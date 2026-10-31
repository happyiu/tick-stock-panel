"""ETF watchlist ticks and full-market minute refresh share one serialized poll."""
from __future__ import annotations

from datetime import timedelta
from types import SimpleNamespace

import polars as pl
import pytest

from app.data_providers import custom
from app.market_time import cn_today
from app.services import preferences, watchlist
from app.services import quote_service as qs
from app.tickflow.repository import DataStore, KlineRepository

ETFS = {"159992.SZ", "510300.SH"}


@pytest.fixture(params=["fuyao", "astockdata", "tickflow"])
def polling(monkeypatch, request):
    state = SimpleNamespace(
        provider=request.param, now=0.0, day=cn_today(), pull_all=True,
        watchlist=["159992.SZ", "600519.SH"], fail=False,
        stock_interval=10.0, watchlist_interval=10.0, pool_interval=60.0,
    )
    service = qs.QuoteService()
    service._repo = SimpleNamespace(
        get_etf_symbol_set=lambda: ETFS,
        get_etf_instruments=lambda: pl.DataFrame({"symbol": sorted(ETFS)}),
        get_instruments=lambda: pl.DataFrame({"symbol": ["600519.SH"]}),
        get_index_symbol_set=set,
    )
    requests: list[list[str]] = []
    captured: list[list[dict]] = []
    state.stock_calls = []
    state.etf_calls = []

    def records(symbols):
        symbols = list(symbols)
        if "600519.SH" in symbols:
            state.stock_calls.append(state.now)
        if set(symbols) & ETFS:
            state.etf_calls.append(state.now)
            requests.append(sorted(set(symbols) & ETFS))
            if state.fail == "exception":
                raise RuntimeError("ETF endpoint unavailable")
            if state.fail == "empty":
                return []
        return [{"symbol": symbol, "last_price": 0.0 if state.fail == "zero" else 4.1} for symbol in symbols]

    class _Provider:
        def get_realtime(self, symbols=None):
            return records(symbols if symbols is not None else ["600519.SH"])

    class _Quotes:
        def get_by_universes(self, universes):
            symbols = ({"600519.SH"} if "CN_Equity_A" in universes else set())
            if "CN_ETF" in universes:
                symbols |= ETFS
            return records(sorted(symbols))

        def get(self, symbols):
            return records(symbols)

    monkeypatch.setattr(preferences, "get_realtime_data_provider", lambda: state.provider)
    monkeypatch.setattr(preferences, "get_realtime_pull_etf", lambda: state.pull_all)
    monkeypatch.setattr(preferences, "get_realtime_pull_stock", lambda: True)
    monkeypatch.setattr(preferences, "get_realtime_quote_interval", lambda: state.stock_interval)
    monkeypatch.setattr(preferences, "get_realtime_etf_watchlist_interval", lambda: state.watchlist_interval)
    monkeypatch.setattr(preferences, "get_realtime_etf_pool_interval", lambda: state.pool_interval)
    monkeypatch.setattr(watchlist, "list_symbols", lambda: [{"symbol": s} for s in state.watchlist])
    monkeypatch.setattr(custom, "provider_has_dataset", lambda *args: True)
    monkeypatch.setattr(custom, "get_provider", lambda name: _Provider())
    monkeypatch.setattr("app.tickflow.client.get_paid_realtime_client", lambda: SimpleNamespace(quotes=_Quotes()))
    monkeypatch.setattr(qs.time, "perf_counter", lambda: state.now)
    monkeypatch.setattr(qs, "cn_today", lambda: state.day)
    monkeypatch.setattr(service, "_process_full_market_records", lambda rows, **kw: captured.append(rows))
    return service, state, requests, captured


def test_full_refresh_once_per_minute_and_watchlist_between(polling):
    service, state, requests, captured = polling
    for elapsed in (0, 10, 20, 30, 40, 50, 59.9, 60):
        state.now = elapsed
        service._fetch_full_market_quotes()
    assert requests == [sorted(ETFS), *([["159992.SZ"]] * 5), sorted(ETFS)]
    for rows in captured:
        symbols = [row["symbol"] for row in rows]
        assert len(symbols) == len(set(symbols))
        assert "600519.SH" in symbols


