from itertools import pairwise

from app.services.wave import _shape, analyze_wave, confluence


def points(values):
    return [dict(value=v, side='low' if i % 2 == 0 else 'high', index=i) for i, v in enumerate(values)]


def test_shapes_and_mirrors():
    values = [10, 20, 15, 30, 25, 40, 32, 36, 28]
    rows = [dict(low=v, high=v, closed=True) for v in values]
    assert _shape(points(values), rows)
    mirrored = [60-v for v in values]
    ps = points(mirrored)
    for p in ps:
        p['side'] = 'high' if p['side'] == 'low' else 'low'
    assert _shape(ps, [dict(low=v, high=v, closed=True) for v in mirrored])
    for bad in ([10, 20, 10, 30], [10, 20, 15, 30, 20], [10, 20, 15, 30, 25, 29], [10, 20, 15, 30, 25, 40, 32, 40], [10, 20, 15, 30, 25, 40, 32, 36, 33]):
        assert not _shape(points(bad), [dict(low=v, high=v, closed=True) for v in bad])


def test_causal_validation_and_no_candidate():
    from datetime import date, timedelta
    rows = []
    values = [10, 20, 15, 30, 25, 40, 32, 36, 28]
    prices = [12, 11, 10.5]
    for a, b in pairwise(values):
        prices.extend(a+(b-a)*i/5 for i in range(5))
    prices.extend([28, 29, 30])
    for i, v in enumerate(prices):
        rows.append(dict(date=str(date(2025, 1, 1)+timedelta(days=i)), open=v, high=v+.1, low=v-.1, close=v, is_closed=True))
    for i in range(8, len(rows)):
        assert analyze_wave(rows[:i]) == analyze_wave(rows, as_of=rows[i-1]['date'])
    result = analyze_wave(rows)
    assert len(result['candidates']) <= 3
    assert all(p['confirmedAt'] > p['date'] for c in result['candidates'] for p in c['points'])
    assert analyze_wave(rows[::-1])['status'] == 'invalid_data'
    assert analyze_wave([], '1w')['status'] == 'unsupported'
    assert not analyze_wave([])['candidates']
    assert '证据不足' in confluence(dict(status='insufficient'), result)


def test_api_opt_in_and_shared_cutoff():
    from app.api.kline import _with_chanlun
    rows = [dict(date='2025-01-01', open=10, high=11, low=9, close=10, is_closed=True)]
    payload = dict(rows=rows, period='1d')
    assert 'wave' not in _with_chanlun(dict(payload), False, 'stroke', None)
    result = _with_chanlun(dict(payload), False, 'stroke', None, include_wave=True, wave_as_of='2025-01-01', include_dow=True, dow_as_of='2024-01-01')
    assert result['wave']['dataThrough'] == result['dow']['dataThrough'] == '2025-01-01'


def test_current_position_is_not_last_completed_wave():
    from app.services.wave_position import current_position
    c = dict(direction='up', points=[dict(index=0, value=30, side='high', label='3')])
    rows = [dict(high=30, low=29, closed=True), dict(high=29, low=27, closed=True)]
    assert current_position(c, rows)['active'] == '4'
    c['points'][0].update(value=25, side='low', label='4')
    rows = [dict(high=26, low=25, closed=True), dict(high=28, low=26, closed=True)]
    assert current_position(c, rows)['active'] == '5'
    rows.append(dict(high=29, low=24, closed=True))
    assert current_position(c, rows)['active'] is None


def test_atr_pivots_are_causal_and_scale_is_explicit():
    import random
    from datetime import date, timedelta

    from app.services.wave_position import scaled_pivots
    rng = random.Random(3)
    rows = []
    for i in range(100):
        value = 100+rng.uniform(-12, 12)
        rows.append(dict(date=str(date(2025, 1, 1)+timedelta(days=i)), high=value+1, low=value-1, close=value, closed=True))
    full = scaled_pivots(rows, 2)
    assert full
    for p in full:
        assert p['threshold'] > 0
        assert p['confirmedAt'] >= p['localConfirmedAt'] > p['date']
    for end in (25, 50, 75):
        prefix = scaled_pivots(rows[:end], 2)
        # Replacements are only visible in the later snapshot, never backfilled.
        assert all(p['confirmedAt'] <= rows[end-1]['date'] for p in prefix)
