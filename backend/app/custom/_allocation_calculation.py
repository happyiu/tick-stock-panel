# ruff: noqa: RUF001
"""Allocation schemes and their shared historical simulation."""

from collections.abc import Callable, Sequence
from decimal import Decimal
from math import isclose

import numpy as np

BACKTEST_RULE_VERSION = "angel_devil_scheme_close_v1"

# Map a stable scheme ID to its display name and weight function.
AllocationFunction = Callable[[list[str], np.ndarray, float], Sequence[float] | np.ndarray]
DEFAULT_SCHEME_ID = "devil_trader"
POSITION_ONLY_SCHEMES = frozenset({DEFAULT_SCHEME_ID})
CURRENT_SCORE_SCHEMES = frozenset({DEFAULT_SCHEME_ID})
SCHEMES: dict[str, tuple[str, AllocationFunction | None]] = {
    DEFAULT_SCHEME_ID: ("魔鬼操盘手", None),
}


def total_position_for_score(score):
    if isinstance(score, bool) or not isinstance(score, (int, float)) or not np.isfinite(score) or not 0 <= score <= 100:
        raise ValueError("市场环境得分不可用，无法确定总仓位")
    if score <= 60:
        return 0.7, "中性"
    return 0.9, "牛市"


def score_allocation(symbols, scores, total_position, max_weight, capital):
    """Allocate by squared score; capped weights and fractional cents stay in cash."""
    precise_scores = [Decimal(str(score)) if score is not None else Decimal(0) for score in scores]
    score_square_sum = sum((score * score for score in precise_scores), Decimal(0))
    budget, cap = Decimal(str(total_position)), Decimal(str(max_weight))
    weights = [
        min(cap, budget * score_value * score_value / score_square_sum)
        if score is not None and score_square_sum else Decimal(0)
        for score, score_value in zip(scores, precise_scores, strict=True)
    ]
    rows = [
        {"symbol": symbol, "score": score, "weight": float(weight)}
        for symbol, score, weight in zip(symbols, scores, weights, strict=True)
    ]
    result = {"etf_allocations": rows, "cash_weight": float(1 - sum(weights))}
    if capital is not None:
        remaining_cents = capital * 100
        for row, weight in zip(rows, weights, strict=True):
            cents = int(weight * capital * 100)
            row["amount"] = cents / 100
            remaining_cents -= cents
        result["cash_amount"] = remaining_cents / 100
    return result


def replay_tracking(days, market, symbols, score_series, max_weight, threshold):
    events, skipped = [], []
    previous_position = None
    previous_weights = [0.0] * len(symbols)
    previous_cash = 1.0
    for day in days:
        market_score = market.get(day)
        scores = [series.get(day) for series in score_series]
        missing = [symbol for symbol, score in zip(symbols, scores, strict=True) if score is None]
        if market_score is None or missing:
            skipped.append({"date": day, "market_missing": market_score is None, "symbols": missing})
            continue

        position, _ = total_position_for_score(market_score)
        allocation = score_allocation(symbols, scores, position, max_weight, None)
        rows = allocation["etf_allocations"]
        changes = [row["weight"] - old for row, old in zip(rows, previous_weights, strict=True)]
        deviation = max(map(abs, changes))
        if previous_position is None:
            reason = "initial"
        elif position != previous_position:
            reason = "position_change"
        elif deviation > threshold and not isclose(deviation, threshold, rel_tol=0, abs_tol=1e-12):
            reason = "deviation"
        else:
            continue

        cash = allocation["cash_weight"]
        equal_weight = min(max_weight, position / len(symbols))
        events.append({
            "date": day,
            "reason": reason,
            "market_score": market_score,
            "previous_position": previous_position,
            "total_position": position,
            "max_deviation": deviation if previous_position is not None else None,
            "etf_allocations": [
                {**row, "previous_weight": old, "change": change, "equal_weight": equal_weight}
                for row, old, change in zip(rows, previous_weights, changes, strict=True)
            ],
            "previous_cash": previous_cash,
            "cash_weight": cash,
            "equal_cash_weight": 1 - equal_weight * len(symbols),
        })
        previous_position = position
        previous_weights = [row["weight"] for row in rows]
        previous_cash = cash
    return {"events": events, "skipped": skipped}


