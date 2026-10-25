from datetime import date, timedelta

import pytest

from app.indicators import chart_catalog as catalog
from app.indicators.chart_formula import FormulaError, compile_formula, evaluate

FORMULA = 'DRAWPIVOT(HIGH,1,1,1),COLORRED; DRAWPIVOT(LOW,1,1,-1),COLORGREEN;'


def bars(highs, lows=None):
    return [dict(date=(date(2026, 1, 1) + timedelta(days=i)).isoformat(),
                 high=high, low=low, open=low, close=high, is_closed=True)
            for i, (high, low) in enumerate(zip(highs, lows or [1.] * len(highs), strict=True))]


def levels(rows, formula=FORMULA):
    return [d['levels'] for d in evaluate(compile_formula(formula), rows)['drawings']]


def test_confirmation_is_delayed_until_right_bars_close():
    rows = bars([2., 5., 3., 2.])
    formula = 'DRAWPIVOT(HIGH,1,2,1);'
    assert levels(rows[:3], formula) == [[]]
    rows[-1]['is_closed'] = False
    assert levels(rows, formula) == [[]]
    rows[-1]['is_closed'] = True
    assert levels(rows, formula) == [[dict(value=5., pivot_index=1, confirmed_index=3)]]
    del rows[-1]['is_closed']
    assert levels(rows, formula) == [[]]


def test_multiple_levels_touch_break_and_recreation():
    rows = bars([2., 8., 3., 6., 4.], [1., 3., 2., 4., 3.])
    resistance, support = levels(rows)
    assert [level['value'] for level in resistance] == [8., 6.]
    assert [level['value'] for level in support] == [2.]
    touched = [*rows, *bars([6.], [2.])]
    assert levels(touched)[0] == resistance
    assert levels(touched)[1] == support
    broken = [*rows, *bars([7.], [1.5])]
    assert [level['value'] for level in levels(broken)[0]] == [8.]
    assert levels(broken)[1] == []
    recreated = bars([2., 6., 3., 7., 2., 6., 3.])
    assert levels(recreated)[0][-1] == dict(value=6., pivot_index=5, confirmed_index=6)


def test_equal_extrema_choose_last_plateau_and_deduplicate_active_prices():
    rows = bars([2., 6., 6., 3., 6., 3.])
    assert levels(rows)[0] == [dict(value=6., pivot_index=2, confirmed_index=3)]
    mirrored = bars([10.] * 6, [8., 4., 4., 7., 4., 7.])
    assert levels(mirrored)[1] == [dict(value=4., pivot_index=2, confirmed_index=3)]


def test_missing_window_and_unknown_break_price_fail_closed():
    rows = bars([2., 6., 3., None, 2., 5., 3.])
    assert levels(rows)[0] == [dict(value=5., pivot_index=5, confirmed_index=6)]
    rows[1]['is_closed'] = False
    assert levels(rows[:3])[0] == []


@pytest.mark.parametrize('formula', [
    'DRAWPIVOT(HIGH,0,2,1);', 'DRAWPIVOT(HIGH,3,-1,1);',
    'DRAWPIVOT(HIGH,3,2,0);', 'DRAWPIVOT(HIGH,3,2,2);',
    'DRAWPIVOT(HIGH,1.5,2,1);', 'DRAWPIVOT(HIGH,20000,1,1);',
    'DRAWPIVOT(HIGH,CLOSE,2,1);', "DRAWPIVOT('HIGH',3,2,1);",
])
def test_invalid_arguments_are_rejected(formula):
    with pytest.raises(FormulaError):
        levels(bars([2., 4., 3.]), formula)


def test_empty_input_and_bounded_level_count():
    assert levels([]) == [[], []]
    rows = bars([3000-i*.1+i%2 for i in range(1202)],
                [1000+i*.1-i%2 for i in range(1202)])
    result = levels(rows)
    assert sum(map(len, result)) == 500
    assert min(level['confirmed_index'] for group in result for level in group) >= 702


