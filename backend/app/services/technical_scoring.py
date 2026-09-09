"""统一技术指标评分.

评分是对单根 K 线当时可见信息的结构化摘要, 不是交易信号, 也不替换策略
引擎的截面评分. 模块只生成运行时列, 不修改持久化数据.

评分只使用已有图表指标: MA, MACD, RSI, KDJ, momentum/ROC, 量比,
ATR 和 BOLL. 方向分与独立波动风险分开, 量价分同时考虑当前放量和量能持续性.
"""
from __future__ import annotations

import math
from collections.abc import Iterable

import polars as pl

from app.indicators.pipeline import compute_indicators

TECHNICAL_SCORE_VERSION = "technical-score-v2"

# 供 API/前端使用的运行时列. 列名带 technical_ 前缀, 避免与策略 score 混淆.
TECHNICAL_SCORE_COLUMNS = (
    "technical_direction_score",
    "technical_confidence",
    "technical_coverage",
    "technical_trend_score",
    "technical_momentum_score",
    "technical_volume_price_score",
    "technical_state_confirmation_score",
    "technical_volatility_risk",
    "technical_activity_score",
    "technical_score_available",
)

# 方向分的顶层权重; ATR/BOLL 只参与独立风险分, 活跃度并入量价分.
_DIRECTION_WEIGHTS = {
    "trend": 0.35,
    "momentum": 0.30,
    "volume_price": 0.25,
    "state_confirmation": 0.10,
}

_REQUIRED_INDICATORS = {
    "ma5", "ma10", "ma20", "ma60",
    "macd_dif", "macd_dea", "macd_hist",
    "rsi_14", "kdj_k", "kdj_d", "kdj_j",
    "momentum_5d", "momentum_20d", "momentum_60d",
    "boll_upper", "boll_lower", "vol_ma5", "vol_ma10", "vol_ratio_5d", "atr_14",
}


def _number(value: object) -> float | None:
    if value is None or value == "":
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _clamp(value: float, low: float = 0.0, high: float = 100.0) -> float:
    return max(low, min(high, value))


def _sign_score(value: float | None) -> float | None:
    """把方向值映射为 0/50/100; 零和无效值保持中性/缺失."""
    if value is None:
        return None
    if value > 0:
        return 100.0
    if value < 0:
        return 0.0
    return 50.0


def _weighted_mean(parts: Iterable[tuple[float | None, float]]) -> tuple[float | None, float]:
    """返回按可用权重重归一后的分数和覆盖率."""
    available = [(value, weight) for value, weight in parts if value is not None]
    total = sum(weight for _, weight in available)
    expected = sum(weight for _, weight in parts)
    if total <= 0 or expected <= 0:
        return None, 0.0
    return sum(value * weight for value, weight in available) / total, total / expected


def _weighted_score(
    parts: Iterable[tuple[float | None, float, float]],
) -> tuple[float | None, float]:
    """Combine nested scores while retaining the underlying indicator coverage."""
    values = list(parts)
    available = [(value, weight) for value, weight, _ in values if value is not None]
    expected = sum(weight for _, weight, _ in values)
    score_weight = sum(weight for _, weight in available)
    if score_weight <= 0 or expected <= 0:
        return None, 0.0
    score = sum(value * weight for value, weight in available) / score_weight
    coverage = sum(weight * coverage for value, weight, coverage in values if value is not None) / expected
    return score, coverage


def _consistency_score(values: Iterable[float | None]) -> float:
    available = [value for value in values if value is not None]
    if len(available) < 2:
        return 0.0
    center = sum(available) / len(available)
    dispersion = sum(abs(value - center) for value in available) / (len(available) * 50.0)
    return _clamp(1.0 - dispersion, 0.0, 1.0)


def _state_confirmation_score(values: Iterable[float | None]) -> tuple[float | None, float]:
    available = [value for value in values if value is not None]
    if len(available) < 2:
        return None, len(available) / 3.0
    bullish = sum(value > 55.0 for value in available)
    bearish = sum(value < 45.0 for value in available)
    score = 50.0 + 50.0 * (bullish - bearish) / len(available)
    return _clamp(score), len(available) / 3.0


