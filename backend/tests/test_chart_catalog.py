import json
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import polars as pl
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.custom.chart_indicators import router
from app.indicators import chart_catalog as catalog
from app.indicators.chart_formula import compile_formula, evaluate
from app.indicators.pipeline import compute_indicators


def test_all_defaults_compile_and_basic_six_match_pipeline():
    rows = [dict(symbol='TEST', date=f'{i:05}', open=10+i*.02, high=11+i*.02,
                 low=9+i*.01, close=10+i*.03+(i%7)*.01, volume=1000+i) for i in range(150)]
    expected = compute_indicators(pl.DataFrame(rows)).to_dicts()
    for item in catalog.defaults().values():
        catalog.validate_definition(item)
    for key in ('ma', 'macd', 'rsi', 'kdj', 'boll'):
        result = evaluate(compile_formula(catalog.defaults()[key]['formula']), rows)['rows']
        for i, row in enumerate(result):
            for field, value in row.items():
                if field not in expected[i]:
                    continue
                if expected[i][field] is None:
                    assert value is None
                else:
                    assert value == pytest.approx(expected[i][field], abs=1e-8)


def test_catalog_lifecycle_and_conflicts(tmp_path):
    payload = dict(name='测试', pane='main', formula='中线:MA(CLOSE,5);')
    item = catalog.save_indicator(tmp_path, payload)
    assert catalog.get_indicator(tmp_path, item['id'])['formula'] == payload['formula']
    with ThreadPoolExecutor(2) as pool:
        futures = [pool.submit(catalog.save_indicator, tmp_path, {**payload, 'revision': 1}, item['id']) for _ in range(2)]
        results = []
        for f in futures:
            try:
                results.append(f.result()['revision'])
            except catalog.CatalogError as e:
                results.append(e.status)
    assert sorted(results) == [2, 409]
    catalog.delete_indicator(tmp_path, 'ma', 1)
    assert 'ma' not in {i['id'] for i in catalog.list_indicators(tmp_path)['items']}
    assert json.loads((tmp_path/'user_data/custom_indicators/ma.json').read_text())['deleted']
    catalog.delete_indicator(tmp_path, item['id'], 2)
    with pytest.raises(catalog.CatalogError, match='不存在'):
        catalog.get_indicator(tmp_path, item['id'])


def test_corruption_and_paths_fail_closed(tmp_path):
    folder = tmp_path/'user_data/custom_indicators'
    folder.mkdir(parents=True)
    (folder/'ma.json').write_text('{broken')
    result = catalog.list_indicators(tmp_path)
    assert 'ma' not in {i['id'] for i in result['items']}
    assert result['errors'][0]['id'] == 'ma'
    (folder/'user-invalid.json').write_text('[]')
    assert len(catalog.list_indicators(tmp_path)['errors']) == 2
    for key in ('../outside', 'builtin-ema'):
        with pytest.raises(catalog.CatalogError):
            catalog.delete_indicator(tmp_path, key, 1)


def test_management_api(tmp_path):
    app = FastAPI()
    app.include_router(router)
    app.state.repo = SimpleNamespace(store=SimpleNamespace(data_dir=tmp_path))
    client = TestClient(app)
    payload = dict(name='测试', pane='sub', formula='结果:MA(CLOSE,5);')
    assert len(client.get('/api/indicators').json()['items']) == 12
    assert client.post('/api/indicators/validate', json={**payload, 'formula': '结果:REF(CLOSE,-1);'}).status_code == 422
    item = client.post('/api/indicators', json=payload).json()
    assert client.get('/api/indicators/'+item['id']).json()['revision'] == 1
    assert client.put('/api/indicators/'+item['id'], json={**payload, 'revision': 1}).json()['revision'] == 2
    assert client.put('/api/indicators/'+item['id'], json={**payload, 'revision': 1}).status_code == 409
    assert client.put('/api/indicators/builtin-ema', json={**payload, 'revision': 1}).status_code == 403
    assert client.delete('/api/indicators/'+item['id']+'?revision=2').status_code == 200


@pytest.mark.parametrize('name', [None, '', '   '])
def test_formula_validation_does_not_require_indicator_name(name, tmp_path):
    app = FastAPI()
    app.include_router(router)
    app.state.repo = SimpleNamespace(store=SimpleNamespace(data_dir=tmp_path))
    client = TestClient(app)
    payload = dict(pane='main', formula='MA13:MA(C,13),COLORWHITE,LINETHICK2;')
    if name is not None:
        payload['name'] = name
    response = client.post('/api/indicators/validate', json=payload)
    assert response.status_code == 200
    assert response.json() == {'valid': True, 'variables': ['MA13']}
    assert client.post('/api/indicators', json=payload).status_code == 422
    invalid = client.post('/api/indicators/validate', json={**payload, 'formula': 'X:REF(C,-1);'})
    assert invalid.status_code == 422
    assert 'detail' in invalid.json()
    assert client.post('/api/indicators/validate', json={**payload, 'formula': ''}).status_code == 422


