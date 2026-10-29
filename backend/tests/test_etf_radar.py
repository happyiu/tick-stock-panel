from datetime import date
from types import SimpleNamespace

from app.services.etf_radar import EtfRadar, active_signals, window_start


def test_age_uses_market_sessions_and_first_observation():
    dates = ['2026-09-30', '2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14']
    def signal(day, status='candidate'):
        return dict(availableDate=day, structureDate='2026-09-01', status=status)
    analysis = dict(candidateSignals=[signal(dates[0]), signal(dates[1]), signal(dates[-1]), signal(dates[-1], 'invalidated')])
    result = active_signals(analysis, dict(symbol='ETF'), dates[-1], dates)
    assert [s['age'] for s in result] == [4, 0]
    assert all(s['symbol'] == 'ETF' for s in result)
    assert window_start(date(2024, 2, 29)) == date(2022, 2, 28)


def test_partial_failure_publishes_and_all_failure_preserves_snapshot(tmp_path, monkeypatch):
    import app.services.etf_radar as module
    repo = SimpleNamespace(store=SimpleNamespace(data_dir=tmp_path))
    radar = EtfRadar(SimpleNamespace(repo=repo))
    dates = ['2026-10-28']
    members = [dict(symbol='A'), dict(symbol='B')]
    monkeypatch.setattr(radar, 'candles', lambda symbol, *args: [] if symbol == 'B' else [dict(date=dates[0])])
    monkeypatch.setattr(module, 'analyze_chanlun', lambda *a, **kw: dict(status='ready', candidateSignals=[]))
    job, _ = radar.jobs.create()
    radar.run(job, dates[0], dates, members, 'key', False)
    snapshot = (radar.root / '2026-10-28.json').read_text()
    assert radar.jobs.get(job)['result']['counts'] == dict(ready=1, missing=1, stale=0, insufficient=0, failed=0)
    monkeypatch.setattr(radar, 'candles', lambda *a: [])
    job, _ = radar.jobs.create()
    radar.run(job, dates[0], dates, members, 'new', False)
    assert radar.jobs.get(job)['status'] == 'failed'
    assert (radar.root / '2026-10-28.json').read_text() == snapshot


