"""Deterministic short-term score, anti-trap zones and noisy-signal filters.

This is a dependency-free port of the executable rules in stock_analysis.
The service deliberately owns a separate indicator namespace so the existing
technical-score-v3 and structure calculations keep their current semantics.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date
from typing import Any

import polars as pl

from app.price_limits import board_limit_pct, price_limit_pct

SHORT_TERM_SCORE_VERSION = "short-term-score-v1"
SHORT_TERM_BAR_SEMANTICS = "native-bars"

_DIMENSIONS = (
    ("price_position", "价格位置", 18),
    ("momentum", "短期动量", 10),
    ("volume_price", "量价配合", 7),
    ("macd", "MACD动能", 5),
    ("smart_money", "主力行为", 9),
    ("turnover", "换手率", 4),
    ("ma_trend", "MA趋势", 10),
    ("support_resistance", "支撑压力", 5),
    ("kdj", "KDJ状态", 3),
    ("squeeze", "均线形态", 2),
    ("divergence", "背离信号", 2),
    ("meta", "趋势确认", 2),
)
SHORT_TERM_DIMENSIONS = _DIMENSIONS
_TOTAL_WEIGHT = sum(item[2] for item in _DIMENSIONS)
_SIGNAL_DEDUP_GAPS = {
    "ma": 8,
    "macd": 5,
    "kdj": 5,
    "overbought_oversold": 5,
    "volume": 5,
    "squeeze": 10,
    "macd_divergence": 8,
    "volume_price_divergence": 8,
}


@dataclass(frozen=True)
class ShortTermContext:
    symbol: str
    asset_type: str
    period: str
    risk_warning: bool = False

    @property
    def high_volatility_board(self) -> bool:
        return self.asset_type == "stock" and board_limit_pct(self.symbol) > 0.10

    @property
    def limit_enabled(self) -> bool:
        # Aggregated and native minute bars do not retain a trustworthy raw
        # daily limit price. A daily stock frame may carry raw_* columns.
        return self.asset_type == "stock" and self.period == "1d"


def _finite(value: object) -> float | None:
    if value is None or value == "":
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _safe(c: dict[str, list[Any]], index: int, key: str) -> float | None:
    values = c.get(key)
    if values is None or index < 0 or index >= len(values):
        return None
    return _finite(values[index])


def _mean(values: list[Any], minimum: int = 1) -> float | None:
    numeric = [value for value in (_finite(item) for item in values) if value is not None]
    return sum(numeric) / len(numeric) if len(numeric) >= minimum else None


def _sma(values: list[float], period: int) -> list[float | None]:
    return [
        _mean(values[max(0, index - period + 1):index + 1])
        for index in range(len(values))
    ]


def _ema(values: list[float], span: int) -> list[float]:
    if not values:
        return []
    alpha = 2.0 / (span + 1.0)
    result = [values[0]]
    for value in values[1:]:
        result.append(alpha * value + (1.0 - alpha) * result[-1])
    return result


def _rolling_std(values: list[float], period: int) -> list[float | None]:
    result: list[float | None] = []
    for index in range(len(values)):
        window = values[max(0, index - period + 1):index + 1]
        if len(window) < 2:
            result.append(None)
            continue
        average = sum(window) / len(window)
        result.append(math.sqrt(sum((value - average) ** 2 for value in window) / (len(window) - 1)))
    return result


def _date_text(value: object) -> str:
    if hasattr(value, "isoformat"):
        return str(value.isoformat()).replace("T", " ")
    return str(value or "").replace("T", " ")


def _date_key(value: object, period: str) -> str:
    text = _date_text(value)
    return text[:16] if period == "30m" else text[:10]


def _close_pct(close: list[float], index: int) -> float:
    if index <= 0 or close[index - 1] <= 0:
        return 0.0
    return (close[index] / close[index - 1] - 1.0) * 100.0


def _build_columns(frame: pl.DataFrame, period: str) -> dict[str, list[Any]]:
    records = frame.sort(["symbol", "date"] if "symbol" in frame.columns else ["date"]).to_dicts()
    close = [_finite(row.get("close")) or 0.0 for row in records]
    open_ = [_finite(row.get("open")) or close[index] for index, row in enumerate(records)]
    high = [_finite(row.get("high")) or close[index] for index, row in enumerate(records)]
    low = [_finite(row.get("low")) or close[index] for index, row in enumerate(records)]
    volume = [max(0.0, _finite(row.get("volume")) or 0.0) for row in records]
    dates = [_date_text(row.get("date")) for row in records]
    pct: list[float] = []
    turnover: list[float | None] = []
    raw_close: list[float | None] = []
    raw_high: list[float | None] = []
    raw_low: list[float | None] = []
    for index, row in enumerate(records):
        supplied = _finite(row.get("change_pct"))
        pct.append(supplied * 100.0 if supplied is not None else _close_pct(close, index))
        turnover_value = row.get("turnover_rate")
        turnover.append(_finite(turnover_value if turnover_value is not None else row.get("turnover")))
        raw_close.append(_finite(row.get("raw_close")))
        raw_high.append(_finite(row.get("raw_high")))
        raw_low.append(_finite(row.get("raw_low")))

    result: dict[str, list[Any]] = {
        "date": dates,
        "key": [_date_key(value, period) for value in dates],
        "close": close,
        "open": open_,
        "high": high,
        "low": low,
        "volume": volume,
        "pct_change": pct,
        "turnover": turnover,
        "raw_close": raw_close,
        "raw_high": raw_high,
        "raw_low": raw_low,
    }
    for period_size in (5, 7, 10, 20, 60):
        result[f"ma{period_size}"] = [
            round(value, 3) if value is not None else None
            for value in _sma(close, period_size)
        ]
    for period_size in (5, 10, 20):
        pv = [close[index] * volume[index] for index in range(len(close))]
        result[f"vwma{period_size}"] = [
            round(
                sum(pv[max(0, index - period_size + 1):index + 1])
                / sum(volume[max(0, index - period_size + 1):index + 1]),
                3,
            ) if sum(volume[max(0, index - period_size + 1):index + 1]) > 0 else None
            for index in range(len(close))
        ]
    ema12 = _ema(close, 12)
    ema26 = _ema(close, 26)
    dif = [round(ema12[index] - ema26[index], 4) for index in range(len(close))]
    dea = [round(value, 4) for value in _ema(dif, 9)]
    result["macd_dif"] = dif
    result["macd_dea"] = dea
    result["macd_hist"] = [round(2.0 * (dif[index] - dea[index]), 4) for index in range(len(close))]

    lows: list[float] = []
    highs: list[float] = []
    rsv: list[float] = []
    for index in range(len(close)):
        window_low = min(low[max(0, index - 8):index + 1])
        window_high = max(high[max(0, index - 8):index + 1])
        lows.append(window_low)
        highs.append(window_high)
        rsv.append(50.0 if window_high == window_low else (close[index] - window_low) / (window_high - window_low) * 100.0)
    kdj_k: list[float] = []
    kdj_d: list[float] = []
    for index, value in enumerate(rsv):
        if index == 0:
            kdj_k.append(50.0)
            kdj_d.append(50.0)
        else:
            kdj_k.append((2.0 * kdj_k[index - 1] + value) / 3.0)
            kdj_d.append((2.0 * kdj_d[index - 1] + kdj_k[index]) / 3.0)
    result["kdj_k"] = [round(value, 3) for value in kdj_k]
    result["kdj_d"] = [round(value, 3) for value in kdj_d]
    result["kdj_j"] = [round(3.0 * kdj_k[index] - 2.0 * kdj_d[index], 3) for index in range(len(close))]

    middle_raw = _sma(close, 20)
    std = _rolling_std(close, 20)
    result["bb_middle"] = [round(value, 3) if value is not None else None for value in middle_raw]
    result["bb_upper"] = [
        round(value + 2.0 * std[index], 3) if value is not None and std[index] is not None else None
        for index, value in enumerate(middle_raw)
    ]
    result["bb_lower"] = [
        round(value - 2.0 * std[index], 3) if value is not None and std[index] is not None else None
        for index, value in enumerate(middle_raw)
    ]
    result["bb_bandwidth"] = [
        round((result["bb_upper"][index] - result["bb_lower"][index]) / value * 100.0, 3)
        if value and result["bb_upper"][index] is not None and result["bb_lower"][index] is not None
        else None
        for index, value in enumerate(middle_raw)
    ]
    result["vol_ma5"] = [round(value, 0) if value is not None else None for value in _sma(volume, 5)]
    result["vol_ma10"] = [round(value, 0) if value is not None else None for value in _sma(volume, 10)]
    # 量比沿用源项目口径：当前量 / 前5根均量，不把当前量混入分母。
    result["vol_ratio_5d"] = [
        (
            volume[index] / average
            if (average := _mean(volume[max(0, index - 5):index], 1)) and average > 0
            else None
        )
        for index in range(len(volume))
    ]
    result["vol_ratio_prev5"] = [
        (
            volume[index] / average
            if (average := _mean(volume[max(0, index - 5):index], 1)) and average > 0
            else None
        )
        for index in range(len(volume))
    ]
    return result


def _clamp(value: float, low: float = -10.0, high: float = 10.0) -> int:
    return int(max(low, min(high, round(value))))


def _atr(c: dict[str, list[Any]], n: int, period: int = 14) -> float:
    values: list[float] = []
    for index in range(max(1, n - period), n):
        values.append(max(
            c["high"][index] - c["low"][index],
            abs(c["high"][index] - c["close"][index - 1]),
            abs(c["low"][index] - c["close"][index - 1]),
        ))
    return _mean(values) or 0.0


def _price_position(c: dict[str, list[Any]], n: int) -> float | None:
    if n < 11:
        return None
    high = max(c["high"][n - 10:n])
    low = min(c["low"][n - 10:n])
    return (c["close"][n - 1] - low) / (high - low) * 100.0 if high > low else None


def _effective_limit(c: dict[str, list[Any]], index: int, ctx: ShortTermContext) -> float | None:
    if not ctx.limit_enabled or c["raw_close"][index] is None:
        return None
    text = c["date"][index][:10]
    try:
        trading_date = date.fromisoformat(text)
    except ValueError:
        return None
    return price_limit_pct(ctx.symbol, trading_date, is_risk_warning=ctx.risk_warning) * 100.0


def _broken_limit(c: dict[str, list[Any]], n: int, ctx: ShortTermContext) -> dict[str, Any]:
    result = {"today_broken": False, "recent_broken_days": 0}
    if n < 2 or not ctx.limit_enabled:
        return result
    for index in range(max(1, n - 5), n):
        limit = _effective_limit(c, index, ctx)
        previous = c["raw_close"][index - 1]
        high = c["raw_high"][index]
        close = c["raw_close"][index]
        if limit is None or previous is None or high is None or close is None or previous <= 0:
            continue
        limit_price = previous * (1.0 + limit / 100.0)
        if high >= limit_price * 0.995 and c["pct_change"][index] < limit:
            result["recent_broken_days"] += 1
            if index == n - 1:
                result["today_broken"] = True
    return result


def _recent_limit_up_count(c: dict[str, list[Any]], n: int, ctx: ShortTermContext) -> int:
    if not ctx.limit_enabled:
        return 0
    result = 0
    for index in range(n - 2, -1, -1):
        limit = _effective_limit(c, index, ctx)
        if limit is None or c["pct_change"][index] < limit:
            break
        result += 1
    return result


def _detect_trend(c: dict[str, list[Any]], n: int) -> int:
    close = c["close"]
    score = 0.0
    if n >= 4 and close[n - 4] > 0:
        change = (close[n - 1] / close[n - 4] - 1.0) * 100.0
        score += 1.5 if change > 6 else 1.0 if change > 3 else 0.5 if change > 0 else -1.5 if change < -6 else -1.0 if change < -3 else -0.5 if change < 0 else 0
    if n >= 11:
        low10 = min(close[n - 11:n])
        if low10 > 0:
            distance = (close[n - 1] - low10) / low10 * 100.0
            score += 1 if distance > 12 else 0.5 if distance > 6 else -1 if distance < -5 else -0.5 if distance < 0 else 0
    ma5 = _safe(c, n - 1, "ma5")
    ma10 = _safe(c, n - 1, "ma10")
    if ma5 and ma5 > 0:
        value = (close[n - 1] - ma5) / ma5 * 100.0
        score += 1 if value > 2 else 0.5 if value > 0 else -1 if value < -2 else -0.5 if value < 0 else 0
    if ma5 and ma10 and ma10 > 0:
        score += 1 if ma5 > ma10 * 1.005 else -1 if ma5 < ma10 * 0.995 else 0
    if n >= 4:
        old_ma5 = _safe(c, n - 4, "ma5")
        if old_ma5 and old_ma5 > 0 and ma5:
            slope = (ma5 - old_ma5) / old_ma5 * 100.0
            score += 1 if slope > 1.5 else -1 if slope < -1.5 else 0
    if n >= 5:
        recent = _mean(c["volume"][n - 3:n])
        previous = _mean(c["volume"][max(0, n - 6):n - 3])
        if recent and previous and recent > previous * 1.5:
            score += 1 if close[n - 1] > close[n - 4] else -1 if close[n - 1] < close[n - 4] else 0
    return 2 if score >= 5 else 1 if score >= 2 else -2 if score <= -5 else -1 if score <= -2 else 0


def _score_price_position(c: dict[str, list[Any]], n: int, trend: int, ctx: ShortTermContext) -> tuple[int, str]:
    score = 0
    details: list[str] = []
    cp = c["close"][n - 1]
    position = _price_position(c, n)
    if position is not None:
        if trend >= 1:
            if position >= 98:
                score -= 2
                details.append(f"触及10日高点({position:.0f}%)")
            elif position > 95:
                score -= 1
            elif position > 85:
                score += 1
            elif 60 <= position <= 85:
                score += 3
            elif 40 <= position < 60:
                score += 2
        else:
            if position >= 98:
                score -= 6
                details.append(f"触及10日高点({position:.0f}%,极度追高)")
            elif position > 95:
                score -= 4
            elif position > 90:
                score -= 2
            elif position > 85:
                score -= 1
            elif 60 <= position <= 85:
                score += 3
            elif 40 <= position < 60:
                score += 1
    if n >= 6:
        high5 = max(c["high"][n - 5:n])
        if high5 > 0:
            distance = (cp - high5) / high5 * 100.0
            if trend >= 1:
                if distance > -0.5:
                    score += 1
                    details.append("创5日新高(上升趋势中)")
                elif -3 <= distance <= -1:
                    score += 3
                elif -6 <= distance < -3:
                    score += 2
                elif distance < -6:
                    score -= 1
            else:
                if distance > -0.5:
                    score -= 3
                elif distance > -1.5:
                    score -= 1
                elif -5 <= distance <= -2:
                    score += 3
                elif -8 < distance < -5:
                    score += 1
                elif distance <= -8:
                    score -= 1
    if n >= 6:
        high5 = max(c["high"][n - 5:n])
        low5 = min(c["low"][n - 5:n])
        if low5 > 0:
            range5 = (high5 - low5) / low5 * 100.0
            active = 35 if ctx.high_volatility_board else 22
            normal = 25 if ctx.high_volatility_board else 15
            dead = 12 if ctx.high_volatility_board else 8
            low = 18 if ctx.high_volatility_board else 12
            if range5 > active:
                score += 2
                details.append(f"5日振幅大({range5:.0f}%,活跃)")
            elif range5 > normal:
                score += 1
            elif range5 < dead:
                score -= 2
                details.append(f"5日振幅极小({range5:.0f}%,死水)")
            elif range5 < low:
                score -= 1
    return _clamp(score), "; ".join(details) or "价格位置正常"


def _score_momentum(c: dict[str, list[Any]], n: int, trend: int, ctx: ShortTermContext) -> tuple[int, str]:
    close, pct = c["close"], c["pct_change"]
    score = 0
    details: list[str] = []
    scale = 2.0 if ctx.high_volatility_board else 1.0
    today = pct[n - 1]
    if today > 5 * scale:
        score += 1 if trend <= -1 else 3
    elif today > 3 * scale:
        score += 3 if trend >= 1 else 1 if trend <= -1 else 2
    elif today > 1 * scale:
        score += 3 if trend >= 1 else 0 if trend <= -1 else 2
    elif today > 0:
        score += 1
    elif today > -1 * scale:
        score -= 1
    elif today > -3 * scale:
        score += -1 if trend >= 1 else -4 if trend <= -1 else -2
    elif today > -5 * scale:
        score += -2 if trend >= 1 else -6
    else:
        score += -3 if trend >= 1 else -8
    if ctx.limit_enabled:
        limit = _effective_limit(c, n - 1, ctx)
        if limit is not None and today >= limit:
            count = _recent_limit_up_count(c, n, ctx)
            score += -2 if count == 0 else 1 if count <= 2 else 2
        elif limit is not None and today <= -limit:
            score -= 3
    broken = _broken_limit(c, n, ctx)
    if broken["today_broken"]:
        fallback = (c["raw_high"][n - 1] - c["raw_close"][n - 1]) / c["raw_high"][n - 1] * 100.0 if c["raw_high"][n - 1] and c["raw_close"][n - 1] is not None else 0
        score += -6 if fallback > 5 else -4 if fallback > 3 else -1 if fallback > 1 and trend >= 1 else -3 if fallback > 1 else 1 if trend >= 1 else -2
    elif broken["recent_broken_days"] >= 2:
        score -= 2
    elif broken["recent_broken_days"] == 1 and trend <= -1:
        score -= 1
    streak = 0
    for index in range(n - 1, max(0, n - 10), -1):
        if close[index] > close[index - 1]:
            if streak >= 0:
                streak += 1
            else:
                break
        elif close[index] < close[index - 1]:
            if streak <= 0:
                streak -= 1
            else:
                break
        else:
            break
    if streak >= 5:
        score += 1 if trend >= 1 else -3
    elif streak == 4:
        score += 1 if trend >= 1 else -2
    elif streak == 3:
        score += 2 if trend >= 1 else 1
    elif streak == 2:
        score += 2 if trend >= 1 else 1
    elif streak == 1:
        score += 1
    if streak <= -5:
        score += 2 if trend >= 1 else -1 if trend <= -1 else 1
    elif streak == -4:
        score += 2 if trend >= 1 else -2 if trend <= -1 else 1
    elif streak <= -3:
        score += 1 if trend >= 1 else -2 if trend <= -1 else -1
    if n >= 4 and close[n - 4] > 0:
        c3 = (close[n - 1] / close[n - 4] - 1.0) * 100.0
        if trend >= 1:
            if c3 > 12 * scale:
                score -= 5
                details.append(f"3日涨{c3:+.1f}%(严重过热)")
            elif c3 > 10 * scale:
                score -= 3
                details.append(f"3日涨{c3:+.1f}%(过热)")
            elif c3 > 5 * scale:
                score += 4
            elif c3 > 3 * scale:
                score += 3
            elif c3 > 0:
                score += 3
            elif c3 > -3 * scale:
                score += 2
            elif c3 > -5 * scale:
                score += 3
            else:
                score += 1
        elif trend <= -1:
            if c3 > 10 * scale:
                score -= 3
            elif c3 > 5 * scale:
                score += 1
            elif c3 > 0:
                score += 1
            elif c3 < -10 * scale:
                score -= 2
            elif c3 < -5 * scale:
                score -= 2
            elif c3 < 0:
                score -= 1
        else:
            score += 0 if c3 > 7 * scale else 2 if c3 > 0 else -1 if c3 > -5 * scale else 1
    if n >= 11 and trend >= 1:
        low10 = min(close[n - 11:n])
        distance = (close[n - 1] - low10) / low10 * 100.0 if low10 > 0 else 0
        score += 2 if distance < 3 else 1 if distance < 7 else 0
    if n >= 3 and today > 2 * scale and pct[n - 2] <= 0:
        score += 2
    elif n >= 3 and today > 2 * scale and pct[n - 2] > 3 * scale and trend < 1:
        score -= 1
        details.append("连续加速(获利盘压力)")
    if n >= 6 and close[n - 6] > 0:
        c5 = (close[n - 1] / close[n - 6] - 1.0) * 100.0
        score += -1 if trend >= 1 and c5 > 20 * scale else 1 if trend >= 1 and c5 > 10 * scale else -2 if trend < 1 and c5 > 15 * scale else -1 if trend < 1 and c5 > 10 * scale else 3 if trend >= 1 and c5 < -15 * scale else 0
    if c["close"][n - 1] > 0 and c["high"][n - 1] - c["low"][n - 1] > 7 * c["close"][n - 1] / 100 and c["close"][n - 1] < c["open"][n - 1]:
        score -= 2 if trend <= -1 else 1
    return _clamp(score), "; ".join(details) or f"本周期涨跌{today:+.1f}%"


def _score_volume(c: dict[str, list[Any]], n: int, trend: int, ctx: ShortTermContext) -> tuple[int, str]:
    volume, close = c["volume"], c["close"]
    current = volume[n - 1]
    if current <= 0:
        return 0, "停牌或无成交"
    average = _mean(volume[max(0, n - 5):n - 1]) or current
    ratio = current / average if average > 0 else 1.0
    pct = c["pct_change"][n - 1]
    scale = 2.0 if ctx.high_volatility_board else 1.0
    score = 0
    details: list[str] = []
    if ratio >= 3:
        if pct > 2 * scale:
            score += 5
            if trend <= -1:
                score -= 2
        elif pct < -2 * scale:
            score -= 5
            if trend >= 1:
                score += 2
        else:
            score -= 3
    elif ratio >= 1.5:
        score += 3 if pct > scale else -3 if pct < -scale else 0
    elif ratio <= 0.5:
        score += 3 if pct > 0 and trend >= 1 else 1 if pct > 0 else -1 if trend <= -1 else 2 if trend >= 1 else 0
        if n >= 30 and all(volume[index] == 0 or volume[index] >= current for index in range(max(0, n - 30), n - 1)):
            score += 3
    if n >= 3:
        consistency = 0
        for index in range(n - 3, n):
            if volume[index] > volume[index - 1] and close[index] > close[index - 1]:
                consistency += 2
            elif volume[index] <= volume[index - 1] and close[index] <= close[index - 1]:
                consistency -= 1
            elif volume[index] > volume[index - 1] and close[index] <= close[index - 1]:
                consistency -= 3
            else:
                consistency += 1
        score += 3 if consistency >= 3 else -3 if consistency <= -3 else 0
    return _clamp(score), f"量比={ratio:.1f}" + ("; 量价配合" if score > 0 else "; 量价背离" if score < 0 else "")


def _score_macd(c: dict[str, list[Any]], n: int, trend: int) -> tuple[int, str]:
    dif, dea, hist = _safe(c, n - 1, "macd_dif"), _safe(c, n - 1, "macd_dea"), _safe(c, n - 1, "macd_hist")
    if dif is None or dea is None or hist is None:
        return 0, "MACD数据不足"
    previous = _safe(c, n - 2, "macd_hist")
    score = 3 if dif > dea else -3
    score += 2 if dif > 0 and dea > 0 else -2 if dif < 0 and dea < 0 else 0
    if previous is not None:
        if hist > 0 and hist > previous:
            score += 3
        elif hist > 0 and hist < previous:
            score += 1 if trend >= 1 else -1
        elif hist < 0 and hist < previous:
            score -= 3
        elif hist < 0 and hist > previous:
            score -= 1 if trend <= -1 else 1
    else:
        score += 1 if hist > 0 else -1
    if trend >= 1 and dif < 0 and previous is not None and hist > previous:
        score += 2
    elif trend <= -1 and dif > 0 and previous is not None and hist < previous:
        score -= 2
    if n >= 5:
        recent = c["macd_hist"][n - 5:n]
        if all(value > 0 for value in recent):
            score += 1
        elif all(value < 0 for value in recent):
            score -= 1
    return _clamp(score), f"DIF{'>' if dif > dea else '<'}DEA; 柱体{'偏多' if hist > 0 else '偏空'}"


def _nearest_support_distance(zones: dict[str, list[dict[str, Any]]], cp: float) -> float | None:
    values = [
        cp - (zone["low"] + zone["high"]) / 2.0
        for zone in zones.get("support", [])
        if zone.get("status") != "broken" and cp >= (zone["low"] + zone["high"]) / 2.0
    ]
    return min(values) / cp * 100.0 if values and cp > 0 else None


def _score_kdj(c: dict[str, list[Any]], n: int, trend: int, zones: dict[str, list[dict[str, Any]]]) -> tuple[int, str]:
    k, d, j = _safe(c, n - 1, "kdj_k"), _safe(c, n - 1, "kdj_d"), _safe(c, n - 1, "kdj_j")
    if k is None or d is None or j is None:
        return 0, "KDJ数据不足"
    score = 0
    details: list[str] = []
    if k > 80 and d > 70:
        score += 4 if trend >= 1 else -4 if trend <= -1 else -2
        details.append("强势区" if trend >= 1 else "超买")
        if trend >= 1 and n >= 5 and sum(value > 80 for value in c["kdj_k"][n - 5:n]) >= 5:
            score -= 2
    elif k < 20 and d < 30:
        if trend >= 1:
            score += 5
            details.append("回调节买点")
        elif trend <= -1:
            position = _price_position(c, n)
            average = _mean(c["volume"][max(0, n - 5):n - 1]) or 0
            ratio = c["volume"][n - 1] / average if average > 0 else 1
            range5 = (max(c["high"][n - 5:n]) - min(c["low"][n - 5:n])) / c["close"][n - 1] * 100 if n >= 5 and c["close"][n - 1] > 0 else 0
            near_support = _nearest_support_distance(zones, c["close"][n - 1])
            capitulation = k < 25 and d < 30 and position is not None and position <= 15 and ratio < 0.8 and (near_support is not None and near_support <= 3 or range5 > 15)
            if capitulation:
                score += 4
                details.append("缩量近低/支撑(衰竭反转)")
            else:
                score -= 2
                details.append("超卖(趋势偏弱)")
        else:
            score += 3
            details.append("超卖区")
    elif 40 <= k <= 60:
        details.append("中位震荡")
    else:
        details.append(f"K={k:.0f}")
    pk, pd = _safe(c, n - 2, "kdj_k"), _safe(c, n - 2, "kdj_d")
    if pk is not None and pd is not None:
        if pk <= pd and k > d:
            score += 5 if trend >= 1 else 1 if trend <= -1 else 4
            details.append("金叉")
        elif pk >= pd and k < d:
            score -= 1 if trend >= 1 else 5 if trend <= -1 else 4
            details.append("死叉")
    if j > 100 and trend < 1:
        score -= 2
    elif j < 0 and trend > -1:
        score += 2
    return _clamp(score), "; ".join(details)


def _eval_ma_break_quality(c: dict[str, list[Any]], n: int) -> int:
    if n < 5:
        return 0
    cp, op = c["close"][n - 1], c["open"][n - 1]
    high, low = c["high"][n - 1], c["low"][n - 1]
    ma5, previous_ma5 = _safe(c, n - 1, "ma5"), _safe(c, n - 2, "ma5")
    if ma5 is None or previous_ma5 is None:
        return 0
    previous_close = c["close"][n - 2]
    broke_up = previous_close <= previous_ma5 and cp > ma5
    broke_down = previous_close >= previous_ma5 and cp < ma5
    if not broke_up and not broke_down:
        return 0
    direction = 1 if broke_up else -1
    average = _mean(c["volume"][max(0, n - 6):n - 1]) or 0.0
    quality = 0
    if average > 0:
        ratio = c["volume"][n - 1] / average
        quality += 2 if ratio >= 2 else 1 if ratio >= 1.3 else -3 if ratio < 0.7 else -1
    total_range = high - low
    if total_range > 0:
        body_ratio = abs(cp - op) / total_range
        quality += 1 if body_ratio > 0.7 else -2 if body_ratio < 0.3 else 0
    penetration = abs(cp - ma5) / ma5 * 100.0 if ma5 > 0 else 0.0
    quality += 1 if penetration > 2 else -2 if penetration < 0.3 else 0
    return max(-5, min(5, direction * quality))


def _check_ma_close_confirmation(c: dict[str, list[Any]], n: int) -> int:
    if n < 3:
        return 0
    values: list[tuple[float, float]] = []
    for index in range(max(0, n - 5), n):
        ma5 = _safe(c, index, "ma5")
        if ma5 is None:
            return 0
        values.append((c["close"][index], ma5))
    last_above = values[-1][0] > values[-1][1]
    streak = 0
    for close, ma5 in reversed(values):
        if (close > ma5) == last_above:
            streak += 1
        else:
            break
    return streak if streak >= 2 and last_above else -streak if streak >= 2 else 0


def _score_ma_trend(c: dict[str, list[Any]], n: int, trend: int) -> tuple[int, str]:
    cp = c["close"][n - 1]
    ma5, ma10, ma20 = (_safe(c, n - 1, key) for key in ("ma5", "ma10", "ma20"))
    if ma5 is None or ma10 is None or ma20 is None:
        return 0, "均线数据不足"
    score = 0
    details: list[str] = []
    if ma5 > ma10 > ma20:
        score += 4
        details.append("多头排列")
    elif ma5 < ma10 < ma20:
        score -= 4
        details.append("空头排列")
    elif ma5 > ma10 and ma10 < ma20:
        score += 1
        details.append("短期金叉待确认")
    elif ma5 < ma10 and ma10 > ma20:
        score -= 1
        details.append("短期死叉待确认")
    else:
        details.append("均线纠缠")

    vwma5, vwma10, vwma20 = (_safe(c, n - 1, key) for key in ("vwma5", "vwma10", "vwma20"))
    if vwma5 is not None and vwma10 is not None and vwma20 is not None:
        if ma5 > vwma5:
            score += 2
            details.append("MA5>VWMA5(量能支撑)")
        else:
            score -= 2
            details.append("MA5<VWMA5(量价分歧)")
        if ma20 > vwma20:
            score += 1
        else:
            score -= 1
            details.append("MA20<VWMA20(量能不足)")
        if cp > ma5 and ma5 < vwma5:
            score -= 3
            details.append("疑似诱多(缩量站上MA)")
        elif cp < ma5 and ma5 > vwma5:
            score += 3
            details.append("疑似诱空(缩量跌破MA)")

    break_score = _eval_ma_break_quality(c, n)
    if break_score:
        score += break_score
        details.append(f"突破质量{'+' if break_score > 0 else ''}{break_score}")

    bandwidth = _safe(c, n - 1, "bb_bandwidth")
    upper, lower = _safe(c, n - 1, "bb_upper"), _safe(c, n - 1, "bb_lower")
    if bandwidth is not None:
        if bandwidth < 3:
            score += 1 if score > 0 else -1
            details.append("BB收敛(变盘在即)")
        elif bandwidth > 8:
            score = int(score * 0.6)
            details.append("BB宽幅震荡(MA信号打折)")
        if upper is not None and lower is not None and upper > lower:
            boll_position = (cp - lower) / (upper - lower) * 100.0
            if boll_position > 85:
                score -= 2
                details.append(f"BB上轨({boll_position:.0f}%)")
            elif boll_position < 15:
                score += 2
                details.append(f"BB下轨({boll_position:.0f}%)")

    confirmation = _check_ma_close_confirmation(c, n)
    if confirmation > 0:
        score += 2
        details.append(f"连续{confirmation}根站稳MA5上方")
    elif confirmation < 0:
        score -= 2
        details.append(f"连续{abs(confirmation)}根收于MA5下方")
    if trend >= 1 and score < -3:
        score = -3
        details.append("上升趋势(MA信号下限)")
    elif trend <= -1 and score > 3:
        score = 3
        details.append("下跌趋势(MA信号上限)")
    return _clamp(score), "; ".join(details)


def _score_squeeze(c: dict[str, list[Any]], n: int, trend: int) -> tuple[int, str]:
    ma5, ma10, ma20 = _safe(c, n - 1, "ma5"), _safe(c, n - 1, "ma10"), _safe(c, n - 1, "ma20")
    cp = c["close"][n - 1]
    if ma5 is None or ma10 is None or ma20 is None or cp <= 0:
        return 0, "数据不足"
    spread = (max(ma5, ma10, ma20) - min(ma5, ma10, ma20)) / cp * 100.0
    if spread >= 1.5:
        return 0, f"均线分散({spread:.1f}%)"
    details = ["高度粘合" if spread < 0.5 else f"均线收敛({spread:.1f}%)"]
    bull = ma5 > ma10 > ma20
    bear = ma5 < ma10 < ma20
    if bull:
        score = 7 if trend >= 1 else 3
        details.append("多头粘合")
    elif bear:
        score = -7 if trend <= -1 else -3
        details.append("空头粘合")
    elif trend >= 1:
        score = 3
        details.append("上升趋势粘合(偏多)")
    elif trend <= -1:
        score = -3
        details.append("下跌趋势粘合(偏空)")
    else:
        hist = _safe(c, n - 1, "macd_hist")
        score = 2 if hist is not None and hist > 0.02 else -2 if hist is not None and hist < -0.02 else 0
        details.append("MACD多头" if score > 0 else "MACD空头" if score < 0 else "方向未确认")
    center = (ma5 + ma10 + ma20) / 3.0
    deviation = (cp - center) / cp * 100.0
    score += 2 if deviation > 0.5 else -2 if deviation < -0.5 else 0
    return _clamp(score), "; ".join(details)


def _score_smart_money(c: dict[str, list[Any]], n: int, trend: int, ctx: ShortTermContext) -> tuple[int, str]:
    cp, op, high, low = c["close"][n - 1], c["open"][n - 1], c["high"][n - 1], c["low"][n - 1]
    tr = high - low
    if n < 5 or tr <= 0:
        return 0, "数据不足"
    body = abs(cp - op)
    upper = (high - max(cp, op)) / tr
    lower = (min(cp, op) - low) / tr
    score = 3 if upper >= 0.35 and trend >= 1 else 1 if upper >= 0.25 else -1 if upper < 0.1 and lower > 0.25 else 0
    score += -3 if lower >= 0.5 else -1 if lower >= 0.35 else 1 if lower < 0.15 and upper >= 0.25 else 0
    if body / tr < 0.1:
        position = _price_position(c, n)
        if trend >= 1:
            score -= 5 if position is not None and position > 90 else 2
        elif trend <= -1:
            score += 2
        else:
            score -= 1
    if n >= 2:
        previous_body = abs(c["close"][n - 2] - c["open"][n - 2])
        if cp > op and c["close"][n - 2] < c["open"][n - 2] and body > previous_body * 1.2:
            score += 4 if trend >= 1 else 2
        elif cp < op and c["close"][n - 2] > c["open"][n - 2] and body > previous_body * 1.2:
            score -= 4 if trend <= -1 else 2
    scale = 2.0 if ctx.high_volatility_board else 1.0
    average = _mean(c["volume"][max(0, n - 5):n - 1]) or 0
    if average > 0:
        ratio = c["volume"][n - 1] / average
        if ratio > 2 and abs(c["pct_change"][n - 1]) < scale:
            score -= 5 if trend >= 1 else 3
        elif ratio < 0.6 and c["pct_change"][n - 1] > 3 * scale:
            score += 3 if trend >= 1 else 1
        elif ratio < 0.6 and c["pct_change"][n - 1] < -3 * scale:
            score -= 3 if trend <= -1 else 1
    pct = c["pct_change"][n - 1]
    if (high - cp) / tr < 0.15 and pct < 2 * scale:
        score -= 3 if trend >= 1 else 1
    elif (cp - low) / tr < 0.15 and pct > -2 * scale:
        score += 2 if trend <= -1 else 1
    broken = _broken_limit(c, n, ctx)
    if broken["today_broken"]:
        upper_broken = (high - cp) / tr
        score -= 4 if upper_broken > 0.60 else 2 if upper_broken > 0.40 else 1 if upper_broken > 0.25 else 0
        if cp < op:
            score -= 2
    return _clamp(score), "K线行为与量价异常"


def _score_turnover(c: dict[str, list[Any]], n: int, trend: int, ctx: ShortTermContext) -> tuple[int | None, str]:
    current = _safe(c, n - 1, "turnover")
    if current is None:
        return None, "换手率数据缺失"
    high_volatility = ctx.high_volatility_board
    super_high, high, mid, low = ((30, 15, 6, 3) if high_volatility else (20, 10, 4, 2))
    big, medium, small = ((10, 6, 4) if high_volatility else (5, 3, 2))
    pct = c["pct_change"][n - 1]
    score = 0
    details: list[str] = []
    if current > super_high:
        score += 5 if pct > big else -5 if pct < -big else 2 if pct > 0 else -2
    elif current > high:
        score += 4 if pct > medium and trend >= 1 else 2 if pct > medium else -4 if pct < -medium else 1 if pct > 0 else -2 if pct < 0 else 0
    elif current > mid:
        score += 2 if pct > small else -2 if pct < -small else 1
    elif current > low:
        score += 3 if pct > small and trend >= 1 else 1 if pct > small else -1 if pct < -small else 0
    else:
        score += 2 if pct > 0 else -1 if pct < -medium else 0
    details.append(
        "超高换手" if current > super_high else
        "高换手" if current > high else
        "适度换手" if current > mid else
        "低换手" if current > low else "地量换手"
    )
    previous = [value for value in c["turnover"][max(0, n - 6):n - 1] if value is not None]
    average = _mean(previous)
    if average and average > 0:
        ratio = current / average
        if ratio > 3:
            score += 3 if pct > 2 else -3 if pct < -2 else -1
        elif ratio > 2:
            score += 2 if pct > 1 else -2 if pct < -1 else 0
        elif ratio < 0.5:
            score += 1 if trend >= 1 and pct > 0 else -1 if trend <= -1 else 0
    limit = _effective_limit(c, n - 1, ctx)
    if limit is not None:
        zt_low, zt_mid, zt_high, zt_very_high = ((8, 15, 30, 45) if high_volatility else (5, 10, 20, 30))
        dt_high, dt_low = ((20, 5) if high_volatility else (15, 3))
        if pct >= limit:
            if current < zt_low:
                score += 4
            elif current < zt_mid:
                score += 2
            elif current < zt_high:
                score += 1
            elif current < zt_very_high:
                score -= 1
            else:
                score -= 3
        elif pct <= -limit:
            if current > dt_high:
                score -= 3
            elif current < dt_low:
                score -= 2
        broken = _broken_limit(c, n, ctx)
        if broken["today_broken"]:
            score -= 4 if current > zt_high else 2 if current > zt_mid else 1
    if n >= 3:
        high_turn_days = sum(
            1 for index in range(n - 3, n)
            if (value := _safe(c, index, "turnover")) is not None and value > high
        )
        if high_turn_days >= 3:
            score -= 2 if trend >= 1 else 3 if trend <= -1 else 0
    if n >= 4:
        values = [_safe(c, index, "turnover") for index in range(n - 4, n)]
        if all(value is not None for value in values):
            if values[0] < values[1] < values[2] < values[3]:
                score += 3 if c["close"][n - 1] > c["close"][n - 4] and trend >= 1 else 1 if c["close"][n - 1] > c["close"][n - 4] else -2 if trend <= -1 else 0
            elif values[0] > values[1] > values[2] > values[3]:
                score += 2 if c["close"][n - 1] > c["close"][n - 4] and trend >= 1 else -2 if c["close"][n - 1] <= c["close"][n - 4] else 0
    return _clamp(score), f"{'/'.join(details)} {current:.2f}%"


def _zones_for_prefix(c: dict[str, list[Any]], n: int, ctx: ShortTermContext) -> dict[str, list[dict[str, Any]]]:
    """Build the source support/resistance candidates from ``c[:n]`` only."""
    empty = {"support": [], "resistance": []}
    if n < 20 or c["close"][n - 1] <= 0:
        return empty
    start = n - min(120, n)
    close = c["close"][n - 1]
    volume_average = [0.0] * n
    atr_sum = 0.0
    atr_count = 0
    for index in range(start, n):
        if index > start:
            atr_sum += max(
                c["high"][index] - c["low"][index],
                abs(c["high"][index] - c["close"][index - 1]),
                abs(c["low"][index] - c["close"][index - 1]),
            )
            atr_count += 1
        previous = [value for value in c["volume"][max(start, index - 5):index] if value > 0]
        volume_average[index] = sum(previous) / len(previous) if previous else 0.0
    atr = atr_sum / atr_count if atr_count else close * 0.02
    noisy = [False] * n
    for index in range(start, n):
        noisy[index] = (
            c["high"][index] - c["low"][index] > atr * 3
            and volume_average[index] > 0
            and c["volume"][index] < volume_average[index] * 0.7
        )

    points: list[dict[str, Any]] = []

    def add_point(price: float, score: int, source: str) -> None:
        if price > 0:
            points.append({"p": float(price), "s": score, "source": source})

    for index in range(start + 2, n):
        if noisy[index]:
            continue
        bar_high, bar_low = c["high"][index], c["low"][index]
        recent = index >= n - 10
        span = 2 if recent else 5
        backward = min(span, index - start)
        forward = min(span, n - 1 - index)
        high_window = range(index - backward, index + forward + 1)
        low_window = range(index - backward, index + forward + 1)
        is_high = all(c["high"][j] < bar_high for j in high_window if j != index)
        is_low = all(c["low"][j] > bar_low for j in low_window if j != index)
        base = 15 if not recent and backward >= 5 and forward >= 5 else 10
        bar_range = bar_high - bar_low
        high_score = base if not recent and backward >= 5 and forward >= 5 else base if bar_range > 0 and (bar_high - c["close"][index]) / bar_range < 0.3 else round(base * 0.5)
        low_score = base if not recent and backward >= 5 and forward >= 5 else base if bar_range > 0 and (c["close"][index] - bar_low) / bar_range < 0.3 else round(base * 0.5)
        if is_high:
            add_point(bar_high, high_score, "局部高点")
        if is_low:
            add_point(bar_low, low_score, "局部低点")

    for period_size, score in ((5, 12), (10, 18), (20, 30)):
        value = _safe(c, n - 1, f"ma{period_size}")
        if value is not None:
            add_point(value, score, f"MA{period_size}")

    for index in range(start, n):
        current_volume, average = c["volume"][index], volume_average[index]
        if not noisy[index] and current_volume > 0 and average > 0 and current_volume >= average * 2:
            ratio = current_volume / average
            score = 25 if ratio >= 3 else round(10 + (ratio - 2) * 15)
            add_point(c["high"][index], score, "放量高点")
            add_point(c["low"][index], score, "放量低点")
        if index <= start or noisy[index] or noisy[index - 1]:
            continue
        previous_high, previous_low = c["high"][index - 1], c["low"][index - 1]
        if c["low"][index] > previous_high:
            filled = any(c["low"][j] <= previous_high for j in range(index + 1, n))
            add_point((c["low"][index] + previous_high) / 2, 8 if filled else 20, "向上缺口")
        if c["high"][index] < previous_low:
            filled = any(c["high"][j] >= previous_low for j in range(index + 1, n))
            add_point((c["high"][index] + previous_low) / 2, 8 if filled else 20, "向下缺口")

    for index in range(start + 10, n + 1):
        window_high = max(c["high"][index - 10:index])
        window_low = min(c["low"][index - 10:index])
        if window_high - window_low < atr * 1.5:
            add_point(window_high, 10, "10根平台")
            add_point(window_low, 10, "10根平台")
    for index in range(max(start, n - 5), n):
        add_point(c["high"][index], 8, "近期高点")
        add_point(c["low"][index], 8, "近期低点")

    tolerance = max(close * 0.01, atr * 0.5)
    minimum_width = close * 0.008
    max_distance = max(close * 0.20, atr * 5)
    points.sort(key=lambda item: item["p"])
    clusters: list[dict[str, Any]] = []
    index = 0
    while index < len(points):
        base_price = points[index]["p"]
        cluster = {"min": base_price, "max": base_price, "score": points[index]["s"], "sources": [points[index]["source"]]}
        next_index = index + 1
        while next_index < len(points) and points[next_index]["p"] - base_price <= tolerance:
            cluster["score"] += points[next_index]["s"]
            cluster["max"] = points[next_index]["p"]
            if points[next_index]["source"] not in cluster["sources"]:
                cluster["sources"].append(points[next_index]["source"])
            next_index += 1
        clusters.append(cluster)
        index = next_index

    result = {"support": [], "resistance": []}
    for cluster in clusters:
        low, high = cluster["min"], cluster["max"]
        if high - low < minimum_width:
            middle = (high + low) / 2
            low, high = middle - minimum_width / 2, middle + minimum_width / 2
        middle = (low + high) / 2
        if middle > close + max_distance or middle < close - max_distance:
            continue
        score = min(100, cluster["score"])
        side = "resistance" if middle > close else "support"
        birth = n
        for bar_index in range(start, n):
            if (side == "resistance" and c["close"][bar_index] < low) or (side == "support" and c["close"][bar_index] > high):
                birth = bar_index
                break
        touches = 0
        in_zone = False
        for bar_index in range(birth, n):
            inside = low <= c["close"][bar_index] <= high
            if inside and not in_zone:
                touches += 1
                in_zone = True
            elif not inside:
                in_zone = False
        if touches >= 3:
            score += 20
        elif touches >= 2:
            score += 10

        false_breaks = 0
        first_check = max(birth, start + 1)
        for bar_index in range(first_check, n - 3):
            if side == "resistance" and c["high"][bar_index] > high and c["close"][bar_index] < low:
                if all(c["close"][j] < low for j in range(bar_index + 1, min(bar_index + 4, n))):
                    false_breaks += 1
            elif side == "support" and c["low"][bar_index] < low and c["close"][bar_index] > high:
                if all(c["close"][j] > high for j in range(bar_index + 1, min(bar_index + 4, n))):
                    false_breaks += 1
        if false_breaks:
            score += 20 + (15 if false_breaks > 1 else 0)
        status = "trap" if false_breaks else "normal"
        tag = f"假突破{false_breaks}次" if false_breaks else ""
        valid_breakouts = 0
        for bar_index in range(first_check, n - 2):
            outside = c["close"][bar_index] > high if side == "resistance" else c["close"][bar_index] < low
            if outside and volume_average[bar_index] > 0 and c["volume"][bar_index] > volume_average[bar_index] * 1.2:
                holds = all(
                    c["close"][j] > high if side == "resistance" else c["close"][j] < low
                    for j in range(bar_index + 1, min(bar_index + 3, n))
                )
                if holds:
                    valid_breakouts += 1
                    break
        if valid_breakouts:
            score -= 25
            if status != "trap":
                status = "broken"
                tag = "失效"

        divergence = False
        for bar_index in range(max(birth, start + 2), n):
            high_values = c["high"][bar_index - 2:bar_index + 1]
            low_values = c["low"][bar_index - 2:bar_index + 1]
            volume_values = c["volume"][bar_index - 2:bar_index + 1]
            if side == "resistance" and high_values[2] > high_values[1] > high_values[0] and volume_values[2] < volume_values[1] < volume_values[0] and low <= high_values[2] <= high + atr:
                divergence = True
                break
            if side == "support" and low_values[2] < low_values[1] < low_values[0] and volume_values[2] < volume_values[1] < volume_values[0] and low - atr <= low_values[2] <= high:
                divergence = True
                break
        if divergence:
            score += -15 if side == "resistance" else 10
            tag = f"{tag} 背离".strip() if tag else "背离"
        score = max(0, min(100, score))
        if score < 15:
            continue
        result[side].append({
            "id": "",
            "side": side,
            "low": round(low, 4),
            "high": round(high, 4),
            "center": round((low + high) / 2, 4),
            "score": int(score),
            "status": status,
            "tag": tag,
            "touches": touches,
            "false_breaks": false_breaks,
            "valid_breakouts": valid_breakouts,
            "sources": cluster["sources"],
            "distance_pct": round(abs((low + high) / 2 - close) / close * 100, 3),
            "as_of": c["key"][n - 1],
        })
    for side in result:
        result[side].sort(key=lambda item: (-item["score"], item["distance_pct"]))
        for rank, zone in enumerate(result[side][:3]):
            zone["id"] = f"{side}-{rank}"
        result[side] = result[side][:3]
    return result


def _volume_ratio(c: dict[str, list[Any]], index: int) -> float | None:
    return _safe(c, index, "vol_ratio_5d")


def _previous_volume_average(c: dict[str, list[Any]], index: int, period: int = 5) -> float:
    values = [value for value in c["volume"][max(0, index - period):index] if value > 0]
    return sum(values) / len(values) if len(values) >= 3 else 0.0


def _signal_allowed(c: dict[str, list[Any]], index: int, direction: str, kind: str) -> bool:
    if direction == "bullish":
        average = _previous_volume_average(c, index)
        if average > 0 and c["volume"][index] < average * 0.7:
            return False
    if kind == "kdj":
        k = _safe(c, index, "kdj_k")
        if k is not None and 35 < k < 65:
            return False
    if kind == "macd":
        current, previous = _safe(c, index, "macd_hist"), _safe(c, index - 1, "macd_hist")
        if current is None or previous is None:
            return False
        if abs(current) <= abs(previous) * 0.8:
            return False
    return True


def _cross_signal(
    c: dict[str, list[Any]],
    index: int,
    fast_key: str,
    slow_key: str,
    kind: str,
    label: str,
) -> dict[str, Any] | None:
    if index < 2:
        return None
    cross_index = index - 1
    before_fast, before_slow = _safe(c, cross_index - 1, fast_key), _safe(c, cross_index - 1, slow_key)
    crossed_fast, crossed_slow = _safe(c, cross_index, fast_key), _safe(c, cross_index, slow_key)
    current_fast, current_slow = _safe(c, index, fast_key), _safe(c, index, slow_key)
    if None in {before_fast, before_slow, crossed_fast, crossed_slow, current_fast, current_slow}:
        return None
    direction = "bullish" if before_fast <= before_slow and crossed_fast > crossed_slow and current_fast > current_slow else "bearish" if before_fast >= before_slow and crossed_fast < crossed_slow and current_fast < current_slow else ""
    if not direction or not _signal_allowed(c, cross_index, direction, kind):
        return None
    return {
        "_index": index,
        "as_of": c["key"][index],
        "cross_as_of": c["key"][cross_index],
        "type": f"{kind}_cross",
        "label": f"{label}{'金叉' if direction == 'bullish' else '死叉'}",
        "direction": direction,
        "g": 1 if direction == "bullish" else 0,
        "nm": label.removeprefix("MA"),
        "price": round(c["close"][cross_index], 4),
        "confirmed_bars": 2,
        "detail": "交叉连续确认，已通过量能/状态过滤",
    }


def _squeeze_signal(c: dict[str, list[Any]], index: int, start: int) -> dict[str, Any] | None:
    ma5, ma10, ma20 = (_safe(c, index, key) for key in ("ma5", "ma10", "ma20"))
    close = c["close"][index]
    if ma5 is None or ma10 is None or ma20 is None or close <= 0:
        return None
    spread = (max(ma5, ma10, ma20) - min(ma5, ma10, ma20)) / close * 100.0
    if spread >= 1.2:
        return None

    def spread_at(position: int) -> float | None:
        values = [_safe(c, position, key) for key in ("ma5", "ma10", "ma20")]
        price = c["close"][position]
        return (max(values) - min(values)) / price * 100.0 if all(value is not None for value in values) and price > 0 else None

    if any((value := spread_at(position)) is not None and value <= spread for position in range(max(start, index - 10), index)):
        return None
    previous_values = [
        value for position in range(max(start, index - 10), max(start, index - 3))
        if (value := spread_at(position)) is not None
    ]
    if not previous_values or max(previous_values) <= spread * 1.3:
        return None

    bullish, bearish = 0, 0
    bull_align = ma5 > ma10 > ma20
    bear_align = ma5 < ma10 < ma20
    center = (ma5 + ma10 + ma20) / 3.0
    deviation = (close - center) / close * 100.0
    if bull_align:
        bullish += 3
    if bear_align:
        bearish += 3
    if deviation > 0.5:
        bullish += 2
    elif deviation > 0.2:
        bullish += 1
    if deviation < -0.5:
        bearish += 2
    elif deviation < -0.2:
        bearish += 1
    old_ma5 = _safe(c, index - 5, "ma5")
    if old_ma5 is not None:
        if ma5 > old_ma5:
            bullish += 1
        elif ma5 < old_ma5:
            bearish += 1
    recent_volume = sum(c["volume"][index - 2:index + 1]) / 3.0
    previous_volume_values = c["volume"][max(start, index - 7):max(start, index - 3)]
    previous_volume = sum(previous_volume_values) / len(previous_volume_values) if previous_volume_values else 0.0
    volume_up = previous_volume > 0 and recent_volume > previous_volume * 1.15
    if volume_up and deviation > 0:
        bullish += 1
    if volume_up and deviation < 0:
        bearish += 1
    hist = _safe(c, index, "macd_hist")
    if hist is not None and hist > 0.02:
        bullish += 1
    if hist is not None and hist < -0.02:
        bearish += 1
    reference = max(start, index - 20)
    trend_up = c["close"][reference] > 0 and close > c["close"][reference]
    trend_down = c["close"][reference] > 0 and close < c["close"][reference]
    if abs(deviation) < 3:
        if trend_up and bearish > bullish:
            bearish -= 2
        if trend_down and bullish > bearish:
            bullish -= 2
    if deviation > 3:
        bullish -= 2
    if deviation > 3 and trend_down:
        bearish += 2
    if deviation < -3 and trend_up:
        bullish += 2

    direction = ""
    grade = 0
    if bull_align and bullish >= 3 and (not trend_down or bullish >= 5):
        direction, grade = "bullish", 1
    elif bear_align and bearish >= 3 and (not trend_up or bearish >= 5):
        direction, grade = "bearish", -1
    elif bullish >= 4 and bullish >= bearish + 2:
        direction, grade = "bullish", 1
    elif bearish >= 4 and bearish >= bullish + 2:
        direction, grade = "bearish", -1
    elif spread < 0.5:
        direction = "neutral"
    if not direction:
        return None
    return {
        "_index": index,
        "as_of": c["key"][index],
        "type": "ma_squeeze",
        "label": "均线粘合" if direction == "neutral" else f"均线粘合({'偏多' if direction == 'bullish' else '偏空'})",
        "direction": direction,
        "g": grade,
        "price": round(close, 4),
        "detail": f"MA5/10/20 spread={spread:.2f}%",
    }


def _divergence_signals(c: dict[str, list[Any]], n: int, start: int, kind: str) -> list[dict[str, Any]]:
    indicator = "macd_dif" if kind == "macd" else "volume"
    pivots: dict[str, list[int]] = {"high": [], "low": []}
    for index in range(start + 3, max(start + 3, n - 2)):
        window = range(index - 2, index + 3)
        if kind == "macd" and _safe(c, index, "macd_dif") is None:
            continue
        if all(c["close"][position] < c["close"][index] for position in window if position != index):
            pivots["high"].append(index)
        if all(c["close"][position] > c["close"][index] for position in window if position != index):
            pivots["low"].append(index)
    result: list[dict[str, Any]] = []
    for mode, direction, text in (("high", "bearish", "顶背离"), ("low", "bullish", "底背离")):
        for left, right in zip(pivots[mode], pivots[mode][1:]):
            left_price = c["close"][left]
            right_price = c["close"][right]
            if kind == "macd":
                left_indicator = _safe(c, left, "macd_dif")
                right_indicator = _safe(c, right, "macd_dif")
                if left_indicator is None or right_indicator is None or abs(right_indicator) < 0.02:
                    continue
                if mode == "high":
                    divergent = right_price > left_price * 1.015 and right_indicator < left_indicator - 0.01
                else:
                    divergent = right_price < left_price * 0.985 and right_indicator > left_indicator + 0.01
            else:
                left_indicator = c[indicator][left]
                right_indicator = c[indicator][right]
                if mode == "high":
                    divergent = right_price > left_price * 1.02 and right_indicator < left_indicator * 0.65
                else:
                    divergent = right_price < left_price * 0.98 and right_indicator < left_indicator * 0.6
            confirmation = right + 2
            if divergent and confirmation < n:
                result.append({
                    "_index": confirmation,
                    "as_of": c["key"][confirmation],
                    "pivot_as_of": c["key"][right],
                    "type": f"{kind}_divergence",
                    "label": f"{kind.upper()}{text}",
                    "direction": direction,
                    "g": 1 if direction == "bearish" else 0,
                    "price": round(c["close"][right], 4),
                    "detail": "局部高低点与指标方向不一致，已等待两根K线确认",
                })
    return result


def _dedup_signals(items: list[dict[str, Any]], gap: int) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for item in sorted(items, key=lambda value: value["_index"]):
        if result and item["_index"] - result[-1]["_index"] < gap:
            result[-1] = item
        else:
            result.append(item)
    return result


def _calc_signals(c: dict[str, list[Any]], n: int) -> dict[str, list[dict[str, Any]]]:
    found: dict[str, list[dict[str, Any]]] = {
        "ma": [], "macd": [], "kdj": [], "overbought_oversold": [], "volume": [],
        "squeeze": [], "macd_divergence": [], "volume_price_divergence": [],
    }
    if n < 30:
        return found
    # Keep the event stream causal for every historical row. A full-window
    # lookback here would make early rows differ after future bars are added.
    start = 1
    for index in range(max(2, start), n):
        for fast, slow, label in (("ma5", "ma10", "MA5/10"), ("ma10", "ma20", "MA10/20")):
            signal = _cross_signal(c, index, fast, slow, "ma", label)
            if signal:
                found["ma"].append(signal)
        macd = _cross_signal(c, index, "macd_dif", "macd_dea", "macd", "MACD")
        if macd:
            found["macd"].append(macd)
        kdj = _cross_signal(c, index, "kdj_k", "kdj_d", "kdj", "KDJ")
        if kdj:
            found["kdj"].append(kdj)

        k, d = _safe(c, index, "kdj_k"), _safe(c, index, "kdj_d")
        previous_k, previous_d = _safe(c, index - 1, "kdj_k"), _safe(c, index - 1, "kdj_d")
        if k is not None and d is not None:
            was_ob = previous_k is not None and previous_d is not None and previous_k > 80 and previous_d > 70
            was_os = previous_k is not None and previous_d is not None and previous_k < 20 and previous_d < 30
            if k > 80 and d > 70 and not was_ob:
                found["overbought_oversold"].append({"_index": index, "as_of": c["key"][index], "type": "overbought", "label": "KDJ超买", "direction": "bearish", "g": 1, "price": round(c["close"][index], 4), "detail": "高位状态，需结合趋势而非单独卖出"})
            elif k < 20 and d < 30 and not was_os:
                found["overbought_oversold"].append({"_index": index, "as_of": c["key"][index], "type": "oversold", "label": "KDJ超卖", "direction": "bullish", "g": 0, "price": round(c["close"][index], 4), "detail": "超卖状态，需结合下跌趋势过滤"})

        squeeze = _squeeze_signal(c, index, start)
        if squeeze is not None:
            found["squeeze"].append(squeeze)

    # KDJ 超买/超卖状态和第5根钝化提示各只发一次，保持源项目的状态机语义。
    ob_days, os_days = 0, 0
    found["overbought_oversold"] = []
    for index in range(start, n):
        k, d = _safe(c, index, "kdj_k"), _safe(c, index, "kdj_d")
        if k is None or d is None:
            ob_days, os_days = 0, 0
            continue
        is_ob, is_os = k > 80 and d > 70, k < 20 and d < 30
        if is_ob:
            ob_days += 1
            if ob_days == 1:
                found["overbought_oversold"].append({"_index": index, "as_of": c["key"][index], "type": "overbought", "label": "KDJ超买", "direction": "bearish", "g": 1, "price": round(c["close"][index], 4), "detail": "进入超买区"})
            elif ob_days == 5:
                found["overbought_oversold"].append({"_index": index, "as_of": c["key"][index], "type": "overbought_stall", "label": "KDJ超买钝化", "direction": "bearish", "g": 1, "price": round(c["close"][index], 4), "detail": "超买连续5根，钝化风险升高"})
        else:
            ob_days = 0
        if is_os:
            os_days += 1
            if os_days == 1:
                found["overbought_oversold"].append({"_index": index, "as_of": c["key"][index], "type": "oversold", "label": "KDJ超卖", "direction": "bullish", "g": 0, "price": round(c["close"][index], 4), "detail": "进入超卖区"})
            elif os_days == 5:
                found["overbought_oversold"].append({"_index": index, "as_of": c["key"][index], "type": "oversold_stall", "label": "KDJ超卖钝化", "direction": "bullish", "g": 0, "price": round(c["close"][index], 4), "detail": "超卖连续5根，弱势钝化"})
        else:
            os_days = 0

    # 天量/巨量/地量使用前置窗口，避免把当前量混入分母。
    for index in range(max(start, 30), n):
        current = c["volume"][index]
        if current <= 0:
            continue
        previous5 = [value for value in c["volume"][index - 5:index] if value > 0]
        previous20 = [value for value in c["volume"][index - 20:index] if value > 0]
        if len(previous5) < 3:
            continue
        average5 = sum(previous5) / len(previous5)
        average20 = sum(previous20) / len(previous20) if len(previous20) >= 10 else average5
        ratio5, ratio20 = current / average5, current / average20
        direction = "bullish" if c["pct_change"][index] > 1 else "bearish" if c["pct_change"][index] < -1 else "neutral"
        if all(c["volume"][position] < current for position in range(max(0, index - 120), index)):
            found["volume"].append({"_index": index, "as_of": c["key"][index], "type": "volume_new_high", "label": "天量", "direction": direction, "g": 3, "price": round(c["close"][index], 4), "volume_ratio": round(ratio5, 3), "detail": "成交量创120根新高"})
        elif all(c["volume"][position] < current for position in range(max(0, index - 10), index)) and (ratio5 >= 2.5 or ratio20 >= 2.5):
            found["volume"].append({"_index": index, "as_of": c["key"][index], "type": "volume_spike", "label": "巨量", "direction": direction, "g": 1, "price": round(c["close"][index], 4), "volume_ratio": round(ratio5, 3), "detail": "成交量创10根新高且量比≥2.5"})
        if all(c["volume"][position] == 0 or c["volume"][position] >= current for position in range(max(0, index - 30), index)) and ratio20 < 0.5:
            found["volume"].append({"_index": index, "as_of": c["key"][index], "type": "volume_valley", "label": "地量", "direction": "neutral", "g": 0, "price": round(c["close"][index], 4), "volume_ratio": round(ratio20, 3), "detail": "成交量创30根低点且量比<0.5"})

    # 源规则把反向 MACD 柱体作为均线粘合信号的最后一道过滤。
    found["squeeze"] = [
        item for item in found["squeeze"]
        if not (item.get("direction") == "bullish" and (_safe(c, item["_index"], "macd_hist") or 0) < -0.05)
        and not (item.get("direction") == "bearish" and (_safe(c, item["_index"], "macd_hist") or 0) > 0.05)
    ]

    found["macd_divergence"] = _divergence_signals(c, n, start, "macd")
    found["volume_price_divergence"] = _divergence_signals(c, n, start, "volume")

    # 源项目的巨量提示需要有实际价格波动，避免横盘噪声。
    found["volume"] = [
        item for item in found["volume"]
        if not (item.get("g") == 1 and abs(c["pct_change"][item["_index"]]) < 1.0)
    ]

    return found


def _signals_until(signals: dict[str, list[dict[str, Any]]], n: int) -> dict[str, list[dict[str, Any]]]:
    return {
        key: _dedup_signals(
            [dict(item) for item in values if item.get("_index", -1) < n],
            _SIGNAL_DEDUP_GAPS.get(key, 1),
        )
        for key, values in signals.items()
    }


def _score_sr(c: dict[str, list[Any]], n: int, zones: dict[str, list[dict[str, Any]]], trend: int) -> tuple[int, str]:
    if not zones.get("support") and not zones.get("resistance"):
        return 0, "无有效支撑压力"
    cp = c["close"][n - 1]
    supports = [zone for zone in zones.get("support", []) if zone.get("status") != "broken" and cp >= zone["center"]]
    resistances = [zone for zone in zones.get("resistance", []) if zone.get("status") != "broken" and cp <= zone["center"]]
    support = min(supports, key=lambda zone: cp - zone["center"], default=None)
    resistance = min(resistances, key=lambda zone: zone["center"] - cp, default=None)
    score = 0
    details: list[str] = []
    if support:
        distance = (cp - support["center"]) / cp * 100.0
        score += 5 if distance < 1 and trend >= 1 else 3 if distance < 1 else 2 if distance < 3 else 0
        if support.get("status") == "trap":
            score += 3
        details.append(f"距支撑{distance:.1f}%")
    else:
        score -= 3 if trend <= -1 else 1
        details.append("下方无支撑")
    if resistance:
        distance = (resistance["center"] - cp) / cp * 100.0
        score -= 2 if distance < 1 and trend >= 1 else 5 if distance < 1 else 2 if distance < 3 else 0
        if resistance.get("status") == "trap":
            score -= 3
        details.append(f"距压力{distance:.1f}%")
    else:
        score += 3 if trend >= 1 else 1
        details.append("上方无压力")
    return _clamp(score), "; ".join(details)


def _score_divergence(c: dict[str, list[Any]], n: int, signals: dict[str, list[dict[str, Any]]], trend: int) -> tuple[int, str]:
    recent = n - 10
    macd = next((item for item in reversed(signals.get("macd_divergence", [])) if item.get("_index", -1) >= recent), None)
    volume = next((item for item in reversed(signals.get("volume_price_divergence", [])) if item.get("_index", -1) >= recent), None)
    score = 0
    details: list[str] = []
    if macd:
        if macd["direction"] == "bearish":
            score -= 5 if trend >= 1 else 7
            details.append("MACD顶背离")
        else:
            score += 5 if trend <= -1 else 3 if trend >= 1 else 6
            details.append("MACD底背离")
    if volume:
        score += -5 if volume["direction"] == "bearish" else 5
        details.append("量价顶背离" if volume["direction"] == "bearish" else "量价底背离")
    return _clamp(score), "; ".join(details) or "无明显背离"


def _score_meta(c: dict[str, list[Any]], n: int, raw_scores: list[int], trend: int, ctx: ShortTermContext) -> tuple[int, str]:
    positive = sum(value > 0 for value in raw_scores)
    negative = sum(value < 0 for value in raw_scores)
    total_abs = sum(abs(value) for value in raw_scores)
    score = 0
    details: list[str] = []
    if positive >= 6 and total_abs > 15:
        score += 3 if trend >= 1 else 1
        details.append("多维共振(看多)")
    elif negative >= 6 and total_abs > 15:
        score -= 3 if trend <= -1 else 1
        details.append("多维共振(看空)")
    elif positive <= 2 and negative <= 2:
        score -= 1
        details.append("信号混乱")
    else:
        details.append("信号分歧")
    raw_sum = sum(raw_scores)
    if trend >= 1 and raw_sum > 0:
        score += 2
        details.append("趋势确认(多头)")
    elif trend <= -1 and raw_sum < 0:
        score -= 2
        details.append("趋势确认(空头)")
    ma20 = _safe(c, n - 1, "ma20")
    cp = c["close"][n - 1]
    scale = 2.0 if ctx.high_volatility_board else 1.0
    if ma20 is not None and ma20 > 0:
        deviation = (cp - ma20) / ma20 * 100.0
        if deviation > 8 * scale:
            average = _mean(c["volume"][max(0, n - 6):n - 1]) or 0.0
            ratio = c["volume"][n - 1] / average if average > 0 else 1.0
            if c["pct_change"][n - 1] > 2 * scale and ratio > 2:
                score -= 5 if trend <= -1 else 3
                details.append("高位放量(诱多)" if trend <= -1 else "高位放量(警惕)")
        elif deviation < -8 * scale and c["pct_change"][n - 1] < -2 * scale:
            score += 4 if trend >= 1 else 2
            details.append("低位急跌(洗盘)" if trend >= 1 else "低位急跌(诱空)")
    if n >= 6 and c["close"][n - 6] > 0:
        cumulative = (cp / c["close"][n - 6] - 1.0) * 100.0
        current = c["pct_change"][n - 1]
        if cumulative > 10 and current < -1:
            score += 1 if trend >= 1 else -3
            details.append("大涨后回调")
        elif cumulative < -10 and current > 1 and trend >= 1:
                score += 3
                details.append("大跌后反弹")
    return _clamp(score), "; ".join(details)


def _dimension_available(dimension: str, n: int, c: dict[str, list[Any]], ctx: ShortTermContext) -> bool:
    minimum = {
        "price_position": 11, "momentum": 6, "volume_price": 6, "macd": 26,
        "smart_money": 5, "turnover": 5, "ma_trend": 20, "support_resistance": 20,
        "kdj": 9, "squeeze": 20, "divergence": 20, "meta": 20,
    }[dimension]
    if n < max(20, minimum):
        return False
    if dimension == "turnover" and _safe(c, n - 1, "turnover") is None:
        return False
    return True


def _indicator_snapshot(c: dict[str, list[Any]], n: int) -> dict[str, float | None]:
    fields = (
        "close", "ma5", "ma7", "ma10", "ma20", "ma60", "vwma5", "vwma10", "vwma20",
        "macd_dif", "macd_dea", "macd_hist", "kdj_k", "kdj_d", "kdj_j", "bb_middle", "bb_upper", "bb_lower",
        "bb_bandwidth", "volume", "vol_ma5", "vol_ma10", "vol_ratio_5d", "turnover",
    )
    values = {field: _safe(c, n - 1, field) for field in fields}
    values["change_pct"] = _safe(c, n - 1, "pct_change")
    values["price_position_10"] = _price_position(c, n)
    values["atr_14"] = _atr(c, n)
    return {key: round(value, 6) if value is not None else None for key, value in values.items()}


def _advice(total: int | None, trend: int | None, dimensions: list[dict[str, Any]]) -> tuple[str, str]:
    if total is None:
        return "数据不足", "等待更多历史K线"
    if total >= 78:
        return "强烈买入", "短线强势，果断跟进"
    if total >= 63:
        return "建议买入", "可逢低介入，设好止盈止损"
    if total >= 50:
        return "偏多观望", "轻仓试探，等待确认"
    if total >= 40:
        return "观望", "方向不明，场外等待"
    if total >= 25:
        return "建议卖出", "逢高减仓，规避风险"
    return "强烈卖出", "尽快离场，切勿抄底"


def _filter_public_signals(signals: dict[str, list[dict[str, Any]]], start: str | None = None) -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = {}
    for key, values in signals.items():
        visible = [
            item for item in values
            if start is None or str(item.get("as_of", "")) >= start
        ]
        result[key] = [
            {field: value for field, value in item.items() if field != "_index"}
            for item in _dedup_signals(visible, _SIGNAL_DEDUP_GAPS.get(key, 1))
        ]
    return result


def calculate_short_term_analysis(frame: pl.DataFrame, context: ShortTermContext) -> dict[str, Any]:
    """Calculate source-compatible rows, zones and confirmed signals."""
    columns = _build_columns(frame, context.period)
    count = len(columns["close"])
    if count == 0:
        return {
            "version": SHORT_TERM_SCORE_VERSION,
            "period": context.period,
            "bar_semantics": SHORT_TERM_BAR_SEMANTICS,
            "rows": [], "zones": {"support": [], "resistance": []}, "signals": {},
            "as_of": None, "limitations": ["当前周期没有可计算的K线"],
        }
    all_signals = _calc_signals(columns, count)
    rows: list[dict[str, Any]] = []
    latest_zones: dict[str, list[dict[str, Any]]] = {"support": [], "resistance": []}
    for n in range(1, count + 1):
        trend = _detect_trend(columns, n) if n >= 10 else None
        zones = _zones_for_prefix(columns, n, context)
        if n == count:
            latest_zones = zones
        visible_signals = _signals_until(all_signals, n)
        dimensions: list[dict[str, Any]] = []
        raw_scores: list[int] = []
        for dimension, name, weight in _DIMENSIONS[:-1]:
            available = trend is not None and _dimension_available(dimension, n, columns, context)
            if available:
                scorer = {
                    "price_position": _score_price_position,
                    "momentum": _score_momentum,
                    "volume_price": _score_volume,
                    "macd": _score_macd,
                    "smart_money": _score_smart_money,
                    "turnover": _score_turnover,
                    "ma_trend": _score_ma_trend,
                    "support_resistance": _score_sr,
                    "kdj": _score_kdj,
                    "squeeze": _score_squeeze,
                    "divergence": _score_divergence,
                }[dimension]
                if dimension == "price_position":
                    score, detail = scorer(columns, n, trend, context)
                elif dimension in {"momentum", "volume_price", "smart_money", "turnover"}:
                    score, detail = scorer(columns, n, trend, context)
                elif dimension in {"support_resistance"}:
                    score, detail = scorer(columns, n, zones, trend)
                elif dimension == "kdj":
                    score, detail = scorer(columns, n, trend, zones)
                elif dimension == "divergence":
                    score, detail = scorer(columns, n, visible_signals, trend)
                else:
                    score, detail = scorer(columns, n, trend)
            else:
                score, detail = None, f"历史不足{max(20, {'macd': 26}.get(dimension, 20))}根或数据缺失"
            dimensions.append({"id": dimension, "name": name, "score": score, "weight": weight, "detail": detail})
            if score is not None:
                raw_scores.append(score)

        meta_available = trend is not None and _dimension_available("meta", n, columns, context)
        if meta_available:
            meta_score, meta_detail = _score_meta(columns, n, raw_scores, trend, context)
        else:
            meta_score, meta_detail = None, "历史不足20根或前置维度不可用"
        dimensions.append({"id": "meta", "name": "趋势确认", "score": meta_score, "weight": 2, "detail": meta_detail})

        available_weight = sum(item["weight"] for item in dimensions if item["score"] is not None)
        weighted_raw = sum(item["score"] * item["weight"] for item in dimensions if item["score"] is not None)
        total = round(50.0 + 50.0 * math.tanh(2.5 * weighted_raw / (available_weight * 10.0))) if available_weight else None
        if total is not None and context.limit_enabled:
            limit = _effective_limit(columns, n - 1, context)
            if limit is not None and columns["pct_change"][n - 1] >= limit and _recent_limit_up_count(columns, n, context) == 0:
                total = min(total, 72)
            broken = _broken_limit(columns, n, context)
            if broken["today_broken"]:
                high, current = columns["raw_high"][n - 1], columns["raw_close"][n - 1]
                fallback = (high - current) / high * 100.0 if high and current is not None else 0.0
                total = min(total, 60 if fallback > 5 else 65 if fallback > 3 else 70 if fallback > 1 else 74)
        action, hold_advice = _advice(total, trend, dimensions)
        rows.append({
            "as_of": columns["key"][n - 1],
            "total": total,
            "action": action,
            "hold_advice": hold_advice,
            "trend": trend,
            "coverage": round(available_weight / _TOTAL_WEIGHT, 4),
            "available": bool(total is not None and n >= 20),
            "dimensions": dimensions,
            "indicators": _indicator_snapshot(columns, n),
        })

    limitations: list[str] = []
    if count < 120:
        limitations.append(f"当前仅有{count}根原生K线，120根窗口未完整覆盖")
    if all(value is None for value in columns["turnover"]):
        limitations.append("换手率数据缺失，换手率维度未参与归一化")
    if context.period == "1d" and context.asset_type == "stock" and all(value is None for value in columns["raw_close"]):
        limitations.append("缺少原始价，涨跌停/炸板规则未启用")
    if context.asset_type == "etf":
        limitations.append("ETF仅使用通用价量与技术规则，不套用股票板块涨跌停解释")
    if context.period != "1d":
        limitations.append("非日线周期不启用日级涨跌停与炸板规则")
    return {
        "version": SHORT_TERM_SCORE_VERSION,
        "period": context.period,
        "bar_semantics": SHORT_TERM_BAR_SEMANTICS,
        "rows": rows,
        "zones": latest_zones,
        "signals": _filter_public_signals(all_signals),
        "as_of": columns["key"][-1],
        "limitations": limitations,
    }


def short_term_analysis_payload(
    frame: pl.DataFrame,
    *,
    symbol: str,
    asset_type: str,
    period: str,
    risk_warning: bool = False,
) -> dict[str, Any]:
    return calculate_short_term_analysis(
        frame,
        ShortTermContext(symbol=symbol, asset_type=asset_type, period=period, risk_warning=risk_warning),
    )