def test_empty_watchlist_still_refreshes_full_catalog_each_minute(polling):
    service, state, requests, _ = polling
    state.watchlist = []
    for elapsed in (0, 10, 60):
        state.now = elapsed
        service._fetch_full_market_quotes()
    assert requests == [sorted(ETFS), sorted(ETFS)]


def test_watchlist_changes_take_effect_on_next_tick(polling):
    service, state, requests, _ = polling
    service._fetch_full_market_quotes()
    state.now = 10
    state.watchlist = ["510300.SH"]
    service._fetch_full_market_quotes()
    assert requests == [sorted(ETFS), ["510300.SH"]]


def test_final_sync_bypasses_full_refresh_cooldown(polling):
    service, state, requests, _ = polling
    service._fetch_full_market_quotes()
    state.now = 10
    service._fetch_full_market_quotes(final_boundary_ms=123)
    assert requests == [sorted(ETFS), sorted(ETFS)]


@pytest.mark.parametrize("reset", ["new_day", "provider", "scope"])
def test_new_context_gets_an_immediate_full_refresh(polling, reset):
    service, state, requests, _ = polling
    service._fetch_full_market_quotes()
    state.now = 10
    if reset == "new_day":
        state.day += timedelta(days=1)
    elif reset == "provider":
        state.provider = "another_custom_source"
    else:
        state.pull_all = False
        service._fetch_full_market_quotes()
        assert requests[-1] == ["159992.SZ"]
        state.pull_all = True
    service._fetch_full_market_quotes()
    assert requests[-1] == sorted(ETFS)


@pytest.mark.parametrize("failure", ["empty", "exception", "zero"])
def test_failed_full_request_retries_without_forging_success(polling, failure):
    service, state, requests, _ = polling
    state.fail = failure
    service._fetch_full_market_quotes()
    state.now = 60
    state.fail = False
    service._fetch_full_market_quotes()
    assert requests == [sorted(ETFS), sorted(ETFS)]


def test_configured_intervals_schedule_each_scope_independently(polling):
    service, state, requests, _ = polling
    state.stock_interval, state.watchlist_interval, state.pool_interval = 30, 10, 45
    for elapsed in (0, 5, 10, 20, 30, 40, 45, 50, 55, 60):
        state.now = elapsed
        service._fetch_full_market_quotes()
    assert state.stock_calls == [0, 30, 60]
    assert requests == [sorted(ETFS), ["159992.SZ"], ["159992.SZ"], ["159992.SZ"],
                        ["159992.SZ"], sorted(ETFS), ["159992.SZ"], ["159992.SZ"]]
    assert state.etf_calls == [0, 10, 20, 30, 40, 45, 50, 60]


def test_faster_pool_refresh_does_not_postpone_watchlist_clock(polling):
    service, state, requests, _ = polling
    state.watchlist_interval, state.pool_interval = 30, 10
    for elapsed in (0, 10, 20, 30, 40):
        state.now = elapsed
        service._fetch_full_market_quotes()
        assert service._poll_attempts["etf_watchlist"][2] == (0 if elapsed < 30 else 30)
    # Simultaneous deadlines use the full-pool response once.
    assert requests == [sorted(ETFS)] * 5


def test_interval_change_takes_effect_without_restart(polling):
    service, state, requests, _ = polling
    service._fetch_full_market_quotes()
    state.now = 7
    state.watchlist_interval = 7
    service._fetch_full_market_quotes()
    assert requests == [sorted(ETFS), ["159992.SZ"]]


