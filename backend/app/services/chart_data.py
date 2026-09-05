"""按需展示行情。只维护有界内存快照,不写仓库或 enriched 历史缓存。"""
from __future__ import annotations

import logging
from collections import OrderedDict
from concurrent.futures import Future, TimeoutError
from dataclasses import dataclass, replace
from datetime import date, datetime, time, timedelta
from threading import Lock
from time import monotonic

import polars as pl

from app.data_providers import custom as custom_sources
from app.data_providers.registry import get_provider
from app.indicators.pipeline import compute_enriched
from app.market_time import CN_TZ, cn_now, cn_today, in_continuous_session
from app.services.kline_sync import _enforce_minute_beijing_wallclock

logger = logging.getLogger(__name__)


def resolve_provider(name: str, dataset: str):
    if name == "tickflow":
        return get_provider(name)
    if not custom_sources.provider_has_dataset(name, dataset):
        raise ValueError(f"数据源未提供 {dataset}")
    return custom_sources.get_provider(name)


@dataclass(frozen=True)
class ChartSnapshot:
    frame: pl.DataFrame
    provider: str
    fetched_at: str | None = None
    stale: bool = False
    adjustment: str = "none"
    amount_estimated: bool = False

    def metadata(self) -> dict:
        column = "datetime" if "datetime" in self.frame.columns else "date"
        through = str(self.frame[column].max()) if not self.frame.is_empty() else None
        return {
            "provider": self.provider, "fetched_at": self.fetched_at,
            "stale": self.stale, "adjustment": self.adjustment,
            "amount_estimated": self.amount_estimated,
            "data_through": through,
        }


@dataclass(frozen=True)
class _Entry:
    snapshot: ChartSnapshot
    raw: pl.DataFrame
    expires: float


def _validate(frame: pl.DataFrame, symbol: str, column: str, start: date, end: date) -> pl.DataFrame:
    required = {"symbol", column, "open", "high", "low", "close", "volume"}
    if frame.is_empty() or not required.issubset(frame.columns):
        raise ValueError("数据源未返回有效K线")
    frame = frame.with_columns(pl.col(column).cast(pl.Date if column == "date" else pl.Datetime("us")))
    day = pl.col(column) if column == "date" else pl.col(column).dt.date()
    frame = frame.filter((pl.col("symbol") == symbol) & day.is_between(start, end))
    valid = pl.all_horizontal([
        pl.col(c).is_finite() & (pl.col(c) > 0) for c in ("open", "high", "low", "close")
    ]) & (pl.col("high") >= pl.max_horizontal("open", "close", "low")) & (
        pl.col("low") <= pl.min_horizontal("open", "close")
    )
    if frame.is_empty() or not frame.select(valid.fill_null(False).all()).item():
        raise ValueError("K线价格或日期无效")
    return frame.unique(subset=["symbol", column], keep="last").sort(column)


