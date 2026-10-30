# ruff: noqa: RUF001
from copy import deepcopy

from app.services.wave_comparison import compare_periods


def period(adjustment="forward", counts=True):
    return dict(
        status="ok" if counts else "no_candidate",
        source=dict(adjustment=adjustment, stale=False),
        dataCoverage=dict(bars=320),
        coverageStart="2026-09-01",
        dataThrough="2026-10-27",
        counts=[dict(direction="up")] if counts else [],
    )


def test_current_page_has_candidates_but_different_adjustment():
    result = compare_periods({"1d": period(), "30m": period("none")})
    assert result["status"] == "adjustment_mismatch"
    assert result["summary"] == "日线为前复权，30分钟为不复权，暂不进行跨周期对照"
    assert "覆盖不足" not in result["summary"]


def test_missing_candidates_are_not_missing_data():
    result = compare_periods({"1d": period(), "30m": period(counts=False)})
    assert result["summary"] == "30分钟已有320根K线，暂未识别到有效浪形"


def test_empty_unknown_invalid_stale_and_unsupported_are_distinct():
    for change, message in [
        ({"dataThrough": None}, "没有可用的已收盘K线"),
        ({"source": dict(adjustment="unknown")}, "复权方式未知"),
        ({"status": "invalid_data"}, "数据校验失败"),
        ({"source": dict(adjustment="forward", stale=True)}, "行情快照已过期"),
        ({"status": "unsupported"}, "暂不支持波浪分析"),
    ]:
        minute = deepcopy(period())
        minute.update(change)
        assert message in compare_periods({"1d": period(), "30m": minute})["summary"]


def test_matching_and_conflicting_directions():
    periods = {"1d": period(), "30m": period()}
    assert compare_periods(periods)["status"] == "available"
    assert "方向一致" in compare_periods(periods)["summary"]
    periods["30m"]["counts"][0]["direction"] = "down"
    assert "周期方向不同" in compare_periods(periods)["summary"]
