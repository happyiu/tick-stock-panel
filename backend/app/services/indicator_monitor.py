"""Independent candle/formula monitoring with a durable event outbox."""
# ruff: noqa: RUF001
from __future__ import annotations

import hashlib
import json
import logging
import math
import re
import sqlite3
import threading
import uuid
import zlib
from contextlib import contextmanager
from datetime import datetime, time, timedelta
from pathlib import Path
from time import monotonic

from app.indicators import chart_catalog
from app.indicators.chart_formula import compile_formula, evaluate
from app.market_time import cn_now
from app.services.fs_utils import atomic_write_text

logger = logging.getLogger(__name__)
CHANNELS = {'system', 'feishu', 'wecom', 'custom', 'email'}


def bar_end(row, period):
    value = str(row['date']).replace('T', ' ')
    return value[:16] if period == '30m' else value[:10]+' 15:00'


class IndicatorMonitorService:
    def __init__(self, data_dir, *, loader=None, sender=None, capability=None, publisher=None, formatter=None):
        self.data_dir = Path(data_dir)
        self.directory = self.data_dir / 'user_data'
        if self.directory.is_symlink():
            raise ValueError('运行数据目录不能使用符号链接')
        self.directory.mkdir(parents=True, exist_ok=True)
        self.rules_path = self.directory / 'indicator_monitors.json'
        self.db_path = self.directory / 'indicator_monitor.sqlite3'
        if self.rules_path.is_symlink() or self.db_path.is_symlink():
            raise ValueError('指标监控文件不能使用符号链接')
        self.lock = threading.RLock()
        self.loader = loader
        self.sender = sender
        self.capability = capability or (lambda rule: '尚未连接数据服务')
        self.publisher = publisher
        self.formatter = formatter
        self.stop_event = threading.Event()
        self.threads = []
        self.delivery_lock = threading.Lock()
        with self.db() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS runtime (rule_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS events (
                    event_id TEXT PRIMARY KEY, rule_id TEXT NOT NULL, ts INTEGER NOT NULL, payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS deliveries (
                    event_id TEXT NOT NULL, channel TEXT NOT NULL, status TEXT NOT NULL,
                    PRIMARY KEY(event_id,channel));
                CREATE TABLE IF NOT EXISTS seen (event_id TEXT PRIMARY KEY, ts INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, payload BLOB NOT NULL);
                CREATE INDEX IF NOT EXISTS events_time ON events(ts);
            ''')

    @contextmanager
    def db(self):
        with self.lock:
            connection = sqlite3.connect(self.db_path, timeout=10)
            try:
                with connection:
                    yield connection
            finally:
                connection.close()

    def rules(self):
        with self.lock:
            if not self.rules_path.exists():
                return []
            value = json.loads(self.rules_path.read_text())
            if not isinstance(value, list):
                raise ValueError('指标监控配置损坏')
            return value

    def _write_rules(self, rules):
        atomic_write_text(self.rules_path, json.dumps(rules, ensure_ascii=False, indent=2))

    @staticmethod
    def _state(db, key):
        row = db.execute('SELECT payload FROM runtime WHERE rule_id=?', (key,)).fetchone()
        return json.loads(row[0]) if row else {}

    @staticmethod
    def _put_state(db, key, state):
        db.execute('INSERT OR REPLACE INTO runtime VALUES (?,?)', (key, json.dumps(state, ensure_ascii=False)))

    def get(self, key):
        rule = next((r for r in self.rules() if r['id'] == key), None)
        if rule is None:
            raise KeyError('监控规则不存在')
        with self.db() as db:
            state = self._state(db, key)
        state.pop('snapshot', None)
        state.pop('input_rows', None)
        needs_update = state.get('status') in {'context_changed', 'version_changed'}
        return {**rule, **state, 'needs_update': needs_update, 'status': state.get('status', 'waiting') if rule['enabled'] else 'paused'}

    def list(self):
        return [self.get(rule['id']) for rule in self.rules()]

    def save(self, payload, key=None):
        with self.lock:
            rules = self.rules()
            previous = next((r for r in rules if r['id'] == key), None)
            if key and previous is None:
                raise KeyError('监控规则不存在')
            item = chart_catalog.get_indicator(self.data_dir, payload['indicator_id'])
            if item.get('source') != 'custom':
                raise ValueError('仅支持自建指标')
            period = payload.get('period', '30m')
            signal_ids = list(dict.fromkeys(payload.get('signal_ids', [])))
            available = {s['id'] for s in item.get('monitor_signals', []) if period in s['periods']}
            if not signal_ids or not set(signal_ids) <= available:
                raise ValueError('请选择适用于当前周期的监控信号')
            rule = {field: payload.get(field, default) for field, default in (
                ('symbol', ''), ('asset_type', 'stock'), ('indicator_id', ''), ('period', '30m'),
                ('mode', 'both'), ('channels', []), ('enabled', True), ('compare_days', 1))}
            if rule['asset_type'] not in {'stock', 'etf'} or period not in {'30m', '1d'}:
                raise ValueError('仅支持股票、ETF的30f和日线')
            if not isinstance(rule['symbol'], str) or not re.fullmatch(r'\d{6}\.(SH|SZ|BJ)', rule['symbol']):
                raise ValueError('请选择有效标的')
            if rule['mode'] not in {'preview', 'confirmed', 'both'} or not set(rule['channels']) <= CHANNELS:
                raise ValueError('触发方式或通知渠道非法')
            if type(rule['compare_days']) is not int or not 1 <= rule['compare_days'] <= 20:
                raise ValueError('量能对比周期需要1～20')
            duplicate = next((r for r in rules if r['id'] != key and all(r[f] == rule[f] for f in ('symbol', 'indicator_id', 'period'))), None)
            if duplicate:
                raise ValueError('相同标的、指标和周期的监控已存在')
            fingerprint = chart_catalog.calculation_fingerprint(item)
            same_indicator = previous is not None and previous['indicator_id'] == rule['indicator_id']
            if same_indicator and rule['enabled'] and fingerprint != previous['fingerprint']:
                raise ValueError('指标版本已变化，请先采用新版本')
            if previous and rule['enabled']:
                with self.db() as db:
                    if self._state(db, key).get('status') == 'context_changed':
                        raise ValueError('数据口径版本已变化，请先重建上下文')
            if rule['enabled']:
                reason = self.capability(rule)
                if reason:
                    raise ValueError(reason)
            reset = previous is None or (rule['enabled'] and not previous['enabled']) or any(
                rule[f] != previous[f] for f in ('symbol', 'asset_type', 'indicator_id', 'period', 'compare_days', 'mode')
            ) or (previous is not None and signal_ids != previous['signal_ids'])
            rule.update(id=key or f'im-{uuid.uuid4().hex}', signal_ids=signal_ids,
                        generation=(previous['generation'] if previous else 0) + int(reset),
                        fingerprint=previous['fingerprint'] if same_indicator else fingerprint,
                        definition=previous['definition'] if same_indicator else item)
            self._write_rules([r for r in rules if r['id'] != key]+[rule])
            if reset:
                with self.db() as db:
                    self._put_state(db, rule['id'], {'status': 'version_changed' if same_indicator and fingerprint != previous['fingerprint'] else 'waiting'})
            return self.get(rule['id'])

    def delete(self, key):
        with self.lock:
            self.get(key)
            self._write_rules([r for r in self.rules() if r['id'] != key])

    def adopt(self, key):
        with self.lock:
            rule = self.get(key)
            item = chart_catalog.get_indicator(self.data_dir, rule['indicator_id'])
            rule['fingerprint'] = chart_catalog.calculation_fingerprint(item)
            rule['definition'] = item
            rule['generation'] += 1
            rule['signal_ids'] = [s for s in rule['signal_ids'] if any(
                v['id'] == s and rule['period'] in v['periods'] for v in item.get('monitor_signals', []))]
            if not rule['signal_ids']:
                raise ValueError('新版本已移除选中信号，请编辑规则重新选择')
            reason = self.capability(rule)
            if reason:
                raise ValueError(reason)
            rule['enabled'] = True
            original = next(r for r in self.rules() if r['id'] == key)
            clean = {k: rule[k] for k in original}
            self._write_rules([clean if r['id'] == key else r for r in self.rules()])
            with self.db() as db:
                self._put_state(db, key, {'status': 'waiting'})
            return self.get(key)

    def _status(self, key, status, reason, now):
        with self.db() as db:
            state = self._state(db, key)
            state.update(status=status, reason=reason, last_checked=now.isoformat())
            self._put_state(db, key, state)

    def evaluate(self, key, snapshot, now=None, evaluation_cache=None):
        now = now or cn_now()
        if self.stop_event.is_set():
            return
        rule = self.get(key)
        if not rule['enabled']:
            return
        try:
            item = chart_catalog.get_indicator(self.data_dir, rule['indicator_id'])
        except chart_catalog.CatalogError:
            self._status(key, 'version_changed', '指标已删除或无法加载，请更新规则', now)
            return
        if chart_catalog.calculation_fingerprint(item) != rule['fingerprint']:
            self._status(key, 'version_changed', '指标已修改，请确认采用新版本', now)
            return
        rows = snapshot.get('rows', [])
        if snapshot.get('stale') or not rows:
            self._status(key, 'waiting', snapshot.get('reason') or '等待有效K线数据', now)
            return
        with self.db() as db:
            state = self._state(db, key)
        context = snapshot.get('source_context', '')
        if state.get('source_context') and state['source_context'] != context:
            self._status(key, 'context_changed', '数据源或复权口径变化，请重建上下文', now)
            return
        if state.get('status') in {'context_changed', 'version_changed'}:
            return
        if state.get('calc_start'):
            previous_rows = state.get('input_rows') or state.get('snapshot', {}).get('rows', [])
            if snapshot.get('adjustment') == 'none' and previous_rows:
                # Raw prices keep their basis across days; bridge bounded provider windows only with overlap.
                overlap = {str(r['date']) for r in previous_rows} & {str(r['date']) for r in rows}
                if overlap:
                    by_date = {str(r['date']): r for r in previous_rows}
                    by_date.update({str(r['date']): r for r in rows})
                    rows = [by_date[key] for key in sorted(by_date)]
            rows = [r for r in rows if str(r['date']) >= state['calc_start']]
            if not rows or str(rows[0]['date']) != state['calc_start']:
                self._status(key, 'waiting', '固定计算起点的历史数据缺失', now)
                return
        else:
            rows = rows[-500:]
        if len(rows) < item.get('min_history_bars', 100):
            with self.db() as db:
                state.update(calc_start=str(rows[0]['date']), source_context=context, input_rows=rows)
                self._put_state(db, key, state)
            self._status(key, 'history_short', '历史不足，等待更多K线', now)
            return
        if len(rows) > 20000:
            raise ValueError('超过20000根计算上限，请重建监控上下文')
        input_key = json.dumps([{k: r.get(k) for k in ('date', 'open', 'high', 'low', 'close', 'volume', 'amount')} for r in rows], sort_keys=True)
        cache_key = (item['formula'], rule['period'], rule['compare_days'], input_key)
        computed = evaluation_cache.get(cache_key) if evaluation_cache is not None else None
        if computed is None:
            computed = evaluate(compile_formula(item['formula']), rows, rule['period'], rule['compare_days'])
            if evaluation_cache is not None:
                if len(evaluation_cache) >= 8:
                    evaluation_cache.clear()
                evaluation_cache[cache_key] = computed
        closed = [bar_end(r, rule['period']) for r in rows if r.get('is_closed')]
        initial = not state.get('initialized')
        baseline = state.get('last_closed', '') if not initial else max(closed, default='')
        today = now.date().isoformat()
        created = []
        with self.db() as db:
            # A concurrent edit must not commit results from an obsolete generation.
            latest = next((r for r in self.rules() if r['id'] == key), None)
            if self.stop_event.is_set() or latest is None or not latest['enabled'] or latest['generation'] != rule['generation']:
                return
            unavailable = False
            for index, (row, values) in enumerate(zip(rows, computed['rows'], strict=True)):
                end = bar_end(row, rule['period'])
                if not end.startswith(today):
                    continue
                is_closed = row.get('is_closed') is True
                if is_closed and end <= baseline:
                    continue
                if not is_closed and (index != len(rows)-1 or row.get('is_fresh') is False or end <= now.strftime('%Y-%m-%d %H:%M')):
                    continue
                phase = 'confirmed' if is_closed else 'preview'
                for signal in item.get('monitor_signals', []):
                    if signal['id'] not in rule['signal_ids']:
                        continue
                    value = values.get(signal['variable'])
                    if value is None or not math.isfinite(value):
                        unavailable = True
                        continue
                    base_id = f"{key}:{rule['generation']}:{signal['id']}:{end}"
                    preview_id = hashlib.sha256((base_id+':preview').encode()).hexdigest()
                    if is_closed:
                        old = db.execute('SELECT payload FROM events WHERE event_id=?', (preview_id,)).fetchone()
                        if old:
                            event = json.loads(old[0])
                            event['confirmation'] = 'confirmed' if value != 0 else 'unconfirmed'
                            db.execute('UPDATE events SET payload=? WHERE event_id=?', (json.dumps(event, ensure_ascii=False), preview_id))
                    if value == 0 or rule['mode'] not in {phase, 'both'}:
                        continue
                    event_id = hashlib.sha256((base_id+':'+phase).encode()).hexdigest()
                    label = '盘中未确认' if phase == 'preview' else '收盘已确认'
                    delayed = is_closed and now.replace(tzinfo=None) - datetime.fromisoformat(end) > timedelta(minutes=2)
                    message = f"{item['name']} · {'30f' if rule['period'] == '30m' else '日线'} · {signal['name']} · {end} · {label}"
                    if delayed:
                        message += '（延迟确认）'
                    event = dict(event_id=event_id, rule_id=key, generation=rule['generation'], source='indicator', type=phase,
                                 symbol=rule['symbol'], asset_type=rule['asset_type'], indicator_id=item['id'],
                                 indicator_name=item['name'], period=rule['period'], signal_id=signal['id'],
                                 signal_name=signal['name'], phase=phase, bar_end=end, price=row.get('close'),
                                 ts=int(now.timestamp()*1000), message=message, delayed=delayed,
                                 confirmation='pending' if phase == 'preview' else 'confirmed')
                    inserted = db.execute('INSERT OR IGNORE INTO seen VALUES (?,?)', (event_id, event['ts'])).rowcount
                    if inserted:
                        if self.formatter:
                            try:
                                formatted = self.formatter(dict(event))
                                if isinstance(formatted, str):
                                    event['message'] = formatted
                            except Exception:
                                logger.warning('indicator notification formatter failed')
                        frozen = dict(rows=rows[:index+1], definition=item, compare_days=rule['compare_days'],
                                      symbol=rule['symbol'], asset_type=rule['asset_type'], period=rule['period'])
                        raw_snapshot = json.dumps(frozen, ensure_ascii=False).encode()
                        event['snapshot_id'] = hashlib.sha256(raw_snapshot).hexdigest()
                        db.execute('INSERT OR IGNORE INTO snapshots VALUES (?,?)', (event['snapshot_id'], zlib.compress(raw_snapshot)))
                        db.execute('INSERT INTO events VALUES (?,?,?,?)',
                                   (event_id, key, event['ts'], json.dumps(event, ensure_ascii=False)))
                        for channel in rule['channels']:
                            db.execute('INSERT INTO deliveries VALUES (?,?,?)', (event_id, channel, 'pending'))
                        created.append(event)
            gaps = [bar_end(r, rule['period']) for r in rows if not r.get('is_closed') and baseline < bar_end(r, rule['period']) <= now.strftime('%Y-%m-%d %H:%M')]
            complete_before_gap = [end for end in closed if not gaps or end < min(gaps)]
            state.update(initialized=True, calc_start=str(rows[0]['date']), source_context=context,
                         last_closed=max(complete_before_gap, default=baseline) if not unavailable else baseline,
                         status='waiting' if unavailable else 'running',
                         reason='信号尚不可计算' if unavailable else '', last_checked=now.isoformat(),
                         data_through=snapshot.get('data_through'), snapshot=dict(rows=rows, definition=item, compare_days=rule['compare_days'],
                                                                                symbol=rule['symbol'], asset_type=rule['asset_type'], period=rule['period']))
            state.pop('input_rows', None)
            self._put_state(db, key, state)
            # Retain the same seven-day history as existing monitoring. Cursors are independent.
            cutoff = int((now-timedelta(days=7)).timestamp()*1000)
            db.execute('DELETE FROM deliveries WHERE event_id IN (SELECT event_id FROM events WHERE ts<?)', (cutoff,))
            db.execute('DELETE FROM events WHERE ts<?', (cutoff,))
            db.execute('DELETE FROM seen WHERE ts<?', (cutoff,))
            db.execute('DELETE FROM events WHERE event_id NOT IN (SELECT event_id FROM events ORDER BY ts DESC LIMIT 5000)')
            db.execute('DELETE FROM deliveries WHERE event_id NOT IN (SELECT event_id FROM events)')
            db.execute("DELETE FROM snapshots WHERE id NOT IN (SELECT json_extract(payload,'$.snapshot_id') FROM events)")
        self._publish(key, created)

    def _publish(self, key, created=None):
        from app.services.events import bus
        try:
            bus.publish('indicator_monitor_updated', {'rule_id': key}, scope='read:analysis')
            if self.publisher:
                self.publisher(key, [{k: v for k, v in event.items() if k != 'snapshot_id'} for event in (created or [])])
        except Exception:
            logger.warning('indicator event broadcast failed; durable records retained')

    def events(self):
        with self.db() as db:
            events = [json.loads(row[0]) for row in db.execute('SELECT payload FROM events ORDER BY ts DESC LIMIT 5000')]
            for event in events:
                event.pop('snapshot', None)
                event.pop('snapshot_id', None)
                event['deliveries'] = dict(db.execute('SELECT channel,status FROM deliveries WHERE event_id=?', (event['event_id'],)))
            return events

    def clear_events(self):
        with self.db() as db:
            db.execute('DELETE FROM events')
            db.execute('DELETE FROM deliveries')
            db.execute('DELETE FROM snapshots')

    def retry(self, event_id):
        with self.db() as db:
            db.execute("UPDATE deliveries SET status='pending' WHERE event_id=? AND status='failed'", (event_id,))

    def snapshot(self, key, event_id=None):
        with self.db() as db:
            if event_id:
                row = db.execute('SELECT payload FROM events WHERE rule_id=? AND event_id=?', (key, event_id)).fetchone()
                if not row:
                    raise KeyError('触发记录不存在或已清除')
                snapshot_id = json.loads(row[0])['snapshot_id']
                compressed = db.execute('SELECT payload FROM snapshots WHERE id=?', (snapshot_id,)).fetchone()
                if not compressed:
                    raise KeyError('触发快照不存在')
                return json.loads(zlib.decompress(compressed[0]))
            state = self._state(db, key)
            if 'snapshot' not in state:
                raise ValueError('等待首次有效计算')
            return state['snapshot']

    def deliver(self):
        if self.sender is None or not self.delivery_lock.acquire(blocking=False):
            return
        try:
            with self.db() as db:
                jobs = list(db.execute("SELECT d.event_id,d.channel,e.payload FROM deliveries d JOIN events e USING(event_id) WHERE d.status='pending' LIMIT 100"))
            for event_id, channel, payload in jobs:
                if self.stop_event.is_set():
                    break
                event = json.loads(payload)
                event.pop('snapshot', None)
                try:
                    success = self.sender(event, channel)
                except Exception:
                    success = False
                    logger.warning('indicator notification failed (%s)', channel)
                with self.db() as db:
                    db.execute('UPDATE deliveries SET status=? WHERE event_id=? AND channel=?',
                               ('sent' if success else 'failed', event_id, channel))
                self._publish(event['rule_id'])
        finally:
            self.delivery_lock.release()

    def tick(self, now=None):
        from app.services import trading_day
        now = now or cn_now()
        self.expire_pending(now)
        rules = [r for r in self.rules() if r['enabled']]
        if not rules:
            return
        if now.weekday() >= 5 or trading_day.is_trading_day() is False:
            return
        if not time(9, 30) <= now.time() < time(15, 31):
            return
        cache = {}
        evaluation_cache = {}
        for rule in rules:
            if not rule['enabled'] or self.stop_event.is_set():
                continue
            try:
                reason = self.capability(rule)
                if reason:
                    self._status(rule['id'], 'capability_missing', reason, now)
                    continue
                current = self.get(rule['id'])
                if current.get('status') in {'version_changed', 'context_changed'}:
                    continue
                if not self.loader:
                    continue
                group = (rule['symbol'], rule['asset_type'], rule['period'], current.get('calc_start'))
                if group not in cache:
                    cache[group] = self.loader(current, now)
                self.evaluate(rule['id'], cache[group], now, evaluation_cache)
            except Exception as exc:
                logger.warning('indicator monitor evaluation failed (%s)', type(exc).__name__)
                self._status(rule['id'], 'error', '计算失败，请检查公式、数据或计算上限', now)

    def expire_pending(self, now):
        today = now.date().isoformat()
        with self.db() as db:
            for event_id, payload in list(db.execute("SELECT event_id,payload FROM events WHERE json_extract(payload,'$.confirmation')='pending'")):
                event = json.loads(payload)
                if event['bar_end'][:10] < today or (event['bar_end'].startswith(today) and now.time() >= time(15, 30)):
                    event['confirmation'] = 'missing_data'
                    db.execute('UPDATE events SET payload=? WHERE event_id=?', (json.dumps(event, ensure_ascii=False), event_id))

    def start(self):
        if self.threads:
            return
        def run(action, interval):
            while not self.stop_event.is_set():
                started = monotonic()
                try:
                    action()
                except Exception:
                    logger.exception('indicator monitor worker failed')
                self.stop_event.wait(max(0, interval-(monotonic()-started)))
        self.threads = [threading.Thread(target=run, args=(self.tick, 60), daemon=True, name='indicator-monitor'),
                        threading.Thread(target=run, args=(self.deliver, 2), daemon=True, name='indicator-delivery')]
        for worker in self.threads:
            worker.start()

    def stop(self):
        self.stop_event.set()
        for worker in self.threads:
            worker.join(timeout=2)
