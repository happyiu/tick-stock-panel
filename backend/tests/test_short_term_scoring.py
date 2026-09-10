"""Small executable checks for the short-term-score-v1 contract."""
from __future__ import annotations

import math
import sys
from datetime import date, timedelta
from pathlib import Path

import polars as pl

sys.path.insert(0, str(Path(__file__).parents[1]))

from app.services.short_term_scoring import (
    SHORT_TERM_DIMENSIONS,
    _build_columns,
    _cross_signal,
    _dedup_signals,
    _signals_until,
    short_term_analysis_payload,
)


def make_frame(count: int, *, period: str = "1d", turnover: bool = True) -> pl.DataFrame:
    start = date(2026, 1, 1)
    rows = []
    for index in range(count):
        if period == "30m":
            stamp = f"2026-01-{index // 8 + 1:02d} {9 + (index % 8) // 2:02d}:{30 if index % 2 == 0 else 0:02d}"
        else:
            stamp = start + timedelta(days=index)
        row = {
            "symbol": "000001.SZ",
            "date": stamp,
            "open": 10.0 + index * 0.02,
            "high": 10.2 + index * 0.02,
            "low": 9.8 + index * 0.02,
            "close": 10.0 + index * 0.02,
            "volume": 1000.0 + index,
            "change_pct": 0.05,
        }
        if turnover:
            row["turnover_rate"] = 2.0
        rows.append(row)
    return pl.DataFrame(rows)


def test_weighted_tanh_and_percent_change() -> None:
    payload = short_term_analysis_payload(
        make_frame(40), symbol="000001.SZ", asset_type="stock", period="1d",
    )
    row = payload["rows"][-1]
    available = [item for item in row["dimensions"] if item["score"] is not None]
    raw = sum(item["score"] * item["weight"] for item in available)
    weight = sum(item["weight"] for item in available)
    expected = round(50 + 50 * math.tanh(2.5 * raw / (weight * 10)))
    assert sum(item[2] for item in SHORT_TERM_DIMENSIONS) == 77
    assert row["total"] == expected
    assert row["indicators"]["change_pct"] == 5.0


def test_source_indicator_golden_values() -> None:
    frame = pl.DataFrame(
        {
            "symbol": ["000001.SZ"] * 3,
            "date": [date(2026, 1, 1) + timedelta(days=index) for index in range(3)],
            "open": [10.0, 11.0, 12.0],
            "high": [10.0, 11.0, 12.0],
            "low": [9.0, 10.0, 11.0],
            "close": [10.0, 11.0, 12.0],
            "volume": [100.0, 200.0, 300.0],
        }
    )
    columns = _build_columns(frame, "1d")
    assert columns["ma7"][-1] == 11.0
    assert columns["vwma5"][-1] == 11.333
    assert columns["kdj_k"] == [50.0, 66.667, 77.778]
    assert columns["kdj_d"] == [50.0, 55.556, 62.963]
    assert columns["vol_ratio_5d"] == [None, 2.0, 2.0]


def test_etf_missing_turnover_is_not_zero() -> None:
    payload = short_term_analysis_payload(
        make_frame(40, turnover=False), symbol="510300.SH", asset_type="etf", period="1d",
    )
    row = payload["rows"][-1]
    turnover = next(item for item in row["dimensions"] if item["id"] == "turnover")
    assert turnover["score"] is None
    assert row["coverage"] < 1
    assert any("换手率" in item for item in payload["limitations"])


def test_prefix_does_not_change_existing_as_of_rows() -> None:
    full = short_term_analysis_payload(
        make_frame(40), symbol="000001.SZ", asset_type="stock", period="1d",
    )
    prefix = short_term_analysis_payload(
        make_frame(35), symbol="000001.SZ", asset_type="stock", period="1d",
    )
    assert full["rows"][34] == prefix["rows"][-1]


def test_native_30m_keys_and_zone_contract() -> None:
    payload = short_term_analysis_payload(
        make_frame(40, period="30m"), symbol="000001.SZ", asset_type="stock", period="30m",
    )
    keys = [row["as_of"] for row in payload["rows"]]
    assert all(len(key) == 16 for key in keys)
    assert payload["bar_semantics"] == "native-bars"
    assert set(payload["zones"]) == {"support", "resistance"}


def test_signal_confirmation_and_noise_filters() -> None:
    base = {
        "key": [f"2026-01-0{index + 1}" for index in range(6)],
        "close": [10.0] * 6,
        "volume": [100.0] * 6,
        "macd_hist": [1.0] * 6,
    }
    ma = {
        **base,
        "ma5": [1.0, 1.0, 1.0, 1.0, 3.0, 3.0],
        "ma10": [2.0] * 6,
    }
    confirmed = _cross_signal(ma, 5, "ma5", "ma10", "ma", "MA5/10")
    assert confirmed is not None
    assert confirmed["as_of"] == "2026-01-06"
    assert confirmed["cross_as_of"] == "2026-01-05"
    assert _cross_signal({**ma, "ma5": [1.0, 1.0, 1.0, 1.0, 3.0, 1.0]}, 5, "ma5", "ma10", "ma", "MA5/10") is None

    low_volume = {**ma, "volume": [100.0, 100.0, 100.0, 100.0, 50.0, 100.0]}
    assert _cross_signal(low_volume, 5, "ma5", "ma10", "ma", "MA5/10") is None

    kdj = {
        **base,
        "kdj_k": [40.0, 40.0, 30.0, 30.0, 50.0, 55.0],
        "kdj_d": [40.0, 40.0, 40.0, 40.0, 40.0, 45.0],
    }
    assert _cross_signal(kdj, 5, "kdj_k", "kdj_d", "kdj", "K/D") is None

    macd = {
        **base,
        "macd_dif": [0.0, 0.0, 0.0, 0.0, 2.0, 2.0],
        "macd_dea": [1.0] * 6,
        "macd_hist": [0.0, 0.0, 0.0, 1.0, 0.5, 1.0],
    }
    assert _cross_signal(macd, 5, "macd_dif", "macd_dea", "macd", "MACD") is None

    deduped = _dedup_signals(
        [{"_index": 10}, {"_index": 12}, {"_index": 20}],
        gap=5,
    )
    assert [item["_index"] for item in deduped] == [12, 20]


def test_signal_dedup_is_causal() -> None:
    signals = {
        "ma": [
            {"_index": 40, "as_of": "2026-02-10"},
            {"_index": 44, "as_of": "2026-02-14"},
        ]
    }
    assert _signals_until(signals, 43)["ma"][0]["_index"] == 40
    assert _signals_until(signals, 50)["ma"][0]["_index"] == 44


if __name__ == "__main__":
    for check in (
        test_weighted_tanh_and_percent_change,
        test_source_indicator_golden_values,
        test_etf_missing_turnover_is_not_zero,
        test_prefix_does_not_change_existing_as_of_rows,
        test_native_30m_keys_and_zone_contract,
        test_signal_confirmation_and_noise_filters,
        test_signal_dedup_is_causal,
    ):
        check()
    print("short-term scoring assertions passed")
