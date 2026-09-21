"""Commodity provider normalization and persistence regression tests."""
from __future__ import annotations

from datetime import date
from types import SimpleNamespace

import httpx
import pytest

from app.api import commodity as commodity_api
from app.data_providers.commodity import DEFINITIONS_BY_SYMBOL, get_json, parse_value
from app.plugins.eia.provider import _fetch as eia_fetch
from app.plugins.eia.provider import _rows as eia_rows
from app.plugins.fred.provider import _rows as fred_rows
from app.plugins.goldapi import provider as goldapi_provider
from app.plugins.goldapi.provider import _fetch as gold_fetch
from app.plugins.goldapi.provider import _fetch_current as gold_current_fetch
from app.plugins.goldapi.provider import _rows as gold_rows
from app.services.commodity_sync import _SYNC_LOCK, CommoditySyncBusyError, sync_commodities
from app.tickflow.repository import DataStore, KlineRepository


def test_provider_normalizers_keep_units_frequency_and_skip_missing_values():
    xau = DEFINITIONS_BY_SYMBOL["XAU/USD"]
    wti = DEFINITIONS_BY_SYMBOL["WTI"]
    stocks = DEFINITIONS_BY_SYMBOL["CRUDE_STOCKS"]

    gold = gold_rows(
        [{"day": "2026-09-17", "avg_price": "2500.25"}, {"day": "2026-09-16", "avg_price": ""}],
        xau,
        "2026-09-18T00:00:00+00:00",
    )
    fred = fred_rows(
        {"observations": [{"date": "2026-09-17", "value": "72.15"}, {"date": "2026-09-16", "value": "."}]},
        wti,
        "2026-09-18T00:00:00+00:00",
    )
    eia = eia_rows(
        {"response": {"data": [{"period": "2026-09-13", "value": "430000"}, {"period": "2026-09-06", "value": "NA"}]}},
        stocks,
        "2026-09-18T00:00:00+00:00",
    )

    assert gold[0]["value"] == pytest.approx(2500.25)
    assert gold[0]["unit"] == "USD/oz"
    assert gold[0]["frequency"] == "1d"
    assert len(fred) == 1 and fred[0]["source_series_id"] == "DCOILWTICO"
    assert len(eia) == 1 and eia[0]["frequency"] == "1w"
    assert parse_value(".") is None
    with pytest.raises(ValueError, match="不是有效数字"):
        parse_value("not-a-number")


def test_provider_http_errors_cover_auth_and_timeout_without_leaking_key():
    secret = "commodity-test-secret"

    def unauthorized(request):
        return httpx.Response(401, request=request, json={"error": "unauthorized"})

    with (
        httpx.Client(transport=httpx.MockTransport(unauthorized)) as client,
        pytest.raises(ValueError, match="HTTP 401") as exc,
    ):
        get_json(client, "https://example.test", params={"api_key": secret}, source="FRED")
    assert secret not in str(exc.value)

    def plan_limited(request):
        return httpx.Response(
            404,
            request=request,
            json={"message": "This symbol is available starting with the Grow or Venture plan."},
        )

    with (
        httpx.Client(transport=httpx.MockTransport(plan_limited)) as client,
        pytest.raises(ValueError, match="Grow or Venture plan") as exc,
    ):
        get_json(client, "https://example.test", params={"apikey": secret}, source="Gold API")
    assert secret not in str(exc.value)

    def timeout(request):
        raise httpx.ReadTimeout("timed out", request=request)

    with (
        httpx.Client(transport=httpx.MockTransport(timeout)) as client,
        pytest.raises(ValueError, match="请求失败: ReadTimeout"),
    ):
        get_json(client, "https://example.test", params={"api_key": secret}, source="EIA")


def test_eia_fetch_uses_dataset_route_and_series_facet():
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, request=request, json={"response": {"data": []}})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        eia_fetch(client, "test-key", "WCRSTUS1", start=date(2026, 9, 1), end=date(2026, 9, 18))

    assert len(requests) == 1
    request = requests[0]
    assert request.url.path == "/v2/petroleum/stoc/wstk/data/"
    assert request.url.params["facets[series][]"] == "WCRSTUS1"
    assert request.url.params["data[0]"] == "value"
    assert request.url.params["frequency"] == "weekly"


