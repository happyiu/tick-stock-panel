"""a-stock-data provider 的无网络契约测试。"""

from __future__ import annotations

from datetime import date, datetime
from pathlib import Path

import pandas as pd

from app.plugins.astockdata import provider as ap
from app.plugins.astockdata.provider import AStockDataProvider


class _FakeTdx:
    def __init__(self, frame: pd.DataFrame):
        self.frame = frame
        self.calls: list[dict] = []

    def bars(self, **kwargs):
        self.calls.append(kwargs)
        return self.frame


def _bars() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "open": [10.0, 10.2],
            "high": [10.4, 10.5],
            "low": [9.9, 10.1],
            "close": [10.2, 10.4],
            "vol": [1000, 1200],
            "amount": [10000, 12000],
        },
        index=pd.DatetimeIndex(pd.to_datetime(["2026-09-01", "2026-09-02"]), name="datetime"),
    )


def test_daily_uses_mootdx_raw_bars_and_normalizes_symbol(monkeypatch):
    provider = AStockDataProvider()
    fake = _FakeTdx(_bars())
    monkeypatch.setattr(provider, "_get_tdx", lambda: fake)

    frame = provider.get_daily(["600519.SH"], datetime(2026, 9, 1), datetime(2026, 9, 2))

    assert frame.columns == ["symbol", "date", "open", "high", "low", "close", "volume", "amount"]
    assert frame.height == 2
    assert frame["symbol"].unique().to_list() == ["600519.SH"]
    assert frame["volume"].to_list() == [1000.0, 1200.0]
    assert fake.calls[0]["frequency"] == 9


def test_minute_converts_datetime_and_keeps_canonical_columns(monkeypatch):
    provider = AStockDataProvider()
    minute = _bars()
    minute.index = pd.DatetimeIndex(
        pd.to_datetime(["2026-09-02 09:35", "2026-09-02 09:36"]), name="datetime"
    )
    fake = _FakeTdx(minute)
    monkeypatch.setattr(provider, "_get_tdx", lambda: fake)

    frame = provider.get_minute(["600519.SH"], datetime(2026, 9, 2), datetime(2026, 9, 2, 10))

    assert set(frame.columns) == {
        "symbol",
        "datetime",
        "open",
        "high",
        "low",
        "close",
        "volume",
        "amount",
    }
    assert frame.height == 2
    assert (frame["datetime"][0].hour, frame["datetime"][0].minute) == (9, 35)
    assert fake.calls[0]["frequency"] == 8


def test_default_minute_window_fits_mootdx_limit(monkeypatch):
    provider = AStockDataProvider()
    fake = _FakeTdx(_bars())
    monkeypatch.setattr(provider, "_get_tdx", lambda: fake)

    frame = provider.get_minute(["600519.SH"], None, None)

    assert frame.height == 2


def test_minute_falls_back_to_tencent_when_mootdx_is_unavailable(monkeypatch):
    provider = AStockDataProvider()
    monkeypatch.setattr(ap, "_tdx_client", lambda: (_ for _ in ()).throw(RuntimeError("offline")))

    class _Response:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "data": {
                    "sh600519": {
                        "m1": [
                            ["202609040935", "1200", "1201", "1202", "1199", "10", {}, "0.1"],
                            ["202609040936", "1201", "1202", "1203", "1200", "20", {}, "0.2"],
                        ]
                    }
                }
            }

    calls: list[str] = []

    def fake_get(url, **kwargs):
        calls.append(url)
        return _Response()

    monkeypatch.setattr(ap, "_http_get", fake_get)
    frame = provider.get_minute(
        ["600519.SH"], datetime(2026, 9, 4, 9, 30), datetime(2026, 9, 4, 10)
    )

    assert frame.height == 2
    assert frame["amount"].to_list() == [1_200_500.0, 2_403_000.0]
    assert calls == ["https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=sh600519,m1,,320"]


