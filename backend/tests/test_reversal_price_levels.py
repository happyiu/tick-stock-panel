from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace

import polars as pl

from app.api import stock_analysis
from app.indicators.chart_formula import compile_formula, evaluate
from app.indicators.levels import LEVEL_TYPES, compute_levels, summarize_levels
from app.market_time import CN_TZ


def frame():
    return pl.DataFrame({
        'date': [date(2026, 10, 12) + timedelta(days=i) for i in range(9)],
        'open': [4.] * 9, 'close': [4.] * 9,
        'high': [5., 6., 7., 10., 7., 8., 9., 7., 6.],
        'low': [3., 2., 3., 1., 3., 2., 3., 2., 3.],
    })


def test_key_levels_reuse_chart_pivots_without_losing_price_precision():
    df = frame().with_columns(pl.col('high') / 100, pl.col('low') / 100,
                              pl.col('open') / 100, pl.col('close') / 100)
    as_of = datetime(2026, 10, 21, tzinfo=CN_TZ)
    result = compute_levels(df, as_of=as_of)
    expected = evaluate(compile_formula('DRAWPIVOT(HIGH,3,2,1); DRAWPIVOT(LOW,3,2,-1);'),
                        df.with_columns(pl.lit(True).alias('is_closed')).to_dicts())
    assert 'reversal_pivot' in LEVEL_TYPES
    assert [point['value'] for point in result['reversal_pivot']] == [
        point['value'] for drawing in expected['drawings'] for point in drawing['levels']
    ]
    assert result['reversal_pivot'][0] == dict(value=.1, label='拐点压力', type='reversal_pivot',
        side='resistance', strength='strong', pivot_date='2026-10-15', confirmed_date='2026-10-17')
    assert any(point['side'] == 'support' for point in result['reversal_pivot'])
    assert '反转拐点' in summarize_levels(result, .04)


def test_today_closure_historical_cutoff_and_strict_break():
    df = frame().head(6)
    day = df['date'][-1]
    before_close = datetime.combine(day, datetime.min.time(), CN_TZ).replace(hour=14)
    assert compute_levels(df, as_of=before_close)['reversal_pivot'] == []
    after_close = before_close.replace(hour=15)
    confirmed = compute_levels(df, as_of=after_close)['reversal_pivot']
    assert {point['value'] for point in confirmed} == {10., 1.}
    assert compute_levels(df, as_of=after_close.astimezone(UTC))['reversal_pivot'] == confirmed
    assert compute_levels(df)['reversal_pivot'] == []
    df = df.with_columns(pl.lit(True).alias('is_closed'))
    assert compute_levels(df)['reversal_pivot'] == confirmed
    touched = pl.concat([df, pl.DataFrame([dict(date=day+timedelta(days=1), open=4., close=4.,
                                               high=10., low=1., is_closed=False)])])
    assert compute_levels(touched)['reversal_pivot'] == confirmed
    broken = touched.with_columns(pl.when(pl.col('date') > day).then(11.).otherwise(pl.col('high')).alias('high'))
    assert all(point['side'] == 'support' for point in compute_levels(broken)['reversal_pivot'])


def test_api_returns_group_for_etfs_and_empty_data(monkeypatch):
    df = frame()
    monkeypatch.setattr(stock_analysis, 'cn_today', lambda: date(2026, 10, 21))
    monkeypatch.setattr(stock_analysis, 'cn_now', lambda: datetime(2026, 10, 21, tzinfo=CN_TZ))
    repo = SimpleNamespace(resolve_asset_type=lambda symbol: 'etf', get_daily_asset=lambda *args: df)
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(repo=repo)))
    result = stock_analysis.get_levels(request, symbol='512000.SH', days=120, end_date=date(2026, 10, 17))
    assert result['asset_type'] == 'etf'
    assert {point['value'] for point in result['levels']['reversal_pivot']} == {10., 1.}
    assert all(point['confirmed_date'] <= '2026-10-17' for point in result['levels']['reversal_pivot'])
    repo.get_daily_asset = lambda *args: pl.DataFrame()
    empty = stock_analysis.get_levels(request, symbol='512000.SH', days=120)
    assert empty['levels']['reversal_pivot'] == []
