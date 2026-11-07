from datetime import date
from pathlib import Path
from unittest.mock import Mock

import pandas as pd
import pytest

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
    assert service.portfolios(request)[str(key)]["lookback"] == 252
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
    hrp = service.allocate_amounts([0.1, 0.2, 0.7], 123)
    assert hrp == [12.3, 24.6, 86.1]
    assert round(sum(hrp), 2) == 123


def test_invalid_constraints_precede_data_access():
    with pytest.raises(ValueError, match="70%"):
        service.prepare(service.Calculation(symbols=["a", "b"]), Mock(), "optimize")


def run_signal_worker(payload, targets=None, fail_min_variance=False):
    import json
    import subprocess

    python = Path(__file__).parents[1] / "allocation-engine/.venv/bin/python"
    script = """
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("allocation",sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
p=json.load(sys.stdin)
targets=p.pop("_targets",None)
if targets:
    m.weights=lambda r,cap,method:m.np.array(targets[str(r.index[-1].date())])
if p.pop("_fail_min_variance",False):
    m.rp.Portfolio.optimization=lambda self,**kwargs: None
    try:
        m.calculate(p)
    except ValueError as exc:
        print(json.dumps({"error":str(exc)}))
        sys.exit(0)
print(json.dumps(m.calculate(p)))
"""
    if targets:
        payload = {**payload, "_targets": targets}
    if fail_min_variance:
        payload = {**payload, "_fail_min_variance": True}
    return json.loads(
        subprocess.check_output(
            [
                str(python),
                "-c",
                script,
                str(Path(service.__file__).with_name("_allocation_worker.py")),
            ],
            input=json.dumps(payload),
            text=True,
        )
    )


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
        max_weight=1.0,
        mode="backtest",
        start=str(dates[2].date()),
        end=str(dates[-1].date()),
        threshold=0.05,
        fee=0.0,
        slippage=0.0,
    )


def test_no_initial_position_or_carried_attack():
    p = signal_payload()
    p["signals"][1] = ["attack", "attack"]  # before the formal period
    targets = {d: [0.5, 0.5] for d in p["dates"]}
    result = run_signal_worker(p, targets)
    assert result["trades"] == []
    assert all(
        row["cash"] == 1.0 and row["weights"] == [0.0, 0.0] for row in result["accounts"]["hrp"]
    )


def test_worker_uses_selected_methods_for_weights_and_backtest():
    import numpy as np

    p = signal_payload()
    returns = np.random.default_rng(26).normal(size=(8, 2)) * [0.004, 0.025]
    p["close"] = (100 * np.cumprod(1 + returns, axis=0)).tolist()
    p.update(lookback=4, start=p["dates"][4], max_weight=1.0)
    p["signals"][4] = ["attack", "attack"]
    first_window = {
        **p,
        "mode": "optimize",
        **{key: p[key][:5] for key in ("dates", "close", "split", "dividend")},
    }
    primary = {}
    for method in ("hrp", "herc", "min_variance"):
        cap = 0.75 if method == "herc" else 1.0
        optimized = run_signal_worker({**first_window, "method": method, "max_weight": cap})
        primary[method] = optimized["weights"]
        assert set(optimized["history"]) == {method, "equal"}
        assert sum(primary[method]) == pytest.approx(1.0)
        assert all(0 <= weight <= cap + 1e-6 for weight in primary[method])
    assert primary["min_variance"] != pytest.approx(primary["hrp"])
    result = run_signal_worker({**p, "method": "herc", "max_weight": 0.75})
    assert set(result["accounts"]) == {"herc", "equal"}
    assert result["schedule"][0]["weights"] == pytest.approx(primary["herc"])
    assert result["accounts"]["herc"][0]["weights"] == pytest.approx(primary["herc"])
    assert {trade["model"] for trade in result["trades"]} == {"herc", "equal"}
    failed = run_signal_worker(
        {**first_window, "method": "min_variance"}, fail_min_variance=True
    )
    assert failed["error"].startswith("最小方差 求解失败")
    assert failed["error"].endswith("未返回可行结果")


def test_attack_retreat_close_fills_and_one_sided_rebalance():
    p = signal_payload()
    p["signals"][3] = ["attack", "attack"]
    p["signals"][6] = [None, "attack"]
    p["signals"][7] = ["retreat", None]
    targets = {d: ([0.5, 0.5] if i < 4 else [0.2, 0.8]) for i, d in enumerate(p["dates"])}
    result = run_signal_worker(p, targets)
    trades = [t for t in result["trades"] if t["model"] == "hrp"]
    assert [(t["date"], t["symbol"], t["side"], t["reason"]) for t in trades] == [
        (p["dates"][3], "A", "buy", "attack"),
        (p["dates"][3], "B", "buy", "attack"),
        (p["dates"][4], "A", "sell", "threshold_reduce"),
        (p["dates"][6], "B", "buy", "attack"),
        (p["dates"][7], "A", "sell", "retreat"),
    ]
    assert all(t["price"] == 100.0 for t in trades)  # opens are deliberately 90
    rows = result["accounts"]["hrp"]
    assert rows[2]["weights"] == pytest.approx([0.2, 0.5])
    assert rows[2]["cash"] == pytest.approx(0.3)
    assert rows[4]["weights"] == pytest.approx([0.2, 0.8])
    assert rows[-1]["weights"] == pytest.approx([0.0, 0.8])


