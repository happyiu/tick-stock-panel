"""ETF catalog filtering, classification and HTTP boundary tests."""
from types import SimpleNamespace

import polars as pl
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.kline import router
from app.services.etf_pool import list_etfs


class Repo:
    def get_etf_quote_snapshot(self, _symbols):
        return pl.DataFrame()

    def get_etf_instruments(self):
        return pl.DataFrame({
            "symbol": ["510300.SH", "159605.SZ", "511010.SH", "518880.SH", "159001.SZ", "512480.SH", "159999.SZ"],
            "name": ["沪深300ETF", "中概互联ETF广发", "国债ETF", "黄金ETF", "货币ETF", "半导体ETF", None],
        })


def test_categories_search_exchange_and_pagination():
    repo = Repo()
    result = list_etfs(repo, page=1, page_size=2)
    assert result["total"] == result["catalog_total"] == 7
    assert [r["symbol"] for r in result["rows"]] == ["159001.SZ", "159605.SZ"]
    assert result["rows"][1]["category"] == "跨境"
    assert sum(c["count"] for c in result["categories"]) == 7
    assert list_etfs(repo, page=2, page_size=2)["rows"][0]["symbol"] == "159999.SZ"
    assert list_etfs(repo, q=" etf广发 ")["rows"][0]["symbol"] == "159605.SZ"
    assert list_etfs(repo, q="5103", category="宽基", exchange="SH")["total"] == 1
    assert list_etfs(repo, category="债券", exchange="SZ")["total"] == 0
    assert list_etfs(repo, page=99)["rows"] == []
    assert list_etfs(repo, page=10**30)["rows"] == []
    assert list_etfs(repo, q="不存在")["categories"] == result["categories"]


def test_empty_and_legacy_missing_fields():
    empty = SimpleNamespace(get_etf_instruments=lambda: pl.DataFrame())
    assert list_etfs(empty)["rows"] == []
    assert list_etfs(empty)["total"] == 0
    legacy = SimpleNamespace(get_etf_instruments=lambda: pl.DataFrame({"symbol": ["510300.SH", "510300.SH", None]}), get_etf_quote_snapshot=lambda _: pl.DataFrame())
    assert list_etfs(legacy)["rows"] == [
        {"symbol": "510300.SH", "code": "510300", "name": "", "category": "其他", "exchange": "SH", "last_price": None, "change_pct": None, "quote_date": None},
    ]


def test_api_validation_and_repository_failure():
    app = FastAPI()
    app.include_router(router)
    app.state.repo = Repo()
    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.get("/api/kline/etf-pool", params={"category": "商品", "page_size": 1})
        assert response.status_code == 200
        assert response.json()["rows"][0]["symbol"] == "518880.SH"
        for params in ({"page": 0}, {"page_size": 201}, {"exchange": "UNKNOWN"}, {"category": "INVALID"}):
            assert client.get("/api/kline/etf-pool", params=params).status_code == 422
        def fail():
            raise RuntimeError("unavailable")
        app.state.repo = SimpleNamespace(get_etf_instruments=fail)
        assert client.get("/api/kline/etf-pool").status_code == 500


@pytest.mark.parametrize(("name", "category"), [
    ("恒生科技ETF", "跨境"), ("纳斯达克ETF", "跨境"), ("标普500ETF", "跨境"),
    ("国债ETF", "债券"), ("黄金ETF", "商品"), ("货币ETF", "货币"),
    ("沪深300ETF", "宽基"), ("科创50ETF", "宽基"), ("半导体ETF", "行业主题"),
    ("黄金股ETF", "行业主题"), ("黄金产业ETF", "行业主题"),
    ("红利低波ETF", "策略风格"), ("未知ETF", "其他"),
])
def test_classification(name, category):
    repo = SimpleNamespace(get_etf_instruments=lambda: pl.DataFrame({"symbol": ["510000.SH"], "name": [name]}), get_etf_quote_snapshot=lambda _: pl.DataFrame())
    assert list_etfs(repo)["rows"][0]["category"] == category


def test_quote_batch_is_limited_to_current_page_and_missing_values_stay_null():
    calls = []
    repo = Repo()
    def quotes(symbols):
        calls.append(symbols)
        return pl.DataFrame({"symbol": ["159605.SZ"], "last_price": [1.2345], "change_pct": [.0123], "quote_date": ["2026-10-20"]})
    repo.get_etf_quote_snapshot = quotes
    rows = list_etfs(repo, page_size=2)["rows"]
    assert calls == [["159001.SZ", "159605.SZ"]]
    assert rows[0]["last_price"] is None
    assert rows[0]["change_pct"] is None
    assert rows[1]["last_price"] == 1.2345
    assert rows[1]["change_pct"] == .0123
    assert rows[1]["quote_date"] == "2026-10-20"

    app = FastAPI()
    app.include_router(router)
    app.state.repo = repo
    with TestClient(app) as client:
        payload = client.get("/api/kline/etf-pool", params={"page_size": 2}).json()
        assert payload["rows"][1]["last_price"] == 1.2345
        assert payload["rows"][1]["change_pct"] == .0123
