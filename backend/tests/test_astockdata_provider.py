"""a-stock-data provider 的无网络契约测试。"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from pathlib import Path

import pandas as pd
import pytest

from app.plugins.astockdata import provider as ap
from app.plugins.astockdata.provider import AStockDataProvider


def test_native_30m_routes_etf_and_uses_frequency_two(monkeypatch):
    provider = AStockDataProvider()
    frame = _bars()
    frame.index = pd.DatetimeIndex(pd.to_datetime(["2026-09-02 10:00", "2026-09-02 10:30"]), name="datetime")
    fake = _FakeTdx(frame)
    monkeypatch.setattr(provider, "_get_tdx", lambda: fake)
    result = provider.get_minute(["510300.SH"], datetime(2026, 9, 2), datetime(2026, 9, 3), asset_type="etf", freq="30m")
    assert fake.calls[0]["frequency"] == 2
    assert result["symbol"].unique().to_list() == ["510300.SH"]
    assert result.height == 2


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("510300.SH", ("510300", "sh", "510300.SH")),
        ("588000.SH", ("588000", "sh", "588000.SH")),
        ("000016.SH", ("000016", "sh", "000016.SH")),
        ("920982.BJ", ("920982", "bj", "920982.BJ")),
        ("832982.BJ", ("832982", "bj", "832982.BJ")),
        ("000001.SZ", ("000001", "sz", "000001.SZ")),
    ],
)
def test_market_routing_matches_upstream_v371_v372(raw, expected):
    assert ap._symbol_parts(raw) == expected


def test_market_routing_rejects_mismatched_bse_suffix():
    with pytest.raises(ValueError, match="市场标识与号段矛盾"):
        ap._symbol_parts("920982.SH")


def test_factor_transport_failure_is_not_an_empty_event_list(monkeypatch):
    def fail(*args):
        raise RuntimeError("offline")
    monkeypatch.setattr(ap, "_sina_factors", fail)
    with pytest.raises(RuntimeError, match="除权因子获取失败"):
        AStockDataProvider().get_adj_factors(["510300.SH"], None, None, asset_type="etf")


class _FakeTdx:
    def __init__(self, frame: pd.DataFrame):
        self.frame = frame
        self.calls: list[dict] = []

    def bars(self, **kwargs):
        self.calls.append(kwargs)
        return self.frame

    def quotes(self, **kwargs):
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
    today = datetime.now(ap._BEIJING).date()
    fake.frame.index = pd.DatetimeIndex(
        pd.to_datetime([today - timedelta(days=1), today]), name="datetime"
    )
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
    assert "amount_estimated" not in frame.columns
    chart = provider.get_chart_minute(
        ["600519.SH"], datetime(2026, 9, 4, 9, 30), datetime(2026, 9, 4, 10),
    )
    assert chart["amount_estimated"].to_list() == [True, True]


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


def test_tencent_depth_parser_maps_buy_and_sell_levels():
    values = [""] * 29
    values[9:19] = ["10", "100", "9.9", "90", "9.8", "80", "9.7", "70", "9.6", "60"]
    values[19:29] = ["10.1", "11", "10.2", "22", "10.3", "33", "10.4", "44", "10.5", "55"]

    rows = ap._parse_tencent_depth(
        f'v_sh600519="{"~".join(values)}";',
        [("sh600519", "600519.SH")],
        123,
    )

    assert rows == {
        "600519.SH": {
            "bid_prices": [10.0, 9.9, 9.8, 9.7, 9.6],
            "bid_volumes": [100, 90, 80, 70, 60],
            "ask_prices": [10.1, 10.2, 10.3, 10.4, 10.5],
            "ask_volumes": [11, 22, 33, 44, 55],
            "timestamp": 123,
        },
    }


def test_tencent_depth_parser_skips_all_zero_snapshot():
    values = [""] * 29
    values[9:29] = ["0"] * 20

    assert ap._parse_tencent_depth(
        f'v_bj832982="{"~".join(values)}";',
        [("bj832982", "832982.BJ")],
        123,
    ) == {}


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


def test_depth_batch_maps_mootdx_five_levels_and_keeps_explicit_market(monkeypatch):
    quotes = pd.DataFrame([
        {
            "market": 1,
            "code": "000016",
            "bid1": 3000.0,
            "bid2": 2999.0,
            "bid3": 2998.0,
            "bid4": 2997.0,
            "bid5": 2996.0,
            "ask1": 3001.0,
            "ask2": 3002.0,
            "ask3": 3003.0,
            "ask4": 3004.0,
            "ask5": 3005.0,
            "bid_vol1": 10,
            "bid_vol2": 20,
            "bid_vol3": 30,
            "bid_vol4": 40,
            "bid_vol5": 50,
            "ask_vol1": 11,
            "ask_vol2": 21,
            "ask_vol3": 31,
            "ask_vol4": 41,
            "ask_vol5": 51,
            "servertime": "2026-09-12 14:59:59.000",
        },
        {
            "market": 0,
            "code": "000001",
            "bid1": 10.0,
            "ask1": 10.1,
            "bid_vol1": 100,
            "ask_vol1": 200,
        },
    ])
    provider = AStockDataProvider()
    fake = _FakeTdx(quotes)
    monkeypatch.setattr(provider, "_get_tdx", lambda: fake)

    result = provider.get_depth_batch(["000016.SH", "000001.SZ"])

    assert fake.calls == [{"symbol": ["sh000016", "sz000001"]}]
    assert result["000016.SH"]["bid_prices"] == [3000.0, 2999.0, 2998.0, 2997.0, 2996.0]
    assert result["000016.SH"]["ask_volumes"] == [11, 21, 31, 41, 51]
    assert result["000016.SH"]["timestamp"] == 1789196399000
    assert result["000001.SZ"]["bid_volumes"] == [100, None, None, None, None]


def test_depth_batch_isolates_bse_symbols_before_mootdx(monkeypatch):
    provider = AStockDataProvider()
    fake = _FakeTdx(pd.DataFrame([{
        "market": 1,
        "code": "600519",
        "bid1": 1200,
        "ask1": 1201,
        "bid_vol1": 1,
        "ask_vol1": 2,
    }]))
    monkeypatch.setattr(provider, "_get_tdx", lambda: fake)
    fallback_calls: list[list[tuple[str, str]]] = []
    monkeypatch.setattr(
        ap,
        "_fetch_tencent_depth",
        lambda requested: (fallback_calls.append(requested) or {}),
    )

    result = provider.get_depth_batch(["920982.BJ", "600519.SH"])

    assert list(result) == ["600519.SH"]
    assert fake.calls == [{"symbol": ["sh600519"]}]
    assert fallback_calls == [[("bj920982", "920982.BJ")]]


def test_depth_batch_falls_back_to_tencent_when_mootdx_is_unavailable(monkeypatch):
    provider = AStockDataProvider()
    monkeypatch.setattr(
        provider,
        "_get_tdx",
        lambda: (_ for _ in ()).throw(RuntimeError("offline")),
    )
    values = [""] * 29
    values[9:29] = ["10", "100", "9.9", "90", "9.8", "80", "9.7", "70", "9.6", "60",
                    "10.1", "11", "10.2", "22", "10.3", "33", "10.4", "44", "10.5", "55"]

    class _Response:
        content = f'v_sh600519="{"~".join(values)}";'.encode("gbk")

        def raise_for_status(self):
            return None

    calls: list[str] = []

    def fake_get(url, **kwargs):
        calls.append(url)
        return _Response()

    monkeypatch.setattr(ap, "_http_get", fake_get)
    result = provider.get_depth_batch(["600519.SH"])

    assert result["600519.SH"]["bid_volumes"] == [100, 90, 80, 70, 60]
    assert calls == ["https://qt.gtimg.cn/q=sh600519"]


def test_depth_batch_returns_empty_without_symbols(monkeypatch):
    provider = AStockDataProvider()
    monkeypatch.setattr(provider, "_get_tdx", lambda: pytest.fail("不应连接 mootdx"))

    assert provider.get_depth_batch([]) == {}


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
    assert set(manifest["datasets"]) == {"daily", "adj_factor", "minute", "realtime", "depth5"}
    assert AStockDataProvider().capabilities.depth5 is True
    assert "financial" not in manifest["datasets"]
    assert manifest["upstream"]["repository"] == ap.UPSTREAM_REPOSITORY
    assert manifest["upstream"]["version"] == ap.UPSTREAM_VERSION == "v3.8.0"
    assert manifest["upstream"]["commit"] == ap.UPSTREAM_COMMIT


def test_mootdx_failure_returns_empty_daily(monkeypatch):
    provider = AStockDataProvider()
    monkeypatch.setattr(ap, "_tdx_client", lambda: (_ for _ in ()).throw(RuntimeError("offline")))
    assert provider.get_daily(["600519.SH"], None, None).is_empty()