def test_threshold_boundary_and_same_day_attack_after_reduction():
    p = signal_payload()
    p["signals"][2] = ["attack", "attack"]
    p["signals"][3] = [None, "attack"]
    targets = {d: ([0.5, 0.5] if i < 3 else [0.45, 0.55]) for i, d in enumerate(p["dates"])}
    result = run_signal_worker(p, targets)
    rows = result["accounts"]["hrp"]
    assert rows[1]["weights"] == pytest.approx([0.45, 0.55])
    # threshold is inclusive, and a fresh same-day attack may consume sale proceeds
    assert any(t["reason"] == "threshold_reduce" for t in result["trades"] if t["model"] == "hrp")


def test_signal_costs_and_dividend_split_accounting():
    p = signal_payload()
    p["signals"][2] = ["attack", None]
    p["split"][3] = [2.0, 1.0]
    p["close"] = [[100.0, 100.0] for _ in p["dates"]]
    for i in range(3, 8):
        p["close"][i] = [49.0, 100.0]
    p["dividend"][3] = [2.0, 0.0]  # per pre-split share
    targets = {d: [0.5, 0.5] for d in p["dates"]}
    no_cost = run_signal_worker(p, targets)
    assert no_cost["history"]["hrp"]["return"] == pytest.approx(0.0)
    p["fee"] = 0.01
    cost = run_signal_worker(p, targets)
    assert cost["history"]["hrp"]["return"] < 0
    assert all(a["cash"] >= 0 for a in cost["accounts"]["hrp"])
    buys = [t for t in cost["trades"] if t["model"] == "hrp"]
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
    body = {"symbols": ["510300.SH"], "lookback": 2, "max_weight": 1, "initial_capital": 1235}
    with TestClient(app) as client:
        response = client.post("/api/asset-allocation/optimize", json=body)
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["weights"] == [1.0]
        assert result["target_amounts"] == {"hrp": [1235.0], "equal": [1235.0]}
        assert result["parameters"]["initial_capital"] == 1235
        assert result["parameters"]["method"] == "hrp"
        assert result["history"]["hrp"]["return"] == pytest.approx(0.2)
        legacy_body = {key: value for key, value in body.items() if key != "initial_capital"}
        legacy = client.post("/api/asset-allocation/optimize", json=legacy_body).json()
        assert legacy["parameters"]["initial_capital"] is None
        assert "target_amounts" not in legacy
        different_capital = client.post(
            "/api/asset-allocation/optimize", json={**body, "initial_capital": 2346}
        ).json()
        assert different_capital["data_version"] != result["data_version"]
        selected = client.post("/api/asset-allocation/optimize", json={**body, "method": "herc"}).json()
        assert selected["parameters"]["method"] == "herc"
        assert selected["data_version"] != result["data_version"]
        assert selected["target_amounts"] == {"herc": [1235.0], "equal": [1235.0]}
        route = "/api/asset-allocation/portfolios/11111111-1111-4111-8111-111111111111"
        assert client.put(route, json=body).json()[str(route.rsplit("/", 1)[-1])]["initial_capital"] == 1235
        invalid_body = {**body, "initial_capital": 1234.5}
        assert client.put(route, json=invalid_body).status_code == 422
        assert client.put(route, json={**body, "method": "equal"}).status_code == 422
        assert client.post("/api/asset-allocation/optimize", json={**body, "method": "equal"}).status_code == 422
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
    service.stop_worker()


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


def test_worker_timeout_recycles_process(monkeypatch):
    from concurrent.futures import TimeoutError

    process = Mock()
    process.poll.return_value = None
    monkeypatch.setattr(service, "_process", process)
    executor = Mock()
    executor.submit.return_value.result.side_effect = TimeoutError()
    monkeypatch.setattr(service, "ThreadPoolExecutor", lambda _: executor)
    with pytest.raises(ValueError, match="超时"):
        service.run_engine({})
    assert service._process is None
    process.kill.assert_called_once()


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
    body = service.Portfolio(symbols=["ONE"], max_weight=1)
    assert body.auto_refresh is False and body.rebalance == "monthly"
    service.save(key, body, request)
    payload = {"dates": ["2026-01-05"], "close": [[100]], "dividend": [[0]], "split": [[1]]}
    monkeypatch.setattr(service, "prepare", lambda *a: payload)
    monkeypatch.setattr(service, "run_engine", lambda p: {"weights": [1.0]})
    entry = service.refresh_portfolio(str(key), request)
    assert entry["status"] == "initial"
    service.confirm(
        key,
        service.Confirmation(checked_at=service.tracking(request)[str(key)]["checked_at"]),
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
            service.Confirmation(checked_at=service.tracking(request)[str(key)]["checked_at"]),
            request,
        )


