from app.services.dow import analyze_dow, pivot_candidate


def sample():
    import random
    from datetime import date, timedelta
    random.seed(4)
    rows = []
    for i in range(150):
        price = 100 + i * .2 + random.uniform(-4, 4)
        rows.append(dict(date=str(date(2025, 1, 1)+timedelta(days=i)), open=price,
                         high=price+1, low=price-1, close=price, volume=100+i, is_closed=True))
    return rows


def test_prefix_invariance():
    rows = sample()
    full = analyze_dow(rows)
    for i in range(10, len(rows), 7):
        prefix = analyze_dow(rows[:i])
        cutoff = rows[i-1]['date']
        assert prefix == analyze_dow(rows, as_of=cutoff)
        assert prefix['events'] == [e for e in full['events'] if e['date'] <= cutoff]


def test_plateau_and_validation():
    assert pivot_candidate([1, 2, 4, 4, 3, 2], 3, 1)
    assert not pivot_candidate([1, 2, 4, 4, 3, 2], 2, 1)
    rows = sample()
    assert analyze_dow(rows[::-1])['status'] == 'invalid_data'
    assert analyze_dow([rows[0], rows[0]])['status'] == 'invalid_data'
    rows[1]['close'] = float('nan')
    assert analyze_dow(rows)['status'] == 'invalid_data'
    assert analyze_dow([], period='1mo')['status'] == 'unsupported'


def test_unclosed_and_cache_revision():
    rows = sample()
    before = analyze_dow(rows[:-1])
    rows[-1]['is_closed'] = False
    current = analyze_dow(rows)
    assert current['events'] == before['events']
    assert current['pivots'] == before['pivots']
    from app.services.dow import _calculate
    misses = _calculate.cache_info().misses
    rows[-1].update(is_closed=True, volume=100000)
    analyze_dow(rows)
    assert _calculate.cache_info().misses == misses + 1


def test_api_opt_in_and_historical_cutoff():
    from app.api.kline import _with_chanlun
    rows = sample()
    payload = dict(rows=rows, period='1d')
    assert 'dow' not in _with_chanlun(dict(payload), False, 'stroke', None)
    result = _with_chanlun(dict(payload), False, 'stroke', None, include_dow=True, dow_as_of=rows[50]['date'])
    assert result['dow'] == analyze_dow(rows[:51])
    empty = _with_chanlun(dict(rows=[], period='30m'), False, 'stroke', None, include_dow=True)
    assert empty['dow']['status'] == 'insufficient'


def test_trend_damage_volume_and_no_repeat():
    result = analyze_dow(sample())
    assert any(e['kind'] == 'confirm' for e in result['events'])
    assert any(e['kind'] == 'damage' for e in result['events'])
    assert any(e['kind'] == 'wick' for e in result['events'])
    keys = [(e['kind'], e['anchorDate'], e['direction'], e.get('structureId')) for e in result['events']]
    assert len(keys) == len(set(keys))
    assert all(p['confirmedAt'] > p['date'] for p in result['pivots'])
    rows = sample()
    for row in rows:
        row['volume'] = None
    assert all(e['volumeRatio'] is None for e in analyze_dow(rows)['events'])


def test_period_end_excludes_unfinished_higher_period():
    rows = sample()[:10]
    rows[-1]['period_end'] = '2025-01-12'
    result = analyze_dow(rows, period='1w', as_of='2025-01-10')
    assert result['dataThrough'] == rows[-2]['date']


def test_reversal_and_dual_pivot_confirmation():
    rows = sample()
    from datetime import date, timedelta
    for i, row in enumerate(sample()):
        value = 140 - i*.5 + (row['close'] - 100 - i*.2)
        rows.append(dict(date=str(date(2025, 6, 1)+timedelta(days=i)), open=value,
                         high=value+1, low=value-1, close=value, volume=200, is_closed=True))
    result = analyze_dow(rows)
    assert any(e['kind'] == 'reversal' and e['direction'] == 'down' for e in result['events'])
    assert result['trend'] == 'down'
    for event in result['events']:
        if event['kind'] in ('confirm', 'reversal'):
            same = [p for p in result['pivots'] if p['confirmedAt'] == event['date']]
            assert len(same) != 2


def test_explanation_uses_confirmation_anchor_and_volume():
    rows = sample()
    for i in range(20, len(rows)):
        result = analyze_dow(rows[:i])
        confirms = [e for e in result['events'] if e['kind'] in ('confirm', 'reversal')]
        assert result['breakoutVolume'] == (confirms[-1] if confirms else None)
        for path in result['paths']:
            if path['kind'] == 'confirmation':
                points = [p for p in result['pivots'] if p['side'] == ('high' if path['direction'] == 'up' else 'low')]
                assert path['value'] == points[-2]['value']
            if path['kind'] == 'damage':
                assert path['satisfied'] == result['damaged']


def test_new_structure_does_not_inherit_old_confirmation():
    result = analyze_dow(sample()[:27])
    path = next(p for p in result['paths'] if p['kind'] == 'confirmation')
    assert round(result['basis']['confirmation']['value'], 3) == 105.544
    assert round(path['value'], 3) == 107.420
    assert not path['satisfied']


def test_damaged_old_structure_waits_for_new_structure():
    import random
    from datetime import date, timedelta
    rng = random.Random(11)
    rows = []
    for i in range(45):
        c = 100 + i*.1 + rng.uniform(-8, 8)
        rows.append(dict(date=str(date(2025, 1, 1)+timedelta(days=i)), open=c,
                         high=c+1, low=c-1, close=c, volume=100, is_closed=True))
    for mirrored in (False, True):
        data = rows if not mirrored else [dict(r, open=220-r['open'], close=220-r['close'], high=220-r['low'], low=220-r['high']) for r in rows]
        result = analyze_dow(data)
        assert result['damaged']
        assert not any(p['kind'] == 'confirmation' for p in result['paths'])
        recovery = next(p for p in result['paths'] if p['kind'] == 'recovery')
        assert recovery['structureReady'] is False
        assert recovery['value'] is None


def test_minute_window_matches_expanded_fallback():
    from datetime import datetime, timedelta
    rows = sample()
    cutoff = '2025-05-30 10:00:00'
    start = (datetime.fromisoformat(cutoff)-timedelta(days=120)).date().isoformat()
    narrow = [r for r in rows if r['date'] >= start]
    assert analyze_dow(rows, '30m', cutoff) == analyze_dow(narrow, '30m', cutoff)


def test_recovery_requires_new_structure_and_close_confirmation():
    rows = sample()
    recovered = False
    for i in range(21, len(rows)):
        before = analyze_dow(rows[:i-1])
        after = analyze_dow(rows[:i])
        if before['damaged'] and not after['damaged']:
            event = after['basis']['confirmation']
            assert event['date'] == rows[i-1]['date']
            assert event['structureId'] != before['basis']['confirmation']['structureId']
            assert rows[i-1]['close'] > event['value'] if event['direction'] == 'up' else rows[i-1]['close'] < event['value']
            recovered = True
    assert recovered
