import json
from datetime import date, datetime
from pathlib import Path
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
    [(0, 0.7, "中性"), (60, 0.7, "中性"), (60.01, 0.9, "牛市"), (100, 0.9, "牛市")],
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
    assert preview["etf_allocations"] == []
    assert preview["cash_weight"] == 1
    assert "etf_allocations" not in backtest
    assert backtest["position_history"] == points
    assert [point["total_position"] for point in backtest["position_history"]] == [0.5, 0.7, 0.7, 0.9]


@pytest.mark.parametrize(
    ("scores", "cap", "expected"),
    [
        ([30, 20, 80], 0.35, [0.7 * 900 / 7700, 0.7 * 400 / 7700, 0.35]),
        ([30, 20, 80], 1, [0.7 * 900 / 7700, 0.7 * 400 / 7700, 0.7 * 6400 / 7700]),
        ([None, 20, 80], 0.35, [0, 0.7 * 400 / 6800, 0.35]),
        ([0, None], 0.35, [0, 0]),
        ([], 0.35, []),
    ],
)
def test_devil_trader_allocates_scores_without_redistributing_overflow(scores, cap, expected):
    symbols = [f"ETF{i}" for i in range(len(scores))]
    result = _allocation_calculation.score_allocation(symbols, scores, 0.7, cap, 100_000)
    rows = result["etf_allocations"]
    assert [row["score"] for row in rows] == scores
    assert [row["weight"] for row in rows] == pytest.approx(expected)
    assert result["cash_weight"] == pytest.approx(1 - sum(expected))
    assert sum(row["amount"] for row in rows) + result["cash_amount"] == pytest.approx(100_000)
    assert all(row["amount"] / 100_000 <= min(row["weight"], cap) for row in rows)
    assert sum(row["amount"] for row in rows) / 100_000 <= 0.7
    if scores == [30, 20, 80] and cap == 0.35:
        assert [row["amount"] for row in rows] == [8181.81, 3636.36, 35000.0]
        assert result["cash_amount"] == 53181.83


def test_daily_etf_score_uses_aligned_closed_inputs_and_matches_frontend(monkeypatch):
    import polars as pl

    from app.services import technical_scoring, watchlist_market_trends

    sample_path = Path(__file__).parents[2] / "frontend/src/lib/fixtures/allocation_score_sample.json"
    sample = json.loads(sample_path.read_text())
    as_of = date.fromisoformat(sample["daily"]["as_of"])
    prices = pl.DataFrame({
        "date": [date(2026, 10, 30), date(2026, 11, 5), as_of, date(2026, 11, 9)],
        "open": [1.0] * 4, "high": [3.0] * 4, "low": [1.0] * 4,
        "close": [1.0, 1.0, 2.0, 3.0], "volume": [100.0] * 4,
    })
    request = Mock()
    repo = request.app.state.repo
    repo.get_etf_daily.return_value = prices
    repo.get_minute_range.return_value = pl.DataFrame()
    request.app.state.chart_data_service = None
    monkeypatch.setattr(service, "cn_now", lambda: datetime(2026, 11, 9, 10))

    def daily_categories(frame):
        assert frame["date"][-1] == as_of
        assert frame["symbol"].unique().to_list() == ["510300.SH"]
        return sample["daily"]["categories"]

    def signals(rows):
        if rows and isinstance(rows[0]["date"], date):
            assert all(row["date"] <= as_of for row in rows)
        # Week and day both end in the same bar; their independent signals differ.
        return [
            "attack" if row["date"] == as_of and len(rows) == 3 else "retreat"
            for row in rows
        ]

    monkeypatch.setattr(technical_scoring, "latest_technical_categories", daily_categories)
    monkeypatch.setattr(watchlist_market_trends, "angel_devil_signals", signals)
    def daily_scores(day):
        return service._composite_scores(request, "510300.SH", "etf", day, day)

    assert daily_scores(as_of) == [{"date": str(as_of), "score": sample["composite_score"]}]
    assert daily_scores(date(2026, 11, 9)) == []
    repo.get_etf_daily.return_value = prices.filter(pl.col("date") < as_of)
    assert daily_scores(as_of) == []


