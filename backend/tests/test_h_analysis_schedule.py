from __future__ import annotations

from datetime import date

import pytest

from app.jobs import daily_pipeline
from app.services.timeline_execution import TimelineExecutionStore


class _Scheduler:
    def __init__(self) -> None:
        self.kwargs = None

    def add_job(self, _func, **kwargs):
        self.kwargs = kwargs


def test_h_analysis_job_runs_daily_at_eight() -> None:
    scheduler = _Scheduler()

    daily_pipeline._register_h_analysis_job(scheduler)

    assert scheduler.kwargs["id"] == daily_pipeline.SEEKHUB_DAILY_JOB_ID
    assert str(scheduler.kwargs["trigger"]) == "cron[hour='8', minute='0']"
    assert str(scheduler.kwargs["trigger"].fields[4]) == "*"


@pytest.mark.asyncio
async def test_seekhub_daily_methods_share_session(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    session = {"date": "2026-09-22", "id": "session-old"}
    calls: list[tuple[str, str | None]] = []

    monkeypatch.setattr(daily_pipeline, "timeline_execution_store", TimelineExecutionStore(tmp_path))
    monkeypatch.setattr(daily_pipeline, "cn_today", lambda: date(2026, 9, 22))
    monkeypatch.setattr(daily_pipeline, "studio_configured", lambda: True)
    monkeypatch.setattr(
        daily_pipeline._prefs,
        "get_seekhub_daily_prompt",
        lambda method: {"seekhub_daily_start": "请分析 YYYY-MM-DD 的市场", "seekhub_daily_decision": "开始盘中分析吧"}[method],
    )
    monkeypatch.setattr(
        daily_pipeline._prefs,
        "get_seekhub_daily_session_id",
        lambda session_date: session["id"] if session["date"] == session_date else None,
    )
    monkeypatch.setattr(
        daily_pipeline._prefs,
        "set_seekhub_daily_session_id",
        lambda session_date, session_id: session.update(date=session_date, id=session_id) or session_id,
    )

    async def fake_run_chat(input_text: str, *, session_id: str | None = None):
        calls.append((input_text, session_id))
        return {"session_id": "session-new", "run_id": "run-1", "output": "分析结果"}

    monkeypatch.setattr(daily_pipeline, "hermes_studio_run_chat", fake_run_chat)

    result = await daily_pipeline.seekhub_daily_start()
    decision_result = await daily_pipeline.seekhub_daily_decision()

    assert result == {"status": "completed", "date": "2026-09-22"}
    assert decision_result == {"status": "completed", "date": "2026-09-22"}
    assert calls == [("请分析 2026-09-22 的市场", "session-old"), ("开始盘中分析吧", "session-new")]
    rows = daily_pipeline.timeline_execution_store.list(timeline_date="2026-09-22")
    rows_by_method = {row["method"]: row for row in rows}
    assert set(rows_by_method) == {"seekhub_daily_decision", "seekhub_daily_start"}
    assert all(row["status"] == "succeeded" for row in rows)
    assert all(row["session_id"] == "session-new" for row in rows)
    assert rows_by_method["seekhub_daily_start"]["result"]["output"] == "分析结果"


def test_seekhub_daily_session_expires_by_date(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = tmp_path / "preferences.json"
    monkeypatch.setattr(daily_pipeline._prefs, "_path", lambda: path)
    daily_pipeline._prefs._invalidate_cache()
    try:
        daily_pipeline._prefs.set_seekhub_daily_session_id("2026-09-22", "session-one")
        assert daily_pipeline._prefs.get_seekhub_daily_session_id("2026-09-22") == "session-one"
        assert daily_pipeline._prefs.get_seekhub_daily_session_id("2026-09-23") is None
    finally:
        daily_pipeline._prefs._invalidate_cache()
