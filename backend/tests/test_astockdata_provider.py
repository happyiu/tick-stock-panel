"""a-stock-data provider 的无网络契约测试。"""

from __future__ import annotations

from datetime import date, datetime
from pathlib import Path

import pandas as pd
import polars as pl
import pytest

from app.plugins.astockdata import provider as ap
from app.plugins.astockdata.provider import AStockDataProvider


def test_native_30m_uses_tencent_and_filters_requested_window(monkeypatch):
    frame = pl.DataFrame({"datetime": [datetime(2026, 9, 2, 10), datetime(2026, 9, 2, 10, 30)],
                          "symbol": ["510300.SH"] * 2, "amount_estimated": [True] * 2})
    calls = []
    monkeypatch.setattr(ap, "_tencent_minute", lambda symbol, freq: (calls.append((symbol, freq)) or frame))
    provider = AStockDataProvider()
    monkeypatch.setattr(provider, "_get_tdx", lambda: pytest.fail("不应连接 TCP"))
    result = provider.get_minute(["510300.SH"], datetime(2026, 9, 2, 10, 15), datetime(2026, 9, 3), asset_type="etf", freq="30m")
    assert calls == [("510300.SH", "30m")]
    assert result["datetime"].to_list() == [datetime(2026, 9, 2, 10, 30)]
    assert "amount_estimated" not in result.columns


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


def test_daily_uses_tencent_raw_bars_and_keeps_missing_amount_null(monkeypatch):
    calls = []
    def fake(key, period, param, **kwargs):
        calls.append((key, period, param, kwargs))
        return [["2026-09-01", "10", "10.2", "10.4", "9.9", "1000"],
                ["2026-09-02", "10.2", "10.4", "10.5", "10.1", "1200"]]
    monkeypatch.setattr(ap, "_tencent_kline_data", fake)
    provider = AStockDataProvider()
    monkeypatch.setattr(provider, "_get_tdx", lambda: pytest.fail("不应连接 TCP"))
    frame = provider.get_daily(["600519.SH"], datetime(2026, 9, 1), datetime(2026, 9, 2))
    assert frame["volume"].to_list() == [1000, 1200]
    assert frame["close"].to_list() == [10.2, 10.4]
    assert frame["amount"].to_list() == [None, None]
    assert calls == [("sh600519", "day", "sh600519,day,2026-09-01,2026-09-02,640,", {"daily": True})]


def test_minute_normalizes_datetime_and_keeps_canonical_columns():
    minute = _bars()
    minute.index = pd.DatetimeIndex(pd.to_datetime(["2026-09-02 09:35", "2026-09-02 09:36"]), name="datetime")
    frame = ap._normalise_minute(minute, "600519.SH")
    assert set(frame.columns) == {"symbol", "datetime", "open", "high", "low", "close", "volume", "amount"}
    assert frame.height == 2
    assert (frame["datetime"][0].hour, frame["datetime"][0].minute) == (9, 35)


def test_minute_uses_tencent_and_exposes_quality_only_for_chart(monkeypatch):
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
    assert calls == ["https://web.ifzq.gtimg.cn/appstock/app/kline/mkline?param=sh600519,m1,,320"]
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


@pytest.mark.parametrize("fail_first_batch", [False, True])
def test_realtime_batches_etf_catalog_and_continues_after_failed_batch(monkeypatch, fail_first_batch):
    symbols = [f"{510000 + i}.SH" for i in range(401)]
    calls: list[list[str]] = []

    class _Response:
        def __init__(self, keys):
            quotes = []
            for key in keys:
                values = [""] * 53
                values[1] = "ETF"
                values[3:7] = ["4.1", "4", "4", "100"]
                quotes.append(f'v_{key}="{"~".join(values)}";')
            self.content = "\n".join(quotes).encode("gbk")

        def raise_for_status(self):
            return None

    def fake_get(url, **kwargs):
        keys = url.split("q=", 1)[1].split(",")
        calls.append(keys)
        if fail_first_batch and len(calls) == 1:
            raise RuntimeError("first batch unavailable")
        return _Response(keys)

    monkeypatch.setattr(ap, "_http_get", fake_get)
    monkeypatch.setattr(ap.time, "sleep", lambda seconds: None)
    rows = AStockDataProvider().get_realtime(symbols=[*symbols, symbols[0]])

    assert [len(keys) for keys in calls] == [200, 200, 1]
    assert {row["symbol"] for row in rows} == set(symbols[200:] if fail_first_batch else symbols)
    assert all(row["last_price"] == 4.1 for row in rows)


