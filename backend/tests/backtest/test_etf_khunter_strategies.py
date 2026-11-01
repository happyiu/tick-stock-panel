"""ETF adaptations of KHunter selection and timing signals."""

from datetime import date, timedelta
from pathlib import Path

import numpy as np
import polars as pl

from app.backtest.matrix import build_market_data_matrix, validate_signal_matrix
from app.strategy.engine import StrategyEngine

BUILTIN = Path(__file__).resolve().parents[2] / "app" / "strategy" / "builtin"


def _market(
    closes: list[float],
    volumes: list[float],
    *,
    opens: list[float] | None = None,
    highs: list[float] | None = None,
    lows: list[float] | None = None,
):
    panel = pl.DataFrame(
        {
            "symbol": ["510300.SH"] * len(closes),
            "date": [date(2025, 1, 1) + timedelta(days=i) for i in range(len(closes))],
            "open": opens if opens is not None else closes,
            "high": highs if highs is not None else [value * 1.01 for value in closes],
            "low": lows if lows is not None else [value * 0.99 for value in closes],
            "close": closes,
            "volume": volumes,
        }
    )
    return build_market_data_matrix(panel)


def test_etf_2560_requires_both_crosses_and_configured_gain():
    strategy = StrategyEngine._load_file(BUILTIN / "khunter_2560_etf.py")
    assert strategy.meta["asset_types"] == ["etf"]
    market = _market([1.0] * 60 + [0.98, 1.04], [100.0] * 60 + [90.0, 300.0])
    signals = strategy.matrix_strategy.compute_signals(market, {"min_change_pct": 2.0})
    validate_signal_matrix(signals, market.shape)
    assert signals.entry[-1, 0] == 1
    assert signals.entry[:-1, 0].sum() == 0
    assert strategy.matrix_strategy.compute_signals(
        market, {"min_change_pct": 7.0}
    ).entry[-1, 0] == 0
    no_volume_cross = _market([1.0] * 60 + [0.98, 1.04], [100.0] * 60 + [200.0, 300.0])
    assert strategy.matrix_strategy.compute_signals(
        no_volume_cross, {"min_change_pct": 2.0}
    ).entry[-1, 0] == 0


def test_etf_golden_triangle_requires_ordered_recent_crosses():
    strategy = StrategyEngine._load_file(BUILTIN / "khunter_golden_triangle_etf.py")
    assert strategy.meta["asset_types"] == ["etf"]
    # A rising long trend survives a short dip; the recovery crosses A, B, C in order.
    base = [1.0 + i * 0.005 for i in range(65)]
    dip = [base[-1] - (i + 1) * 0.002 for i in range(12)]
    closes = base + dip + [dip[-1] + (i + 1) * 0.01 for i in range(20)]
    market = _market(closes, [100.0] * 77 + [160.0] * 20)
    signals = strategy.matrix_strategy.compute_signals(
        market, {"ac_interval": 5, "min_change_pct": 0.0, "min_volume_ratio": 1.0}
    )
    validate_signal_matrix(signals, market.shape)
    assert np.count_nonzero(signals.entry) == 1
    assert strategy.matrix_strategy.compute_signals(
        market, {"ac_interval": 0, "min_change_pct": 0.0, "min_volume_ratio": 1.0}
    ).entry.sum() == 0
    assert strategy.matrix_strategy.compute_signals(
        market, {"ac_interval": 5, "min_change_pct": 0.0, "min_volume_ratio": 3.0}
    ).entry.sum() == 0