def test_manual_refresh_bypasses_all_scope_timers(polling, monkeypatch):
    service, _, requests, _ = polling
    service._fetch_full_market_quotes()
    monkeypatch.setattr(service, "_market_phase", lambda: "closed")
    monkeypatch.setattr(service, "status", dict)
    service.refresh()
    assert requests == [sorted(ETFS), sorted(ETFS)]


@pytest.mark.parametrize("start_method", ["enable", "start"])
def test_reenabled_service_refreshes_full_catalog_immediately(polling, monkeypatch, start_method):
    service, state, requests, _ = polling
    service._fetch_full_market_quotes()
    monkeypatch.setattr(service, "_save_enabled", lambda enabled: None)
    monkeypatch.setattr(service, "is_realtime_allowed", lambda: True)
    monkeypatch.setattr(service, "_clamp_interval", lambda interval: interval)
    monkeypatch.setattr(qs.threading, "Thread", lambda **kw: SimpleNamespace(start=lambda: None))
    if start_method == "start":
        service.start(interval=10)
    else:
        assert service.enable()
    state.now = 10
    service._fetch_full_market_quotes()
    assert requests == [sorted(ETFS), sorted(ETFS)]


def _daily(symbol, day, price):
    return {"symbol": symbol, "date": day, "open": price, "high": price,
            "low": price, "close": price, "volume": 1000.0, "amount": price * 1000}


def test_watchlist_tick_preserves_other_etfs_on_disk_and_in_pool(tmp_path, monkeypatch):
    today = cn_today()
    repo = KlineRepository(DataStore(tmp_path))
    repo._etf_instruments_cache = pl.DataFrame({"symbol": sorted(ETFS), "name": ["ETF A", "ETF B"]})
    repo.append_etf_daily(pl.DataFrame([
        _daily(symbol, today - timedelta(days=i), 4.0)
        for symbol in sorted(ETFS) for i in range(1, 11)
    ]))
    service = qs.QuoteService()
    service.set_repo(repo)
    monkeypatch.setattr(qs, "_persist_last_fetch", lambda *a: None)
    monkeypatch.setattr(service, "_update_volume_delta", lambda *a: None)
    pushes = []
    monkeypatch.setattr(service, "_broadcast_quote_updated", lambda: pushes.append(True))

    def tick(prices):
        rows = []
        for symbol, price in prices.items():
            row = _daily(symbol, today, price)
            row["last_price"] = row.pop("close")
            row.pop("date")
            rows.append(row)
        service._process_full_market_records(rows, t0=0.0, now_ts=0.0)

    tick({"159992.SZ": 4.1, "510300.SH": 4.2})
    before = repo.get_etf_quote_snapshot(sorted(ETFS))
    tick({"159992.SZ": 4.3})

    for table, column in (("kline_etf_daily", "close"), ("kline_etf_enriched", "raw_close")):
        frame = pl.read_parquet(tmp_path / table / f"date={today}" / "part.parquet")
        assert dict(frame.select("symbol", column).iter_rows()) == {"159992.SZ": 4.3, "510300.SH": 4.2}
    quotes = {row["symbol"]: row for row in repo.get_etf_quote_snapshot(sorted(ETFS)).to_dicts()}
    assert quotes["159992.SZ"]["last_price"] == 4.3
    assert quotes["510300.SH"] == before.filter(pl.col("symbol") == "510300.SH").to_dicts()[0]
    cached, cache_date = repo.get_enriched_latest_asset("etf", refresh=False)
    assert cache_date == today
    assert set(cached["symbol"]) == ETFS
    assert len(pushes) == 2


