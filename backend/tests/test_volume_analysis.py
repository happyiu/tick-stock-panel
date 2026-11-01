from datetime import date, timedelta

import polars as pl
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.custom import volume_analysis as volume

TODAY = date(2026, 10, 30)


def rows(values):
    return [{"date": TODAY - timedelta(days=len(values) - index - 1), "amount": value}
            for index, value in enumerate(values)]


def test_rolling_mean_full_window_and_missing_amount():
    points, crosses = volume.calculate_trend(rows([10.0] * 28 + [None] + [20.0] * 28), TODAY)
    assert points[27]["ma28"] == 10.0
    assert points[28]["ma5"] is None
    assert points[28]["ma28"] is None
    assert points[-1]["ma28"] == 20.0
    assert all(event["date"] != points[28]["date"] for event in crosses)


def test_three_pairs_cross_both_directions_and_clip_90():
    values = [10.0] * 35 + [100.0] * 35 + [1.0] * 35 + [100.0] * 35
    points, crosses = volume.calculate_trend(rows(values), TODAY)
    assert len(points) == 90
    assert points[0]["date"] == rows(values)[-90]["date"].isoformat()
    assert {event["kind"] for event in crosses} == {"golden", "death"}
    assert {f'{event["fast"]}/{event["slow"]}' for event in crosses} == {
        "ma5/ma13", "ma5/ma28", "ma13/ma28"}
    assert all(event["date"] >= points[0]["date"] for event in crosses)


def test_empty_and_today_provisional():
    assert volume.calculate_trend([], TODAY) == ([], [])
    points, _ = volume.calculate_trend(rows([5.0] * 30), TODAY)
    assert points[-1]["provisional"] is True
    assert points[-2]["provisional"] is False


class Repo:
    def get_index_daily(self, symbol, start, end, columns=None):
        return pl.DataFrame(rows([10.0] * 30))

    def get_name_map(self, symbols):
        return {"000300.SH": "沪深300"}


def test_api_replaces_today_and_rejects_unknown(monkeypatch):
    monkeypatch.setattr(volume, "cn_today", lambda: TODAY)
    monkeypatch.setattr(volume, "latest_live_candle", lambda *args, **kwargs: {
        "date": TODAY.isoformat(), "amount": 100.0, "quote_ts": None})
    app = FastAPI()
    app.state.repo = Repo()
    app.include_router(volume.router)
    client = TestClient(app)
    result = client.get("/api/custom/volume-analysis/trend", params={"symbol": "000300.SH"})
    assert result.status_code == 200
    body = result.json()
    assert body["points"][-1]["amount"] == 100.0
    assert body["points"][-1]["provisional"] is True
    assert body["source"] == "live"
    assert body["name"] == "沪深300"
    assert client.get("/api/custom/volume-analysis/trend", params={"symbol": "600000.SH"}).status_code == 422
