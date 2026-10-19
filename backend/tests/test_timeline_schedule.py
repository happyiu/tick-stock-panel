from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from pydantic import ValidationError

from app.services import preferences
from app.services import timeline_schedule as schedule


def test_config_persists_and_validates(tmp_path, monkeypatch):
    monkeypatch.setattr(preferences, '_path', lambda: tmp_path / 'prefs.json')
    preferences._invalidate_cache()
    try:
        assert schedule.get_settings() is None
        config = schedule.TimelineSettings(stepMinutes=30, timerMethods=['seekhub_daily_decision'])
        schedule.save_settings(config)
        preferences._invalidate_cache()
        assert schedule.get_settings() == config.model_dump()
        for patch in [{'stepMinutes': 7}, {'timerMethods': ['eval']},
                      {'customPoints': [{'id': 1, 'time': '25:00', 'description': '', 'timerMethod': ''}]}]:
            with pytest.raises(ValidationError):
                schedule.TimelineSettings(**patch)
    finally:
        preferences._invalidate_cache()


@pytest.mark.parametrize('time,due', [('09:29', False), ('09:30', True), ('10:00', True),
    ('10:15', False), ('11:30', True), ('12:00', False), ('13:00', True), ('15:00', True), ('15:30', False)])
@pytest.mark.asyncio
async def test_dispatch_aligned_to_sessions(time, due, monkeypatch):
    from app.jobs import daily_pipeline
    config = schedule.TimelineSettings(stepMinutes=30, timerMethods=['seekhub_daily_decision'])
    monkeypatch.setattr(schedule, 'get_settings', config.model_dump)
    now = datetime.fromisoformat(f'2026-10-19T{time}:00').replace(tzinfo=ZoneInfo('Asia/Shanghai'))
    monkeypatch.setattr(schedule, 'cn_now', lambda: now)
    monkeypatch.setattr(schedule.trading_day, 'is_trading_day', lambda now: True)
    calls = []

    async def run(**kwargs):
        calls.append(kwargs)
    monkeypatch.setattr(daily_pipeline, 'seekhub_daily_decision', run)
    await schedule.run_due()
    assert calls == ([{'scheduled_time': time}] if due else [])


@pytest.mark.asyncio
async def test_custom_dedup_holiday_and_disabled(monkeypatch):
    from app.jobs import daily_pipeline
    config = schedule.TimelineSettings(stepMinutes=30, timerMethods=['seekhub_daily_decision'], customPoints=[
        {'id': 1, 'time': '10:00', 'description': '检查', 'timerMethod': 'seekhub_daily_decision'},
    ])
    monkeypatch.setattr(schedule, 'get_settings', config.model_dump)
    monkeypatch.setattr(schedule, 'cn_now', lambda: datetime(2026, 10, 19, 10, tzinfo=ZoneInfo('Asia/Shanghai')))
    monkeypatch.setattr(schedule.trading_day, 'is_trading_day', lambda now: True)
    calls = []

    async def run(**kwargs):
        calls.append(kwargs)
    monkeypatch.setattr(daily_pipeline, 'seekhub_daily_decision', run)
    await schedule.run_due()
    assert len(calls) == 1
    monkeypatch.setattr(schedule.trading_day, 'is_trading_day', lambda now: False)
    await schedule.run_due()
    assert len(calls) == 1
    monkeypatch.setattr(schedule, 'get_settings', lambda: None)
    await schedule.run_due()
    assert len(calls) == 1


