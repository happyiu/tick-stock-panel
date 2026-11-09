# ruff: noqa: RUF001
"""ETF allocation schemes, tracking and backtests."""

from __future__ import annotations

import hashlib
import json
import math
import os
import threading
import time
import uuid
from bisect import bisect_left, bisect_right
from datetime import date, timedelta
from decimal import Decimal
from types import SimpleNamespace
from typing import Literal

from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from requests import RequestException

from app.custom import _allocation_calculation
from app.data_providers import get_provider
from app.extensions import BACKEND_EXTENSION_API_VERSION, BackendExtensionRegistrar
from app.market_time import cn_now

EXTENSION_ID = "portfolio.asset-allocation"
EXTENSION_API_VERSION = BACKEND_EXTENSION_API_VERSION
router = APIRouter(prefix="/api/asset-allocation", tags=["asset-allocation"])
_lock = threading.RLock()
_cache = {}
_events = {}
SCORE_AVERAGE_WINDOW = 5


class Portfolio(BaseModel):
    name: str = Field(default="新组合", min_length=1, max_length=100)
    symbols: list[str] = Field(default_factory=list)
    scheme_id: str = Field(default=_allocation_calculation.DEFAULT_SCHEME_ID, min_length=1)
    initial_capital: int | None = Field(default=None, ge=1, lt=1_000_000_000_000)
    lookback: int = Field(default=252, ge=2)
    max_weight: float = Field(default=0.35, gt=0, le=1)
    auto_refresh: bool = False
    rebalance: Literal["monthly", "daily_threshold", "angel_devil"] = "monthly"
    threshold: float = Field(default=0.10, gt=0, le=1)

    @field_validator("scheme_id", mode="before")
    @classmethod
    def default_scheme(cls, value):
        return _allocation_calculation.DEFAULT_SCHEME_ID if value is None else value

    @field_validator("initial_capital", mode="before")
    @classmethod
    def reject_boolean_capital(cls, value):
        if isinstance(value, bool):
            raise ValueError("资金必须为整数元")
        return value


class TrackingCalculation(Portfolio):
    fee: float = Field(default=0, ge=0, lt=0.1)
    slippage: float = Field(default=0, ge=0, lt=0.1)


class Calculation(TrackingCalculation):
    start: date | None = None
    end: date | None = None

def allocate_amounts(weights, initial_capital):
    cents = int(Decimal(str(initial_capital)) * 100)
    precise_weights = [max(Decimal(0), Decimal(str(weight))) for weight in weights]
    total_weight = sum(precise_weights)
    if total_weight <= 0:
        raise ValueError("目标权重无效，无法分配资金")
    exact_cents = [weight / total_weight * cents for weight in precise_weights]
    amounts = [int(value) for value in exact_cents]
    remainder = cents - sum(amounts)
    order = sorted(range(len(weights)), key=lambda index: exact_cents[index] - amounts[index], reverse=True)
    for index in order[:remainder]:
        amounts[index] += 1
    return [amount / 100 for amount in amounts]


def portfolio_file(request):
    return request.app.state.repo.store.data_dir / "user_data/asset_allocation.json"


def read_portfolios(request):
    path = portfolio_file(request)
    return json.loads(path.read_text()) if path.exists() else {}


@router.get("/schemes")
def schemes():
    return {
        "default_scheme_id": _allocation_calculation.DEFAULT_SCHEME_ID,
        "schemes": {
            key: {
                "name": name,
                "ready": allocate is not None,
                "position_ready": key in _allocation_calculation.POSITION_ONLY_SCHEMES,
                "current_weights_ready": key in _allocation_calculation.CURRENT_SCORE_SCHEMES,
            }
            for key, (name, allocate) in _allocation_calculation.SCHEMES.items()
        },
    }


@router.get("/portfolios")
def portfolios(request: Request):
    with _lock:
        return read_portfolios(request)


@router.put("/portfolios/{portfolio_id}")
def save(portfolio_id: uuid.UUID, body: Portfolio, request: Request):
    if body.scheme_id not in _allocation_calculation.SCHEMES:
        raise HTTPException(422, "所选配置方案不可用")
    with _lock:
        items = read_portfolios(request)
        key = str(portfolio_id)
        previous = items.get(key, {})
        record = {**body.model_dump(), "updated_at": cn_now().isoformat()}
        revision = previous.get("allocation_revision")
        if not revision or config_signature(previous) != config_signature(record):
            revision = uuid.uuid4().hex
        record["allocation_revision"] = revision
        items[key] = record
        write_portfolios(request, items)
        return items


def write_portfolios(request, items):
    path = portfolio_file(request)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(items, ensure_ascii=False))
    temporary.replace(path)