def scheme_unavailability(scheme_id):
    scheme = SCHEMES.get(scheme_id)
    if scheme is None:
        return "请选择可用的配置方案"
    if scheme[1] is None:
        return f"{scheme[0]}的规则待补充"
    return None


def weights(symbols, returns, cap, scheme_id):
    if error := scheme_unavailability(scheme_id):
        raise ValueError(error)
    label, allocate = SCHEMES[scheme_id]
    result = np.array(allocate(list(symbols), returns, cap), dtype=float)
    if (
        result.shape != (len(symbols),)
        or not np.isfinite(result).all()
        or (result < 0).any()
        or (result > cap + 1e-9).any()
        or abs(result.sum() - 1) > 1e-9
    ):
        raise ValueError(f"{label} 返回的目标仓位违反配置约束")
    return result


def performance(nav, dates, *, include_daily_drawdown=False):
    values = np.asarray(nav)
    peaks = np.maximum.accumulate(values)
    if include_daily_drawdown:
        peaks = np.maximum(1.0, peaks)
    drawdowns = values / peaks - 1
    return {
        "return": float(values[-1] - 1),
        "drawdown": float(drawdowns.min()),
        "points": [
            {"date": day, "value": float(value), **({"drawdown": float(drawdown)} if include_daily_drawdown else {})}
            for day, value, drawdown in zip(dates, values, drawdowns, strict=True)
        ],
    }


def tracking_performance(days, close, dividend, split, signals, events, rate):
    """Trade only on per-ETF signals, using the latest allocation target for entries."""
    close, dividend, split = (np.asarray(matrix, dtype=float) for matrix in (close, dividend, split))
    by_day = {event["date"]: event for event in events}
    symbols = [row["symbol"] for row in events[0]["etf_allocations"]]
    histories = {}
    trades = []
    for model, weight_key in (("scheme", "weight"), ("equal", "equal_weight")):
        shares = np.zeros(close.shape[1])
        cost_basis = np.zeros(close.shape[1])
        accrued_dividends = np.zeros(close.shape[1])
        active = np.zeros(len(symbols), dtype=bool)
        target = np.zeros(len(symbols))
        position = 0.0
        cash = 1.0
        nav = []
        for i, (day, daily_signals) in enumerate(zip(days, signals, strict=True)):
            dividends_today = shares * dividend[i]
            cash += float(dividends_today.sum())
            accrued_dividends += dividends_today
            shares *= split[i]
            prices = close[i]
            held = shares * prices
            equity = cash + float(held.sum())
            if not np.isfinite(equity) or equity <= 0:
                raise ValueError(f"{day} 模拟资产金额无效")
            update = by_day.get(day)
            if update is not None:
                target = np.array([row[weight_key] for row in update["etf_allocations"]])
                position = update["total_position"]
            signal = np.asarray(daily_signals, dtype=object)
            enter = (signal == "attack") & ~active
            retreat = signal == "retreat"
            active = (active | enter) & ~retreat
            resize = enter
            if resize.any() or (retreat & (held > 0)).any():
                traded = resize | retreat
                fixed = float(held[~traded].sum())
                target_weights = target[resize]
                target_sum = float(target_weights.sum())

                def targets_at(net):
                    # Leave untouched holdings in place and fit buys within the remaining exposure.
                    budget = net
                    if target_sum:
                        budget = min(net, max(0.0, net * position - fixed) / target_sum)
                    amounts = held.copy()
                    amounts[traded] = 0
                    amounts[resize] = budget * target_weights
                    return amounts

                net = equity
                if rate:
                    low, high = 0.0, equity
                    for _ in range(60):
                        mid = (low + high) / 2
                        costs = rate * np.abs(targets_at(mid) - held).sum()
                        if mid + costs > equity:
                            high = mid
                        else:
                            low = mid
                    net = low
                amounts = targets_at(net)
                for j in np.flatnonzero(np.abs(amounts - held) > 1e-12):
                    difference = amounts[j] - held[j]
                    trade_fee = rate * abs(difference)
                    side = "buy" if difference > 0 else "sell"
                    realized_pnl = None
                    if side == "buy":
                        cost_basis[j] += difference + trade_fee
                    else:
                        sold_fraction = min(1.0, abs(difference) / held[j]) if held[j] > 0 else 0.0
                        realized_pnl = (
                            abs(difference) - trade_fee
                            - cost_basis[j] * sold_fraction
                            + accrued_dividends[j] * sold_fraction
                        )
                        cost_basis[j] *= 1 - sold_fraction
                        accrued_dividends[j] *= 1 - sold_fraction
                    trades.append({
                        "date": day, "model": model, "symbol": symbols[j],
                        "side": side,
                        "reason": "retreat" if retreat[j] else "attack",
                        "price": float(prices[j]), "weight": float(amounts[j] / net),
                        "realized_pnl": float(realized_pnl) if realized_pnl is not None else None,
                    })
                shares[traded] = amounts[traded] / prices[traded]
                cash = max(0.0, net - float(amounts.sum()))
                equity = net
            nav.append(equity)
        histories[model] = performance(nav, days, include_daily_drawdown=True)
    return histories, sorted(trades, key=lambda trade: trade["date"])


