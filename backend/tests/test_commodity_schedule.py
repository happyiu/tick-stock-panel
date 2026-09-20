"""Commodity scheduler regression tests."""
from __future__ import annotations

from app.jobs import daily_pipeline


class _Scheduler:
    def __init__(self):
        self.kwargs = None

    def add_job(self, _func, **kwargs):
        self.kwargs = kwargs


def test_commodity_job_runs_daily():
    scheduler = _Scheduler()
    daily_pipeline._register_commodity_job(scheduler, object())
    assert scheduler.kwargs["id"] == daily_pipeline.COMMODITY_JOB_ID
    assert scheduler.kwargs["trigger"].interval.total_seconds() == 24 * 60 * 60
