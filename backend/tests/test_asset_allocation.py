from datetime import date
from unittest.mock import Mock

import pandas as pd
import pytest

from app.custom import _allocation_calculation
from app.custom import asset_allocation as service
from app.plugins.astockdata import provider


def test_etf_affine_events(monkeypatch):
    response = Mock(
        text='x={"data":[{"d":"2026-01-19","s":"1","u":".880"},{"d":"2025-06-18","s":"1","u":".757"},{"d":"1900-01-01","s":"1","u":"0"}]}'
    )
    monkeypatch.setattr(provider, "_http_get", lambda *a, **k: response)
    events = provider.etf_corporate_actions("510300.SH")
    assert events[-1]["dividend"] == pytest.approx(0.123)
    assert (4.738 + events[-1]["dividend"]) / 4.859 - 1 == pytest.approx(0.0004116073)
    response.text = 'x={"data":[{"d":"1900-01-01","s":"1","u":"0"},{"d":"2025-08-04","s":"2","u":"0"},{"d":"2026-01-01","s":"2","u":"0.6"}]}'
    events = provider.etf_corporate_actions("512000.SH")
    assert events[0]["split"] == 2
    assert events[1]["dividend"] == 0.3
    response.text = 'x={"data":[]}'
    with pytest.raises(ValueError, match="覆盖"):
        provider.etf_corporate_actions("512000.SH")


def test_portfolios_persist_and_delete(tmp_path):
    request = Mock()
    request.app.state.repo.store.data_dir = tmp_path
    import uuid

    key = uuid.uuid4()
    service.save(key, service.Portfolio(name="测试"), request)
    saved = service.portfolios(request)[str(key)]
    assert saved["lookback"] == 252
    assert saved["scheme_id"] == "devil_trader"
    service.delete(key, request)
    assert service.portfolios(request) == {}


def test_initial_capital_validation_and_cent_allocation():
    assert service.Portfolio().initial_capital is None
    for invalid in (True, 0, -1, float("inf"), 1.5, 1_000_000_000_000):
        with pytest.raises(ValueError):
            service.Portfolio(initial_capital=invalid)

    equal = service.allocate_amounts([1 / 3] * 3, 100_001)
    assert equal == [33_333.67, 33_333.67, 33_333.66]
    assert round(sum(equal), 2) == 100_001
    primary = service.allocate_amounts([0.1, 0.2, 0.7], 123)
    assert primary == [12.3, 24.6, 86.1]
    assert round(sum(primary), 2) == 123


@pytest.mark.parametrize(
    ("score", "position", "regime"),
    [(34, 0.5, "熊市"), (35, 0.7, "中性"), (64, 0.7, "中性"), (65, 0.9, "牛市")],
)
def test_environment_score_maps_to_total_position(score, position, regime):
    assert _allocation_calculation.total_position_for_score(score) == (position, regime)


@pytest.fixture(autouse=True)
def allocation_schemes(monkeypatch):
    monkeypatch.setattr(
        _allocation_calculation,
        "SCHEMES",
        {
            **_allocation_calculation.SCHEMES,
            "test": ("测试方案", lambda symbols, returns, cap: [1 / len(symbols)] * len(symbols)),
            "tilt": ("偏重方案", lambda symbols, returns, cap: [0.7, 0.3]),
        },
    )


def test_pending_scheme_and_invalid_constraints_precede_data_access():
    repo = Mock()
    with pytest.raises(ValueError, match="魔鬼操盘手的规则待补充"):
        service.prepare(service.Calculation(symbols=["a", "b"]), repo, "optimize")
    with pytest.raises(ValueError, match="70%"):
        service.prepare(service.Calculation(symbols=["a", "b"], scheme_id="test"), repo, "optimize")
    repo.get_etf_symbol_set.assert_not_called()


@pytest.mark.parametrize("weights", [[1], [0.3, 0.3], [float("nan"), 1], [-0.1, 1.1], [0.7, 0.3]])
def test_reject_invalid_scheme_weights(weights, monkeypatch):
    import numpy as np

    monkeypatch.setitem(_allocation_calculation.SCHEMES, "invalid", ("测试方案", lambda *_: weights))
    with pytest.raises(ValueError, match="违反配置约束"):
        _allocation_calculation.weights(["A", "B"], np.zeros((2, 2)), 0.6, "invalid")


