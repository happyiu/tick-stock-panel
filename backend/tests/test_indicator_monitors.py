from datetime import datetime

import pytest

from app.indicators import chart_catalog
from app.market_time import CN_TZ


def definition(tmp_path, **changes):
    payload = dict(
        name='测试信号', pane='sub', formula='hit:=CLOSE>10; 线:CLOSE;',
        monitor_signals=[dict(id='buy', name='试仓', variable='hit', periods=['30m', '1d'])],
        min_history_bars=1,
    )
    payload.update(changes)
    return chart_catalog.save_indicator(tmp_path, payload)


def test_signal_contract_and_fingerprint(tmp_path):
    item = definition(tmp_path)
    assert item['monitor_signals'][0]['variable'] == 'hit'
    fingerprint = chart_catalog.calculation_fingerprint(item)
    renamed = chart_catalog.save_indicator(tmp_path, {**item, 'name': '新名称'}, item['id'])
    assert chart_catalog.calculation_fingerprint(renamed) == fingerprint
    with pytest.raises(chart_catalog.CatalogError, match='变量'):
        chart_catalog.validate_definition({**item, 'monitor_signals': [dict(id='buy', name='试仓', variable='missing', periods=['30m'])]})


def monitor(tmp_path, loader=None, sender=None):
    from app.services.indicator_monitor import IndicatorMonitorService
    return IndicatorMonitorService(tmp_path, loader=loader, sender=sender, capability=lambda rule: None)


def setup_rule(tmp_path, service, period='30m', mode='both'):
    item = definition(tmp_path)
    rule = service.save(dict(symbol='510300.SH', asset_type='etf', indicator_id=item['id'], period=period,
                            signal_ids=['buy'], mode=mode, channels=[], enabled=True))
    return rule, item


def at(time):
    return datetime.fromisoformat('2026-10-20 '+time).replace(tzinfo=CN_TZ)


def snapshot(close=11, complete=False):
    return dict(rows=[dict(date='2026-10-20 10:30', open=9, high=max(12, close), low=8, close=close,
                           volume=100, is_closed=complete)], source_context='test', data_through='2026-10-20 10:30')


def test_preview_confirmation_restart_and_withdrawal(tmp_path):
    svc = monitor(tmp_path)
    rule, _ = setup_rule(tmp_path, svc)
    svc.evaluate(rule['id'], snapshot(), at('10:12'))
    assert [e['phase'] for e in svc.events()] == ['preview']
    svc.evaluate(rule['id'], snapshot(9), at('10:20'))
    svc.evaluate(rule['id'], snapshot(), at('10:25'))
    assert len(svc.events()) == 1
    svc = monitor(tmp_path)
    svc.evaluate(rule['id'], snapshot(complete=True), at('10:31'))
    assert {e['phase'] for e in svc.events()} == {'preview', 'confirmed'}
    svc.evaluate(rule['id'], snapshot(complete=True), at('10:32'))
    assert len(svc.events()) == 2


def test_no_historical_spam_and_version_pause(tmp_path):
    svc = monitor(tmp_path)
    rule, item = setup_rule(tmp_path, svc)
    svc.evaluate(rule['id'], snapshot(complete=True), at('10:31'))
    assert svc.events() == []
    chart_catalog.save_indicator(tmp_path, {**item, 'formula': 'hit:=CLOSE>9; 线:CLOSE;'}, item['id'])
    missing = snapshot()
    missing['rows'][0]['date'] = '2026-10-20 11:00'
    svc.evaluate(rule['id'], missing, at('10:32'))
    assert svc.get(rule['id'])['status'] == 'version_changed'
    with pytest.raises(ValueError, match='版本'):
        svc.save({**svc.get(rule['id']), 'enabled': True}, rule['id'])
    adopted = svc.adopt(rule['id'])
    assert adopted['generation'] == rule['generation']+1


def test_unconfirmed_missing_data_and_null_are_distinct(tmp_path):
    svc = monitor(tmp_path)
    rule, _ = setup_rule(tmp_path, svc)
    svc.evaluate(rule['id'], snapshot(), at('10:12'))
    svc.evaluate(rule['id'], snapshot(9, complete=True), at('10:31'))
    assert svc.events()[0]['confirmation'] == 'unconfirmed'
    assert len(svc.events()) == 1


