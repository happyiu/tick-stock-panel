"""策略页周线 / 30F 周期数据装配测试。"""
from __future__ import annotations

from datetime import date, datetime, timedelta

import polars as pl

from app.services.screener import (
    ScreenerService,
    _aggregate_weekly_strategy_frame,
    _prepare_30m_strategy_frame,
)


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


def test_30m_context_loads_multiple_days_and_keeps_latest_bar_as_current():
    raw = pl.DataFrame({
        "symbol": ["510300.SH"] * 2,
        "datetime": [datetime(2026, 9, 8, 14, 31), datetime(2026, 9, 9, 14, 31)],
        "open": [4.0, 4.1],
        "high": [4.1, 4.2],
        "low": [3.9, 4.0],
        "close": [4.05, 4.15],
        "volume": [100.0, 110.0],
        "amount": [400.0, 450.0],
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

    assert context.history is not None and context.history.height == 2
    assert context.current is not None and context.current.height == 1
    assert context.current["name"].to_list() == ["沪深300ETF"]
    assert context.current["date"].to_list() == [datetime(2026, 9, 9, 14, 31)]