def test_api_round_trip_and_failed_save(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api.settings import router

    monkeypatch.setattr(preferences, '_path', lambda: tmp_path / 'prefs.json')
    preferences._invalidate_cache()
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    url = '/api/settings/preferences/timeline-schedule'
    payload = {'stepMinutes': 30, 'timerMethods': ['seekhub_daily_decision'], 'customPoints': [],
               'prompts': {'seekhub_daily_decision': '检查 YYYY-MM-DD'}}
    try:
        assert client.put(url, json=payload).status_code == 200
        assert schedule.get_settings()['stepMinutes'] == 30
        assert preferences.get_seekhub_daily_prompt('seekhub_daily_decision') == '检查 YYYY-MM-DD'
        assert client.put(url, json={**payload, 'stepMinutes': 7}).status_code == 422
        assert client.put(url, json={**payload, 'timerMethods': ['eval']}).status_code == 422
        assert client.put(url, json={**payload, 'prompts': {'seekhub_daily_decision': ' '}}).status_code == 400
        assert schedule.get_settings()['timerMethods'] == ['seekhub_daily_decision']
        assert client.put(url, json={**payload, 'timerMethods': []}).status_code == 200
        assert schedule.get_settings()['timerMethods'] == []
    finally:
        preferences._invalidate_cache()


def test_registration_is_async_and_coalesced():
    from inspect import iscoroutinefunction

    from apscheduler.schedulers.asyncio import AsyncIOScheduler

    scheduler = AsyncIOScheduler(timezone='Asia/Shanghai')
    schedule.register(scheduler)
    jobs = scheduler.get_jobs()
    assert len(jobs) == 1
    job = jobs[0]
    assert job.id == 'timeline_tasks'
    assert iscoroutinefunction(job.func)
    assert job.coalesce and job.max_instances == 1
    assert job.misfire_grace_time == 30
    next_time = job.trigger.get_next_fire_time(None, datetime(2026, 10, 19, 10, 0, 4, tzinfo=ZoneInfo('Asia/Shanghai')))
    assert next_time.strftime('%H:%M:%S') == '10:01:00'


@pytest.mark.asyncio
async def test_custom_point_outside_session_and_failure_isolation(monkeypatch):
    from app.jobs import daily_pipeline

    config = schedule.TimelineSettings(customPoints=[
        {'id': 1, 'time': '09:00', 'timerMethod': 'seekhub_daily_start'},
        {'id': 2, 'time': '09:00', 'timerMethod': 'seekhub_daily_decision'},
    ])
    monkeypatch.setattr(schedule, 'get_settings', config.model_dump)
    monkeypatch.setattr(schedule, 'cn_now', lambda: datetime(2026, 10, 19, 9, tzinfo=ZoneInfo('Asia/Shanghai')))
    monkeypatch.setattr(schedule.trading_day, 'is_trading_day', lambda now: None)
    calls = []

    async def fail(**kwargs):
        raise RuntimeError('unavailable')

    async def run(**kwargs):
        calls.append(kwargs)
    monkeypatch.setattr(daily_pipeline, 'seekhub_daily_start', fail)
    monkeypatch.setattr(daily_pipeline, 'seekhub_daily_decision', run)
    await schedule.run_due()
    assert calls == [{'scheduled_time': '09:00'}]


@pytest.mark.asyncio
@pytest.mark.parametrize('configured,status', [(False, 'skipped'), (True, 'failed')])
async def test_scheduled_execution_keeps_failure_and_skip_records(tmp_path, monkeypatch, configured, status):
    from app.jobs import daily_pipeline
    from app.services.timeline_execution import TimelineExecutionStore

    store = TimelineExecutionStore(tmp_path)
    monkeypatch.setattr(daily_pipeline, 'timeline_execution_store', store)
    monkeypatch.setattr(daily_pipeline, 'studio_configured', lambda: configured)
    monkeypatch.setattr(daily_pipeline._prefs, 'get_seekhub_daily_session_id', lambda day: None)
    monkeypatch.setattr(daily_pipeline._prefs, 'get_seekhub_daily_prompt', lambda method: '检查')
    monkeypatch.setattr(schedule, 'get_settings', lambda: schedule.TimelineSettings(
        stepMinutes=30, timerMethods=['seekhub_daily_decision']).model_dump())
    monkeypatch.setattr(schedule, 'cn_now', lambda: datetime(2026, 10, 19, 10, tzinfo=ZoneInfo('Asia/Shanghai')))
    monkeypatch.setattr(schedule.trading_day, 'is_trading_day', lambda now: True)

    async def fail(*args, **kwargs):
        raise RuntimeError('studio unavailable')
    monkeypatch.setattr(daily_pipeline, 'hermes_studio_run_chat', fail)
    await schedule.run_due()
    rows = store.list()
    assert len(rows) == 1
    assert rows[0]['scheduled_time'] == '10:00'
    assert rows[0]['status'] == status


@pytest.mark.asyncio
async def test_live_scheduler_reads_saved_config_after_registration(tmp_path, monkeypatch):
    import asyncio
    from datetime import timedelta

    from apscheduler.schedulers.asyncio import AsyncIOScheduler

    from app.jobs import daily_pipeline

    monkeypatch.setattr(preferences, '_path', lambda: tmp_path / 'prefs.json')
    preferences._invalidate_cache()
    monkeypatch.setattr(schedule, 'cn_now', lambda: datetime(2026, 10, 19, 10, tzinfo=ZoneInfo('Asia/Shanghai')))
    monkeypatch.setattr(schedule.trading_day, 'is_trading_day', lambda now: True)
    fired = asyncio.Event()
    calls = []

    async def run(**kwargs):
        calls.append(kwargs)
        fired.set()
    monkeypatch.setattr(daily_pipeline, 'seekhub_daily_decision', run)
    scheduler = AsyncIOScheduler(timezone='Asia/Shanghai')
    schedule.register(scheduler)
    scheduler.start()
    try:
        schedule.save_settings(schedule.TimelineSettings(stepMinutes=30, timerMethods=['seekhub_daily_decision']))
        scheduler.modify_job('timeline_tasks', next_run_time=datetime.now(ZoneInfo('Asia/Shanghai')) + timedelta(milliseconds=30))
        await asyncio.wait_for(fired.wait(), timeout=2)
        assert calls == [{'scheduled_time': '10:00'}]
    finally:
        scheduler.shutdown(wait=False)
        preferences._invalidate_cache()
