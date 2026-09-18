"""Exchange-rate interval scheduler regression test."""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.api.settings import ExchangeRateScheduleIn
from app.jobs import daily_pipeline


class _Scheduler:
    def __init__(self):
        self.kwargs = None

    def add_job(self, _func, **kwargs):
        self.kwargs = kwargs


def test_exchange_rate_job_uses_hour_interval():
    scheduler = _Scheduler()

    daily_pipeline._register_exchange_rate_job(scheduler, object(), 3)

    assert scheduler.kwargs["id"] == daily_pipeline.EXCHANGE_RATE_JOB_ID
    assert scheduler.kwargs["trigger"].interval.total_seconds() == 3 * 60 * 60


def test_exchange_rate_schedule_api_rejects_zero_hours():
    with pytest.raises(ValidationError):
        ExchangeRateScheduleIn(interval_hours=0)
