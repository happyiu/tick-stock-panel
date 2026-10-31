"""Native stock-trend-pattern contract and causal recognition regressions."""

from datetime import date, timedelta

import pytest

from app.services.trend_patterns import analyze, catalog
from app.services.trend_patterns.recognize import geometry
from app.services.trend_patterns.structure import pivots


def bars(n=250):
    return [
        dict(
            date=(date(2025, 1, 1) + timedelta(days=i)).isoformat(),
            open=100.0,
            high=102.0,
            low=98.0,
            close=100.0,
            volume=1000.0,
            is_closed=True,
        )
        for i in range(n)
    ]


def test_contract_and_indicator_alignment():
    result = analyze(bars(), symbol="TEST.SH")
    assert {
        "candles",
        "indicators",
        "trend",
        "swings",
        "levels",
        "patterns",
        "verdict",
    } <= result.keys()
    assert len(result["candles"]) == 160
    assert result["candles"][-1][1:] == [100.0, 102.0, 98.0, 100.0, 1000.0]
    for group in result["indicators"].values():
        for series in group.values() if isinstance(group, dict) else [group]:
            assert len(series) == 160
    assert result["indicators"]["rsi"][-1] == 50
    assert result["verdict"]["stanceEn"] == "flat"


def test_catalog_has_84_unique_patterns_and_explicit_detection():
    items = catalog()
    assert len(items) == len({p["id"] for p in items}) == 84
    assert all(p["detect"] for p in items)


def test_latest_candle_hit_is_not_masked_by_old_one():
    rows = bars()
    for i, row in enumerate(rows):
        close = 500 - i * 1.5
        row.update(open=close + 0.8, high=close + 1.2, low=close - 0.3, close=close)
    for end in (240, 249):
        previous = rows[end - 1]
        rows[end].update(
            open=previous["close"] - 0.5,
            close=previous["open"] + 0.5,
            high=previous["open"] + 0.9,
            low=previous["close"] - 0.9,
        )
    result = analyze(rows, symbol="TEST.SH")
    engulfing = next(p for p in result["patterns"] if p["id"] == "bullish_engulfing")
    assert engulfing["date"] == rows[-1]["date"]
    assert engulfing["at"] == 159
    assert engulfing["scaled"] is False
    assert engulfing["stopPrice"] == rows[-1]["low"]


def test_as_of_truncates_before_indicators_and_pattern_detection():
    rows = bars()
    cutoff = rows[199]["date"]
    expected = analyze(rows[:200], symbol="TEST.SH")
    actual = analyze(rows, symbol="TEST.SH", as_of=cutoff)
    for key in ("candles", "indicators", "trend", "swings", "levels", "patterns", "verdict"):
        assert actual[key] == expected[key], key
    rows[-1]["is_closed"] = False
    assert analyze(rows, symbol="TEST.SH")["lastDate"] == rows[-2]["date"]


@pytest.mark.parametrize("mutation", [dict(high=80), dict(close=float("nan")), dict(volume=-1)])
def test_invalid_data_fails_closed(mutation):
    rows = bars()
    rows[-1].update(mutation)
    with pytest.raises(ValueError):
        analyze(rows, symbol="TEST.SH")


def test_insufficient_data_still_has_seven_fields_without_direction():
    result = analyze(bars(10), symbol="TEST.SH")
    assert result["status"] == "insufficient"
    assert result["patterns"] == []
    assert result["verdict"]["score"] is None
    assert result["verdict"]["stanceEn"] == "unknown"


def test_double_bottom_uses_lows_instead_of_highs():
    rows = bars(60)
    cs = [
        dict(d=r["date"], o=r["open"], h=r["high"], l=r["low"], c=r["close"], v=r["volume"])
        for r in rows
    ]
    cs[10]["h"] = cs[30]["h"] = 115.0
    cs[20]["l"], cs[40]["l"] = 90.0, 70.0
    cs[-1]["c"], cs[-1]["h"] = 110.0, 112.0
    assert geometry(cs, dict(type="double", top=False), pivots(cs)) is None
    cs[20]["l"] = cs[40]["l"] = 80.0
    cs[30]["h"] = 110.0
    cs[-1]["c"], cs[-1]["h"] = 116.0, 117.0
    found = geometry(cs, dict(type="double", top=False), pivots(cs))
    assert found["status"] == "confirmed"
    assert found["triggerPrice"] == 110.0
    assert found["stopPrice"] == 80.0
    assert found["targetPrice"] == 140.0


def test_bullish_wedge_is_not_reported_after_breaking_its_lower_boundary():
    cs = [dict(d=f"D{i}", o=100.0, h=102.0, l=98.0, c=100.0, v=1000.0) for i in range(60)]
    swings = dict(
        ph=[dict(i=i, p=p) for i, p in [(10, 120.0), (30, 110.0), (50, 100.0)]],
        pl=[dict(i=i, p=p) for i, p in [(15, 90.0), (35, 85.0), (55, 80.0)]],
    )
    assert geometry(cs, dict(type="wedge", rising=False), swings)["status"] == "confirmed"
    cs[-1].update(o=76.0, c=75.0, h=77.0, l=74.0)
    assert geometry(cs, dict(type="wedge", rising=False), swings) is None


def test_swings_publish_both_anchor_and_confirmation_time():
    rows = bars(40)
    rows[20]["high"] = 110.0
    result = analyze(rows, symbol="TEST.SH")
    point = next(p for p in result["swings"]["ph"] if p["d"] == rows[20]["date"])
    assert point["confirmedAt"] == rows[23]["date"]
    assert not analyze(rows, symbol="TEST.SH", as_of=rows[22]["date"])["swings"]["ph"]


