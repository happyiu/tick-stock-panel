"""ETF asset_type metadata and monitor event contract tests."""
from __future__ import annotations

from datetime import date
from types import SimpleNamespace

import polars as pl

from app.api import alerts as alerts_api
from app.api import kline as kline_api
from app.api import monitor_rules as monitor_rules_api
from app.api import stock_analysis as stock_analysis_api
from app.services import quote_service
from app.services.quote_service import QuoteService


class _AssetRepo:
    def __init__(self, data_dir):
        self.store = SimpleNamespace(data_dir=data_dir)

    def resolve_asset_type(self, symbol: str) -> str:
        return "etf" if symbol == "510300.SH" else "stock"

    def get_instruments_asset(self, asset_type: str) -> pl.DataFrame:
        if asset_type == "etf":
            return pl.DataFrame({"symbol": ["510300.SH"], "name": ["沪深300ETF"]})
        return pl.DataFrame()

    def get_daily_asset(self, asset_type, symbol, start, end, columns=None) -> pl.DataFrame:
        return pl.DataFrame({
            "date": [date(2026, 9, 3)],
            "symbol": [symbol],
            "open": [4.1201],
            "high": [4.1302],
            "low": [4.1103],
            "close": [4.1234],
            "volume": [100000.0],
        })

    def get_enriched_latest_asset(self, asset_type: str, refresh: bool = True):
        return pl.DataFrame(), None

    def get_name_map(self):
        return {}


def _request(repo):
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(repo=repo, quote_service=None)))


def test_daily_and_levels_expose_asset_type_without_rounding_close(tmp_path):
    repo = _AssetRepo(tmp_path)
    request = _request(repo)

    daily = kline_api.get_daily(
        request, symbol="510300.SH", days=30,
        start_date=None, end_date=None, ext_columns=None,
    )
    levels = stock_analysis_api.get_levels(request, symbol="510300.SH", days=30)

    assert daily["asset_type"] == "etf"
    assert daily["rows"][0]["close"] == 4.1234
    assert levels["asset_type"] == "etf"


def test_legacy_alert_list_fills_asset_type(monkeypatch, tmp_path):
    repo = _AssetRepo(tmp_path)
    monkeypatch.setattr(
        alerts_api.alert_store,
        "list_recent",
        lambda *args, **kwargs: [{"symbol": "510300.SH", "price": 4.1234}],
    )
    monkeypatch.setattr(alerts_api.alert_store, "count", lambda *_args: 1)

    result = alerts_api.list_alerts(_request(repo))

    assert result["alerts"][0]["asset_type"] == "etf"


class _EtfEngine:
    rule_count = 1

    def __init__(self, event):
        self.event = event
        self.evaluated_asset_type = None

    def has_rule_type(self, rule_type: str) -> bool:
        return False

    def has_asset_rules(self, asset_type: str) -> bool:
        return asset_type == "etf"

    def set_name_map(self, _name_map):
        pass

    def evaluate(self, _df, *, asset_type: str, reset_strategy_results=True):
        self.evaluated_asset_type = asset_type
        return [self.event]


def test_monitor_sse_event_preserves_etf_asset_type(monkeypatch, tmp_path):
    event = {
        "source": "signal",
        "type": "signal",
        "rule_id": "etf-rule",
        "symbol": "510300.SH",
        "name": "沪深300ETF",
        "asset_type": "etf",
        "message": "ETF signal",
        "price": 4.1234,
        "change_pct": 0.01,
        "signals": [],
        "severity": "info",
        "conditions": [],
        "logic": "and",
    }
    repo = _AssetRepo(tmp_path)
    engine = _EtfEngine(event)
    service = QuoteService.__new__(QuoteService)
    service._repo = repo
    service._app_state = SimpleNamespace(repo=repo, monitor_engine=engine)
    service._abnormal_last_eval = 0.0
    repo.get_enriched_latest_asset = lambda _asset_type, refresh=True: (
        pl.DataFrame({"symbol": ["510300.SH"], "close": [4.1234]}),
        date(2026, 9, 4),
    )
    service.get_enriched_today = lambda: (pl.DataFrame(), None)
    service._inject_intraday_signals = lambda df, _engine, _asset_type: df
    service._format_extension_notifications = lambda events: events
    service._enrich_alerts_ext = lambda _alerts: None
    service._maybe_send_system_notifications = lambda _alerts: None
    service._maybe_send_webhook = lambda _events, _engine: None
    pushed = []
    service._broadcast_alerts = pushed.extend

    monkeypatch.setattr(QuoteService, "_is_continuous_trading", staticmethod(lambda: True))
    monkeypatch.setattr(quote_service, "cn_today", lambda: date(2026, 9, 4))

    service._evaluate_monitors(pl.DataFrame(), None)

    assert engine.evaluated_asset_type == "etf"
    assert pushed[0]["asset_type"] == "etf"


class _RuleRepo:
    def resolve_asset_type(self, symbol: str) -> str:
        return {"510300.SH": "etf", "000001.SH": "index"}.get(symbol, "stock")


def test_reconcile_corrects_etf_only_rule_but_keeps_mixed_pool():
    repo = _RuleRepo()
    reconcile = monitor_rules_api._reconcile_index_asset_type

    assert reconcile(
        {"asset_type": "stock", "scope": "symbols", "symbols": ["510300.SH"]}, repo,
    )["asset_type"] == "etf"
    assert reconcile(
        {"asset_type": "stock", "scope": "symbols", "symbols": ["510300.SH", "000001.SH"]}, repo,
    )["asset_type"] == "stock"
