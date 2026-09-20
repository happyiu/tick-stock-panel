"""向前扩展 ETF 历史日K数据。

ETF 日K与股票日K分开存储,因此这里只扩展 ETF 日K及其 enriched,
不触发股票除权因子或股票 enriched 的全量重算。
"""
from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import date, datetime

from app.services import index_sync
from app.services.extend_history import compute_offset
from app.tickflow.capabilities import CapabilitySet
from app.tickflow.repository import KlineRepository

logger = logging.getLogger(__name__)


def _noop(stage: str, pct: int, msg: str, **kwargs) -> None:
    pass


def run_extend_etf_history(
    repo: KlineRepository,
    capset: CapabilitySet,
    value: int,
    unit: str,
    start_date: date | None = None,
    end_date: date | None = None,
    on_progress: Callable | None = None,
) -> dict:
    """按时长向前扩展,或按指定区间回补 ETF 日K及 enriched。"""
    emit = on_progress or _noop

    emit("extend_etf_history", 2, "检查当前 ETF 数据范围…")
    earliest = repo.earliest_daily_date("etf")
    if not earliest:
        return {"error": "本地无 ETF 日K数据,请先执行一次 ETF 同步"}

    explicit_range = start_date is not None or end_date is not None
    if explicit_range:
        if start_date is None or end_date is None:
            return {"error": "指定区间必须同时提供 start_date 和 end_date"}
        if start_date > end_date:
            return {"error": "指定区间无效,start_date 不能晚于 end_date"}
        sync_start = start_date
        sync_end = end_date
    else:
        offset = compute_offset(value, unit)
        sync_start = earliest - offset
        sync_end = earliest
        if sync_start >= sync_end:
            return {"error": "扩展范围无效,请增大时间跨度"}

    emit("extend_etf_history", 5, "解析 ETF 标的池…")
    instruments = repo.get_etf_instruments()
    if instruments.is_empty() or "symbol" not in instruments.columns:
        return {"error": "ETF 标的池为空,请先执行一次 ETF 同步"}
    symbols = sorted(set(str(symbol) for symbol in instruments["symbol"].to_list() if symbol))
    if not symbols:
        return {"error": "ETF 标的池为空,请先执行一次 ETF 同步"}
    emit("extend_etf_history", 8, f"ETF 标的池: {len(symbols)} 只")

    start_str = sync_start.strftime("%Y-%m-%d")
    end_str = sync_end.strftime("%Y-%m-%d")
    emit("extend_etf_history", 10, f"获取 ETF 日K [{start_str} ~ {end_str}]…")
    logger.info(
        "extend_etf_history: ETF daily K [%s ~ %s], %d symbols",
        start_str,
        end_str,
        len(symbols),
    )

    def _daily_chunk(cur: int, tot: int) -> None:
        total = max(tot, 1)
        emit(
            "extend_etf_history",
            10 + int(75 * cur / total),
            f"ETF 日K批次 {cur}/{tot}",
            stage_pct=int(100 * cur / total),
            skip_log=True,
        )

    written_daily = index_sync.sync_and_persist_etf_daily(
        repo,
        capset,
        start_date=datetime.combine(sync_start, datetime.min.time()),
        end_date=datetime.combine(sync_end, datetime.min.time()),
        symbols_override=symbols,
        on_chunk_done=_daily_chunk,
    )
    if written_daily <= 0:
        return {"error": "未获取到 ETF 历史日K,请检查数据源或回补范围"}
    emit("extend_etf_history", 90, f"ETF 日K完成,写入 {written_daily} 行")
    logger.info("extend_etf_history: ETF daily K done, %d rows", written_daily)

    repo.refresh_index_views()
    daily_dir = repo.store.data_dir / "kline_etf_daily"
    enriched_dir = repo.store.data_dir / "kline_etf_enriched"
    daily_days = len(list(daily_dir.glob("date=*"))) if daily_dir.exists() else 0
    enriched_days = len(list(enriched_dir.glob("date=*"))) if enriched_dir.exists() else 0

    emit("extend_etf_history", 95, "刷新 ETF 视图…")
    emit(
        "extend_etf_history",
        100,
        f"完成,ETF 已回补 [{start_str} ~ {end_str}]"
        if explicit_range else f"完成,ETF 已扩展至 {start_str}",
    )

    return {
        "asset_type": "etf",
        "mode": "range" if explicit_range else "extend",
        "universe_size": len(symbols),
        "earliest_before": earliest.isoformat(),
        "earliest_after": min(earliest, sync_start).isoformat(),
        "requested_start": start_str,
        "requested_end": end_str,
        "daily_rows": written_daily,
        "etf_daily_rows": written_daily,
        "daily_days": daily_days,
        "etf_daily_days": daily_days,
        "enriched_days": enriched_days,
        "etf_enriched_days": enriched_days,
    }