def _composite_scores(request, symbol, asset_type, start=None, end=None, *, etf_days=None, replay=False):
    """Score closed index or ETF candles as of the requested sessions."""
    import polars as pl

    from app.services.chart_candles import chart_snapshot
    from app.services.kline_periods import (
        aggregate_daily_period,
        aggregate_minute_30m,
        annotate_bar_closure,
        prepare_native_30m,
    )
    from app.services.technical_scoring import (
        TECHNICAL_SCORE_WARMUP_DAYS,
        latest_technical_categories,
        score_technical_frame,
        technical_score_payload,
    )
    from app.services.watchlist_market_trends import angel_devil_signals

    now = cn_now()
    latest_end = now.date() if now.hour >= 16 else now.date() - timedelta(days=1)
    is_etf = asset_type == "etf"
    if end is not None and (is_etf or replay):
        latest_end = min(end, latest_end)
    requested_start = start or end or latest_end
    # Keep the same three-year warmup as the market-trend panel so weekly EMA signals converge.
    history_start = requested_start - timedelta(days=1100)
    state = request.app.state

    def closed_rows(frame):
        if not {"date", "open", "high", "low", "close", "volume"} <= set(frame.columns):
            return []
        if "symbol" not in frame.columns:
            frame = frame.with_columns(pl.lit(symbol).alias("symbol"))
        rows = (
            frame.with_columns(pl.col("date").cast(pl.Date, strict=False))
            .filter(pl.col("date").is_between(history_start, latest_end))
            .sort("date")
            .to_dicts()
        )
        return [row for row in annotate_bar_closure(rows, "1d", latest_end, now=now) if row["is_closed"]]

    snapshot = chart_snapshot(state, symbol, asset_type, "1d", history_start, latest_end).frame
    closed_daily_rows = closed_rows(snapshot)
    def signal_events(rows, period):
        values = angel_devil_signals(rows)
        width = 16 if period == "30m" else 10
        return [
            (str(row["date"]).replace("T", " ")[:width], signal)
            for row, signal in zip(rows, values, strict=True)
            if signal is not None
        ]

    def category(row, category_id):
        return next((item for item in row.get("categories", []) if item.get("id") == category_id), None)

    def indicator(category_row, indicator_id):
        return next((item for item in (category_row or {}).get("indicators", []) if item.get("id") == indicator_id), None)

    def valid_score(value):
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and 0 <= value <= 100

    def daily_factor_scores(row):
        momentum = category(row, "momentum")
        macd = indicator(momentum, "macd")
        rsi = indicator(momentum, "rsi")
        position = category(row, "price_position")
        atr_values = (indicator(position, "ma20_atr_position") or {}).get("raw_values") or {}
        macd_values = (macd or {}).get("raw_values") or {}
        dif, hist, previous_hist = (macd_values.get(key) for key in ("dif", "hist", "previous_hist"))
        atr = atr_values.get("atr14")
        macd_score = None
        if all(isinstance(value, (int, float)) and math.isfinite(value) for value in (dif, hist, previous_hist, atr)) and atr > 0:
            macd_score = 50 + 50 * (
                0.5 * math.tanh(2 * hist / atr)
                + 0.3 * math.tanh(dif / atr)
                + 0.2 * math.tanh(8 * (hist - previous_hist) / atr)
            )

        rsi_values = (rsi or {}).get("raw_values") or {}
        rsi_value = rsi_values.get("rsi14")
        rsi_score = None
        if valid_score(rsi_value) and (rsi or {}).get("direction") in {"RISING", "FALLING", "FLAT"}:
            rsi_score = max(0.0, min(100.0, 50 + 0.8 * (rsi_value - 50)
                + (10 if rsi["direction"] == "RISING" else -10 if rsi["direction"] == "FALLING" else 0)
                + (10 if rsi.get("divergence") == "BOTTOM_DIVERGENCE" else -10 if rsi.get("divergence") == "TOP_DIVERGENCE" else 0)))

        volume = category(row, "volume_price")
        volume_score = volume.get("score") if volume and volume.get("available") is True and volume.get("coverage", 0) >= 100 and valid_score(volume.get("score")) else None
        return macd_score, rsi_score, volume_score

    def composite_score(row, weekly, daily, minute):
        trend = None
        if weekly is not None and daily is not None:
            raw = 55 * (weekly == "attack") + 30 * (daily == "attack") + 15 * (0.5 if minute is None else minute == "attack")
            trend = math.floor(raw + 0.5)
        macd, rsi, volume = daily_factor_scores(row)
        if any(value is None for value in (trend, macd, rsi, volume)):
            return None
        return math.floor(trend * 0.4 + macd * 0.2 + rsi * 0.2 + volume * 0.2 + 0.5)

    def weekly_rows(daily, as_of):
        weekly = aggregate_daily_period(daily, "1w")
        return [
            row for row in annotate_bar_closure(weekly.to_dicts(), "1w", as_of, now=now)
            if row["is_closed"]
        ]

    def closed_minutes(frame, native):
        if frame.is_empty():
            return []
        bars = prepare_native_30m(frame) if native else aggregate_minute_30m(frame)
        return [
            row for row in annotate_bar_closure(bars.to_dicts(), "30m", latest_end, now=now)
            if row["is_closed"]
        ]

    if is_etf:
        days = [day for day in (etf_days or [end]) if day <= latest_end]
        if not days:
            return []
        primary_dates = [row["date"] for row in closed_daily_rows]
        fallback_rows = []
        fallback_dates = []
        if set(days) - set(primary_dates):
            fallback_rows = closed_rows(state.repo.get_etf_daily(symbol, history_start, latest_end))
            fallback_dates = [row["date"] for row in fallback_rows]

        minute_start = days[0] - timedelta(days=380)
        minute_frame = chart_snapshot(state, symbol, asset_type, "30m", minute_start, latest_end).frame
        minutes = closed_minutes(minute_frame, native=True)
        minute_dates = [str(row["date"]) for row in minutes]
        fallback_minutes = None
        fallback_minute_dates = []

        def daily_window(rows, dates, day):
            return rows[bisect_left(dates, day - timedelta(days=1100)):bisect_right(dates, day)]

        def minute_window(rows, stamps, day):
            left = bisect_left(stamps, str(day - timedelta(days=380)))
            right = bisect_right(stamps, f"{day} 15:00")
            return rows[left:right]

        def last_signal(rows, period):
            events = signal_events(rows, period)
            return events[-1][1] if events else None

        points = []
        for day in days:
            rows = daily_window(closed_daily_rows, primary_dates, day)
            if not rows or rows[-1]["date"] != day:
                rows = daily_window(fallback_rows, fallback_dates, day)
            if not rows or rows[-1]["date"] != day or any(
                value is None or not math.isfinite(value) or value <= 0
                for value in (rows[-1][key] for key in ("open", "high", "low", "close", "volume"))
            ):
                continue

            day_minutes = minute_window(minutes, minute_dates, day)
            if not day_minutes:
                if fallback_minutes is None:
                    raw = state.repo.get_minute_range([symbol], minute_start, latest_end, asset_type="etf")
                    fallback_minutes = closed_minutes(raw, native=False)
                    fallback_minute_dates = [str(row["date"]) for row in fallback_minutes]
                day_minutes = minute_window(fallback_minutes, fallback_minute_dates, day)
            sessions = sorted({str(row["date"])[:10] for row in day_minutes})[-120:]
            if sessions:
                day_minutes = [row for row in day_minutes if str(row["date"])[:10] >= sessions[0]]

            daily = pl.DataFrame(rows, infer_schema_length=None)
            technical_daily = daily.filter(pl.col("date") >= day - timedelta(days=TECHNICAL_SCORE_WARMUP_DAYS))
            score = composite_score(
                {"categories": latest_technical_categories(technical_daily)},
                last_signal(weekly_rows(daily, day), "1w"),
                last_signal(rows, "1d"),
                last_signal(day_minutes, "30m"),
            )
            points.append({"date": str(day), "score": score})
        return points

    if snapshot.is_empty():
        closed_daily_rows = closed_rows(state.repo.get_index_daily(symbol, history_start, latest_end))
    if not closed_daily_rows:
        if replay:
            return []
        raise ValueError("上证指数没有可用的完整 OHLCV 日线，无法计算市场环境得分")
    daily = pl.DataFrame(closed_daily_rows, infer_schema_length=None)
    technical_rows = technical_score_payload(score_technical_frame(daily, assume_sorted=True))["rows"]
    daily_events = signal_events(closed_daily_rows, "1d")
    weekly_events = signal_events(weekly_rows(daily, latest_end), "1w")
    if replay:
        # A short week cannot use the next week's candles to confirm its own close early.
        confirmed_events = []
        for stamp, signal in weekly_events:
            day = date.fromisoformat(stamp)
            if day.weekday() < 4:
                day += timedelta(days=7 - day.weekday())
            confirmed_events.append((str(day), signal))
        weekly_events = confirmed_events
    minute_frame = chart_snapshot(state, symbol, asset_type, "30m", history_start, latest_end).frame
    minute_events = signal_events(closed_minutes(minute_frame, native=True), "30m")

    def latest(events, cutoff, cursor):
        while cursor < len(events) and events[cursor][0] <= cutoff:
            cursor += 1
        return (events[cursor - 1][1] if cursor else None), cursor

    daily_cursor = weekly_cursor = minute_cursor = 0
    latest_daily = latest_weekly = latest_minute = None
    points = []
    for row in technical_rows:
        as_of = str(row["as_of"]).replace("T", " ")[:10]
        if end and as_of > end.isoformat():
            break
        latest_daily, daily_cursor = latest(daily_events, as_of, daily_cursor)
        latest_weekly, weekly_cursor = latest(weekly_events, as_of, weekly_cursor)
        latest_minute, minute_cursor = latest(minute_events, f"{as_of} 15:00", minute_cursor)

        score = composite_score(row, latest_weekly, latest_daily, latest_minute)
        if start and as_of < start.isoformat():
            continue
        points.append({"date": as_of, "score": score})
    return points


