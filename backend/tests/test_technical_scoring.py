"""Regression tests for the versioned detail-page technical score."""
from __future__ import annotations

from datetime import date, datetime, timedelta

import polars as pl
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import kline as kline_api
from app.services.technical_scoring import (
    TECHNICAL_SCORE_COLUMNS,
    TECHNICAL_SCORE_VERSION,
    score_technical_frame,
    technical_score_payload,
)


def _manual_row(day: date, direction: str, *, previous: bool = False) -> dict:
    if direction == "bull":
        close = 100.0 if previous else 105.0
        ma5, ma10, ma20, ma60 = ((103.0, 102.0, 101.0, 100.0)
                                  if previous else (104.0, 103.0, 102.0, 101.0))
        dif, dea, hist = ((0.4, 0.1, 0.4) if previous else (0.5, 0.1, 0.8))
        rsi, k, d, j = 90.0, 100.0, 0.0, 100.0
        momentum = (0.05, 0.10, 0.20)
        change = 0.05
    elif direction == "bear":
        close = 100.0 if previous else 95.0
        ma5, ma10, ma20, ma60 = ((97.0, 98.0, 99.0, 100.0)
                                  if previous else (96.0, 97.0, 98.0, 99.0))
        dif, dea, hist = ((-0.4, -0.1, -0.4) if previous else (-0.5, -0.1, -0.8))
        rsi, k, d, j = 10.0, 0.0, 100.0, 0.0
        momentum = (-0.05, -0.10, -0.20)
        change = -0.05
    else:
        close = 100.0
        ma5 = ma10 = ma20 = ma60 = 100.0
        dif = dea = hist = 0.0
        rsi = k = d = j = 50.0
        momentum = (0.0, 0.0, 0.0)
        change = 0.0

    return {
        "symbol": "TEST.SH",
        "date": day,
        "close": close,
        "volume": 1000.0,
        "ma5": ma5,
        "ma10": ma10,
        "ma20": ma20,
        "ma60": ma60,
        "macd_dif": dif,
        "macd_dea": dea,
        "macd_hist": hist,
        "rsi_14": rsi,
        "kdj_k": k,
        "kdj_d": d,
        "kdj_j": j,
        "momentum_5d": momentum[0],
        "momentum_20d": momentum[1],
        "momentum_60d": momentum[2],
        "boll_upper": 102.0,
        "boll_lower": 98.0,
        "vol_ma5": 2000.0 if direction != "neutral" else 1000.0,
        "vol_ma10": 1000.0,
        "vol_ratio_5d": 2.0,
        "atr_14": 1.0,
        "change_pct": change,
    }


@pytest.mark.parametrize(
    ("direction", "expected"),
    [("bull", 100), ("bear", 0), ("neutral", 50)],
)
def test_direction_score_has_clear_bull_bear_neutral_boundaries(direction: str, expected: int):
    first_day = date(2026, 1, 1)
    rows = [_manual_row(first_day, direction, previous=True),
            _manual_row(first_day + timedelta(days=1), direction)]
    result = score_technical_frame(pl.DataFrame(rows))
    latest = result.row(-1, named=True)

    assert latest["technical_direction_score"] == expected
    assert latest["technical_trend_score"] == expected
    assert latest["technical_momentum_score"] == expected
    assert latest["technical_volume_price_score"] == expected
    assert latest["technical_state_confirmation_score"] == expected
    assert latest["technical_score_available"] is True
    assert 0 <= latest["technical_confidence"] <= 100
    assert 0 <= latest["technical_coverage"] <= 100


def test_flat_price_history_is_neutral_after_indicator_degeneracy():
    result = score_technical_frame(_raw_frame(80, slope=0.0)).row(-1, named=True)
    assert result["technical_direction_score"] == 50
    assert result["technical_momentum_score"] == 50
    assert result["technical_score_available"] is True


def _raw_frame(count: int = 100, *, slope: float = 0.25, volume: float = 1000.0) -> pl.DataFrame:
    rows = []
    for index in range(count):
        close = 100.0 + slope * index
        rows.append({
            "symbol": "TEST.SH",
            "date": date(2026, 1, 1) + timedelta(days=index),
            "open": close - 0.2,
            "high": close + 0.4,
            "low": close - 0.4,
            "close": close,
            "volume": volume,
        })
    return pl.DataFrame(rows)


