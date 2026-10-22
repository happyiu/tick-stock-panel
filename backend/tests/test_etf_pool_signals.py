"""ETF daily signal filtering runs before sorting and pagination."""
from datetime import date
from types import SimpleNamespace

import polars as pl
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.kline import router
from app.services.etf_pool import list_etfs
from app.services.screener import ScreenerService
from app.strategy import custom_signals


@pytest.fixture()
def repo(tmp_path):
    latest = date(2026, 10, 21)
    frame = pl.DataFrame({
        "symbol": ["510001.SH", "510002.SH", "510003.SH", "510004.SH"],
        "date": [latest, latest, latest, date(2026, 10, 20)],
        "signal_macd_golden": [True, True, None, True],
        "signal_ma_golden_5_20": [True, False, True, True],
    })
    return SimpleNamespace(
        store=SimpleNamespace(data_dir=tmp_path),
        get_etf_instruments=lambda: pl.DataFrame({"symbol": frame["symbol"], "name": ["沪深300ETF"] * 4}),
        get_etf_quote_snapshot=lambda symbols: pl.DataFrame({"symbol": symbols, "change_pct": [float(s[5]) / 100 for s in symbols]}),
        get_enriched_latest_asset=lambda _asset: (frame, latest),
        get_matrix_data_generation=lambda _asset: "generation-1",
    )


def test_all_any_nulls_stale_rows_sort_and_pagination(repo):
    ids = ["signal_macd_golden", "signal_ma_golden_5_20"]
    result = list_etfs(repo, signal_ids=ids)
    assert [row["symbol"] for row in result["rows"]] == ["510001.SH"]
    assert result["signal_date"] == "2026-10-21"
    result = list_etfs(repo, signal_ids=ids, signal_match="any", sort_change_pct="desc", page_size=1, page=2)
    assert result["total"] == 3
    assert result["catalog_total"] == 4
    assert [row["symbol"] for row in result["rows"]] == ["510002.SH"]
    assert list_etfs(repo, q="不存在", signal_ids=ids)["rows"] == []


@pytest.mark.parametrize("ids", [["unknown"], ["signal_limit_up"], ["csg_deleted"], ["signal_macd_golden"] * 33])
def test_invalid_signals_fail_explicitly(repo, ids):
    with pytest.raises(ValueError):
        list_etfs(repo, signal_ids=ids)


def test_api_and_missing_data(repo):
    app = FastAPI()
    app.include_router(router)
    app.state.repo = repo
    with TestClient(app) as client:
        payload = client.get("/api/kline/etf-pool", params={"signal_ids": "signal_macd_golden,signal_ma_golden_5_20", "signal_match": "any"}).json()
        assert payload["total"] == 3
        assert client.get("/api/kline/etf-pool", params={"signal_ids": "unknown"}).status_code == 422
        assert client.get("/api/kline/etf-pool", params={"signal_match": "bad"}).status_code == 422
        repo.get_enriched_latest_asset = lambda _asset: (pl.DataFrame(), None)
        payload = client.get("/api/kline/etf-pool", params={"signal_ids": "signal_macd_golden"}).json()
        assert payload["rows"] == []
        assert payload["signal_date"] is None
        assert payload["signal_warnings"]


def test_missing_signal_column_is_not_silently_ignored(repo, monkeypatch):
    repo.get_enriched_latest_asset = lambda _asset: (pl.DataFrame({"symbol": ["510001.SH"], "date": [date(2026, 10, 21)]}), date(2026, 10, 21))
    monkeypatch.setattr(ScreenerService, '_load_enriched_history', lambda *_args, **_kwargs: pl.DataFrame())
    with pytest.raises(ValueError, match="计算"):
        list_etfs(repo, signal_ids=["signal_macd_golden"])


@pytest.mark.parametrize("definition_type", ["conditions", "formula"])
def test_custom_signal_uses_history_and_changes_invalidate_cached_result(tmp_path, monkeypatch, definition_type):
    from app.config import settings
    from app.indicators.pipeline import invalidate_custom_signals
    from app.tickflow.repository import DataStore, KlineRepository

    monkeypatch.setattr(settings, "data_dir", tmp_path)
    repo = KlineRepository(DataStore(tmp_path))
    repo.save_etf_instruments(pl.DataFrame({"symbol": ["510001.SH"], "name": ["沪深300ETF"]}))
    for day, close in (("2026-10-20", 1.), ("2026-10-21", 2.)):
        path = tmp_path / "kline_etf_enriched" / f"date={day}"
        path.mkdir(parents=True)
        pl.DataFrame({"symbol": ["510001.SH"], "date": [date.fromisoformat(day)], "open": [close], "high": [close], "low": [close], "close": [close], "raw_close": [close], "volume": [100.], "amount": [100.], "turnover_rate": [1.]}).write_parquet(path / "part.parquet")
    sig = {"id": "rise", "name": "比昨日上涨", "kind": "entry", "enabled": True, "conditions": [{"left": "close", "op": ">", "right": "field:close", "rightDays": 1}]}
    if definition_type == "formula":
        sig.update(definition_type="formula", formula="rise:CLOSE>REF(CLOSE,1);", output_var="rise", min_history_bars=2)
    try:
        custom_signals.save_one(tmp_path, sig)
        invalidate_custom_signals()
        assert list_etfs(repo, signal_ids=["csg_rise"])["total"] == 1
        # 同一天行情发生变化, 不能继续使用旧历史计算缓存。
        repo.merge_live_enriched_asset("etf", pl.DataFrame({
            "symbol": ["510001.SH"], "date": [date(2026, 10, 21)],
            "open": [.5], "high": [.5], "low": [.5], "close": [.5], "raw_close": [.5],
            "volume": [100.], "amount": [50.], "turnover_rate": [1.],
        }))
        assert list_etfs(repo, signal_ids=["csg_rise"])["total"] == 0
        sig["conditions"][0]["op"] = "<"
        if definition_type == "formula":
            sig["formula"] = "rise:CLOSE<REF(CLOSE,1);"
        custom_signals.save_one(tmp_path, sig)
        invalidate_custom_signals()
        repo.clear_cache()
        assert list_etfs(repo, signal_ids=["csg_rise"])["total"] == 1
        sig["enabled"] = False
        custom_signals.save_one(tmp_path, sig)
        with pytest.raises(ValueError):
            list_etfs(repo, signal_ids=["csg_rise"])
    finally:
        invalidate_custom_signals()
        ScreenerService.clear_history_cache()
