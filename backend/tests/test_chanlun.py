"""缠论计算的时间、输入与缓存契约。"""

import random
from datetime import datetime, timedelta

import pytest

from app.services.chanlun import analyze_chanlun


@pytest.fixture
def bars():
    result = []
    rng = random.Random(42)
    close = 20.0
    for i in range(360):
        close = max(2, close + rng.uniform(-0.6, 0.6))
        result.append(
            {
                "date": str((datetime(2025, 1, 1) + timedelta(days=i)).date()),
                "open": close,
                "high": close + 0.1,
                "low": close - 0.1,
                "close": close,
                "volume": 1000.0,
                "is_closed": True,
            }
        )
    return result


def test_official_engine_contract_and_chart_rule_sources(bars):
    result = analyze_chanlun(bars)
    assert result["ruleVersion"] == 4
    assert result["engine"]["name"] == "czsc"
    assert result["engine"]["version"] == "1.0.2"
    assert result["capabilities"]["supportedSources"] == ["stroke"]
    assert result["strokes"]
    assert result["capabilities"]["segments"] is True
    assert result["capabilities"]["segmentRuleSource"] == "project"
    assert result["capabilities"]["divergences"] is True
    for key in ("segmentCenters", "thirdSignals"):
        assert result[key] == []
    assert all(s["confirmedAt"] >= s["endDate"] for s in result["strokes"] if s["confirmed"])
    assert all(f["confirmedAt"] >= f["date"] for f in result["fractals"])


def test_historical_cutoff_cannot_see_future_or_invalid_future_rows(bars):
    cutoff = bars[200]["date"]
    expected = analyze_chanlun(bars[:201])
    future = [*bars, {"date": "2099-01-01", "close": float("nan")}]
    assert analyze_chanlun(future, as_of=cutoff) == expected


def test_open_tail_does_not_confirm_structures(bars):
    before = analyze_chanlun(bars)
    tail = {**bars[-1], "date": "2026-10-17", "close": 25, "high": 30, "low": 1, "is_closed": False}
    after = analyze_chanlun([*bars, tail])
    for key in ("fractals", "strokes", "segments", "centers", "trends", "centerExtensions", "divergences"):
        assert before[key] == after[key]
    assert after["currentPrice"] == 25
    assert after["issues"]


@pytest.mark.parametrize(
    "change",
    [
        {"close": float("nan")},
        {"high": 0},
        {"close": -1},
        {"date": "not-a-date"},
        {"date": "2025-01-01T00:00:00+00:00"},
    ],
)
def test_invalid_data_fails_closed(bars, change):
    result = analyze_chanlun([{**bars[0], **change}, *bars[1:]])
    assert result["status"] == "invalid_data"
    assert result["strokes"] == []


def test_duplicate_and_unknown_close_state_fail_closed(bars):
    assert analyze_chanlun([bars[0], bars[0]])["status"] == "invalid_data"
    assert not analyze_chanlun(
        [{k: v for k, v in row.items() if k != "is_closed"} for row in bars]
    )["strokes"]


def test_cache_isolated_from_caller_mutation_and_price_revision(bars):
    first = analyze_chanlun(bars)
    first["strokes"].clear()
    assert analyze_chanlun(bars)["strokes"]
    revised = [
        {**row, **{key: row[key] * 2 for key in ("open", "high", "low", "close")}} for row in bars
    ]
    assert analyze_chanlun(revised)["strokes"][0]["startPrice"] == pytest.approx(
        analyze_chanlun(bars)["strokes"][0]["startPrice"] * 2
    )


def test_minute_time_labels_remain_beijing_wall_clock(bars):
    minute = [{**row, "date": f"{row['date']} 10:00"} for row in bars]
    result = analyze_chanlun(minute, period="30m")
    assert result["source"] == "stroke"
    assert result["strokes"][0]["startDate"].endswith("10:00")
    assert result["centers"] == result["strokeCenters"]
    assert result["interpretation"]["asOf"].endswith("10:00")


def test_intraday_observation_does_not_expose_completed_daily_candle(bars):
    result = analyze_chanlun(bars, as_of=f"{bars[-1]['date']} 10:00")
    assert result == analyze_chanlun(bars[:-1])


def test_timezone_cutoff_is_rejected_and_engine_failure_is_explicit(bars, monkeypatch):
    from app.services import chanlun

    with pytest.raises(ValueError, match="wall-clock"):
        analyze_chanlun(bars, as_of="2025-01-01T00:00:00+00:00")
    chanlun._analyze_cached.cache_clear()
    original = chanlun._load_engine

    def fail():
        raise ImportError("synthetic missing engine")

    monkeypatch.setattr(chanlun, "_load_engine", fail)
    result = analyze_chanlun(bars)
    assert result["status"] == "engine_unavailable"
    assert not result["strokes"]
    monkeypatch.setattr(chanlun, "_load_engine", original)
    assert analyze_chanlun(bars)["status"] == "ready"


