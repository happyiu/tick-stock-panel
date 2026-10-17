"""个股分析 / 关键价位的日K窗口右端必须是北京日期, 不能用服务器本地 date.today()。

CONTRIBUTING §3.3: A 股交易时段按北京时间, 服务器时区不能成为隐式输入。
助手工具 get_stock_daily / get_stock_analysis 已改用 cn_today()
(test_assistant_beijing_today), 但个股分析页的两条读路径仍是 date.today():

- stock_analyzer._load_kline: AI 四维分析注入的最近 N 根日 K
- stock_analysis.get_levels: 图表关键价位 / markLine 数据源

美西主机整个 A 股交易时段、UTC 主机北京 00:00-08:00, 本地日历日比北京
早一天: 管道已写入的当日官方 K 被排除, 分析与价位停在昨天。
"""
from __future__ import annotations

from datetime import date
from types import SimpleNamespace

import polars as pl

from app.api import stock_analysis as stock_analysis_api
from app.services import stock_analyzer

BJ = date(2026, 3, 2)  # 钉死的北京日期, 不会碰巧等于跑测试那天的 date.today()


class _Repo:
    def __init__(self) -> None:
        self.windows: list[tuple[date, date]] = []

    def resolve_asset_type(self, symbol: str) -> str:
        return "stock"

    def get_daily_asset(self, asset_type, symbol, start, end, columns=None) -> pl.DataFrame:
        self.windows.append((start, end))
        return pl.DataFrame()


def test_load_kline_window_ends_on_beijing_today(monkeypatch) -> None:
    """AI 个股分析读日K的窗口右端必须是北京今天。

    raising=False: 未修复代码没有调用 cn_today, 钉了也不会被用到,
    仍走 date.today() → 与 2026-03-02 不等。
    """
    monkeypatch.setattr(stock_analyzer, "cn_today", lambda: BJ, raising=False)
    repo = _Repo()
    stock_analyzer._load_kline(repo, "600000.SH")
    assert repo.windows, "应查询日K"
    _start, end = repo.windows[0]
    assert end == BJ, f"窗口右端必须是北京日期 {BJ}, 实际 {end} (服务器本地 {date.today()})"
    assert end != date.today()


def test_levels_window_ends_on_beijing_today(monkeypatch) -> None:
    """/api/stock-analysis/levels 未传日期时窗口右端必须是北京今天。

    raising=False: 未修复代码没有调用 cn_today, 钉了也不会被用到。
    """
    monkeypatch.setattr(stock_analysis_api, "cn_today", lambda: BJ, raising=False)
    repo = _Repo()
    req = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(repo=repo)))
    stock_analysis_api.get_levels(req, symbol="600000.SH", days=120)
    assert repo.windows, "应查询日K"
    _start, end = repo.windows[0]
    assert end == BJ, f"窗口右端必须是北京日期 {BJ}, 实际 {end} (服务器本地 {date.today()})"
    assert end != date.today()


def test_levels_historical_cutoff_excludes_future_rows(monkeypatch) -> None:
    monkeypatch.setattr(stock_analysis_api, "cn_today", lambda: BJ)
    cutoff = date(2026, 2, 27)

    class Repo(_Repo):
        def get_daily_asset(self, asset_type, symbol, start, end, columns=None):
            self.windows.append((start, end))
            return pl.DataFrame({
                "date": [date(2026, 2, 26), cutoff, BJ],
                "open": [10., 11., 100.], "high": [11., 12., 110.],
                "low": [9., 10., 90.], "close": [10., 11., 100.],
            })

    repo = Repo()
    req = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(repo=repo)))
    result = stock_analysis_api.get_levels(req, symbol="600000.SH", days=120, end_date=cutoff)
    assert repo.windows[0][1] == cutoff
    assert result["dates"] == ["2026-02-26", "2026-02-27"]
    assert result["close"] == 11.
    assert all(level["value"] < 100 for group in result["levels"].values() for level in group)


def test_levels_api_cutoff_validation_and_empty_response(monkeypatch) -> None:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    monkeypatch.setattr(stock_analysis_api, "cn_today", lambda: BJ)
    app = FastAPI()
    app.include_router(stock_analysis_api.router)
    app.state.repo = _Repo()
    with TestClient(app) as client:
        invalid = client.get("/api/stock-analysis/levels", params={"symbol": "A", "end_date": "invalid"})
        assert invalid.status_code == 422
        assert not app.state.repo.windows
        for end_date, expected in [("2026-02-27", date(2026, 2, 27)), ("2099-01-01", BJ)]:
            response = client.get("/api/stock-analysis/levels", params={"symbol": "A", "end_date": end_date})
            assert response.status_code == 200
            assert response.json()["close"] is None
            assert response.json()["dates"] == []
            assert all(not group for group in response.json()["levels"].values())
            assert app.state.repo.windows[-1][1] == expected