def test_goldapi_fetch_uses_daily_history_average_and_header():
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, request=request, json=[{"day": "2026-09-17", "avg_price": 2500.25}])

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        payload = gold_fetch(client, "test-key", "XAU", start=date(2026, 9, 1), end=date(2026, 9, 18))

    assert payload == [{"day": "2026-09-17", "avg_price": 2500.25}]
    request = requests[0]
    assert request.url.path == "/history"
    assert request.url.params["symbol"] == "XAU"
    assert request.url.params["groupBy"] == "day"
    assert request.url.params["aggregation"] == "avg"
    assert request.headers["x-api-key"] == "test-key"


def test_goldapi_fetches_current_price():
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, request=request, json={"price": 2501.5, "updatedAt": "2026-09-21T09:37:33Z"})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        payload = gold_current_fetch(client, "XAU")

    assert payload["price"] == 2501.5
    assert requests[0].url.path == "/price/XAU"


def test_goldapi_provider_maps_copper_and_crypto_symbols(monkeypatch):
    monkeypatch.setattr(goldapi_provider, "get_api_key", lambda: "test-key")
    requested: list[str] = []

    def fetch(_client, _api_key, symbol, *, start, end):
        requested.append(symbol)
        return [{"day": "2026-09-17", "avg_price": "1.25"}]

    monkeypatch.setattr(goldapi_provider, "_fetch", fetch)
    provider = goldapi_provider.GoldApiProvider()
    try:
        rows = provider.get_commodity_series(symbols=["HG", "BTC", "ETH"])
    finally:
        provider.close()

    assert requested == ["HG", "BTC", "ETH"]
    assert {row["symbol"] for row in rows} == {"HG", "BTC", "ETH"}
    assert {row["category"] for row in rows if row["symbol"] == "HG"} == {"precious_metal"}
    assert {row["category"] for row in rows if row["symbol"] in {"BTC", "ETH"}} == {"crypto"}


def test_goldapi_provider_reads_current_prices(monkeypatch):
    requested: list[str] = []

    def fetch(_client, symbol):
        requested.append(symbol)
        return {"price": "2501.5", "updatedAt": "2026-09-21T09:37:33Z"}

    monkeypatch.setattr(goldapi_provider, "_fetch_current", fetch)
    provider = goldapi_provider.GoldApiProvider()
    try:
        rows = provider.get_current_prices(symbols=["HG", "BTC"])
    finally:
        provider.close()

    assert requested == ["HG", "BTC"]
    assert {row["symbol"] for row in rows} == {"HG", "BTC"}
    assert rows[0]["updated_at"] == "2026-09-21T09:37:33Z"


class _Source:
    def __init__(self, rows=None, error: Exception | None = None):
        self.rows = rows or []
        self.error = error

    def get_commodity_series(self, *, start, end, symbols):
        if self.error:
            raise self.error
        return self.rows


def _row(symbol: str, value: float, retrieved_at: str = "2026-09-18T00:00:00+00:00"):
    definition = DEFINITIONS_BY_SYMBOL[symbol]
    return {
        **definition.__dict__,
        "date": date(2026, 9, 17),
        "value": value,
        "retrieved_at": retrieved_at,
    }


def test_commodity_sync_writes_partitions_and_is_idempotent(monkeypatch, tmp_path):
    repo = KlineRepository(DataStore(tmp_path))
    source = _Source([_row("WTI", 72.15)])
    monkeypatch.setattr(
        "app.data_providers.custom.get_provider",
        lambda name: source,
    )

    first = sync_commodities(repo, start=date(2026, 9, 1), end=date(2026, 9, 18), symbols=["WTI"])
    second = sync_commodities(repo, start=date(2026, 9, 1), end=date(2026, 9, 18), symbols=["WTI"])
    changed = sync_commodities(
        repo,
        start=date(2026, 9, 1),
        end=date(2026, 9, 18),
        symbols=["WTI"],
    )

    assert first["ok"] is True
    assert first["rows_fetched"] == 1
    assert first["rows_written"] == 1
    assert second["rows_written"] == 0
    assert changed["rows_written"] == 0
    assert (tmp_path / "commodity" / "date=2026-09-17" / "part.parquet").exists()
    assert repo.execute_all("SELECT symbol, value FROM commodity") == [("WTI", 72.15)]

    later = _Source([_row("WTI", 73.2, "2026-09-19T00:00:00+00:00")])
    monkeypatch.setattr("app.data_providers.custom.get_provider", lambda name: later)
    revised = sync_commodities(
        repo,
        start=date(2026, 9, 1),
        end=date(2026, 9, 18),
        symbols=["WTI"],
    )
    assert revised["rows_written"] == 1
    assert repo.execute_all("SELECT symbol, value FROM commodity") == [("WTI", 73.2)]