def test_missing_and_invalid_base_data_is_not_reported_as_zero_score():
    missing = score_technical_frame(pl.DataFrame({
        "symbol": ["TEST.SH"], "date": [date(2026, 1, 1)], "close": [100.0],
    })).row(0, named=True)
    assert missing["technical_direction_score"] is None
    assert missing["technical_score_available"] is False
    assert missing["technical_confidence"] == 0.0

    zero_volume = score_technical_frame(_raw_frame(80, volume=0.0)).row(-1, named=True)
    assert zero_volume["technical_direction_score"] is None
    assert zero_volume["technical_score_available"] is False

    invalid = _raw_frame(1).with_columns(pl.lit(float("nan")).alias("close"))
    invalid_row = score_technical_frame(invalid).row(0, named=True)
    assert invalid_row["technical_direction_score"] is None
    assert invalid_row["technical_score_available"] is False


def test_missing_current_volume_does_not_create_volume_price_direction():
    first_day = date(2026, 1, 1)
    rows = [_manual_row(first_day, "bull", previous=True),
            _manual_row(first_day + timedelta(days=1), "bull")]
    rows[-1].pop("vol_ratio_5d")
    result = score_technical_frame(pl.DataFrame(rows)).row(-1, named=True)

    assert result["technical_volume_price_score"] is None
    assert result["technical_direction_score"] == 100
    assert result["technical_coverage"] == 72
    assert result["technical_score_available"] is True


def test_prefix_and_full_history_produce_same_historical_score():
    full = score_technical_frame(_raw_frame(100))
    prefix = score_technical_frame(_raw_frame(80))
    full_row = full.filter(pl.col("date") == date(2026, 3, 21)).row(0, named=True)
    prefix_row = prefix.row(-1, named=True)

    for column in TECHNICAL_SCORE_COLUMNS:
        assert prefix_row[column] == full_row[column], column


def test_high_volatility_is_independent_from_direction_confidence():
    base_frame = _raw_frame(40, slope=0.1)
    base = score_technical_frame(base_frame).row(-1, named=True)

    high_volatility_rows = base_frame.to_dicts()
    high_volatility_rows[-1]["high"] += 5.0
    high_volatility_rows[-1]["low"] -= 5.0
    high_volatility = score_technical_frame(pl.DataFrame(high_volatility_rows)).row(-1, named=True)

    shrinking_volume_rows = base_frame.to_dicts()
    shrinking_volume_rows[-1]["volume"] = 100.0
    shrinking_volume = score_technical_frame(pl.DataFrame(shrinking_volume_rows)).row(-1, named=True)

    assert high_volatility["technical_volatility_risk"] > base["technical_volatility_risk"]
    assert high_volatility["technical_confidence"] >= base["technical_confidence"]
    assert shrinking_volume["technical_activity_score"] < base["technical_activity_score"]
    assert shrinking_volume["technical_confidence"] < base["technical_confidence"]


def test_payload_is_versioned_and_date_aligned():
    frame = score_technical_frame(_raw_frame(80))
    payload = technical_score_payload(frame)

    assert payload["version"] == TECHNICAL_SCORE_VERSION
    assert len(payload["rows"]) == frame.height
    assert payload["rows"][0]["as_of"] == "2026-01-01"
    assert set(payload["rows"][0]) == {
        "as_of", "direction_score", "confidence", "coverage", "trend",
        "momentum", "volume_price", "state_confirmation", "volatility_risk", "activity", "available",
    }


class _ScoringRepo:
    def __init__(self, daily: pl.DataFrame):
        self.daily = daily

    def resolve_asset_type(self, _symbol: str) -> str:
        return "stock"

    def get_instruments(self) -> pl.DataFrame:
        return pl.DataFrame({
            "symbol": ["TEST.SH"], "name": ["测试标的"],
            "total_shares": [1.0], "float_shares": [1.0],
        })

    def get_daily_asset(self, _asset_type, _symbol, _start, _end, columns=None):
        if columns:
            return self.daily.select([column for column in columns if column in self.daily.columns])
        return self.daily