def test_duplicate_rule_and_failed_delivery_retry(tmp_path):
    sent = []
    svc = monitor(tmp_path, sender=lambda event, channel: sent.append(event['event_id']) or False)
    rule, _ = setup_rule(tmp_path, svc)
    rule = svc.save({**rule, 'channels': ['feishu']}, rule['id'])
    with pytest.raises(ValueError, match='已存在'):
        svc.save(rule)
    svc.evaluate(rule['id'], snapshot(), at('10:12'))
    svc.deliver()
    event = svc.events()[0]
    assert event['deliveries']['feishu'] == 'failed'
    svc.retry(event['event_id'])
    svc.deliver()
    assert sent == [event['event_id'], event['event_id']]


def test_clear_history_does_not_reset_preview_dedup(tmp_path):
    svc = monitor(tmp_path)
    rule, _ = setup_rule(tmp_path, svc)
    svc.evaluate(rule['id'], snapshot(), at('10:12'))
    svc.clear_events()
    svc = monitor(tmp_path)
    svc.evaluate(rule['id'], snapshot(), at('10:13'))
    assert svc.events() == []


def test_confirm_only_and_daily_are_independent(tmp_path):
    svc = monitor(tmp_path)
    rule, _ = setup_rule(tmp_path, svc, period='1d', mode='confirmed')
    first = dict(rows=[dict(date='2026-10-20', close=11, is_closed=False)], source_context='daily')
    svc.evaluate(rule['id'], first, at('14:12'))
    assert svc.events() == []
    svc.evaluate(rule['id'], {**first, 'rows': [{**first['rows'][0], 'is_closed': True}]}, at('15:01'))
    assert [e['phase'] for e in svc.events()] == ['confirmed']


def test_context_change_requires_explicit_adoption(tmp_path):
    svc = monitor(tmp_path)
    rule, _ = setup_rule(tmp_path, svc)
    svc.evaluate(rule['id'], snapshot(), at('10:12'))
    svc.evaluate(rule['id'], {**snapshot(), 'source_context': 'different'}, at('10:13'))
    assert svc.get(rule['id'])['status'] == 'context_changed'
    assert len(svc.events()) == 1
    adopted = svc.adopt(rule['id'])
    svc.evaluate(adopted['id'], {**snapshot(), 'source_context': 'different'}, at('10:14'))
    assert len(svc.events()) == 2


def test_stale_and_null_values_never_confirm(tmp_path):
    svc = monitor(tmp_path)
    rule, item = setup_rule(tmp_path, svc)
    svc.evaluate(rule['id'], snapshot(), at('10:12'))
    svc.evaluate(rule['id'], {**snapshot(complete=True), 'stale': True}, at('10:31'))
    assert len(svc.events()) == 1
    item = chart_catalog.save_indicator(tmp_path, {**item, 'formula': 'hit:=MA(CLOSE,100);'}, item['id'])
    svc.adopt(rule['id'])
    missing = snapshot()
    missing['rows'][0]['date'] = '2026-10-20 11:00'
    svc.evaluate(rule['id'], missing, at('10:32'))
    assert svc.get(rule['id'])['reason'] == '信号尚不可计算'
    assert len(svc.events()) == 1


def test_api_rule_validation_and_frozen_snapshot(tmp_path):
    from types import SimpleNamespace

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api.indicator_monitors import router

    svc = monitor(tmp_path)
    item = definition(tmp_path)
    app = FastAPI()
    app.include_router(router)
    app.state.indicator_monitor = svc
    app.state.repo = SimpleNamespace(resolve_asset_type=lambda symbol: 'etf')
    client = TestClient(app)
    payload = dict(symbol='510300.SH', asset_type='etf', indicator_id=item['id'], period='30m', signal_ids=['buy'])
    response = client.post('/api/indicator-monitors', json=payload)
    assert response.status_code == 200
    rule = response.json()
    assert client.post('/api/indicator-monitors', json=payload).status_code == 422
    assert client.post('/api/indicator-monitors', json={**payload, 'period': '1w'}).status_code == 422
    svc.evaluate(rule['id'], snapshot(), at('10:12'))
    event = svc.events()[0]
    chart_catalog.save_indicator(tmp_path, {**item, 'formula': 'hit:=0; 线:CLOSE;'}, item['id'])
    old = client.get(f"/api/indicator-monitors/{rule['id']}/snapshot?event_id={event['event_id']}")
    assert old.status_code == 200
    assert old.json()['definition']['formula'] == item['formula']
    assert client.delete(f"/api/indicator-monitors/{rule['id']}").status_code == 200
    assert len(client.get('/api/indicator-monitors/events').json()['items']) == 1
    assert client.get(f"/api/indicator-monitors/{rule['id']}/snapshot?event_id={event['event_id']}").status_code == 200