def test_signals_are_first_seen_events_and_never_backdated(bars):
    full = analyze_chanlun(bars)
    assert full["candidateSignals"]
    for signal in full["candidateSignals"]:
        assert signal["availableDate"] >= signal["structureDate"]
        prefix = analyze_chanlun(bars, as_of=signal["availableDate"])
        match = next(s for s in prefix["candidateSignals"] if s["id"] == signal["id"])
        assert match["availableDate"] == signal["availableDate"]
        earlier = [row for row in bars if row["date"] < signal["availableDate"]]
        assert all(s["id"] != signal["id"] for s in analyze_chanlun(earlier)["candidateSignals"])
    invalidated = [
        s
        for s in full["candidateSignals"]
        if s["invalidatedAt"] and s["invalidatedAt"] > s["availableDate"]
    ]
    assert invalidated
    signal = invalidated[0]
    prefix = analyze_chanlun([row for row in bars if row["date"] < signal["invalidatedAt"]])
    assert (
        next(s for s in prefix["candidateSignals"] if s["id"] == signal["id"])["status"]
        == "candidate"
    )


def test_kline_api_opt_in_daily_period_empty_gzip_and_validation(bars, monkeypatch):
    from types import SimpleNamespace

    import polars as pl
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api import kline
    from app.services.chart_data import ChartSnapshot

    frame = pl.DataFrame(
        [
            {**row, "date": datetime.fromisoformat(row["date"]).date(), "symbol": "ETF"}
            for row in bars
        ]
    )
    monkeypatch.setattr(kline, "_chart_snapshot", lambda *args: ChartSnapshot(frame, "test"))
    monkeypatch.setattr(kline, "_get_asset_info", lambda *args: {})
    monkeypatch.setattr(kline, "in_continuous_session", lambda: False)
    monkeypatch.setattr(
        kline, "_maybe_inject_live_candle", lambda _request, _symbol, rows, _asset: rows
    )
    from app.services import preferences

    monkeypatch.setattr(preferences, "get_daily_batch_compress", lambda: True)
    app = FastAPI()
    app.state.repo = SimpleNamespace(resolve_asset_type=lambda _: "etf")
    app.include_router(kline.router)
    client = TestClient(app)
    params = {"symbol": "ETF", "start_date": bars[0]["date"], "end_date": bars[-1]["date"]}
    plain = client.get("/api/kline/daily", params=params)
    assert "chanlun" not in plain.json()
    analyzed = client.get(
        "/api/kline/daily",
        params={**params, "include_chanlun": True, "chanlun_as_of": bars[200]["date"]},
    )
    assert analyzed.status_code == 200
    assert analyzed.headers["content-encoding"] == "gzip"
    # TestClient transparently decodes gzip; same rows are used by the shared service.
    payload = analyzed.json()
    assert payload["chanlun"] == analyze_chanlun(payload["rows"], as_of=bars[200]["date"])
    assert (
        client.get(
            "/api/kline/daily", params={**params, "include_chanlun": True, "chanlun_as_of": "bad"}
        ).status_code
        == 422
    )
    assert (
        client.get(
            "/api/kline/daily", params={**params, "include_chanlun": True, "chanlun_source": "bad"}
        ).status_code
        == 422
    )
    weekly = client.get(
        "/api/kline/period",
        params={**params, "period": "1w", "include_chanlun": True, "chanlun_source": "segment"},
    )
    assert weekly.status_code == 200
    assert weekly.json()["chanlun"]["status"] == "unsupported"
    minute = frame.with_columns(
        pl.col("date").cast(pl.Datetime).dt.replace(hour=10).alias("datetime")
    ).drop("date")
    monkeypatch.setattr(kline, "_chart_snapshot", lambda *args: ChartSnapshot(minute, "test"))
    intraday = client.get(
        "/api/kline/period",
        params={**params, "period": "30m", "days": 120, "include_chanlun": True},
    )
    assert intraday.status_code == 200
    body = intraday.json()
    assert body["chanlun"] == analyze_chanlun(body["rows"], period="30m")
    monkeypatch.setattr(
        kline, "_chart_snapshot", lambda *args: ChartSnapshot(pl.DataFrame(), "test")
    )
    app.state.repo.get_daily_asset = lambda *args, **kwargs: pl.DataFrame()
    empty = client.get("/api/kline/daily", params={**params, "include_chanlun": True})
    assert empty.status_code == 200
    assert empty.json()["chanlun"]["status"] == "insufficient"
