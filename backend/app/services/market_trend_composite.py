"""Shared scoring for the market-trend component of composite scores."""
from __future__ import annotations

import math


def _valid_score(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and 0 <= value <= 100


def _category(categories, category_id):
    return next((item for item in categories if item.get("id") == category_id), None)


def _indicator(category, indicator_id):
    return next((item for item in (category or {}).get("indicators", []) if item.get("id") == indicator_id), None)


def market_trend_score(weekly, daily, minute):
    if weekly is None or daily is None:
        return None
    raw = 55 * (weekly == "attack") + 30 * (daily == "attack") + 15 * (0.5 if minute is None else minute == "attack")
    return math.floor(raw + 0.5)


def composite_trend_score(categories, weekly, daily, minute):
    trend = market_trend_score(weekly, daily, minute)
    if trend is None:
        return None

    momentum = _category(categories, "momentum")
    macd = _indicator(momentum, "macd")
    rsi = _indicator(momentum, "rsi")
    position = _category(categories, "price_position")
    atr_values = (_indicator(position, "ma20_atr_position") or {}).get("raw_values") or {}
    macd_values = (macd or {}).get("raw_values") or {}
    dif, hist, previous_hist = (macd_values.get(key) for key in ("dif", "hist", "previous_hist"))
    atr = atr_values.get("atr14")
    macd_score = None
    if all(isinstance(value, (int, float)) and math.isfinite(value) for value in (dif, hist, previous_hist, atr)) and atr > 0:
        macd_score = 50 + 50 * (
            0.5 * math.tanh(2 * hist / atr)
            + 0.3 * math.tanh(dif / atr)
            + 0.2 * math.tanh(8 * (hist - previous_hist) / atr)
        )

    rsi_values = (rsi or {}).get("raw_values") or {}
    rsi_value = rsi_values.get("rsi14")
    rsi_score = None
    if _valid_score(rsi_value) and (rsi or {}).get("direction") in {"RISING", "FALLING", "FLAT"}:
        rsi_score = max(0.0, min(100.0, 50 + 0.8 * (rsi_value - 50)
            + (10 if rsi["direction"] == "RISING" else -10 if rsi["direction"] == "FALLING" else 0)
            + (10 if rsi.get("divergence") == "BOTTOM_DIVERGENCE" else -10 if rsi.get("divergence") == "TOP_DIVERGENCE" else 0)))

    volume = _category(categories, "volume_price")
    volume_score = volume.get("score") if volume and volume.get("available") is True and volume.get("coverage", 0) >= 100 and _valid_score(volume.get("score")) else None
    if any(value is None for value in (macd_score, rsi_score, volume_score)):
        return None
    return math.floor(trend * 0.4 + macd_score * 0.2 + rsi_score * 0.2 + volume_score * 0.2 + 0.5)