def test_minute_confirmation_requires_complete_actual_coverage(monkeypatch):
    from types import SimpleNamespace

    import polars as pl

    from app.services import chart_candles
    from app.services.chart_data import ChartSnapshot

    stamps = pl.datetime_range(datetime(2026, 10, 20, 10, 1), datetime(2026, 10, 20, 10, 30), '1m', eager=True)
    frame = pl.DataFrame(dict(symbol=['A']*30, datetime=stamps, open=[10.]*30, high=[12.]*30,
                              low=[9.]*30, close=[11.]*30, volume=[1.]*30))
    def get_snapshot(*args, **kwargs):
        return ChartSnapshot(frame if args[3] == '1m' else pl.DataFrame(), 'test', adjustment='forward')
    monkeypatch.setattr(chart_candles, 'chart_snapshot', get_snapshot)
    monkeypatch.setattr(chart_candles.preferences, 'get_minute_data_provider', lambda: 'test')
    rule = dict(symbol='A', asset_type='stock', period='30m')
    state = SimpleNamespace(repo=SimpleNamespace(get_name_map=lambda symbols: {}))
    full = chart_candles.monitor_snapshot(state, rule, at('10:31'))
    assert full['rows'][0]['is_closed'] is True
    frame = frame.filter(pl.col('datetime') != datetime(2026, 10, 20, 10, 12))
    missing = chart_candles.monitor_snapshot(state, rule, at('10:31'))
    assert missing['rows'][0]['is_closed'] is False


def test_deadline_and_restart_old_previews_do_not_remain_pending(tmp_path):
    svc = monitor(tmp_path)
    rule, _ = setup_rule(tmp_path, svc)
    svc.evaluate(rule['id'], snapshot(), at('10:12'))
    svc.expire_pending(at('15:29'))
    assert svc.events()[0]['confirmation'] == 'pending'
    svc.expire_pending(at('15:30'))
    assert svc.events()[0]['confirmation'] == 'missing_data'


def test_missing_earlier_bar_does_not_advance_cursor_past_gap(tmp_path):
    svc = monitor(tmp_path)
    rule, _ = setup_rule(tmp_path, svc)
    svc.evaluate(rule['id'], snapshot(), at('10:12'))
    first = snapshot()
    later = {**first['rows'][0], 'date': '2026-10-20 11:00', 'is_closed': True}
    svc.evaluate(rule['id'], {**first, 'rows': first['rows']+[later]}, at('11:01'))
    svc.evaluate(rule['id'], {**first, 'rows': [{**first['rows'][0], 'is_closed': True}, later]}, at('11:02'))
    assert {(e['bar_end'], e['phase']) for e in svc.events()} == {
        ('2026-10-20 10:30', 'preview'), ('2026-10-20 10:30', 'confirmed'), ('2026-10-20 11:00', 'confirmed'),
    }


def test_capability_rejection_and_no_enabled_rules_do_not_fetch(tmp_path, monkeypatch):
    svc = monitor(tmp_path)
    item = definition(tmp_path)
    svc.capability = lambda rule: '分钟数据能力不可用'
    with pytest.raises(ValueError, match='分钟数据'):
        svc.save(dict(symbol='510300.SH', indicator_id=item['id'], signal_ids=['buy']))
    monkeypatch.setattr('app.services.trading_day.is_trading_day', lambda: (_ for _ in ()).throw(AssertionError('no network without rules')))
    svc.tick(at('10:12'))


