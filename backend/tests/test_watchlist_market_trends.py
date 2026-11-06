from datetime import date, datetime, timedelta
from types import SimpleNamespace

import polars as pl
import pytest

from app.api import watchlist as api
from app.services import watchlist_market_trends as trends


def prices(values):
    return [{'date': str(date(2026, 1, 1) + timedelta(days=i)), 'close': value} for i, value in enumerate(values)]


def test_latest_signal_matches_panel_and_counts_signal_bar():
    rows = prices([100.] * 30 + [110., 112., 90., 88., 105.])
    result = trends.summarize(rows, '1d', date(2026, 3, 1), datetime(2026, 3, 1, 16))
    assert result['signal'] == 'retreat'
    assert result['date'] == rows[32]['date']
    assert result['bars'] == 3
    assert result['change_percent'] == pytest.approx((105 / 90 - 1) * 100)
    rows[-1]['close'] = 106.
    assert trends.summarize(rows, '1d', date(2026, 3, 1), datetime(2026, 3, 1, 16))['change_percent'] != result['change_percent']


def test_missing_short_and_flat_data_are_distinct():
    now = datetime(2026, 3, 1, 16)
    for count, status in [(0, 'empty'), (21, 'insufficient'), (30, 'no_signal')]:
        assert trends.summarize(prices([100.] * count), '1d', now.date(), now)['status'] == status


def test_open_daily_bar_cannot_create_signal():
    rows = prices([100.] * 30 + [110., 112., 90.])
    end = date.fromisoformat(rows[-1]['date'])
    result = trends.summarize(rows, '1d', end, datetime.combine(end, datetime.min.time()).replace(hour=14))
    assert result['signal'] == 'attack'
    assert result['data_through'] == rows[-2]['date']
    assert result['bars'] == 2


def test_index_never_reads_stock_minutes_and_failure_is_isolated(monkeypatch):
    monkeypatch.setattr(trends, 'wave_daily_snapshot', lambda *a: (_ for _ in ()).throw(RuntimeError('daily failure')))
    monkeypatch.setattr(trends, 'chart_snapshot', lambda *a: SimpleNamespace(frame=pl.DataFrame()))
    result = trends.symbol_trends(SimpleNamespace(repo=object()), '000001.SH', 'index', datetime(2026, 11, 6, 16))
    assert result['1w']['status'] == result['1d']['status'] == 'error'
    assert result['30m']['status'] == 'empty'


def test_batch_deduplicates_and_keeps_asset_scope(monkeypatch):
    monkeypatch.setattr(api.watchlist, 'list_symbols', lambda: [{'symbol': '159992.SZ'}, {'symbol': '600000.SH'}])
    calls = []
    monkeypatch.setattr(trends, 'symbol_trends', lambda state, symbol, asset, now: calls.append(symbol) or {})
    repo = SimpleNamespace(resolve_asset_type=lambda symbol: 'etf' if symbol == '159992.SZ' else 'stock')
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(repo=repo)))
    result = api.watchlist_market_trends(api.MarketTrendsRequest(symbols=['159992.SZ', '159992.SZ', '600000.SH', 'unknown'], asset_type='etf'), request)
    assert calls == ['159992.SZ']
    assert [row['symbol'] for row in result['rows']] == calls


def test_open_week_and_future_thirty_minute_bar_are_excluded():
    now = datetime(2026, 11, 6, 14, 15)
    weekly = [{'date': date(2026, 3, 20) + timedelta(weeks=i), 'close': 100.} for i in range(34)]
    weekly[-1]['close'] = 90.
    result = trends.summarize(weekly, '1w', now.date(), now)
    assert result['status'] == 'no_signal'
    assert result['data_through'] == '2026-10-30'
    minute = [{'date': str(now.replace(hour=10, minute=0) - timedelta(minutes=(30-i)*30)), 'close': 100.} for i in range(30)]
    minute += [{'date': '2026-11-06 14:30', 'close': 90.}]
    result = trends.summarize(minute, '30m', now.date(), now)
    assert result['status'] == 'no_signal'
    assert result['data_through'] != '2026-11-06 14:30'
