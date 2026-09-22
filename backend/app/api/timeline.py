"""时间轴定时任务执行记录 API。"""
from __future__ import annotations

import asyncio
import logging
from datetime import date as date_type
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.market_time import cn_today
from app.services.timeline_execution import timeline_execution_store

router = APIRouter(prefix="/api/timeline", tags=["timeline"])
logger = logging.getLogger(__name__)
_RETRY_TASKS: set[asyncio.Task[None]] = set()

RETRYABLE_METHODS = {
    "daily_pipeline",
    "instruments_sync",
    "scheduled_review",
    "seekhub_daily_start",
    "seekhub_daily_decision",
}


class TimelineRetryRequest(BaseModel):
    method: str = Field(min_length=1, max_length=120)
    task_name: str = Field(default="", max_length=200)
    scheduled_time: str = Field(pattern=r"^\d{2}:\d{2}$")


async def _run_retry(request: Request, item: dict, run_id: str) -> None:
    from app.jobs import daily_pipeline

    method = item["method"]
    scheduled_time = item["scheduled_time"]
    try:
        if method == "seekhub_daily_start":
            await daily_pipeline.seekhub_daily_start(
                scheduled_time=scheduled_time,
                timeline_run_id=run_id,
            )
            return
        if method == "seekhub_daily_decision":
            await daily_pipeline.seekhub_daily_decision(
                scheduled_time=scheduled_time,
                timeline_run_id=run_id,
            )
            return
        if method == "scheduled_review":
            await daily_pipeline._run_scheduled_review_tracked(
                request.app.state.repo,
                scheduled_time,
                timeline_run_id=run_id,
            )
            return

        repo = request.app.state.repo
        if method == "instruments_sync":
            await asyncio.to_thread(
                daily_pipeline._run_tracked,
                lambda on_progress=None: daily_pipeline.run_instruments_sync(repo),
                "instruments_sync",
                timeline_time=scheduled_time,
                timeline_name=item["task_name"],
                timeline_run_id=run_id,
            )
            return

        capset = request.app.state.capabilities
        quote_service = getattr(request.app.state, "quote_service", None)

        def run_pipeline(on_progress=None):
            try:
                if quote_service:
                    with quote_service.paused():
                        return daily_pipeline.run_now(repo, capset, on_progress=on_progress)
                return daily_pipeline.run_now(repo, capset, on_progress=on_progress)
            finally:
                repo.refresh_cache()

        await asyncio.to_thread(
            daily_pipeline._run_tracked,
            run_pipeline,
            "daily_pipeline",
            timeline_time=scheduled_time,
            timeline_name=item["task_name"],
            timeline_run_id=run_id,
        )
    except Exception as exc:
        logger.exception("timeline retry failed: method=%s run_id=%s", method, run_id)
        try:
            timeline_execution_store.finish(run_id, status="failed", error=str(exc))
        except Exception:
            logger.exception("timeline retry failure record failed: run_id=%s", run_id)


def _accept_retry(request: Request, item: dict, *, run_id: str | None = None) -> dict:
    retry_id = run_id
    if retry_id:
        if not timeline_execution_store.restart(retry_id):
            raise HTTPException(status_code=404, detail="timeline execution not found")
    else:
        retry_id = timeline_execution_store.start(
            task_name=item["task_name"],
            method=item["method"],
            scheduled_time=item["scheduled_time"],
        )
    retry_task = asyncio.create_task(_run_retry(request, item, retry_id))
    _RETRY_TASKS.add(retry_task)
    retry_task.add_done_callback(_RETRY_TASKS.discard)
    return {
        "accepted": True,
        "run_id": retry_id,
        "method": item["method"],
        "scheduled_time": item["scheduled_time"],
    }


@router.get("/executions")
def list_executions(
    date: Annotated[date_type | None, Query()] = None,
    method: Annotated[str | None, Query(min_length=1, max_length=120)] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
) -> dict:
    timeline_date = date.isoformat() if date else cn_today().isoformat()
    return {
        "date": timeline_date,
        "items": timeline_execution_store.list(
            timeline_date=timeline_date,
            method=method,
            limit=limit,
        ),
    }


@router.post("/executions/retry")
async def retry_method(payload: TimelineRetryRequest, request: Request) -> dict:
    method = payload.method.strip()
    if method not in RETRYABLE_METHODS:
        raise HTTPException(status_code=400, detail=f"定时器方法不支持重试: {method}")
    return _accept_retry(request, {
        "task_name": payload.task_name.strip() or method,
        "method": method,
        "scheduled_time": payload.scheduled_time,
    })


@router.post("/executions/{run_id}/retry")
async def retry_execution(run_id: str, request: Request) -> dict:
    item = timeline_execution_store.get(run_id)
    if not item:
        raise HTTPException(status_code=404, detail="timeline execution not found")
    method = item["method"]
    if method not in RETRYABLE_METHODS:
        raise HTTPException(status_code=400, detail=f"定时器方法不支持重试: {method}")
    return _accept_retry(request, item, run_id=run_id)
