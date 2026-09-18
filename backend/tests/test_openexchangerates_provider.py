"""Open Exchange Rates provider contract tests."""
from __future__ import annotations

from datetime import UTC, date, datetime

import pytest

from app.plugins.openexchangerates import provider


def _payload() -> dict:
    return {
        "timestamp": int(datetime(2026, 9, 18, 0, 2, tzinfo=UTC).timestamp()),
        "base": "USD",
        "rates": {
            "CNY": 7.12,
            "CNH": 7.10,
            "JPY": 155.0,
            "HKD": 7.8,
            "EUR": 0.86,
            "GBP": 0.74,
            "CAD": 1.39,
            "SEK": 9.8,
            "CHF": 0.82,
        },
    }


def test_openexchangerates_provider_normalizes_snapshot_and_dxy(monkeypatch):
    monkeypatch.setattr(provider, "get_api_key", lambda: "test-app-id")
    calls = []

    def fake_request(client, app_id):
        calls.append(app_id)
        return _payload()

    monkeypatch.setattr(provider, "_request", fake_request)
    source = provider.OpenExchangeRatesProvider()
    try:
        rows = source.get_exchange_rates()
    finally:
        source.close()

    by_symbol = {row["symbol"]: row for row in rows}
    assert set(by_symbol) == {"USD/CNY", "USD/CNH", "JPY/CNY", "HKD/CNY", "EUR/CNY", "DXY"}
    assert calls == ["test-app-id"]
    assert by_symbol["USD/CNY"]["date"] == date(2026, 9, 18)
    assert by_symbol["USD/CNY"]["source"] == provider.SOURCE
    assert by_symbol["DXY"]["source"] == provider.DERIVED_SOURCE
    assert by_symbol["JPY/CNY"]["rate"] == pytest.approx(7.12 / 155.0)
    assert by_symbol["DXY"]["rate"] > 0


def test_openexchangerates_provider_is_current_snapshot_only(monkeypatch):
    monkeypatch.setattr(provider, "get_api_key", lambda: "test-app-id")
    source = provider.OpenExchangeRatesProvider()
    try:
        with pytest.raises(ValueError, match="历史范围请使用 Frankfurter"):
            source.get_exchange_rates(date(2026, 9, 17), date(2026, 9, 18))
    finally:
        source.close()


def test_openexchangerates_provider_requires_app_id(monkeypatch):
    monkeypatch.setattr(provider, "get_api_key", lambda: "")
    assert provider.availability() == (
        False,
        "缺少 App ID(可在下方输入框直接填写,或配置环境变量 OPENEXCHANGERATES_APP_ID)",
    )
