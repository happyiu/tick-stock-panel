from datetime import date, datetime
from types import SimpleNamespace

import polars as pl
import pytest

from app.data_providers import custom
from app.services import index_sync, preferences
from app.tickflow.capabilities import CapabilitySet
from app.tickflow.repository import DataStore, KlineRepository


def _bar():
    return pl.DataFrame({
        'symbol': ['510300.SH'], 'date': [date(2026, 10, 21)],
        'open': [4.0], 'high': [4.2], 'low': [3.9], 'close': [4.1],
        'volume': [100.0], 'amount': [41000.0],
    })


def test_etf_route_defaults_and_is_independent_of_stock_route(monkeypatch):
    monkeypatch.setattr(preferences, 'load', lambda: {'daily_data_provider': 'astockdata'})
    assert preferences.get_etf_daily_data_provider() == 'tickflow'
    monkeypatch.setattr(preferences, 'load', lambda: {'etf_daily_data_provider': 'missing'})
    assert preferences.get_etf_daily_data_provider() == 'tickflow'
    monkeypatch.setattr(preferences, '_allowed_data_providers', lambda: {'tickflow', 'astockdata'})
    monkeypatch.setattr(preferences, 'load', lambda: {'etf_daily_data_provider': 'astockdata'})
    assert preferences.get_etf_daily_data_provider() == 'astockdata'


def test_custom_etf_daily_sync_passes_asset_and_writes_only_etf_partitions(tmp_path, monkeypatch):
    repo = KlineRepository(DataStore(tmp_path))
    calls = []
    class Provider:
        def get_daily(self, symbols, **kwargs):
            calls.append((symbols, kwargs))
            return _bar()
    monkeypatch.setattr(preferences, 'get_etf_daily_data_provider', lambda: 'astockdata')
    monkeypatch.setattr(custom, 'provider_has_dataset', lambda name, dataset: dataset == 'etf_daily')
    monkeypatch.setattr(custom, 'get_provider', lambda name: Provider())
    monkeypatch.setattr(index_sync.kline_sync, 'sync_daily_batch', lambda *a, **kw: pytest.fail('不应请求 TickFlow'))
    written = index_sync.sync_and_persist_etf_daily(
        repo, CapabilitySet({}), symbols_override=['510300.SH'],
        start_date=datetime(2026, 10, 21), end_date=datetime(2026, 10, 21),
    )
    assert written == 1
    assert calls[0][0] == ['510300.SH']
    assert calls[0][1]['asset_type'] == 'etf'
    assert calls[0][1]['start_time'] == datetime(2026, 10, 21)
    assert list((tmp_path / 'kline_etf_daily').rglob('*.parquet'))
    assert list((tmp_path / 'kline_etf_enriched').rglob('*.parquet'))
    assert not list((tmp_path / 'kline_daily').rglob('*.parquet'))


def test_unsupported_etf_source_fails_without_cross_source_fallback(tmp_path, monkeypatch):
    monkeypatch.setattr(preferences, 'get_etf_daily_data_provider', lambda: 'fuyao')
    monkeypatch.setattr(custom, 'provider_has_dataset', lambda *a: False)
    repo = KlineRepository(DataStore(tmp_path))
    with pytest.raises(ValueError, match='ETF'):
        index_sync.sync_and_persist_etf_daily(repo, CapabilitySet({}), symbols_override=['510300.SH'])
    assert not list((tmp_path / 'kline_etf_daily').rglob('*.parquet'))


def test_etf_provider_preference_api_roundtrip(monkeypatch):
    from app.api import settings as settings_api
    monkeypatch.setattr(preferences, '_allowed_data_providers', lambda: {'tickflow', 'astockdata'})
    stored = {}
    monkeypatch.setattr(preferences, 'save', lambda updates: stored.update(updates))
    monkeypatch.setattr(preferences, 'load', lambda: dict(stored))
    monkeypatch.setattr(settings_api, 'detect_capabilities', lambda: CapabilitySet({}))
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace()))
    result = settings_api.update_data_providers(settings_api.DataProvidersIn(etf_daily_data_provider='astockdata'), request)
    assert stored['etf_daily_data_provider'] == 'astockdata'
    assert result['etf_daily_data_provider'] == 'astockdata'


def test_generic_http_source_uses_explicit_etf_dataset(monkeypatch):
    from app.data_providers.custom.config import config_from_dict
    from app.data_providers.custom.provider import GenericHTTPProvider
    fields = {key: key for key in _bar().columns}
    cfg = config_from_dict({'name': 'http_etf', 'datasets': {
        'daily': {'url': 'https://example.test/stocks', 'field_map': fields},
        'etf_daily': {'url': 'https://example.test/etfs', 'field_map': fields},
    }})
    provider = GenericHTTPProvider(cfg)
    calls = []
    monkeypatch.setattr(provider, '_request_rows_retry', lambda cfg, *a, **kw: (calls.append(cfg.url) or _bar().to_dicts()))
    try:
        assert provider.validate() == []
        assert provider.get_daily(['510300.SH'], None, None, asset_type='etf').height == 1
        assert calls == ['https://example.test/etfs']
        provider.get_daily(['600519.SH'], None, None)
        assert calls[-1] == 'https://example.test/stocks'
    finally:
        provider.close()


@pytest.mark.parametrize('usable', [True, False])
def test_etf_history_api_gate_follows_routed_capability(monkeypatch, usable):
    import asyncio

    from fastapi import HTTPException

    from app.api import kline
    from app.data_providers import capabilities
    from app.services import pipeline_jobs

    monkeypatch.setattr(capabilities, 'build_capability_matrix', lambda *a, **kw: {
        'capabilities': [{'id': 'etf_daily', 'usable': usable}],
    })
    monkeypatch.setattr(pipeline_jobs.job_store, 'create', lambda **kw: ('existing', False))
    class Request:
        app = SimpleNamespace(state=SimpleNamespace(repo=None, capabilities=CapabilitySet({})))
        async def json(self):
            return {'value': 1, 'unit': 'year'}
    if usable:
        assert asyncio.run(kline.extend_etf_history(Request())) == {'status': 'reused', 'job_id': 'existing'}
    else:
        with pytest.raises(HTTPException) as exc:
            asyncio.run(kline.extend_etf_history(Request()))
        assert exc.value.status_code == 403
        assert 'ETF池日K' in exc.value.detail