def test_batched_etf_scores_match_single_day_without_reading_future_candles(monkeypatch):
    from datetime import timedelta

    import polars as pl

    from app.services import technical_scoring

    sample_path = Path(__file__).parents[2] / "frontend/src/lib/fixtures/allocation_score_sample.json"
    categories = json.loads(sample_path.read_text())["daily"]["categories"]
    start = date(2024, 1, 1)
    dates = [start + timedelta(days=i) for i in range(700)]
    closes = [10 + (i % 55) / 20 for i in range(len(dates))]
    bars = pl.DataFrame({
        "date": dates, "open": closes, "high": closes, "low": closes, "close": closes,
        "volume": [100.0] * len(dates),
    })
    request = Mock()
    request.app.state.chart_data_service = None
    repo = request.app.state.repo
    repo.get_etf_daily.return_value = bars
    repo.get_index_daily.return_value = bars.select("date")
    repo.get_minute_range.return_value = pl.DataFrame()
    monkeypatch.setattr(service, "cn_now", lambda: datetime(2026, 1, 1, 16))
    monkeypatch.setattr(technical_scoring, "latest_technical_categories", lambda frame: categories)
    days = dates[-12:]

    points = service._composite_scores(request, "510300.SH", "etf", days[0], days[-1], etf_days=days)
    assert repo.get_etf_daily.call_count == repo.get_minute_range.call_count == 1
    assert all(point["score"] is not None for point in points)
    averages = service._rolling_score_averages(days, points)
    for day in days[4:]:
        assert averages[str(day)] == service.etf_composite_score(request, "510300.SH", day)

    repo.get_etf_daily.return_value = bars.with_columns(
        pl.when(pl.col("date") > days[0]).then(1000.0).otherwise(pl.col("close")).alias("close")
    )
    changed = service._composite_scores(request, "510300.SH", "etf", days[0], days[-1], etf_days=days)
    assert changed[0] == points[0]


def test_replay_threshold_and_position_change_use_last_successful_allocation():
    days = [f"2026-11-{i:02}" for i in range(1, 8)]
    market = dict(zip(days, [60, 60, 60, 60, 60, 61, 61], strict=True))
    scores = [
        dict(zip(days, [None, 0, 10, 10, 12, 10, 10], strict=True)),
        dict(zip(days, [10, 10, 30, 20, 20, None, 20], strict=True)),
    ]
    result = _allocation_calculation.replay_tracking(days, market, ["A", "B"], scores, .29, .07)
    initial, deviation, change = result["events"]
    assert [(event["date"], event["reason"]) for event in result["events"]] == [
        (days[1], "initial"), (days[3], "deviation"), (days[6], "position_change"),
    ]
    assert initial["previous_cash"] == 1
    assert deviation["max_deviation"] == pytest.approx(.14)
    assert change["previous_position"] == .7
    assert change["total_position"] == .9
    assert change["etf_allocations"][0]["previous_weight"] == pytest.approx(.14)
    assert change["cash_weight"] == pytest.approx(.53)
    assert [row["equal_weight"] for row in change["etf_allocations"]] == pytest.approx([.29, .29])
    assert change["equal_cash_weight"] == pytest.approx(.42)
    assert change["max_deviation"] < .07
    assert [day["date"] for day in result["skipped"]] == [days[0], days[5]]
    no_scores = _allocation_calculation.replay_tracking(days, {}, ["A"], [{}], .3, .05)
    assert not no_scores["events"]
    assert len(no_scores["skipped"]) == len(days)
    assert no_scores["skipped"][0] == {"date": days[0], "market_missing": True, "symbols": ["A"]}


