from datetime import date, datetime, timedelta
from types import SimpleNamespace

import polars as pl
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.signals import router
from app.indicators.chart_formula import compile_formula, evaluate
from app.strategy import custom_signals, formula_signals

FORMULA = 'angel:=EMA(CLOSE,2); devil:=EMA(CLOSE+20*SLOPE(CLOSE,21),42); attack:=CROSS(angel,devil);'


def signal(**changes):
    return {'id': 'attack', 'name': '天使魔鬼·进攻', 'kind': 'entry', 'enabled': True,
            'definition_type': 'formula', 'formula': FORMULA, 'output_var': 'attack',
            'min_history_bars': 22, 'timeframe': 'daily', **changes}


def bars():
    prices = [100.] * 30 + [110., 112., 90., 88., 105.]
    return pl.DataFrame([{'symbol': symbol, 'date': date(2026, 1, 1) + timedelta(days=i),
                         'open': p, 'high': p, 'low': p, 'close': p, 'volume': 10., 'amount': p * 10}
                        for symbol in ['A', 'B'] for i, p in enumerate(prices if symbol == 'A' else [100.] * len(prices))])


def test_formula_parity_group_isolation_and_no_future_data():
    frame = bars()
    result = formula_signals.inject(frame, [signal()], period='1d')
    source = frame.filter(pl.col('symbol') == 'A')
    expected = evaluate(compile_formula(FORMULA), source.to_dicts(), '1d')['rows']
    actual = result.filter(pl.col('symbol') == 'A')['csg_attack'].to_list()
    assert actual[:21] == [None] * 21
    assert actual[21:] == [bool(row['attack']) for row in expected[21:]]
    assert actual[30:33] == [True, False, False]
    assert not any(value for value in result.filter(pl.col('symbol') == 'B')['csg_attack'])
    prefix = frame.filter(pl.col('date') <= date(2026, 1, 31))
    assert formula_signals.inject(prefix, [signal()])['csg_attack'].to_list() == result.filter(pl.col('date') <= date(2026, 1, 31))['csg_attack'].to_list()


def test_period_truth_nulls_and_unsupported_periods():
    sig = signal(formula='out:IF(PERIOD=1440,-2,0);', output_var='out', min_history_bars=1)
    assert formula_signals.inject(bars(), [sig], period='1d')['csg_attack'].all()
    assert not formula_signals.inject(bars(), [sig], period='30m')['csg_attack'].any()
    with pytest.raises(ValueError, match='周期'):
        formula_signals.inject(bars(), [sig], needed={'csg_attack'}, period='1w')
    assert 'csg_attack' not in formula_signals.inject(bars(), [sig], period='1w').columns
    sig.update(formula='out:CLOSE;', min_history_bars=1)
    missing = bars().with_columns(pl.when(pl.col('date') == date(2026, 1, 31)).then(None).otherwise(pl.col('close')).alias('close'))
    assert formula_signals.inject(missing, [sig]).filter(pl.col('date') == date(2026, 1, 31))['csg_attack'].null_count() == 2


@pytest.mark.parametrize('patch', [
    {'formula': 'out:EXEC(CLOSE);'}, {'formula': 'out:REF(CLOSE,-1);'},
    {'output_var': 'absent'}, {'min_history_bars': 0}, {'min_history_bars': 20001},
    {'timeframe': 'intraday'},
])
def test_invalid_formula_is_rejected(patch):
    with pytest.raises(ValueError):
        custom_signals.validate(signal(**patch))


def test_dependencies_needed_selection_and_bad_definition_isolation():
    definitions = [signal(), signal(id='bad', formula='bad:UNKNOWN(CLOSE);', output_var='bad'), signal(id='broken', formula=None)]
    assert formula_signals.dependencies(definitions)['csg_attack'] == frozenset({'close'})
    assert 'csg_attack' not in formula_signals.inject(bars(), definitions, needed=set()).columns
    assert 'csg_attack' in formula_signals.inject(bars(), definitions).columns
    with pytest.raises(ValueError):
        formula_signals.inject(bars(), definitions, needed={'csg_bad'})
    with pytest.raises(ValueError, match='公式必须是文本'):
        formula_signals.inject(bars(), definitions, needed={'csg_broken'})