def test_api_validation_and_job_boundary(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api.kline import router
    radar = EtfRadar(SimpleNamespace(repo=SimpleNamespace(store=SimpleNamespace(data_dir=tmp_path))))
    app = FastAPI()
    app.include_router(router)
    app.state.etf_radar = radar
    monkeypatch.setattr(radar, 'context', lambda requested: (_ for _ in ()).throw(ValueError('交易日不可用')))
    with TestClient(app) as client:
        assert client.get('/api/kline/etf-pool/radar').status_code == 422
        assert client.post('/api/kline/etf-pool/radar/scan').status_code == 422
        assert client.get('/api/kline/etf-pool/radar/jobs/invalid').status_code == 404
        assert client.get('/api/kline/etf-pool/radar/jobs/aaaaaaaaaa').status_code == 404
    radar.active = 'aaaaaaaaaa'
    assert radar.start() == {'job_id': 'aaaaaaaaaa', 'date': None}


def test_capacity_is_held_only_during_analysis_and_timeout_is_readable(tmp_path, monkeypatch):
    from contextlib import contextmanager

    import app.services.etf_radar as module
    from app.services.heavy_job_limiter import HeavyJobLimitTimeoutError
    radar = EtfRadar(SimpleNamespace(repo=SimpleNamespace(store=SimpleNamespace(data_dir=tmp_path))))
    held = False
    @contextmanager
    def slot(kind, *, timeout, cancel_event):
        nonlocal held
        assert kind == 'normal'
        assert timeout == 123
        held = True
        try:
            yield
        finally:
            held = False
    def candles(*args):
        assert not held
        return [dict(date='2026-10-28')]
    def analyze(*args, **kwargs):
        assert held
        return dict(status='ready', candidateSignals=[])
    monkeypatch.setattr(radar, 'candles', candles)
    monkeypatch.setattr(module, 'analyze_chanlun', analyze)
    monkeypatch.setattr(module.shared_heavy_job_limiter, 'slot', slot)
    job, _ = radar.jobs.create(timeout_s=123)
    radar.run(job, '2026-10-28', ['2026-10-28'], [dict(symbol='A')], 'key', False)
    assert radar.jobs.get(job)['status'] == 'succeeded'
    @contextmanager
    def unavailable(*args, **kwargs):
        raise HeavyJobLimitTimeoutError('internal English error')
        yield
    monkeypatch.setattr(module.shared_heavy_job_limiter, 'slot', unavailable)
    job, _ = radar.jobs.create(timeout_s=123)
    radar.run(job, '2026-10-28', ['2026-10-28'], [dict(symbol='A')], 'key', False)
    assert radar.jobs.get(job)['status'] == 'failed'
    assert '等待其他计算任务' in radar.jobs.get(job)['error']
    assert 'internal English' not in radar.jobs.get(job)['error']


def test_hourly_refresh_only_during_session_and_close_invalidates():
    from datetime import datetime

    from app.market_time import CN_TZ
    from app.services.etf_radar import needs_update
    snapshot = dict(cache_key='k', mode='intraday', computed_at='2026-10-29T09:40:00+08:00')
    def now(h, m):
        return datetime(2026, 10, 29, h, m, tzinfo=CN_TZ)
    assert not needs_update(snapshot, 'k', '2026-10-29', now(10, 39))
    assert not needs_update(snapshot, 'k', '2026-10-29', now(10, 40))
    assert not needs_update(snapshot, 'k', '2026-10-29', now(12, 0))
    assert not needs_update(snapshot, 'k', '2026-10-29', now(16, 0))
    assert needs_update(snapshot, 'closed-key', '2026-10-29', now(15, 1))
    assert not needs_update(snapshot, 'k', '2026-10-28', now(10, 40))


def test_intraday_observation_does_not_change_standard_confirmation(monkeypatch):
    import app.services.chanlun as module
    rows = [dict(date='2026-10-29', is_closed=False)]
    def analyze(simulated, **kwargs):
        assert simulated[0]['is_closed'] is True
        return dict(issues=[], candidateSignals=[dict(structureConfirmed=True)], bars=[dict(date='2026-10-29', isClosed=True)])
    monkeypatch.setattr(module, 'analyze_chanlun', analyze)
    result = module.analyze_daily_observation(rows)
    assert rows[0]['is_closed'] is False
    assert result['observationMode'] == 'intraday'
    assert result['candidateSignals'][0]['structureConfirmed'] is False
    assert result['candidateSignals'][0]['provisional'] is True
    assert result['bars'][0]['isClosed'] is False


def test_background_scheduler_respects_session_and_reuses_running_job(tmp_path, monkeypatch):
    from datetime import datetime

    import app.services.etf_radar as module
    from app.market_time import CN_TZ
    radar = EtfRadar(SimpleNamespace(repo=SimpleNamespace(store=SimpleNamespace(data_dir=tmp_path))))
    monkeypatch.setattr(module.preferences, 'get_realtime_quotes_enabled', lambda: True)
    calls = []
    monkeypatch.setattr(radar, 'read', lambda: dict(date='2026-10-29', needs_update=True))
    def start():
        calls.append('scan')
        radar.active = 'job'
    monkeypatch.setattr(radar, 'start', start)
    class Stop:
        def __init__(self):
            self.steps = iter([False, False, True])
        def wait(self, seconds):
            return next(self.steps)
    monkeypatch.setattr(module, 'cn_now', lambda: datetime(2026, 10, 29, 11, 30, tzinfo=CN_TZ))
    radar.stopping = Stop()
    radar._schedule()
    assert calls == ['scan']
    radar.active = None
    calls.clear()
    radar.stopping = Stop()
    monkeypatch.setattr(module, 'cn_now', lambda: datetime(2026, 10, 29, 10, 30, tzinfo=CN_TZ))
    radar._schedule()
    assert calls == []


def test_three_scan_phases_have_stable_boundaries_and_no_historical_rollover():
    from datetime import datetime

    from app.market_time import CN_TZ
    from app.services.etf_radar import scan_phase
    def phase(hour, minute):
        return scan_phase('2026-10-29', datetime(2026, 10, 29, hour, minute, tzinfo=CN_TZ))
    assert phase(11, 30) == phase(13, 30) == phase(14, 29) == 'midday'
    assert phase(14, 30) == phase(14, 59) == 'afternoon'
    assert phase(15, 0) == phase(18, 0) == 'closed'
    assert scan_phase('2026-10-28', datetime(2026, 10, 29, 14, 30, tzinfo=CN_TZ)) == 'closed'


def test_today_can_be_selected_before_daily_history_is_available(tmp_path, monkeypatch):
    from datetime import datetime

    import polars as pl
    import pytest

    import app.services.etf_radar as module
    from app.market_time import CN_TZ
    repo = SimpleNamespace(store=SimpleNamespace(data_dir=tmp_path), get_matrix_data_generation=lambda _: 'v')
    radar = EtfRadar(SimpleNamespace(repo=repo))
    monkeypatch.setattr(module, 'cn_now', lambda: datetime(2026, 10, 29, 10, 0, tzinfo=CN_TZ))
    monkeypatch.setattr(radar, 'candles', lambda *a: [dict(date='2026-10-28')])
    monkeypatch.setattr(module, 'etf_catalog', lambda _: pl.DataFrame({'symbol': ['510300.SH']}))
    monkeypatch.setattr(module.trading_day, 'is_trading_day', lambda _: True)
    assert radar.context('2026-10-29')[0] == '2026-10-29'
    assert radar.context()[0] == '2026-10-28'
    assert radar.context('2026-10-28')[0] == '2026-10-28'
    monkeypatch.setattr(module.trading_day, 'is_trading_day', lambda _: False)
    with pytest.raises(ValueError):
        radar.context('2026-10-29')
    with pytest.raises(ValueError):
        radar.context('2026-10-30')
