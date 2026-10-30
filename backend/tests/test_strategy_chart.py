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


def test_index_chart_strategy_and_signal_api(tmp_path, monkeypatch):
    from datetime import timedelta
    from pathlib import Path

    import numpy as np
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api.strategy import router as strategy_router
    from app.api.strategy_chart import router
    from app.config import settings

    monkeypatch.setattr(settings, "data_dir", tmp_path)
    symbol = "000001.SH"
    closes = list(np.linspace(3000, 3400, 65)) + list(np.linspace(3400, 3000, 20)) + list(np.linspace(3000, 3400, 20))
    dates = [date(2026, 1, 1) + timedelta(days=i) for i in range(len(closes))]
    frame = pl.DataFrame(dict(
        symbol=[symbol] * len(dates), date=dates,
        open=closes, high=[p + 10 for p in closes], low=[p - 10 for p in closes],
        close=closes, volume=[100_000_000.] * len(dates), amount=[p * 100_000_000 for p in closes],
    ))

    class Repo:
        store = SimpleNamespace(data_dir=tmp_path)

        def resolve_asset_type(self, _symbol):
            return "index"

        def get_daily_asset(self, asset, requested, *_args):
            assert (asset, requested) == ("index", symbol)
            return frame

    builtin = Path(__file__).resolve().parents[1] / "app/strategy/builtin"
    engine = StrategyEngine(strategy_dirs=[builtin])
    app = FastAPI()
    app.include_router(router)
    app.include_router(strategy_router)
    app.state.repo = Repo()
    app.state.strategy_engine = engine
    client = TestClient(app)
    normal = client.get("/api/strategies", params={"asset_type": "index"})
    assert normal.status_code == 200
    assert normal.json()["strategies"] == []
    chart_list = client.get("/api/strategies", params={"asset_type": "index", "chart": True})
    assert chart_list.status_code == 200, chart_list.text
    assert {s["id"] for s in chart_list.json()["strategies"]} == {"ma_golden_cross", "macd_golden"}
    assert "index" not in engine.get("ma_golden_cross").meta["asset_types"]
    params = dict(symbol=symbol, asset_type="index", timeframe="1d",
                  start_date=str(dates[0]), end_date=str(dates[-1]))
    response = client.get("/api/strategy-chart/signals/ma_golden_cross", params=params)
    assert response.status_code == 200, response.text
    assert response.json()["asset_type"] == "index"
    assert any(row["kind"] == "exit" for row in response.json()["markers"])
    signal = client.get("/api/strategy-chart/signal-markers", params={**params, "signal_ids": "signal_ma_golden_5_20"})
    assert signal.status_code == 200, signal.text
    assert signal.json()["markers"]
    wrong = client.get("/api/strategy-chart/signals/ma_golden_cross", params={**params, "asset_type": "etf"})
    assert wrong.status_code == 400
    unsupported = client.get("/api/strategy-chart/signals/limit_up_momentum", params=params)
    assert unsupported.status_code == 400
    limit = client.get("/api/strategy-chart/signal-markers", params={**params, "signal_ids": "signal_limit_up"})
    assert limit.status_code == 400
    assert "指数" in limit.json()["detail"]


def test_index_custom_limit_signal_is_rejected_before_reading_prices(monkeypatch):
    import pytest

    from app.indicators import pipeline
    from app.strategy import custom_signals

    monkeypatch.setattr(pipeline, "get_signal_dependencies", lambda: {"csg_limit": frozenset({"signal_limit_up"})})
    monkeypatch.setattr(custom_signals, "load_all", lambda *_: [{"id": "limit", "conditions": [], "enabled": True}])
    with pytest.raises(ValueError, match="指数不支持引用涨跌停字段"):
        StrategyChartService(None, None).signal_markers(
            symbol="000001.SH", asset_type="index", timeframe="1d", signal_ids=["csg_limit"],
            start=date(2026, 1, 1), end=date(2026, 2, 1),
        )