def test_api_validate_crud_and_legacy_conditions(tmp_path):
    app = FastAPI()
    app.include_router(router)
    app.state.repo = SimpleNamespace(store=SimpleNamespace(data_dir=tmp_path), clear_cache=lambda: None)
    with TestClient(app) as client:
        response = client.post('/api/custom-signals/validate', json={'formula': FORMULA})
        assert response.status_code == 200
        assert response.json()['variables'] == ['angel', 'devil', 'attack']
        assert client.post('/api/custom-signals/validate', json={'formula': 'x:REF(CLOSE,-1);'}).status_code == 400
        assert client.post('/api/custom-signals', json=signal()).status_code == 200
        assert custom_signals.load_all(tmp_path)[0]['output_var'] == 'attack'
        (tmp_path / 'user_data' / 'custom_signals' / 'broken.json').write_text('[]')
        assert len(custom_signals.load_all(tmp_path)) == 1
        assert client.get('/api/custom-signals').json()['signals'][0]['definition_type'] == 'formula'
        assert client.post('/api/custom-signals', json=signal(output_var='absent')).status_code == 400
        legacy = {'id': 'old', 'name': '旧条件', 'kind': 'entry', 'conditions': [{'left': 'close', 'op': '>', 'right': '0'}]}
        assert client.post('/api/custom-signals', json=legacy).status_code == 200
        assert client.delete('/api/custom-signals/attack').status_code == 200
        assert [s['id'] for s in custom_signals.load_all(tmp_path)] == ['old']


def test_shared_pipeline_backtest_dependencies_and_period_dispatch(monkeypatch):
    from app.backtest.strategy import StrategyDependencyResolver
    from app.indicators import pipeline
    from app.services.screener import _prepare_30m_strategy_frame
    from app.strategy.engine import StrategyDef

    sig = signal(min_history_bars=150)
    monkeypatch.setattr(pipeline, '_formula_signal_definitions', [sig])
    monkeypatch.setattr(pipeline, '_custom_signal_exprs', {})
    result = pipeline.compute_signals(bars(), needed={'csg_attack'})
    assert result['csg_attack'].null_count() == len(result)
    assert pipeline.get_signal_dependencies()['csg_attack'] == frozenset({'close'})
    strategy = StrategyDef(meta={'id': 'formula', 'scoring': {}}, basic_filter={'enabled': False},
                           entry_signals=['csg_attack'], exit_signals=[], stop_loss=None, trailing_stop=None,
                           trailing_take_profit_activate=None, trailing_take_profit_drawdown=None,
                           max_hold_days=None, filter_fn=lambda _df, _p: pl.col('csg_attack'),
                           filter_history_fn=None, lookback_days=1, source='custom')
    plan = StrategyDependencyResolver().resolve(strategy, params={}, basic_filter={'enabled': False}, entry_signals=['csg_attack'], exit_signals=[])
    assert plan.warmup_bars == 150
    assert 'csg_attack' in plan.signal_columns
    assert 'close' in plan.base_columns
    period_signal = signal(formula='out:PERIOD=30;', output_var='out', min_history_bars=1)
    monkeypatch.setattr(pipeline, '_formula_signal_definitions', [period_signal])
    minute = bars().filter(pl.col('symbol') == 'A').head(3).with_columns(
        pl.Series('datetime', [datetime(2026, 1, 1, 9, 31), datetime(2026, 1, 1, 9, 32), datetime(2026, 1, 1, 10, 1)]),
    )
    aggregated = _prepare_30m_strategy_frame(minute)
    assert aggregated['csg_attack'].all()


