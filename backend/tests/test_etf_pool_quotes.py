"""ETF pool quotes retain raw prices, decimal returns and per-symbol dates."""
from datetime import date

import polars as pl
import pytest

from app.tickflow.repository import DataStore, KlineRepository


@pytest.fixture()
def repo(tmp_path):
    return KlineRepository(DataStore(tmp_path))


def write_day(repo, day, rows):
    root = repo.store.data_dir / 'kline_etf_enriched' / f'date={day}'
    root.mkdir(parents=True)
    pl.DataFrame(rows).with_columns(pl.lit(date.fromisoformat(day)).alias('date')).write_parquet(root / 'part.parquet')


def history(repo):
    write_day(repo, '2026-09-18', {'symbol': ['510300.SH', '159605.SZ'], 'close': [1., 5.], 'raw_close': [10., 5.]})
    write_day(repo, '2026-09-21', {'symbol': ['510300.SH', '159605.SZ'], 'close': [1.1, 5.5], 'raw_close': [8., 5.5]})
    write_day(repo, '2026-09-22', {'symbol': ['159605.SZ'], 'close': [6.], 'raw_close': [6.]})


def test_recent_partitions_keep_non_live_symbols_and_adjusted_return(repo, monkeypatch):
    history(repo)
    monkeypatch.setattr(repo, '_refresh_etf_enriched', lambda: pytest.fail('must not recompute historical indicators'))
    rows = {r['symbol']: r for r in repo.get_etf_quote_snapshot(['510300.SH', '159605.SZ', 'MISSING']).to_dicts()}
    assert set(rows) == {'510300.SH', '159605.SZ'}
    assert rows['510300.SH']['last_price'] == 8.  # raw price, not adjusted close 1.1
    assert rows['510300.SH']['change_pct'] == pytest.approx(.1)
    assert rows['510300.SH']['quote_date'] == '2026-09-21'
    assert rows['159605.SZ']['change_pct'] == pytest.approx(6 / 5.5 - 1)
    assert rows['159605.SZ']['quote_date'] == '2026-09-22'
    assert repo.get_etf_quote_snapshot([]).is_empty()


def test_cache_overrides_only_same_or_newer_dates(repo):
    history(repo)
    repo._etf_enriched_cache_date = date(2026, 9, 22)
    repo._etf_enriched_cache = pl.DataFrame({
        'symbol': ['510300.SH', '159605.SZ'],
        'date': [date(2026, 9, 22), date(2026, 9, 18)],
        'raw_close': [8.1234, 999.], 'close': [1.2, 999.], 'change_pct': [.0234, .9],
    })
    rows = {r['symbol']: r for r in repo.get_etf_quote_snapshot(['510300.SH', '159605.SZ']).to_dicts()}
    assert rows['510300.SH']['last_price'] == 8.1234
    assert rows['510300.SH']['change_pct'] == .0234
    assert rows['510300.SH']['quote_date'] == '2026-09-22'
    assert rows['159605.SZ']['last_price'] == 6.


def test_missing_raw_price_zero_baseline_and_nonfinite_values_are_null(repo):
    write_day(repo, '2026-09-21', {'symbol': ['510300.SH'], 'close': [0.]})
    write_day(repo, '2026-09-22', {'symbol': ['510300.SH'], 'close': [1.]})
    row = repo.get_etf_quote_snapshot(['510300.SH']).to_dicts()[0]
    assert row['last_price'] is None
    assert row['change_pct'] is None
    repo._etf_enriched_cache_date = date(2026, 9, 23)
    repo._etf_enriched_cache = pl.DataFrame({
        'symbol': ['510300.SH', '159605.SZ'], 'raw_close': [float('nan'), 3.1234],
        'change_pct': [float('inf'), float('nan')],
    })
    rows = {r['symbol']: r for r in repo.get_etf_quote_snapshot(['510300.SH', '159605.SZ']).to_dicts()}
    assert rows['510300.SH']['quote_date'] == '2026-09-22'
    assert rows['159605.SZ']['change_pct'] is None
    assert rows['159605.SZ']['quote_date'] == '2026-09-23'


def test_no_data_does_not_scan_or_compute_unrelated_assets(repo):
    assert repo.get_etf_quote_snapshot(['510300.SH']).is_empty()


def test_missing_previous_partition_row_does_not_become_a_multi_day_return(repo):
    write_day(repo, '2026-09-18', {'symbol': ['510300.SH'], 'close': [10.], 'raw_close': [10.]})
    write_day(repo, '2026-09-21', {'symbol': ['159605.SZ'], 'close': [5.], 'raw_close': [5.]})
    write_day(repo, '2026-09-22', {'symbol': ['510300.SH'], 'close': [12.], 'raw_close': [12.]})
    row = repo.get_etf_quote_snapshot(['510300.SH']).to_dicts()[0]
    assert row['last_price'] == 12.
    assert row['change_pct'] is None