def calculate(p):
    symbols = p["symbols"]
    dates = p["dates"]
    close = np.asarray(p["close"])
    dividend = np.asarray(p["dividend"])
    split = np.asarray(p["split"])
    returns = (close[1:] * split[1:] + dividend[1:]) / close[:-1] - 1
    if not np.isfinite(returns).all() or (returns <= -1).any():
        raise ValueError("收益序列无效")
    window, cap = p["lookback"], p["max_weight"]
    if len(returns) < window:
        raise ValueError(f"历史不足，需要 {window + 1} 个收盘价，当前 {len(close)} 个")
    equal = np.ones(len(symbols)) / len(symbols)
    if p["mode"] == "optimize":
        sample = returns[-window:]
        w = weights(symbols, sample, cap, p["scheme_id"])
        cov = np.atleast_2d(np.cov(sample, rowvar=False))
        variance = w @ cov @ w
        rc = w * (cov @ w) / variance if variance > 0 else np.zeros(len(w))
        paths = {}
        for name, allocation in (("scheme", w), ("equal", equal)):
            nav = np.r_[1.0, (1 + sample).cumprod(axis=0) @ allocation]
            paths[name] = performance(nav, dates[-window - 1 :])
        return {
            "weights": w.tolist(),
            "risk_contribution": rc.tolist(),
            "history": paths,
            "sample_start": dates[-window - 1],
            "samples": window,
        }
    return signal_backtest(p, dates, close, dividend, split, returns, window, cap, equal)


