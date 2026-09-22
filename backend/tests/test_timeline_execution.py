from __future__ import annotations

from app.services.timeline_execution import TimelineExecutionStore


def test_timeline_execution_persists_result_status_and_session(tmp_path) -> None:
    store = TimelineExecutionStore(tmp_path)
    run_id = store.start(
        task_name="ai追踪分析启动",
        method="seekhub_daily_start",
        timeline_date="2026-09-22",
        scheduled_time="08:00",
    )
    store.finish(
        run_id,
        status="succeeded",
        session_id="session-1",
        result={"output": "分析完成", "run_id": "run-1"},
    )

    rows = store.list(timeline_date="2026-09-22")

    assert rows[0]["id"] == run_id
    assert rows[0]["status"] == "succeeded"
    assert rows[0]["scheduled_time"] == "08:00"
    assert rows[0]["session_id"] == "session-1"
    assert rows[0]["result"] == {"output": "分析完成", "run_id": "run-1"}
    assert rows[0]["error"] is None


def test_timeline_execution_filters_method_and_keeps_failure(tmp_path) -> None:
    store = TimelineExecutionStore(tmp_path)
    store.finish(
        store.start(
            task_name="盘后 · 全量管道",
            method="daily_pipeline",
            timeline_date="2026-09-22",
            scheduled_time="15:35",
        ),
        status="failed",
        error="上游超时",
    )
    store.start(
        task_name="数据-自动调度-盘前 · 个股维表",
        method="instruments_sync",
        timeline_date="2026-09-22",
        scheduled_time="09:10",
    )

    rows = store.list(timeline_date="2026-09-22", method="daily_pipeline")

    assert len(rows) == 1
    assert rows[0]["status"] == "failed"
    assert rows[0]["error"] == "上游超时"


def test_timeline_execution_restart_reuses_and_clears_record(tmp_path) -> None:
    store = TimelineExecutionStore(tmp_path)
    run_id = store.start(
        task_name="ai追踪分析启动",
        method="seekhub_daily_start",
        timeline_date="2026-09-22",
        scheduled_time="08:00",
    )
    store.finish(run_id, status="failed", session_id="session-old", result={"old": True}, error="超时")

    assert store.restart(run_id) is True
    rows = store.list(timeline_date="2026-09-22")

    assert len(rows) == 1
    assert rows[0]["id"] == run_id
    assert rows[0]["status"] == "running"
    assert rows[0]["finished_at"] is None
    assert rows[0]["session_id"] is None
    assert rows[0]["result"] is None
    assert rows[0]["error"] is None