def _window_consistency(records: list[dict], index: int) -> float:
    row = records[index]
    previous = records[index - 1] if index > 0 else {}
    values: list[float | None] = []
    for left, right in (("ma5", "ma20"), ("ma20", "ma60")):
        left_value = _number(row.get(left))
        right_value = _number(row.get(right))
        values.append(_sign_score(left_value - right_value) if left_value is not None and right_value is not None else None)
    for key in ("momentum_5d", "momentum_20d", "momentum_60d"):
        values.append(_sign_score(_number(row.get(key))))
    for key in ("ma5", "ma20", "ma60"):
        current = _number(row.get(key))
        prior = _number(previous.get(key))
        values.append(_sign_score(current - prior) if current is not None and prior is not None else None)
    return _consistency_score(values)


def _relative_level_score(relative: float | None) -> float | None:
    """历史相对水平 -> 波动风险分.

    采用固定线性映射而非截面 min-max, 保证同一标的在不同日期和不同数据集上可比.
    历史中位数为 50 分, 相对水平每增加 1 倍提高 50 分.
    """
    if relative is None or relative < 0 or not math.isfinite(relative):
        return None
    return _clamp(50.0 + (relative - 1.0) * 50.0)


def _activity_level_score(relative: float | None) -> float | None:
    """相对量能 -> 活跃度分; 1x 为常态 50 分."""
    if relative is None or relative < 0 or not math.isfinite(relative):
        return None
    return _clamp(50.0 + (relative - 1.0) * 50.0)


def _rsi_score(value: float | None) -> float | None:
    if value is None:
        return None
    # 50 为中性; 保留超买/超卖的方向信息, 但不让极值超过 0~100.
    return _clamp(50.0 + (value - 50.0) * 1.25)


def _flat_close_window(records: list[dict], index: int, window: int = 14) -> bool:
    closes = [
        value for row in records[max(0, index - window + 1):index + 1]
        if (value := _number(row.get("close"))) is not None and value > 0
    ]
    return len(closes) >= 2 and max(closes) - min(closes) <= 1e-12


def _volume_ratio(records: list[dict], index: int) -> float | None:
    current = _number(records[index].get("volume"))
    if current is not None and current <= 0:
        return None
    if "vol_ratio_5d" in records[index]:
        explicit = _number(records[index].get("vol_ratio_5d"))
        return explicit if explicit is not None and explicit > 0 else None
    if current is None or index < 5:
        return None
    previous = [_number(row.get("volume")) for row in records[index - 5:index]]
    if any(value is None or value < 0 for value in previous):
        return None
    average = sum(value for value in previous if value is not None) / 5.0
    return current / average if average > 0 else None


def _change_pct(records: list[dict], index: int) -> float | None:
    explicit = _number(records[index].get("change_pct"))
    if explicit is not None:
        return explicit
    if index <= 0:
        return None
    current = _number(records[index].get("close"))
    previous = _number(records[index - 1].get("close"))
    if current is None or previous is None or previous <= 0:
        return None
    return current / previous - 1.0


def _trend_score(records: list[dict], index: int) -> tuple[float | None, float]:
    row = records[index]
    previous = records[index - 1] if index > 0 else {}
    alignment = _weighted_mean((
        (_sign_score(_number(row.get("close")) - _number(row.get("ma5")))
         if _number(row.get("close")) is not None and _number(row.get("ma5")) is not None else None, 0.25),
        (_sign_score(_number(row.get("ma5")) - _number(row.get("ma10")))
         if _number(row.get("ma5")) is not None and _number(row.get("ma10")) is not None else None, 0.25),
        (_sign_score(_number(row.get("ma10")) - _number(row.get("ma20")))
         if _number(row.get("ma10")) is not None and _number(row.get("ma20")) is not None else None, 0.25),
        (_sign_score(_number(row.get("ma20")) - _number(row.get("ma60")))
         if _number(row.get("ma20")) is not None and _number(row.get("ma60")) is not None else None, 0.25),
    ))

    slope_parts: list[tuple[float | None, float]] = []
    for field in ("ma5", "ma20", "ma60"):
        current = _number(row.get(field))
        prior = _number(previous.get(field))
        slope_parts.append((_sign_score(current - prior) if current is not None and prior is not None else None, 1.0))
    slope = _weighted_mean(slope_parts)
    score, coverage = _weighted_score((
        (alignment[0], 0.6, alignment[1]),
        (slope[0], 0.4, slope[1]),
    ))
    return score, coverage


