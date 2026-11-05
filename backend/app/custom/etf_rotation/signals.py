# ruff: noqa: RUF001
"""Vectorized indicators and daily cross-sectional decisions, with no provider access."""

import math

import numpy as np
import pandas as pd

from .models import RotationConfig


def history_bars(config: RotationConfig) -> int:
    market_window = (
        config.parameters.market_ma_period + 1
        if config.strategy == "composite_momentum_enhanced"
        else 64
    )
    return max(64, config.parameters.momentum_window + 1, market_window)


def required_symbols(config):
    return list(
        dict.fromkeys(
            [
                *config.symbols,
                *(
                    [config.haven_symbol, config.reference_symbol]
                    if config.strategy == "gold_safe_haven"
                    else []
                ),
            ]
        )
    )


class SignalBook:
    def __init__(self, config, snapshot):
        self.config = config
        self.market_period = (
            config.parameters.market_ma_period
            if config.strategy == "composite_momentum_enhanced"
            else 60
        )
        self.context = {r["date"]: r for r in snapshot.get("market_environment", [])}
        self.frames = {}
        self.bars = {}
        for symbol, rows in snapshot["etfs"].items():
            df = pd.DataFrame(rows).set_index("date").sort_index() if rows else pd.DataFrame()
            self.bars[symbol] = {r["date"]: r for r in rows}
            if df.empty:
                self.frames[symbol] = df
                continue
            close, volume = df["close"], df["volume"]
            ret = close.pct_change(fill_method=None)
            df["ret5"] = close / close.shift(5) - 1
            df["momentum"] = close / close.shift(config.parameters.momentum_window) - 1
            df["trend"] = sum(
                w * (close / close.shift(n) - 1) for n, w in [(5, 0.15), (20, 0.5), (60, 0.35)]
            )
            df["quality"] = sum(close / close.rolling(n).mean() - 1 for n in [5, 20, 60]) / 3
            mean, std = ret.rolling(20).mean(), ret.rolling(20).std(ddof=0)
            df["sharpe"] = (mean / std.replace(0, np.nan) * np.sqrt(252)).where(std != 0, 0)
            df["volume_factor"] = (
                volume / volume.rolling(20).mean().replace(0, np.nan) - 1
            ) * np.sign(ret)
            vlong = ret.rolling(63).std(ddof=1)
            df["vol_ratio"] = (ret.rolling(21).std(ddof=1) / vlong.replace(0, np.nan)).where(
                vlong != 0, 1
            )
            df["ma60"] = close.rolling(60).mean()
            tr = pd.concat(
                [df.high - df.low, (df.high - close.shift()).abs(), (df.low - close.shift()).abs()],
                axis=1,
            ).max(axis=1)
            df["atr"] = tr.rolling(20).mean()
            df["amount20"] = df["amount"].rolling(20).mean()
            self.frames[symbol] = df
        self.index = {r["date"]: r for r in snapshot["index"]}
        idx = pd.DataFrame(snapshot["index"])
        self.index_ma = {}
        if not idx.empty:
            idx = idx.sort_values("date")
            self.index_ma = dict(
                zip(idx.date, idx.close.rolling(self.market_period).mean(), strict=True)
            )
        self.dates = sorted(set(self.index).union(*(set(bars) for bars in self.bars.values())))
        self.need = history_bars(config)
        calendar = pd.Index(self.dates)
        ready = pd.Series(True, index=calendar)
        for symbol in required_symbols(config):
            bars = self.bars.get(symbol, {})
            valid = pd.Series(
                [
                    d in bars
                    and all(
                        math.isfinite(float(bars[d].get(k) or 0)) and float(bars[d].get(k) or 0) > 0
                        for k in ["open", "high", "low", "close", "volume", "amount"]
                    )
                    for d in calendar
                ],
                index=calendar,
                dtype=float,
            )
            ready &= valid.rolling(self.need).sum().eq(self.need)
        index_valid = pd.Series(
            [
                d in self.index
                and math.isfinite(float(self.index[d].get("close") or 0))
                and float(self.index[d].get("close") or 0) > 0
                for d in calendar
            ],
            index=calendar,
            dtype=float,
        )
        ready &= index_valid.rolling(self.market_period).sum().eq(60)
        self.ready_dates = set(calendar[ready])

    def valid(self, day):
        return day in self.ready_dates

    def features(self, symbol, day):
        return self.frames[symbol].loc[day]

    def calculate(self, day):
        if not self.valid(day):
            return {
                "date": day,
                "valid": False,
                "ranking": [],
                "reason": "日线或预热数据不足，暂停新决策",
            }
        c, p = self.config, self.config.parameters
        ratio = self.index[day]["close"] / self.index_ma[day] - 1
        enhanced = c.strategy == "composite_momentum_enhanced"
        band = p.market_band if enhanced else 0.02
        regime = "bull" if ratio > band else "bear" if ratio < -band else "neutral"
        multiplier = 1.1 if regime == "bull" else 0.8 if regime == "bear" else 1
        target_exposure = (
            {"bull": p.bull_exposure, "neutral": p.neutral_exposure, "bear": p.bear_exposure}[
                regime
            ]
            if enhanced
            else 1.0
        )
        environment = {
            "symbol": "000300.SH",
            "close": float(self.index[day]["close"]),
            "ma": float(self.index_ma[day]),
            "ma_period": self.market_period,
            "deviation": float(ratio),
            "band": band,
            "regime": regime,
            "score_multiplier": multiplier if c.strategy.startswith("composite_momentum") else 1.0,
            "controls_exposure": enhanced,
            "target_exposure": target_exposure,
            "market_context": self.context.get(day),
        }
        ranking = []
        if c.strategy.startswith("composite_momentum"):
            names = ["trend", "sharpe", "quality", "volume_factor"]
            weights = [p.trend_weight, p.sharpe_weight, p.quality_weight, p.volume_weight]
            raw = pd.DataFrame({s: self.features(s, day)[names] for s in c.symbols}).T.astype(float)
            z = raw.apply(
                lambda col: (col - col.mean()) / col.std(ddof=1) if col.std(ddof=1) > 0 else col * 0
            )
            scores = (z * weights).sum(axis=1) * (
                1.1 if regime == "bull" else 0.8 if regime == "bear" else 1
            )
            for symbol in c.symbols:
                ranking.append(
                    {
                        "symbol": symbol,
                        "score": float(scores[symbol]),
                        "factors": {
                            n: {"raw": float(raw.loc[symbol, n]), "zscore": float(z.loc[symbol, n])}
                            for n in names
                        },
                    }
                )
        else:
            ranking = [
                {"symbol": s, "score": float(self.features(s, day).momentum), "factors": {}}
                for s in c.symbols
            ]
        ranking.sort(key=lambda r: (-r["score"], r["symbol"]))
        spread = float(np.std([r["score"] for r in ranking], ddof=1))
        rets = [float(self.features(s, day).ret5) for s in c.symbols]
        vol = [float(self.features(s, day).vol_ratio) for s in c.symbols]
        panic = {
            "drop": min(rets),
            "vol_ratio": float(np.mean(vol)),
            "breadth": sum(x < 0 for x in rets) / len(rets),
        }
        bull = False
        if c.strategy == "gold_safe_haven":
            ref = self.features(c.reference_symbol, day)
            bull = bool(ref.close > ref.ma60)
        return {
            "date": day,
            "valid": True,
            "ranking": ranking,
            "spread": spread,
            "regime": regime,
            "environment": environment,
            "panic": panic,
            "panic_triggered": c.strategy == "gold_safe_haven"
            and not (p.bull_filter and bull)
            and panic["drop"] < p.panic_drop
            and panic["vol_ratio"] > p.panic_vol
            and panic["breadth"] > p.panic_breadth,
            "broad_ret5": float(np.mean(rets)),
        }