def test_tracking_performance_marks_to_market_and_accounts_for_actions_and_trade_costs():
    days = [f"2026-11-{i:02}" for i in range(2, 6)]
    events = [
        {"date": day, "total_position": .7, "etf_allocations": [
            {"symbol": symbol, "weight": weight, "equal_weight": .25}
            for symbol, weight in zip(["A", "B"], weights, strict=True)
        ]}
        for day, weights in [(days[0], [.5, 0]), (days[2], [0, .5])]
    ]
    result, trades = _allocation_calculation.tracking_performance(
        days, [[10, 10], [6, 8], [6, 8], [6, 4]],
        [[0, 0], [1, 0], [0, 0], [0, 0]], [[1, 1], [2, 1], [1, 1], [1, 1]],
        [["attack", None], [None, None], ["retreat", "attack"], [None, None]],
        events, .02,
    )
    initial = 1 / 1.01
    equal_initial = 1 / 1.005
    scheme_rebalance = initial * (1.15 - .012) / 1.01
    equal_rebalance = equal_initial * (1.075 - .006) / 1.005
    assert [(t["date"], t["symbol"], t["side"], t["price"]) for t in trades if t["model"] == "scheme"] == [
        (days[0], "A", "buy", 10), (days[2], "A", "sell", 6), (days[2], "B", "buy", 8),
    ]
    assert next(t["realized_pnl"] for t in trades if t["model"] == "scheme" and t["side"] == "sell") == pytest.approx(.1267326732673268)
    assert next(t["realized_pnl"] for t in trades if t["model"] == "equal" and t["side"] == "sell") == pytest.approx(.063681592039801)
    for model, initial, before, rebalance, end in [
        ("scheme", initial, 1.15 * initial, scheme_rebalance, .75 * scheme_rebalance),
        ("equal", equal_initial, 1.075 * equal_initial, equal_rebalance, .875 * equal_rebalance),
    ]:
        history = result[model]
        assert [p["date"] for p in history["points"]] == days
        assert [p["value"] for p in history["points"]] == pytest.approx([initial, before, rebalance, end])
        assert history["points"][0]["drawdown"] == pytest.approx(initial - 1)
        assert history["return"] == pytest.approx(end - 1)
        assert history["drawdown"] == pytest.approx(end / before - 1)


def test_tracking_target_updates_wait_for_each_etf_signal():
    days = [f"2026-11-{i:02}" for i in range(1, 8)]
    events = [
        {"date": days[i], "total_position": .7, "etf_allocations": [
            {"symbol": "A", "weight": weight, "equal_weight": .35},
            {"symbol": "B", "weight": .1, "equal_weight": .35},
        ]}
        for i, weight in [(0, .25), (2, .15), (3, .4), (4, .45), (5, .5)]
    ]
    result, trades = _allocation_calculation.tracking_performance(
        days, [[10, 10]] * 7, [[0, 0]] * 7, [[1, 1]] * 7,
        [[None, None], ["attack", None], [None, None], [None, None],
         ["retreat", None], [None, None], ["attack", None]],
        events, 0,
    )
    scheme = [t for t in trades if t["model"] == "scheme"]
    assert [(t["date"], t["symbol"], t["side"], t["reason"]) for t in scheme] == [
        (days[1], "A", "buy", "attack"), (days[4], "A", "sell", "retreat"),
        (days[6], "A", "buy", "attack"),
    ]
    assert [t["weight"] for t in scheme] == pytest.approx([.25, 0, .5])
    assert result["scheme"]["return"] == pytest.approx(0)


def test_tracking_attack_uses_remaining_exposure_without_resizing_other_etfs():
    days = ["2026-11-05", "2026-11-06"]
    events = [{"date": days[0], "total_position": .7, "etf_allocations": [
        {"symbol": symbol, "weight": .35, "equal_weight": .35} for symbol in ("A", "B")
    ]}]
    _, trades = _allocation_calculation.tracking_performance(
        days, [[10, 10], [20, 10]], [[0, 0]] * 2, [[1, 1]] * 2,
        [["attack", None], [None, "attack"]], events, 0,
    )
    scheme = [t for t in trades if t["model"] == "scheme"]
    assert [(t["date"], t["symbol"]) for t in scheme] == [(days[0], "A"), (days[1], "B")]
    assert scheme[-1]["weight"] == pytest.approx(.7 - .7 / 1.35)


