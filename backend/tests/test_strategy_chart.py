from datetime import date, datetime
from types import SimpleNamespace

import polars as pl

from app.services.strategy_chart import (
    StrategyChartService,
    evaluate_signal_frame,
    evaluate_strategy_frame,
)
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


def test_signal_frame_groups_selected_active_signals_on_each_bar() -> None:
    frame = pl.DataFrame(
        {
            "symbol": ["600000.SH"] * 4,
            "date": [
                date(2026, 9, 10),
                date(2026, 9, 11),
                date(2026, 9, 14),
                date(2026, 9, 15),
            ],
            "signal_macd_golden": [False, True, False, True],
            "signal_ma_dead_5_20": [False, False, True, True],
        }
    )

    markers = evaluate_signal_frame(
        frame,
        signal_ids=["signal_macd_golden", "signal_ma_dead_5_20"],
        timeframe="1d",
        start=date(2026, 9, 10),
        end=date(2026, 9, 15),
    )

    assert markers == [
        {"date": "2026-09-11", "signals": ["signal_macd_golden"]},
        {"date": "2026-09-14", "signals": ["signal_ma_dead_5_20"]},
        {"date": "2026-09-15", "signals": ["signal_macd_golden", "signal_ma_dead_5_20"]},
    ]


def test_30m_chart_frame_reuses_snapshot_and_aggregates_local_minutes() -> None:
    chart_frame = pl.DataFrame(
        {
            "symbol": ["512000.SH", "512000.SH"],
            "datetime": [datetime(2026, 9, 17, 10, 0), datetime(2026, 9, 17, 10, 30)],
            "open": [1.0, 1.1],
            "high": [1.2, 1.3],
            "low": [0.9, 1.0],
            "close": [1.1, 1.2],
            "volume": [100.0, 120.0],
        }
    )

    class SnapshotService:
        def get(self, *_args):
            return SimpleNamespace(frame=chart_frame)

    class Repo:
        def get_minute_range(self, *_args, **_kwargs):
            raise AssertionError("应优先复用图表快照")

    service = StrategyChartService(Repo(), None, SnapshotService())
    frame = service.load_frame(
        symbol="512000.SH",
        asset_type="etf",
        timeframe="30m",
        start=date(2026, 9, 17),
        end=date(2026, 9, 17),
        required_bars=1,
        days=1,
    )
    assert frame["date"].to_list() == ["2026-09-17 10:00", "2026-09-17 10:30"]

    minute_frame = chart_frame.with_columns(
        pl.datetime(2026, 9, 17, 9, 30).alias("datetime"),
    )

    class LocalRepo:
        def get_minute_range(self, *_args, **_kwargs):
            return minute_frame

    fallback = StrategyChartService(LocalRepo(), None).load_frame(
        symbol="512000.SH",
        asset_type="etf",
        timeframe="30m",
        start=date(2026, 9, 17),
        end=date(2026, 9, 17),
        required_bars=1,
        days=1,
    )
    assert fallback["date"].to_list() == ["2026-09-17 10:00"]