class ChartDataService:
    def __init__(self, *, clock=monotonic, max_entries: int = 128):
        self._clock = clock
        self._max_entries = max_entries
        self._lock = Lock()
        self._cache: OrderedDict[tuple, _Entry] = OrderedDict()
        self._pending: dict[tuple, Future] = {}

    def get(self, provider_name: str, factor_name: str, symbol: str, asset_type: str,
            period: str, start: date, end: date) -> ChartSnapshot:
        end = min(end, cn_today())
        key = (provider_name, factor_name, symbol, asset_type, period, start, end)
        with self._lock:
            entry = self._cache.get(key)
            if entry is not None:
                self._cache.move_to_end(key)
                if self._clock() < entry.expires:
                    return entry.snapshot
            pending = self._pending.get(key)
            owner = pending is None
            if owner:
                # 有界并发,避免不同标的的大量请求建立无界等待队列。
                if len(self._pending) >= 32:
                    return self._fallback(entry, provider_name)
                pending = Future()
                self._pending[key] = pending
        if not owner:
            try:
                return pending.result(timeout=15)
            except TimeoutError:
                return self._fallback(entry, provider_name)

        raw = entry.raw if entry else pl.DataFrame()
        try:
            snapshot, raw = self._fetch(provider_name, factor_name, symbol, asset_type, period, start, end, raw)
        except Exception as exc:
            # 不把供应商异常(可能含请求参数)透传浏览器。
            logger.warning("chart fetch failed for %s/%s/%s (%s)", provider_name, symbol, period, type(exc).__name__)
            snapshot = self._fallback(entry, provider_name)
        ttl = 30 if snapshot.stale or (end == cn_today() and in_continuous_session()) else 300
        with self._lock:
            self._cache[key] = _Entry(snapshot, raw, self._clock() + ttl)
            self._cache.move_to_end(key)
            while len(self._cache) > self._max_entries:
                self._cache.popitem(last=False)
            self._pending.pop(key, None)
        pending.set_result(snapshot)
        return snapshot

    @staticmethod
    def _fallback(entry: _Entry | None, provider: str) -> ChartSnapshot:
        return replace(entry.snapshot, stale=True) if entry else ChartSnapshot(pl.DataFrame(), provider, stale=True)

    def _fetch(self, name, factor_name, symbol, asset, period, start, end, previous):
        dataset = "daily" if period == "1d" else "minute"
        provider = resolve_provider(name, dataset)
        start_time = datetime.combine(start, time.min, CN_TZ)
        end_time = datetime.combine(end, time.max, CN_TZ)
        if dataset == "minute":
            # Generic HTTP / 老插件可能静默忽略 freq;仅使用明确声明的原生周期。
            if period not in getattr(provider, "minute_frequencies", ("1m",)):
                raise ValueError("数据源未声明该分钟周期")
            history_days = getattr(provider, "minute_history_days", None)
            if period == "1m" and history_days:
                start_time = datetime.combine(max(start, end - timedelta(days=history_days * 2 + 10)), time.min, CN_TZ)
            fetch_minute = getattr(provider, "get_chart_minute", provider.get_minute)
            raw = fetch_minute([symbol], start_time=start_time, end_time=end_time, asset_type=asset, freq=period)
            raw = _enforce_minute_beijing_wallclock(raw, source=name)
            raw = _validate(raw, symbol, "datetime", start, end)
            if period == "30m":
                labels = raw["datetime"].dt.strftime("%H:%M").to_list()
                if any(label not in {"10:00", "10:30", "11:00", "11:30", "13:30", "14:00", "14:30", "15:00"} for label in labels):
                    raise ValueError("30分钟K必须使用区间结束时间")
            adjustment = getattr(provider, "minute_adjustment", "unknown")
            frame = raw
        else:
            # 首次拉完整窗口;后续只更新尾部,保留同源原始历史,再统一复权。
            if not previous.is_empty():
                start_time = datetime.combine(max(start, previous["date"].max() - timedelta(days=7)), time.min, CN_TZ)
            update = provider.get_daily([symbol], start_time=start_time, end_time=end_time, asset_type=asset)
            update = _validate(update, symbol, "date", start_time.date(), end)
            raw = pl.concat([previous, update], how="diagonal_relaxed") if not previous.is_empty() else update
            raw = raw.unique(subset=["symbol", "date"], keep="last").sort("date")
            # 因子失败时整个快照保留旧版,不能把原始价伪装成前复权价。
            factor_provider = resolve_provider(factor_name, "adj_factor")
            factors = factor_provider.get_adj_factors(
                [symbol], start_time=datetime.combine(start, time.min, CN_TZ),
                end_time=datetime.combine(cn_today(), time.max, CN_TZ), asset_type=asset,
            )
            frame = compute_enriched(raw, factors=factors)
            adjustment = "forward"
        estimated = "amount_estimated" in raw.columns and bool(raw["amount_estimated"].any())
        return ChartSnapshot(frame, name, cn_now().isoformat(), adjustment=adjustment, amount_estimated=estimated), raw
