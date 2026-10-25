from datetime import date, datetime, timedelta
from types import SimpleNamespace

import polars as pl
import pytest

from app.api import stock_analysis
from app.indicators.levels import LEVEL_TYPES, compute_levels, summarize_levels
from app.market_time import CN_TZ


def frame(candles, closed=True):
    return pl.DataFrame([dict(date=date(2026, 10, 12)+timedelta(days=i),
                              open=opened, high=high, low=low, close=close, is_closed=closed)
                         for i, (opened, high, low, close) in enumerate(candles)])


SUPPLY = [(10., 11.5, 9.8, 11.), (11., 11.8, 8.5, 9.)]
DEMAND = [(11., 11.5, 9.8, 10.), (10., 12.5, 9.5, 12.)]


@pytest.mark.parametrize('candles,side,lower,upper', [
    (SUPPLY, 'resistance', 10., 11.8), (DEMAND, 'support', 9.5, 11.),
])
def test_zone_boundaries_confirmation_and_precision(candles, side, lower, upper):
    df = frame(candles).with_columns(pl.col('open', 'high', 'low', 'close')/100)
    zones = compute_levels(df)['supply_demand']
    assert 'supply_demand' in LEVEL_TYPES
    assert len(zones) == 1
    assert zones[0] == dict(type='supply_demand', side=side,
        label='供给区' if side == 'resistance' else '需求区', strength='strong',
        lower=lower/100, upper=upper/100, value=(lower/100+upper/100)/2,
        formed_date='2026-10-12', confirmed_date='2026-10-13')
    assert '~' in summarize_levels({'supply_demand': zones}, .1)
    pending = df.with_columns(pl.when(pl.col('date') == date(2026, 10, 13))
                              .then(False).otherwise(True).alias('is_closed'))
    assert compute_levels(pending)['supply_demand'] == []
    unknown = df.drop('is_closed')
    assert compute_levels(unknown)['supply_demand'] == []
    assert len(compute_levels(unknown, as_of=datetime(2026, 10, 14, tzinfo=CN_TZ))['supply_demand']) == 1


@pytest.mark.parametrize('candles,next_candle,exists', [
    (SUPPLY, (10., 11.8, 9.7, 10.), True),
    (SUPPLY, (10., 11.9, 9.7, 10.), False),
    (DEMAND, (11., 12., 9.5, 11.), True),
    (DEMAND, (11., 12., 9.4, 11.), False),
])
def test_touch_is_retained_and_intrabar_break_removes_zone(candles, next_candle, exists):
    df = frame([*candles, next_candle]).with_columns(
        pl.when(pl.col('date') == date(2026, 10, 14)).then(False).otherwise(True).alias('is_closed'))
    assert bool(compute_levels(df)['supply_demand']) is exists


@pytest.mark.parametrize('candles', [
    [(10., 11.5, 9.8, 11.), (11., 11.8, 9., 9.3)],  # below 1.8x
    [(10., 11., 9., 10.), (10., 11., 8., 8.)],       # zero prior body
    [(10., 11.5, 9.8, 11.), (10., 13., 9., 12.)],   # same direction
    [(10., 11.5, 9.8, 11.), (9.5, 10., 7., 7.5)],   # opening gap, no engulf
    [(10., 11.5, 9.8, 11.), (11., None, 8.5, 9.)],
])
def test_unqualified_or_missing_candles_do_not_form_zones(candles):
    assert compute_levels(frame(candles))['supply_demand'] == []


def test_multiple_zones_deduplication_recreation_and_cap():
    candles = [*SUPPLY, (10., 10.4, 8.8, 10.2), (10.2, 10.5, 8.9, 9.7)]
    zones = compute_levels(frame(candles))['supply_demand']
    assert {(z['lower'], z['upper']) for z in zones} == {(10., 11.8), (10., 10.5)}
    assert len(compute_levels(frame([*SUPPLY, *SUPPLY]))['supply_demand']) == 1
    recreated = [*SUPPLY, (10., 12., 9.8, 11.), *SUPPLY]
    assert compute_levels(frame(recreated))['supply_demand'][-1]['confirmed_date'] == '2026-10-16'
    shrinking = []
    for i in range(510):
        center = 1000-i
        shrinking.extend([(center, center+.5, center-.5, center+.2),
                          (center+.2, center+.6, center-.8, center-.2)])
    capped = compute_levels(frame(shrinking))['supply_demand']
    assert len(capped) == 500
    assert capped[0]['confirmed_date'] == str(date(2026, 10, 12)+timedelta(days=21))


def test_api_historical_cutoff_and_empty_response(monkeypatch):
    monkeypatch.setattr(stock_analysis, 'cn_today', lambda: date(2026, 10, 20))
    monkeypatch.setattr(stock_analysis, 'cn_now', lambda: datetime(2026, 10, 20, tzinfo=CN_TZ))
    df = frame([*SUPPLY, (10., 12., 9., 10.)])
    repo = SimpleNamespace(resolve_asset_type=lambda symbol: 'etf', get_daily_asset=lambda *args: df)
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(repo=repo)))
    historical = stock_analysis.get_levels(request, symbol='512000.SH', days=120, end_date=date(2026, 10, 13))
    assert len(historical['levels']['supply_demand']) == 1
    assert stock_analysis.get_levels(request, symbol='512000.SH', days=120)['levels']['supply_demand'] == []
    repo.get_daily_asset = lambda *args: pl.DataFrame()
    assert stock_analysis.get_levels(request, symbol='512000.SH', days=120)['levels']['supply_demand'] == []
