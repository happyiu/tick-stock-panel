"""Explicit current-position evidence for confirmed wave-shape candidates."""
from typing import Literal, TypedDict


class Position(TypedDict):
    lastCompleted: str
    active: str | None
    direction: Literal['up', 'down']
    status: Literal['forming', 'unresolved']
    explanation: str


def current_position(candidate, rows) -> Position:
    last = candidate['points'][-1]
    tail = [r for r in rows[last['index']+1:] if r['closed']]
    stage = last['label']
    next_label = {'3': '4', '4': '5', '5': 'A', 'A': 'B', 'B': 'C'}.get(stage)
    up = candidate['direction'] == 'up'
    active_up = up if next_label in ('5', 'B') else not up
    # A new extreme in the completed leg direction contradicts its provisional end.
    extending = any(r['high'] > last['value'] if last['side'] == 'high' else r['low'] < last['value'] for r in tail)
    ready = bool(tail) and not extending and next_label is not None
    return dict(lastCompleted=stage, active=next_label if ready else None,
                direction='up' if active_up else 'down', status='forming' if ready else 'unresolved',
                explanation=f'可能处于{next_label}浪形成中,端点尚未确认' if ready else '末端延伸或后续结构不足,暂不能可靠判断当前浪位')


def enrich(candidate, rows, finer_points):
    position = current_position(candidate, rows)
    tree = []
    for i, (start, end) in enumerate(zip(candidate['points'], candidate['points'][1:], strict=False)):
        inside = [p for p in finer_points if start['index'] < p['index'] < end['index']]
        children = [dict(label=str(j+1), start=a, end=b, children=[], validation='price_segment')
                    for j, (a, b) in enumerate(zip([start, *inside], [*inside, end], strict=True))]
        tree.append(dict(label=end['label'], start=start, end=end, children=children,
                         validation='unverified_subdivision', expected='5' if i % 2 == 0 else '3'))
    p0, p1 = candidate['points'][:2]
    length = abs(p1['value']-p0['value'])
    sign = 1 if position['direction'] == 'up' else -1
    candidate.update(currentPosition=position, waveTree=tree,
                     validation=dict(level='shape_only', pending=['内部5-3结构尚未完整验证', '分钟覆盖尚未提供'],
                                     passed=candidate['rules']),
                     conditions=dict(next=candidate['nextCondition'], invalidation=candidate['invalidation']),
                     projections=[dict(ratio=r, value=candidate['points'][-1]['value']+sign*length*r,
                                       reference=[p0['date'], p1['date']], kind='scenario_reference') for r in (1, 1.618, 2.618)],
                     revisions=[dict(effectiveAt=candidate['effectiveAt'], reason='当前截止时刻的结构解释')])
    return candidate


def scaled_pivots(rows, multiplier):
    """Publish local extrema only once the observed reversal exceeds causal ATR14."""
    from app.indicators.pivots import pivot_candidate
    highs = [r['high'] if r['closed'] else None for r in rows]
    lows = [r['low'] if r['closed'] else None for r in rows]
    ranges, sequence, pending = [], [], None
    previous_close = None
    for i, row in enumerate(rows):
        if not row['closed']:
            continue
        ranges.append(max(row['high']-row['low'], abs(row['high']-previous_close), abs(row['low']-previous_close)) if previous_close is not None else row['high']-row['low'])
        previous_close = row['close']
        if len(ranges) < 14:
            continue
        atr = sum(ranges[-14:])/14
        p = i-2
        facts = [(side, values[p]) for side, values, d in (('high', highs, 1), ('low', lows, -1)) if pivot_candidate(values, p, d)]
        if len(facts) == 2:
            pending = None
            continue
        if facts:
            side, value = facts[0]
            point = dict(date=rows[p]['date'], confirmedAt=row['date'], localConfirmedAt=row['date'], side=side, value=value, index=p, threshold=multiplier*atr)
            if pending is None or pending['side'] != side or (value-pending['value'])*(1 if side == 'high' else -1) >= 0:
                pending = point
        if pending is None:
            continue
        reversal = pending['value']-row['close'] if pending['side'] == 'high' else row['close']-pending['value']
        if reversal < pending['threshold']:
            continue
        point = dict(pending, confirmedAt=row['date'])
        if sequence and sequence[-1]['side'] == point['side']:
            if (point['value']-sequence[-1]['value'])*(1 if point['side'] == 'high' else -1) >= 0:
                sequence[-1] = point
        else:
            sequence.append(point)
        pending = None
    return sequence