def test_realtime_formula_history_is_reused_until_historical_data_changes(tmp_path, monkeypatch):
    from app import parquet
    from app.tickflow.repository import DataStore, KlineRepository

    repo = KlineRepository(DataStore(tmp_path))
    frame = bars().filter(pl.col('symbol') == 'A')
    repo.append_etf_enriched(frame)
    original = parquet.scan_enriched_parquet
    scans = []
    def scan(*args, **kwargs):
        scans.append(True)
        return original(*args, **kwargs)
    monkeypatch.setattr('app.tickflow.repository.scan_enriched_parquet', scan)
    before = date(2026, 2, 10)
    assert repo.get_formula_history('etf', before, 100).height == frame.height
    repo.get_formula_history('etf', before, 100)
    assert len(scans) == 1
    repo.append_etf_enriched(frame.tail(1).with_columns(pl.lit(106.).alias('close')))
    assert repo.get_formula_history('etf', before, 100)['close'][-1] == 106.
    assert len(scans) == 2


def test_incremental_quote_reuses_history_instead_of_single_snapshot(tmp_path, monkeypatch):
    from app.indicators import pipeline
    from app.services import quote_service

    source = bars().filter(pl.col('symbol') == 'A').head(31)
    current = source.tail(1)
    saved = []
    requested = []
    def history(_asset, _today, count):
        requested.append(count)
        return source.head(30)
    repo = SimpleNamespace(
        store=SimpleNamespace(data_dir=tmp_path),
        get_live_agg=lambda: pl.DataFrame({'symbol': ['A']}),
        get_enriched_latest=lambda: (source.tail(2).head(1), date(2026, 1, 30)),
        get_instruments=pl.DataFrame,
        get_formula_history=history,
        flush_live_enriched_asset=lambda _asset, frame: saved.append(frame),
    )
    monkeypatch.setattr(quote_service, 'cn_today', lambda: date(2026, 1, 31))
    monkeypatch.setattr(pipeline, 'compute_enriched_today', lambda **_kwargs: current)
    monkeypatch.setattr(pipeline, 'attach_deviation_columns_today', lambda frame, *_args: frame)
    monkeypatch.setattr(pipeline, '_formula_signal_definitions', [signal()])
    service = quote_service.QuoteService()
    service._repo = repo
    monkeypatch.setattr(service, 'get_index_quotes', pl.DataFrame)
    service._flush_live_enriched(current)
    assert requested == [22]
    assert saved[0]['csg_attack'].to_list() == [True]
    current = current.with_columns(pl.lit(90.).alias('close'))
    service._flush_live_enriched(current)
    assert saved[1]['csg_attack'].to_list() == [False]


