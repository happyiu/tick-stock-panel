# ruff: noqa: RUF001
"""Close decisions -> following session open fills; all fills share one FIFO ledger."""

import math
from copy import deepcopy

import numpy as np

from .models import VERSION
from .signals import SignalBook


class Ledger:
    def __init__(self, cash, fees, state=None):
        self.cash = float(cash)
        self.fees = fees
        self.lots = deepcopy((state or {}).get("lots", {}))
        self.fills = []

    def shares(self, symbol):
        return sum(lot["shares"] for lot in self.lots.get(symbol, []))

    def buy(self, symbol, budget, price, day, index, reason):
        price *= 1 + self.fees.slippage
        budget = min(budget, self.cash)
        affordable = min(
            (budget - self.fees.minimum) / price, budget / (price * (1 + self.fees.commission))
        )
        qty = int(max(0, affordable) // 100) * 100
        if qty <= 0:
            return
        amount = qty * price
        fee = max(self.fees.minimum, amount * self.fees.commission)
        if amount + fee > self.cash + 1e-8:
            raise ValueError("买入资金不足")
        self.cash -= amount + fee
        self.lots.setdefault(symbol, []).append(
            {
                "shares": qty,
                "cost": amount + fee,
                "date": day,
                "index": index,
                "entry": price,
                "peak": price,
                "trailing": False,
            }
        )
        self.fills.append(
            {
                "date": day,
                "symbol": symbol,
                "side": "buy",
                "shares": qty,
                "price": price,
                "amount": amount,
                "fee": fee,
                "slippage_cost": qty * price * self.fees.slippage / (1 + self.fees.slippage),
                "profit": None,
                "days_held": None,
                "reason": reason,
            }
        )

    def sell(self, symbol, qty, price, day, index, reason):
        qty = min(qty, self.shares(symbol))
        if qty <= 0:
            return
        price *= 1 - self.fees.slippage
        amount = qty * price
        fee = max(self.fees.minimum, amount * self.fees.commission)
        if self.cash + amount < fee:
            return False
        remaining, basis, held = qty, 0.0, 0.0
        for lot in self.lots[symbol]:
            used = min(remaining, lot["shares"])
            cost = lot["cost"] * used / lot["shares"]
            lot["cost"] -= cost
            lot["shares"] -= used
            basis += cost
            held += used * (index - lot["index"])
            remaining -= used
            if remaining == 0:
                break
        self.lots[symbol] = [lot for lot in self.lots[symbol] if lot["shares"]]
        if not self.lots[symbol]:
            del self.lots[symbol]
        self.cash += amount - fee
        self.fills.append(
            {
                "date": day,
                "symbol": symbol,
                "side": "sell",
                "shares": qty,
                "price": price,
                "amount": amount,
                "fee": fee,
                "slippage_cost": qty * price * self.fees.slippage / (1 - self.fees.slippage),
                "profit": amount - fee - basis,
                "days_held": held / qty,
                "reason": reason,
            }
        )

        return True

    def value(self, marks):
        return self.cash + sum(self.shares(s) * marks[s] for s in self.lots)


def _tradeable(book, symbol, day, side):
    row = book.bars.get(symbol, {}).get(day)
    if not row or any(
        not math.isfinite(float(row.get(k) or 0)) or float(row.get(k) or 0) <= 0
        for k in ["open", "close", "volume"]
    ):
        return False
    raw_open = row.get("raw_open")
    if not raw_open and row.get("raw_close") and row.get("close"):
        raw_open = row["open"] * row["raw_close"] / row["close"]
    if raw_open:
        if side == "buy" and row.get("limit_up") and raw_open >= row["limit_up"]:
            return False
        if side == "sell" and row.get("limit_down") and raw_open <= row["limit_down"]:
            return False
    high, low = row.get("raw_high"), row.get("raw_low")
    # A single-price daily bar cannot establish executable opening liquidity.
    # Conservatively defer it; ETF limits must not be inferred from stock prefixes.
    if high and low and abs(high - low) < 1e-8:
        return False
    return not bool(row.get("suspended", False))


def _decide_core(book, day, ledger, state, signal):
    """Pure decision aside from explicit per-lot risk state updates; reused by preview."""
    p, c = book.config.parameters, book.config
    if not signal["valid"]:
        return None
    value = ledger.value(state["marks"])
    state["peak_value"] = max(state["peak_value"], value)
    if ledger.lots and p.account_guard and value <= state["peak_value"] * (1 - p.max_drawdown):
        return {"target": None, "steps": 1, "reason": "账户回撤保护", "risk": True}
    if p.risk_mode == "B":
        for symbol, lots in ledger.lots.items():
            row = book.features(symbol, day)
            for lot in lots:
                lot["peak"] = max(lot["peak"], float(row.high))
                lot["trailing"] = bool(
                    lot["trailing"] or row.close / lot["entry"] - 1 >= p.take_profit
                )
                if row.low <= lot["entry"] - p.atr_multiple * row.atr:
                    return {"target": None, "steps": 1, "reason": "ATR止损", "risk": True}
                if lot["trailing"] and row.low <= lot["peak"] * (1 - p.trailing_drawdown):
                    return {"target": None, "steps": 1, "reason": "浮动止盈", "risk": True}
    if state.get("pending"):
        return state["pending"]
    target = signal["ranking"][0]["symbol"]
    scores = {r["symbol"]: r["score"] for r in signal["ranking"]}
    held = next(iter(ledger.lots), None)
    if c.strategy == "gold_safe_haven":
        if state["mode"] == "gold":
            age = state["index"] - state["gold_since"]
            gold_ret = float(book.features(c.haven_symbol, day).ret5)
            if gold_ret < p.gold_stop or (
                age >= p.gold_min_hold
                and (signal["broad_ret5"] >= p.panic_exit or age >= p.gold_max_hold)
            ):
                return {
                    "target": None,
                    "steps": 1,
                    "reason": "避险止损" if gold_ret < p.gold_stop else "避险结束",
                    "mode": "normal",
                }
            return None
        if signal["panic_triggered"]:
            return {"target": c.haven_symbol, "steps": 1, "reason": "恐慌避险", "mode": "gold"}
    if not held:
        return {"target": target, "steps": 1, "reason": "正分开仓"} if scores[target] > 0 else None
    age = state["index"] - min(lot["index"] for lot in ledger.lots[held])
    if held == target or age < p.min_hold:
        return None
    gap = scores[target] - scores[held]
    if c.strategy.startswith("composite_momentum"):
        threshold = max(p.switch_std * signal["spread"], 0.1)
    else:
        amount = ledger.shares(held) * float(book.features(held, day).close)
        fees = c.fees
        impact = (
            sum(
                amount / max(float(book.features(s, day).amount20), 1) * 0.1 for s in [held, target]
            )
            / 2
        )
        threshold = max(
            p.switch_gap,
            max(fees.commission, fees.minimum / max(amount, 1)) + fees.slippage + impact,
        )
        if p.short_confirmation and book.features(target, day).ret5 <= -0.005:
            return None
    if gap > threshold:
        return {
            "target": target,
            "steps": p.adjustment_days,
            "reason": "排名切换",
            "mode": "normal",
        }
    return None


def decide(book, day, ledger, state, signal):
    order = _decide_core(book, day, ledger, state, signal)
    if book.config.strategy != "composite_momentum_enhanced" or not signal["valid"]:
        return order
    if order and order.get("risk"):
        return order
    exposure = signal["environment"]["target_exposure"]
    if exposure == 0:
        if ledger.lots:
            return {
                "target": None,
                "steps": 1,
                "reason": "市场环境降仓至现金",
                "target_exposure": 0.0,
            }
        state["exposure_target"] = 0.0
        return None
    previous = state.get("exposure_target", 1.0)
    if ledger.lots and abs(previous - exposure) > 1e-8:
        target = max(ledger.lots, key=lambda symbol: ledger.shares(symbol) * state["marks"][symbol])
        resume = state.get("pending")
        if resume and resume.get("resize_only"):
            resume = resume.get("resume_plan")
        return {
            "target": target,
            "steps": 1,
            "reason": "市场环境仓位调整",
            "target_exposure": exposure,
            "resize_only": True,
            "resume_plan": deepcopy(resume),
        }
    if order:
        return {**order, "target_exposure": exposure}
    return None


def _allocated_step(book, ledger, state, day, order):
    target, steps = order["target"], order["steps"]
    symbols = set(ledger.lots) | ({target} if target else set())
    if any(not book.bars.get(s, {}).get(day, {}).get("open", 0) > 0 for s in symbols):
        state["execution_warning"] = "开盘估值数据不足，保留环境调仓指令"
        return False
    prices = {s: book.bars[s][day]["open"] for s in symbols}
    value = ledger.cash + sum(ledger.shares(s) * prices[s] for s in ledger.lots)
    cap = value * order["target_exposure"] * 0.98
    if order.get("resize_only"):
        invested = sum(ledger.shares(symbol) * prices[symbol] for symbol in ledger.lots)
        if invested > cap:
            ratio = cap / invested
            for symbol in list(ledger.lots):
                shares = ledger.shares(symbol)
                desired = int(shares * ratio // 100) * 100
                if shares > desired and not ledger.sell(
                    symbol, shares - desired, prices[symbol], day, state["index"], order["reason"]
                ):
                    state["execution_warning"] = "资金不足以支付环境减仓佣金"
                    return False
        else:
            ledger.buy(
                target,
                max(0, min(ledger.cash, cap - invested)),
                prices[target],
                day,
                state["index"],
                order["reason"],
            )
        return True
    for symbol in list(ledger.lots):
        shares = ledger.shares(symbol)
        if symbol != target:
            quantity = shares if steps == 1 else max(100, int(shares / steps // 100) * 100)
        else:
            quantity = max(0, shares - int(cap / prices[symbol] // 100) * 100)
        if quantity and not ledger.sell(
            symbol, quantity, prices[symbol], day, state["index"], order["reason"]
        ):
            state["execution_warning"] = "资金不足以支付环境调仓卖出佣金"
            return False
    if target:
        invested = sum(ledger.shares(s) * prices[s] for s in ledger.lots)
        ledger.buy(
            target,
            max(0, min(ledger.cash, cap - invested)),
            prices[target],
            day,
            state["index"],
            order["reason"],
        )
        if ledger.shares(target) == 0:
            state["execution_warning"] = "环境仓位预算不足以买入整手，保留指令"
            return False
    return True


def execute(book, ledger, state, day):
    state["execution_warning"] = ""
    order = state["pending"]
    if not order:
        return False
    target = order["target"]
    outgoing = [s for s in ledger.lots if s != target]
    blocked = [s for s in outgoing if not _tradeable(book, s, day, "sell")]
    if target and not _tradeable(book, target, day, "buy"):
        blocked.append(target)
    if blocked:
        state["execution_warning"] = "开盘不可成交，保留待执行指令: " + ", ".join(blocked)
        return False
    if "target_exposure" in order:
        if not _allocated_step(book, ledger, state, day, order):
            return False
    else:
        steps = order["steps"]
        for symbol in outgoing:
            shares = ledger.shares(symbol)
            qty = shares if steps == 1 else max(100, int(shares / steps // 100) * 100)
            filled = ledger.sell(
                symbol, qty, book.bars[symbol][day]["open"], day, state["index"], order["reason"]
            )
            if not filled:
                state["execution_warning"] = "卖出所得及现金不足以支付佣金: " + symbol
                return False
        if target:
            budget = ledger.cash
            if book.config.strategy == "composite_momentum":
                budget = budget / steps if outgoing else budget * 0.98
            ledger.buy(
                target, budget, book.bars[target][day]["open"], day, state["index"], order["reason"]
            )
            if ledger.shares(target) == 0:
                state["execution_warning"] = "资金不足，等待可买入整手"
                return False
    order["steps"] -= 1
    if order["steps"] <= 0:
        state["pending"] = order.get("resume_plan")
        state["mode"] = order.get("mode", "normal")
        if state["mode"] == "gold":
            state["gold_since"] = state["index"]
        if "target_exposure" in order:
            state["exposure_target"] = order["target_exposure"]
        if order.get("risk"):
            state["exposure_target"] = 0.0
            state["peak_value"] = ledger.cash
        return bool(order.get("risk"))
    return False


def simulate(config, snapshot, start, end, initial_cash, state=None, progress=None):
    book = SignalBook(config, snapshot)
    state = (
        deepcopy(state)
        if state
        else {
            "cash": initial_cash,
            "lots": {},
            "marks": {},
            "pending": None,
            "peak_value": initial_cash,
            "index": -1,
            "mode": "normal",
            "gold_since": 0,
        }
    )
    ledger = Ledger(state["cash"], config.fees, state)
    days = [d for d in book.dates if start <= d <= end]
    records, signals = [], []
    for offset, day in enumerate(days):
        state["index"] += 1
        exited = execute(book, ledger, state, day)
        stale = []
        for symbol in set(ledger.lots) | set(state["marks"]):
            row = book.bars.get(symbol, {}).get(day)
            if row and row.get("close", 0) > 0:
                state["marks"][symbol] = row["close"]
            elif symbol in ledger.lots:
                stale.append(symbol)
        value = ledger.value(state["marks"])
        signal = book.calculate(day)
        order = None if exited else decide(book, day, ledger, state, signal)
        if exited:
            signal["reason"] = "风控退出完成，当日不重新开仓"
        state["pending"] = order if signal["valid"] else state["pending"]
        signal["decision"] = deepcopy(state["pending"])
        signals.append(signal)
        records.append(
            {
                "date": day,
                "cash": ledger.cash,
                "total_value": value,
                "return": value / initial_cash - 1,
                "exposure": (value - ledger.cash) / value if value > 0 else 0,
                "exposure_target": signal.get("environment", {}).get("target_exposure"),
                "positions": [
                    {
                        "symbol": s,
                        "shares": ledger.shares(s),
                        "close": state["marks"][s],
                        "cost": sum(lot["cost"] for lot in lots),
                    }
                    for s, lots in ledger.lots.items()
                ],
                "stale_marks": stale,
                "reason": "；".join(
                    filter(None, [state.get("execution_warning"), signal.get("reason")])
                ),
                "pending": deepcopy(state["pending"]),
            }
        )
        if progress and offset % 10 == 0:
            progress(int(10 + 85 * (offset + 1) / max(len(days), 1)))
    state.update(
        cash=ledger.cash,
        lots=ledger.lots,
        last_date=days[-1] if days else state.get("last_date"),
        last_signal=signals[-1] if signals else state.get("last_signal"),
    )
    values = [initial_cash, *[r["total_value"] for r in records]]
    returns = np.diff(values) / np.array(values[:-1])
    peaks = np.maximum.accumulate(values)
    drawdowns = np.array(values) / peaks - 1
    for row, dd in zip(records, drawdowns[1:], strict=True):
        row["drawdown"] = float(dd)
    final = values[-1]
    stats = {
        "total_return": final / initial_cash - 1,
        "annualized_return": (final / initial_cash) ** (252 / max(len(days), 1)) - 1,
        "max_drawdown": float(min(drawdowns)),
        "sharpe": float((returns.mean() - 0.03 / 252) / returns.std(ddof=1) * np.sqrt(252))
        if len(returns) > 1 and returns.std(ddof=1) > 0
        else 0,
        "initial_cash": initial_cash,
        "final_value": final,
        "fees": sum(f["fee"] for f in ledger.fills),
        "trades": len(ledger.fills),
        "invalid_signal_days": sum(not signal["valid"] for signal in signals),
        "slippage": sum(f["slippage_cost"] for f in ledger.fills),
        "average_exposure": float(np.mean([r["exposure"] for r in records])) if records else 0,
    }
    months = {}
    previous = initial_cash
    for row in records:
        month = row["date"][:7]
        if month not in months:
            months[month] = {"base": previous, "value": row["total_value"]}
        months[month]["value"] = row["total_value"]
        previous = row["total_value"]
    monthly = [{"month": m, "return": v["value"] / v["base"] - 1} for m, v in months.items()]
    benchmarks = []
    if days:
        first = days[0]
        base_index = book.index[first]["close"]
        bases = {s: book.bars[s][first]["close"] for s in config.symbols}
        last = {s: 1.0 for s in config.symbols}
        last_index = base_index
        for d in days:
            if d in book.index:
                last_index = book.index[d]["close"]
            for s in config.symbols:
                row = book.bars[s].get(d)
                if row and row.get("close", 0) > 0:
                    last[s] = row["close"] / bases[s]
            benchmarks.append(
                {
                    "date": d,
                    "hs300": last_index / base_index - 1,
                    "equal_weight": sum(last.values()) / len(last) - 1,
                }
            )
    return {
        "algorithm_version": VERSION,
        "stats": stats,
        "daily": records,
        "signals": signals,
        "fills": ledger.fills,
        "monthly": monthly,
        "benchmarks": benchmarks,
        "state": state,
    }
