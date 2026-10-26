"""Interpretation must describe observed structures without advancing open candles."""
from copy import deepcopy

import pytest

from app.services.chanlun_interpretation import build_interpretation


def sample(count=3, close=10):
    return {
        "bars": [{"date": "2026-10-26 10:00", "periodEnd": "2026-10-26 10:00", "close": close, "isClosed": True}],
        "centers": [{}],
        "latestCenter": {"zd": 9, "zg": 11, "formedAt": "2026-10-26 10:00", "startStrokeIndex": 1, "endStrokeIndex": 3, "componentCount": count},
        "strokes": [{"id": str(i)} for i in range(4)],
        "latestConfirmedStroke": {"direction": "up", "startPrice": 8, "endPrice": 12},
    }


@pytest.mark.parametrize(("count", "close", "key", "subtitle"), [
    (3, 10, "forming", "刚形成"), (5, 10, "oscillating", "中枢延伸"),
    (3, 12, "leaving", "向上离开"), (3, 8, "leaving", "向下离开"),
    (3, 11, "forming", "刚形成"), (3, 9, "forming", "刚形成"),
])
def test_phase_and_observation_follow_closed_price(count, close, key, subtitle):
    a = sample(count, close)
    original = deepcopy(a)
    result = build_interpretation(a)
    assert result["phase"]["key"] == key
    assert result["phase"]["subtitle"] == subtitle
    assert result["ruleSource"] == "project"
    assert result["levels"] == [{"key": "upper", "label": "中枢上沿", "price": 11}, {"key": "lower", "label": "中枢下沿", "price": 9}]
    assert any("9" in c["text"] or "11" in c["text"] for c in result["observation"]["conditions"])
    assert (result["observation"]["conditions"][0]["state"] == "met") == (key == "leaving")
    assert a == original


def test_open_tail_cannot_advance_phase_or_observation():
    a = sample()
    expected = build_interpretation(a)
    a["bars"].append({"date": "2026-10-26 10:30", "periodEnd": "2026-10-26 10:30", "close": 100, "isClosed": False})
    assert build_interpretation(a) == expected


def test_return_requires_closed_evidence_after_center_formation():
    a = sample()
    a["bars"].insert(0, {"date": "2026-10-23 15:00", "periodEnd": "2026-10-23 15:00", "close": 12, "isClosed": True})
    assert build_interpretation(a)["phase"]["key"] == "forming"
    a["bars"].append({"date": "2026-10-26 10:30", "periodEnd": "2026-10-26 10:30", "close": 12, "isClosed": True})
    a["bars"].append({"date": "2026-10-26 11:00", "periodEnd": "2026-10-26 11:00", "close": 10, "isClosed": True})
    assert build_interpretation(a)["phase"]["subtitle"] == "回到中枢"


def test_zero_width_center_missing_legs_and_missing_center():
    a = sample()
    a["latestCenter"].update(zd=10, zg=10, startStrokeIndex=0)
    result = build_interpretation(a)
    assert result["phase"]["key"] == "forming"
    assert result["legs"] == [{"label": "a", "strokes": []}, {"label": "b", "strokes": []}]
    assert result["levels"][0]["price"] == result["levels"][1]["price"] == 10
    a["latestCenter"] = None
    a["centers"] = []
    result = build_interpretation(a)
    assert result["phase"]["key"] == "insufficient"
    assert result["levels"] == []
    assert result["legs"] == []