def signal_payload():
    dates = pd.bdate_range("2026-01-01", periods=8)
    return dict(
        symbols=["A", "B"],
        dates=[str(d.date()) for d in dates],
        close=[[100.0, 100.0]] * 8,
        open=[[90.0, 90.0]] * 8,
        dividend=[[0.0, 0.0]] * 8,
        split=[[1.0, 1.0]] * 8,
        signals=[[None, None] for _ in dates],
        lookback=2,
        scheme_id="test",
        max_weight=1.0,
        mode="backtest",
        start=str(dates[2].date()),
        end=str(dates[-1].date()),
        threshold=0.05,
        fee=0.0,
        slippage=0.0,
    )


def test_devil_trader_backtest_returns_daily_position_from_each_score(monkeypatch):
    points = [
        {"date": "2026-01-05", "score": 34, "regime": "熊市", "total_position": 0.5},
        {"date": "2026-01-06", "score": 35, "regime": "中性", "total_position": 0.7},
        {"date": "2026-01-07", "score": 64, "regime": "中性", "total_position": 0.7},
        {"date": "2026-01-08", "score": 65, "regime": "牛市", "total_position": 0.9},
    ]
    monkeypatch.setattr(service, "market_environment_position_history", lambda *_args, **_kwargs: points)
    body = service.Calculation(
        scheme_id="devil_trader",
        symbols=[],
        start=date(2026, 1, 5),
        end=date(2026, 1, 8),
    )

    preview = service.calculate(body, Mock(), "optimize")
    backtest = service.calculate(body, Mock(), "backtest")

    assert preview["total_position"] == 0.9
    assert backtest["position_history"] == points
    assert [point["total_position"] for point in backtest["position_history"]] == [0.5, 0.7, 0.7, 0.9]


def test_no_initial_position_or_carried_attack():
    p = signal_payload()
    p["signals"][1] = ["attack", "attack"]  # before the formal period
    result = _allocation_calculation.calculate(p)
    assert result["trades"] == []
    assert all(
        row["cash"] == 1.0 and row["weights"] == [0.0, 0.0] for row in result["accounts"]["scheme"]
    )


def test_selected_scheme_drives_history_and_backtest_even_with_flat_prices():
    p = signal_payload()
    p["scheme_id"] = "tilt"
    p["signals"][2] = ["attack", "attack"]
    preview = _allocation_calculation.calculate({**p, "mode": "optimize"})
    assert preview["weights"] == [0.7, 0.3]
    assert preview["risk_contribution"] == [0, 0]
    assert set(preview["history"]) == {"scheme", "equal"}
    result = _allocation_calculation.calculate(p)
    assert set(result["accounts"]) == {"scheme", "equal"}
    assert all(day["weights"] == preview["weights"] for day in result["schedule"])
    assert result["accounts"]["scheme"][0]["weights"] == pytest.approx(preview["weights"])
    assert result["accounts"]["equal"][0]["weights"] == pytest.approx([0.5, 0.5])


def test_attack_retreat_close_fills_and_one_sided_rebalance():
    p = signal_payload()
    p["signals"][3] = ["attack", "attack"]
    p["signals"][6] = [None, "attack"]
    p["signals"][7] = ["retreat", None]
    p["close"] = [[100.0, 100.0]] * 4 + [[150.0, 100.0]] * 4
    result = _allocation_calculation.calculate(p)
    trades = [t for t in result["trades"] if t["model"] == "scheme"]
    assert [(t["date"], t["symbol"], t["side"], t["reason"]) for t in trades] == [
        (p["dates"][3], "A", "buy", "attack"),
        (p["dates"][3], "B", "buy", "attack"),
        (p["dates"][4], "A", "sell", "threshold_reduce"),
        (p["dates"][6], "B", "buy", "attack"),
        (p["dates"][7], "A", "sell", "retreat"),
    ]
    assert [t["price"] for t in trades] == [100.0, 100.0, 150.0, 100.0, 150.0]
    rows = result["accounts"]["scheme"]
    assert rows[2]["weights"] == pytest.approx([0.5, 0.4])
    assert rows[2]["cash"] == pytest.approx(0.125)
    assert rows[4]["weights"] == pytest.approx([0.5, 0.5])
    assert rows[-1]["weights"] == pytest.approx([0.0, 0.5])


