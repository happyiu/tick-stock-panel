"""Frankfurter exchange-rate fetch and local Parquet persistence."""
from __future__ import annotations

import logging
import threading
from datetime import date
from pathlib import Path
from typing import Any

import polars as pl

from app.market_time import cn_today
from app.services.fs_utils import atomic_write_parquet

logger = logging.getLogger(__name__)

TABLE = "exchange_rate"
PROVIDER_NAME = "frankfurter"
KEY_COLUMNS = ["symbol", "date", "source"]
SCHEMA = {
    "symbol": pl.Utf8,
    "date": pl.Date,
    "base": pl.Utf8,
    "quote": pl.Utf8,
    "rate": pl.Float64,
    "source": pl.Utf8,
    "frequency": pl.Utf8,
    "retrieved_at": pl.Utf8,
}

# ponytail: one global lock is enough for the single local sync stream; split by pair if throughput grows.
_SYNC_LOCK = threading.Lock()


class ExchangeRateSyncBusyError(RuntimeError):
    """Raised when a manual and scheduled sync overlap."""


def _get_provider(provider: Any | None = None) -> tuple[str, Any]:
    if provider is not None:
        return PROVIDER_NAME, provider
    from app.data_providers import custom as custom_sources
    from app.services import preferences

    name = preferences.get_exchange_rate_data_provider()
    if name != PROVIDER_NAME:
        raise ValueError(f"当前汇率数据源暂不支持: {name}")
    return name, custom_sources.get_provider(name)


def _as_frame(rows: list[dict[str, Any]]) -> pl.DataFrame:
    return pl.DataFrame(rows, schema=SCHEMA).sort(["date", "symbol"])


def _partition_path(data_dir: Path, quote_date: date) -> Path:
    return data_dir / TABLE / f"date={quote_date.isoformat()}" / "part.parquet"


def _upsert_partition(path: Path, incoming: pl.DataFrame) -> int:
    existing = pl.read_parquet(path) if path.exists() else pl.DataFrame(schema=SCHEMA)
    merged = pl.concat([existing, incoming], how="diagonal_relaxed").unique(
        subset=KEY_COLUMNS,
        keep="last",
    ).sort(["date", "symbol"])
    path.parent.mkdir(parents=True, exist_ok=True)
    # 抓取时间是元数据; 同一业务值重复拉取不应触发整分区重写。
    existing_values = existing.drop("retrieved_at") if "retrieved_at" in existing else existing
    merged_values = merged.drop("retrieved_at")
    if existing.is_empty() or not existing_values.equals(merged_values):
        atomic_write_parquet(merged, path)
        return len(merged)
    return 0


def sync_exchange_rates(
    repo,
    *,
    start: date | None = None,
    end: date | None = None,
    provider: Any | None = None,
) -> dict[str, Any]:
    """Fetch Frankfurter data and idempotently write exchange_rate partitions.

    No dates means the provider's latest-value endpoint. Supplying either date
    fills the other side with the same date (or today for an open-ended start).
    """
    if start is not None and end is None:
        end = cn_today()
    elif end is not None and start is None:
        start = end
    if start is not None and end is not None and start > end:
        raise ValueError("汇率开始日期不能晚于结束日期")

    if not _SYNC_LOCK.acquire(blocking=False):
        raise ExchangeRateSyncBusyError("汇率同步正在进行中")
    try:
        provider_name, source = _get_provider(provider)
        rows = source.get_exchange_rates(start=start, end=end)
        result: dict[str, Any] = {
            "provider": provider_name,
            "symbol": "USD/CNY",
            "symbols": [],
            "rows_fetched": len(rows),
            "rows_written": 0,
            "start_date": None,
            "end_date": None,
            "latest_rate": None,
            "latest_rates": {},
        }
        if not rows:
            logger.info("exchange rate sync returned no rows: start=%s end=%s", start, end)
            return result

        frame = _as_frame(rows)
        for quote_date in frame.get_column("date").unique().sort().to_list():
            part = frame.filter(pl.col("date") == quote_date)
            result["rows_written"] += _upsert_partition(
                _partition_path(repo.store.data_dir, quote_date), part,
            )

        repo.rebuild_views()
        from app.api.data import invalidate_storage_cache
        invalidate_storage_cache()

        latest_by_symbol: dict[str, dict[str, Any]] = {}
        for row in frame.sort(["symbol", "date"]).to_dicts():
            latest_by_symbol[row["symbol"]] = row
        latest_rates = {
            symbol: float(row["rate"])
            for symbol, row in latest_by_symbol.items()
        }
        result.update({
            "symbols": sorted(latest_rates),
            "start_date": frame.get_column("date").min().isoformat(),
            "end_date": frame.get_column("date").max().isoformat(),
            "latest_rate": latest_rates.get("USD/CNY"),
            "latest_rates": latest_rates,
        })
        logger.info(
            "exchange rate sync complete: provider=%s rows=%d range=%s..%s",
            provider_name,
            result["rows_written"],
            result["start_date"],
            result["end_date"],
        )
        return result
    finally:
        _SYNC_LOCK.release()
