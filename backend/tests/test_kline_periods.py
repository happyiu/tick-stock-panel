"""个股详情 K 线周期聚合与 API 契约。"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from types import SimpleNamespace

import polars as pl
import pytest
from fastapi import HTTPException

from app.api import kline as kline_api
from app.services.kline_periods import aggregate_daily_period, aggregate_minute_30m


def test_weekly_uses_actual_trading_boundaries_and_recomputes_ma():
    frame = pl.DataFrame({
        "symbol": ["600000.SH"] * 6,
        "date": [
            date(2026, 8, 31), date(2026, 9, 1), date(2026, 9, 4),
            date(2026, 9, 7), date(2026, 9, 8), date(2026, 9, 11),
        ],
        "open": [10.0, 10.1, 10.2, 11.0, 11.1, 11.2],
        "high": [10.3, 10.4, 10.5, 11.3, 11.4, 11.5],
        "low": [9.8, 9.9, 10.0, 10.8, 10.9, 11.0],
        "close": [10.1, 10.2, 10.4, 11.1, 11.2, 11.4],
        "volume": [100.0, 110.0, 120.0, 200.0, 210.0, 220.0],
    })

    result = aggregate_daily_period(frame, "1w")

    assert result.height == 2
    assert result["period_start"].to_list() == [date(2026, 8, 31), date(2026, 9, 7)]
    assert result["date"].to_list() == [date(2026, 9, 4), date(2026, 9, 11)]
    assert result["open"].to_list() == [10.0, 11.0]
    assert result["high"].to_list() == [10.5, 11.5]
    assert result["low"].to_list() == [9.8, 10.8]
    assert result["close"].to_list() == [10.4, 11.4]
    assert result["volume"].to_list() == [330.0, 630.0]
    assert "ma5" in result.columns
    for column in (
        "vol_ma5", "vol_ma10", "vol_ratio_5d",
        "momentum_5d", "momentum_20d", "momentum_60d", "atr_14",
    ):
        assert column in result.columns


def test_monthly_does_not_merge_adjacent_months():
    frame = pl.DataFrame({
        "symbol": ["510300.SH"] * 4,
        "date": [date(2026, 1, 29), date(2026, 1, 30), date(2026, 2, 2), date(2026, 2, 3)],
        "open": [4.0, 4.1, 4.2, 4.3],
        "high": [4.2, 4.3, 4.4, 4.5],
        "low": [3.9, 4.0, 4.1, 4.2],
        "close": [4.1, 4.2, 4.3, 4.4],
        "volume": [10.0, 20.0, 30.0, 40.0],
        "amount": [100.0, 200.0, 300.0, 400.0],
    })

    result = aggregate_daily_period(frame, "1mo")

    assert result["date"].to_list() == [date(2026, 1, 30), date(2026, 2, 3)]
    assert result["volume"].to_list() == [30.0, 70.0]
    assert result["amount"].to_list() == [300.0, 700.0]
    assert "atr_14" in result.columns


def test_30m_calculates_extended_technical_indicators():
    times = [(9, 31), (10, 1), (10, 31), (11, 1), (13, 1), (13, 31), (14, 1), (14, 31)]
    rows = []
    for day in range(8):
        trade_date = date(2026, 8, 3) + timedelta(days=day)
        for slot, (hour, minute) in enumerate(times):
            close = 100.0 + day * 1.5 + slot * 0.1
            rows.append({
                "symbol": "600000.SH",
                "datetime": datetime(trade_date.year, trade_date.month, trade_date.day, hour, minute),
                "open": close - 0.05,
                "high": close + 0.1,
                "low": close - 0.1,
                "close": close,
                "volume": float(100 + day * 10 + slot),
                "amount": close * float(100 + day * 10 + slot),
            })

    result = aggregate_minute_30m(pl.DataFrame(rows))

    assert result.height == 64
    last = result.row(-1, named=True)
    for column in (
        "vol_ma5", "vol_ma10", "vol_ratio_5d",
        "momentum_5d", "momentum_20d", "momentum_60d", "atr_14",
    ):
        assert last[column] is not None

    volumes = result["volume"].to_list()
    closes = result["close"].to_list()
    assert last["vol_ratio_5d"] == pytest.approx(volumes[-1] / (sum(volumes[-6:-1]) / 5))
    assert last["momentum_5d"] == pytest.approx(closes[-1] / closes[-6] - 1)
    assert last["momentum_20d"] == pytest.approx(closes[-1] / closes[-21] - 1)


def test_30m_respects_lunch_break_and_uses_scheduled_bucket_labels():
    frame = pl.DataFrame({
        "symbol": ["600000.SH"] * 6,
        "datetime": [
            datetime(2026, 9, 4, 9, 31),
            datetime(2026, 9, 4, 9, 59),
            datetime(2026, 9, 4, 10, 0),
            datetime(2026, 9, 4, 10, 1),
            datetime(2026, 9, 4, 13, 1),
            datetime(2026, 9, 4, 13, 30),
        ],
        "open": [None] * 6,
        "high": [10.1, 10.3, 10.4, 10.5, 10.6, 10.7],
        "low": [9.9, 10.0, 10.1, 10.2, 10.3, 10.4],
        "close": [10.0, 10.2, 10.3, 10.4, 10.5, 10.6],
        "volume": [1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
        "amount": [10.0, 20.0, 30.0, 40.0, 50.0, 60.0],
    })

    result = aggregate_minute_30m(frame)

    assert result["date"].to_list() == [
        "2026-09-04 10:00", "2026-09-04 10:30", "2026-09-04 13:30",
    ]
    assert result["open"].to_list() == [10.0, 10.4, 10.5]
    assert result["close"].to_list() == [10.3, 10.4, 10.6]
    assert result["volume"].to_list() == [6.0, 4.0, 11.0]


class _Repo:
    def __init__(
        self,
        daily: pl.DataFrame | None = None,
        minute: pl.DataFrame | None = None,
        asset_type: str = "stock",
    ):
        self.daily = daily if daily is not None else pl.DataFrame()
        self.minute = minute if minute is not None else pl.DataFrame()
        self.asset_type = asset_type
        self.last_daily_asset_type: str | None = None

    def resolve_asset_type(self, _symbol: str) -> str:
        return self.asset_type

    def get_instruments(self) -> pl.DataFrame:
        return pl.DataFrame({
            "symbol": ["600000.SH"], "name": ["浦发银行"],
            "total_shares": [1.0], "float_shares": [1.0],
        })

    def get_instruments_asset(self, asset_type: str) -> pl.DataFrame:
        return pl.DataFrame({
            "symbol": ["510300.SH"], "name": ["沪深300ETF"], "asset_type": [asset_type],
        })

    def get_enriched_latest_asset(self, _asset_type: str):
        return pl.DataFrame(), None

    def get_daily_asset(self, asset_type, _symbol, _start, _end, columns=None):
        self.last_daily_asset_type = asset_type
        if self.daily.is_empty() or not columns:
            return self.daily
        return self.daily.select([column for column in columns if column in self.daily.columns])

    def get_minute_range(self, _symbols, _start, _end, asset_type="stock"):
        return self.minute


def _request(repo: _Repo):
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(repo=repo, quote_service=None)))


def test_period_api_returns_weekly_contract():
    daily = pl.DataFrame({
        "symbol": ["600000.SH", "600000.SH"],
        "date": [date(2026, 9, 3), date(2026, 9, 4)],
        "open": [10.0, 10.2], "high": [10.3, 10.5], "low": [9.9, 10.1],
        "close": [10.2, 10.4], "volume": [100.0, 200.0], "amount": [1000.0, 2000.0],
    })

    result = kline_api.get_period_kline(
        _request(_Repo(daily=daily)), "600000.SH", "1w", "2026-09-01", "2026-09-04", 20,
    )

    assert result["period"] == "1w"
    assert result["asset_type"] == "stock"
    assert result["rows"][0]["date"] == date(2026, 9, 4)
    assert result["rows"][0]["volume"] == 300.0
    assert result["rows"][0]["period_start"] == date(2026, 9, 3)
    assert result["rows"][0]["period_end"] == date(2026, 9, 4)
    assert result["rows"][0]["is_closed"] is True


def test_period_api_routes_monthly_etf_to_etf_storage():
    daily = pl.DataFrame({
        "symbol": ["510300.SH", "510300.SH"],
        "date": [date(2026, 8, 31), date(2026, 9, 1)],
        "open": [4.0, 4.1], "high": [4.2, 4.3], "low": [3.9, 4.0],
        "close": [4.1, 4.2], "volume": [100.0, 200.0], "amount": [400.0, 820.0],
    })
    repo = _Repo(daily=daily, asset_type="etf")

    result = kline_api.get_period_kline(
        _request(repo), "510300.SH", "1mo", "2026-08-01", "2026-09-05", 20,
    )

    assert repo.last_daily_asset_type == "etf"
    assert result["asset_type"] == "etf"
    assert result["name"] == "沪深300ETF"
    assert [row["date"] for row in result["rows"]] == [date(2026, 8, 31), date(2026, 9, 1)]
    assert [row["is_closed"] for row in result["rows"]] == [True, False]


def test_period_api_returns_latest_requested_30m_trade_days():
    minute = pl.DataFrame({
        "symbol": ["600000.SH"] * 4,
        "datetime": [
            datetime(2026, 9, 3, 9, 31), datetime(2026, 9, 3, 10, 1),
            datetime(2026, 9, 4, 9, 31), datetime(2026, 9, 4, 10, 1),
        ],
        "open": [10.0, 10.1, 11.0, 11.1], "high": [10.2, 10.3, 11.2, 11.3],
        "low": [9.9, 10.0, 10.9, 11.0], "close": [10.1, 10.2, 11.1, 11.2],
        "volume": [10.0, 20.0, 30.0, 40.0], "amount": [100.0, 200.0, 300.0, 400.0],
    })

    result = kline_api.get_period_kline(
        _request(_Repo(minute=minute)), "600000.SH", "30m", "2026-08-01", "2026-09-04", 1,
    )

    assert result["period"] == "30m"
    assert result["requested_days"] == 1
    assert result["available_days"] == 1
    assert {row["date"][:10] for row in result["rows"]} == {"2026-09-04"}
    assert all(row["is_closed"] is True for row in result["rows"])


def test_period_api_rejects_index_scope():
    repo = _Repo()
    repo.resolve_asset_type = lambda _symbol: "index"
    with pytest.raises(HTTPException, match="指数周期切换暂未开放"):
        kline_api.get_period_kline(
            _request(repo), "000001.SH", "1w", "2026-01-01", "2026-09-05", 20,
        )