def test_threshold_boundary_and_same_day_attack_after_reduction():
    p = signal_payload()
    p["signals"][2] = ["attack", "attack"]
    p["signals"][3] = [None, "attack"]
    p["close"] = [[100.0, 110.0]] * 3 + [[110.0, 90.0]] * 5
    result = _allocation_calculation.calculate(p)
    rows = result["accounts"]["scheme"]
    assert rows[1]["weights"] == pytest.approx([0.5, 0.5])
    # threshold is inclusive, and a fresh same-day attack may consume sale proceeds
    assert any(t["reason"] == "threshold_reduce" for t in result["trades"] if t["model"] == "scheme")


def test_signal_costs_and_dividend_split_accounting():
    p = signal_payload()
    p["signals"][2] = ["attack", None]
    p["split"][3] = [2.0, 1.0]
    p["close"] = [[100.0, 100.0] for _ in p["dates"]]
    for i in range(3, 8):
        p["close"][i] = [49.0, 100.0]
    p["dividend"][3] = [2.0, 0.0]  # per pre-split share
    no_cost = _allocation_calculation.calculate(p)
    assert no_cost["history"]["scheme"]["return"] == pytest.approx(0.0)
    p["fee"] = 0.01
    cost = _allocation_calculation.calculate(p)
    assert cost["history"]["scheme"]["return"] < 0
    assert all(a["cash"] >= 0 for a in cost["accounts"]["scheme"])
    buys = [t for t in cost["trades"] if t["model"] == "scheme"]
    assert buys[0]["amount"] + buys[0]["cost"] <= 1.0
    assert buys[0]["cost"] == pytest.approx(buys[0]["amount"] * 0.01)


def test_api_and_data_validation(tmp_path, monkeypatch):
    import polars as pl
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    repo = Mock()
    repo.store.data_dir = tmp_path
    repo.get_etf_symbol_set.return_value = {"510300.SH"}
    repo.get_name_map.return_value = {"510300.SH": "ETF"}
    days = [date(2026, 1, d) for d in (5, 6, 7)]
    repo.get_index_daily.return_value = pl.DataFrame({"date": days})
    repo.get_etf_daily.return_value = pl.DataFrame(
        {
            "date": days,
            "raw_close": [1.0, 1.1, 1.2],
            "close": [1.0, 1.1, 1.2],
            "open": [1.0, 1.1, 1.2],
        }
    )
    monkeypatch.setattr(service, "get_provider", lambda _: Mock(get_etf_actions=lambda _: []))
    service._events.clear()
    app = FastAPI()
    app.state.repo = repo
    app.include_router(service.router)
    body = {"symbols": ["510300.SH"], "lookback": 2, "scheme_id": "test", "max_weight": 1, "initial_capital": 1235}
    with TestClient(app) as client:
        schemes = client.get("/api/asset-allocation/schemes").json()
        assert schemes["default_scheme_id"] == "devil_trader"
        assert schemes["schemes"]["devil_trader"] == {
            "name": "魔鬼操盘手", "ready": False, "position_ready": True
        }
        assert schemes["schemes"]["test"] == {
            "name": "测试方案", "ready": True, "position_ready": False
        }
        response = client.post("/api/asset-allocation/optimize", json=body)
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["weights"] == [1.0]
        assert result["target_amounts"] == {"scheme": [1235.0], "equal": [1235.0]}
        assert result["parameters"]["initial_capital"] == 1235
        assert result["parameters"]["scheme_id"] == "test"
        assert result["history"]["scheme"]["return"] == pytest.approx(0.2)
        legacy_body = {key: value for key, value in body.items() if key != "initial_capital"}
        legacy = client.post("/api/asset-allocation/optimize", json=legacy_body).json()
        assert legacy["parameters"]["initial_capital"] is None
        assert "target_amounts" not in legacy
        different_capital = client.post(
            "/api/asset-allocation/optimize", json={**body, "initial_capital": 2346}
        ).json()
        assert different_capital["data_version"] != result["data_version"]
        route = "/api/asset-allocation/portfolios/11111111-1111-4111-8111-111111111111"
        assert client.put(route, json=body).json()[str(route.rsplit("/", 1)[-1])]["initial_capital"] == 1235
        invalid_body = {**body, "initial_capital": 1234.5}
        assert client.put(route, json=invalid_body).status_code == 422
        assert client.put(route, json={**body, "scheme_id": "missing"}).status_code == 422
        assert client.post("/api/asset-allocation/optimize", json={**body, "scheme_id": "missing"}).status_code == 422
        recommendation = client.post(route + "/refresh").json()
        assert recommendation["status"] == "initial"
        assert client.post(route + "/confirm", json={"checked_at": "stale"}).status_code == 409
        assert (
            client.post(
                route + "/confirm", json={"checked_at": recommendation["checked_at"]}
            ).status_code
            == 200
        )
        stored = client.get("/api/asset-allocation/tracking").json()
        assert next(iter(stored.values()))["basis"]["weights"] == [1.0]

        body["symbols"] = ["unknown"]
        assert client.post("/api/asset-allocation/optimize", json=body).status_code == 422
        body["symbols"] = ["510300.SH"]
        repo.get_etf_daily.return_value = repo.get_etf_daily.return_value.head(2)
        response = client.post("/api/asset-allocation/optimize", json=body)
        assert response.status_code == 422 and "缺少" in response.text