def _momentum_score(records: list[dict], index: int) -> tuple[float | None, float]:
    row = records[index]
    previous = records[index - 1] if index > 0 else {}
    dif = _number(row.get("macd_dif"))
    dea = _number(row.get("macd_dea"))
    hist = _number(row.get("macd_hist"))
    previous_hist = _number(previous.get("macd_hist"))
    macd = _weighted_mean((
        (_sign_score(dif - dea) if dif is not None and dea is not None else None, 0.5),
        (_sign_score(dif) if dif is not None else None, 0.3),
        (_sign_score(hist - previous_hist) if hist is not None and previous_hist is not None else None, 0.2),
    ))

    rsi_value = _number(row.get("rsi_14"))
    rsi = 50.0 if rsi_value in {0.0, 100.0} and _flat_close_window(records, index) else _rsi_score(rsi_value)
    k = _number(row.get("kdj_k"))
    d = _number(row.get("kdj_d"))
    kdj = _weighted_mean((
        (_clamp(50.0 + (k - d) * 2.0) if k is not None and d is not None else None, 0.6),
        (_clamp(k) if k is not None else None, 0.4),
    ))
    roc = _weighted_mean((
        (_sign_score(_number(row.get("momentum_5d"))), 0.25),
        (_sign_score(_number(row.get("momentum_20d"))), 0.35),
        (_sign_score(_number(row.get("momentum_60d"))), 0.40),
    ))
    score, coverage = _weighted_score((
        (macd[0], 0.35, macd[1]),
        (rsi, 0.20, 1.0 if rsi is not None else 0.0),
        (kdj[0], 0.15, kdj[1]),
        (roc[0], 0.30, roc[1]),
    ))
    return score, coverage


def _volume_price_score(records: list[dict], index: int) -> tuple[float | None, float]:
    change = _change_pct(records, index)
    ratio = _volume_ratio(records, index)
    price_score = None
    if change is not None and ratio is not None:
        if abs(change) < 1e-12:
            price_score = 50.0
        else:
            conviction = _clamp(ratio / 2.0, 0.25, 1.0)
            price_score = _clamp(50.0 + 50.0 * (1.0 if change > 0 else -1.0) * conviction)

    vol5 = _number(records[index].get("vol_ma5"))
    vol10 = _number(records[index].get("vol_ma10"))
    sustained_ratio = vol5 / vol10 if vol5 is not None and vol10 is not None and vol10 > 0 else None
    sustained_score = _activity_level_score(sustained_ratio)
    if price_score is None:
        return None, 0.0
    if sustained_score is not None and price_score < 50.0:
        sustained_score = 100.0 - sustained_score
    return _weighted_score(((price_score, 0.7, 1.0), (sustained_score, 0.3, 1.0)))