class _MinuteScoringRepo(_ScoringRepo):
    def __init__(self, daily: pl.DataFrame, minute: pl.DataFrame):
        super().__init__(daily)
        self.minute = minute

    def get_minute_range(self, _symbols, _start, _end, asset_type="stock"):
        return self.minute


def test_daily_api_score_switch_is_opt_in_and_rows_stay_compatible():
    app = FastAPI()
    app.include_router(kline_api.router)
    app.state.repo = _ScoringRepo(_raw_frame(100))
    app.state.chart_data_service = None
    app.state.quote_service = None

    with TestClient(app) as client:
        base = client.get("/api/kline/daily", params={
            "symbol": "TEST.SH", "start_date": "2026-03-01", "end_date": "2026-04-10",
        })
        scored = client.get("/api/kline/daily", params={
            "symbol": "TEST.SH", "start_date": "2026-03-01", "end_date": "2026-04-10",
            "include_technical_scores": "true",
        })

    assert base.status_code == 200
    assert scored.status_code == 200
    base_json = base.json()
    scored_json = scored.json()
    assert "technical_scores" not in base_json
    assert "technical_scores" in scored_json
    assert scored_json["technical_scores"]["version"] == TECHNICAL_SCORE_VERSION
    assert len(scored_json["technical_scores"]["rows"]) == len(scored_json["rows"])
    assert all(not key.startswith("technical_") for row in scored_json["rows"] for key in row)
    assert scored_json["technical_scores"]["rows"][0]["as_of"] == scored_json["rows"][0]["date"]


def test_period_api_aligns_weekly_score_rows_to_period_bars():
    app = FastAPI()
    app.include_router(kline_api.router)
    app.state.repo = _ScoringRepo(_raw_frame(100))
    app.state.chart_data_service = None
    app.state.quote_service = None

    with TestClient(app) as client:
        response = client.get("/api/kline/period", params={
            "symbol": "TEST.SH", "period": "1w",
            "start_date": "2026-03-01", "end_date": "2026-04-10",
            "include_technical_scores": "true",
        })

    assert response.status_code == 200
    result = response.json()
    assert result["technical_scores"]["version"] == TECHNICAL_SCORE_VERSION
    assert len(result["technical_scores"]["rows"]) == len(result["rows"])
    assert [item["as_of"] for item in result["technical_scores"]["rows"]] == [
        row["date"] for row in result["rows"]
    ]


def test_period_api_aligns_30m_score_rows_after_warmup_bars():
    times = ((9, 31), (10, 1), (10, 31), (11, 1), (13, 1), (13, 31), (14, 1), (14, 31))
    rows = []
    for day_index in range(8):
        trade_day = date(2026, 8, 3) + timedelta(days=day_index)
        for slot, (hour, minute) in enumerate(times):
            close = 100.0 + day_index + slot * 0.1
            rows.append({
                "symbol": "TEST.SH",
                "datetime": datetime(trade_day.year, trade_day.month, trade_day.day, hour, minute),
                "open": close - 0.05,
                "high": close + 0.1,
                "low": close - 0.1,
                "close": close,
                "volume": 100.0 + day_index * 10 + slot,
            })

    app = FastAPI()
    app.include_router(kline_api.router)
    app.state.repo = _MinuteScoringRepo(_raw_frame(1), pl.DataFrame(rows))
    app.state.chart_data_service = None
    app.state.quote_service = None

    with TestClient(app) as client:
        response = client.get("/api/kline/period", params={
            "symbol": "TEST.SH", "period": "30m", "days": 2,
            "start_date": "2026-08-01", "end_date": "2026-08-10",
            "include_technical_scores": "true",
        })

    assert response.status_code == 200
    result = response.json()
    assert result["available_days"] == 2
    assert len(result["technical_scores"]["rows"]) == len(result["rows"]) == 16
    assert result["technical_scores"]["rows"][0]["as_of"] == result["rows"][0]["date"]
