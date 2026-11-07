# ruff: noqa: RUF001
"""Portfolio extension. Repository data stays outside the isolated optimizer."""

from __future__ import annotations

import atexit
import hashlib
import json
import math
import os
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from datetime import date, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Literal

from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from requests import RequestException

from app.data_providers import get_provider
from app.extensions import BACKEND_EXTENSION_API_VERSION, BackendExtensionRegistrar
from app.market_time import cn_now

EXTENSION_ID = "portfolio.asset-allocation"
EXTENSION_API_VERSION = BACKEND_EXTENSION_API_VERSION
router = APIRouter(prefix="/api/asset-allocation", tags=["asset-allocation"])
_lock = threading.RLock()
_engine_lock = threading.RLock()
_process = None
_cache = {}
_events = {}


class Portfolio(BaseModel):
    name: str = Field(default="新组合", min_length=1, max_length=100)
    symbols: list[str] = Field(default_factory=list)
    lookback: int = Field(default=252, ge=2)
    max_weight: float = Field(default=0.35, gt=0, le=1)
    auto_refresh: bool = False
    rebalance: Literal["monthly", "daily_threshold", "angel_devil"] = "monthly"
    threshold: float = Field(default=0.05, gt=0, le=1)


class Calculation(Portfolio):
    start: date | None = None
    end: date | None = None
    fee: float = Field(default=0, ge=0, lt=0.1)
    slippage: float = Field(default=0, ge=0, lt=0.1)


def stop_worker():
    global _process
    if _process is not None:
        _process.kill()
        _process.wait()
        _process = None


atexit.register(stop_worker)
router.add_event_handler("shutdown", stop_worker)


def run_engine(payload):
    global _process
    with _engine_lock:
        if _process is None or _process.poll() is not None:
            python = os.getenv("ALLOCATION_PYTHON") or str(
                Path(__file__).resolve().parents[2]
                / "allocation-engine/.venv"
                / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
            )
            if not Path(python).exists():
                raise ValueError("请先运行 uv sync --project backend/allocation-engine --frozen")
            _process = subprocess.Popen(
                [python, str(Path(__file__).with_name("_allocation_worker.py"))],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                text=True,
            )
        _process.stdin.write(json.dumps(payload) + "\n")
        _process.stdin.flush()
        executor = ThreadPoolExecutor(1)
        future = executor.submit(_process.stdout.readline)
        try:
            line = future.result(timeout=120)
            response = json.loads(line)
        except (TimeoutError, ValueError):
            stop_worker()
            raise ValueError("配置引擎超时或退出，请重试") from None
        finally:
            executor.shutdown(wait=False)
        if "error" in response:
            raise ValueError(response["error"])
        return response["result"]


def portfolio_file(request):
    return request.app.state.repo.store.data_dir / "user_data/asset_allocation.json"


def read_portfolios(request):
    path = portfolio_file(request)
    return json.loads(path.read_text()) if path.exists() else {}


@router.get("/portfolios")
def portfolios(request: Request):
    with _lock:
        return read_portfolios(request)


@router.put("/portfolios/{portfolio_id}")
def save(portfolio_id: uuid.UUID, body: Portfolio, request: Request):
    with _lock:
        items = read_portfolios(request)
        items[str(portfolio_id)] = {**body.model_dump(), "updated_at": cn_now().isoformat()}
        write_portfolios(request, items)
        return items


def write_portfolios(request, items):
    path = portfolio_file(request)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(items, ensure_ascii=False))
    temporary.replace(path)


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


def prepare(body, repo, mode, basis_date=None):
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
            from app.services.watchlist_market_trends import angel_devil_signals

            history_days = sorted(rows)
            first_signal_day = next((d for d in days if d >= body.start), None)
            if first_signal_day is None:
                raise ValueError("所选区间内没有已闭合交易日")
            if sum(d < first_signal_day for d in history_days) < 21:
                raise ValueError(f"{symbol} 天使魔鬼信号至少需要 21 根预热日线")
            # Use the same proportional event adjustment as the enriched pipeline.
            # Future splits/dividends only rescale earlier bars uniformly.
            scale = 1.0
            adjusted = []
            previous_close = None
            for day in history_days:
                raw = rows[day]["raw_close"]
                if raw is None or not math.isfinite(raw) or raw <= 0:
                    raise ValueError(f"{symbol} {day} 信号历史价格无效")
                event = events.get(str(day))
                if event and previous_close is not None:
                    cash = event["dividend"]
                    if previous_close <= cash:
                        raise ValueError(f"{symbol} {day} 分红金额无效")
                    scale *= previous_close * event["split"] / (previous_close - cash)
                adjusted.append({"date": str(day), "close": raw * scale})
                previous_close = raw
            # Gaps inside signal history must not change the indicator's time base.
            expected = [d for d in calendar["date"].to_list() if history_days[0] <= d <= days[-1]]
            if set(expected) - set(history_days):
                raise ValueError(f"{symbol} 天使魔鬼信号历史存在交易日缺口")
            by_day = dict(zip(history_days, angel_devil_signals(adjusted), strict=True))
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
        payload["rule_version"] = "angel_devil_close_v1"
    return payload


def calculate(body, request, mode):
    try:
        if mode == "backtest" and (not body.start or not body.end or body.start > body.end):
            raise ValueError("请选择有效的回测起止日期")
        if mode == "backtest":
            body = body.model_copy(update={"rebalance": "angel_devil"})
        payload = prepare(body, request.app.state.repo, mode)
        signature = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
        with _lock:
            result = _cache.get(signature)
        if result is None:
            result = run_engine(payload)
            result.update(
                {
                    "data_version": signature,
                    "engine_version": "7.4.1",
                    "event_source": os.getenv("ALLOCATION_ACTION_PROVIDER", "astockdata"),
                    "as_of": payload["dates"][-1],
                    "parameters": body.model_dump(mode="json"),
                    "names": request.app.state.repo.get_name_map(body.symbols),
                }
            )
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


def config_signature(body):
    # Display name and automation switch don't change the tracked holdings.
    return [body.symbols, body.lookback, body.max_weight, body.threshold]


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
        return read_tracking(request)


def refresh_portfolio(portfolio_id, request, require_today=False):
    with _lock:
        raw = read_portfolios(request).get(portfolio_id)
        previous = read_tracking(request).get(portfolio_id, {})
    if raw is None:
        raise HTTPException(404, "组合已删除")
    body = Calculation(**raw)
    signature = config_signature(body)
    basis = previous.get("basis") if previous.get("config") == signature else None
    try:
        payload = prepare(
            body, request.app.state.repo, "optimize", basis["date"] if basis else None
        )
        if require_today and payload["dates"][-1] != cn_now().date().isoformat():
            raise ValueError(f"今日收盘数据尚未就绪，最新数据截至 {payload['dates'][-1]}")
        result = run_engine(payload)
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
        if not entry or entry.get("status") == "error" or raw is None:
            raise HTTPException(422, "请先重算组合")
        if entry["checked_at"] != body.checked_at:
            raise HTTPException(409, "建议已经更新，请刷新后确认")
        if entry["config"] != config_signature(Calculation(**raw)):
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
        if raw.get("auto_refresh") and raw.get("symbols"):
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
