"""Fetch and persist the fixed multi-source commodity history dataset."""
from __future__ import annotations

import logging
import threading
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import polars as pl

from app.data_providers.commodity import definitions_for
from app.market_time import cn_today
from app.services.fs_utils import atomic_write_parquet

logger = logging.getLogger(__name__)

TABLE = "commodity"
KEY_COLUMNS = ["symbol", "date", "source", "source_series_id", "frequency"]
SCHEMA = {
    "symbol": pl.Utf8,
    "name": pl.Utf8,
    "category": pl.Utf8,
    "kind": pl.Utf8,
    "date": pl.Date,
    "value": pl.Float64,
    "unit": pl.Utf8,
    "frequency": pl.Utf8,
    "source": pl.Utf8,
    "source_series_id": pl.Utf8,
    "retrieved_at": pl.Utf8,
}

# ponytail: one global lock is enough for the single local commodity sync stream; split by source if throughput grows.
_SYNC_LOCK = threading.Lock()


class CommoditySyncBusyError(RuntimeError):
    """Raised when a manual and scheduled commodity sync overlap."""


def _as_frame(rows: list[dict[str, Any]]) -> pl.DataFrame:
    return pl.DataFrame(rows, schema=SCHEMA).sort(["date", "symbol", "source"])


def _partition_path(data_dir: Path, quote_date: date) -> Path:
    return data_dir / TABLE / f"date={quote_date.isoformat()}" / "part.parquet"


def _upsert_partition(path: Path, incoming: pl.DataFrame) -> int:
    existing = pl.read_parquet(path) if path.exists() else pl.DataFrame(schema=SCHEMA)
    merged = pl.concat([existing, incoming], how="diagonal_relaxed").unique(
        subset=KEY_COLUMNS,
        keep="last",
    ).sort(["date", "symbol", "source"])
    path.parent.mkdir(parents=True, exist_ok=True)
    existing_values = existing.drop("retrieved_at") if "retrieved_at" in existing else existing
    merged_values = merged.drop("retrieved_at")
    if existing.is_empty() or not existing_values.equals(merged_values):
        atomic_write_parquet(merged, path)
        return len(merged)
    return 0


def _date_range(start: date | None, end: date | None) -> tuple[date, date]:
    today = cn_today()
    if start is None and end is None:
        return today - timedelta(days=14), today
    if start is None:
        start = end
    if end is None:
        end = today
    if start is None or end is None or start > end:
        raise ValueError("商品开始日期不能晚于结束日期")
    return start, end


def _provider_rows(
    provider_name: str,
    *,
    start: date,
    end: date,
    symbols: list[str],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    from app.data_providers import custom as custom_sources

    try:
        provider = custom_sources.get_provider(provider_name)
        fetch = getattr(provider, "get_commodity_series", None)
        if fetch is None:
            raise ValueError(f"数据源 {provider_name} 未实现商品数据能力")
        rows = fetch(start=start, end=end, symbols=symbols)
        if not isinstance(rows, list):
            raise ValueError(f"数据源 {provider_name} 返回格式无效")
        return rows, {
            "provider": provider_name,
            "ok": True,
            "rows_fetched": len(rows),
            "rows_written": 0,
            "symbols": sorted({str(row.get("symbol")) for row in rows if row.get("symbol")}),
            "error": None,
        }
    except Exception as exc:
        logger.warning("commodity provider %s failed: %s", provider_name, exc)
        return [], {
            "provider": provider_name,
            "ok": False,
            "rows_fetched": 0,
            "rows_written": 0,
            "symbols": [],
            "error": str(exc),
        }


def sync_commodities(
    repo,
    *,
    start: date | None = None,
    end: date | None = None,
    symbols: list[str] | None = None,
) -> dict[str, Any]:
    """Sync selected source groups and idempotently write commodity partitions."""
    range_start, range_end = _date_range(start, end)
    definitions = definitions_for(symbols)
    by_source: dict[str, list[str]] = {}
    for definition in definitions:
        by_source.setdefault(definition.source, []).append(definition.symbol)

    if not _SYNC_LOCK.acquire(blocking=False):
        raise CommoditySyncBusyError("商品同步正在进行中")
    try:
        result: dict[str, Any] = {
            "ok": False,
            "start_date": range_start.isoformat(),
            "end_date": range_end.isoformat(),
            "providers": [],
            "rows_fetched": 0,
            "rows_written": 0,
            "symbols": [],
        }
        changed = False
        for provider_name, provider_symbols in by_source.items():
            rows, provider_result = _provider_rows(
                provider_name,
                start=range_start,
                end=range_end,
                symbols=provider_symbols,
            )
            result["providers"].append(provider_result)
            result["rows_fetched"] += provider_result["rows_fetched"]
            if not rows:
                continue
            try:
                frame = _as_frame(rows)
                for quote_date in frame.get_column("date").unique().sort().to_list():
                    part = frame.filter(pl.col("date") == quote_date)
                    written = _upsert_partition(
                        _partition_path(repo.store.data_dir, quote_date),
                        part,
                    )
                    provider_result["rows_written"] += written
                    result["rows_written"] += written
                    changed = changed or written > 0
                result["symbols"] = sorted(set(result["symbols"]) | set(provider_result["symbols"]))
            except Exception as exc:
                provider_result["ok"] = False
                provider_result["error"] = str(exc)
                logger.warning("commodity provider %s persistence failed: %s", provider_name, exc)

        result["ok"] = any(item["ok"] for item in result["providers"])
        if changed:
            repo.rebuild_views()
            from app.api.data import invalidate_storage_cache
            invalidate_storage_cache()
        logger.info(
            "commodity sync complete: providers=%s rows=%d written=%d range=%s..%s",
            ",".join(item["provider"] for item in result["providers"] if item["ok"]),
            result["rows_fetched"],
            result["rows_written"],
            result["start_date"],
            result["end_date"],
        )
        return result
    finally:
        _SYNC_LOCK.release()