@pytest.mark.parametrize('direction', [1, -1])
def test_levels_match_sequential_reference_at_each_cutoff(direction):
    import random

    rng = random.Random(7)
    rows = bars([float(rng.randrange(10, 20)) for _ in range(60)],
                [float(rng.randrange(1, 9)) for _ in range(60)])
    source = 'high' if direction == 1 else 'low'
    formula = f'DRAWPIVOT({source},3,2,{direction});'
    active = {}
    for end, row in enumerate(rows):
        current = row[source]
        active = {price: value for price, value in active.items() if direction*current <= direction*price}
        if end >= 5:
            pivot = end-2
            price = rows[pivot][source]
            if (all(direction*price >= direction*other[source] for other in rows[pivot-3:pivot])
                    and all(direction*price > direction*other[source] for other in rows[pivot+1:end+1])):
                active.setdefault(price, dict(value=price, pivot_index=pivot, confirmed_index=end))
        assert levels(rows[:end+1], formula)[0] == list(active.values())


@pytest.mark.parametrize('period', ['1d', '30m', '1w', '1mo'])
def test_history_clipping_dates_and_closure_cache_invalidation(tmp_path, period):
    rows = bars([2., 8., 3., 6., 4.])
    if period == '30m':
        for row in rows:
            row['date'] += ' 10:00'
    item = catalog.save_indicator(tmp_path, dict(name='拐点', pane='main', formula=FORMULA))
    payload = dict(symbol='TEST', asset_type='etf', period=period, rows=rows[-1:])
    result = catalog.attach_results(payload, tmp_path, item['id'], history_rows=rows)['indicator_results'][item['id']]
    assert result['drawings'][0]['levels'] == [
        dict(value=8., pivot_date=rows[1]['date'], confirmed_date=rows[2]['date']),
        dict(value=6., pivot_date=rows[3]['date'], confirmed_date=rows[4]['date']),
    ]
    payload['rows'] = [{**rows[-1], 'is_closed': False}]
    pending = catalog.attach_results(payload, tmp_path, item['id'], history_rows=rows)['indicator_results'][item['id']]
    assert len(pending['drawings'][0]['levels']) == 1
    assert result['drawings'][0]['levels'][-1]['value'] == 6.
    copy = catalog.save_indicator(tmp_path, {**item, 'copy_from': item['id'], 'name': '拐点副本'})
    assert catalog.get_indicator(tmp_path, copy['id'])['formula'] == FORMULA
    restarted = catalog.list_indicators(tmp_path)
    assert any(i['id'] == item['id'] for i in restarted['items'])


def test_every_historical_cutoff_matches_its_own_snapshot(tmp_path):
    rows = bars([2., 8., 3., 6., 4., 7., 3., 9.])
    item = catalog.save_indicator(tmp_path, dict(name='拐点', pane='main', formula=FORMULA))
    for end in range(1, len(rows)+1):
        history = rows[:end]
        result = catalog.attach_results(dict(rows=history[-1:], period='1d'), tmp_path,
                                        item['id'], history_rows=rows)['indicator_results'][item['id']]
        assert [level['value'] for level in result['drawings'][0]['levels']] == [
            level['value'] for level in levels(history)[0]
        ]
        assert all(level['confirmed_date'] <= history[-1]['date']
                   for drawing in result['drawings'] for level in drawing['levels'])
    assert levels(rows[:5])[0] and levels(rows)[0] == []


def test_pivot_definition_and_management_api(tmp_path):
    from types import SimpleNamespace

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.custom.chart_indicators import router

    app = FastAPI()
    app.include_router(router)
    app.state.repo = SimpleNamespace(store=SimpleNamespace(data_dir=tmp_path))
    client = TestClient(app)
    item = catalog.defaults()['reversal-pivots']
    assert item['pane'] == 'main' and item['source'] == 'custom'
    assert client.post('/api/indicators/validate', json={
        'pane': 'main', 'formula': item['formula'],
    }).status_code == 200
    assert client.get('/api/indicators/language').json()['drawings']['DRAWPIVOT'] == [4, 4]
    assert client.post('/api/indicators/validate', json={
        'pane': 'sub', 'formula': FORMULA,
    }).status_code == 422
    saved = client.post('/api/indicators', json={
        'name': '拐点副本', 'pane': 'main', 'formula': FORMULA,
    }).json()
    assert saved['revision'] == 1
    rows = bars([2., 8., 3., 6., 4.])
    result = client.post('/api/indicators/evaluate', json={
        'ids': [saved['id']], 'rows': rows, 'symbol': '510300.SH', 'period': '1d',
    }).json()
    assert len(result['indicator_results'][saved['id']]['drawings'][0]['levels']) == 2
    updated = client.put('/api/indicators/'+saved['id'], json={
        'name': saved['name'], 'pane': 'main', 'formula': 'DRAWPIVOT(HIGH,2,2,1);', 'revision': 1,
    }).json()
    assert updated['revision'] == 2