def test_commodity_sync_isolates_provider_failures(monkeypatch, tmp_path):
    repo = KlineRepository(DataStore(tmp_path))
    providers = {
        "goldapi": _Source([_row("XAU/USD", 2500.25)]),
        "fred": _Source(error=ValueError("FRED HTTP 503")),
    }
    monkeypatch.setattr(
        "app.data_providers.custom.get_provider",
        lambda name: providers[name],
    )

    result = sync_commodities(
        repo,
        start=date(2026, 9, 1),
        end=date(2026, 9, 18),
        symbols=["XAU/USD", "WTI"],
    )

    assert result["ok"] is True
    assert result["rows_written"] == 1
    assert {item["provider"]: item["ok"] for item in result["providers"]} == {
        "goldapi": True,
        "fred": False,
    }
    assert repo.execute_all("SELECT symbol FROM commodity") == [("XAU/USD",)]


def test_goldapi_keeps_available_symbol_when_another_fails(monkeypatch):
    monkeypatch.setattr(goldapi_provider, "get_api_key", lambda: "test-key")

    def fetch(_client, _api_key, symbol, *, start, end):
        if symbol == "XAG":
            raise ValueError("Gold API HTTP 403")
        return [{"day": "2026-09-17", "avg_price": "2500.25"}]

    monkeypatch.setattr(goldapi_provider, "_fetch", fetch)
    provider = goldapi_provider.GoldApiProvider()
    try:
        rows = provider.get_commodity_series(symbols=["XAU/USD", "XAG/USD"])
    finally:
        provider.close()

    assert [row["symbol"] for row in rows] == ["XAU/USD"]


def test_commodity_sync_rejects_concurrent_run(tmp_path):
    repo = KlineRepository(DataStore(tmp_path))
    assert _SYNC_LOCK.acquire(blocking=False)
    try:
        with pytest.raises(CommoditySyncBusyError):
            sync_commodities(repo, symbols=["WTI"])
    finally:
        _SYNC_LOCK.release()


def test_commodity_api_filters_local_rows():
    rows = [
        ("WTI", "WTI 原油", "energy", "price", date(2026, 9, 17), 72.15, "USD/bbl", "1d", "fred", "DCOILWTICO", "now"),
    ]
    request = SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(
                repo=SimpleNamespace(execute_all=lambda sql, params: rows),
            ),
        ),
    )
    result = commodity_api.list_commodities(
        request,
        start_date=date(2026, 9, 1),
        end_date=date(2026, 9, 18),
        symbol="WTI",
        limit=100,
    )
    assert result["count"] == 1
    assert result["items"][0]["value"] == 72.15
    assert result["items"][0]["source_series_id"] == "DCOILWTICO"


def test_commodity_api_category_filter_and_empty_view():
    seen: dict[str, object] = {}
    request = SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(
                repo=SimpleNamespace(
                    execute_all=lambda sql, params: (seen.update({"sql": sql, "params": params}) or [])
                ),
            ),
        ),
    )
    result = commodity_api.list_commodities(request, category="energy", limit=5)
    assert result == {"items": [], "count": 0}
    assert "energy" in seen["params"]
    assert commodity_api.list_commodities(request, category="crypto", limit=5) == {"items": [], "count": 0}
    assert "category = ?" in str(seen["sql"])
    assert "crypto" in seen["params"]

    failing_request = SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(
                repo=SimpleNamespace(execute_all=lambda _sql, _params: (_ for _ in ()).throw(RuntimeError("no view"))),
            ),
        ),
    )
    assert commodity_api.list_commodities(failing_request)["items"] == []