def _volatility_risk(records: list[dict], index: int) -> float | None:
    row = records[index]
    close = _number(row.get("close"))
    atr = _number(row.get("atr_14"))
    atr_pct = atr / close if atr is not None and close is not None and close > 0 else None

    upper = _number(row.get("boll_upper"))
    lower = _number(row.get("boll_lower"))
    middle = _number(row.get("ma20"))
    boll_width = ((upper - lower) / middle
                  if upper is not None and lower is not None and middle is not None and middle > 0
                  else None)
    parts: list[float] = []
    for value, field in ((atr_pct, "_atr_pct"), (boll_width, "_boll_width")):
        if value is None:
            continue
        history: list[float] = []
        for prior in records[max(0, index - 20):index]:
            prior_close = _number(prior.get("close"))
            if field == "_atr_pct":
                prior_atr = _number(prior.get("atr_14"))
                prior_value = prior_atr / prior_close if prior_atr is not None and prior_close and prior_close > 0 else None
            else:
                prior_upper = _number(prior.get("boll_upper"))
                prior_lower = _number(prior.get("boll_lower"))
                prior_middle = _number(prior.get("ma20"))
                prior_value = ((prior_upper - prior_lower) / prior_middle
                               if prior_upper is not None and prior_lower is not None
                               and prior_middle is not None and prior_middle > 0 else None)
            if prior_value is not None and math.isfinite(prior_value) and prior_value >= 0:
                history.append(prior_value)
        if len(history) < 20:
            continue
        history.sort()
        middle_index = len(history) // 2
        baseline = history[middle_index]
        if len(history) % 2 == 0:
            baseline = (history[middle_index - 1] + history[middle_index]) / 2.0
        if baseline > 0:
            parts.append(_relative_level_score(value / baseline) or 50.0)
    return sum(parts) / len(parts) if parts else None


def _activity_score(records: list[dict], index: int) -> float | None:
    ratio = _volume_ratio(records, index)
    ratio_score = _activity_level_score(ratio)
    vol5 = _number(records[index].get("vol_ma5"))
    vol10 = _number(records[index].get("vol_ma10"))
    trend_ratio = vol5 / vol10 if vol5 is not None and vol10 is not None and vol10 > 0 else None
    trend_score = _activity_level_score(trend_ratio)
    score, _ = _weighted_mean(((ratio_score, 0.7), (trend_score, 0.3)))
    return score


def _score_records(records: list[dict]) -> list[dict[str, float | bool | None]]:
    result: list[dict[str, float | bool | None]] = []
    for index in range(len(records)):
        trend, trend_coverage = _trend_score(records, index)
        momentum, momentum_coverage = _momentum_score(records, index)
        volume_price, volume_price_coverage = _volume_price_score(records, index)
        state_confirmation, state_coverage = _state_confirmation_score((trend, momentum, volume_price))
        volatility = _volatility_risk(records, index)
        activity = _activity_score(records, index)

        base_dimensions = (
            (trend, _DIRECTION_WEIGHTS["trend"], trend_coverage),
            (momentum, _DIRECTION_WEIGHTS["momentum"], momentum_coverage),
            (volume_price, _DIRECTION_WEIGHTS["volume_price"], volume_price_coverage),
        )
        dimensions = (*base_dimensions, (state_confirmation, _DIRECTION_WEIGHTS["state_confirmation"], state_coverage))
        direction_score, _ = _weighted_score(dimensions)
        coverage_weight = sum(weight for _, weight, _ in base_dimensions)
        coverage = sum(weight * component_coverage for _, weight, component_coverage in base_dimensions) / coverage_weight
        valid_dimensions = sum(score is not None for score, _, _ in base_dimensions)
        close = _number(records[index].get("close"))
        volume = _number(records[index].get("volume"))
        base_data_valid = close is not None and close > 0 and volume is not None and volume > 0
        available = (
            base_data_valid
            and direction_score is not None
            and valid_dimensions >= 2
            and coverage >= 0.60
        )

        consistency = _consistency_score((trend, momentum, volume_price))
        window_consistency = _window_consistency(records, index)
        confidence = _clamp(100.0 * (coverage + consistency + window_consistency) / 3.0)
        result.append({
            "technical_direction_score": round(direction_score) if available and direction_score is not None else None,
            "technical_confidence": round(confidence) if available else 0,
            "technical_coverage": round(coverage * 100.0),
            "technical_trend_score": round(trend) if trend is not None else None,
            "technical_momentum_score": round(momentum) if momentum is not None else None,
            "technical_volume_price_score": round(volume_price) if volume_price is not None else None,
            "technical_state_confirmation_score": round(state_confirmation) if state_confirmation is not None else None,
            "technical_volatility_risk": round(volatility) if volatility is not None else None,
            "technical_activity_score": round(activity) if activity is not None else None,
            "technical_score_available": available,
        })
    return result