def test_date_only_daily_bar_is_not_available_before_its_close():
    rows = bars(40)
    result = analyze(rows, symbol="TEST.SH", as_of=rows[-1]["date"] + " 10:00:00")
    assert result["lastDate"] == rows[-2]["date"]


def test_tail_indices_are_null_when_the_anchor_is_outside_returned_candles():
    rows = bars()
    rows[100]["high"] = 120.0
    result = analyze(rows, symbol="TEST.SH", tail=1)
    assert all(
        level["lastIdx"] is None or level["lastIdx"] == 0
        for level in result["levels"]["resistance"]
    )


def test_missing_volume_preserves_price_analysis_without_fake_volume_confirmation():
    rows = bars()
    for row in rows:
        row["volume"] = None
    result = analyze(rows, symbol="TEST.SH")
    assert result["status"] == "ok"
    assert result["verdict"]["volRatio"] is None
    assert all(v is None for v in result["indicators"]["obv"])
    assert all(p["volumeConfirmed"] is None for p in result["patterns"])


def test_forming_geometry_does_not_increase_pattern_direction_score():
    from app.services.trend_patterns.structure import verdict

    rows = bars()
    data = analyze(rows, symbol="TEST.SH")
    cs = [dict(c=100.0) for _ in rows]
    forming = dict(status="forming", dir="bull", conf=90)
    output = verdict(cs, data["indicators"], data["trend"], data["levels"], [forming])
    assert output["patternScore"] == 0
    assert output["agree"] is False


def test_all_catalog_rules_run_on_teaching_examples_without_exceptions():
    from app.services.trend_patterns.recognize import recognize

    for pattern in catalog():
        cs = [
            dict(d=f"D{i:03}", o=r[0], h=r[1], l=r[2], c=r[3], v=r[4])
            for i, r in enumerate(pattern["candles"])
        ]
        hits = recognize(cs, [pattern]) if len(cs) >= 30 else []
        assert len(hits) <= 1
        for found in hits:
            assert found["scaled"] is False
            assert found["confirmedAt"] is None or found["confirmedAt"] in [c["d"] for c in cs]


def test_api_returns_contract_catalog_and_rejects_invalid_or_oversized_input():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api.stock_analysis import router

    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    response = client.post(
        "/api/stock-analysis/trend-patterns", json=dict(symbol="TEST.SH", rows=bars())
    )
    assert response.status_code == 200
    assert response.json()["momentumReversion"]["status"] == "ok"
    assert response.json()["momentumReversion"]["opportunity"]["title"]
    assert response.json()["momentumReversion"]["opportunity"]["pending"]
    assert response.json()["sampleCount"] == 250
    assert len(response.json()["candles"]) == 160
    assert len(client.get("/api/stock-analysis/pattern-catalog").json()["items"]) == 84
    invalid = bars()
    invalid[-1]["low"] = 110.0
    assert (
        client.post(
            "/api/stock-analysis/trend-patterns", json=dict(symbol="TEST.SH", rows=invalid)
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/stock-analysis/trend-patterns", json=dict(symbol="TEST.SH", rows=bars(1501))
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/stock-analysis/trend-patterns",
            json=dict(symbol="TEST.SH", rows=bars(), as_of="bad-date"),
        ).status_code
        == 422
    )


def test_geometry_uses_absolute_dates_and_survives_tail_truncation():
    rows = bars()
    for i, row in enumerate(rows):
        close = 500 - i * 1.5
        row.update(open=close + 0.8, high=close + 1.2, low=close - 0.3, close=close)
    previous = rows[-2]
    rows[-1].update(
        open=previous["close"] - 0.5,
        close=previous["open"] + 0.5,
        high=previous["open"] + 0.9,
        low=previous["close"] - 0.9,
    )
    full = analyze(rows, symbol="TEST.SH")
    short = analyze(rows, symbol="TEST.SH", tail=1)
    a = next(p for p in full["patterns"] if p["id"] == "bullish_engulfing")
    b = next(p for p in short["patterns"] if p["id"] == a["id"])
    assert a["geometry"] == b["geometry"]
    assert a["geometry"]["start"] == rows[-2]["date"]
    assert a["geometry"]["end"] == rows[-1]["date"]
    assert all(p["geometry"] for p in full["patterns"])


def test_double_bottom_geometry_preserves_recognition_points_and_neckline():
    cs = [dict(d=f"D{i}", o=100.0, h=102.0, l=98.0, c=100.0, v=1000.0) for i in range(60)]
    cs[20]["l"] = cs[40]["l"] = 80.0
    cs[30]["h"] = 110.0
    cs[-1].update(c=116.0, h=117.0)
    found = geometry(cs, dict(type="double", top=False), pivots(cs))
    paths = found["geometry"]["paths"]
    assert paths[0]["points"] == [
        dict(date="D20", price=80.0),
        dict(date="D30", price=110.0),
        dict(date="D40", price=80.0),
    ]
    assert paths[1]["points"][-1] == dict(date="D59", price=110.0)
    assert found["geometry"]["start"] == "D20"


def test_fitted_boundaries_are_the_same_lines_used_for_recognition():
    cs = [dict(d=f"D{i}", o=100.0, h=102.0, l=98.0, c=100.0, v=1000.0) for i in range(60)]
    swings = dict(
        ph=[dict(i=i, p=p) for i, p in [(10, 120.0), (30, 110.0), (50, 100.0)]],
        pl=[dict(i=i, p=p) for i, p in [(15, 90.0), (35, 85.0), (55, 80.0)]],
    )
    found = geometry(cs, dict(type="wedge", rising=False), swings)
    upper, lower = found["geometry"]["paths"]
    assert upper["points"][-1]["price"] == found["triggerPrice"]
    assert lower["points"][-1]["price"] == found["stopPrice"]