def test_legacy_depth_normalizer_keeps_explicit_market():
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
    result = ap._normalise_depth_quotes(quotes, [("sh000016", "000016.SH"), ("sz000001", "000001.SZ")], 123)
    assert result["000016.SH"]["bid_prices"] == [3000.0, 2999.0, 2998.0, 2997.0, 2996.0]
    assert result["000016.SH"]["ask_volumes"] == [11, 21, 31, 41, 51]
    assert result["000016.SH"]["timestamp"] == 1789196399000
    assert result["000001.SZ"]["bid_volumes"] == [100, None, None, None, None]


def test_depth_batch_sends_bse_and_shares_directly_to_tencent(monkeypatch):
    provider = AStockDataProvider()
    monkeypatch.setattr(provider, "_get_tdx", lambda: pytest.fail("不应连接 TCP"))
    calls = []
    monkeypatch.setattr(ap, "_fetch_tencent_depth", lambda requested: (calls.append(requested) or {}))
    assert provider.get_depth_batch(["920982.BJ", "600519.SH", "600519.SH"]) == {}
    assert calls == [[("bj920982", "920982.BJ"), ("sh600519", "600519.SH")]]


def test_depth_batch_uses_tencent(monkeypatch):
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
    assert manifest["upstream"]["version"] == ap.UPSTREAM_VERSION == "v3.10.2"
    assert manifest["upstream"]["commit"] == ap.UPSTREAM_COMMIT


def test_daily_transport_failure_propagates(monkeypatch):
    monkeypatch.setattr(ap, "_tencent_kline_data", lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("offline")))
    with pytest.raises(RuntimeError, match="offline"):
        AStockDataProvider().get_daily(["600519.SH"], None, None)


@pytest.mark.parametrize(("symbol", "lots"), [("688981.SH", 10), ("689009.SH", 10), ("588000.SH", 1000), ("300750.SZ", 1000)])
def test_tencent_kline_volume_units_for_daily_and_minute(monkeypatch, symbol, lots):
    def fake(key, period, param, **kwargs):
        return [["2026-10-22" if period == "day" else "202610221000", "100", "100", "101", "99", "1000", {}, "987654"]]
    monkeypatch.setattr(ap, "_tencent_kline_data", fake)
    minute = ap._tencent_minute(symbol, "5m")
    assert minute["volume"][0] == lots
    assert minute["amount"][0] == lots * 100 * 100
    daily = ap._tencent_daily(symbol, date(2026, 10, 22), date(2026, 10, 22))
    assert daily["volume"][0] == lots
    assert daily["amount"][0] is None


def test_tencent_kline_rotates_hosts_and_rejects_all_empty_payloads(monkeypatch):
    calls = []
    class Response:
        def raise_for_status(self): pass
        def json(self):
            return {} if len(calls) == 1 else {"data": {"sh600519": {"m1": [["valid"]]}}}
    monkeypatch.setattr(ap, "_http_get", lambda url, **kw: (calls.append(url) or Response()))
    assert ap._tencent_kline_data("sh600519", "m1", "test") == [["valid"]]
    assert len(calls) == 2
    class Empty(Response):
        def json(self): return {}
    monkeypatch.setattr(ap, "_http_get", lambda *a, **kw: Empty())
    with pytest.raises(RuntimeError, match="三个入口"):
        ap._tencent_kline_data("sh600519", "m1", "test")


def test_tencent_daily_segments_long_ranges_without_adjustment(monkeypatch):
    calls = []
    def fake(key, period, param, **kw):
        calls.append(param)
        return [[param.split(",")[2], "10", "11", "12", "9", "100"]]
    monkeypatch.setattr(ap, "_tencent_kline_data", fake)
    frame = ap._tencent_daily("510300.SH", date(2020, 1, 1), date(2026, 1, 1))
    assert len(calls) == 4
    assert all(p.endswith(",640,") for p in calls)
    assert frame.height == 4


