"""Descriptive AMMR scores and causal chart integration."""

import math

import pytest

from app.services.trend_patterns import analyze


def rows(closes):
    from datetime import date, timedelta

    return [
        dict(
            date=str(date(2025, 1, 1) + timedelta(days=i)),
            open=c,
            high=c * 1.01,
            low=c * 0.99,
            close=c,
            volume=100,
            is_closed=True,
        )
        for i, c in enumerate(closes)
    ]


@pytest.mark.parametrize(("sign", "env"), [(1, "up"), (-1, "down")])
def test_trend_and_contributions(sign, env):
    r = analyze(rows([100 + sign * i * 0.3 for i in range(100)]), symbol="TEST")[
        "momentumReversion"
    ]
    assert r["status"] == "ok"
    assert r["environment"] == env
    assert sign * r["momentum"]["score"] >= 20
    assert round(sum(r["momentum"]["components"].values()), 1) == r["momentum"]["score"]
    assert 0 <= r["reversion"]["score"] <= 100


def test_flat_insufficient_and_scale():
    r = analyze(rows([100.0] * 100), symbol="TEST")["momentumReversion"]
    assert r["environment"] == "range"
    assert r["metrics"]["z20"] is None
    assert r["momentum"]["score"] == 0
    assert r["reversion"]["score"] == 0
    assert (
        analyze(rows([100.0] * 64), symbol="TEST")["momentumReversion"]["status"] == "insufficient"
    )
    prices = [100 + i * 0.1 + math.sin(i) * 2 for i in range(100)]
    a, b = [
        analyze(rows([c * s for c in prices]), symbol="TEST")["momentumReversion"]
        for s in (1, 0.001)
    ]
    assert a["momentum"]["score"] == b["momentum"]["score"]
    assert a["reversion"]["score"] == b["reversion"]["score"]


def test_cutoff_forming_and_tail():
    data = rows([100 + i * 0.3 for i in range(100)])
    original = analyze(data, symbol="TEST")
    future = rows([100 + i * 0.3 for i in range(110)])
    assert (
        analyze(future, symbol="TEST", as_of=data[-1]["date"])["momentumReversion"]
        == original["momentumReversion"]
    )
    future = [*data, {**rows([1.0] * 101)[-1], "is_closed": False}]
    assert analyze(future, symbol="TEST")["momentumReversion"] == original["momentumReversion"]
    assert (
        analyze(data, symbol="TEST", tail=1)["momentumReversion"] == original["momentumReversion"]
    )


@pytest.mark.parametrize("period", ["1d", "1w", "1mo", "30m"])
def test_periods(period):
    assert (
        analyze(rows([100 + i * 0.1 for i in range(80)]), symbol="TEST", period=period)[
            "momentumReversion"
        ]["status"]
        == "ok"
    )


@pytest.mark.parametrize("sign", [-1, 1])
def test_extreme_and_recovery(sign):
    baseline = [100 + math.sin(i) * 0.1 for i in range(90)]
    extreme = analyze(rows([*baseline, 100 + sign * 8]), symbol="TEST")["momentumReversion"]
    assert extreme["reversion"]["state"] == "deviation"
    assert extreme["reversion"]["score"] <= 39
    recovering = analyze(rows([*baseline, 100 + sign * 8, 100 + sign * 5]), symbol="TEST")[
        "momentumReversion"
    ]
    assert recovering["reversion"]["state"] == "recovering"
    assert recovering["reversion"]["side"] == ("low" if sign < 0 else "high")
    complete = analyze(rows([*baseline, 100 + sign * 8, 100 - sign]), symbol="TEST")[
        "momentumReversion"
    ]
    assert complete["reversion"]["state"] == "completed"
    assert complete["reversion"]["score"] == 0


@pytest.mark.parametrize(("hist", "direction"), [(1, "strong"), (-1, "weak")])
def test_exact_momentum_threshold(hist, direction):
    from app.services.trend_patterns.momentum_reversion import analyze_momentum_reversion

    candles = [dict(c=101 if i == 0 else 100, d=str(i)) for i in range(65)]
    ind = dict(
        atr14=[1.0] * 65,
        ma={"ma20": [100.0] * 65, "ma60": [100.0] * 65},
        boll={"up": [102.0] * 65, "dn": [98.0] * 65},
        macd={"hist": [hist] * 65},
        rsi=[50.0] * 65,
    )
    result = analyze_momentum_reversion(candles, ind)
    assert result["momentum"]["score"] == hist * 20
    assert result["momentum"]["direction"] == direction
    ind["atr14"][-1] = 0
    assert analyze_momentum_reversion(candles, ind)["status"] == "unavailable"


@pytest.mark.parametrize(
    ("env", "side", "state", "maturity", "score", "delta", "price", "code"),
    [
        ("unknown", "low", "recovering", 70, -10, 5, 99, "pullback"),
        ("range", "low", "recovering", 70, -10, 5, 99, "range_buy"),
        ("down", "low", "recovering", 95, 20, 10, 99, "weak_rebound"),
        ("unknown", "low", "recovering", 69.9, -10, 5, 99, "wait"),
        ("range", "low", "recovering", 70, -10, 4.9, 99, "wait"),
        ("range", "low", "deviation", 90, -10, 5, 99, "wait"),
        ("unknown", "low", "recovering", 90, -10, 5, 95, "wait"),
        ("range", "low", "completed", 0, 20, 5, 101, "completed"),
        ("up", "high", "recovering", 75, 55, -5, 103, "high_risk"),
        ("up", "high", "deviation", 39, 80, 5, 103, "overheat"),
        ("up", "none", "none", 0, 50, 5, 101, "trend"),
        ("down", "none", "none", 0, -50, -5, 99, "defend"),
    ],
)
def test_opportunity_conclusions(env, side, state, maturity, score, delta, price, code):
    from app.services.trend_patterns.momentum_reversion import opportunity

    result = opportunity(
        env,
        dict(ma20=100, ma60=95, slope=0.5, z20=2 if side == "high" else -1),
        score,
        delta,
        dict(side=side, state=state, started=state == "recovering", score=maturity),
        price,
    )
    assert result["code"] == code
    assert result["reason"]
    assert isinstance(result["pending"], list)