def _empty_score_columns(frame: pl.DataFrame) -> pl.DataFrame:
    existing = [column for column in TECHNICAL_SCORE_COLUMNS if column in frame.columns]
    base = frame.drop(existing) if existing else frame
    return base.with_columns([
        pl.Series(name="technical_direction_score", values=[], dtype=pl.Int64),
        pl.Series(name="technical_confidence", values=[], dtype=pl.Int64),
        pl.Series(name="technical_coverage", values=[], dtype=pl.Int64),
        pl.Series(name="technical_trend_score", values=[], dtype=pl.Int64),
        pl.Series(name="technical_momentum_score", values=[], dtype=pl.Int64),
        pl.Series(name="technical_volume_price_score", values=[], dtype=pl.Int64),
        pl.Series(name="technical_state_confirmation_score", values=[], dtype=pl.Int64),
        pl.Series(name="technical_volatility_risk", values=[], dtype=pl.Int64),
        pl.Series(name="technical_activity_score", values=[], dtype=pl.Int64),
        pl.Series(name="technical_score_available", values=[], dtype=pl.Boolean),
    ])


def score_technical_frame(
    frame: pl.DataFrame,
    *,
    assume_sorted: bool = False,
) -> pl.DataFrame:
    """为每根 K 线附加技术评分列.

    输入可以是已计算指标的 enriched/周期 K, 也可以是包含 OHLCV 的基础表;
    缺少图表指标时会按现有 pipeline 补算. 返回按 symbol/date 排序的运行时表.
    """
    if frame.is_empty():
        return _empty_score_columns(frame)
    sort_columns = [column for column in ("symbol", "date") if column in frame.columns]
    working = frame if assume_sorted or not sort_columns else frame.sort(sort_columns)
    missing = _REQUIRED_INDICATORS - set(working.columns)
    if missing and {"symbol", "date", "open", "high", "low", "close", "volume"} <= set(working.columns):
        working = compute_indicators(working, needed=_REQUIRED_INDICATORS, assume_sorted=True)

    grouped = working.partition_by("symbol", maintain_order=True) if "symbol" in working.columns else [working]
    all_scores: list[dict[str, float | bool | None]] = []
    for group in grouped:
        all_scores.extend(_score_records(group.to_dicts()))
    if len(all_scores) != working.height:
        raise RuntimeError("technical score row count mismatch")
    return working.with_columns([
        pl.Series(name=column, values=[score[column] for score in all_scores])
        for column in TECHNICAL_SCORE_COLUMNS
    ])


def technical_score_payload(frame: pl.DataFrame) -> dict:
    """把评分列压缩成 KlineResponse 的附加序列。"""
    if frame.is_empty() or "date" not in frame.columns:
        return {"version": TECHNICAL_SCORE_VERSION, "rows": []}
    rows = []
    for row in frame.select(["date", *TECHNICAL_SCORE_COLUMNS]).to_dicts():
        rows.append({
            "as_of": str(row.pop("date")),
            "direction_score": row.pop("technical_direction_score"),
            "confidence": row.pop("technical_confidence"),
            "coverage": row.pop("technical_coverage"),
            "trend": row.pop("technical_trend_score"),
            "momentum": row.pop("technical_momentum_score"),
            "volume_price": row.pop("technical_volume_price_score"),
            "state_confirmation": row.pop("technical_state_confirmation_score"),
            "volatility_risk": row.pop("technical_volatility_risk"),
            "activity": row.pop("technical_activity_score"),
            "available": row.pop("technical_score_available"),
        })
    return {"version": TECHNICAL_SCORE_VERSION, "rows": rows}
