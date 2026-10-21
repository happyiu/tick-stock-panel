"""行情轮询间隔接口: quote_service 缺失时的兜底分支不能抛 AttributeError (issue #261)。"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from app.api.settings import QuoteIntervalIn, update_quote_interval
from app.services import preferences
from app.services.quote_service import QuoteService


def _request_without_quote_service() -> SimpleNamespace:
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(quote_service=None)))


def test_update_quote_interval_without_service_returns_defaults():
    result = update_quote_interval(
        QuoteIntervalIn(interval=6.0), request=_request_without_quote_service()
    )

    assert result == {"interval": 6.0, "min_interval": 6.0, "max_interval": 60.0}


def test_update_quote_interval_without_service_keeps_requested_interval():
    result = update_quote_interval(
        QuoteIntervalIn(interval=12.0), request=_request_without_quote_service()
    )

    assert result["interval"] == 12.0
    assert result["min_interval"] == 6.0
    assert result["max_interval"] == 60.0


@pytest.mark.parametrize("scope", ["stock", "etf_watchlist", "etf_pool"])
def test_scope_interval_saves_independently_and_survives_restart(tmp_path, monkeypatch, scope):
    monkeypatch.setattr(preferences, "_path", lambda: tmp_path / "preferences.json")
    preferences._invalidate_cache()
    monkeypatch.setattr(preferences, "get_realtime_data_provider", lambda: "fuyao")
    service = QuoteService()
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(quote_service=service)))
    result = update_quote_interval(QuoteIntervalIn(scope=scope, interval=17), request)
    assert result["interval"] == 17
    restarted = QuoteService()
    assert restarted.get_interval(scope) == 17
    for other, default in (("stock", 6), ("etf_watchlist", 10), ("etf_pool", 60)):
        if other != scope:
            assert restarted.get_interval(other) == default


@pytest.mark.parametrize("value", [0, -1, float("nan"), float("inf")])
def test_invalid_interval_is_rejected(value):
    with pytest.raises(ValidationError):
        QuoteIntervalIn(interval=value)


def test_interval_http_contract_is_scoped_and_validated(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api.settings import router

    monkeypatch.setattr(preferences, "_path", lambda: tmp_path / "preferences.json")
    preferences._invalidate_cache()
    monkeypatch.setattr(preferences, "get_realtime_data_provider", lambda: "fuyao")
    app = FastAPI()
    app.include_router(router)
    app.state.quote_service = QuoteService()
    with TestClient(app) as client:
        for scope, interval in (("stock", 12), ("etf_watchlist", 17), ("etf_pool", 120)):
            response = client.put("/api/settings/preferences/quote-interval", json={"scope": scope, "interval": interval})
            assert response.status_code == 200
            assert response.json()["interval"] == interval
        for scope, interval in (("stock", 12), ("etf_watchlist", 17), ("etf_pool", 120)):
            assert client.get("/api/settings/preferences/quote-interval", params={"scope": scope}).json()["interval"] == interval
        assert client.put("/api/settings/preferences/quote-interval", json={"scope": "unknown", "interval": 12}).status_code == 422
        assert client.put("/api/settings/preferences/quote-interval", json={"scope": "etf_pool", "interval": 0}).status_code == 422
