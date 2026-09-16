from datetime import date
from types import SimpleNamespace

import polars as pl

from app.services.strategy_chart import evaluate_strategy_frame
from app.strategy.engine import StrategyEngine


def test_expression_strategy_projects_entry_and_exit_markers() -> None:
    strategy = SimpleNamespace(
        execution_backend="polars_expr",
        basic_filter={"enabled": False},
        filter_history_fn=None,
        filter_fn=lambda _frame, _params: pl.col("candidate"),
        entry_signals=["candidate"],
        exit_signals=["exit"],
        meta={},
    )
    frame = pl.DataFrame(
        {
            "symbol": ["600000.SH"] * 4,
            "date": [
                date(2026, 9, 10),
                date(2026, 9, 11),
                date(2026, 9, 14),
                date(2026, 9, 15),
            ],
            "open": [10.0, 10.1, 10.2, 10.3],
            "high": [10.2, 10.3, 10.4, 10.5],
            "low": [9.8, 9.9, 10.0, 10.1],
            "close": [10.1, 10.2, 10.3, 10.4],
            "volume": [100.0, 110.0, 120.0, 130.0],
            "candidate": [False, True, False, True],
            "signal_candidate": [False, True, False, True],
            "signal_exit": [False, False, True, False],
        }
    )

    markers = evaluate_strategy_frame(
        StrategyEngine,
        strategy,
        frame,
        symbol="600000.SH",
        asset_type="stock",
        timeframe="1d",
        start=date(2026, 9, 10),
        end=date(2026, 9, 15),
    )

    assert markers == [
        {"date": "2026-09-11", "kind": "entry", "signals": ["candidate"]},
        {"date": "2026-09-15", "kind": "entry", "signals": ["candidate"]},
        {"date": "2026-09-14", "kind": "exit", "signals": ["exit"]},
    ]