def test_tracking_history_uses_closed_index_sessions_and_current_draft(monkeypatch):
    import polars as pl
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(service.router)
    repo = app.state.repo = Mock()
    repo.get_etf_symbol_set.return_value = {"A"}
    repo.get_name_map.return_value = {"A": "ETF A"}
    from app.services import watchlist_market_trends

    days = [date(2026, 11, 5), date(2026, 11, 6)]
    warmup = [date.fromordinal(days[0].toordinal() - offset) for offset in range(21, 0, -1)]
    repo.get_index_daily.return_value = pl.DataFrame({"date": warmup + days})
    repo.get_etf_daily.return_value = pl.DataFrame({"date": warmup + days, "raw_close": [10.] * 22 + [12.]})
    actions = Mock(return_value=[])
    monkeypatch.setattr(service, "etf_action_rows", actions)
    monkeypatch.setattr(service, "cn_now", lambda: datetime(2026, 11, 6, 10))
    indicator = Mock(side_effect=lambda rows: ["attack" if row["date"] == str(days[0]) else None for row in rows])
    monkeypatch.setattr(watchlist_market_trends, "angel_devil_signals", indicator)
    score = Mock(side_effect=lambda request, symbol, *args, **kwargs: [
        {"date": str(day), "score": 37 if symbol == "000001.SH" else 50} for day in [*warmup[-4:], days[0]]
    ])
    monkeypatch.setattr(service, "_composite_scores", score)
    with TestClient(app) as client:
        body = {"symbols": ["A"], "start": str(days[0]), "end": str(days[1]), "fee": .01, "slippage": .01}
        response = client.post("/api/asset-allocation/tracking-history", json=body)
        assert response.status_code == 200
        result = response.json()
        assert result["start"] == result["end"] == str(days[0])
        assert result["sessions"] == result["requested_sessions"] == 1
        assert result["events"][0]["cash_weight"] == pytest.approx(.65)
        assert result["history"]["equal"]["drawdown"] == pytest.approx(1 / 1.007 - 1)
        assert score.call_args.kwargs["etf_days"] == [*warmup[-4:], days[0]]
        assert indicator.call_args.args[0][-1]["date"] == str(days[0])
        assert result["trades"][0]["reason"] == "attack"
        monkeypatch.setattr(service, "cn_now", lambda: datetime(2026, 11, 6, 16))
        result = client.post("/api/asset-allocation/tracking-history", json=body).json()
        assert result["skipped"][0]["date"] == str(days[1])
        assert result["history"]["scheme"]["points"][1]["value"] == pytest.approx(1.07 / 1.007)

        actions.side_effect = ValueError("事件覆盖无法确认")
        result = client.post("/api/asset-allocation/tracking-history", json=body).json()
        assert result["events"] and "事件覆盖无法确认" in result["performance_error"]
        repo.get_etf_daily.return_value = pl.DataFrame({"date": days[:1], "raw_close": [10.]})
        actions.side_effect = None
        result = client.post("/api/asset-allocation/tracking-history", json=body).json()
        assert result["events"] and "2026-11-06 缺少有效的未复权收盘价" in result["performance_error"]
        assert "history" not in result
        assert client.post("/api/asset-allocation/tracking-history", json={**body, "fee": -.01}).status_code == 422
        assert client.post("/api/asset-allocation/tracking-history", json={"symbols": ["A", "A"]}).status_code == 422


def test_optimize_returns_scores_in_portfolio_order_and_invalidates_on_score_change(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(service.router)
    repo = app.state.repo = Mock()
    symbols = ["510300.SH", "512000.SH"]
    repo.get_etf_symbol_set.return_value = set(symbols)
    repo.get_name_map.return_value = {symbols[0]: "沪深300"}
    monkeypatch.setattr(service, "market_environment_position_history", lambda *args, **kwargs: [
        {"date": "2026-11-06", "score": 37, "regime": "中性", "total_position": 0.7},
    ])
    scores = {symbols[0]: 70, symbols[1]: None}
    score = Mock(side_effect=lambda _request, symbol, as_of: scores[symbol] if as_of == date(2026, 11, 6) else None)
    monkeypatch.setattr(service, "etf_composite_score", score)

    with TestClient(app) as client:
        capability = client.get("/api/asset-allocation/schemes").json()["schemes"]["devil_trader"]
        assert capability["current_weights_ready"] and capability["position_ready"] and not capability["ready"]
        body = {"symbols": symbols, "max_weight": 0.2}
        first = client.post("/api/asset-allocation/optimize", json=body).json()
        assert first["etf_allocations"] == [
            {"symbol": symbols[0], "score": 70, "weight": 0.2},
            {"symbol": symbols[1], "score": None, "weight": 0},
        ]
        assert first["cash_weight"] == 0.8
        assert "cash_amount" not in first
        scores[symbols[1]] = 30
        second = client.post("/api/asset-allocation/optimize", json=body).json()
        assert second["cash_weight"] == pytest.approx(1 - .2 - .7 * 900 / 5800)
        assert second["data_version"] != first["data_version"]
        bad = client.post("/api/asset-allocation/optimize", json={"symbols": [symbols[0]] * 2})
        assert bad.status_code == 422


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
            "name": "魔鬼操盘手", "ready": False, "position_ready": True, "current_weights_ready": True
        }
        assert schemes["schemes"]["test"] == {
            "name": "测试方案", "ready": True, "position_ready": False, "current_weights_ready": False
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
