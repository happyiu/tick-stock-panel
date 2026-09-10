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
    _ma_alignment_state,
    _ma_slope_state,
    _ma_slope_summary,
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
            "amount": close * volume,
        })
    return pl.DataFrame(rows)


def _ma_state_row(*, ma5: float, ma10: float, ma20: float, ma60: float, ma120: float) -> dict:
    return {"ma5": ma5, "ma10": ma10, "ma20": ma20, "ma60": ma60, "ma120": ma120}


@pytest.mark.parametrize(
    ("current", "expected_state", "expected_score"),
    [
        (_ma_state_row(ma5=110, ma10=108, ma20=105, ma60=102, ma120=100), "强多头排列", 100),
        (_ma_state_row(ma5=110, ma10=108, ma20=105, ma60=102, ma120=103), "多头排列", 80),
        (_ma_state_row(ma5=98, ma10=100, ma20=105, ma60=102, ma120=100), "多头回调", 65),
        (_ma_state_row(ma5=100.1, ma10=100.0, ma20=100.2, ma60=99.9, ma120=99.8), "均线收敛/缠绕", 50),
        (_ma_state_row(ma5=102, ma10=100, ma20=95, ma60=98, ma120=100), "空头反弹", 35),
        (_ma_state_row(ma5=95, ma10=98, ma20=100, ma60=102, ma120=101), "空头排列", 20),
        (_ma_state_row(ma5=95, ma10=98, ma20=100, ma60=102, ma120=105), "强空头排列", 0),
    ],
)
def test_ma_alignment_state_groups_common_orderings(current, expected_state: str, expected_score: int):
    score, state, _ = _ma_alignment_state([current], 0)

    assert score == expected_score
    assert state == expected_state


def test_ma_alignment_state_identifies_early_reversal_and_missing_ma120():
    bottom_turn = [
        _ma_state_row(ma5=99, ma10=100.2, ma20=100.4, ma60=105, ma120=110),
        _ma_state_row(ma5=101, ma10=100, ma20=100.5, ma60=105, ma120=110),
    ]
    top_turn = [
        _ma_state_row(ma5=101, ma10=99.8, ma20=99.4, ma60=95, ma120=90),
        _ma_state_row(ma5=99, ma10=100, ma20=99.5, ma60=95, ma120=90),
    ]

    bottom_score, bottom_state, bottom_detail = _ma_alignment_state(bottom_turn, 1)
    top_score, top_state, top_detail = _ma_alignment_state(top_turn, 1)
    missing_score, missing_state, missing_detail = _ma_alignment_state([
        _ma_state_row(ma5=99, ma10=100, ma20=101, ma60=102, ma120=float("nan")),
    ], 0)

    assert (bottom_score, bottom_state) == (70, "底部转强")
    assert "上穿" in bottom_detail
    assert (top_score, top_state) == (30, "顶部转弱")
    assert "下穿" in top_detail
    assert missing_score is None
    assert missing_state == "数据不足"
    assert "MA120" in missing_detail


@pytest.mark.parametrize(
    ("values", "expected_state"),
    [
        ([100.0, 100.3], "强上升"),
        ([100.0, 100.1], "上升"),
        ([100.0, 100.02], "走平"),
        ([100.0, 99.9], "下降"),
        ([100.0, 99.7], "强下降"),
        ([100.0, 100.4, 100.5], "上升减速"),
        ([100.0, 99.6, 99.5], "下降减速"),
        ([100.0, 100.02, 100.12], "由平转升"),
        ([100.0, 100.02, 99.92], "由平转降"),
    ],
)
def test_ma_slope_state_covers_direction_strength_and_turning_points(values, expected_state: str):
    records = [{"ma5": value} for value in values]
    index = len(records) - 1

    score, state, slope, previous_slope = _ma_slope_state(records, index, "ma5")

    assert score is not None
    assert state == expected_state
    assert slope is not None
    if len(values) >= 3:
        assert previous_slope is not None


def test_ma_slope_summary_keeps_each_ma_state_visible():
    records = [
        {"ma5": 100.0, "ma20": 200.0, "ma60": 300.0},
        {"ma5": 100.02, "ma20": 200.4, "ma60": 299.8},
        {"ma5": 100.12, "ma20": 200.5, "ma60": 299.6},
    ]

    score, coverage, status = _ma_slope_summary(records, 2)

    assert score is not None
    assert coverage == 1.0
    assert status == "MA5由平转升 · MA20上升减速 · MA60下降"


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
        "category_direction_score", "category_direction_coverage", "direction_available",
        "category_risk_score", "risk_available", "category_activity_score", "activity_available",
        "categories",
    }


def test_category_payload_exposes_nested_scores_and_independent_activity():
    payload = technical_score_payload(score_technical_frame(_raw_frame(100)))
    latest = payload["rows"][-1]

    assert latest["direction_available"] is True
    assert latest["category_direction_score"] is not None
    assert latest["risk_available"] is True
    assert latest["activity_available"] is True
    assert [category["id"] for category in latest["categories"]] == [
        "trend", "momentum", "volume_price", "price_position", "volatility_risk", "activity",
    ]
    assert all("score" in indicator and "raw_values" in indicator for category in latest["categories"] for indicator in category["indicators"])
    trend = next(category for category in latest["categories"] if category["id"] == "trend")
    alignment = next(indicator for indicator in trend["indicators"] if indicator["id"] == "ma_alignment")
    assert alignment["detail"].splitlines()[0] == "比较价格、MA5/10/20/60/120 的相对排列"
    assert len(alignment["detail"].splitlines()) == 2
    slope = next(indicator for indicator in trend["indicators"] if indicator["id"] == "ma_slope")
    assert slope["status"] in {"偏强", "中性", "偏弱", "数据不足"}
    assert slope["detail"].splitlines()[0] == "分别识别 MA5/20/60 的方向、力度与拐点状态"
    assert len(slope["detail"].splitlines()) == 4
    assert "↑" in slope["detail"]


def test_missing_amount_does_not_become_activity_score():
    frame = _raw_frame(100).drop("amount")
    latest = score_technical_frame(frame).row(-1, named=True)

    assert latest["technical_category_activity_score"] is None
    assert latest["technical_category_activity_available"] is False


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
