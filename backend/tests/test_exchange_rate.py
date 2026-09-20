"""Frankfurter provider and exchange-rate persistence regression tests."""
from __future__ import annotations

from datetime import date
from types import SimpleNamespace

import polars as pl
import pytest

from app.api import exchange_rate as exchange_rate_api
from app.data_providers import custom as custom_sources
from app.plugins.frankfurter.provider import (
    DERIVED_SOURCE,
    FRANKFURTER_API_URL,
    FRANKFURTER_SOURCE,
    SUPPORTED_PAIRS,
    FrankfurterProvider,
)
from app.services.exchange_rate_sync import sync_exchange_rates
from app.tickflow.repository import DataStore, KlineRepository


def test_frankfurter_provider_fetches_requested_pairs_and_dxy():
    provider = FrankfurterProvider()
    calls = []
    pair_rates = {
        "USD/CNY": 7.12,
        "JPY/CNY": 0.043,
        "HKD/CNY": 0.86,
        "EUR/CNY": 7.78,
        "USD/CNH": 7.10,
    }
    component_rates = {"EUR": 0.86, "JPY": 155.0, "GBP": 0.74, "CAD": 1.39, "SEK": 9.8, "CHF": 0.82}

    def fake_get(path, *, base_url=FRANKFURTER_API_URL, params=None):
        calls.append((path, base_url, params))
        if path == "/rates":
            return [
                {"date": "2026-09-16", "base": "USD", "quote": quote, "rate": rate}
                for quote, rate in component_rates.items()
            ]
        pair = next(
            pair for pair in SUPPORTED_PAIRS
            if pair[3] == base_url and path == f"/rate/{pair[1].lower()}/{pair[2].lower()}"
        )
        return {
            "date": "2026-09-16",
            "base": pair[1],
            "quote": pair[2],
            "rate": pair_rates[pair[0]],
        }

    provider._get = fake_get
    rows = provider.get_exchange_rates()
    by_symbol = {row["symbol"]: row for row in rows}
    assert set(by_symbol) == {"USD/CNY", "USD/CNH", "JPY/CNY", "HKD/CNY", "EUR/CNY", "DXY"}
    assert by_symbol["USD/CNY"]["source"] == "CFETS"
    assert by_symbol["USD/CNH"]["source"] == FRANKFURTER_SOURCE
    assert by_symbol["DXY"]["source"] == DERIVED_SOURCE
    expected_dxy = 50.14348112 * (1 / 0.86) ** -0.576 * 155.0 ** 0.136
    expected_dxy *= (1 / 0.74) ** -0.119 * 1.39 ** 0.091 * 9.8 ** 0.042 * 0.82 ** 0.036
    assert by_symbol["DXY"]["rate"] == pytest.approx(expected_dxy)
    assert len(calls) == len(SUPPORTED_PAIRS) + 1
    provider.close()


def test_frankfurter_provider_passes_date_range_to_each_source():
    provider = FrankfurterProvider()
    calls = []
    component_rows = [
        {"date": "2026-01-02", "base": "USD", "quote": quote, "rate": 1.0}
        for quote in ("EUR", "JPY", "GBP", "CAD", "SEK", "CHF")
    ]

    def fake_get(path, *, base_url=FRANKFURTER_API_URL, params=None):
        calls.append((path, base_url, params))
        if base_url == FRANKFURTER_API_URL and params["quotes"] == "EUR,JPY,GBP,CAD,SEK,CHF":
            return component_rows
        return [{
            "date": "2026-01-02",
            "base": params["base"],
            "quote": params["quotes"],
            "rate": 1.0,
        }]

    provider._get = fake_get
    rows = provider.get_exchange_rates(date(2026, 1, 1), date(2026, 1, 3))
    assert len(rows) == len(SUPPORTED_PAIRS) + 1
    pair_calls = calls[:-1]
    assert all(path == "/rates" for path, _, _ in pair_calls)
    assert all(params["from"] == "2026-01-01" and params["to"] == "2026-01-03" for _, _, params in pair_calls)
    assert calls[-1][2]["from"] == "2026-01-01"
    assert calls[-1][2]["to"] == "2026-01-03"
    provider.close()