def signal_backtest(p, dates, close, dividend, split, returns, window, cap, equal):
    start, end = p["start"], p["end"]
    signals = np.asarray(p.get("signals", []), dtype=object)
    if signals.shape != close.shape or any(
        value not in (None, "attack", "retreat") for value in signals.flat
    ):
        raise ValueError("天使魔鬼信号缺失或无效，请重新准备日线信号")
    formal = [i for i, day in enumerate(dates) if start <= day <= end]
    if not formal:
        raise ValueError("所选区间内没有已闭合交易日")
    if formal[0] < window:
        raise ValueError("首日资产配置历史预热不足")
    paths, logs, schedules, accounts = {}, [], [], {}
    targets = {}
    for i in formal:
        # User-selected same-close simulation: include this completed day's return.
        try:
            target = weights(p["symbols"], returns[i - window : i], cap, p["scheme_id"])
        except ValueError as exc:
            raise ValueError(f"{dates[i]}：{exc}") from exc
        targets[i] = target
        schedules.append(
            {
                "date": dates[i],
                "as_of": dates[i],
                "weights": target.tolist(),
                "signals": signals[i].tolist(),
            }
        )
    rate = p["fee"] + p["slippage"]
    for model in ("scheme", "equal"):
        shares, cash = np.zeros(len(equal)), 1.0
        nav, timeline = [1.0], [dates[formal[0] - 1]]
        daily_accounts = []
        for i in formal:
            cash += shares @ dividend[i]
            shares *= split[i]
            prices = close[i]
            target = targets[i] if model == "scheme" else equal
            equity = float(cash + shares @ prices)
            amounts = shares * prices
            deviation = float(np.max(np.abs(amounts / equity - target)))
            triggered = deviation >= p.get("threshold", 0.10) - 1e-10
            retreat = signals[i] == "retreat"
            attack = signals[i] == "attack"
            reduce = triggered & (amounts > equity * target + 1e-12)

            def orders(
                net,
                held=amounts,
                allocation=target,
                retreats=retreat,
                attacks=attack,
                reductions=reduce,
            ):
                sell = np.where(
                    retreats,
                    held,
                    np.where(reductions, np.maximum(held - net * allocation, 0.0), 0.0),
                )
                buy = np.where(attacks, np.maximum(net * allocation - (held - sell), 0.0), 0.0)
                return sell, buy

            # Solve all same-close orders jointly, including fees and available cash.
            # No untriggered sale or signal-free purchase can fund this solution.
            low, high = 0.0, equity
            for _ in range(60):
                net = (low + high) / 2
                sell, buy = orders(net)
                costs = (sell.sum() + buy.sum()) * rate
                if net + costs > equity or cash + sell.sum() - buy.sum() - costs < -1e-12:
                    high = net
                else:
                    low = net
            sells, buys = orders(low)
            day_logs = []
            for side, values in (("sell", sells), ("buy", buys)):
                for j in np.flatnonzero(values > 1e-12):
                    value = float(values[j])
                    quantity = value / prices[j]
                    if side == "sell":
                        shares[j] = max(0.0, shares[j] - quantity)
                        cash += value * (1 - rate)
                        reason = "retreat" if retreat[j] else "threshold_reduce"
                    else:
                        shares[j] += quantity
                        cash -= value * (1 + rate)
                        reason = "attack"
                    day_logs.append(
                        {
                            "symbol": p["symbols"][j],
                            "side": side,
                            "reason": reason,
                            "price": float(prices[j]),
                            "shares": quantity,
                            "amount": value,
                            "cost": value * rate,
                        }
                    )
            if cash < -1e-8 or (shares < -1e-10).any():
                raise ValueError("回测资金或份额为负")
            cash = max(0.0, float(cash))
            value = float(cash + shares @ prices)
            for trade in day_logs:
                logs.append(
                    {
                        **trade,
                        "model": model,
                        "date": dates[i],
                        "weights": target.tolist(),
                        "turnover": trade["amount"] / equity,
                        "deviation": deviation,
                    }
                )
            nav.append(value)
            timeline.append(dates[i])
            daily_accounts.append(
                {
                    "date": dates[i],
                    "cash": cash,
                    "value": value,
                    "weights": (shares * prices / value).tolist(),
                    "target": target.tolist(),
                }
            )
        paths[model] = performance(nav, timeline)
        accounts[model] = daily_accounts
    return {
        "history": paths,
        "trades": logs,
        "samples": window,
        "schedule": schedules,
        "accounts": accounts,
        "rule_version": BACKTEST_RULE_VERSION,
    }
