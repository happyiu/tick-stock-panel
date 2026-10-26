"""Chart projections must use observed center bounds and closed input only."""
from copy import deepcopy

from app.services.chanlun_geometry import build_center_extensions, build_trends


def center(i, lower, upper):
    return {"id": f"zs-{i}", "startDate": f"2026-10-{10 + i * 2}",
            "endDate": f"2026-10-{11 + i * 2}", "formedAt": f"2026-10-{12 + i * 2}",
            "zd": lower, "zg": upper}


def test_trend_bands_follow_center_relations_and_split_on_direction_change():
    centers = [center(0, 10, 11), center(1, 12, 13), center(2, 14, 15), center(3, 8, 9)]
    original = deepcopy(centers)
    trends = build_trends(centers, "2026-10-20")
    assert [t["direction"] for t in trends] == ["up", "down"]
    assert trends[0]["centerIds"] == ["zs-0", "zs-1", "zs-2"]
    assert trends[1]["centerIds"] == ["zs-2", "zs-3"]
    assert trends[-1]["current"] is True
    assert trends[0]["current"] is False
    assert trends[-1]["band"][-1] == {"date": "2026-10-20", "lower": 8, "upper": 9}
    assert trends[-1]["availableDate"] == "2026-10-18"
    assert all(t["ruleSource"] == "project" for t in trends)
    assert centers == original


def test_overlapping_and_equal_boundaries_remain_consolidation():
    assert build_trends([], "2026-10-20") == []
    for centers in ([center(0, 10, 11)], [center(0, 10, 11), center(1, 11, 12)]):
        trends = build_trends(centers, "2026-10-20")
        assert len(trends) == 1
        assert trends[0]["direction"] == "none"
    flat = build_trends([center(0, 10, 10)], "2026-10-20")[0]
    assert all(b["upper"] == b["lower"] for b in flat["band"])


def test_extensions_start_at_each_center_end_and_stop_at_closed_boundary():
    centers = [center(0, 10, 11), center(1, 12, 12)]
    lines = build_center_extensions(centers, "2026-10-20")
    assert len(lines) == 2
    assert lines[0]["startDate"] == "2026-10-11"
    assert all(line["endDate"] == "2026-10-20" for line in lines)
    assert lines[1]["zd"] == lines[1]["zg"] == 12
    assert build_center_extensions(centers, "2026-10-11") == []


def test_history_prefix_does_not_read_future_centers():
    now = [center(0, 10, 11), center(1, 12, 13)]
    future = [*now, center(2, 8, 9)]
    assert build_trends(future, "2026-10-14") == build_trends(now, "2026-10-14")
    assert build_center_extensions(future, "2026-10-14") == build_center_extensions(now, "2026-10-14")
