"""统一技术指标评分.

评分是对单根 K 线当时可见信息的结构化摘要, 不是交易信号, 也不替换策略
引擎的截面评分. 模块只生成运行时列, 不修改持久化数据.

评分只使用已有图表指标: MA, MACD, RSI, KDJ, momentum/ROC, 量比,
ATR, BOLL 和 K 线成交额. 旧版顶层字段保持兼容; v3 另外输出 ETF 优先的
类别/子指标评分, 方向、波动风险和成交活跃度彼此独立.
"""
from __future__ import annotations

import math
from collections.abc import Iterable
from itertools import pairwise

import polars as pl

from app.indicators.pipeline import compute_indicators

TECHNICAL_SCORE_VERSION = "technical-score-v3"

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
    "technical_category_direction_score",
    "technical_category_direction_coverage",
    "technical_category_direction_available",
    "technical_category_risk_score",
    "technical_category_risk_available",
    "technical_category_activity_score",
    "technical_category_activity_available",
)

# 方向分的顶层权重; ATR/BOLL 只参与独立风险分, 活跃度并入量价分.
_DIRECTION_WEIGHTS = {
    "trend": 0.35,
    "momentum": 0.30,
    "volume_price": 0.25,
    "state_confirmation": 0.10,
}

# v3 分类评分权重。旧 _DIRECTION_WEIGHTS 保留给兼容字段, 避免改变已有
# technical_direction_score 的历史语义; ETF 页面消费 category_* 字段。
_CATEGORY_DIRECTION_WEIGHTS = {
    "trend": 0.35,
    "momentum": 0.30,
    "volume_price": 0.20,
    "price_position": 0.15,
}

_CATEGORY_INDICATOR_WEIGHTS = {
    "trend": {
        "ma_alignment": 0.45,
        "ma_slope": 0.35,
        "trend_persistence": 0.20,
    },
    "momentum": {
        "macd": 0.35,
        "roc": 0.30,
        "rsi": 0.20,
        "kdj": 0.15,
    },
    "volume_price": {
        "price_volume": 0.40,
        "volume_consistency": 0.30,
        "vwma_support": 0.30,
    },
    "price_position": {
        "range_position_20": 0.35,
        "range_position_60": 0.30,
        "boll_position": 0.20,
        "ma20_atr_position": 0.15,
    },
    "volatility_risk": {
        "atr_relative": 0.30,
        "realized_volatility": 0.25,
        "boll_width_relative": 0.20,
        "ma20_deviation_risk": 0.15,
        "rolling_drawdown": 0.10,
    },
    "activity": {
        "amount_ratio_20": 0.40,
        "amount_ma5_ma20": 0.30,
        "volume_ratio_5": 0.20,
        "trade_continuity": 0.10,
    },
}

_CATEGORY_META = {
    "trend": {"name": "趋势", "kind": "direction", "weight": 0.35},
    "momentum": {"name": "动能", "kind": "direction", "weight": 0.30},
    "volume_price": {"name": "量价确认", "kind": "direction", "weight": 0.20},
    "price_position": {"name": "位置强度", "kind": "direction", "weight": 0.15},
    "volatility_risk": {"name": "波动与过热风险", "kind": "risk", "weight": None},
    "activity": {"name": "成交活跃度", "kind": "activity", "weight": None},
}

