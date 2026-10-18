"""策略页周线 / 30F 周期数据装配测试。"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from types import SimpleNamespace

import numpy as np
import polars as pl
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.backtest.matrix import make_signal_matrix
from app.services.screener import (
    ScreenerService,
    _aggregate_weekly_strategy_frame,
    _prepare_30m_strategy_frame,
)
from app.strategy.engine import StrategyDataContext, StrategyDef, StrategyEngine


def _scan_engine(backend):
    class Signals:
        def required_fields(self):
            return frozenset({"close"})

        def required_warmup_bars(self, params):
            return 1

        def compute_signals(self, market, params):
            entry = np.isin(market.close, [1.0, 11.0, 12.0])
            return make_signal_matrix(
                market.shape,
                entry=entry.astype(np.uint8),
                exit=(market.close == 10).astype(np.uint8),
                score=np.nan_to_num(market.close),
                entry_signal_code=np.where(entry, (market.close == 12).astype(np.int16), -1),
                exit_signal_code=np.where(market.close == 10, 0, -1).astype(np.int16),
                entry_signal_ids=("first", "second"),
                exit_signal_ids=("sell",),
            )

    engine = StrategyEngine(strategy_dirs=[])
    engine._strategies["scan"] = StrategyDef(
        meta={"id": "scan", "asset_types": ["stock", "etf"], "timeframes": ["1d", "30m"], "limit": 100},
        basic_filter={"price_min": 5.0, "amount_min": 500.0},
        entry_signals=["first", "second"], exit_signals=["sell"],
        stop_loss=None, trailing_stop=None, trailing_take_profit_activate=None,
        trailing_take_profit_drawdown=None, max_hold_days=None,
        filter_fn=(lambda df, params: pl.col("signal_first") | pl.col("signal_second")) if backend == "polars_expr" else None,
        filter_history_fn=None, lookback_days=1, source="custom",
        execution_backend=backend, matrix_strategy=Signals() if backend == "matrix_native" else None,
    )
    return engine


def _scan_panel(timestamp_column="date"):
    rows = []
    for stamp, prices in [
        (datetime(2026, 9, 8, 15), {"A": 10, "B": 11, "C": 10, "D": 10}),
        (datetime(2026, 9, 9, 10), {"A": 11, "B": 10, "C": 1, "D": 12}),
        (datetime(2026, 9, 9, 11), {"A": 12, "B": 10, "C": 1, "D": 12}),
        (datetime(2026, 9, 9, 15), {"A": 10, "B": 10, "C": 10}),
        (datetime(2026, 9, 10, 10), {"A": 10, "B": 12, "C": 10, "D": 10}),
    ]:
        for symbol, price in prices.items():
            rows.append({
                "symbol": symbol, timestamp_column: stamp,
                "open": float(price), "high": float(price), "low": float(price), "close": float(price),
                "volume": 100.0, "amount": 100.0 if price == 1 else 1000.0,
                "signal_first": price in (1, 11), "signal_second": price == 12, "signal_sell": price == 10,
            })
    return pl.DataFrame(rows)


@pytest.mark.parametrize("asset_type", ["stock", "etf"])
@pytest.mark.parametrize("timestamp_column", ["date", "datetime"])
def test_30m_matrix_scan_matches_any_bar_of_selected_day(asset_type, timestamp_column):
    engine = _scan_engine("matrix_native")
    panel = _scan_panel(timestamp_column)
    context = StrategyDataContext(asset_type, "30m", date(2026, 9, 9), current=panel, history=panel)
    single = engine.run("scan", context)
    batch = engine.run_all(context, strategy_ids=["scan"])["scan"]
    for result in (single, batch):
        assert result.total == 2
        rows = {row["symbol"]: row for row in result.rows}
        assert set(rows) == {"A", "D"}
        assert rows["A"][timestamp_column] == datetime(2026, 9, 9, 11)
        assert rows["A"]["close"] == 12.0
        assert rows["D"][timestamp_column] == datetime(2026, 9, 9, 11)
        assert result.entry_signal_hits == [
            {"symbol": "A", "signals": ["first", "second"]},
            {"symbol": "D", "signals": ["second"]},
        ]
        assert result.scores["A"] == 12.0
    pooled = engine.run("scan", context, pool=["D"])
    assert [row["symbol"] for row in pooled.rows] == ["D"]
    assert [hit["symbol"] for hit in pooled.entry_signal_hits] == ["D"]


def test_daily_matrix_scan_still_checks_last_bar_and_empty_day_stays_empty():
    engine = _scan_engine("matrix_native")
    panel = _scan_panel()
    for timeframe, day in [("1d", date(2026, 9, 9)), ("30m", date(2026, 9, 11))]:
        result = engine.run("scan", StrategyDataContext("stock", timeframe, day, current=panel, history=panel))
        assert result.total == 0


def test_30m_expression_scan_deduplicates_matching_bars_and_unions_signals():
    engine = _scan_engine("polars_expr")
    panel = _scan_panel()
    current = panel.filter(pl.col("date").cast(pl.Date) == date(2026, 9, 9))
    result = engine.run("scan", StrategyDataContext("stock", "30m", date(2026, 9, 9), current=current, history=panel))
    assert result.total == 2
    assert {row["symbol"] for row in result.rows} == {"A", "D"}
    assert all(row["date"] == datetime(2026, 9, 9, 11) for row in result.rows)
    assert result.entry_signal_hits == [
        {"symbol": "A", "signals": ["first", "second"]},
        {"symbol": "D", "signals": ["second"]},
    ]


def test_30m_preset_and_batch_api_include_earlier_intraday_hits(tmp_path, monkeypatch):
    from app.api import screener

    engine = _scan_engine("matrix_native")
    panel = _scan_panel()
    service = ScreenerService(SimpleNamespace(store=SimpleNamespace(data_dir=tmp_path)), asset_type="etf")
    monkeypatch.setattr(service, "build_strategy_context", lambda *args, **kwargs: StrategyDataContext(
        "etf", "30m", date(2026, 9, 9), current=panel, history=panel,
    ))
    monkeypatch.setattr(screener, "ScreenerService", lambda *args, **kwargs: service)
    app = FastAPI()
    app.include_router(screener.router)
    app.state.repo = service.repo
    app.state.strategy_engine = engine
    with TestClient(app) as client:
        body = {"as_of": "2026-09-09", "asset_type": "etf", "timeframe": "30m"}
        single = client.post("/api/screener/run_preset", json={**body, "strategy_id": "scan"})
        batch = client.post("/api/screener/run_all", json={**body, "strategy_ids": ["scan"], "summary_only": False})
    assert single.status_code == batch.status_code == 200
    for result in (single.json(), batch.json()["results"]["scan"]):
        assert result["total"] == 2
        assert {row["symbol"] for row in result["rows"]} == {"A", "D"}


def test_weekly_strategy_frame_aggregates_partial_current_week_without_future_rows():
    dates = [
        date(2026, 8, 31), date(2026, 9, 1), date(2026, 9, 2), date(2026, 9, 4),
        date(2026, 9, 7), date(2026, 9, 8), date(2026, 9, 9), date(2026, 9, 10),
    ]
    frame = pl.DataFrame({
        "symbol": ["600000.SH"] * len(dates),
        "date": dates,
        "open": [10.0, 10.1, 10.2, 10.3, 11.0, 11.1, 11.2, 11.3],
        "high": [10.3, 10.4, 10.5, 10.6, 11.3, 11.4, 11.5, 11.6],
        "low": [9.8, 9.9, 10.0, 10.1, 10.8, 10.9, 11.0, 11.1],
        "close": [10.1, 10.2, 10.3, 10.4, 11.1, 11.2, 11.3, 11.4],
        "volume": [100.0] * len(dates),
        "amount": [1000.0] * len(dates),
        "name": ["测试"] * len(dates),
    })

    result = _aggregate_weekly_strategy_frame(frame, date(2026, 9, 10))

    assert result.height == 2
    assert result["date"].to_list() == [date(2026, 9, 4), date(2026, 9, 10)]
    assert result["open"].to_list() == [10.0, 11.0]
    assert result["high"].to_list() == [10.6, 11.6]
    assert result["low"].to_list() == [9.8, 10.8]
    assert result["close"].to_list() == [10.4, 11.4]
    assert result["volume"].to_list() == [400.0, 400.0]
    assert "ma5" in result.columns


def test_30m_strategy_frame_uses_datetime_period_end_and_recomputes_indicators():
    slots = [(9, 31), (10, 1), (10, 31), (11, 1), (13, 1), (13, 31), (14, 1), (14, 31)]
    rows: list[dict] = []
    for day_offset in range(3):
        trade_date = date(2026, 9, 7) + timedelta(days=day_offset)
        for slot, (hour, minute) in enumerate(slots):
            close = 10.0 + day_offset + slot * 0.1
            rows.append({
                "symbol": "510300.SH",
                "datetime": datetime(trade_date.year, trade_date.month, trade_date.day, hour, minute),
                "open": close - 0.05,
                "high": close + 0.1,
                "low": close - 0.1,
                "close": close,
                "volume": 100.0 + slot,
                "amount": close * (100.0 + slot),
            })

    result = _prepare_30m_strategy_frame(pl.DataFrame(rows))

    assert result.height == 24
    assert result.schema["date"] == pl.Datetime("us")
    assert result["date"].to_list()[-1] == datetime(2026, 9, 9, 14, 31)
    assert "ma5" in result.columns
    assert "signal_ma20_breakout" in result.columns


def test_30m_context_loads_multiple_days_and_keeps_all_target_day_bars_as_current():
    raw = pl.DataFrame({
        "symbol": ["510300.SH"] * 3,
        "datetime": [datetime(2026, 9, 8, 14, 31), datetime(2026, 9, 9, 10, 1), datetime(2026, 9, 9, 14, 31)],
        "open": [4.0, 4.1, 4.1],
        "high": [4.1, 4.2, 4.2],
        "low": [3.9, 4.0, 4.0],
        "close": [4.05, 4.15, 4.15],
        "volume": [100.0, 110.0, 110.0],
        "amount": [400.0, 450.0, 450.0],
    })

    class FakeRepo:
        def get_minute_range(self, symbols, start, end, asset_type="stock"):
            assert asset_type == "etf"
            return raw

    class FakeEngine:
        def required_history_bars(self, strategy_ids, *, params_map=None, overrides_map=None):
            return 10

    service = ScreenerService(FakeRepo(), asset_type="etf")  # type: ignore[arg-type]
    context = service.build_strategy_context(
        FakeEngine(),
        date(2026, 9, 9),
        ["etf_30m"],
        timeframe="30m",
        current=pl.DataFrame({"symbol": ["510300.SH"], "name": ["沪深300ETF"]}),
    )

    assert context.history is not None and context.history.height == 3
    assert context.current is not None and context.current.height == 2
    assert context.current["name"].to_list() == ["沪深300ETF"] * 2
    assert context.current["date"].to_list() == [datetime(2026, 9, 9, 10, 1), datetime(2026, 9, 9, 14, 31)]
