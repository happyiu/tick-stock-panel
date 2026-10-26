"""Project feature-sequence segmentation over official pens."""
from copy import deepcopy
from itertools import pairwise

from app.services.chanlun_segments import build_segments


def pens(points):
    return [{"index": i, "startDate": f"2026-10-{i + 1:02}", "endDate": f"2026-10-{i + 2:02}",
             "startPrice": a, "endPrice": b, "low": min(a, b), "high": max(a, b),
             "direction": "up" if b > a else "down", "confirmed": True,
             "confirmedAt": f"2026-10-{i + 3:02}", "startSourceIndex": i * 10, "endSourceIndex": (i + 1) * 10}
            for i, (a, b) in enumerate(pairwise(points))]


def test_three_pens_can_only_make_an_unfinished_segment():
    result = build_segments(pens([100, 110, 103, 115]))
    assert len(result) == 1
    assert result[0]["confirmed"] is False
    assert result[0]["confirmedAt"] is None
    assert (result[0]["startPrice"], result[0]["endPrice"]) == (100, 115)
    assert result[0]["componentCount"] == 3
    assert result[0]["ruleSource"] == "project"


def test_no_gap_feature_turn_confirms_at_lookahead_not_at_endpoint():
    strokes = pens([100, 110, 103, 115, 105, 112, 102])
    original = deepcopy(strokes)
    first = build_segments(strokes)[0]
    assert first["confirmed"] is True
    assert first["endStrokeIndex"] == 2
    assert first["endDate"] == strokes[2]["endDate"]
    assert first["confirmedAt"] == strokes[5]["confirmedAt"]
    assert first["confirmation"]["hasGap"] is False
    assert first["confirmation"]["featureStrokeIndices"] == [1, 3, 5]
    assert strokes == original


def test_gap_turn_waits_for_a_reverse_feature_fractal():
    strokes = pens([100, 110, 103, 120, 117, 119, 112, 118, 116, 122])
    assert build_segments(strokes[:6])[0]["confirmed"] is False
    assert build_segments(strokes[:8])[0]["confirmed"] is False
    first = build_segments(strokes)[0]
    assert first["confirmed"] is True
    assert first["confirmation"]["hasGap"] is True
    assert first["confirmation"]["reverseFeatureStrokeIndices"] == [4, 6, 8]
    assert first["confirmedAt"] == strokes[8]["confirmedAt"]


def test_unfinished_feature_cannot_confirm_and_downward_is_symmetric():
    strokes = pens([100, 110, 103, 115, 105, 112, 102])
    strokes[-1].update(confirmed=False, confirmedAt=None)
    assert build_segments(strokes)[0]["confirmed"] is False
    mirror = pens([200 - x for x in [100, 110, 103, 115, 105, 112, 102]])
    first = build_segments(mirror)[0]
    assert first["confirmed"] is True
    assert first["direction"] == "down"
    assert (first["startPrice"], first["endPrice"]) == (100, 85)


def test_insufficient_and_nonoverlapping_pens_do_not_invent_a_segment():
    assert build_segments([]) == []
    assert build_segments(pens([100, 110, 105])) == []
    assert build_segments(pens([100, 110, 120, 130])) == []


def test_feature_inclusion_does_not_create_a_false_turn():
    strokes = pens([100, 110, 103, 112, 102, 111, 104])
    assert not any(s["confirmed"] for s in build_segments(strokes))
