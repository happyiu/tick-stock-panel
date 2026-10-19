"""时间轴配置及交易日内按时间点分发。"""
from __future__ import annotations

import asyncio
import logging
from typing import Literal

from apscheduler.triggers.cron import CronTrigger
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.market_time import cn_now
from app.services import preferences, trading_day

logger = logging.getLogger(__name__)
TimerMethod = Literal['seekhub_daily_start', 'seekhub_daily_decision']


class TimelinePoint(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    id: int
    time: str = Field(pattern=r'^(?:[01]\d|2[0-3]):[0-5]\d$')
    description: str = Field(default='', max_length=200)
    timerMethod: Literal['', 'seekhub_daily_start', 'seekhub_daily_decision'] = ''  # noqa: N815 - browser contract


class TimelineSettings(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    stepMinutes: Literal[5, 15, 30, 60] = 15  # noqa: N815 - browser contract
    timerMethods: list[TimerMethod] = Field(default_factory=list, max_length=2)  # noqa: N815 - browser contract
    customPoints: list[TimelinePoint] = Field(default_factory=list, max_length=100)  # noqa: N815 - browser contract


def get_settings() -> dict | None:
    saved = preferences.load().get('timeline_schedule')
    if saved is None:
        return None
    try:
        return TimelineSettings.model_validate(saved).model_dump()
    except ValidationError:
        logger.warning('invalid timeline schedule; tasks disabled')
        return None


def save_settings(config: TimelineSettings, prompts: dict[str, str] | None = None) -> dict:
    value = config.model_dump()
    updates = {'timeline_schedule': value}
    if prompts:
        saved_prompts = preferences.get_seekhub_daily_prompts()
        saved_prompts.update(prompts)
        updates['seekhub_daily_prompts'] = saved_prompts
    preferences.save(updates)
    return value


async def run_due() -> None:
    from app.jobs import daily_pipeline

    config = get_settings()
    if not config:
        return
    now = cn_now()
    if now.weekday() >= 5:
        return
    minutes = now.hour * 60 + now.minute
    scheduled_time = now.strftime('%H:%M')
    methods = []
    for start, end in ((570, 690), (780, 900)):
        if start <= minutes <= end and (minutes - start) % config['stepMinutes'] == 0:
            methods.extend(config['timerMethods'])
    methods.extend(point['timerMethod'] for point in config['customPoints']
                   if point['time'] == scheduled_time and point['timerMethod'])
    if not methods or await asyncio.to_thread(trading_day.is_trading_day, now) is False:
        return
    for method in dict.fromkeys(methods):
        try:
            await getattr(daily_pipeline, method)(scheduled_time=scheduled_time)
        except Exception:
            logger.exception('timeline method failed: %s', method)


def register(scheduler) -> None:
    scheduler.add_job(
        run_due, trigger=CronTrigger(second=0, timezone='Asia/Shanghai'),
        id='timeline_tasks', replace_existing=True, coalesce=True,
        max_instances=1, misfire_grace_time=30,
    )