def test_success_times_are_scoped_and_failed_prices_do_not_advance_them(monkeypatch):
    monkeypatch.setattr(preferences, "load", dict)
    monkeypatch.setattr(watchlist, "list_symbols", lambda: [{"symbol": "159992.SZ"}])
    service = qs.QuoteService()
    service._repo = SimpleNamespace(
        get_index_symbol_set=set,
        get_etf_instruments=lambda: pl.DataFrame({"symbol": sorted(ETFS)}),
        flush_live_daily=lambda frame: None,
        merge_live_daily_asset=lambda *args: None,
    )
    monkeypatch.setattr(service, "_flush_live_enriched", lambda *args, **kwargs: None)
    monkeypatch.setattr(service, "_broadcast_quote_updated", lambda: None)
    monkeypatch.setattr(service, "_update_volume_delta", lambda *args: None)
    monkeypatch.setattr(qs, "_persist_last_fetch", lambda *args: None)
    clock = [100.0]
    monkeypatch.setattr(qs.time, "time", lambda: clock[0])

    def tick(symbols, pool=False, price=4.0):
        rows = [{"symbol": s, "last_price": price, "open": 4.0, "high": 4.1, "low": 3.9,
                 "volume": 1000.0, "amount": 4000.0} for s in symbols]
        service._process_full_market_records(rows, t0=0.0, now_ts=0.0, etf_pool_refresh=pool)

    tick(["600519.SH"])
    clock[0] = 110
    tick(ETFS, pool=True)
    clock[0] = 120
    tick(["159992.SZ"])
    assert service._scope_fetch_times == {
        "stock_last_fetch_ms": 100_000, "etf_watchlist_last_fetch_ms": 120_000, "etf_pool_last_fetch_ms": 110_000,
    }
    clock[0] = 130
    tick(ETFS, pool=True, price=0)
    assert service._scope_fetch_times["etf_pool_last_fetch_ms"] == 110_000
    assert service._scope_fetch_times["etf_watchlist_last_fetch_ms"] == 120_000
    assert service._symbol_count == 1


@pytest.mark.parametrize(('extra', 'expected'), [
    ({'change_pct': -.02, 'prev_close': 1.5}, -.02),
    ({'prev_close': 1.5}, -.02),
    ({'change_pct': float('nan'), 'prev_close': 1.5}, -.02),
    ({'change_pct': 0.}, 0.),
    ({'prev_close': 0.}, None),
    ({}, None),
])
def test_etf_daily_return_uses_quote_reference_instead_of_stale_history(tmp_path, monkeypatch, extra, expected):
    today = cn_today()
    repo = KlineRepository(DataStore(tmp_path))
    repo._etf_instruments_cache = pl.DataFrame({'symbol': sorted(ETFS), 'name': ['ETF A', 'ETF B']})
    repo.append_etf_daily(pl.DataFrame([
        _daily('159992.SZ', today - timedelta(days=5), 1.),
        _daily('510300.SH', today - timedelta(days=1), 2.),
    ]))
    service = qs.QuoteService()
    service.set_repo(repo)
    monkeypatch.setattr(qs, '_persist_last_fetch', lambda *a: None)
    monkeypatch.setattr(service, '_update_volume_delta', lambda *a: None)
    monkeypatch.setattr(service, '_broadcast_quote_updated', lambda: None)
    rows = []
    for symbol, price in [('159992.SZ', 1.47), ('510300.SH', 1.98)]:
        record = _daily(symbol, today, price)
        record['last_price'] = record.pop('close')
        record.pop('date')
        if symbol == '159992.SZ':
            record.update(extra)
        rows.append(record)
    service._process_full_market_records(rows, t0=0., now_ts=0.)
    cache, _ = repo.get_enriched_latest_asset('etf', refresh=False)
    value = cache.filter(pl.col('symbol') == '159992.SZ')['change_pct'][0]
    assert value is None if expected is None else value == pytest.approx(expected)
    for instance in (repo, KlineRepository(DataStore(tmp_path))):
        quotes = {r['symbol']: r for r in instance.get_etf_quote_snapshot(sorted(ETFS)).to_dicts()}
        value = quotes['159992.SZ']['change_pct']
        assert value is None if expected is None else value == pytest.approx(expected)
        if expected is not None:
            warmed, _ = instance.get_enriched_latest_asset('etf')
            assert warmed.filter(pl.col('symbol') == '159992.SZ')['change_pct'][0] == pytest.approx(expected)
