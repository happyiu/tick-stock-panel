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


def test_invalid_constraints_precede_data_access():
    with pytest.raises(ValueError, match="70%"):
        service.prepare(service.Calculation(symbols=["a", "b"]), Mock(), "optimize")


def test_worker_income_fees_and_no_future():
    # riskfolio is optional in the application environment; test through the isolated runtime below.
    import json
    import subprocess

    python = Path(__file__).parents[1] / "allocation-engine/.venv/bin/python"
    if not python.exists():
        pytest.skip("install allocation-engine first")
    dates = pd.bdate_range("2026-01-01", "2026-04-10")
    prices = [100.0] * len(dates)
    dividend = [0.0] * len(dates)
    event = list(dates).index(pd.Timestamp("2026-02-02"))
    for i in range(event, len(dates)):
        prices[i] = 99.0
    dividend[event] = 1.0
    payload = dict(
        symbols=["ONE"],
        dates=[str(x.date()) for x in dates],
        close=[[p] for p in prices],
        open=[[p] for p in prices],
        dividend=[[x] for x in dividend],
        split=[[1] for _ in dates],
        lookback=3,
        max_weight=1.0,
        mode="backtest",
        start="2026-02-02",
        end="2026-04-10",
        fee=0.0,
        slippage=0.0,
    )

    def run(p):
        output = subprocess.check_output(
            [str(python), str(Path(service.__file__).with_name("_allocation_worker.py"))],
            input=json.dumps(p) + "\n",
            text=True,
        )
        return json.loads(output)["result"]

    original = run(payload)
    # Initial buyers on the ex-dividend date must not receive the prior owners' cash.
    assert original["history"]["hrp"]["return"] == pytest.approx(0.0)
    assert len(original["trades"]) == 6
    payload["fee"] = 0.001
    assert run(payload)["history"]["hrp"]["return"] < 0
    payload["fee"] = 0
    payload["close"][-1] = [120.0]
    changed = run(payload)
    assert changed["trades"][0] == original["trades"][0]


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
    body = {"symbols": ["510300.SH"], "lookback": 2, "max_weight": 1}
    with TestClient(app) as client:
        response = client.post("/api/asset-allocation/optimize", json=body)
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["weights"] == [1.0]
        assert result["history"]["hrp"]["return"] == pytest.approx(0.2)
        route = "/api/asset-allocation/portfolios/11111111-1111-4111-8111-111111111111"
        assert client.put(route, json=body).status_code == 200
        recommendation = client.post(route + "/refresh").json()
        assert recommendation["status"] == "initial"
        assert client.post(route + "/confirm", json={"checked_at": "stale"}).status_code == 409
        assert client.post(route + "/confirm", json={"checked_at": recommendation["checked_at"]}).status_code == 200
        stored = client.get("/api/asset-allocation/tracking").json()
        assert next(iter(stored.values()))["basis"]["weights"] == [1.]

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


def test_hrp_rebalance_uses_only_preceding_prices():
    import json
    import subprocess

    import numpy as np

    python = Path(__file__).parents[1] / "allocation-engine/.venv/bin/python"
    dates = pd.bdate_range("2026-01-01", "2026-04-10")
    rng = np.random.default_rng(17)
    prices = 100 * np.cumprod(1 + rng.normal(0, 0.01, (len(dates), 3)), axis=0)
    payload = dict(
        symbols=["A", "B", "C"],
        dates=[str(d.date()) for d in dates],
        close=prices.tolist(),
        open=prices.tolist(),
        dividend=np.zeros_like(prices).tolist(),
        split=np.ones_like(prices).tolist(),
        lookback=10,
        max_weight=0.5,
        mode="backtest",
        start="2026-02-02",
        end="2026-04-10",
        fee=0.0,
        slippage=0.0,
    )

    def run():
        output = subprocess.check_output(
            [str(python), str(Path(service.__file__).with_name("_allocation_worker.py"))],
            input=json.dumps(payload) + "\n",
            text=True,
        )
        return json.loads(output)["result"]

    original = run()
    payload["close"][-1][0] *= 2
    changed = run()
    assert changed["trades"] == original["trades"]
    assert changed["history"]["hrp"]["return"] != original["history"]["hrp"]["return"]


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


def test_daily_threshold_backtest_and_no_future():
    import json
    import subprocess

    import numpy as np

    python = Path(__file__).parents[1] / "allocation-engine/.venv/bin/python"
    dates = pd.bdate_range("2026-01-01", "2026-03-10")
    prices = 100 * np.cumprod(
        1 + np.random.default_rng(33).normal(0, 0.02, (len(dates), 3)), axis=0
    )
    p = dict(
        symbols=["A", "B", "C"],
        dates=[str(d.date()) for d in dates],
        close=prices.tolist(),
        open=prices.tolist(),
        split=np.ones_like(prices).tolist(),
        dividend=np.zeros_like(prices).tolist(),
        lookback=10,
        max_weight=0.5,
        mode="backtest",
        rebalance="daily_threshold",
        threshold=1.0,
        start="2026-02-03",
        end="2026-03-10",
        fee=0.0,
        slippage=0.0,
    )

    def run():
        output = subprocess.check_output(
            [str(python), str(Path(service.__file__).with_name("_allocation_worker.py"))],
            input=json.dumps(p) + "\n",
            text=True,
        )
        return json.loads(output)["result"]

    passive = run()
    assert len(passive["trades"]) == 2
    assert passive["trades"][0]["date"] == "2026-02-03"
    p["threshold"] = 0.001
    active = run()
    assert len(active["trades"]) > 2
    assert all(t["reason"] in ("initial", "threshold") for t in active["trades"])
    p["close"][-1][0] *= 2
    changed = run()
    assert changed["trades"] == active["trades"]


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
