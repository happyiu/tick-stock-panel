"""Bounded full-catalog daily CZSC scans; snapshots never alter market data."""
# ruff: noqa: RUF001
from __future__ import annotations

import calendar
import hashlib
import json
import logging
import os
import threading
import time
from datetime import date, timedelta

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from app.market_time import cn_now
from app.services import preferences, trading_day
from app.services.chanlun import (
    ENGINE_CONFIG,
    ENGINE_VERSION,
    analyze_chanlun,
    analyze_daily_observation,
)
from app.services.chart_candles import chart_snapshot, latest_live_candle
from app.services.etf_pool import etf_catalog
from app.services.heavy_job_limiter import (
    HeavyJobCancelledError,
    HeavyJobLimitTimeoutError,
    shared_heavy_job_limiter,
)
from app.services.pipeline_jobs import JobCancelledError, JobStore


def window_start(end):
    year = end.year - 2
    return end.replace(year=year, day=min(end.day, calendar.monthrange(year, end.month)[1]))


def active_signals(analysis, member, day, dates):
    recent = dates[max(0, dates.index(day) - 4):dates.index(day) + 1]
    result = []
    for signal in analysis['candidateSignals']:
        appeared = signal['availableDate'][:10]
        if signal['status'] == 'invalidated' or appeared not in recent:
            continue
        result.append({**signal, **member, 'age': len(recent) - 1 - recent.index(appeared)})
    return result


def scan_phase(day, now):
    if day != now.date().isoformat() or now.hour >= 15:
        return 'closed'
    return 'afternoon' if (now.hour, now.minute) >= (14, 30) else 'midday'


def needs_update(snapshot, key, day, now):
    return not snapshot or snapshot.get('cache_key') != key


class StaleRadarDataError(ValueError):
    pass