def test_chart_snapshots_versions_and_failed_write(tmp_path, monkeypatch):
    rows = [dict(date=f'2026-10-{i+1:02}', open=1., high=3., low=1., close=float(i+1), volume=10.) for i in range(20)]
    item = catalog.save_indicator(tmp_path, dict(name='线', pane='main', formula='线:MA(CLOSE,2);'))
    payload = dict(symbol='TEST', asset_type='stock', period='1d', rows=rows)
    one = catalog.attach_results(payload, tmp_path, item['id'])['indicator_results'][item['id']]
    assert one['rows'][-1]['线'] == 19.5
    updated = catalog.save_indicator(tmp_path, {**item, 'formula': '线:MA(CLOSE,3);'}, item['id'])
    two = catalog.attach_results(payload, tmp_path, item['id'])['indicator_results'][item['id']]
    assert two['rows'][-1]['线'] == 19
    assert two['revision'] == 2
    payload['rows'] = [*rows[:-1], {**rows[-1], 'close': 30.}]
    assert catalog.attach_results(payload, tmp_path, item['id'])['indicator_results'][item['id']]['rows'][-1]['线'] != 19
    monkeypatch.setattr(catalog, 'atomic_write_text', lambda *args: (_ for _ in ()).throw(OSError('disk unavailable')))
    with pytest.raises(OSError):
        catalog.save_indicator(tmp_path, {**updated, 'name': '丢失的修改'}, item['id'])
    assert catalog.get_indicator(tmp_path, item['id'])['name'] == '线'


def test_input_size_and_damaged_metadata_isolation(tmp_path):
    folder = tmp_path/'user_data/custom_indicators'
    folder.mkdir(parents=True)
    (folder/'ma.json').write_text(json.dumps({'id': 'ma', 'name': 'broken'}))
    assert catalog.list_indicators(tmp_path)['errors']
    assert catalog.attach_results({'rows': [{'date': '2026-10-01', 'close': 1.}]}, tmp_path, 'ma')['indicator_errors']


@pytest.mark.parametrize('period', ['1d', '30m', '1w', '1mo'])
def test_chart_projection_preserves_all_plots_without_intermediates(tmp_path, period):
    rows = [dict(date=f'{i:04}', open=10+i*.01, high=11+i*.01, low=9+i*.01,
                 close=10+i*.02, volume=1000+i) for i in range(120)]
    payload = dict(symbol='TEST', period=period, rows=rows)
    results = catalog.attach_results(payload, tmp_path, ','.join(catalog.defaults()))['indicator_results']
    for key, item in catalog.defaults().items():
        full = evaluate(compile_formula(item['formula']), rows, period)
        compact = results[key]
        assert compact['figures'] == full['figures']
        for figure in full['figures']:
            assert [r[figure['key']] for r in compact['rows']] == [r[figure['key']] for r in full['rows']]
        for before, after in zip(full['drawings'], compact['drawings'], strict=True):
            assert before['kind'] == after['kind']
            assert before['text'] == after['text']
            for position, field in before['fields']:
                constants = dict(after.get('constants', []))
                mapped = dict(after['fields']).get(position)
                values = [constants[position] if position in constants else r[mapped] for r in compact['rows']]
                assert values == [r[field] for r in full['rows']]
    assert 'halfHour' not in results['bull-bear-trend-v2']['rows'][-1]
    for field in ('supported', 'ready'):
        assert field in results['bull-bear-trend-v2']['rows'][-1]
    assert 'bull' in results['angel-devil']['rows'][-1]
    assert 'mid' in results['boll']['rows'][-1]
    assert len(json.dumps(results)) < len(json.dumps({
        key: evaluate(compile_formula(item['formula']), rows) for key, item in catalog.defaults().items()
    })) * .5


def test_chart_cache_ignores_unused_enriched_columns_and_isolation(tmp_path):
    catalog._cached_evaluation.cache_clear()
    payload = dict(symbol='TEST', period='1d', rows=[dict(date='2026-10-01', close=1.)])
    first = catalog.attach_results(payload, tmp_path, 'ma')
    first['indicator_results']['ma']['rows'][0]['ma5'] = 999
    payload['rows'][0]['unrelated_score'] = 50
    second = catalog.attach_results(payload, tmp_path, 'ma')
    assert catalog._cached_evaluation.cache_info().hits == 1
    assert second['indicator_results']['ma']['rows'][0]['ma5'] is None


def test_all_original_formulas_are_prefix_causal_and_copy_retains_layout(tmp_path):
    rows = [dict(date=f'{i:04}', open=10+i*.01, high=11+i*.01, low=9+i*.01, close=10+i*.02, volume=1000+i) for i in range(120)]
    for item in catalog.defaults().values():
        full = evaluate(compile_formula(item['formula']), rows, '30m')['rows']
        prefix = evaluate(compile_formula(item['formula']), rows[:80], '30m')['rows']
        assert full[:80] == prefix
    original = catalog.defaults()['etf-swing-v2']
    copy = catalog.save_indicator(tmp_path, {**original, 'copy_from': original['id'], 'name': '副本'})
    assert copy['id'] != original['id']
    assert copy['height'] == original['height']
    assert copy['min_value'] == original['min_value']
    assert copy['calculation_origin'] == original['id']
    payload = dict(symbol='TEST', period='30m', rows=rows[30:])
    result = catalog.attach_results(payload, tmp_path, f"{copy['id']},{original['id']}", history_rows=rows)['indicator_results']
    assert result[copy['id']]['rows'] == result[original['id']]['rows']