def test_etf_provider_emits_dividend_factor(monkeypatch):
    from datetime import datetime

    import polars as pl

    monkeypatch.setattr(
        provider,
        "etf_corporate_actions",
        lambda _: [{"date": "2026-01-19", "split": 1.0, "dividend": 0.123}],
    )
    obj = provider.AStockDataProvider()
    monkeypatch.setattr(
        obj,
        "get_daily",
        lambda *a, **kw: pl.DataFrame({"date": [date(2026, 1, 16)], "close": [4.859]}),
    )
    result = obj.get_adj_factors(
        ["510300.SH"], datetime(2026, 1, 1), datetime(2026, 2, 1), asset_type="etf"
    )
    assert result["ex_factor"][0] == pytest.approx(4.859 / (4.859 - 0.123))


def test_tracking_drifts_with_price_and_keeps_ex_dividend_cash():
    payload = {
        "dates": ["2026-01-05", "2026-01-06"],
        "close": [[100, 100], [110, 99]],
        "split": [[1, 1], [1, 1]],
        "dividend": [[0, 0], [0, 1]],
    }
    basis = {"date": "2026-01-05", "prices": [100, 100], "weights": [0.5, 0.5]}
    current = service.tracked_weights(payload, basis)
    assert current == pytest.approx([55 / 105, 49.5 / 105])
    # A 2:1 split halves price while preserving holding value.
    payload["split"][-1][0] = 2
    payload["close"][-1][0] = 55
    assert service.tracked_weights(payload, basis) == pytest.approx(current)


def test_tracking_confirm_and_legacy_defaults(tmp_path, monkeypatch):
    import uuid

    request = Mock()
    request.app.state.repo.store.data_dir = tmp_path
    key = uuid.uuid4()
    body = service.Portfolio(symbols=["ONE"], scheme_id="test", max_weight=1)
    assert body.auto_refresh is False and body.rebalance == "monthly"
    service.save(key, body, request)
    payload = {"dates": ["2026-01-05"], "close": [[100]], "dividend": [[0]], "split": [[1]]}
    monkeypatch.setattr(service, "prepare", lambda *a: payload)
    monkeypatch.setattr(_allocation_calculation, "calculate", lambda _: {"weights": [1.0]})
    entry = service.refresh_portfolio(str(key), request)
    assert entry["status"] == "initial"
    service.confirm(
        key,
        service.Confirmation(checked_at=entry["checked_at"]),
        request,
    )
    assert service.tracking(request)[str(key)]["basis"]["weights"] == [1.0]
    # Recomputing suggestions never advances the confirmed baseline.
    payload["dates"] = ["2026-01-06"]
    service.refresh_portfolio(str(key), request)
    assert service.tracking(request)[str(key)]["basis"]["date"] == "2026-01-05"
    body.threshold = 0.1
    service.save(key, body, request)
    from fastapi import HTTPException

    with pytest.raises(HTTPException):
        service.confirm(
            key,
            service.Confirmation(checked_at=entry["checked_at"]),
            request,
        )


