from __future__ import annotations

from datetime import date, timedelta

import polars as pl

from app.indicators.pipeline import compute_indicators, compute_limit_signals, compute_signals


def _bars(n: int = 90) -> pl.DataFrame:
    rows = []
    for symbol, offset in (("600000", 0.0), ("300001", 2.0)):
        for i in range(n):
            close = 10.0 + offset + i * 0.03 + ((i % 7) - 3) * 0.04
            rows.append({
                "symbol": symbol,
                "date": date(2024, 1, 1) + timedelta(days=i),
                "open": close - 0.02,
                "high": close + 0.10,
                "low": close - 0.10,
                "close": close,
                "volume": 1000 + i * 10,
                "amount": close * (1000 + i * 10),
                "raw_close": close,
                "raw_high": close + 0.10,
                "raw_low": close - 0.10,
            })
    return pl.DataFrame(rows)


def test_compute_indicators_assume_sorted_matches_default_values():
    bars = _bars().sort(["symbol", "date"])

    default = compute_indicators(bars, needed={"macd_hist", "rsi_14", "momentum_20d"})
    fast = compute_indicators(
        bars,
        needed={"macd_hist", "rsi_14", "momentum_20d"},
        assume_sorted=True,
    )

    assert fast.equals(default)


def test_compute_indicators_high20_uses_close_window_and_needed_pruning():
    bars = _bars(22).filter(pl.col("symbol") == "600000").with_columns(
        pl.int_range(1, 23).cast(pl.Float64).alias("close"),
    ).with_columns([
        (pl.col("close") + 0.1).alias("high"),
        (pl.col("close") - 0.1).alias("low"),
    ]).sort(["symbol", "date"])

    result = compute_indicators(bars, needed={"high_20d", "low_20d"})

    assert "high_20d" in result.columns
    assert "low_20d" in result.columns
    assert "high_60d" not in result.columns
    assert result["high_20d"][:19].null_count() == 19
    assert result["low_20d"][:19].null_count() == 19
    assert result["high_20d"][19:].to_list() == [20.0, 21.0, 22.0]
    assert result["low_20d"][19:].to_list() == [1.0, 2.0, 3.0]


def test_compute_signals_subset_matches_full_values():
    indicators = compute_indicators(_bars())
    full = compute_signals(indicators)
    subset = compute_signals(indicators, needed={"signal_macd_golden", "signal_volume_surge"})

    assert "signal_macd_golden" in subset.columns
    assert "signal_volume_surge" in subset.columns
    assert "signal_ma20_breakout" not in subset.columns
    assert subset["signal_macd_golden"].equals(full["signal_macd_golden"])
    assert subset["signal_volume_surge"].equals(full["signal_volume_surge"])


def test_compute_signals_empty_needed_adds_no_signals():
    indicators = compute_indicators(_bars(), needed={"ma20"})
    result = compute_signals(indicators, needed=set())
    assert not any(col.startswith(("signal_", "csg_")) for col in result.columns)


def test_compute_limit_signals_subset_matches_full_and_prunes_other_outputs():
    bars = compute_indicators(_bars(), needed={"change_pct"})
    instruments = pl.DataFrame({
        "symbol": ["600000", "300001"],
        "name": ["浦发银行", "测试股份"],
        "float_shares": [1_000_000_000.0, 500_000_000.0],
    })
    full = compute_limit_signals(bars, instruments)
    subset = compute_limit_signals(bars, instruments, needed={"signal_limit_up"})

    assert "signal_limit_up" in subset.columns
    assert "signal_limit_down" not in subset.columns
    assert "signal_broken_limit_up" not in subset.columns
    assert subset["signal_limit_up"].equals(full["signal_limit_up"])