_REQUIRED_INDICATORS = {
    "ma5", "ma10", "ma20", "ma60", "ma120",
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


def _median(values: Iterable[float]) -> float | None:
    ordered = sorted(value for value in values if math.isfinite(value))
    if not ordered:
        return None
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2.0


def _round_value(value: object) -> float | int | None:
    number = _number(value)
    if number is None:
        return None
    return round(number, 6)


def _raw_values(**values: object) -> dict[str, float | int | None]:
    return {key: _round_value(value) for key, value in values.items()}


def _score_status(score: float | None, *, high: str = "偏强", low: str = "偏弱") -> str:
    if score is None:
        return "数据不足"
    if score >= 60:
        return high
    if score <= 40:
        return low
    return "中性"


_MA_ALIGNMENT_TOLERANCE = 0.005
_MA_FLAT_TOLERANCE = 0.002
_MA_ALIGNMENT_STATE_SCORES = {
    "强多头排列": 100.0,
    "多头排列": 80.0,
    "多头回调": 65.0,
    "均线收敛/缠绕": 50.0,
    "空头反弹": 35.0,
    "空头排列": 20.0,
    "强空头排列": 0.0,
    "底部转强": 70.0,
    "顶部转弱": 30.0,
}
_MA_ALIGNMENT_STATE_MEANINGS = {
    "强多头排列": "短中长期均线全部向上, 趋势最强",
    "多头排列": "中短期上涨趋势明确, 长期趋势尚未完全转多",
    "多头回调": "大趋势仍偏多, 短期正在调整",
    "均线收敛/缠绕": "趋势不明确, 处于震荡或方向选择阶段",
    "空头反弹": "大趋势仍偏空, 短期出现反弹",
    "空头排列": "中短期下跌趋势明确, 长期趋势尚未完全转空",
    "强空头排列": "短中长期均线全部向下, 趋势最弱",
    "底部转强": "下跌后的早期转强阶段, 短期均线开始上穿",
    "顶部转弱": "上涨后的早期转弱阶段, 短期均线开始下穿",
}

_MA_SLOPE_FIELDS = ("ma5", "ma20", "ma60")
_MA_SLOPE_STATE_SCORES = {
    "强上升": 100.0,
    "上升": 80.0,
    "走平": 50.0,
    "下降": 20.0,
    "强下降": 0.0,
    "上升减速": 65.0,
    "下降减速": 35.0,
    "由平转升": 70.0,
    "由平转降": 30.0,
}
_MA_SLOPE_STATE_MEANINGS = {
    "强上升": ("↑↑", "上行幅度较大"),
    "上升": ("↑", "正常上行"),
    "走平": ("→", "方向不明确"),
    "下降": ("↓", "正常下行"),
    "强下降": ("↓↓", "下行幅度较大"),
    "上升减速": ("↗→", "仍为正向, 但斜率趋平"),
    "下降减速": ("↘→", "仍为负向, 但跌势收窄"),
    "由平转升": ("→↗", "从横盘开始转强"),
    "由平转降": ("→↘", "从横盘开始转弱"),
}
_MA_SLOPE_FLAT_TOLERANCE = 0.0005
_MA_SLOPE_STRONG_TOLERANCE = 0.002
_MA_SLOPE_CHANGE_TOLERANCE = 0.0002


def _relative_close(left: float, right: float, tolerance: float = _MA_ALIGNMENT_TOLERANCE) -> bool:
    scale = max(abs(left), abs(right), 1e-12)
    return abs(left - right) / scale <= tolerance


def _strict_order(values: Iterable[float], *, ascending: bool) -> bool:
    ordered = list(values)
    if len(ordered) < 2:
        return False
    pairs = pairwise(ordered)
    if ascending:
        return all(left < right and not _relative_close(left, right) for left, right in pairs)
    return all(left > right and not _relative_close(left, right) for left, right in pairs)


def _ma_converged(values: Iterable[float]) -> bool:
    ordered = list(values)
    if len(ordered) < 2:
        return False
    center = _median(ordered)
    return center is not None and max(abs(value - center) for value in ordered) / max(abs(center), 1e-12) <= _MA_ALIGNMENT_TOLERANCE


def _ma20_is_flat(records: list[dict], index: int) -> bool:
    if index < 1:
        return False
    current = _number(records[index].get("ma20"))
    previous = _number(records[index - 1].get("ma20"))
    if current is None or previous is None or previous == 0:
        return False
    return abs(current / previous - 1.0) <= _MA_FLAT_TOLERANCE


def _ma_alignment_state(records: list[dict], index: int) -> tuple[float | None, str, str]:
    row = records[index]
    values = {
        key: _number(row.get(key))
        for key in ("ma5", "ma10", "ma20", "ma60", "ma120")
    }
    if any(value is None or value <= 0 for value in values.values()):
        return None, "数据不足", "需要 MA5/10/20/60/MA120 才能识别均线状态"

    ma5 = values["ma5"]
    ma10 = values["ma10"]
    ma20 = values["ma20"]
    ma60 = values["ma60"]
    ma120 = values["ma120"]
    short_bull = _strict_order((ma5, ma10, ma20, ma60), ascending=False)
    short_bear = _strict_order((ma5, ma10, ma20, ma60), ascending=True)
    full_bull = short_bull and ma60 > ma120 and not _relative_close(ma60, ma120)
    full_bear = short_bear and ma60 < ma120 and not _relative_close(ma60, ma120)
    long_bull = ma20 > ma60 and not _relative_close(ma20, ma60) and ma60 > ma120 and not _relative_close(ma60, ma120)
    long_bear = ma20 < ma60 and not _relative_close(ma20, ma60) and ma60 < ma120 and not _relative_close(ma60, ma120)

    previous = records[index - 1] if index > 0 else {}
    previous_ma5 = _number(previous.get("ma5"))
    previous_ma10 = _number(previous.get("ma10"))
    previous_ma20 = _number(previous.get("ma20"))
    crossed_up = (
        ma5 > ma10 and ma5 > ma20
        and previous_ma5 is not None
        and previous_ma10 is not None
        and previous_ma20 is not None
        and (previous_ma5 <= previous_ma10 or previous_ma5 <= previous_ma20)
    )
    crossed_down = (
        ma5 < ma10 and ma5 < ma20
        and previous_ma5 is not None
        and previous_ma10 is not None
        and previous_ma20 is not None
        and (previous_ma5 >= previous_ma10 or previous_ma5 >= previous_ma20)
    )

    if full_bull:
        state = "强多头排列"
        rule = "MA5 > MA10 > MA20 > MA60 > MA120"
    elif full_bear:
        state = "强空头排列"
        rule = "MA5 < MA10 < MA20 < MA60 < MA120"
    elif crossed_up and ma20 < ma60 and ma20 < ma120 and _ma20_is_flat(records, index):
        state = "底部转强"
        rule = "MA5上穿MA10/MA20; MA20走平; MA20仍低于MA60/MA120"
    elif crossed_down and ma20 > ma60 and ma20 > ma120 and _ma20_is_flat(records, index):
        state = "顶部转弱"
        rule = "MA5下穿MA10/MA20; MA20走平; MA20仍高于MA60/MA120"
    elif short_bull:
        state = "多头排列"
        rule = "MA5 > MA10 > MA20 > MA60; MA120尚未完全跟随"
    elif short_bear:
        state = "空头排列"
        rule = "MA5 < MA10 < MA20 < MA60; MA120尚未完全转空"
    elif long_bull and ma5 < ma10 and ma5 < ma20:
        state = "多头回调"
        rule = "MA5低于MA10/MA20; MA20 > MA60 > MA120"
    elif long_bear and ma5 > ma10 and ma5 > ma20:
        state = "空头反弹"
        rule = "MA5高于MA10/MA20; MA20 < MA60 < MA120"
    elif _ma_converged((ma5, ma10, ma20)) or _ma_converged((ma5, ma10, ma20, ma60, ma120)):
        state = "均线收敛/缠绕"
        rule = "MA5/10/20相对价差约<=0.5%; 趋势尚未明确"
    elif long_bull:
        state = "多头回调"
        rule = "长期均线仍为MA20 > MA60 > MA120; 短期排列未完成"
    elif long_bear:
        state = "空头反弹"
        rule = "长期均线仍为MA20 < MA60 < MA120; 短期排列未完成"
    else:
        state = "均线收敛/缠绕"
        rule = "长短周期顺序混合; 未形成明确多空趋势"
    return _MA_ALIGNMENT_STATE_SCORES[state], state, rule


def _relative_change(current: float | None, previous: float | None) -> float | None:
    if current is None or previous is None or previous <= 0:
        return None
    return current / previous - 1.0


def _ma_slope_base_state(slope: float) -> str:
    if slope >= _MA_SLOPE_STRONG_TOLERANCE:
        return "强上升"
    if slope > _MA_SLOPE_FLAT_TOLERANCE:
        return "上升"
    if slope <= -_MA_SLOPE_STRONG_TOLERANCE:
        return "强下降"
    if slope < -_MA_SLOPE_FLAT_TOLERANCE:
        return "下降"
    return "走平"


def _ma_slope_state(
    records: list[dict],
    index: int,
    field: str,
) -> tuple[float | None, str, float | None, float | None]:
    """返回单条均线的评分、状态、当前斜率和上一段斜率.

    斜率用均线相对上一周期的变化率表示, 避免不同价格区间的 ETF 直接比较绝对价差.
    只有在当前斜率仍保持原方向、但相对上一段明显变弱时才标为减速;
    从走平跨入正/负方向则标为早期转强/转弱.
    """
    current = _number(records[index].get(field))
    previous = _number(records[index - 1].get(field)) if index > 0 else None
    slope = _relative_change(current, previous)
    if slope is None:
        return None, "数据不足", None, None

    previous_slope = None
    if index > 1:
        previous_previous = _number(records[index - 2].get(field))
        previous_slope = _relative_change(previous, previous_previous)

    state = _ma_slope_base_state(slope)
    if previous_slope is not None:
        if (
            previous_slope > _MA_SLOPE_FLAT_TOLERANCE
            and slope >= -_MA_SLOPE_FLAT_TOLERANCE
            and previous_slope - slope > _MA_SLOPE_CHANGE_TOLERANCE
        ):
            state = "上升减速"
        elif (
            previous_slope < -_MA_SLOPE_FLAT_TOLERANCE
            and slope <= _MA_SLOPE_FLAT_TOLERANCE
            and slope - previous_slope > _MA_SLOPE_CHANGE_TOLERANCE
        ):
            state = "下降减速"
        elif (
            abs(previous_slope) <= _MA_SLOPE_FLAT_TOLERANCE
            and slope > _MA_SLOPE_FLAT_TOLERANCE
            and slope - previous_slope > _MA_SLOPE_CHANGE_TOLERANCE
        ):
            state = "由平转升"
        elif (
            abs(previous_slope) <= _MA_SLOPE_FLAT_TOLERANCE
            and slope < -_MA_SLOPE_FLAT_TOLERANCE
            and previous_slope - slope > _MA_SLOPE_CHANGE_TOLERANCE
        ):
            state = "由平转降"

    return _MA_SLOPE_STATE_SCORES[state], state, slope, previous_slope


def _ma_slope_components(records: list[dict], index: int) -> dict[str, tuple[float | None, str, float | None, float | None]]:
    return {
        field: _ma_slope_state(records, index, field)
        for field in _MA_SLOPE_FIELDS
    }


def _ma_slope_summary(records: list[dict], index: int) -> tuple[float | None, float, str]:
    parts: list[tuple[float | None, float]] = []
    states: list[str] = []
    for field, (score, state, _, _) in _ma_slope_components(records, index).items():
        parts.append((score, 1.0))
        if score is not None:
            states.append(f"{field.upper()}{state}")
    score, coverage = _weighted_mean(parts)
    return score, coverage, " · ".join(states) if states else "数据不足"


def _weighted_category(category_id: str, indicators: list[dict]) -> dict:
    expected = sum(float(item["weight"]) for item in indicators)
    available = [item for item in indicators if item.get("score") is not None]
    available_weight = sum(float(item["weight"]) for item in available)
    coverage = available_weight / expected if expected > 0 else 0.0
    score = (
        sum(float(item["score"]) * float(item["weight"]) for item in available) / available_weight
        if available_weight > 0 else None
    )
    category_available = score is not None and coverage >= 0.60
    meta = _CATEGORY_META[category_id]
    return {
        "id": category_id,
        "name": meta["name"],
        "kind": meta["kind"],
        "weight": meta["weight"],
        "score": round(score) if category_available and score is not None else None,
        "coverage": round(coverage * 100.0),
        "available": category_available,
        "indicators": indicators,
    }


def _history_relative_score(
    current: float | None,
    history: Iterable[float | None],
    *,
    minimum: int = 20,
) -> tuple[float | None, float | None]:
    values = [value for value in history if value is not None and math.isfinite(value) and value >= 0]
    baseline = _median(values) if len(values) >= minimum else None
    if current is None or baseline is None or baseline <= 0:
        return None, None
    relative = current / baseline
    return _relative_level_score(relative), relative


def _atr_pct(records: list[dict], index: int) -> float | None:
    close = _number(records[index].get("close"))
    atr = _number(records[index].get("atr_14"))
    return atr / close if atr is not None and close is not None and close > 0 else None


def _boll_width(records: list[dict], index: int) -> float | None:
    row = records[index]
    upper = _number(row.get("boll_upper"))
    lower = _number(row.get("boll_lower"))
    middle = _number(row.get("ma20"))
    return ((upper - lower) / middle
            if upper is not None and lower is not None and middle is not None and middle > 0 else None)


def _realized_volatility(records: list[dict], index: int, window: int = 20) -> float | None:
    if index < window:
        return None
    returns: list[float] = []
    for position in range(index - window + 1, index + 1):
        current = _number(records[position].get("close"))
        previous = _number(records[position - 1].get("close"))
        if current is None or previous is None or previous <= 0:
            return None
        returns.append(current / previous - 1.0)
    if len(returns) < window:
        return None
    average = sum(returns) / len(returns)
    return math.sqrt(sum((value - average) ** 2 for value in returns) / len(returns))


def _vwma(records: list[dict], index: int, window: int) -> float | None:
    if index < window - 1:
        return None
    closes: list[float] = []
    volumes: list[float] = []
    for row in records[index - window + 1:index + 1]:
        close = _number(row.get("close"))
        volume = _number(row.get("volume"))
        if close is None or volume is None or close <= 0 or volume < 0:
            return None
        closes.append(close)
        volumes.append(volume)
    total_volume = sum(volumes)
    return sum(close * volume for close, volume in zip(closes, volumes, strict=True)) / total_volume if total_volume > 0 else None


def _range_position(records: list[dict], index: int, window: int) -> float | None:
    if index < window - 1:
        return None
    highs = [_number(row.get("high")) for row in records[index - window + 1:index + 1]]
    lows = [_number(row.get("low")) for row in records[index - window + 1:index + 1]]
    close = _number(records[index].get("close"))
    if close is None or any(value is None for value in (*highs, *lows)):
        return None
    low = min(value for value in lows if value is not None)
    high = max(value for value in highs if value is not None)
    return _clamp((close - low) / (high - low) * 100.0) if high > low else 50.0


def _boll_position(records: list[dict], index: int) -> float | None:
    row = records[index]
    close = _number(row.get("close"))
    upper = _number(row.get("boll_upper"))
    lower = _number(row.get("boll_lower"))
    if close is None or upper is None or lower is None or upper <= lower:
        return None
    return _clamp((close - lower) / (upper - lower) * 100.0)


def _ma20_atr_position(records: list[dict], index: int) -> float | None:
    row = records[index]
    close = _number(row.get("close"))
    ma20 = _number(row.get("ma20"))
    atr = _number(row.get("atr_14"))
    if close is None or ma20 is None or atr is None or atr <= 0:
        return None
    return _clamp(50.0 + 50.0 * math.tanh((close - ma20) / (2.0 * atr)))


def _category_scores(records: list[dict], index: int) -> dict:
    row = records[index]
    previous = records[index - 1] if index > 0 else {}

    alignment_score, alignment_status, _ = _ma_alignment_state(records, index)
    alignment_meaning = _MA_ALIGNMENT_STATE_MEANINGS.get(alignment_status, "数据不足")

    slope_components = _ma_slope_components(records, index)
    slope_score, _ = _weighted_mean([(component[0], 1.0) for component in slope_components.values()])
    slope_meaning = "\n".join(
        f"{field.upper()} {component[1]} {_MA_SLOPE_STATE_MEANINGS[component[1]][0]}: {_MA_SLOPE_STATE_MEANINGS[component[1]][1]}"
        for field, component in slope_components.items()
        if component[0] is not None
    ) or "数据不足"
    slope_status = _score_status(slope_score)

    persistence_values = []
    for position in range(max(0, index - 4), index + 1):
        close = _number(records[position].get("close"))
        ma20 = _number(records[position].get("ma20"))
        if close is not None and ma20 is not None:
            persistence_values.append(_sign_score(close - ma20))
    persistence = sum(persistence_values) / len(persistence_values) if len(persistence_values) >= 3 else None

    trend_indicators = [
        {
            "id": "ma_alignment", "name": "均线排列", "score": round(alignment_score) if alignment_score is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["trend"]["ma_alignment"],
            "status": alignment_status,
            "detail": f"比较价格、MA5/10/20/60/120 的相对排列\n{alignment_meaning}",
            "raw_values": _raw_values(close=row.get("close"), ma5=row.get("ma5"), ma10=row.get("ma10"), ma20=row.get("ma20"), ma60=row.get("ma60"), ma120=row.get("ma120")),
        },
        {
            "id": "ma_slope", "name": "均线斜率", "score": round(slope_score) if slope_score is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["trend"]["ma_slope"],
            "status": slope_status,
            "detail": f"分别识别 MA5/20/60 的方向、力度与拐点状态\n{slope_meaning}",
            "raw_values": _raw_values(
                ma5=row.get("ma5"),
                ma20=row.get("ma20"),
                ma60=row.get("ma60"),
                previous_ma5=previous.get("ma5"),
                previous_ma20=previous.get("ma20"),
                previous_ma60=previous.get("ma60"),
                ma5_slope_pct=slope_components["ma5"][2],
                ma20_slope_pct=slope_components["ma20"][2],
                ma60_slope_pct=slope_components["ma60"][2],
                previous_ma5_slope_pct=slope_components["ma5"][3],
                previous_ma20_slope_pct=slope_components["ma20"][3],
                previous_ma60_slope_pct=slope_components["ma60"][3],
            ),
        },
        {
            "id": "trend_persistence", "name": "趋势持续性", "score": round(persistence) if persistence is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["trend"]["trend_persistence"],
            "status": _score_status(persistence),
            "detail": "统计最近5周期收盘价相对 MA20 的状态",
            "raw_values": _raw_values(above_count=sum(value >= 50 for value in persistence_values), sample_count=len(persistence_values)),
        },
    ]

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
    momentum_indicators = [
        {
            "id": "macd", "name": "MACD动能", "score": round(macd[0]) if macd[0] is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["momentum"]["macd"],
            "status": _score_status(macd[0]),
            "detail": "DIF/DEA、零轴位置和柱体变化共同评分",
            "raw_values": _raw_values(dif=dif, dea=dea, hist=hist, previous_hist=previous_hist),
        },
        {
            "id": "roc", "name": "多周期ROC", "score": round(roc[0]) if roc[0] is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["momentum"]["roc"],
            "status": _score_status(roc[0]),
            "detail": "综合5/20/60周期收益方向",
            "raw_values": _raw_values(momentum_5=row.get("momentum_5d"), momentum_20=row.get("momentum_20d"), momentum_60=row.get("momentum_60d")),
        },
        {
            "id": "rsi", "name": "RSI14", "score": round(rsi) if rsi is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["momentum"]["rsi"],
            "status": _score_status(rsi),
            "detail": "RSI14 以50为中性, 保留超买超卖状态信息",
            "raw_values": _raw_values(rsi14=rsi_value),
        },
        {
            "id": "kdj", "name": "KDJ", "score": round(kdj[0]) if kdj[0] is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["momentum"]["kdj"],
            "status": _score_status(kdj[0]),
            "detail": "K/D关系与K值共同评分",
            "raw_values": _raw_values(k=k, d=d, j=row.get("kdj_j")),
        },
    ]

    change = _change_pct(records, index)
    ratio = _volume_ratio(records, index)
    price_volume = None
    if change is not None and ratio is not None:
        if abs(change) < 1e-12:
            price_volume = 50.0
        else:
            conviction = _clamp(ratio / 2.0, 0.25, 1.0)
            price_volume = _clamp(50.0 + 50.0 * (1.0 if change > 0 else -1.0) * conviction)

    consistency_values: list[float] = []
    for position in range(max(1, index - 2), index + 1):
        current_close = _number(records[position].get("close"))
        prior_close = _number(records[position - 1].get("close"))
        current_volume = _number(records[position].get("volume"))
        prior_volume = _number(records[position - 1].get("volume"))
        if None in (current_close, prior_close, current_volume, prior_volume) or prior_close <= 0:
            continue
        price_change = current_close / prior_close - 1.0
        volume_change = current_volume - prior_volume
        if abs(price_change) < 1e-12:
            consistency_values.append(50.0)
        elif price_change > 0 and volume_change > 0:
            consistency_values.append(100.0)
        elif price_change < 0 and volume_change > 0:
            consistency_values.append(0.0)
        elif price_change > 0:
            consistency_values.append(65.0)
        else:
            consistency_values.append(35.0)
    volume_consistency = sum(consistency_values) / len(consistency_values) if consistency_values else None

    vwma5 = _vwma(records, index, 5)
    vwma20 = _vwma(records, index, 20)
    close = _number(row.get("close"))
    vwma_support_parts = [
        _sign_score(close - vwma5) if close is not None and vwma5 is not None else None,
        _sign_score(close - vwma20) if close is not None and vwma20 is not None else None,
    ]
    vwma_support = _weighted_mean([(value, 1.0) for value in vwma_support_parts])
    volume_price_indicators = [
        {
            "id": "price_volume", "name": "当前价量共振", "score": round(price_volume) if price_volume is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["volume_price"]["price_volume"],
            "status": _score_status(price_volume),
            "detail": "当前价格方向结合当前量比, 判断价量是否同步",
            "raw_values": _raw_values(change_pct=change, volume_ratio=ratio),
        },
        {
            "id": "volume_consistency", "name": "近3周期量价一致性", "score": round(volume_consistency) if volume_consistency is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["volume_price"]["volume_consistency"],
            "status": _score_status(volume_consistency),
            "detail": "逐周期比较价格变化与成交量变化",
            "raw_values": _raw_values(sample_count=len(consistency_values)),
        },
        {
            "id": "vwma_support", "name": "VWMA支撑关系", "score": round(vwma_support[0]) if vwma_support[0] is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["volume_price"]["vwma_support"],
            "status": _score_status(vwma_support[0]),
            "detail": "比较收盘价与5/20周期成交量加权均价",
            "raw_values": _raw_values(close=close, vwma5=vwma5, vwma20=vwma20),
        },
    ]

    range20 = _range_position(records, index, 20)
    range60 = _range_position(records, index, 60)
    boll_position = _boll_position(records, index)
    ma20_atr_position = _ma20_atr_position(records, index)
    position_indicators = [
        {
            "id": "range_position_20", "name": "20周期区间位置", "score": round(range20) if range20 is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["price_position"]["range_position_20"],
            "status": _score_status(range20, high="高位运行", low="低位运行"),
            "detail": "当前收盘价在最近20周期高低区间中的位置",
            "raw_values": _raw_values(position=range20),
        },
        {
            "id": "range_position_60", "name": "60周期区间位置", "score": round(range60) if range60 is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["price_position"]["range_position_60"],
            "status": _score_status(range60, high="高位运行", low="低位运行"),
            "detail": "当前收盘价在最近60周期高低区间中的位置",
            "raw_values": _raw_values(position=range60),
        },
        {
            "id": "boll_position", "name": "BOLL通道位置", "score": round(boll_position) if boll_position is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["price_position"]["boll_position"],
            "status": _score_status(boll_position),
            "detail": "当前收盘价在BOLL上下轨之间的位置",
            "raw_values": _raw_values(close=close, upper=row.get("boll_upper"), lower=row.get("boll_lower"), position=boll_position),
        },
        {
            "id": "ma20_atr_position", "name": "MA20/ATR位置", "score": round(ma20_atr_position) if ma20_atr_position is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["price_position"]["ma20_atr_position"],
            "status": _score_status(ma20_atr_position),
            "detail": "价格相对MA20的偏离按ATR归一化",
            "raw_values": _raw_values(close=close, ma20=row.get("ma20"), atr14=row.get("atr_14"), position=ma20_atr_position),
        },
    ]

    current_atr_pct = _atr_pct(records, index)
    atr_risk, atr_relative = _history_relative_score(
        current_atr_pct, [_atr_pct(records, position) for position in range(max(0, index - 20), index)]
    )
    current_realized_vol = _realized_volatility(records, index)
    realized_vol_risk, realized_vol_relative = _history_relative_score(
        current_realized_vol, [_realized_volatility(records, position) for position in range(max(0, index - 20), index)]
    )
    current_boll_width = _boll_width(records, index)
    boll_width_risk, boll_width_relative = _history_relative_score(
        current_boll_width, [_boll_width(records, position) for position in range(max(0, index - 20), index)]
    )
    atr = _number(row.get("atr_14"))
    ma20 = _number(row.get("ma20"))
    ma20_deviation = abs(close - ma20) / atr if close is not None and ma20 is not None and atr is not None and atr > 0 else None
    ma20_deviation_risk = _clamp(ma20_deviation / 3.0 * 100.0) if ma20_deviation is not None else None
    recent_highs = [_number(item.get("high")) for item in records[max(0, index - 19):index + 1]]
    peak = max((value for value in recent_highs if value is not None), default=None)
    drawdown = (max(0.0, (peak - close) / peak) if peak is not None and close is not None and peak > 0 else None)
    drawdown_risk = _clamp(drawdown * 1000.0) if drawdown is not None else None
    risk_indicators = [
        {
            "id": "atr_relative", "name": "ATR/价格相对历史", "score": round(atr_risk) if atr_risk is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["volatility_risk"]["atr_relative"],
            "status": _score_status(atr_risk, high="波动放大", low="波动收敛"),
            "detail": "ATR/价格相对此前20周期中位数",
            "raw_values": _raw_values(atr14=atr, atr_pct=current_atr_pct, relative=atr_relative),
        },
        {
            "id": "realized_volatility", "name": "20周期实现波动率", "score": round(realized_vol_risk) if realized_vol_risk is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["volatility_risk"]["realized_volatility"],
            "status": _score_status(realized_vol_risk, high="波动放大", low="波动收敛"),
            "detail": "20周期收益波动相对此前20个波动观测值中位数",
            "raw_values": _raw_values(value=current_realized_vol, relative=realized_vol_relative),
        },
        {
            "id": "boll_width_relative", "name": "BOLL带宽相对历史", "score": round(boll_width_risk) if boll_width_risk is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["volatility_risk"]["boll_width_relative"],
            "status": _score_status(boll_width_risk, high="带宽扩张", low="带宽收缩"),
            "detail": "BOLL带宽相对此前20周期中位数",
            "raw_values": _raw_values(boll_width=current_boll_width, relative=boll_width_relative),
        },
        {
            "id": "ma20_deviation_risk", "name": "MA20偏离风险", "score": round(ma20_deviation_risk) if ma20_deviation_risk is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["volatility_risk"]["ma20_deviation_risk"],
            "status": _score_status(ma20_deviation_risk, high="偏离较大", low="偏离较小"),
            "detail": "价格偏离MA20的幅度按ATR倍数计量",
            "raw_values": _raw_values(deviation_atr=ma20_deviation),
        },
        {
            "id": "rolling_drawdown", "name": "20周期滚动回撤", "score": round(drawdown_risk) if drawdown_risk is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["volatility_risk"]["rolling_drawdown"],
            "status": _score_status(drawdown_risk, high="回撤较大", low="回撤较小"),
            "detail": "当前收盘价相对最近20周期高点的回撤风险",
            "raw_values": _raw_values(drawdown_pct=drawdown),
        },
    ]

    amount = _number(row.get("amount"))
    previous_amounts = [_number(item.get("amount")) for item in records[max(0, index - 20):index]]
    amount_history = [value for value in previous_amounts if value is not None and value > 0]
    amount_average = sum(amount_history) / len(amount_history) if len(amount_history) >= 20 else None
    amount_ratio = amount / amount_average if amount is not None and amount > 0 and amount_average and amount_average > 0 else None
    amount_ratio_score = _activity_level_score(amount_ratio)
    amount_values_5 = [_number(item.get("amount")) for item in records[max(0, index - 4):index + 1]]
    amount_values_20 = [_number(item.get("amount")) for item in records[max(0, index - 19):index + 1]]
    amount_ma5 = sum(value for value in amount_values_5 if value is not None) / len(amount_values_5) if len(amount_values_5) == 5 and all(value is not None for value in amount_values_5) else None
    amount_ma20 = sum(value for value in amount_values_20 if value is not None) / len(amount_values_20) if len(amount_values_20) == 20 and all(value is not None for value in amount_values_20) else None
    amount_ma_ratio = amount_ma5 / amount_ma20 if amount_ma5 is not None and amount_ma20 is not None and amount_ma20 > 0 else None
    amount_ma_score = _activity_level_score(amount_ma_ratio)
    volume_ratio_score = _activity_level_score(ratio)
    continuity_values = [_number(item.get("volume")) for item in records[max(0, index - 19):index + 1]]
    continuity_score = (
        sum(value > 0 for value in continuity_values) / len(continuity_values) * 100.0
        if len(continuity_values) == 20 and all(value is not None for value in continuity_values) else None
    )
    activity_indicators = [
        {
            "id": "amount_ratio_20", "name": "成交额/前20周期均额", "score": round(amount_ratio_score) if amount_ratio_score is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["activity"]["amount_ratio_20"],
            "status": _score_status(amount_ratio_score, high="成交放大", low="成交收缩"),
            "detail": "当前成交额相对前20周期平均成交额",
            "raw_values": _raw_values(amount=amount, average_amount=amount_average, ratio=amount_ratio),
        },
        {
            "id": "amount_ma5_ma20", "name": "成交额MA5/MA20", "score": round(amount_ma_score) if amount_ma_score is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["activity"]["amount_ma5_ma20"],
            "status": _score_status(amount_ma_score, high="短期活跃", low="短期降温"),
            "detail": "成交额短期均值相对20周期均值",
            "raw_values": _raw_values(amount_ma5=amount_ma5, amount_ma20=amount_ma20, ratio=amount_ma_ratio),
        },
        {
            "id": "volume_ratio_5", "name": "成交量量比", "score": round(volume_ratio_score) if volume_ratio_score is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["activity"]["volume_ratio_5"],
            "status": _score_status(volume_ratio_score, high="量能放大", low="量能收缩"),
            "detail": "当前成交量相对前5周期均量",
            "raw_values": _raw_values(volume_ratio=ratio),
        },
        {
            "id": "trade_continuity", "name": "非零成交连续性", "score": round(continuity_score) if continuity_score is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["activity"]["trade_continuity"],
            "status": _score_status(continuity_score, high="成交连续", low="成交间断"),
            "detail": "最近20周期中有实际成交的周期占比",
            "raw_values": _raw_values(nonzero_count=sum(value > 0 for value in continuity_values if value is not None), sample_count=len(continuity_values)),
        },
    ]

    categories = [
        _weighted_category("trend", trend_indicators),
        _weighted_category("momentum", momentum_indicators),
        _weighted_category("volume_price", volume_price_indicators),
        _weighted_category("price_position", position_indicators),
        _weighted_category("volatility_risk", risk_indicators),
        _weighted_category("activity", activity_indicators),
    ]
    by_id = {category["id"]: category for category in categories}
    direction_coverage = sum(
        _CATEGORY_DIRECTION_WEIGHTS[category_id] * by_id[category_id]["coverage"] / 100.0
        for category_id in _CATEGORY_DIRECTION_WEIGHTS
    )
    direction_parts = [
        (by_id[category_id]["score"], weight, by_id[category_id]["coverage"] / 100.0)
        for category_id, weight in _CATEGORY_DIRECTION_WEIGHTS.items()
    ]
    direction_score, _ = _weighted_score(direction_parts)
    direction_available = (
        sum(by_id[category_id]["available"] for category_id in _CATEGORY_DIRECTION_WEIGHTS) >= 3
        and direction_coverage >= 0.70
        and direction_score is not None
    )
    risk_category = by_id["volatility_risk"]
    activity_category = by_id["activity"]
    return {
        "categories": categories,
        "direction_score": round(direction_score) if direction_available and direction_score is not None else None,
        "direction_coverage": round(direction_coverage * 100.0),
        "direction_available": direction_available,
        "risk_score": risk_category["score"],
        "risk_available": risk_category["available"],
        "activity_score": activity_category["score"],
        "activity_available": activity_category["available"],
    }


def _score_records(records: list[dict]) -> list[dict[str, float | bool | None]]:
    result: list[dict[str, float | bool | None]] = []
    for index in range(len(records)):
        trend, trend_coverage = _trend_score(records, index)
        momentum, momentum_coverage = _momentum_score(records, index)
        volume_price, volume_price_coverage = _volume_price_score(records, index)
        state_confirmation, state_coverage = _state_confirmation_score((trend, momentum, volume_price))
        volatility = _volatility_risk(records, index)
        activity = _activity_score(records, index)
        category_scores = _category_scores(records, index)

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
            "technical_category_direction_score": category_scores["direction_score"],
            "technical_category_direction_coverage": category_scores["direction_coverage"],
            "technical_category_direction_available": category_scores["direction_available"],
            "technical_category_risk_score": category_scores["risk_score"],
            "technical_category_risk_available": category_scores["risk_available"],
            "technical_category_activity_score": category_scores["activity_score"],
            "technical_category_activity_available": category_scores["activity_available"],
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
        pl.Series(name="technical_category_direction_score", values=[], dtype=pl.Int64),
        pl.Series(name="technical_category_direction_coverage", values=[], dtype=pl.Int64),
        pl.Series(name="technical_category_direction_available", values=[], dtype=pl.Boolean),
        pl.Series(name="technical_category_risk_score", values=[], dtype=pl.Int64),
        pl.Series(name="technical_category_risk_available", values=[], dtype=pl.Boolean),
        pl.Series(name="technical_category_activity_score", values=[], dtype=pl.Int64),
        pl.Series(name="technical_category_activity_available", values=[], dtype=pl.Boolean),
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
    category_rows: list[dict] = []
    groups = frame.partition_by("symbol", maintain_order=True) if "symbol" in frame.columns else [frame]
    for group in groups:
        records = group.to_dicts()
        category_rows.extend(_category_scores(records, index) for index in range(len(records)))
    rows = []
    for index, row in enumerate(frame.select(["date", *TECHNICAL_SCORE_COLUMNS]).to_dicts()):
        category_scores = category_rows[index]
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
            "category_direction_score": row.pop("technical_category_direction_score"),
            "category_direction_coverage": row.pop("technical_category_direction_coverage"),
            "direction_available": row.pop("technical_category_direction_available"),
            "category_risk_score": row.pop("technical_category_risk_score"),
            "risk_available": row.pop("technical_category_risk_available"),
            "category_activity_score": row.pop("technical_category_activity_score"),
            "activity_available": row.pop("technical_category_activity_available"),
            "categories": category_scores["categories"],
        })
    return {"version": TECHNICAL_SCORE_VERSION, "rows": rows}