def test_switching_method_invalidates_tracking_and_scheduler_reads_saved_method(tmp_path, monkeypatch):
    import uuid
    from datetime import datetime

    from fastapi import HTTPException

    request = Mock()
    repo = request.app.state.repo
    repo.store.data_dir = tmp_path
    key = uuid.uuid4()
    key_str = str(key)
    body = service.Portfolio(symbols=["ONE"], max_weight=1, auto_refresh=True)
    raw = body.model_dump(exclude={"method"})
    service.write_portfolios(request, {key_str: raw})
    prior = {
        "config": service.config_signature(body),
        "checked_at": "legacy",
        "status": "hold",
        "basis": {"date": "2026-11-09", "weights": [1], "prices": [100]},
    }
    service.write_tracking(request, {key_str: prior})
    service.save(key, body, request)
    assert service.tracking(request)[key_str]["basis"] == prior["basis"]

    methods = []

    def prepare(config, *_):
        methods.append(config.method)
        return {"dates": ["2026-11-09"], "close": [[100]], "method": config.method}

    monkeypatch.setattr(service, "prepare", prepare)
    monkeypatch.setattr(service, "cn_now", lambda: datetime(2026, 11, 9, 16))
    body.method = "herc"

    def complete_old_calculation(_):
        service.save(key, body, request)
        return {"weights": [1.0]}

    monkeypatch.setattr(service, "run_engine", complete_old_calculation)
    assert service.refresh_portfolio(key_str, request) is None
    assert service.tracking(request) == {}
    with pytest.raises(HTTPException):
        service.confirm(key, service.Confirmation(checked_at="legacy"), request)
    monkeypatch.setattr(service, "run_engine", lambda _: {"weights": [1.0]})
    assert service.refresh(key, request)["method"] == "herc"
    service.refresh_saved(repo)
    entry = service.tracking(request)[key_str]
    assert entry["method"] == "herc" and entry["status"] == "initial"
    assert entry["basis"] is None
    service.confirm(key, service.Confirmation(checked_at=entry["checked_at"]), request)
    assert service.tracking(request)[key_str]["basis"]["weights"] == [1]
    body.method = "hrp"
    service.save(key, body, request)
    assert service.tracking(request) == {}
    assert methods == ["hrp", "herc", "herc"]


def test_same_day_weights_are_causal_and_missing_signals_fail_closed():
    import numpy as np

    p = signal_payload()
    values = 100 * np.cumprod(1 + np.random.default_rng(17).normal(0, 0.01, (8, 2)), axis=0)
    p["close"] = values.tolist()
    p["signals"][3] = ["attack", "attack"]
    original = run_signal_worker(p)
    p["close"][-1][0] *= 2
    changed = run_signal_worker(p)
    assert original["schedule"][:-1] == changed["schedule"][:-1]
    assert original["schedule"][-1]["weights"] != changed["schedule"][-1]["weights"]
    assert [t for t in original["trades"] if t["date"] < p["dates"][-1]] == [
        t for t in changed["trades"] if t["date"] < p["dates"][-1]
    ]
    del p["signals"]
    import subprocess

    with pytest.raises(subprocess.CalledProcessError):
        run_signal_worker(p)


def test_scheduler_only_visits_enabled_portfolios_after_close(tmp_path, monkeypatch):
    from datetime import datetime

    repo = Mock()
    repo.store.data_dir = tmp_path
    request = Mock()
    request.app.state.repo = repo
    service.write_portfolios(
        request,
        {
            "enabled": {"auto_refresh": True, "symbols": ["A"]},
            "old": {"symbols": ["B"]},
            "draft": {"auto_refresh": True, "symbols": []},
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
    service.save(key, service.Portfolio(symbols=["ONE"], max_weight=1), request)
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
            symbols=["512000.SH"], lookback=3, max_weight=1, start=dates[25], end=dates[-1]
        ),
        repo,
        "backtest",
    )
    assert payload["rule_version"] == "angel_devil_close_v1"
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
                symbols=["512000.SH"], lookback=3, max_weight=1, start=dates[25], end=dates[-1]
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
                "max_weight": 1,
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
        assert result["rule_version"] == "angel_devil_close_v1"
        assert len(result["schedule"]) == 20
        assert result["trades"] == []
        assert result["accounts"]["hrp"][0]["cash"] == 1.0