def test_frankfurter_provider_rejects_wrong_pair_or_rate():
    with pytest.raises(ValueError, match="不支持的货币对"):
        FrankfurterProvider._normalize(
            [{"date": "2026-09-16", "base": "EUR", "quote": "CNY", "rate": 8.3}],
            start=None,
            end=None,
        )
    with pytest.raises(ValueError, match="正数"):
        FrankfurterProvider._normalize(
            [{"date": "2026-09-16", "base": "USD", "quote": "CNY", "rate": 0}],
            start=None,
            end=None,
        )


class _Source:
    def __init__(self, rows):
        self.rows = rows

    def get_exchange_rates(self, *, start=None, end=None):
        return self.rows


def test_exchange_rate_sync_writes_partition_and_is_idempotent(tmp_path):
    repo = KlineRepository(DataStore(tmp_path))
    rows = [
        {
            "symbol": "USD/CNY", "date": date(2026, 9, 15),
            "base": "USD", "quote": "CNY", "rate": 7.11,
            "source": "CFETS", "frequency": "1d", "retrieved_at": "2026-09-16T00:00:00+00:00",
        },
        {
            "symbol": "USD/CNY", "date": date(2026, 9, 16),
            "base": "USD", "quote": "CNY", "rate": 7.12,
            "source": "CFETS", "frequency": "1d", "retrieved_at": "2026-09-16T00:00:00+00:00",
        },
    ]
    source = _Source(rows)

    first = sync_exchange_rates(repo, provider=source)
    second = sync_exchange_rates(repo, provider=source)
    later_source = _Source([{**row, "retrieved_at": "2026-09-17T00:00:00+00:00"} for row in rows])
    third = sync_exchange_rates(repo, provider=later_source)

    assert first["rows_fetched"] == second["rows_fetched"] == 2
    assert first["rows_written"] == 2
    assert second["rows_written"] == 0
    assert third["rows_written"] == 0
    assert first["symbols"] == second["symbols"] == ["USD/CNY"]
    assert first["latest_rates"] == second["latest_rates"] == {"USD/CNY": 7.12}
    assert first["latest_rate"] == second["latest_rate"] == 7.12
    assert (tmp_path / "exchange_rate" / "date=2026-09-15" / "part.parquet").exists()
    assert repo.execute_all(
        "SELECT symbol, date, rate FROM exchange_rate ORDER BY date",
    ) == [
        ("USD/CNY", date(2026, 9, 15), 7.11),
        ("USD/CNY", date(2026, 9, 16), 7.12),
    ]
    assert len(pl.read_parquet(tmp_path / "exchange_rate" / "date=2026-09-16" / "part.parquet")) == 1


def test_exchange_rate_sync_routes_selected_current_provider(monkeypatch, tmp_path):
    repo = KlineRepository(DataStore(tmp_path))
    source = _Source([{
        "symbol": "USD/CNY", "date": date(2026, 9, 18),
        "base": "USD", "quote": "CNY", "rate": 7.13,
        "source": "OPEN_EXCHANGE_RATES", "frequency": "latest",
        "retrieved_at": "2026-09-18T00:00:00+00:00",
    }])
    monkeypatch.setattr(
        "app.services.preferences.get_exchange_rate_data_provider",
        lambda: "openexchangerates",
    )
    monkeypatch.setattr(custom_sources, "get_provider", lambda name: source)

    result = sync_exchange_rates(repo)

    assert result["provider"] == "openexchangerates"


def test_exchange_rate_api_forces_frankfurter_for_bounded_history(monkeypatch):
    calls = []

    def fake_sync(repo, **kwargs):
        calls.append(kwargs)
        return {"provider": kwargs.get("provider_name")}

    monkeypatch.setattr(exchange_rate_api, "sync_exchange_rates", fake_sync)
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(repo=object())))

    exchange_rate_api.sync_exchange_rate_data(
        exchange_rate_api.ExchangeRateSyncIn(
            start_date=date(2026, 9, 17),
            end_date=date(2026, 9, 18),
        ),
        request,
    )

    assert calls == [{
        "start": date(2026, 9, 17),
        "end": date(2026, 9, 18),
        "provider_name": "frankfurter",
    }]