def _trading_sessions(repo, start, end):
    calendar = repo.get_index_daily("000001.SH", start, end, columns=["date"])
    if "date" not in calendar.columns:
        return []
    return sorted({day for day in calendar.get_column("date").drop_nulls().to_list() if start <= day <= end})


def _rolling_score_averages(days, points, window=SCORE_AVERAGE_WINDOW):
    """Align raw scores to market sessions and require a full consecutive window."""
    raw_scores = {str(point["date"]): point.get("score") for point in points}
    recent = []
    averages = {}
    for day in days:
        key = str(day)
        score = raw_scores.get(key)
        if score is None or not isinstance(score, (int, float)) or not math.isfinite(score) or not 0 <= score <= 100:
            recent.clear()
            averages[key] = None
            continue
        recent.append(float(score))
        if len(recent) > window:
            recent.pop(0)
        averages[key] = sum(recent) / window if len(recent) == window else None
    return averages


def market_environment_position_history(request, start=None, end=None, *, replay=False):
    """Return five-session average scores and Devil Trader total exposures."""
    now = cn_now()
    cutoff = now.date() if now.hour >= 16 else now.date() - timedelta(days=1)
    latest_end = min(end or cutoff, cutoff)
    visible_start = start or latest_end - timedelta(days=1100)
    calendar_start = visible_start - timedelta(days=30)
    calendar_days = _trading_sessions(request.app.state.repo, calendar_start, latest_end)
    visible_days = [day for day in calendar_days if visible_start <= day <= latest_end]
    if not visible_days:
        raise ValueError("所选日期范围内没有完整的市场环境交易日")

    first_index = calendar_days.index(visible_days[0])
    score_days = calendar_days[max(0, first_index - SCORE_AVERAGE_WINDOW + 1):]
    raw_points = _composite_scores(
        request, "000001.SH", "index", score_days[0], latest_end, replay=replay
    )
    averages = _rolling_score_averages(score_days, raw_points)
    points = [
        {"date": str(day), "score": averages[str(day)]}
        for day in visible_days
    ]
    if not any(point["score"] is not None for point in points):
        raise ValueError("所选日期范围内没有完整的5日平均市场环境得分")
    for point in points:
        score = point["score"]
        position, regime = _allocation_calculation.total_position_for_score(score) if score is not None else (None, None)
        point.update(total_position=position, regime=regime)
    return points


