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


@pytest.fixture
def durable_daily_session(tmp_path, monkeypatch):
    store = TimelineExecutionStore(tmp_path)
    monkeypatch.setattr(daily_pipeline, "timeline_execution_store", store)
    monkeypatch.setattr(daily_pipeline, "cn_today", lambda: date(2026, 10, 22))
    monkeypatch.setattr(daily_pipeline, "studio_configured", lambda: True)
    monkeypatch.setattr(daily_pipeline._prefs, "_path", lambda: tmp_path / "preferences.json")
    daily_pipeline._prefs._invalidate_cache()
    yield store
    daily_pipeline._prefs._invalidate_cache()


@pytest.mark.asyncio
async def test_daily_session_is_durable_before_request_and_survives_timeout(durable_daily_session, monkeypatch):
    from uuid import UUID

    calls = []
    async def timeout(_prompt, *, session_id=None):
        assert session_id
        UUID(session_id)
        assert daily_pipeline._prefs.get_seekhub_daily_session_id("2026-10-22") == session_id
        running = durable_daily_session.list()[0]
        assert running["status"] == "running" and running["session_id"] == session_id
        calls.append(session_id)
        raise TimeoutError("upstream did not respond")
    monkeypatch.setattr(daily_pipeline, "hermes_studio_run_chat", timeout)
    assert (await daily_pipeline.seekhub_daily_start())["status"] == "failed"
    daily_pipeline._prefs._invalidate_cache()  # restart/reload the file, not just the in-memory value
    assert daily_pipeline._prefs.get_seekhub_daily_session_id("2026-10-22") == calls[0]
    assert durable_daily_session.list()[0]["session_id"] == calls[0]

    async def success(_prompt, *, session_id=None):
        calls.append(session_id)
        return {"session_id": session_id, "run_id": "continued", "output": "continued"}
    monkeypatch.setattr(daily_pipeline, "hermes_studio_run_chat", success)
    assert (await daily_pipeline.seekhub_daily_decision())["status"] == "completed"
    assert calls == [calls[0], calls[0]]


@pytest.mark.asyncio
async def test_daily_failure_keeps_upstream_session_and_partial_result(durable_daily_session, monkeypatch):
    from app.services.hermes_studio import HermesStudioError

    async def fail(_prompt, *, session_id=None):
        raise HermesStudioError("upstream timed out", status_code=504, result={
            "session_id": "canonical-session", "run_id": "upstream-run", "output": "partial analysis",
        })
    monkeypatch.setattr(daily_pipeline, "hermes_studio_run_chat", fail)
    assert (await daily_pipeline.seekhub_daily_start())["status"] == "failed"
    assert daily_pipeline._prefs.get_seekhub_daily_session_id("2026-10-22") == "canonical-session"
    record = durable_daily_session.list()[0]
    assert record["session_id"] == "canonical-session"
    assert record["result"]["run_id"] == "upstream-run"
    assert record["result"]["output"] == "partial analysis"
    assert record["result"]["upstream_status"] == 504


@pytest.mark.asyncio
async def test_daily_methods_do_not_send_overlapping_turns(durable_daily_session, monkeypatch):
    import asyncio

    entered, release = asyncio.Event(), asyncio.Event()
    calls = []
    async def run(_prompt, *, session_id=None):
        calls.append(session_id)
        entered.set()
        await release.wait()
        return {"session_id": session_id, "output": "done"}
    monkeypatch.setattr(daily_pipeline, "hermes_studio_run_chat", run)
    first = asyncio.create_task(daily_pipeline.seekhub_daily_start())
    try:
        await asyncio.wait_for(entered.wait(), 1)
        second = await asyncio.wait_for(daily_pipeline.seekhub_daily_decision(scheduled_time="09:30"), 1)
        assert second["status"] == "skipped"
        assert len(calls) == 1
        skipped = [r for r in durable_daily_session.list() if r["status"] == "skipped"]
        assert len(skipped) == 1 and skipped[0]["session_id"] == calls[0]
    finally:
        release.set()
        await first


def test_daily_reservation_is_atomic_and_rolls_over_by_date(durable_daily_session):
    from concurrent.futures import ThreadPoolExecutor

    with ThreadPoolExecutor(max_workers=8) as executor:
        ids = list(executor.map(lambda _i: daily_pipeline._prefs.ensure_seekhub_daily_session_id("2026-10-22"), range(20)))
    assert len(set(ids)) == 1
    new_id = daily_pipeline._prefs.ensure_seekhub_daily_session_id("2026-10-23")
    assert new_id != ids[0]
    daily_pipeline._prefs._invalidate_cache()
    assert daily_pipeline._prefs.get_seekhub_daily_session_id("2026-10-23") == new_id
    assert daily_pipeline._prefs.get_seekhub_daily_session_id("2026-10-22") is None


@pytest.mark.asyncio
async def test_no_upstream_request_when_session_cannot_be_saved(durable_daily_session, monkeypatch):
    from unittest.mock import AsyncMock

    run = AsyncMock()
    def fail(*_args):
        raise OSError("read-only filesystem")
    monkeypatch.setattr(daily_pipeline._prefs, "set_seekhub_daily_session_id", fail)
    monkeypatch.setattr(daily_pipeline, "hermes_studio_run_chat", run)
    assert (await daily_pipeline.seekhub_daily_start())["status"] == "failed"
    run.assert_not_called()
    assert durable_daily_session.list()[0]["status"] == "failed"


@pytest.mark.asyncio
async def test_real_http_failure_flow_preserves_the_preallocated_session(durable_daily_session, monkeypatch):
    import httpx

    from app import secrets_store
    from app.services import hermes_studio

    real_client = httpx.AsyncClient
    monkeypatch.setattr(secrets_store, "load", lambda: {"hermes_studio_token": "test-token"})
    monkeypatch.setattr(hermes_studio, "current_studio_url", lambda: "http://studio.test")
    requests = []
    def handler(request):
        import json

        body = json.loads(request.content)
        requests.append(body)
        assert daily_pipeline._prefs.get_seekhub_daily_session_id("2026-10-22") == body["session_id"]
        assert durable_daily_session.list()[0]["session_id"] == body["session_id"]
        if len(requests) == 1:
            return httpx.Response(504, json={"ok": False, "session_id": body["session_id"], "run_id": "r-1", "output": "partial", "error": "chat-run timed out"})
        return httpx.Response(200, json={"ok": True, "session_id": body["session_id"], "run_id": "r-2", "output": "continued"})
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(hermes_studio.httpx, "AsyncClient", lambda **kwargs: real_client(transport=transport, **kwargs))
    assert (await daily_pipeline.seekhub_daily_start())["status"] == "failed"
    failure = durable_daily_session.list()[0]
    assert failure["result"]["run_id"] == "r-1" and failure["result"]["output"] == "partial"
    assert "chat-run timed out" in failure["error"]
    assert (await daily_pipeline.seekhub_daily_decision())["status"] == "completed"
    assert len(requests) == 2 and requests[0]["session_id"] == requests[1]["session_id"]
