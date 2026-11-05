# ruff: noqa: RUF001
"""Read rotation snapshots through the application's repository boundary."""

import hashlib
import json
import math
from datetime import date, datetime, time, timedelta

from app.market_time import cn_now

from .models import SOURCE_REVISION, VERSION
from .signals import SignalBook, history_bars, required_symbols

INDEX = "000300.SH"


def closed_date():
    now = cn_now()
    return (
        now.date()
        if now.time().replace(tzinfo=None) >= time(15, 10)
        else now.date() - timedelta(days=1)
    )


def _rows(frame):
    rows = []
    for original in frame.to_dicts():
        row = {}
        for key, value in original.items():
            if isinstance(value, (date, datetime)):
                value = value.isoformat()[:10]
            if isinstance(value, float) and not math.isfinite(value):
                value = None
            row[key] = value
        rows.append(row)
    return rows


def validate_catalog(repo, config):
    available = repo.get_etf_symbol_set()
    missing = set(required_symbols(config)) - available
    if missing:
        raise ValueError("ETF目录中不存在: " + ", ".join(sorted(missing)))


def load_snapshot(repo, request):
    validate_catalog(repo, request.config)
    end = min(request.end, closed_date())
    if request.end > closed_date():
        raise ValueError("结束日期必须是已经完整收盘且已落盘的交易日之前或当日")
    start = request.start - timedelta(days=max(366, history_bars(request.config) * 3))
    columns = [
        "date",
        "symbol",
        "open",
        "high",
        "low",
        "close",
        "volume",
        "amount",
        "raw_close",
        "raw_high",
        "raw_low",
    ]
    etfs = {
        s: _rows(repo.get_etf_daily(s, start, end, columns=columns))
        for s in required_symbols(request.config)
    }
    index = _rows(repo.get_index_daily(INDEX, start, end, columns=["date", "close"]))
    from app.services.regime_builder import load_regime_history

    context = load_regime_history(repo.store.data_dir) if hasattr(repo, "store") else None
    environment = []
    if context is not None and not context.is_empty():
        import polars as pl

        columns = [key for key in ["date", "state", "score"] if key in context.columns]
        environment = _rows(context.filter(pl.col("date").is_between(start, end)).select(columns))
    return {
        "market_environment": environment,
        "etfs": etfs,
        "index": index,
        "algorithm_version": VERSION,
        "source_revision": SOURCE_REVISION,
        "captured_at": cn_now().isoformat(),
        "price_basis": "前复权价研究回测",
    }


def snapshot_digest(snapshot):
    payload = {k: snapshot[k] for k in ["etfs", "index", "market_environment"] if k in snapshot}
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, ensure_ascii=False, allow_nan=False).encode()
    ).hexdigest()


def check_snapshot(config, snapshot, start, end):
    book = SignalBook(config, snapshot)
    eligible = [d for d in book.dates if book.valid(d)]
    proposed = next((d for d in eligible if d >= start), None)
    sessions = [d for d in book.dates if start <= d <= end]
    coverage = []
    for symbol in [*required_symbols(config), INDEX]:
        rows = snapshot["index"] if symbol == INDEX else snapshot["etfs"].get(symbol, [])
        coverage.append(
            {
                "symbol": symbol,
                "first": rows[0]["date"] if rows else None,
                "last": rows[-1]["date"] if rows else None,
                "rows": len(rows),
            }
        )
    incomplete = [day for day in sessions if not book.valid(day)]
    missing_index = [day for day in sessions if day not in book.index]
    start_ready = bool(sessions and proposed == sessions[0])
    ready = bool(start_ready and not incomplete)
    if start_ready and incomplete:
        reason = f"区间内有{len(incomplete)}个交易日数据或预热不完整，请先准备数据；不能按完整区间评估策略"
        proposed = None
    else:
        reason = "" if ready else "全池或参考资产尚未具备完整预热数据，请准备数据或确认共同可用起点"
    return {
        "ready": ready,
        "proposed_start": proposed,
        "requested_start": start,
        "requested_end": end,
        "warmup_bars": history_bars(config),
        "coverage": coverage,
        "incomplete_days": len(incomplete),
        "missing_index_dates": missing_index,
        "reason": reason,
        "data_digest": snapshot_digest(snapshot),
    }


def prepare(repo, capset, request, progress):
    from app.data_providers import custom as custom_sources
    from app.data_providers.normalizer import normalize_daily
    from app.data_providers.registry import get_provider
    from app.indicators.pipeline import compute_enriched
    from app.services import index_sync, preferences

    validate_catalog(repo, request.config)
    start = datetime.combine(
        request.start - timedelta(days=max(366, history_bars(request.config) * 3)), time.min
    )
    end = datetime.combine(min(request.end, closed_date()), time.max)
    progress(2)
    _, failed_factors = index_sync.sync_etf_adj_factor(
        required_symbols(request.config), repo, capset, start_time=start, end_time=end
    )
    if failed_factors:
        raise ValueError("ETF复权因子准备失败: " + ", ".join(failed_factors))
    progress(5)
    index_sync.sync_and_persist_etf_daily(
        repo,
        capset,
        start_date=start,
        end_date=end,
        symbols_override=required_symbols(request.config),
        on_chunk_done=lambda done, total: progress(5 + int(65 * done / max(total, 1))),
    )
    progress(75)
    provider_name = preferences.get_daily_data_provider()
    index_source = provider_name
    index_source_note = None
    if provider_name == "tickflow":
        index_sync.sync_and_persist_index_daily(
            repo, capset, start_date=start, end_date=end, symbols_override=[INDEX]
        )
    else:
        import polars as pl

        def fetch_index(provider, source):
            frame = normalize_daily(
                provider.get_daily([INDEX], start_time=start, end_time=end, asset_type="index"),
                source=source,
            )
            if frame.is_empty():
                return frame
            return frame.filter(
                (pl.col("symbol") == INDEX)
                & pl.col("date").is_between(start.date(), end.date())
            )

        primary_error = None
        raw = pl.DataFrame()
        if custom_sources.provider_has_dataset(provider_name, "daily"):
            try:
                raw = fetch_index(custom_sources.get_provider(provider_name), provider_name)
            except Exception as exc:
                primary_error = exc
        else:
            primary_error = ValueError("未配置日线数据集")

        if raw.is_empty():
            if primary_error is None:
                primary_error = ValueError("未返回沪深300指数日线")
            try:
                raw = fetch_index(get_provider("tickflow"), "tickflow")
            except Exception as exc:
                raise ValueError(
                    f"{provider_name}未能提供沪深300指数日线，TickFlow备用源也不可用"
                ) from exc
            if raw.is_empty():
                raise ValueError(
                    f"{provider_name}未能提供沪深300指数日线，TickFlow备用源未返回数据"
                ) from primary_error
            index_source = "tickflow"
            index_source_note = f"{provider_name}未能返回沪深300日线，已使用TickFlow备用源"

        repo.append_index_daily(raw)
        repo.append_index_enriched(compute_enriched(raw, factors=None, instruments=None))
    repo.refresh_index_views()
    progress(95)
    snap = load_snapshot(repo, request)
    check = check_snapshot(request.config, snap, request.start.isoformat(), request.end.isoformat())
    check["index_source"] = index_source
    if index_source_note:
        check["index_source_note"] = index_source_note
    return check