def test_legacy_portfolio_requires_scheme_and_switch_invalidates_tracking(tmp_path, monkeypatch):
    import uuid
    from datetime import datetime

    from fastapi import HTTPException

    request = Mock()
    repo = request.app.state.repo
    repo.store.data_dir = tmp_path
    key = uuid.uuid4()
    key_str = str(key)
    raw = {"name": "旧组合", "symbols": ["A", "B"], "max_weight": 1, "auto_refresh": True, "method": "retired"}
    service.write_portfolios(request, {key_str: raw})
    service.write_tracking(request, {key_str: {"checked_at": "legacy", "status": "hold"}})
    assert service.portfolios(request)[key_str] == raw
    assert service.tracking(request) == {}
    with pytest.raises(HTTPException, match="魔鬼操盘手的规则待补充"):
        service.refresh_portfolio(key_str, request)
    assert service.read_tracking(request)[key_str]["checked_at"] == "legacy"

    body = service.Portfolio(**raw, scheme_id="test")
    service.save(key, body, request)
    monkeypatch.setattr(service, "cn_now", lambda: datetime(2026, 11, 9, 16))
    payload = {"dates": ["2026-11-09"], "close": [[100, 100]]}
    monkeypatch.setattr(_allocation_calculation, "calculate", lambda _: {"weights": [0.5, 0.5]})
    monkeypatch.setattr(service, "prepare", lambda *args: payload)
    service.refresh_saved(repo)
    entry = service.tracking(request)[key_str]
    assert entry["target"] == [0.5, 0.5]
    assert entry["scheme_id"] == "test"
    assert entry["basis"] is None
    service.confirm(key, service.Confirmation(checked_at=entry["checked_at"]), request)

    changed = body.model_copy(update={"scheme_id": "tilt"})

    def concurrent_edit(*args):
        service.save(key, changed, request)
        return payload

    monkeypatch.setattr(service, "prepare", concurrent_edit)
    assert service.refresh_portfolio(key_str, request) is None
    service.save(key, body, request)
    assert service.tracking(request) == {}
    with pytest.raises(HTTPException):
        service.confirm(key, service.Confirmation(checked_at=entry["checked_at"]), request)


def test_backtest_scheme_uses_only_history_through_each_day(monkeypatch):
    p = signal_payload()
    p["close"] = [[100.0, 100.0] for _ in p["dates"]]
    def react_to_last_return(symbols, returns, cap):
        return [0.7, 0.3] if returns[-1, 0] > 0 else [0.5, 0.5]

    monkeypatch.setitem(_allocation_calculation.SCHEMES, "test", ("测试方案", react_to_last_return))
    original = _allocation_calculation.calculate(p)
    p["close"][-1][0] *= 2
    changed = _allocation_calculation.calculate(p)
    assert original["schedule"][:-1] == changed["schedule"][:-1]
    assert changed["schedule"][-1]["weights"] == [0.7, 0.3]
    del p["signals"]
    with pytest.raises(ValueError, match="信号缺失"):
        _allocation_calculation.calculate(p)


def test_scheduler_only_visits_enabled_portfolios_after_close(tmp_path, monkeypatch):
    from datetime import datetime

    repo = Mock()
    repo.store.data_dir = tmp_path
    request = Mock()
    request.app.state.repo = repo
    service.write_portfolios(
        request,
        {
            "enabled": {"auto_refresh": True, "symbols": ["A"], "scheme_id": "test"},
            "old": {"symbols": ["B"]},
            "draft": {"auto_refresh": True, "symbols": []},
            "pending": {"auto_refresh": True, "symbols": ["B"], "scheme_id": "devil_trader"},
        },
    )
    calls = []
    monkeypatch.setattr(
        service, "refresh_portfolio", lambda key, request, **kw: calls.append((key, kw))
    )
    monkeypatch.setattr(service, "cn_now", lambda: datetime(2026, 11, 9, 15))
    service.refresh_saved(repo)
    assert calls == []
    monkeypatch.setattr(service, "cn_now", lambda: datetime(2026, 11, 9, 16))
    service.refresh_saved(repo)
    assert calls == [("enabled", {"require_today": True})]


