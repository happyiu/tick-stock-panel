"""Conditional scenarios use only the observed closed prefix, never future prices."""
from copy import deepcopy

import pytest

from app.services.chanlun_projection import build_projection


def sample(close=10):
    return {
        "bars": [{"date": "2026-10-26", "periodEnd": "2026-10-26", "close": close, "isClosed": True}],
        "centers": [
            {"id": "upper-far", "startDate": "2026-09-01", "endDate": "2026-09-03", "formedAt": "2026-09-04", "zd": 16, "zg": 18},
            {"id": "upper", "startDate": "2026-09-05", "endDate": "2026-09-08", "formedAt": "2026-09-09", "zd": 13, "zg": 15},
            {"id": "lower", "startDate": "2026-09-10", "endDate": "2026-09-15", "formedAt": "2026-09-16", "zd": 5, "zg": 7},
            {"id": "current", "startDate": "2026-10-01", "endDate": "2026-10-20", "formedAt": "2026-10-23", "zd": 9, "zg": 11},
        ],
    }


@pytest.mark.parametrize(("close", "side", "labels"), [
    (10, "inside", ["向上离开", "向下离开", "继续震荡"]),
    (12, "above", ["回抽未回", "回到中枢", "新高力度观察"]),
    (8, "below", ["回到中枢", "反弹未回", "新低力度观察"]),
    (9, "inside", ["向上离开", "向下离开", "继续震荡"]),
    (11, "inside", ["向上离开", "向下离开", "继续震荡"]),
])
def test_branches_follow_closed_position_and_have_no_probability_or_price_target(close, side, labels):
    a = sample(close)
    original = deepcopy(a)
    result = build_projection(a)
    assert result["status"] == "ready" and result["side"] == side
    assert [b["label"] for b in result["branches"]] == labels
    assert [z["centerId"] for z in result["zones"]] == ["current", "upper", "lower"]
    assert result["ruleSource"] == "project"
    assert all(b["condition"] and b["meaning"] for b in result["branches"])
    assert "probability" not in str(result) and "targetPrice" not in str(result)
    if side != "inside":
        assert result["branches"][2]["rule"]["function"] == "tas_macd_bc_V230804"
        assert "面积" not in result["branches"][2]["condition"]
    assert a == original


def test_open_tail_and_future_centers_cannot_change_scenarios():
    a = sample()
    expected = build_projection(a)
    a["bars"].append({"date": "2026-10-27", "periodEnd": "2026-10-27", "close": 100, "isClosed": False})
    a["centers"].append({"id": "future", "startDate": "2026-10-24", "endDate": "2026-10-26", "formedAt": "2026-10-27", "zd": 90, "zg": 100})
    assert build_projection(a) == expected


def test_zero_width_center_is_valid_and_empty_or_unclosed_inputs_are_explicit():
    a = sample()
    a["centers"][-1].update(zd=10, zg=10)
    assert build_projection(a)["side"] == "inside"
    a["centers"] = []
    assert build_projection(a)["status"] == "insufficient"
    a["bars"][0]["isClosed"] = False
    assert build_projection(a)["anchor"] is None
    assert build_projection(a)["branches"] == []


def test_weekly_anchor_keeps_actual_period_end_and_excludes_future_formation():
    a = sample()
    a["bars"][0].update(date="2026-10-19", periodEnd="2026-10-23")
    result = build_projection(a)
    assert result["anchor"] == {"date": "2026-10-19", "availableDate": "2026-10-23", "price": 10}
    assert result["center"]["centerId"] == "current"
