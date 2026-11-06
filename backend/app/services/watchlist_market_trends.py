"""Compact, closed-candle watchlist summaries using the chart source and formula engine."""
from __future__ import annotations

import logging
import math
from datetime import datetime, timedelta
from functools import lru_cache

from app.indicators.chart_formula import compile_formula, evaluate
from app.services.chart_candles import chart_snapshot, wave_daily_snapshot
from app.services.kline_periods import (
    aggregate_daily_period,
    aggregate_minute_30m,
    annotate_bar_closure,
    prepare_native_30m,
)

logger = logging.getLogger(__name__)
# Same EMA/SLOPE/CROSS formula as the market-trend panel's fixed angel/devil indicator.
_PROGRAM = compile_formula('angel:=EMA(CLOSE,2); devil:=EMA(CLOSE+20*SLOPE(CLOSE,21),42); attack:CROSS(angel,devil); retreat:CROSS(devil,angel);')


def empty_summary(status='empty'):
    return dict(status=status, signal=None, date=None, change_percent=None, bars=None, data_through=None)


@lru_cache(maxsize=128)
def _summarize(prices: tuple[tuple[str, float], ...]):
    if not prices:
        return empty_summary()
    rows = [{'date': stamp, 'close': close} for stamp, close in prices]
    values = evaluate(_PROGRAM, rows)['rows']
    summary = {**empty_summary('insufficient' if len(prices) < 22 else 'no_signal'), 'data_through': prices[-1][0]}
    for i in range(len(prices)-1, 0, -1):
        if values[i]['attack'] or values[i]['retreat']:
            stamp, close = prices[i]
            return {**summary, 'status': 'ok', 'signal': 'attack' if values[i]['attack'] else 'retreat',
                    'date': stamp, 'change_percent': (prices[-1][1]/close-1)*100, 'bars': len(prices)-i}
    return summary


def summarize(rows, period, end, now):
    closed = annotate_bar_closure(rows, period, end, now=now)
    prices = tuple((str(row['date']).replace('T', ' '), float(row['close'])) for row in closed if row['is_closed'])
    if any(not math.isfinite(close) or close <= 0 for _, close in prices):
        return empty_summary('error')
    # Cache is keyed by all input prices, so corrections and new bars invalidate it naturally.
    return dict(_summarize(prices))


def symbol_trends(state, symbol: str, asset: str, now: datetime):
    end = now.date()
    try:
        start = end.replace(year=end.year-3)
    except ValueError:
        start = end.replace(year=end.year-3, month=3, day=1)
    result = {}
    try:
        daily = wave_daily_snapshot(state, symbol, asset, start, end).frame
        result['1d'] = summarize(daily.to_dicts(), '1d', end, now)
        weekly = aggregate_daily_period(daily, '1w') if not daily.is_empty() else daily
        result['1w'] = summarize(weekly.to_dicts(), '1w', end, now)
    except Exception:
        logger.exception('Watchlist daily trend unavailable for %s', symbol)
        result['1w'] = empty_summary('error')
        result['1d'] = empty_summary('error')
    try:
        minute_start = end - timedelta(days=380)
        native = chart_snapshot(state, symbol, asset, '30m', minute_start, end).frame
        if not native.is_empty():
            dates = sorted(native['datetime'].dt.date().unique().to_list())[-120:]
            native = native.filter(native['datetime'].dt.date().is_in(dates))
            bars = prepare_native_30m(native)
        elif asset != 'index':
            minutes = state.repo.get_minute_range([symbol], minute_start, end, asset_type=asset)
            if minutes.is_empty():
                bars = minutes
            else:
                dates = sorted(minutes['datetime'].dt.date().unique().to_list())[-120:]
                minutes = minutes.filter(minutes['datetime'].dt.date().is_in(dates))
                bars = aggregate_minute_30m(minutes)
        else:
            bars = native
        result['30m'] = summarize(bars.to_dicts(), '30m', end, now)
    except Exception:
        logger.exception('Watchlist 30F trend unavailable for %s', symbol)
        result['30m'] = empty_summary('error')
    return result
