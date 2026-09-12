"""Regression tests for the versioned detail-page technical score."""
from __future__ import annotations

from datetime import date, datetime, timedelta

import polars as pl
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import kline as kline_api
from app.services import technical_scoring
from app.services.technical_scoring import (
    TECHNICAL_SCORE_COLUMNS,
    TECHNICAL_SCORE_VERSION,
    _kdj_analysis,
    _ma_alignment_state,
    _ma_dispersion_pattern,
    _ma_slope_state,
    _ma_slope_summary,
    _macd_analysis,
    _momentum_score,
    _roc_analysis,
    _roc_summary,
    _rsi_analysis,
    _rsi_position_state,
    _trend_score_status,
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


def test_momentum_score_uses_requested_indicator_weights():
    score, _ = _momentum_score([{
        "close": 100.0,
        "macd_dif": -1.0,
        "macd_dea": 0.0,
        "macd_hist": 0.0,
        "rsi_14": 90.0,
        "kdj_k": 100.0,
        "kdj_d": 0.0,
        "momentum_5d": 0.01,
        "momentum_20d": 0.01,
        "momentum_60d": 0.01,
    }], 0)

    assert score == pytest.approx(70.0)


def _macd_row(close: float, dif: float, dea: float, hist: float) -> dict:
    return {"close": close, "macd_dif": dif, "macd_dea": dea, "macd_hist": hist}


def test_macd_analysis_separates_cross_zero_axis_and_histogram_momentum():
    analysis = _macd_analysis([
        _macd_row(100.0, -0.6, -0.4, -0.4),
        _macd_row(100.0, -0.3, -0.5, 0.4),
    ], 1)

    assert analysis["state"] == "TURNING_BULLISH"
    assert analysis["event"] == "GOLDEN_CROSS"
    assert analysis["crossover"] == "GOLDEN_CROSS"
    assert analysis["zero_axis"] == "BELOW"
    assert analysis["momentum"] == "BULL_EXPANDING"
    assert analysis["divergence"] is None
    assert "GOLDEN_CROSS" in analysis["tags"]
    assert "零轴下金叉" in analysis["summary"]
    assert "多头动能增强" in analysis["summary"]


@pytest.mark.parametrize(
    ("previous", "current", "expected_state", "expected_momentum"),
    [
        (_macd_row(100.0, 0.4, 0.2, 0.4), _macd_row(100.0, 0.8, 0.4, 0.8), "STRONG_BULL", "BULL_EXPANDING"),
        (_macd_row(100.0, -0.4, -0.2, -0.4), _macd_row(100.0, -0.8, -0.4, -0.8), "STRONG_BEAR", "BEAR_EXPANDING"),
        (_macd_row(100.0, -0.8, -0.6, -0.8), _macd_row(100.0, -0.6, -0.4, -0.4), "RECOVERY", "BEAR_SHRINKING"),
        (_macd_row(100.0, 0.8, 0.4, 0.8), _macd_row(100.0, 0.6, 0.3, 0.6), "TURNING_BEARISH", "BULL_SHRINKING"),
        (_macd_row(100.0, 0.5, 0.3, 0.4), _macd_row(100.0, 0.3, 0.5, -0.4), "TURNING_BEARISH", "BEAR_EXPANDING"),
    ],
)
def test_macd_analysis_uses_six_state_rules(previous, current, expected_state: str, expected_momentum: str):
    analysis = _macd_analysis([previous, current], 1)

    assert analysis["state"] == expected_state
    assert analysis["momentum"] == expected_momentum


def test_macd_analysis_filters_near_zero_crossing_noise_as_range():
    records = []
    for index in range(8):
        dif = 0.01 if index % 2 else -0.01
        dea = 0.0
        records.append(_macd_row(100.0, dif, dea, 2.0 * (dif - dea)))

    analysis = _macd_analysis(records, 7)

    assert analysis["state"] == "RANGE"
    assert analysis["zero_axis"] == "NEAR"
    assert analysis["event"] == "GOLDEN_CROSS"
    assert analysis["summary"].startswith("金叉")


def test_macd_analysis_exposes_dif_and_dea_zero_axis_cross_events():
    analysis = _macd_analysis([
        _macd_row(100.0, -0.3, -0.4, 0.2),
        _macd_row(100.0, 0.2, 0.1, 0.2),
    ], 1)

    assert analysis["event"] == "DIF_CROSS_ZERO_UP"
    assert analysis["events"] == ["DIF_CROSS_ZERO_UP", "DEA_CROSS_ZERO_UP"]
    assert analysis["zero_axis"] == "ABOVE"


def test_macd_analysis_uses_price_normalized_dif_for_strength_slope():
    analysis = _macd_analysis([
        _macd_row(100.0, 0.8, 0.4, 0.8),
        _macd_row(200.0, 1.0, 0.6, 0.8),
    ], 1)

    assert analysis["momentum"] == "BULL_SHRINKING"
    assert analysis["state"] == "TURNING_BEARISH"
    assert analysis["raw_values"]["previous_dif_pct"] == 0.8
    assert analysis["raw_values"]["dif_pct"] == 0.5


def test_macd_analysis_detects_confirmed_bottom_divergence_without_lookahead():
    closes = [100.0, 98.0, 95.0, 98.0, 100.0, 94.0, 90.0, 94.0, 95.0]
    difs = [0.5, -0.8, -1.2, -0.8, 0.4, -0.6, -0.8, -0.5, -0.4]
    records = [_macd_row(close, dif, dif + 0.2, -0.4) for close, dif in zip(closes, difs, strict=True)]

    analysis = _macd_analysis(records, 8)

    assert analysis["divergence"] == "BOTTOM_DIVERGENCE"
    assert "BOTTOM_DIVERGENCE" in analysis["tags"]
    assert analysis["raw_values"]["divergence_price_change_pct"] < 0
    assert analysis["raw_values"]["divergence_dif_change_pct"] > 0


def test_macd_analysis_detects_confirmed_top_divergence():
    closes = [100.0, 102.0, 105.0, 102.0, 100.0, 106.0, 110.0, 106.0, 105.0]
    difs = [0.4, 0.8, 1.2, 0.8, 0.4, 0.7, 0.8, 0.6, 0.5]
    records = [_macd_row(close, dif, dif - 0.2, 0.4) for close, dif in zip(closes, difs, strict=True)]

    analysis = _macd_analysis(records, 8)

    assert analysis["divergence"] == "TOP_DIVERGENCE"
    assert "顶背离" in analysis["summary"]


def test_macd_analysis_reports_recent_divergence_without_marking_it_active():
    closes = [100.0, 98.0, 95.0, 98.0, 100.0, 94.0, 90.0, 94.0, 95.0]
    difs = [0.5, -0.8, -1.2, -0.8, 0.4, -0.6, -0.8, -0.5, -0.4]
    records = [_macd_row(close, dif, dif + 0.2, -0.4) for close, dif in zip(closes, difs, strict=True)]
    for index, record in enumerate(records):
        record["date"] = date(2026, 1, 1) + timedelta(days=index)
    records.extend(
        {
            **_macd_row(95.0, -0.4, -0.2, -0.1),
            "date": date(2026, 1, 10) + timedelta(days=index),
        }
        for index in range(70)
    )

    analysis = _macd_analysis(records, len(records) - 1)

    assert analysis["divergence"] is None
    assert analysis["recent_divergence"] == "BOTTOM_DIVERGENCE"
    assert analysis["recent_divergence_as_of"] == "2026-01-09"


def test_macd_indicator_payload_exposes_structured_analysis_and_readable_detail():
    previous = _manual_row(date(2026, 1, 1), "neutral")
    current = _manual_row(date(2026, 1, 2), "neutral")
    previous.update(ma120=100.0, macd_dif=-0.6, macd_dea=-0.4, macd_hist=-0.4)
    current.update(ma120=100.0, macd_dif=-0.3, macd_dea=-0.5, macd_hist=0.4)

    payload = technical_score_payload(score_technical_frame(pl.DataFrame([previous, current])))
    momentum = next(category for category in payload["rows"][-1]["categories"] if category["id"] == "momentum")
    macd = next(indicator for indicator in momentum["indicators"] if indicator["id"] == "macd")

    assert macd["status"] == "转强"
    assert macd["state"] == "TURNING_BULLISH"
    assert macd["event"] == "GOLDEN_CROSS"
    assert macd["zero_axis"] == "BELOW"
    assert macd["momentum"] == "BULL_EXPANDING"
    assert macd["divergence"] is None
    assert macd["detail"].splitlines()[0] == "DIF/DEA交叉、零轴位置、柱体变化与价格背离"
    assert "趋势位置: 零轴下方" in macd["detail"]
    assert "动能: 多头动能增强" in macd["detail"]
    assert "背离: 当前无有效背离" in macd["detail"]
    assert "最近一次:" not in macd["detail"]


def test_macd_indicator_detail_omits_redundant_relation_summary_for_strong_bull():
    previous = _manual_row(date(2026, 1, 1), "bull", previous=True)
    current = _manual_row(date(2026, 1, 2), "bull")

    payload = technical_score_payload(score_technical_frame(pl.DataFrame([previous, current])))
    momentum = next(category for category in payload["rows"][-1]["categories"] if category["id"] == "momentum")
    macd = next(indicator for indicator in momentum["indicators"] if indicator["id"] == "macd")

    assert macd["status"] == "强多"
    assert "强多 · DIF在DEA上方 · 多头动能增强" not in macd["detail"]
    assert "趋势位置: 零轴上方 · 动能: 多头动能增强" in macd["detail"]


def test_macd_analysis_does_not_guess_when_required_values_are_missing():
    analysis = _macd_analysis([{"close": 100.0}], 0)

    assert analysis["state"] == "INSUFFICIENT"
    assert analysis["confidence"] == 0
    assert analysis["summary"] == "数据不足"


def _roc_rows(values: list[float], closes: list[float] | None = None) -> list[dict]:
    prices = closes or [100.0] * len(values)
    return [
        {
            "date": date(2026, 1, 1) + timedelta(days=index),
            "close": close,
            "momentum_5d": value,
            "momentum_20d": value,
            "momentum_60d": value,
        }
        for index, (value, close) in enumerate(zip(values, prices, strict=True))
    ]


@pytest.mark.parametrize(
    ("values", "expected_state", "expected_event"),
    [
        ([0.01, 0.03, 0.06, 0.11], "STRONG_BULL_ACCEL", None),
        ([0.04, 0.04, 0.04], "BULL_RUN", None),
        ([0.10, 0.08, 0.06], "BULL_DECAY", None),
        ([-0.01, -0.03, -0.06, -0.11], "STRONG_BEAR_ACCEL", None),
        ([-0.10, -0.08, -0.06], "BEAR_DECAY", None),
        ([-0.03, -0.01, 0.01], "TURNING_BULLISH", "ROC_CROSS_ZERO_UP"),
        ([0.03, 0.01, -0.01], "TURNING_BEARISH", "ROC_CROSS_ZERO_DOWN"),
        ([0.0, 0.01], "TURNING_BULLISH", "ROC_CROSS_ZERO_UP"),
        ([0.0, -0.01], "TURNING_BEARISH", "ROC_CROSS_ZERO_DOWN"),
    ],
)
def test_roc_analysis_classifies_direction_slope_and_zero_cross(
    values: list[float],
    expected_state: str,
    expected_event: str | None,
):
    analysis = _roc_analysis(_roc_rows(values), len(values) - 1)

    assert analysis["state"] == expected_state
    assert analysis["event"] == expected_event
    assert analysis["periods"][1]["state"] == expected_state
    assert analysis["periods"][1]["event"] == expected_event


def test_roc_analysis_uses_historical_percentile_for_extreme_labels():
    high = _roc_analysis(_roc_rows([-0.20 + index * 0.01 for index in range(40)]), 39)
    low = _roc_analysis(_roc_rows([0.20 - index * 0.01 for index in range(40)]), 39)

    assert high["extreme"] == "EXTREME_OVERBOUGHT"
    assert high["periods"][1]["percentile"] >= 95.0
    assert low["extreme"] == "EXTREME_OVERSOLD"
    assert low["periods"][1]["percentile"] <= 5.0
    assert high["raw_values"]["roc_20_history_count"] == 40


@pytest.mark.parametrize(
    ("values", "closes", "expected_divergence"),
    [
        (
            [0.02, -0.08, -0.12, -0.08, 0.02, -0.06, -0.08, -0.05, -0.04],
            [100.0, 98.0, 95.0, 98.0, 100.0, 94.0, 90.0, 94.0, 95.0],
            "BOTTOM_DIVERGENCE",
        ),
        (
            [0.02, 0.08, 0.12, 0.08, 0.02, 0.07, 0.08, 0.06, 0.05],
            [100.0, 102.0, 105.0, 102.0, 100.0, 106.0, 110.0, 106.0, 105.0],
            "TOP_DIVERGENCE",
        ),
    ],
)
def test_roc_analysis_detects_confirmed_price_divergence_without_lookahead(
    values: list[float],
    closes: list[float],
    expected_divergence: str,
):
    records = _roc_rows(values, closes)

    before_confirmation = _roc_analysis(records, len(records) - 2)
    confirmed = _roc_analysis(records, len(records) - 1)

    assert before_confirmation["divergence"] is None
    assert confirmed["divergence"] == expected_divergence
    assert confirmed["periods"][1]["divergence"] == expected_divergence
    assert expected_divergence in confirmed["tags"]
    assert confirmed["raw_values"]["roc_20_divergence_confirmation_lag"] == 2


def test_precomputed_roc_context_preserves_analysis_results():
    values = [((index % 17) - 8) / 100.0 for index in range(80)]
    closes = [100.0 + index * 0.1 + (index % 7 - 3) * 0.8 for index in range(80)]
    records = _roc_rows(values, closes)
    context = technical_scoring._build_roc_context(records)

    for index in (0, 5, 29, 60, 79):
        assert technical_scoring._roc_analysis(records, index, context) == _roc_analysis(records, index)


def test_roc_indicator_payload_exposes_each_period_and_reversal_layers():
    values = [0.02, -0.08, -0.12, -0.08, 0.02, -0.06, -0.08, -0.05, -0.04]
    closes = [100.0, 98.0, 95.0, 98.0, 100.0, 94.0, 90.0, 94.0, 95.0]
    rows = [
        _manual_row(item_date, "neutral") | {
            "close": close,
            "momentum_5d": value,
            "momentum_20d": value,
            "momentum_60d": value,
        }
        for item_date, close, value in zip(
            (date(2026, 1, 1) + timedelta(days=index) for index in range(len(values))),
            closes,
            values,
            strict=True,
        )
    ]
    payload = technical_score_payload(score_technical_frame(pl.DataFrame(rows)))
    momentum = next(category for category in payload["rows"][-1]["categories"] if category["id"] == "momentum")
    roc = next(indicator for indicator in momentum["indicators"] if indicator["id"] == "roc")

    assert roc["divergence"] == "BOTTOM_DIVERGENCE"
    assert roc["periods"][0]["period"] == 5
    assert roc["periods"][1]["value_pct"] == -4.0
    assert roc["summary"] == "短中期仍处弱势, 但下跌动能正在明显减弱; 长期 ROC60 仍为负, 但空头动能正在减弱."
    assert roc["detail"] == "识别 5/20/60 周期 ROC 的方向、斜率、零轴穿越、历史分位与价格背离"
    assert all(f"ROC{period}:" not in roc["detail"] for period in (5, 20, 60))
    assert "背离仅作反转预警" not in roc["detail"]


@pytest.mark.parametrize(
    ("periods", "expected"),
    [
        (
            [
                {"period": 5, "value": -0.0497, "state": "BEAR_RUN", "extreme": None},
                {"period": 20, "value": -0.1253, "state": "STRONG_BEAR_ACCEL", "extreme": "EXTREME_OVERSOLD"},
                {"period": 60, "value": 0.0896, "state": "BULL_DECAY", "change_pct_points": -6.03},
            ],
            "短中期动能继续走弱, ROC20 已进入极端超跌; 长期 ROC60 仍为正, 但多头动能正在快速衰减.",
        ),
        (
            [
                {"period": 5, "value": -0.01, "state": "BEAR_DECAY", "extreme": None},
                {"period": 20, "value": -0.03, "state": "BEAR_DECAY", "extreme": None},
                {"period": 60, "value": -0.04, "state": "BEAR_DECAY", "change_pct_points": 1.0},
            ],
            "短中期仍处弱势, 但下跌动能正在明显减弱; 长期 ROC60 仍为负, 但空头动能正在减弱.",
        ),
        (
            [
                {"period": 5, "value": 0.01, "state": "TURNING_BULLISH", "extreme": None},
                {"period": 20, "value": -0.03, "state": "BEAR_RUN", "extreme": None},
                {"period": 60, "value": 0.02, "state": "STRONG_BULL_ACCEL", "change_pct_points": 1.0},
            ],
            "短期动能率先转强, 但中期仍处弱势; 长期 ROC60 保持正值, 多头动能仍在增强.",
        ),
        (
            [
                {"period": 5, "value": 0.01, "state": "BULL_RUN", "extreme": None},
                {"period": 20, "value": 0.03, "state": "BULL_DECAY", "extreme": None},
                {"period": 60, "value": 0.02, "state": "BULL_RUN", "change_pct_points": -1.0},
            ],
            "短中期动能保持偏强; 长期 ROC60 仍保持正动能.",
        ),
    ],
)
def test_roc_summary_uses_deterministic_short_mid_and_long_templates(periods: list[dict], expected: str):
    assert _roc_summary(periods) == expected


@pytest.mark.parametrize(
    ("value", "expected_state", "expected_label"),
    [
        (80.0, "EXTREME_OVERBOUGHT", "极度超买"),
        (70.0, "OVERBOUGHT", "超买"),
        (60.0, "BULLISH", "偏强"),
        (50.0, "NEUTRAL_BULL", "中性偏强"),
        (40.0, "NEUTRAL_BEAR", "中性偏弱"),
        (30.0, "BEARISH", "偏弱"),
        (20.0, "OVERSOLD", "超卖"),
        (19.9, "EXTREME_OVERSOLD", "极度超卖"),
        (None, "INSUFFICIENT", "数据不足"),
    ],
)
def test_rsi_position_uses_eight_readable_bands(value, expected_state: str, expected_label: str):
    assert _rsi_position_state(value) == (expected_state, expected_label)


def _rsi_rows(values: list[float], closes: list[float] | None = None) -> list[dict]:
    prices = closes or [100.0] * len(values)
    return [
        {
            "date": date(2026, 1, 1) + timedelta(days=index),
            "close": close,
            "rsi_14": value,
        }
        for index, (value, close) in enumerate(zip(values, prices, strict=True))
    ]


def test_rsi_events_prioritize_middle_axis_and_recovery_crosses():
    records = _rsi_rows([45.0, 48.0, 52.0, 57.0])
    middle = _rsi_analysis(records, 2)
    assert middle["events"] == ["RSI_CROSS_50_UP"]
    assert middle["summary"] == "中性偏强 · RSI中轴转强"

    oversold = _rsi_analysis(_rsi_rows([23.0, 27.0, 32.0]), 2)
    assert oversold["events"] == ["RSI_CROSS_30_UP"]
    assert oversold["summary"] == "偏弱 · 超卖修复"

    overbought = _rsi_analysis(_rsi_rows([78.0, 74.0, 68.0]), 2)
    assert overbought["events"] == ["RSI_CROSS_70_DOWN"]
    assert overbought["summary"] == "偏强 · 超买回落"


def test_rsi_crosses_do_not_fire_on_the_boundary_that_has_not_been_left():
    assert _rsi_analysis(_rsi_rows([55.0, 50.0]), 1)["events"] == []
    assert _rsi_analysis(_rsi_rows([75.0, 70.0]), 1)["events"] == []


def test_rsi_summary_keeps_current_oversold_position_in_a_weak_zone():
    analysis = _rsi_analysis(_rsi_rows([35.0, 28.0, 25.0, 32.0, 35.0, 28.0]), 5)

    assert analysis["zone"] == "WEAK"
    assert analysis["status"] == "超卖"
    assert analysis["summary"].startswith("超卖 · ")


@pytest.mark.parametrize(
    ("values", "expected_zone", "expected_summary"),
    [
        ([72.0, 75.0, 78.0, 81.0, 77.0, 79.0, 82.0], "STRONG", "极度超买 · 高位钝化"),
        ([28.0, 38.0, 51.0, 58.0, 49.0, 35.0], "WEAK", "弱势区 · 动能下降"),
    ],
)
def test_rsi_trend_zones_and_stagnation_do_not_turn_extremes_into_trades(
    values: list[float],
    expected_zone: str,
    expected_summary: str,
):
    analysis = _rsi_analysis(_rsi_rows(values), len(values) - 1)

    assert analysis["zone"] == expected_zone
    assert analysis["summary"] == expected_summary
    if expected_zone == "STRONG":
        assert analysis["stagnation"] == "HIGH_STAGNATION"
    else:
        assert analysis["stagnation"] is None


@pytest.mark.parametrize(
    ("values", "closes", "expected_divergence"),
    [
        (
            [50.0, 22.0, 30.0, 25.0, 31.0, 35.0, 40.0, 45.0, 48.0],
            [100.0, 98.0, 95.0, 98.0, 100.0, 94.0, 90.0, 92.0, 95.0],
            "BOTTOM_DIVERGENCE",
        ),
        (
            [50.0, 35.0, 40.0, 38.0, 45.0, 32.0, 28.0, 30.0, 35.0],
            [100.0, 98.0, 95.0, 98.0, 103.0, 104.0, 102.0, 103.0, 106.0],
            "HIDDEN_BOTTOM_DIVERGENCE",
        ),
        (
            [50.0, 70.0, 60.0, 75.0, 65.0, 60.0, 55.0, 50.0, 48.0],
            [100.0, 102.0, 105.0, 102.0, 100.0, 106.0, 110.0, 108.0, 105.0],
            "TOP_DIVERGENCE",
        ),
        (
            [50.0, 70.0, 60.0, 75.0, 65.0, 70.0, 75.0, 70.0, 68.0],
            [100.0, 102.0, 105.0, 102.0, 100.0, 101.0, 102.0, 101.0, 99.0],
            "HIDDEN_TOP_DIVERGENCE",
        ),
    ],
)
def test_rsi_divergence_distinguishes_regular_and_hidden_patterns(
    values: list[float],
    closes: list[float],
    expected_divergence: str,
):
    records = _rsi_rows(values, closes)

    before_confirmation = _rsi_analysis(records, len(records) - 2)
    confirmed = _rsi_analysis(records, len(records) - 1)

    assert before_confirmation["divergence"] is None
    assert confirmed["divergence"] == expected_divergence
    assert expected_divergence in confirmed["tags"]
    assert confirmed["raw_values"]["divergence_confirmation_lag"] == 2


@pytest.mark.parametrize(
    ("values", "expected_swing"),
    [
        ([25.0, 35.0, 28.0, 38.0], "BULLISH_FAILURE_SWING"),
        ([75.0, 65.0, 72.0, 62.0], "BEARISH_FAILURE_SWING"),
    ],
)
def test_rsi_failure_swing_requires_second_extreme_and_trigger(values: list[float], expected_swing: str):
    analysis = _rsi_analysis(_rsi_rows(values), len(values) - 1)

    assert analysis["failure_swing"] == expected_swing
    assert expected_swing in analysis["tags"]
    assert "失败摆动" in analysis["summary"]


def test_rsi_failure_swing_does_not_guess_before_breakout():
    analysis = _rsi_analysis(_rsi_rows([25.0, 35.0, 28.0, 34.0]), 3)

    assert analysis["failure_swing"] is None


def test_rsi_indicator_payload_exposes_all_layers_with_requested_numeric_weight():
    records = _rsi_rows(
        [50.0, 22.0, 30.0, 25.0, 31.0, 35.0, 40.0, 45.0, 48.0],
        [100.0, 98.0, 95.0, 98.0, 100.0, 94.0, 90.0, 92.0, 95.0],
    )
    rows = [_manual_row(item["date"], "neutral") | item for item in records]
    payload = technical_score_payload(score_technical_frame(pl.DataFrame(rows)))
    momentum = next(category for category in payload["rows"][-1]["categories"] if category["id"] == "momentum")
    rsi = next(indicator for indicator in momentum["indicators"] if indicator["id"] == "rsi")

    assert rsi["status"] == "中性偏弱"
    assert rsi["divergence"] == "BOTTOM_DIVERGENCE"
    assert "底背离" in rsi["detail"]
    assert "位置、方向、50/30/70穿越、背离与趋势区间" in rsi["detail"]
    assert rsi["weight"] == 0.25
    assert rsi["raw_values"]["rsi14"] == 48.0


def _kdj_rows(
    values: list[tuple[float, float, float]],
    closes: list[float] | None = None,
) -> list[dict]:
    prices = closes or [100.0] * len(values)
    return [
        {
            "date": date(2026, 1, 1) + timedelta(days=index),
            "close": close,
            "kdj_k": k,
            "kdj_d": d,
            "kdj_j": j,
        }
        for index, ((k, d, j), close) in enumerate(zip(values, prices, strict=True))
    ]


@pytest.mark.parametrize(
    ("values", "expected_state", "expected_event", "expected_zone"),
    [
        (
            [(14.0, 18.0, 6.0), (12.0, 17.0, 2.0), (18.0, 15.0, 24.0)],
            "OVERSOLD_REVERSAL",
            "LOW_GOLDEN_CROSS",
            "OVERSOLD",
        ),
        (
            [(44.0, 48.0, 36.0), (47.0, 49.0, 43.0), (52.0, 50.0, 56.0)],
            "MOMENTUM_STRENGTHENING",
            "MIDDLE_GOLDEN_CROSS",
            "MID_HIGH",
        ),
        (
            [(88.0, 84.0, 96.0), (90.0, 87.0, 96.0), (84.0, 86.0, 80.0)],
            "HIGH_DEATH_CROSS",
            "HIGH_DEATH_CROSS",
            "OVERBOUGHT",
        ),
    ],
)
def test_kdj_crosses_are_interpreted_by_location(
    values: list[tuple[float, float, float]],
    expected_state: str,
    expected_event: str,
    expected_zone: str,
):
    analysis = _kdj_analysis(_kdj_rows(values), len(values) - 1)

    assert analysis["state"] == expected_state
    assert analysis["event"] == expected_event
    assert analysis["zone"] == expected_zone
    assert analysis["crossover"] in {"GOLDEN_CROSS", "DEATH_CROSS"}


def test_kdj_j_turn_leads_weak_recovery_before_cross_confirmation():
    analysis = _kdj_analysis(_kdj_rows([
        (14.0, 18.0, 6.0),
        (12.0, 18.0, 0.0),
        (14.0, 17.0, 8.0),
    ]), 2)

    assert analysis["state"] == "WEAK_RECOVERY"
    assert analysis["event"] == "J_TURN_UP"
    assert analysis["j_turn"] == "UP"
    assert analysis["crossover"] is None
    assert analysis["phase"] == "超卖 → J拐头 → 弱势修复"


def test_kdj_low_cross_can_confirm_a_recent_j_turn():
    analysis = _kdj_analysis(_kdj_rows([
        (14.0, 18.0, 6.0),
        (12.0, 18.0, 0.0),
        (14.0, 17.0, 8.0),
        (18.0, 15.0, 24.0),
    ]), 3)

    assert analysis["state"] == "OVERSOLD_REVERSAL"
    assert analysis["event"] == "LOW_GOLDEN_CROSS"
    assert analysis["j_turn"] == "UP"
    assert analysis["raw_values"]["j_turn_age"] == 1


def test_kdj_high_stagnation_is_not_treated_as_an_immediate_sell_signal():
    analysis = _kdj_analysis(_kdj_rows([
        (84.0, 82.0, 88.0),
        (87.0, 84.0, 93.0),
        (90.0, 87.0, 96.0),
    ]), 2)

    assert analysis["state"] == "HIGH_STAGNATION"
    assert analysis["stagnation"] == "HIGH_STAGNATION"
    assert analysis["raw_values"]["stagnation_bars"] == 3
    assert analysis["crossover"] is None
    assert "不等同卖出" in analysis["summary"]


def test_kdj_crosses_at_extremes_keep_their_risk_boundaries():
    high_cross = _kdj_analysis(_kdj_rows([
        (82.0, 85.0, 76.0),
        (86.0, 84.0, 90.0),
    ]), 1)
    low_cross = _kdj_analysis(_kdj_rows([
        (16.0, 14.0, 20.0),
        (12.0, 15.0, 6.0),
    ]), 1)

    assert high_cross["state"] == "HIGH_STRENGTH"
    assert "追高风险增加" in high_cross["summary"]
    assert low_cross["state"] == "OVERSOLD"
    assert low_cross["event"] == "LOW_DEATH_CROSS"
    assert "不追加卖出判断" in low_cross["summary"]


@pytest.mark.parametrize("j", [-12.0, 112.0])
def test_kdj_j_extremes_are_preserved_as_valid_momentum_values(j: float):
    analysis = _kdj_analysis(_kdj_rows([(50.0, 50.0, j)]), 0)

    assert analysis["state"] != "INSUFFICIENT"
    assert analysis["raw_values"]["j"] == j


@pytest.mark.parametrize(
    ("values", "closes", "expected_divergence"),
    [
        (
            [(30, 25, 40), (18, 22, 10), (12, 22, -8), (18, 24, 6), (28, 32, 20), (16, 23, 2), (15, 20, 5), (20, 24, 12), (25, 29, 18)],
            [100, 98, 95, 98, 100, 94, 90, 92, 95],
            "BOTTOM_DIVERGENCE",
        ),
        (
            [(60, 55, 70), (75, 70, 85), (82, 75, 96), (75, 70, 85), (60, 58, 64), (78, 74, 86), (80, 76, 88), (72, 70, 76), (65, 66, 63)],
            [100, 102, 105, 102, 100, 106, 110, 108, 105],
            "TOP_DIVERGENCE",
        ),
    ],
)
def test_kdj_divergence_uses_confirmed_price_pivots_without_lookahead(
    values: list[tuple[float, float, float]],
    closes: list[float],
    expected_divergence: str,
):
    records = _kdj_rows(values, closes)

    before_confirmation = _kdj_analysis(records, len(records) - 2)
    confirmed = _kdj_analysis(records, len(records) - 1)

    assert before_confirmation["divergence"] is None
    assert confirmed["divergence"] == expected_divergence
    assert expected_divergence in confirmed["tags"]
    assert confirmed["raw_values"]["divergence_confirmation_lag"] == 2


def test_kdj_indicator_payload_exposes_state_machine_with_requested_numeric_weight():
    values = [(14.0, 18.0, 6.0), (12.0, 17.0, 2.0), (18.0, 15.0, 24.0)]
    rows = [
        _manual_row(item["date"], "neutral") | item
        for item in _kdj_rows(values)
    ]

    payload = technical_score_payload(score_technical_frame(pl.DataFrame(rows)))
    momentum = next(category for category in payload["rows"][-1]["categories"] if category["id"] == "momentum")
    kdj = next(indicator for indicator in momentum["indicators"] if indicator["id"] == "kdj")

    assert kdj["status"] == "超卖反转"
    assert kdj["state"] == "OVERSOLD_REVERSAL"
    assert kdj["event"] == "LOW_GOLDEN_CROSS"
    assert kdj["phase"] == "超卖 → J拐头 → 低位金叉 → 反转确认"
    assert kdj["detail"].splitlines()[0] == "K/D位置与交叉、J拐点、钝化及价格背离"
    assert "超卖不等于立即上涨" not in kdj["detail"]
    assert kdj["weight"] == 0.20
    assert kdj["raw_values"]["j"] == 24.0


def test_kdj_analysis_does_not_guess_when_k_d_or_j_is_missing():
    analysis = _kdj_analysis([{"close": 100.0, "kdj_k": 10.0}], 0)

    assert analysis["state"] == "INSUFFICIENT"
    assert analysis["confidence"] == 0
    assert analysis["summary"] == "数据不足"


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


def test_ma_slope_detail_hides_composite_transition_symbols():
    records = [
        _manual_row(date(2026, 1, 1), "neutral"),
        _manual_row(date(2026, 1, 2), "neutral"),
        _manual_row(date(2026, 1, 3), "neutral"),
    ]
    for record, ma5, ma20, ma60 in zip(
        records,
        (100.0, 100.4, 100.5),
        (200.0, 199.6, 199.5),
        (300.0, 299.6, 299.5),
        strict=True,
    ):
        record.update(ma5=ma5, ma20=ma20, ma60=ma60)

    payload = technical_score_payload(score_technical_frame(pl.DataFrame(records)))
    detail = next(
        indicator["detail"]
        for indicator in payload["rows"][-1]["categories"][0]["indicators"]
        if indicator["id"] == "ma_slope"
    )

    assert "MA5 上升减速: 仍为正向, 但斜率趋平" in detail
    assert "↗→" not in detail
    assert "↓↓" not in detail


@pytest.mark.parametrize(
    ("short_direction", "long_direction", "expected_status"),
    [
        ("expanding", "expanding", "整体发散"),
        ("contracting", "contracting", "整体收敛"),
        ("flat", "flat", "聚散平稳"),
        ("expanding", "flat", "短期发散"),
        ("flat", "expanding", "中长期发散"),
        ("contracting", "flat", "短期收敛"),
        ("flat", "contracting", "中长期收敛"),
        ("expanding", "contracting", "短散长收"),
        ("contracting", "expanding", "短收长散"),
    ],
)
def test_ma_dispersion_patterns_are_independent_of_structure(short_direction: str, long_direction: str, expected_status: str):
    assert _ma_dispersion_pattern(short_direction, long_direction)[0] == expected_status


@pytest.mark.parametrize(
    ("previous_ma", "current_ma", "expected_status", "expected_score"),
    [
        ((1.06, 1.04, 1.02, 0.99, 0.95), (1.10, 1.07, 1.03, 0.98, 0.92), "整体发散", 90),
        ((1.10, 1.07, 1.03, 0.98, 0.92), (1.06, 1.05, 1.04, 1.00, 0.98), "整体收敛", 65),
        ((1.002, 1.001, 1.000, 0.999, 0.998), (1.003, 1.001, 1.000, 0.999, 0.998), "均线粘合", 50),
        ((0.90, 0.94, 0.98, 1.02, 1.06), (0.94, 0.96, 0.98, 1.00, 1.02), "整体收敛", 35),
        ((0.90, 0.94, 0.98, 1.02, 1.06), (0.82, 0.86, 0.92, 1.00, 1.08), "整体发散", 10),
        ((1.02, 1.01, 1.00, 0.96, 0.92), (1.08, 1.04, 1.02, 1.00, 0.98), "短散长收", 50),
    ],
)
def test_ma_dispersion_classifies_main_states(previous_ma, current_ma, expected_status: str, expected_score: int):
    def make_row(day: date, values: tuple[float, ...]) -> dict:
        row = _manual_row(day, "neutral")
        row.update(close=1.20, ma5=values[0], ma10=values[1], ma20=values[2], ma60=values[3], ma120=values[4])
        return row

    records = [
        make_row(date(2026, 1, index + 1), previous_ma)
        for index in range(3)
    ] + [make_row(date(2026, 1, 4), current_ma)]
    payload = technical_score_payload(score_technical_frame(pl.DataFrame(records)))
    trend = next(category for category in payload["rows"][-1]["categories"] if category["id"] == "trend")
    dispersion = next(indicator for indicator in trend["indicators"] if indicator["id"] == "ma_dispersion")

    assert dispersion["status"] == expected_status
    assert dispersion["score"] == expected_score


def test_ma_dispersion_detail_remains_concise():
    previous = _manual_row(date(2026, 1, 1), "neutral")
    previous.update(close=1.20, ma5=1.06, ma10=1.04, ma20=1.02, ma60=0.99, ma120=0.95)
    current = _manual_row(date(2026, 1, 4), "neutral")
    current.update(close=1.20, ma5=1.10, ma10=1.07, ma20=1.03, ma60=0.98, ma120=0.92)
    baseline_rows = [previous.copy() for _ in range(3)]
    for index, row in enumerate(baseline_rows, start=1):
        row["date"] = date(2026, 1, index)

    payload = technical_score_payload(score_technical_frame(pl.DataFrame([*baseline_rows, current])))
    trend = next(category for category in payload["rows"][-1]["categories"] if category["id"] == "trend")
    dispersion = next(indicator for indicator in trend["indicators"] if indicator["id"] == "ma_dispersion")

    assert dispersion["detail"].splitlines()[0] == "观察 MA5/10/20 与 MA20/60/120 的离散度变化"
    assert "整体发散 · 短期与中长期均发散" in dispersion["detail"]
    assert "综合: 多头发散" in dispersion["detail"]
    assert "短期(MA5/10/20)离散度" not in dispersion["detail"]
    assert "中长期(MA20/60/120)离散度" not in dispersion["detail"]
    assert "结构方向:" not in dispersion["detail"]
    assert "短期偏多" not in dispersion["detail"]


@pytest.mark.parametrize(
    ("score", "expected"),
    [
        (0, "强空"), (20, "强空"), (21, "偏空"), (40, "偏空"),
        (41, "弱空"), (45, "弱空"), (46, "中性/震荡"), (55, "中性/震荡"),
        (56, "弱多"), (60, "弱多"), (61, "偏多"), (80, "偏多"), (81, "强多"),
        (None, "数据不足"),
    ],
)
def test_trend_score_status_uses_requested_bands(score: float | None, expected: str):
    assert _trend_score_status(score) == expected


@pytest.mark.parametrize(
    ("above_count", "expected"),
    [
        (5, "强多头持续"),
        (4, "多头持续较强"),
        (3, "略偏多, 但不稳定"),
        (2, "略偏空"),
        (1, "空头持续较强"),
        (0, "强空头持续"),
    ],
)
def test_trend_persistence_uses_five_period_meanings(above_count: int, expected: str):
    records = [_manual_row(date(2026, 1, index + 1), "neutral") for index in range(5)]
    for index, record in enumerate(records):
        record["close"] = 101.0 if index >= 5 - above_count else 99.0
        record["ma20"] = 100.0

    payload = technical_score_payload(score_technical_frame(pl.DataFrame(records)))
    trend = next(category for category in payload["rows"][-1]["categories"] if category["id"] == "trend")
    persistence = next(indicator for indicator in trend["indicators"] if indicator["id"] == "trend_persistence")

    assert persistence["status"] == expected
    assert persistence["detail"] == f"统计最近5周期收盘价相对 MA20 的状态\n最近5周期: {above_count}/5 在上 · {expected}"
    assert persistence["raw_values"] == {"above_count": above_count, "sample_count": 5}


@pytest.mark.parametrize(
    ("close", "ma20", "ma60", "ma120", "expected_status", "expected_score"),
    [
        (1.04, 1.00, 1.02, 1.01, "强势区", 90),
        (1.04, 1.00, 1.02, 1.08, "中期修复", 75),
        (0.85, 0.84, 0.88, 0.92, "短期转强", 60),
        (1.005, 1.00, 0.98, 0.95, "MA20附近", 50),
        (0.97, 1.00, 0.95, 0.90, "短期回调", 60),
        (0.96, 1.00, 0.98, 0.90, "中期转弱", 35),
        (0.96, 1.00, 0.98, 0.97, "弱势区", 10),
        (1.20, 1.00, 1.05, 1.00, "极端偏离区", 85),
        (0.80, 1.00, 0.90, 0.85, "极端偏离区", 15),
    ],
)
def test_price_position_classifies_cost_line_states(
    close: float,
    ma20: float,
    ma60: float,
    ma120: float,
    expected_status: str,
    expected_score: int,
):
    row = _manual_row(date(2026, 1, 1), "neutral")
    row.update(close=close, ma20=ma20, ma60=ma60, ma120=ma120)

    payload = technical_score_payload(score_technical_frame(pl.DataFrame([row])))
    trend = next(category for category in payload["rows"][0]["categories"] if category["id"] == "trend")
    price_position = next(indicator for indicator in trend["indicators"] if indicator["id"] == "price_vs_ma")

    assert price_position["status"] == expected_status
    assert price_position["score"] == expected_score


def test_price_position_detail_keeps_only_state_meaning():
    row = _manual_row(date(2026, 1, 1), "neutral")
    row.update(close=0.85, ma20=0.84, ma60=0.88, ma120=0.92, atr_14=0.01)

    payload = technical_score_payload(score_technical_frame(pl.DataFrame([row])))
    trend = next(category for category in payload["rows"][0]["categories"] if category["id"] == "trend")
    price_position = next(indicator for indicator in trend["indicators"] if indicator["id"] == "price_vs_ma")

    assert price_position["detail"].splitlines()[0] == "比较价格与 MA20/MA60/MA120 的位置"
    assert "短期转强 · 短期已转强, 中长期仍承压" in price_position["detail"]
    assert "价格 0.850" not in price_position["detail"]
    assert "MA60 0.880" not in price_position["detail"]
    assert "MA120 0.920" not in price_position["detail"]
    assert "距MA20" not in price_position["detail"]


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


def test_payload_reuses_categories_computed_with_score_frame(monkeypatch):
    calls = 0
    original = technical_scoring._category_scores

    def counted(*args, **kwargs):
        nonlocal calls
        calls += 1
        return original(*args, **kwargs)

    monkeypatch.setattr(technical_scoring, "_category_scores", counted)
    frame = technical_scoring.score_technical_frame(_raw_frame(80))
    scoring_calls = calls

    payload = technical_scoring.technical_score_payload(frame)

    assert scoring_calls == frame.height
    assert calls == scoring_calls
    assert len(payload["rows"]) == frame.height


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
    assert {indicator["id"]: indicator["weight"] for indicator in trend["indicators"]} == {
        "ma_slope": 0.30,
        "ma_alignment": 0.25,
        "price_vs_ma": 0.20,
        "ma_dispersion": 0.15,
        "trend_persistence": 0.10,
    }
    momentum = next(category for category in latest["categories"] if category["id"] == "momentum")
    assert [indicator["id"] for indicator in momentum["indicators"]] == ["macd", "rsi", "kdj", "roc"]
    assert {indicator["id"]: indicator["weight"] for indicator in momentum["indicators"]} == {
        "macd": 0.30,
        "rsi": 0.25,
        "roc": 0.25,
        "kdj": 0.20,
    }
    assert trend["status"].startswith(_trend_score_status(trend["score"]))
    assert trend["status"].endswith("(中期降级)")
    assert [indicator["id"] for indicator in trend["indicators"]] == [
        "ma_alignment", "price_vs_ma", "ma_slope", "ma_dispersion", "trend_persistence",
    ]
    alignment = next(indicator for indicator in trend["indicators"] if indicator["id"] == "ma_alignment")
    assert alignment["detail"].splitlines()[0] == "比较价格、MA5/10/20/60 的相对排列 (MA120暂不可用)"
    assert len(alignment["detail"].splitlines()) == 2
    slope = next(indicator for indicator in trend["indicators"] if indicator["id"] == "ma_slope")
    assert slope["status"] in {"偏强", "中性", "偏弱", "数据不足"}
    assert slope["detail"].splitlines()[0] == "分别识别 MA5/20/60 的方向、力度与拐点状态"
    assert len(slope["detail"].splitlines()) == 4
    assert "↑" in slope["detail"]


@pytest.mark.parametrize(
    ("sample_count", "status_suffix", "expected_available"),
    [
        (130, "", True),
        (100, "(中期降级)", True),
        (40, "(短期参考)", True),
        (20, "数据不足", False),
    ],
)
def test_trend_category_degrades_by_available_ma_scope(
    sample_count: int,
    status_suffix: str,
    expected_available: bool,
):
    payload = technical_score_payload(score_technical_frame(_raw_frame(sample_count)))
    trend = next(category for category in payload["rows"][-1]["categories"] if category["id"] == "trend")

    assert trend["available"] is expected_available
    if expected_available:
        assert trend["score"] is not None
        assert trend["status"].endswith(status_suffix)
    else:
        assert trend["score"] is None
        assert trend["status"] == status_suffix


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