class EtfRadar:
    def __init__(self, state):
        self.state = state
        self.root = state.repo.store.data_dir / 'etf_radar'
        self.jobs = JobStore(store_dir=self.root / 'jobs')
        self.lock = threading.Lock()
        self.active = None
        self.active_day = None
        self.stopping = threading.Event()
        self.scheduler = None

    def start_scheduler(self):
        if self.scheduler:
            return
        scheduler = BackgroundScheduler(timezone='Asia/Shanghai')
        for hour, minute in ((11, 30), (14, 30), (15, 0)):
            scheduler.add_job(
                self._scheduled_scan,
                trigger=CronTrigger(day_of_week='mon-fri', hour=hour, minute=minute,
                                    timezone='Asia/Shanghai'),
                id=f'etf-radar-{hour:02d}{minute:02d}',
                coalesce=True, max_instances=1, misfire_grace_time=300,
            )
        scheduler.start()
        self.scheduler = scheduler

    def stop(self):
        self.stopping.set()
        if self.scheduler:
            self.scheduler.shutdown(wait=False)
            self.scheduler = None

    def _scheduled_scan(self):
        try:
            now = cn_now()
            if self.stopping.is_set() or not preferences.get_realtime_quotes_enabled() or self.active:
                return
            current = self.read()
            if current['date'] == now.date().isoformat() and current['needs_update']:
                self.start()
        except Exception:
            logging.getLogger(__name__).warning('ETF radar scheduled scan failed', exc_info=False)

    def candles(self, symbol, asset, start, end, force=False):
        snapshot = chart_snapshot(self.state, symbol, asset, '1d', start, end,
                                  max_age_seconds=0 if force else None)
        frame = snapshot.frame
        if frame.is_empty():
            frame = self.state.repo.get_daily_asset(asset, symbol, start, end,
                                                    columns=['date', 'open', 'high', 'low', 'close', 'volume', 'amount'])
        elif snapshot.stale:
            raise StaleRadarDataError('展示行情已陈旧')
        if 'date' in frame.columns:
            frame = frame.sort('date')
        rows = [{**r, 'date': str(r['date'])[:10], 'is_closed': True}
                for r in frame.to_dicts() if str(r['date'])[:10] <= end.isoformat()]
        now = cn_now()
        if end == now.date() and now.hour < 15:
            live = latest_live_candle(self.state, symbol, asset, refresh_asset=False, today=now.date())
            if live:
                rows = [r for r in rows if r['date'] != end.isoformat()] + [live]
            for row in rows:
                if row['date'] == end.isoformat():
                    row['is_closed'] = False
        return rows

    def context(self, requested=None):
        now = cn_now()
        end = now.date() if now.hour >= 15 or ((now.hour, now.minute) >= (11, 30) and preferences.get_realtime_quotes_enabled()) else now.date() - timedelta(days=1)
        bars = self.candles('000001.SH', 'index', end - timedelta(days=90), end)
        dates = sorted({r['date'] for r in bars})
        if not dates:
            raise ValueError('上证指数交易日数据不可用，请先同步行情')
        today = now.date().isoformat()
        if today not in dates and (requested == today or requested is None):
            trading = trading_day.is_trading_day(now)
            if (trading is True and end == now.date()) or (requested == today and trading is not False):
                dates.append(today)
        if requested and requested not in dates[-10:]:
            raise ValueError('请选择最近10个可用交易日')
        day = requested or dates[-1]
        members = etf_catalog(self.state.repo).sort('symbol').to_dicts()
        intraday = day == now.date().isoformat() and now.hour < 15
        signature = json.dumps([3, members, day, scan_phase(day, now), preferences.get_chart_data_provider(), preferences.get_realtime_data_provider(),
                                None if intraday else self.state.repo.get_matrix_data_generation('etf'),
                                None if intraday else self.state.repo.get_matrix_data_generation('index'),
                                ENGINE_VERSION, ENGINE_CONFIG], sort_keys=True, default=str)
        key = hashlib.sha256(signature.encode()).hexdigest()
        return day, dates, members, key

    def read(self, requested=None):
        day, dates, members, key = self.context(requested)
        path = self.root / f'{day}.json'
        try:
            snapshot = json.loads(path.read_text())
        except (OSError, ValueError):
            snapshot = None
        return dict(date=day, dates=dates[-10:][::-1], snapshot=snapshot,
                    needs_update=needs_update(snapshot, key, day, cn_now()),
                    total=len(members), job_id=self.active, job_date=self.active_day)

    def start(self, requested=None, force=False):
        with self.lock:
            if self.active:
                return {'job_id': self.active, 'date': self.active_day}
        day, dates, members, key = self.context(requested)
        with self.lock:
            if self.active:
                return {'job_id': self.active, 'date': self.active_day}
            job_id, fresh = self.jobs.create()
            self.active = job_id
            self.active_day = day
            if fresh:
                threading.Thread(target=self.run, args=(job_id, day, dates, members, key, force), daemon=True).start()
            return {'job_id': job_id, 'date': day}

    def run(self, job_id, day, dates, members, key, force):
        started = time.monotonic()
        try:
            self.jobs.start(job_id)
            end = date.fromisoformat(day)
            start = window_start(end)
            counts = dict(ready=0, missing=0, stale=0, insufficient=0, failed=0)
            signals, failures = [], []
            mode = 'intraday' if day == cn_now().date().isoformat() and cn_now().hour < 15 else 'closed'
            for i, member in enumerate(members):
                if self.stopping.is_set():
                    raise JobCancelledError(job_id)
                try:
                    rows = self.candles(member['symbol'], 'etf', start, end, force)
                    if not rows:
                        counts['missing'] += 1
                    elif rows[-1]['date'] != day:
                        counts['stale'] += 1
                    else:
                        self.jobs.progress(job_id, 'waiting', int(100 * i / len(members)),
                                           f'等待其他计算任务完成，已完成 {i}/{len(members)}', skip_log=True)
                        # Network I/O must not reserve memory-heavy calculation capacity.
                        wait_s = self.jobs.get(job_id)['timeout_s']
                        with shared_heavy_job_limiter.slot('normal', timeout=wait_s, cancel_event=self.stopping):
                            analysis = (analyze_daily_observation(rows, as_of=day)
                                        if any(r.get('is_closed') is False for r in rows)
                                        else analyze_chanlun(rows, as_of=day))
                        status = analysis['status']
                        if status == 'ready':
                            counts['ready'] += 1
                            signals.extend(active_signals(analysis, member, day, dates))
                        elif status == 'insufficient':
                            counts['insufficient'] += 1
                        else:
                            raise ValueError('；'.join(analysis['issues']))
                except (HeavyJobLimitTimeoutError, HeavyJobCancelledError):
                    raise
                except StaleRadarDataError:
                    counts['stale'] += 1
                except Exception:
                    counts['failed'] += 1
                    failures.append(dict(symbol=member['symbol'], message='行情读取或CZSC计算失败，请检查数据源与后端依赖'))
                self.jobs.progress(job_id, 'scan', int(100 * (i + 1) / len(members)),
                                   f'已完成 {i + 1}/{len(members)}', skip_log=True)
            if not counts['ready'] and members:
                raise ValueError('全池暂无有效分析结果，请检查行情覆盖与CZSC依赖')
            signals.sort(key=lambda s: (s['symbol'], s['variant']))
            signals.sort(key=lambda s: s['availableDate'], reverse=True)
            result = dict(mode=mode, date=day, range=dict(start=start.isoformat(), end=day), cache_key=key,
                          scan_seconds=round(time.monotonic() - started, 3),
                          rule_version=4, computed_at=cn_now().isoformat(), total=len(members),
                          counts=counts, signals=signals, failures=failures,
                          buy_count=len({s['symbol'] for s in signals if s['variant'].startswith('B')}),
                          sell_count=len({s['symbol'] for s in signals if s['variant'].startswith('S')}))
            path = self.root / f'{day}.json'
            tmp = path.with_suffix('.tmp')
            tmp.write_text(json.dumps(result, ensure_ascii=False))
            os.replace(tmp, path)
            self.jobs.succeed(job_id, result)
        except HeavyJobCancelledError:
            self.jobs.fail(job_id, '雷达服务已停止，扫描中断')
        except HeavyJobLimitTimeoutError:
            self.jobs.fail(job_id, '等待其他计算任务完成超时，请稍后重试；如持续出现，请检查正在运行的计算任务')
        except (Exception, JobCancelledError) as exc:
            self.jobs.fail(job_id, str(exc))
        finally:
            with self.lock:
                self.active = None
                self.active_day = None


_INIT_LOCK = threading.Lock()


def get_radar(state):
    with _INIT_LOCK:
        if not hasattr(state, 'etf_radar'):
            state.etf_radar = EtfRadar(state)
        return state.etf_radar
