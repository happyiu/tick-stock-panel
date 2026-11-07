# ruff: noqa: RUF001
"""JSON-lines allocation worker, executed by the isolated engine interpreter."""

import json
import sys
from contextlib import redirect_stdout

import numpy as np
import pandas as pd
import riskfolio as rp

METHOD_LABELS = {"hrp": "HRP", "herc": "HERC", "min_variance": "最小方差"}


def weights(returns, cap, method="hrp"):
    label = METHOD_LABELS[method]
    n = returns.shape[1]
    if n * cap < 1 - 1e-9:
        raise ValueError(f"最多只能配置 {n * cap:.0%}，请提高单只上限或增加标的")
    if n == 1:
        return np.ones(1)
    if (returns.std() <= 1e-12).any():
        raise ValueError(f"存在零波动标的，无法计算{label}")
    try:
        if method == "min_variance":
            portfolio = rp.Portfolio(returns=returns, sht=False, upperlng=cap, budget=1.0)
            portfolio.assets_stats(method_mu="hist", method_cov="hist")
            result = portfolio.optimization(model="Classic", rm="MV", obj="MinRisk", hist=True)
        else:
            portfolio = rp.HCPortfolio(returns=returns, w_min=0.0, w_max=cap)
            result = portfolio.optimization(
                model=label, codependence="pearson", linkage="single", rm="MV",
                k=2 if method == "herc" and n == 2 else None,
            )
        if result is None:
            raise ValueError("未返回可行结果")
        w = result.weights.reindex(returns.columns).to_numpy()
    except Exception as exc:
        raise ValueError(f"{label} 求解失败：{exc}") from exc
    if not (
        np.isfinite(w).all()
        and abs(w.sum() - 1) < 1e-6
        and w.min() >= -1e-7
        and w.max() <= cap + 1e-6
    ):
        raise ValueError(f"{label} 求解结果违反仓位约束")
    if w.min() < 0:
        w = w.clip(min=0)
        w /= w.sum()
    return w


def performance(nav, dates):
    values = np.asarray(nav)
    return {
        "return": float(values[-1] - 1),
        "drawdown": float((values / np.maximum.accumulate(values) - 1).min()),
        "points": [
            {"date": str(d)[:10], "value": float(v)} for d, v in zip(dates, values, strict=True)
        ],
    }


def calculate(p):
    symbols = p["symbols"]
    dates = pd.to_datetime(p["dates"])
    close = np.asarray(p["close"])
    dividend = np.asarray(p["dividend"])
    split = np.asarray(p["split"])
    returns = pd.DataFrame(
        (close[1:] * split[1:] + dividend[1:]) / close[:-1] - 1, index=dates[1:], columns=symbols
    )
    if not np.isfinite(returns.to_numpy()).all() or (returns <= -1).any().any():
        raise ValueError("收益序列无效")
    window, cap = p["lookback"], p["max_weight"]
    method = p.get("method", "hrp")
    if len(returns) < window:
        raise ValueError(f"历史不足，需要 {window + 1} 个收盘价，当前 {len(close)} 个")
    equal = np.ones(len(symbols)) / len(symbols)
    if p["mode"] == "optimize":
        sample = returns.tail(window)
        w = weights(sample, cap, method)
        cov = sample.cov().to_numpy()
        variance = w @ cov @ w
        rc = w * (cov @ w) / variance if variance > 0 else np.zeros(len(w))
        paths = {}
        for name, allocation in [(method, w), ("equal", equal)]:
            nav = np.r_[1.0, (1 + sample).cumprod().to_numpy() @ allocation]
            paths[name] = performance(nav, dates[-window - 1 :])
        return {
            "weights": w.tolist(),
            "risk_contribution": rc.tolist(),
            "history": paths,
            "sample_start": str(dates[-window - 1].date()),
            "samples": window,
        }
    return signal_backtest(p, dates, close, dividend, split, returns, window, cap, equal)


def signal_backtest(p, dates, close, dividend, split, returns, window, cap, equal):
    method = p.get("method", "hrp")
    start, end = pd.Timestamp(p["start"]), pd.Timestamp(p["end"])
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
            target = weights(returns.iloc[i - window : i], cap, method)
        except ValueError as exc:
            raise ValueError(f"{dates[i].date()}：{exc}") from exc
        targets[i] = target
        schedules.append(
            {
                "date": str(dates[i].date()),
                "as_of": str(dates[i].date()),
                "weights": target.tolist(),
                "signals": signals[i].tolist(),
            }
        )
    rate = p["fee"] + p["slippage"]
    for model in (method, "equal"):
        shares, cash = np.zeros(len(equal)), 1.0
        nav, timeline = [1.0], [dates[formal[0] - 1]]
        daily_accounts = []
        for i in formal:
            cash += shares @ dividend[i]
            shares *= split[i]
            prices = close[i]
            target = targets[i] if model == method else equal
            equity = float(cash + shares @ prices)
            amounts = shares * prices
            deviation = float(np.max(np.abs(amounts / equity - target)))
            triggered = deviation >= p.get("threshold", 0.05) - 1e-10
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
            cash = max(0.0, cash)
            value = float(cash + shares @ prices)
            for trade in day_logs:
                logs.append(
                    {
                        **trade,
                        "model": model,
                        "date": str(dates[i].date()),
                        "weights": target.tolist(),
                        "turnover": trade["amount"] / equity,
                        "deviation": deviation,
                    }
                )
            nav.append(value)
            timeline.append(dates[i])
            daily_accounts.append(
                {
                    "date": str(dates[i].date()),
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
        "rule_version": "angel_devil_close_v1",
    }


if __name__ == "__main__":
    for line in sys.stdin:
        try:
            with redirect_stdout(sys.stderr):
                response = {"result": calculate(json.loads(line))}
        except Exception as exc:
            response = {"error": str(exc)}
        print(json.dumps(response, allow_nan=False), flush=True)