def etf_composite_score(request, symbol, as_of):
    sessions = _trading_sessions(request.app.state.repo, as_of - timedelta(days=30), as_of)
    score_days = sessions[-SCORE_AVERAGE_WINDOW:]
    if not score_days:
        return None
    points = _composite_scores(
        request, symbol, "etf", start=score_days[0], end=as_of, etf_days=score_days
    )
    return _rolling_score_averages(score_days, points).get(str(as_of))


@router.delete("/portfolios/{portfolio_id}")
def delete(portfolio_id: uuid.UUID, request: Request):
    with _lock:
        items = read_portfolios(request)
        items.pop(str(portfolio_id), None)
        entries = read_tracking(request)
        entries.pop(str(portfolio_id), None)
        write_tracking(request, entries)
        write_portfolios(request, items)
        return items


def etf_action_rows(symbol):
    key = (symbol, int(time.time() // 300))
    with _lock:
        event_rows = _events.get(key)
    if event_rows is None:
        provider = get_provider(os.getenv("ALLOCATION_ACTION_PROVIDER", "astockdata"))
        getter = getattr(provider, "get_etf_actions", None)
        if getter is None:
            raise ValueError("所选数据源不支持 ETF 分红拆分事件")
        event_rows = getter(symbol)
        with _lock:
            for old in [k for k in _events if k[0] == symbol]:
                del _events[old]
            _events[key] = event_rows
    return event_rows


def prepare(body, repo, mode, basis_date=None):
    if error := _allocation_calculation.scheme_unavailability(body.scheme_id):
        raise ValueError(error)
    symbols = body.symbols
    if not symbols or len(set(symbols)) != len(symbols):
        raise ValueError("请选择 ETF，代码不能重复")
    if len(symbols) * body.max_weight < 1 - 1e-9:
        raise ValueError(
            f"最多只能配置 {len(symbols) * body.max_weight:.0%}，请提高单只上限或增加标的"
        )
    unknown = set(symbols) - repo.get_etf_symbol_set()
    if unknown:
        raise ValueError(f"非 ETF 或未知代码：{', '.join(sorted(unknown))}")
    now = cn_now()
    cutoff = now.date() if now.hour >= 16 else now.date() - timedelta(days=1)
    end = min(body.end or cutoff, cutoff)
    # The core index supplies the shared exchange-session calendar.
    calendar = repo.get_index_daily("000001.SH", date(2000, 1, 1), end, columns=["date"])
    days = sorted(set(calendar["date"].to_list()))
    if not days:
        raise ValueError("交易日历不足，请同步指数历史")
    if basis_date and date.fromisoformat(basis_date) not in days:
        raise ValueError("跟踪基准日期历史缺失，请先补齐数据")
    if mode == "optimize":
        selected = days[-body.lookback - 1 :]
        days = (
            [d for d in days if d >= min(selected[0], date.fromisoformat(basis_date))]
            if basis_date
            else selected
        )
    elif body.start:
        earlier = [d for d in days if d < body.start]
        days = earlier[-body.lookback - 1 :] + [d for d in days if d >= body.start]
    if len(days) < body.lookback + 1:
        raise ValueError("交易日历不足，请同步指数历史")
    payload = {**body.model_dump(mode="json"), "mode": mode, "dates": [str(d) for d in days]}
    closes, opens, dividends, splits = [], [], [], []
    signals = []
    issues = []
    for symbol in symbols:
        frame = repo.get_etf_daily(
            symbol,
            date(2000, 1, 1) if mode == "backtest" else days[0],
            days[-1],
            columns=["date", "raw_close", "open", "close"],
        )
        rows = {r["date"]: r for r in frame.to_dicts()}
        missing = [str(d) for d in days if d not in rows]
        if missing:
            available = f"{min(rows)} 至 {max(rows)}" if rows else "暂无数据"
            issues.append(
                f"{symbol} 缺少 {len(missing)} 个交易日，首个缺口 {missing[0]}，可用区间 {available}"
            )
            continue
        event_rows = etf_action_rows(symbol)
        events = {e["date"]: e for e in event_rows}
        with _lock:
            coverage_path = repo.store.data_dir / "user_data/asset_allocation_coverage.json"
            coverage_path.parent.mkdir(parents=True, exist_ok=True)
            coverage = json.loads(coverage_path.read_text()) if coverage_path.exists() else {}
            coverage[symbol] = {
                "start": str(days[0]),
                "end": str(days[-1]),
                "checked_at": now.isoformat(),
                "provider": os.getenv("ALLOCATION_ACTION_PROVIDER", "astockdata"),
                "events": event_rows,
            }
            temporary = coverage_path.with_suffix(".tmp")
            temporary.write_text(json.dumps(coverage))
            temporary.replace(coverage_path)
        if mode == "backtest":
            first_signal_day = next((d for d in days if d >= body.start), None)
            if first_signal_day is None:
                raise ValueError("所选区间内没有已闭合交易日")
            by_day = daily_allocation_signals(symbol, rows, events, calendar["date"].to_list(), first_signal_day)
            signals.append([by_day[d] for d in days])
        c, o, div, split = [], [], [], []
        for day in days:
            row = rows[day]
            raw = row["raw_close"]
            # Stored open uses the same adjustment scale as close.
            if any(
                v is None or not math.isfinite(v) or v <= 0
                for v in (raw, row["open"], row["close"])
            ):
                raise ValueError(f"{symbol} {day} 价格无效")
            opening = row["open"] * raw / row["close"]
            event = events.get(str(day), {})
            c.append(raw)
            o.append(opening)
            div.append(event.get("dividend", 0))
            split.append(event.get("split", 1))
        closes.append(c)
        opens.append(o)
        dividends.append(div)
        splits.append(split)
    if issues:
        raise ValueError("；".join(issues))
    for key, arrays in [
        ("close", closes),
        ("open", opens),
        ("dividend", dividends),
        ("split", splits),
    ]:
        payload[key] = list(map(list, zip(*arrays, strict=True)))
    if mode == "backtest":
        payload["signals"] = list(map(list, zip(*signals, strict=True)))
        payload["rule_version"] = _allocation_calculation.BACKTEST_RULE_VERSION
    return payload


def calculate(body, request, mode):
    try:
        if mode == "backtest" and (not body.start or not body.end or body.start > body.end):
            raise ValueError("请选择有效的回测起止日期")
        if mode == "backtest":
            body = body.model_copy(update={"rebalance": "angel_devil"})
        if body.scheme_id in _allocation_calculation.POSITION_ONLY_SCHEMES:
            points = market_environment_position_history(
                request,
                start=body.start if mode == "backtest" else None,
                end=body.end,
                replay=mode == "backtest",
            )
            if mode == "backtest":
                unavailable = next((point["date"] for point in points if point["score"] is None), None)
                if unavailable:
                    raise ValueError(f"{unavailable} 市场环境评分数据不足，无法回测总仓位")
            latest_point = points[-1]
            if latest_point["score"] is None or latest_point["total_position"] is None:
                raise ValueError(f"{latest_point['date']} 市场环境评分数据不足，无法确定总仓位")
            position_points = points if mode == "backtest" else [latest_point]
            preview = mode == "optimize" and body.scheme_id in _allocation_calculation.CURRENT_SCORE_SCHEMES
            etf_scores = []
            if preview and body.symbols:
                if len(set(body.symbols)) != len(body.symbols):
                    raise ValueError("ETF 代码不能重复")
                repo = request.app.state.repo
                unknown = set(body.symbols) - repo.get_etf_symbol_set()
                if unknown:
                    raise ValueError(f"非 ETF 或未知代码：{', '.join(sorted(unknown))}")
                as_of = date.fromisoformat(latest_point["date"])
                etf_scores = [etf_composite_score(request, symbol, as_of) for symbol in body.symbols]
            rule_version = "devil_trader_five_session_average_60_90_v2"
            signature = hashlib.sha256(json.dumps({
                "mode": mode,
                "parameters": body.model_dump(mode="json"),
                "positions": position_points,
                "etf_scores": etf_scores,
                "rule_version": rule_version,
            }, sort_keys=True).encode()).hexdigest()
            with _lock:
                result = _cache.get(signature)
            if result is None:
                result = {
                    "total_position": latest_point["total_position"],
                    "market_score": latest_point["score"],
                    "market_regime": latest_point["regime"],
                    "position_history": position_points,
                    "samples": len(position_points),
                    "as_of": latest_point["date"],
                    "data_version": signature,
                    "rule_version": rule_version,
                    "parameters": body.model_dump(mode="json"),
                    "names": {},
                }
                if preview:
                    result.update(_allocation_calculation.score_allocation(
                        body.symbols, etf_scores, latest_point["total_position"],
                        body.max_weight, body.initial_capital,
                    ))
                    if body.symbols:
                        result["names"] = repo.get_name_map(body.symbols)
                with _lock:
                    if len(_cache) >= 32:
                        _cache.pop(next(iter(_cache)))
                    _cache[signature] = result
            return result
        payload = prepare(body, request.app.state.repo, mode)
        signature = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
        with _lock:
            result = _cache.get(signature)
        if result is None:
            result = _allocation_calculation.calculate(payload)
            result.update(
                {
                    "data_version": signature,
                    "event_source": os.getenv("ALLOCATION_ACTION_PROVIDER", "astockdata"),
                    "as_of": payload["dates"][-1],
                    "parameters": body.model_dump(mode="json"),
                    "names": request.app.state.repo.get_name_map(body.symbols),
                }
            )
            if body.initial_capital is not None and result.get("weights") is not None:
                result["target_amounts"] = {
                    "scheme": allocate_amounts(result["weights"], body.initial_capital),
                    "equal": allocate_amounts(
                        [1 / len(body.symbols)] * len(body.symbols), body.initial_capital
                    ),
                }
            with _lock:
                if len(_cache) >= 32:
                    _cache.pop(next(iter(_cache)))
                _cache[signature] = result
        return result
    except RequestException as exc:
        raise HTTPException(503, "ETF 事件数据源请求失败，请稍后重试") from exc
    except (ValueError, RuntimeError, KeyError, OSError) as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/optimize")
def optimize(body: Calculation, request: Request):
    return calculate(body, request, "optimize")


@router.post("/backtest")
def backtest(body: Calculation, request: Request):
    return calculate(body, request, "backtest")


def daily_allocation_signals(symbol, rows, actions, calendar_days, first_signal_day):
    from app.services.watchlist_market_trends import angel_devil_signals

    history_days = sorted(rows)
    if sum(day < first_signal_day for day in history_days) < 21:
        raise ValueError(f"{symbol} 天使魔鬼信号至少需要 21 根预热日线")
    if any(day not in rows for day in calendar_days if history_days[0] <= day <= history_days[-1]):
        raise ValueError(f"{symbol} 天使魔鬼信号历史存在交易日缺口")
    # Build adjusted closes forward using only corporate actions effective on each date.
    scale = 1.0
    adjusted = []
    previous_close = None
    for day in history_days:
        raw = rows[day]["raw_close"]
        if raw is None or not math.isfinite(raw) or raw <= 0:
            raise ValueError(f"{symbol} {day} 信号历史价格无效")
        action = actions.get(str(day))
        if action and previous_close is not None:
            cash, split = action["dividend"], action["split"]
            if not math.isfinite(cash) or not math.isfinite(split) or not 0 <= cash < previous_close or split <= 0:
                raise ValueError(f"{symbol} {day} 分红拆分数据无效")
            scale *= previous_close * split / (previous_close - cash)
        adjusted.append({"date": str(day), "close": raw * scale})
        previous_close = raw
    return dict(zip(history_days, angel_devil_signals(adjusted), strict=True))


def tracking_price_inputs(repo, symbols, days, calendar_days):
    closes, dividends, splits, signals = [], [], [], []
    for symbol in symbols:
        frame = repo.get_etf_daily(symbol, date(2000, 1, 1), days[-1], columns=["date", "raw_close"])
        rows = {row["date"]: row for row in frame.to_dicts() if row.get("date") is not None and row["date"] <= days[-1]}
        prices = []
        for day in days:
            price = rows.get(day, {}).get("raw_close")
            if price is None or not math.isfinite(price) or price <= 0:
                raise ValueError(f"{symbol} {day} 缺少有效的未复权收盘价")
            prices.append(price)
        try:
            actions = {row["date"]: row for row in etf_action_rows(symbol)}
        except (RequestException, ValueError, RuntimeError, KeyError, TypeError, OSError) as exc:
            raise ValueError(f"{symbol} 无法确认分红拆分数据：{exc}") from exc
        cash, ratios = [], []
        for day in days:
            action = actions.get(str(day))
            dividend, split = (action["dividend"], action["split"]) if action is not None else (0.0, 1.0)
            if not math.isfinite(dividend) or not math.isfinite(split) or dividend < 0 or split <= 0:
                raise ValueError(f"{symbol} {day} 分红拆分数据无效")
            cash.append(dividend)
            ratios.append(split)
        closes.append(prices)
        dividends.append(cash)
        splits.append(ratios)
        by_day = daily_allocation_signals(symbol, rows, actions, calendar_days, days[0])
        signals.append([by_day[day] for day in days])
    return tuple(list(zip(*matrix, strict=True)) for matrix in (closes, dividends, splits, signals))


@router.post("/tracking-history")
def tracking_history(body: Calculation, request: Request):
    try:
        if (body.start is None) != (body.end is None):
            raise ValueError("请同时选择开始和结束日期")
        if body.start is not None and body.end is not None and body.start > body.end:
            raise ValueError("结束日期应晚于或等于开始日期")
        if body.scheme_id not in _allocation_calculation.CURRENT_SCORE_SCHEMES:
            raise ValueError("当前方案不支持回看调仓历史")
        if not body.symbols or len(set(body.symbols)) != len(body.symbols):
            raise ValueError("请选择 ETF，代码不能重复")
        repo = request.app.state.repo
        unknown = set(body.symbols) - repo.get_etf_symbol_set()
        if unknown:
            raise ValueError(f"非 ETF 或未知代码：{', '.join(sorted(unknown))}")

        now = cn_now()
        cutoff = now.date() if now.hour >= 16 else now.date() - timedelta(days=1)
        calendar = repo.get_index_daily("000001.SH", date(2000, 1, 1), cutoff, columns=["date"])
        dates = calendar.get_column("date").drop_nulls().to_list() if "date" in calendar.columns else []
        available_days = sorted({day for day in dates if day <= cutoff})
        if body.start is not None and body.end is not None:
            days = [day for day in available_days if body.start <= day <= body.end]
        else:
            days = available_days[max(0, len(available_days) - body.lookback):]
        if not days:
            if body.start is not None:
                raise ValueError("所选起止日期范围内没有交易日")
            raise ValueError("交易日历不足，请同步指数历史")
        start, end = days[0], days[-1]
        first_index = available_days.index(start)
        last_index = available_days.index(end)
        score_days = available_days[max(0, first_index - SCORE_AVERAGE_WINDOW + 1):last_index + 1]
        score_start = score_days[0]
        market_points = _composite_scores(request, "000001.SH", "index", score_start, end, replay=True)
        market_averages = _rolling_score_averages(score_days, market_points)
        visible_days = {str(day) for day in days}
        market = {day: average for day, average in market_averages.items() if day in visible_days}
        scores = []
        for symbol in body.symbols:
            points = _composite_scores(request, symbol, "etf", score_start, end, etf_days=score_days)
            averages = _rolling_score_averages(score_days, points)
            scores.append({day: average for day, average in averages.items() if day in visible_days})
        day_labels = [str(day) for day in days]
        result = {
            "start": str(start),
            "end": str(end),
            "sessions": len(days),
            "requested_sessions": body.lookback if body.start is None else len(days),
            "names": repo.get_name_map(body.symbols),
            **_allocation_calculation.replay_tracking(
                day_labels, market, body.symbols, scores, body.max_weight, body.threshold
            ),
        }
        if result["events"]:
            first = day_labels.index(result["events"][0]["date"])
            try:
                inputs = tracking_price_inputs(repo, body.symbols, days[first:], available_days)
                histories, trades = _allocation_calculation.tracking_performance(
                    day_labels[first:], *inputs, result["events"], body.fee + body.slippage
                )
                for history in histories.values():
                    history["points"][:0] = [
                        {"date": day, "value": 1.0, "drawdown": 0.0} for day in day_labels[:first]
                    ]
                result.update(history=histories, trades=trades)
            except (ValueError, RuntimeError, KeyError, TypeError, OSError) as exc:
                result["performance_error"] = str(exc)
        return result
    except RequestException as exc:
        raise HTTPException(503, "历史行情数据源请求失败，请稍后重试") from exc
    except (ValueError, RuntimeError, KeyError, OSError) as exc:
        raise HTTPException(422, str(exc)) from exc


def setup(registrar: BackendExtensionRegistrar):
    registrar.include_router(router)


def tracking_file(request):
    return portfolio_file(request).with_name("asset_allocation_tracking.json")


def read_tracking(request):
    path = tracking_file(request)
    return json.loads(path.read_text()) if path.exists() else {}


def write_tracking(request, entries):
    path = tracking_file(request)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(entries, ensure_ascii=False))
    temporary.replace(path)


def config_signature(portfolio):
    # Display name and automation switch don't change the tracked holdings.
    return [
        portfolio.get("scheme_id"),
        portfolio.get("symbols"),
        portfolio.get("lookback", 252),
        portfolio.get("max_weight", 0.35),
        portfolio.get("threshold", 0.10),
    ]


def same_tracking_revision(entry, portfolio):
    revision = portfolio.get("allocation_revision")
    return (
        revision is not None
        and _allocation_calculation.scheme_unavailability(portfolio.get("scheme_id")) is None
        and entry.get("allocation_revision") == revision
    )


def tracked_weights(payload, basis):
    shares = [w / p for w, p in zip(basis["weights"], basis["prices"], strict=True)]
    cash = 0.0
    for i, day in enumerate(payload["dates"]):
        if day <= basis["date"]:
            continue
        cash += sum(q * d for q, d in zip(shares, payload["dividend"][i], strict=True))
        shares = [q * s for q, s in zip(shares, payload["split"][i], strict=True)]
    amounts = [q * p for q, p in zip(shares, payload["close"][-1], strict=True)]
    total = sum(amounts) + cash
    return [a / total for a in amounts]


@router.get("/tracking")
def tracking(request: Request):
    with _lock:
        saved = read_portfolios(request)
        return {
            key: entry
            for key, entry in read_tracking(request).items()
            if key in saved and same_tracking_revision(entry, saved[key])
        }


def refresh_portfolio(portfolio_id, request, require_today=False):
    with _lock:
        raw = read_portfolios(request).get(portfolio_id)
        previous = read_tracking(request).get(portfolio_id, {})
    if raw is None:
        raise HTTPException(404, "组合已删除")
    body = Calculation(**raw)
    if error := _allocation_calculation.scheme_unavailability(body.scheme_id):
        raise HTTPException(422, error)
    if not same_tracking_revision(previous, raw):
        previous = {}
    signature = config_signature(raw)
    basis = previous.get("basis") if previous.get("config") == signature else None
    try:
        payload = prepare(
            body, request.app.state.repo, "optimize", basis["date"] if basis else None
        )
        if require_today and payload["dates"][-1] != cn_now().date().isoformat():
            raise ValueError(f"今日收盘数据尚未就绪，最新数据截至 {payload['dates'][-1]}")
        result = _allocation_calculation.calculate(payload)
        current = tracked_weights(payload, basis) if basis else None
        deviation = (
            max(abs(a - b) for a, b in zip(current, result["weights"], strict=True))
            if current
            else None
        )
        record = {
            "config": signature,
            "checked_at": cn_now().isoformat(),
            "as_of": payload["dates"][-1],
            "target": result["weights"],
            "prices": payload["close"][-1],
            "current": current,
            "deviation": deviation,
            "basis": basis,
            "status": "initial"
            if basis is None
            else ("rebalance" if deviation >= body.threshold - 1e-10 else "hold"),
        }
    except Exception as exc:
        record = {
            **previous,
            "checked_at": cn_now().isoformat(),
            "status": "error",
            "error": str(exc.detail if isinstance(exc, HTTPException) else exc),
        }
    with _lock:
        # A concurrent edit/delete must not publish a result for an old definition.
        if read_portfolios(request).get(portfolio_id) != raw:
            return None
        record.update(scheme_id=body.scheme_id, allocation_revision=raw.get("allocation_revision"))
        entries = read_tracking(request)
        entries[portfolio_id] = record
        write_tracking(request, entries)
    return record


@router.post("/portfolios/{portfolio_id}/refresh")
def refresh(portfolio_id: uuid.UUID, request: Request):
    return refresh_portfolio(str(portfolio_id), request)


class Confirmation(BaseModel):
    checked_at: str


@router.post("/portfolios/{portfolio_id}/confirm")
def confirm(portfolio_id: uuid.UUID, body: Confirmation, request: Request):
    with _lock:
        entries = read_tracking(request)
        entry = entries.get(str(portfolio_id))
        raw = read_portfolios(request).get(str(portfolio_id))
        if (
            not entry
            or entry.get("status") == "error"
            or raw is None
            or not same_tracking_revision(entry, raw)
        ):
            raise HTTPException(422, "请先重算组合")
        if entry["checked_at"] != body.checked_at:
            raise HTTPException(409, "建议已经更新，请刷新后确认")
        if entry["config"] != config_signature(raw):
            raise HTTPException(422, "参数已变化，请先重算")
        entry["basis"] = {
            "date": entry["as_of"],
            "weights": entry["target"],
            "prices": entry["prices"],
        }
        entry.update(current=entry["target"], deviation=0.0, status="hold")
        write_tracking(request, entries)
        return entry


_scheduler = None


def refresh_saved(repo):
    now = cn_now()
    if now.weekday() >= 5 or now.hour < 16:
        return
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(repo=repo)))
    with _lock:
        saved = read_portfolios(request)
    for key, raw in saved.items():
        if (
            raw.get("auto_refresh")
            and raw.get("symbols")
            and _allocation_calculation.scheme_unavailability(raw.get("scheme_id")) is None
        ):
            refresh_portfolio(key, request, require_today=True)


def startup(context):
    global _scheduler
    _scheduler = BackgroundScheduler(timezone="Asia/Shanghai", daemon=True)
    _scheduler.add_job(
        refresh_saved,
        "interval",
        minutes=15,
        args=[context.repository],
        max_instances=1,
        coalesce=True,
    )
    _scheduler.start()


def stop_scheduler():
    if _scheduler:
        _scheduler.shutdown(wait=False)


router.add_event_handler("shutdown", stop_scheduler)