def test_old_indicator_clients_preserve_signal_configuration(tmp_path):
    item = definition(tmp_path)
    old_payload = {k: item[k] for k in ('name', 'pane', 'formula', 'revision')}
    saved = chart_catalog.save_indicator(tmp_path, old_payload, item['id'])
    assert saved['monitor_signals'] == item['monitor_signals']
    assert saved['min_history_bars'] == 1
    with pytest.raises(chart_catalog.CatalogError, match='变量'):
        chart_catalog.save_indicator(tmp_path, {**old_payload, 'revision': saved['revision'], 'formula': '线:CLOSE;'}, item['id'])


def test_history_origin_survives_warmup_and_restart(tmp_path):
    svc = monitor(tmp_path)
    item = definition(tmp_path, min_history_bars=3)
    rule = svc.save(dict(symbol='510300.SH', asset_type='etf', indicator_id=item['id'], signal_ids=['buy']))
    one = snapshot()
    svc.evaluate(rule['id'], one, at('10:12'))
    assert svc.get(rule['id'])['status'] == 'history_short'
    assert svc.get(rule['id'])['calc_start'] == one['rows'][0]['date']
    svc = monitor(tmp_path)
    rows = one['rows']+[{**one['rows'][0], 'date': '2026-10-20 11:00'}, {**one['rows'][0], 'date': '2026-10-20 11:30'}]
    svc.evaluate(rule['id'], {**one, 'rows': rows}, at('11:12'))
    assert svc.get(rule['id'])['status'] == 'running'
    svc.evaluate(rule['id'], {**one, 'rows': rows[1:]}, at('11:13'))
    assert svc.get(rule['id'])['reason'] == '固定计算起点的历史数据缺失'


def test_tick_shares_fetches_and_formula_calculation(tmp_path, monkeypatch):
    from app.services import indicator_monitor as module

    loads = []
    svc = monitor(tmp_path, loader=lambda rule, now: loads.append(rule['symbol']) or snapshot())
    setup_rule(tmp_path, svc)
    copied = definition(tmp_path)
    svc.save(dict(symbol='510300.SH', asset_type='etf', indicator_id=copied['id'], period='30m', signal_ids=['buy']))
    original = module.evaluate
    calculations = []
    def calculate(*args, **kwargs):
        calculations.append(1)
        return original(*args, **kwargs)
    monkeypatch.setattr(module, 'evaluate', calculate)
    monkeypatch.setattr('app.services.trading_day.is_trading_day', lambda: True)
    svc.tick(at('10:12'))
    assert loads == ['510300.SH']
    assert len(calculations) == 1
    assert len(svc.events()) == 2


def test_pending_delivery_survives_restart_and_channels_fail_independently(tmp_path):
    svc = monitor(tmp_path)
    rule, _ = setup_rule(tmp_path, svc)
    svc.save({**rule, 'channels': ['feishu', 'wecom']}, rule['id'])
    svc.evaluate(rule['id'], snapshot(), at('10:12'))
    seen = []
    svc = monitor(tmp_path, sender=lambda event, channel: seen.append(channel) or channel == 'wecom')
    svc.deliver()
    assert set(seen) == {'feishu', 'wecom'}
    assert svc.events()[0]['deliveries'] == {'feishu': 'failed', 'wecom': 'sent'}
    svc.retry(svc.events()[0]['event_id'])
    svc.deliver()
    assert seen.count('wecom') == 1


def test_concurrent_evaluation_generates_one_event(tmp_path):
    from concurrent.futures import ThreadPoolExecutor

    svc = monitor(tmp_path)
    rule, _ = setup_rule(tmp_path, svc)
    with ThreadPoolExecutor(2) as executor:
        results = [executor.submit(svc.evaluate, rule['id'], snapshot(), at('10:12')) for _ in range(2)]
        for result in results:
            result.result()
    assert len(svc.events()) == 1


def test_background_worker_lifecycle(tmp_path):
    from threading import Event

    svc = monitor(tmp_path)
    ran = Event()
    svc.tick = ran.set
    svc.start()
    assert ran.wait(1)
    svc.stop()
    assert all(not worker.is_alive() for worker in svc.threads)