def test_automatic_refresh_rejects_stale_data_and_keeps_baseline(tmp_path, monkeypatch):
    import uuid
    from datetime import datetime

    request = Mock()
    request.app.state.repo.store.data_dir = tmp_path
    key = uuid.uuid4()
    service.save(key, service.Portfolio(symbols=["ONE"], scheme_id="test", max_weight=1), request)
    monkeypatch.setattr(service, "cn_now", lambda: datetime(2026, 11, 9, 16))
    monkeypatch.setattr(service, "prepare", lambda *a: {"dates": ["2026-11-06"]})
    result = service.refresh_portfolio(str(key), request, require_today=True)
    assert result["status"] == "error"
    assert "尚未就绪" in result["error"]


def test_prepare_reuses_angel_devil_and_adjusts_split_once(tmp_path, monkeypatch):
    import polars as pl

    dates = [d.date() for d in pd.bdate_range("2026-01-01", periods=40)]
    raw = [100.0] * 30 + [50.0] * 10
    repo = Mock()
    repo.store.data_dir = tmp_path
    repo.get_etf_symbol_set.return_value = {"512000.SH"}
    repo.get_index_daily.return_value = pl.DataFrame({"date": dates})
    # Existing adjusted close must not be adjusted twice in the signal calculation.
    repo.get_etf_daily.return_value = pl.DataFrame(
        {"date": dates, "raw_close": raw, "open": [50.0] * 40, "close": [50.0] * 40}
    )
    monkeypatch.setattr(
        service,
        "get_provider",
        lambda _: Mock(
            get_etf_actions=lambda _: [{"date": str(dates[30]), "split": 2.0, "dividend": 0.0}]
        ),
    )
    service._events.clear()
    payload = service.prepare(
        service.Calculation(
            symbols=["512000.SH"], lookback=3, scheme_id="test", max_weight=1, start=dates[25], end=dates[-1]
        ),
        repo,
        "backtest",
    )
    assert payload["rule_version"] == "angel_devil_scheme_close_v1"
    assert all(row == [None] for row in payload["signals"])
    assert payload["split"][payload["dates"].index(str(dates[30]))] == [2.0]
    assert payload["close"][-1] == [50.0]
    # Missing bars in the signal prehistory also fail closed.
    repo.get_etf_daily.return_value = repo.get_etf_daily.return_value.filter(
        pl.col("date") != dates[10]
    )
    with pytest.raises(ValueError, match="信号历史存在"):
        service.prepare(
            service.Calculation(
                symbols=["512000.SH"], lookback=3, scheme_id="test", max_weight=1, start=dates[25], end=dates[-1]
            ),
            repo,
            "backtest",
        )


def test_backtest_api_forces_signal_rule_and_starts_in_cash(tmp_path, monkeypatch):
    import polars as pl
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    days = [d.date() for d in pd.bdate_range("2026-01-01", periods=45)]
    repo = Mock()
    repo.store.data_dir = tmp_path
    repo.get_etf_symbol_set.return_value = {"510300.SH"}
    repo.get_name_map.return_value = {"510300.SH": "ETF"}
    repo.get_index_daily.return_value = pl.DataFrame({"date": days})
    repo.get_etf_daily.return_value = pl.DataFrame(
        {"date": days, "raw_close": [100.0] * 45, "close": [100.0] * 45, "open": [99.0] * 45}
    )
    monkeypatch.setattr(service, "get_provider", lambda _: Mock(get_etf_actions=lambda _: []))
    service._events.clear()
    app = FastAPI()
    app.state.repo = repo
    app.include_router(service.router)
    with TestClient(app) as client:
        response = client.post(
            "/api/asset-allocation/backtest",
            json={
                "symbols": ["510300.SH"],
                "lookback": 3,
                "scheme_id": "test", "max_weight": 1,
                "initial_capital": 500000,
                "start": str(days[25]),
                "end": str(days[-1]),
                "rebalance": "monthly",
            },
        )
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["parameters"]["rebalance"] == "angel_devil"
        assert result["parameters"]["initial_capital"] == 500000
        assert result["rule_version"] == "angel_devil_scheme_close_v1"
        assert len(result["schedule"]) == 20
        assert result["trades"] == []
        assert result["accounts"]["scheme"][0]["cash"] == 1.0