def test_factor_staircase_becomes_event_ratios(monkeypatch):
    provider = AStockDataProvider()
    monkeypatch.setattr(
        provider,
        "_get_tdx",
        lambda: (_ for _ in ()).throw(AssertionError("adj_factor 不应连接 mootdx")),
    )
    monkeypatch.setattr(
        ap,
        "_sina_factors",
        lambda code, market: [
            {"date": "1900-01-01", "factor": 1.0},
            {"date": "2026-01-01", "factor": 2.0},
            {"date": "2026-06-01", "factor": 3.0},
        ],
    )

    frame = provider.get_adj_factors(["600519.SH"], date(2026, 1, 1), date(2026, 12, 31))

    assert frame["trade_date"].to_list() == [date(2026, 1, 1), date(2026, 6, 1)]
    assert frame["ex_factor"].to_list() == [2.0, 1.5]


def test_tencent_parser_converts_percent_and_amount_units():
    values = [""] * 53
    values[1] = "贵州茅台"
    values[3] = "1200"
    values[4] = "1194"
    values[5] = "1186"
    values[6] = "12345"
    values[31] = "6"
    values[32] = "-1.15"
    values[33] = "1203"
    values[34] = "1180"
    values[37] = "159095"
    values[38] = "4.55"
    values[43] = "2.1"
    values[47] = "1313.4"
    values[48] = "1074.6"

    rows = ap._parse_tencent(f'v_sh600519="{"~".join(values)}";', 123)

    assert len(rows) == 1
    assert rows[0]["symbol"] == "600519.SH"
    assert rows[0]["volume"] == 12345
    assert rows[0]["change_pct"] == -0.0115
    assert rows[0]["amount"] == 1_590_950_000
    assert rows[0]["turnover_rate"] == 0.0455


def test_tencent_parser_keeps_missing_optional_values_null():
    values = [""] * 53
    values[1] = "贵州茅台"
    values[3] = "1200"
    values[4] = "1194"
    rows = ap._parse_tencent(f'v_sh600519="{"~".join(values)}";', 123)

    assert rows[0]["amount"] is None
    assert rows[0]["change_pct"] is None
    assert rows[0]["turnover_rate"] is None


def test_realtime_uses_requested_symbols_without_listing_request(monkeypatch):
    values = [""] * 53
    values[1] = "贵州茅台"
    values[3] = "1200"
    values[4] = "1194"
    values[5] = "1186"
    values[6] = "12345"
    values[37] = "1"
    values[32] = "0.5"

    class _Response:
        content = f'v_sh600519="{"~".join(values)}";'.encode("gbk")
        text = content.decode("gbk")

        def raise_for_status(self):
            return None

    calls: list[str] = []

    def fake_get(url, **kwargs):
        calls.append(url)
        return _Response()

    monkeypatch.setattr(ap, "_http_get", fake_get)
    rows = AStockDataProvider().get_realtime(symbols=["600519.SH"])

    assert rows[0]["symbol"] == "600519.SH"
    assert calls == ["https://qt.gtimg.cn/q=sh600519"]


def test_manifest_declares_standard_datasets():
    import yaml

    manifest = yaml.safe_load(
        (Path(__file__).parents[1] / "app" / "plugins" / "astockdata" / "plugin.yaml").read_text(
            encoding="utf-8"
        )
    )
    assert manifest["name"] == "astockdata"
    assert manifest["runtime"] == "python"
    assert manifest["install_no_deps"] is True
    assert set(manifest["datasets"]) == {"daily", "adj_factor", "minute", "realtime"}
    assert "financial" not in manifest["datasets"]


def test_mootdx_failure_returns_empty_daily(monkeypatch):
    provider = AStockDataProvider()
    monkeypatch.setattr(ap, "_tdx_client", lambda: (_ for _ in ()).throw(RuntimeError("offline")))
    assert provider.get_daily(["600519.SH"], None, None).is_empty()
