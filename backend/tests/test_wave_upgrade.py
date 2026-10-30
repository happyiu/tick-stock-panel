import random
from datetime import datetime, timedelta

from app.services.wave import analyze_wave
from app.services.wave_core.elliott.templates import load_bundled_templates


def test_minute_cutoff_prefix_and_templates():
    rng = random.Random(7)
    rows = []
    for i in range(120):
        v = 100 + rng.uniform(-15, 15)
        rows.append(
            dict(
                date=str(datetime(2025, 1, 1, 10) + timedelta(minutes=30 * i)),
                open=v,
                high=v + 1,
                low=v - 1,
                close=v,
                is_closed=True,
            )
        )
    for end in (30, 60, 90):
        assert analyze_wave(rows[:end], "30m") == analyze_wave(rows, "30m", rows[end - 1]["date"])
    result = analyze_wave(rows, "30m")
    assert result["status"] in ("ok", "no_candidate")
    assert len(result["counts"]) <= 3
    assert len(load_bundled_templates()) == 8
    assert all(p["confirmedAt"] >= p["date"] for c in result["counts"] for p in c["points"])


def test_daily_cannot_read_today_before_close():
    row = dict(date="2025-01-01", open=10, high=11, low=9, close=10, is_closed=True)
    assert analyze_wave([row], as_of="2025-01-01 14:59")["dataThrough"] is None
    assert analyze_wave([row], as_of="2025-01-01 15:00")["dataThrough"] == "2025-01-01"


def test_snapshot_deduplication(tmp_path, monkeypatch):
    from app.config import settings
    from app.services import wave_history

    monkeypatch.setattr(settings, "data_dir", tmp_path)
    payload = dict(symbol="510300.SH", asset_type="etf", asOf="2025-01-01", periods={})
    ident = wave_history.save(payload)
    assert wave_history.save(payload) == ident
    assert len(wave_history.history("510300.SH", "etf")) == 1
    assert wave_history.read(ident) == payload


def test_aggregate_api_and_save_failure(monkeypatch):
    import sqlite3
    from datetime import date
    from types import SimpleNamespace

    import polars as pl

    from app.api.stock_analysis import WaveAnalyzeRequest, wave_analyze
    from app.services import chart_candles, wave_history
    from app.services.chart_data import ChartSnapshot

    def snapshot(state, symbol, asset, period, start, end):
        if period == "30m":
            frame = pl.DataFrame(
                {
                    "symbol": [symbol],
                    "datetime": [datetime(2025, 1, 1, 10)],
                    "open": [10.0],
                    "high": [11.0],
                    "low": [9.0],
                    "close": [10.0],
                    "volume": [100],
                }
            )
        else:
            frame = pl.DataFrame(
                {
                    "symbol": [symbol],
                    "date": [date(2025, 1, 1)],
                    "open": [10.0],
                    "high": [11.0],
                    "low": [9.0],
                    "close": [10.0],
                    "volume": [100],
                }
            )
        return ChartSnapshot(frame, "test", adjustment="forward")

    monkeypatch.setattr(chart_candles, "chart_snapshot", snapshot)
    monkeypatch.setattr(wave_history, "history", lambda *a: [])

    def fail(*args):
        raise sqlite3.OperationalError("disk")

    monkeypatch.setattr(wave_history, "save", fail)
    request = SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(repo=SimpleNamespace(resolve_asset_type=lambda symbol: "etf"))
        )
    )
    result = wave_analyze(
        request, WaveAnalyzeRequest(symbol="510300.SH", asset_type="etf", as_of="2025-01-01 10:00")
    )
    assert result["saved"] is False
    assert result["periods"]["1d"]["dataThrough"] is None
    assert result["periods"]["30m"]["dataThrough"] == "2025-01-01 10:00:00"


def test_price_geometry_and_mirrors():
    from decimal import Decimal

    from app.services.wave_core.domain import Interval
    from app.services.wave_core.elliott.models import WaveCount
    from app.services.wave_core.pivots.models import PivotEvent, PivotState, PivotType
    from app.services.wave_engine import shape_guard

    valid = {
        "impulse": [10, 20, 15, 35, 25, 45],
        "zigzag": [10, 20, 15, 30],
        "flat": [10, 20, 10, 22],
        "expanded_flat": [10, 20, 8, 25],
        "contracting_triangle": [10, 30, 15, 25, 18, 22],
        "leading_diagonal": [10, 30, 18, 33, 25, 35],
        "ending_diagonal": [10, 30, 18, 33, 25, 35],
        "wxy": [10, 30, 20, 40],
    }

    def count(name, values):
        return WaveCount(
            pattern=name,
            degree=1,
            pivots=[
                PivotEvent(
                    interval=Interval.DAILY,
                    degree=1,
                    timestamp=datetime(2025, 1, 1) + timedelta(days=i),
                    confirmed_at=datetime(2025, 1, 2) + timedelta(days=i),
                    price=Decimal(str(v)),
                    type=PivotType.LOW if i % 2 == 0 else PivotType.HIGH,
                    state=PivotState.CONFIRMED,
                )
                for i, v in enumerate(values)
            ],
        )

    for name, values in valid.items():
        from app.services.wave_core.elliott.validator import validate

        templates = {t.name: t for t in load_bundled_templates()}
        assert not validate(count(name, values), templates[name]).hard_violations, name
        assert shape_guard(count(name, values)), name
        assert shape_guard(count(name, [100 - v for v in values])), name
    assert not shape_guard(count("contracting_triangle", [10, 30, 15, 35, 18, 38]))
    assert not shape_guard(count("impulse", [10, 20, 15, 35, 19, 45]))
