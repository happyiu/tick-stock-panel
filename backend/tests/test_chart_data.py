"""展示行情缓存与盘后数据隔离(无网络)。"""
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime
from threading import Event

import polars as pl

from app.services import chart_data


class Provider:
    minute_frequencies = ("1m", "30m")
    minute_adjustment = "none"

    def __init__(self):
        self.calls = []
        self.fail = False

    def get_minute(self, symbols, start_time, end_time, asset_type, freq):
        self.calls.append((symbols, asset_type, freq, start_time))
        if self.fail:
            raise RuntimeError("offline")
        return pl.DataFrame({
            "symbol": symbols, "datetime": [datetime(2026, 9, 4, 10)],
            "open": [4.0], "high": [4.3], "low": [3.9], "close": [4.2],
            "volume": [100.0], "amount": [42000.0],
        })

    def get_daily(self, symbols, start_time, end_time, asset_type):
        self.calls.append((symbols, asset_type, "daily", start_time))
        if self.fail:
            return pl.DataFrame()
        return pl.DataFrame({
            "symbol": symbols * 2, "date": [date(2026, 9, 3), date(2026, 9, 4)],
            "open": [8.0, 4.0], "high": [8.6, 4.3], "low": [7.8, 3.9],
            "close": [8.4, 4.2], "volume": [100.0, 200.0], "amount": [84000.0, 84000.0],
        })

    def get_adj_factors(self, symbols, start_time, end_time, asset_type):
        return pl.DataFrame({"symbol": symbols, "trade_date": [date(2026, 9, 4)], "ex_factor": [2.0]})


def setup(monkeypatch):
    provider = Provider()
    monkeypatch.setattr(chart_data, "resolve_provider", lambda name, dataset: provider)
    clock = [0.0]
    service = chart_data.ChartDataService(clock=lambda: clock[0])
    return service, provider, clock


def fetch(service, period="30m", asset="etf", name="test"):
    return service.get(name, name, "510300.SH", asset, period, date(2026, 9, 1), date(2026, 9, 4))


def test_direct_30m_without_local_minute_and_cache_hit(monkeypatch):
    service, provider, _ = setup(monkeypatch)
    result = fetch(service)
    assert result.frame["close"].to_list() == [4.2]
    assert provider.calls[0][1:3] == ("etf", "30m")
    assert fetch(service).fetched_at == result.fetched_at
    assert len(provider.calls) == 1
    fetch(service, asset="stock")
    fetch(service, name="other")
    assert len(provider.calls) == 3


def test_failure_keeps_previous_snapshot_and_retries_after_ttl(monkeypatch):
    service, provider, clock = setup(monkeypatch)
    first = fetch(service)
    clock[0] = 4000
    provider.fail = True
    stale = fetch(service)
    assert stale.stale
    assert stale.frame.equals(first.frame)
    assert stale.fetched_at == first.fetched_at
    fetch(service)
    assert len(provider.calls) == 2
    provider.fail = False
    clock[0] += 4000
    assert not fetch(service).stale


def test_daily_forward_adjustment_and_empty_refresh_preserves_data(monkeypatch):
    service, provider, clock = setup(monkeypatch)
    result = fetch(service, "1d")
    assert result.adjustment == "forward"
    assert result.frame["close"].to_list() == [4.2, 4.2]
    assert result.frame["raw_close"].to_list() == [8.4, 4.2]
    clock[0] = 4000
    provider.fail = True
    assert fetch(service, "1d").frame.equals(result.frame)
    assert fetch(service, "1d").stale


def test_undeclared_frequency_does_not_call_provider(monkeypatch):
    service, provider, _ = setup(monkeypatch)
    provider.minute_frequencies = ("1m",)
    result = fetch(service)
    assert result.frame.is_empty()
    assert result.stale
    assert not provider.calls


def test_concurrent_requests_share_one_fetch(monkeypatch):
    service, provider, _ = setup(monkeypatch)
    entered, release = Event(), Event()
    original = provider.get_minute

    def slow(*args, **kwargs):
        entered.set()
        assert release.wait(5)
        return original(*args, **kwargs)

    provider.get_minute = slow
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(fetch, service)
        assert entered.wait(5)
        second = pool.submit(fetch, service)
        release.set()
        assert first.result().frame.equals(second.result().frame)
    assert len(provider.calls) == 1


def test_chart_api_uses_etf_native_bars_without_local_minute(monkeypatch):
    from types import SimpleNamespace

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api import kline

    service, provider, _ = setup(monkeypatch)
    monkeypatch.setattr(kline, "_get_asset_info", lambda *a: {"name": "沪深300ETF"})
    monkeypatch.setattr(chart_data, "cn_today", lambda: date(2026, 9, 5))
    monkeypatch.setattr("app.services.preferences.get_chart_data_provider", lambda: "test")
    app = FastAPI()
    app.include_router(kline.router)
    # 没有分钟读写方法: 直接30F请求不应依赖1分钟分区或触发落库。
    app.state.repo = SimpleNamespace(resolve_asset_type=lambda s: "etf", get_daily_asset=lambda *a, **k: pl.DataFrame())
    app.state.chart_data_service = service
    with TestClient(app) as client:
        response = client.get("/api/kline/period", params={
            "symbol": "510300.SH", "period": "30m", "start_date": "2026-09-01", "end_date": "2026-09-04",
        })
        assert response.status_code == 200
        result = response.json()
        assert result["rows"][0]["date"] == "2026-09-04 10:00"
        assert result["rows"][0]["volume"] == 100
        assert result["data_status"]["stale"] is False
        assert result["available_days"] == 1
        daily = client.get("/api/kline/daily", params={
            "symbol": "510300.SH", "start_date": "2026-09-01", "end_date": "2026-09-04",
        }).json()
        assert [r["close"] for r in daily["rows"]] == [4.2, 4.2]
        weekly = client.get("/api/kline/period", params={
            "symbol": "510300.SH", "period": "1w", "start_date": "2026-09-01", "end_date": "2026-09-04",
        }).json()
        assert weekly["rows"][0]["volume"] == 300
        assert weekly["rows"][0]["close"] == 4.2
        provider.fail = True
        empty = client.get("/api/kline/daily", params={
            "symbol": "510300.SH", "start_date": "2025-01-01", "end_date": "2025-02-01",
        }).json()
        assert empty["rows"] == []
        assert empty["data_status"]["stale"] is True
        assert client.get("/api/kline/daily", params={"symbol": "510300.SH", "start_date": "bad"}).status_code == 422


def test_cache_is_bounded_and_daily_refresh_only_fetches_tail(monkeypatch):
    service, provider, clock = setup(monkeypatch)
    service._max_entries = 2
    fetch(service, "1d")
    clock[0] = 4000
    fetch(service, "1d")
    assert provider.calls[-1][3].date() >= date(2026, 9, 1)
    fetch(service, name="a")
    fetch(service, name="b")
    assert len(service._cache) == 2


def test_wrong_period_timestamps_are_rejected(monkeypatch):
    service, provider, _ = setup(monkeypatch)
    original = provider.get_minute
    provider.get_minute = lambda *a, **k: original(*a, **k).with_columns(
        pl.lit(datetime(2026, 9, 4, 9, 31)).alias("datetime"),
    )
    assert fetch(service).frame.is_empty()


def test_factor_failure_does_not_return_unadjusted_daily(monkeypatch):
    service, provider, _ = setup(monkeypatch)

    def fail(*a, **k):
        raise RuntimeError("offline")

    provider.get_adj_factors = fail
    assert fetch(service, "1d").frame.is_empty()