def test_stock_etf_and_main_sub_formula_contexts_are_isolated(tmp_path):
    svc = monitor(tmp_path)
    etf, _ = setup_rule(tmp_path, svc)
    main = definition(tmp_path, pane='main')
    stock = svc.save(dict(symbol='600000.SH', asset_type='stock', indicator_id=main['id'], period='30m', signal_ids=['buy']))
    svc.evaluate(etf['id'], snapshot(), at('10:12'))
    svc.evaluate(stock['id'], snapshot(9), at('10:12'))
    assert [(e['symbol'], e['asset_type']) for e in svc.events()] == [('510300.SH', 'etf')]
    svc.evaluate(stock['id'], snapshot(12), at('10:13'))
    assert {e['symbol']: e['price'] for e in svc.events()} == {'510300.SH': 11, '600000.SH': 12}
    assert svc.snapshot(stock['id'])['definition']['pane'] == 'main'


def test_limited_raw_history_windows_can_extend_fixed_context(tmp_path):
    svc = monitor(tmp_path)
    item = definition(tmp_path, min_history_bars=3)
    rule = svc.save(dict(symbol='510300.SH', asset_type='etf', indicator_id=item['id'], signal_ids=['buy']))
    seed = snapshot()
    seed['adjustment'] = 'none'
    first = seed['rows'][0]
    second = {**first, 'date': '2026-10-20 11:00'}
    third = {**first, 'date': '2026-10-20 11:30'}
    svc.evaluate(rule['id'], {**seed, 'rows': [first, second]}, at('10:12'))
    svc = monitor(tmp_path)
    svc.evaluate(rule['id'], {**seed, 'rows': [second, third]}, at('11:12'))
    assert svc.get(rule['id'])['status'] == 'running'
    assert [r['date'] for r in svc.snapshot(rule['id'])['rows']] == [r['date'] for r in [first, second, third]]


def test_indicator_api_variable_metadata_and_copy(tmp_path):
    from types import SimpleNamespace

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.custom.chart_indicators import router

    app = FastAPI()
    app.include_router(router)
    app.state.repo = SimpleNamespace(store=SimpleNamespace(data_dir=tmp_path))
    client = TestClient(app)
    original = definition(tmp_path)
    payload = {k: original[k] for k in ('name', 'pane', 'formula', 'monitor_signals', 'min_history_bars')}
    validated = client.post('/api/indicators/validate', json=payload)
    assert validated.status_code == 200
    assert validated.json()['variables'] == ['hit', '线']
    copied = client.post('/api/indicators', json={**payload, 'copy_from': original['id']}).json()
    assert copied['id'] != original['id']
    assert copied['monitor_signals'] == original['monitor_signals']
    old_update = {k: copied[k] for k in ('name', 'pane', 'formula', 'revision')}
    updated = client.put('/api/indicators/'+copied['id'], json=old_update)
    assert updated.status_code == 200
    assert updated.json()['monitor_signals'] == copied['monitor_signals']


@pytest.mark.parametrize('name', ['沪深300ETF', ''])
def test_indicator_event_persists_symbol_name_for_delivery(tmp_path, name):
    sent = []
    svc = monitor(tmp_path)
    rule, _ = setup_rule(tmp_path, svc)
    svc.save({**rule, 'channels': ['custom']}, rule['id'])
    svc.evaluate(rule['id'], {**snapshot(), 'symbol_name': name}, at('10:12'))
    assert svc.events()[0]['symbol_name'] == name
    restored = monitor(tmp_path, sender=lambda event, channel: sent.append(event) or True)
    restored.deliver()
    assert sent[0]['symbol_name'] == name


@pytest.mark.parametrize(('asset_type', 'symbol', 'name'), [
    ('etf', '159605.SZ', '中概互联ETF广发'), ('stock', '600000.SH', '浦发银行'),
    ('etf', '999999.SZ', ''),
])
def test_monitor_snapshot_resolves_name_from_repository(monkeypatch, asset_type, symbol, name):
    from types import SimpleNamespace

    import polars as pl

    from app.services import chart_candles
    from app.services.chart_data import ChartSnapshot

    calls = []
    def names(symbols):
        calls.append(symbols)
        return {symbol: name} if name else {}
    state = SimpleNamespace(repo=SimpleNamespace(get_name_map=names))
    monkeypatch.setattr(chart_candles, 'chart_snapshot', lambda *a, **kw: ChartSnapshot(pl.DataFrame(), 'test'))
    result = chart_candles.monitor_snapshot(state, {'symbol': symbol, 'asset_type': asset_type, 'period': '30m'}, at('10:31'))
    assert result['symbol_name'] == name
    assert calls == [[symbol]]
