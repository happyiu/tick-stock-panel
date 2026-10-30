"""Causal single-instrument Dow structure; all events are published at confirmation."""
import copy
import json
import math
from datetime import datetime, timedelta
from functools import lru_cache

from app.indicators.pivots import pivot_candidate

VERSION = 'dow-v3-left3-right2'



def analyze_dow(rows, period='1d', as_of=None):
    base = dict(version=VERSION, period=period, status='insufficient', structure='insufficient',
                trend='unknown', damaged=False, pivots=[], events=[], levels={}, issues=[], forming=True,
                dataThrough=None, coverageStart=None, volume=None)
    if period not in ('1w', '1d', '30m'):
        return {**base, 'status': 'unsupported', 'issues': ['该周期暂不支持道氏趋势']}
    normalized = []
    try:
        cutoff = datetime.fromisoformat(as_of.replace('T', ' ')) if as_of else None
        if cutoff and cutoff.tzinfo:
            raise ValueError('expected Beijing wall clock')
        if cutoff and len(as_of) == 10:
            cutoff = cutoff.replace(hour=23, minute=59, second=59)
        previous = None
        for row in rows:
            stamp = str(row['date']).replace('T', ' ')
            when = datetime.fromisoformat(stamp)
            if cutoff and when > cutoff:
                continue
            end = datetime.fromisoformat(str(row.get('period_end') or stamp).replace('T', ' '))
            if len(str(row.get('period_end') or stamp)) == 10:
                end = end.replace(hour=15)
            if cutoff and end > cutoff:
                continue
            if when.tzinfo or (previous and when <= previous):
                raise ValueError('invalid order')
            previous = when
            values = [float(row[k]) for k in ('open', 'high', 'low', 'close')]
            o, h, low, c = values
            if not all(math.isfinite(v) and v > 0 for v in values) or low > min(o, c) or h < max(o, c) or low > h:
                raise ValueError('invalid OHLC')
            volume = row.get('volume')
            if volume is not None:
                volume = float(volume)
                if not math.isfinite(volume) or volume < 0:
                    raise ValueError('invalid volume')
            normalized.append(dict(date=stamp, open=o, high=h, low=low, close=c, volume=volume, periodEnd=end.isoformat(),
                                   closed=row.get('is_closed') is True))
    except (ValueError, TypeError, KeyError, OverflowError):
        return {**base, 'status': 'invalid_data', 'issues': ['K线日期、顺序或价格量额异常']}
    if period == '30m' and normalized:
        observed = cutoff or datetime.fromisoformat(normalized[-1]['date'])
        start = (observed - timedelta(days=120)).date().isoformat()
        normalized = [r for r in normalized if r['date'][:10] >= start]
    return copy.deepcopy(_calculate(json.dumps(normalized[-1500:], sort_keys=True), period, as_of, VERSION))