def test_chart_backtest_and_strategy_use_the_same_formula_history(tmp_path, monkeypatch):
    from app.backtest.engine import BacktestEngine
    from app.backtest.strategy import StrategyDependencyResolver
    from app.config import settings
    from app.indicators import pipeline
    from app.services.strategy_chart import StrategyChartService
    from app.strategy.engine import StrategyDataContext, StrategyDef, StrategyEngine

    sig = signal()
    monkeypatch.setattr(settings, 'data_dir', tmp_path)
    custom_signals.save_one(tmp_path, sig)
    monkeypatch.setattr(pipeline, '_formula_signal_definitions', [sig])
    monkeypatch.setattr(pipeline, '_custom_signal_exprs', {})
    source = bars().filter(pl.col('symbol') == 'A').head(31)
    source = source.with_columns(pl.col('close').alias('raw_close'), pl.col('high').alias('raw_high'), pl.col('low').alias('raw_low'))
    strategy = StrategyDef(meta={'id': 'formula', 'scoring': {}, 'asset_types': ['stock', 'etf'], 'timeframes': ['1d', '30m', '1w']}, basic_filter={'enabled': False},
                           entry_signals=['csg_attack'], exit_signals=[], stop_loss=None, trailing_stop=None,
                           trailing_take_profit_activate=None, trailing_take_profit_drawdown=None,
                           max_hold_days=None, filter_fn=lambda _df, _p: pl.col('csg_attack'),
                           filter_history_fn=None, lookback_days=1, source='custom')
    repo = SimpleNamespace(store=SimpleNamespace(data_dir=tmp_path),
                           get_daily_asset=lambda *_args: source,
                           get_enriched_range=lambda *_args, **_kwargs: None,
                           get_instruments_asset=lambda _asset: pl.DataFrame({'symbol': ['A'], 'name': ['ETF'], 'limit_up': [121.], 'limit_down': [99.]}),
                           get_historical_shares=pl.DataFrame)
    plan = StrategyDependencyResolver().resolve(strategy, params={}, basic_filter={'enabled': False}, entry_signals=['csg_attack'], exit_signals=[])
    monkeypatch.setattr('app.backtest.engine.pl.scan_parquet', lambda *_args, **_kwargs: source.lazy())
    computed = BacktestEngine(repo).load_panel_for_backtest(['A'], date(2026, 1, 1), date(2026, 1, 31), plan, asset_type='etf')
    assert computed['csg_attack'][-1] is True
    markers = StrategyChartService(repo, None).signal_markers(symbol='A', asset_type='etf', timeframe='1d', signal_ids=['csg_attack'], start=date(2026, 1, 1), end=date(2026, 1, 31))
    assert len(markers) == 1 and markers[0]['date'].startswith('2026-01-31')
    engine = StrategyEngine(strategy_dirs=[])
    engine._strategies['formula'] = strategy
    assert engine.required_history_bars(['formula']) == 22
    context = StrategyDataContext(asset_type='etf', timeframe='1d', as_of=date(2026, 1, 31), current=source.tail(1), history=source)
    assert engine.run('formula', context).total == 1
    monkeypatch.setattr(pipeline, '_formula_signal_definitions', [signal(formula='out:BAD(CLOSE);')])
    with pytest.raises(ValueError, match='无法计算'):
        engine.run('formula', context)


def test_drawings_and_computation_limits():
    source = "out:CLOSE>0; DRAWTEXT(out,LOW,'进攻');"
    assert formula_signals.validate_formula(source, 'out') == ['out']
    assert formula_signals.inject(bars(), [signal(formula=source, output_var='out', min_history_bars=1)])['csg_attack'].all()
    huge = pl.DataFrame({'symbol': ['A'] * 20001, 'date': [date(2026, 1, 1)] * 20001, 'close': [1.] * 20001})
    with pytest.raises(ValueError, match='20000'):
        formula_signals.inject(huge, [signal()], {'csg_attack'})


def test_etf_realtime_full_fallback_keeps_declared_formula_warmup(tmp_path, monkeypatch):
    from app.indicators import pipeline
    from app.services import quote_service

    today = date(2026, 10, 21)
    frame = pl.DataFrame([{'symbol': 'A', 'date': today - timedelta(days=i), 'open': 100., 'high': 100., 'low': 100., 'close': 100., 'volume': 100., 'amount': 10000.} for i in range(1, 151)])
    partition = tmp_path / 'kline_etf_daily' / 'date=2026-10-20'
    partition.mkdir(parents=True)
    frame.write_parquet(partition / 'part.parquet')
    current = frame.head(1).with_columns(pl.lit(today).alias('date'), pl.lit(110.).alias('close'))
    captured = []
    service = quote_service.QuoteService()
    service._repo = SimpleNamespace(store=SimpleNamespace(data_dir=tmp_path),
                                    get_enriched_latest_asset=lambda _asset: (pl.DataFrame(), None),
                                    flush_live_enriched_asset=lambda _asset, frame: captured.append(frame))
    monkeypatch.setattr(quote_service, 'cn_today', lambda: today)
    monkeypatch.setattr(pipeline, '_formula_signal_definitions', [signal(min_history_bars=150)])
    monkeypatch.setattr(pipeline, '_custom_signal_exprs', {})
    service._flush_live_enriched(current, asset_type='etf')
    assert len(captured) == 1
    assert captured[0]['csg_attack'].to_list() == [True]