@pytest.mark.parametrize("case", ["duplicate", "bad_price", "short"])
def test_tencent_minute_rejects_corrupt_rows(monkeypatch, case):
    raw = ["202610221000", "100", "100", "101", "99", "1000"]
    rows = [raw, raw] if case == "duplicate" else [raw[:3] if case == "short" else [*raw[:1], "nan", *raw[2:]]]
    monkeypatch.setattr(ap, "_tencent_kline_data", lambda *a, **kw: rows)
    with pytest.raises((ValueError, IndexError)):
        ap._tencent_minute("688981.SH", "5m")


def _bj_package(*, corrupt=False, zero_prices=False):
    import io
    import struct
    import zipfile
    cod, md1 = bytearray(), bytearray()
    for i in range(50):
        record, block = bytearray(150), bytearray(512)
        record[:6] = str(920000 + i).encode()
        struct.pack_into("<H", record, 32, i)
        struct.pack_into("<4d", block, 12, 10, 12, 9, 0 if zero_prices else 11)
        struct.pack_into("<Q", block, 56, 123400)
        struct.pack_into("<d", block, 72, 1357400)
        cod.extend(record)
        md1.extend(block)
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as z:
        z.writestr("bj261021.cod", cod[:-1] if corrupt else cod)
        z.writestr("bj261021.md1", md1)
    return output.getvalue()


def test_bj_daily_package_filters_symbols_and_converts_shares(monkeypatch):
    class Response:
        status_code = 200
        content = _bj_package()
        def raise_for_status(self): pass
    calls = []
    monkeypatch.setattr(ap, "_tencent_daily", lambda *a: pl.DataFrame({"date": [date(2026, 10, 21)]}))
    monkeypatch.setattr(ap, "_http_get", lambda url, **kw: (calls.append(url) or Response()))
    frame = AStockDataProvider().get_daily(["920001.BJ", "920002.BJ"], date(2026, 10, 21), date(2026, 10, 21))
    assert frame["symbol"].to_list() == ["920001.BJ", "920002.BJ"]
    assert frame["volume"].to_list() == [1234, 1234]
    assert frame["amount"].to_list() == [1357400, 1357400]
    assert len(calls) == 1


def test_bj_package_rejects_truncation():
    with pytest.raises(ValueError, match="长度"):
        ap._tdx_package_bj(_bj_package(corrupt=True), date(2026, 10, 21), {"920001.BJ"})


def test_bj_missing_package_and_minutes_fail_explicitly(monkeypatch):
    class Response:
        status_code = 404
    monkeypatch.setattr(ap, "_http_get", lambda *a, **kw: Response())
    monkeypatch.setattr(ap, "_tencent_daily", lambda *a: pl.DataFrame({"date": [date(2026, 10, 21)]}))
    with pytest.raises(RuntimeError, match="尚未发布"):
        AStockDataProvider().get_daily(["920001.BJ"], date(2026, 10, 21), date(2026, 10, 21))
    with pytest.raises(ValueError, match="北交所"):
        ap._tencent_minute("920001.BJ", "1m")


def test_missing_daily_amount_survives_indicator_pipeline(monkeypatch):
    from app.indicators.pipeline import compute_enriched

    monkeypatch.setattr(ap, "_tencent_kline_data", lambda *a, **kw: [
        ["2026-10-21", "100", "101", "102", "99", "1000"],
        ["2026-10-22", "101", "102", "103", "100", "1100"],
    ])
    raw = ap._tencent_daily("688981.SH", date(2026, 10, 21), date(2026, 10, 22))
    enriched = compute_enriched(raw)
    assert enriched.height == 2
    assert enriched["amount"].is_null().all()
    assert enriched["close"].to_list() == [101, 102]


def test_bj_holiday_does_not_request_package(monkeypatch):
    monkeypatch.setattr(ap, "_tencent_daily", lambda *a: pl.DataFrame())
    monkeypatch.setattr(ap, "_http_get", lambda *a, **kw: pytest.fail("休市无盘后包请求"))
    assert AStockDataProvider().get_daily(["920001.BJ"], date(2026, 10, 1), date(2026, 10, 1)).is_empty()


def test_availability_does_not_require_mootdx(monkeypatch):
    calls = []
    monkeypatch.setattr(ap.importlib, "import_module", lambda name: calls.append(name))
    assert ap.availability() == (True, "ok")
    assert calls == ["requests"]


def test_bj_package_rejects_market_without_priced_rows():
    with pytest.raises(ValueError, match="不完整"):
        ap._tdx_package_bj(_bj_package(zero_prices=True), date(2026, 10, 21), {"920001.BJ"})