@lru_cache(maxsize=32)
def _calculate(serialized, period, as_of, version):
    rows = json.loads(serialized)
    result = dict(version=version, period=period, status='insufficient', structure='insufficient',
                  trend='unknown', damaged=False, pivots=[], events=[], levels={}, issues=[], forming=bool(rows),
                  dataThrough=rows[-1]['date'] if rows else None,
                  coverageStart=rows[0]['date'] if rows else None, volume=None)
    highs, lows, published = [], [], set()
    high = [r['high'] if r['closed'] else None for r in rows]
    low = [r['low'] if r['closed'] else None for r in rows]

    def event(kind, i, anchor, direction, revision=None):
        key = (kind, anchor['date'], direction, revision)
        if key in published:
            return
        published.add(key)
        vols = [r['volume'] for r in rows[max(0, i-20):i] if r['closed']]
        volume = None
        if len(vols) == 20 and all(v is not None for v in vols) and sum(vols) > 0 and rows[i]['volume'] is not None:
            volume = rows[i]['volume'] / (sum(vols)/20)
        result['volume'] = volume
        result['events'].append(dict(kind=kind, date=rows[i]['date'], anchorDate=anchor['date'],
                                     value=anchor['value'], direction=direction, volumeRatio=volume, structureId=revision))

    structure_revision = None
    damaged_revision = None
    current_revision = None
    for i, row in enumerate(rows):
        if not row['closed']:
            continue
        protection = result['levels'].get('protection')
        if protection and result['trend'] != 'unknown':
            direction = 1 if result['trend'] == 'up' else -1
            if direction * (row['close'] - protection['value']) < 0:
                event('damage', i, protection, result['trend'])
                if not result['damaged']:
                    damaged_revision = current_revision
                result['damaged'] = True
            elif (row['low'] < protection['value'] if direction == 1 else row['high'] > protection['value']):
                event('wick', i, protection, result['trend'])
        p = i-2
        added = []
        for values, direction, series in ((high, 1, highs), (low, -1, lows)):
            if not pivot_candidate(values, p, direction):
                continue
            value = values[p]
            label = ''
            if series:
                delta = value-series[-1]['value']
                label = ('HH' if delta > 0 else 'LH' if delta < 0 else 'EH') if direction == 1 else ('HL' if delta > 0 else 'LL' if delta < 0 else 'EL')
            point = dict(date=rows[p]['date'], confirmedAt=row['date'], value=value,
                         side='high' if direction == 1 else 'low', label=label)
            series.append(point)
            result['pivots'].append(point)
            added.append(point)
        if len(highs) < 2 or len(lows) < 2:
            continue
        result['status'] = 'ok'
        up = highs[-1]['label'] == 'HH' and lows[-1]['label'] == 'HL'
        down = highs[-1]['label'] == 'LH' and lows[-1]['label'] == 'LL'
        result['structure'] = 'up' if up else 'down' if down else 'mixed'
        result['levels']['upper'] = highs[-1]
        result['levels']['lower'] = lows[-1]
        current_revision = (highs[-1]['date'], lows[-1]['date'], result['structure'])
        if len(added) == 2 or not (up or down):
            continue
        direction = 'up' if up else 'down'
        anchor = highs[-2] if up else lows[-2]
        crossed = row['close'] > anchor['value'] if up else row['close'] < anchor['value']
        revision = (highs[-1]['date'], lows[-1]['date'], direction)
        if crossed and revision != structure_revision and (not result['damaged'] or revision != damaged_revision):
            event('reversal' if result['trend'] not in ('unknown', direction) else 'confirm', i, anchor, direction, revision)
            result['trend'] = direction
            result['damaged'] = False
            structure_revision = revision
        if result['trend'] == direction and not result['damaged']:
            result['levels']['protection'] = lows[-1] if up else highs[-1]
    if result['status'] != 'ok':
        result['issues'].append('确认高低点不足, 每侧至少需要两个, 右侧需等待两根收盘K线')
    result.update(_explanation(result, current_revision, structure_revision, damaged_revision))
    return result


def _explanation(result, current_revision, confirmed_revision, damaged_revision):
    """Publish state-machine references; presentation never guesses trigger prices."""
    confirmations = [e for e in result['events'] if e['kind'] in ('confirm', 'reversal')]
    latest = confirmations[-1] if confirmations else None
    protection = result['levels'].get('protection')
    paths = []
    trend = result['trend']
    structure = result['structure']
    direction = 'down' if trend == 'up' else 'up'
    if result['status'] == 'ok':
        if protection and trend != 'unknown':
            paths.append(dict(kind='damage', direction=direction, value=protection['value'],
                              satisfied=result['damaged'], anchorDate=protection['date']))
        waiting_structure = result['damaged'] and structure == trend and current_revision == damaged_revision
        if waiting_structure:
            paths.append(dict(kind='recovery', direction=trend, value=None, satisfied=False, anchorDate=None, structureReady=False))
        elif structure in ('up', 'down'):
            side = 'high' if structure == 'up' else 'low'
            points = [p for p in result['pivots'] if p['side'] == side]
            anchor = points[-2]
            paths.append(dict(kind='confirmation', direction=structure, value=anchor['value'],
                              satisfied=bool(current_revision == confirmed_revision and not result['damaged']), structureReady=True,
                              anchorDate=anchor['date']))
        else:
            paths.append(dict(kind='structure', direction=direction, value=None, satisfied=False, anchorDate=None))
    return dict(basis=dict(structure=structure, confirmation=latest), paths=paths,
                breakoutVolume=latest)
