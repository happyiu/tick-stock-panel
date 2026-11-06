# ruff: noqa: RUF001
"""JSON-lines allocation worker, executed by the isolated engine interpreter."""

import json
import sys

import numpy as np
import pandas as pd
import riskfolio as rp


def weights(returns, cap):
    n = returns.shape[1]
    if n * cap < 1 - 1e-9:
        raise ValueError(f"最多只能配置 {n * cap:.0%}，请提高单只上限或增加标的")
    if n == 1:
        return np.ones(1)
    if (returns.std() <= 1e-12).any():
        raise ValueError("存在零波动标的，无法计算 HRP")
    result = rp.HCPortfolio(returns=returns, w_min=0.0, w_max=cap).optimization(
        model="HRP", codependence="pearson", linkage="single", rm="MV"
    )
    if result is None:
        raise ValueError("HRP 未返回可行结果")
    w = result.weights.reindex(returns.columns).to_numpy()
    if not (
        np.isfinite(w).all()
        and abs(w.sum() - 1) < 1e-6
        and w.min() >= -1e-7
        and w.max() <= cap + 1e-6
    ):
        raise ValueError("引擎结果违反仓位约束")
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
    opening = np.asarray(p["open"])
    dividend = np.asarray(p["dividend"])
    split = np.asarray(p["split"])
    returns = pd.DataFrame(
        (close[1:] * split[1:] + dividend[1:]) / close[:-1] - 1, index=dates[1:], columns=symbols
    )
    if not np.isfinite(returns.to_numpy()).all() or (returns <= -1).any().any():
        raise ValueError("收益序列无效")
    window, cap = p["lookback"], p["max_weight"]
    if len(returns) < window:
        raise ValueError(f"历史不足，需要 {window + 1} 个收盘价，当前 {len(close)} 个")
    equal = np.ones(len(symbols)) / len(symbols)
    if p["mode"] == "optimize":
        sample = returns.tail(window)
        w = weights(sample, cap)
        cov = sample.cov().to_numpy()
        variance = w @ cov @ w
        rc = w * (cov @ w) / variance if variance > 0 else np.zeros(len(w))
        paths = {}
        for name, allocation in [("hrp", w), ("equal", equal)]:
            nav = np.r_[1.0, (1 + sample).cumprod().to_numpy() @ allocation]
            paths[name] = performance(nav, dates[-window - 1 :])
        return {
            "weights": w.tolist(),
            "risk_contribution": rc.tolist(),
            "history": paths,
            "sample_start": str(dates[-window - 1].date()),
            "samples": window,
        }
    start, end = pd.Timestamp(p["start"]), pd.Timestamp(p["end"])
    dynamic = p.get("rebalance", "monthly") == "daily_threshold"
    candidates = (
        list(range(window + 1, len(dates)))
        if dynamic
        else [i for i in range(1, len(dates)) if dates[i].month != dates[i - 1].month]
    )
    eligible = [i for i in candidates if i >= window + 1]
    if not eligible:
        raise ValueError("历史不足，暂无满足预热窗口的月初交易日")
    if start < dates[eligible[0]]:
        raise ValueError(f"最早可回测日期 {dates[eligible[0]].date()}")
    trades = [i for i in eligible if start <= dates[i] <= end]
    if not trades:
        raise ValueError("区间内没有月初调仓日")
    stop = max(i for i in range(len(dates)) if dates[i] <= end)
    paths, logs = {}, []
    for model in ("hrp", "equal"):
        shares, cash = np.zeros(len(symbols)), 1.0
        nav, timeline = [1.0], [dates[trades[0] - 1]]
        for i in range(trades[0], stop + 1):
            w = None
            drift = 0.0
            if i in trades:
                target = (
                    weights(returns.iloc[i - 1 - window : i - 1], cap) if model == "hrp" else equal
                )
                previous_value = cash + shares @ close[i - 1]
                drift = float(np.max(np.abs(target - shares * close[i - 1] / previous_value)))
                if not dynamic or i == trades[0] or drift >= p.get("threshold", 0.05) - 1e-10:
                    w = target
            cash += shares @ dividend[i]
            shares *= split[i]
            if w is not None:
                equity = cash + shares @ opening[i]
                current = shares * opening[i]
                cost_rate = p["fee"] + p["slippage"]
                # Solve post-cost target value, so buys never spend unowned cash.
                low, high = 0.0, equity
                for _ in range(60):
                    net = (low + high) / 2
                    if net + np.abs(net * w - current).sum() * cost_rate > equity:
                        high = net
                    else:
                        low = net
                turnover = float(np.abs(low * w - current).sum() / equity)
                shares, cash = low * w / opening[i], 0.0
                logs.append(
                    {
                        "model": model,
                        "date": str(dates[i].date()),
                        "weights": w.tolist(),
                        "turnover": turnover,
                        "cost": equity - low,
                        "reason": "initial"
                        if i == trades[0]
                        else ("threshold" if dynamic else "monthly"),
                        "deviation": drift,
                    }
                )
            nav.append(float(cash + shares @ close[i]))
            timeline.append(dates[i])
        paths[model] = performance(nav, timeline)
    return {"history": paths, "trades": logs, "samples": window}


if __name__ == "__main__":
    for line in sys.stdin:
        try:
            response = {"result": calculate(json.loads(line))}
        except Exception as exc:
            response = {"error": str(exc)}
        print(json.dumps(response, allow_nan=False), flush=True)
