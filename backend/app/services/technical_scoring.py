"""统一技术指标评分.

评分是对单根 K 线当时可见信息的结构化摘要, 不是交易信号, 也不替换策略
引擎的截面评分. 模块只生成运行时列, 不修改持久化数据.

评分只使用已有图表指标: MA, MACD, RSI, KDJ, momentum/ROC, 量比,
ATR, BOLL 和 K 线成交额. 旧版顶层字段保持兼容; v3 另外输出 ETF 优先的
类别/子指标评分, 方向、波动风险和成交活跃度彼此独立.
"""
from __future__ import annotations

import math
from bisect import bisect_left, bisect_right
from collections.abc import Iterable
from dataclasses import dataclass
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

# 分类详情只在单次请求的运行时帧中传递, API 返回 K 线 rows 前会移除。
# 这样评分列和详情 payload 共用同一次分类计算, 避免复杂动能分析重复执行。
TECHNICAL_SCORE_INTERNAL_COLUMNS = ("_technical_score_categories",)

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
        "ma_alignment": 0.25,
        "ma_dispersion": 0.15,
        "ma_slope": 0.30,
        "price_vs_ma": 0.20,
        "trend_persistence": 0.10,
    },
    "momentum": {
        "macd": 0.30,
        "rsi": 0.25,
        "roc": 0.25,
        "kdj": 0.20,
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

_MACD_ZERO_BAND_PCT = 0.05
_MACD_ZERO_NEAR_BAND_PCT = _MACD_ZERO_BAND_PCT * 2
_MACD_HIST_FLAT_BAND_PCT = 0.02
_MACD_HIST_CHANGE_FLAT_BAND_PCT = 0.005
_MACD_CROSS_LOOKBACK = 8
_MACD_DIVERGENCE_LOOKBACK = 60
_MACD_DIVERGENCE_HISTORY_LOOKBACK = 240
_MACD_DIVERGENCE_PIVOT_RADIUS = 2
_MACD_DIVERGENCE_PRICE_CHANGE_PCT = 1.0
_MACD_DIVERGENCE_DIF_CHANGE_PCT = 0.05
_MACD_DIVERGENCE_ACTIVE_BARS = 5

_MACD_STATE_LABELS = {
    "STRONG_BULL": "强多",
    "TURNING_BULLISH": "转强",
    "RECOVERY": "修复",
    "RANGE": "震荡",
    "TURNING_BEARISH": "转弱",
    "STRONG_BEAR": "强空",
    "INSUFFICIENT": "数据不足",
}
_MACD_EVENT_LABELS = {
    "GOLDEN_CROSS": "金叉",
    "DEATH_CROSS": "死叉",
    "DIF_CROSS_ZERO_UP": "DIF上穿零轴",
    "DIF_CROSS_ZERO_DOWN": "DIF下穿零轴",
    "DEA_CROSS_ZERO_UP": "DEA上穿零轴",
    "DEA_CROSS_ZERO_DOWN": "DEA下穿零轴",
}
_MACD_ZERO_AXIS_LABELS = {
    "ABOVE": "零轴上方",
    "BELOW": "零轴下方",
    "NEAR": "零轴附近",
    "CROSSING": "跨越零轴",
    "UNKNOWN": "数据不足",
}
_MACD_MOMENTUM_LABELS = {
    "BULL_EXPANDING": "多头动能增强",
    "BULL_SHRINKING": "多头动能衰减",
    "BEAR_EXPANDING": "空头动能增强",
    "BEAR_SHRINKING": "空头动能衰减",
    "FLAT": "柱体方向暂未变化",
    "INSUFFICIENT": "柱体变化样本不足",
}
_MACD_DIVERGENCE_LABELS = {
    "BOTTOM_DIVERGENCE": "底背离",
    "TOP_DIVERGENCE": "顶背离",
}

_RSI_DIRECTION_FLAT_BAND = 0.5
_RSI_ZONE_LOOKBACK = 20
_RSI_ZONE_MIN_SAMPLES = 6
_RSI_FAILURE_SWING_LOOKBACK = 40
_RSI_STAGNATION_MIN_BARS = 3
_RSI_DIVERGENCE_LOOKBACK = 120
_RSI_DIVERGENCE_PIVOT_RADIUS = 2
_RSI_DIVERGENCE_PRICE_CHANGE_PCT = 1.0
_RSI_DIVERGENCE_VALUE_CHANGE = 2.0
_RSI_DIVERGENCE_ACTIVE_BARS = 5

_RSI_STATE_LABELS = {
    "EXTREME_OVERBOUGHT": "极度超买",
    "OVERBOUGHT": "超买",
    "BULLISH": "偏强",
    "NEUTRAL_BULL": "中性偏强",
    "NEUTRAL_BEAR": "中性偏弱",
    "BEARISH": "偏弱",
    "OVERSOLD": "超卖",
    "EXTREME_OVERSOLD": "极度超卖",
    "INSUFFICIENT": "数据不足",
}
_RSI_DIRECTION_LABELS = {
    "RISING": "动能上升",
    "FALLING": "动能下降",
    "FLAT": "动能走平",
    "INSUFFICIENT": "数据不足",
}
_RSI_EVENT_LABELS = {
    "RSI_CROSS_50_UP": "RSI中轴转强",
    "RSI_CROSS_50_DOWN": "RSI中轴转弱",
    "RSI_CROSS_30_UP": "超卖修复",
    "RSI_CROSS_70_DOWN": "超买回落",
}
_RSI_ZONE_LABELS = {
    "STRONG": "强势区间",
    "WEAK": "弱势区间",
    "NORMAL": "常态区间",
    "INSUFFICIENT": "数据不足",
}
_RSI_DIVERGENCE_LABELS = {
    "BOTTOM_DIVERGENCE": "底背离",
    "TOP_DIVERGENCE": "顶背离",
    "HIDDEN_BOTTOM_DIVERGENCE": "隐藏底背离",
    "HIDDEN_TOP_DIVERGENCE": "隐藏顶背离",
}
_RSI_FAILURE_SWING_LABELS = {
    "BULLISH_FAILURE_SWING": "看涨失败摆动",
    "BEARISH_FAILURE_SWING": "看跌失败摆动",
}
_RSI_STAGNATION_LABELS = {
    "HIGH_STAGNATION": "高位钝化",
    "LOW_STAGNATION": "低位钝化",
}

_KDJ_LOW_LEVEL = 20.0
_KDJ_HIGH_LEVEL = 80.0
_KDJ_DIRECTION_FLAT_BAND = 0.5
_KDJ_STAGNATION_MIN_BARS = 3
_KDJ_STATE_LOOKBACK = 20
_KDJ_DIVERGENCE_LOOKBACK = 120
_KDJ_DIVERGENCE_PIVOT_RADIUS = 2
_KDJ_DIVERGENCE_PRICE_CHANGE_PCT = 1.0
_KDJ_DIVERGENCE_J_CHANGE = 3.0
_KDJ_DIVERGENCE_ACTIVE_BARS = 5

_KDJ_STATE_LABELS = {
    "OVERSOLD_REVERSAL": "超卖反转",
    "LOW_GOLDEN_CROSS": "低位金叉",
    "MOMENTUM_STRENGTHENING": "动能转强",
    "WEAK_RECOVERY": "弱势修复",
    "NEUTRAL_OSCILLATION": "中性震荡",
    "HIGH_STRENGTH": "高位强势",
    "HIGH_STAGNATION": "高位钝化",
    "HIGH_DEATH_CROSS": "高位死叉",
    "MOMENTUM_WEAKENING": "动能转弱",
    "LOW_STAGNATION": "低位钝化",
    "OVERBOUGHT": "极度超买",
    "OVERSOLD": "极度超卖",
    "INSUFFICIENT": "数据不足",
}
_KDJ_EVENT_LABELS = {
    "LOW_GOLDEN_CROSS": "低位金叉",
    "MIDDLE_GOLDEN_CROSS": "中位金叉",
    "HIGH_GOLDEN_CROSS": "高位金叉",
    "LOW_DEATH_CROSS": "低位死叉",
    "MIDDLE_DEATH_CROSS": "中位死叉",
    "HIGH_DEATH_CROSS": "高位死叉",
    "J_TURN_UP": "J拐头向上",
    "J_TURN_DOWN": "J拐头向下",
}
_KDJ_ZONE_LABELS = {
    "OVERSOLD": "极度超卖区",
    "MID_LOW": "中低位",
    "MID_HIGH": "中高位",
    "OVERBOUGHT": "极度超买区",
    "INSUFFICIENT": "数据不足",
}
_KDJ_DIVERGENCE_LABELS = {
    "BOTTOM_DIVERGENCE": "底背离",
    "TOP_DIVERGENCE": "顶背离",
}

_ROC_PERIODS = (
    (5, "momentum_5d", 0.25),
    (20, "momentum_20d", 0.35),
    (60, "momentum_60d", 0.40),
)
_ROC_SLOPE_LOOKBACK = 20
_ROC_SLOPE_FLAT_BAND = 0.0005
_ROC_ACCELERATION_MIN = 0.005
_ROC_ACCELERATION_MULTIPLIER = 1.25
_ROC_HISTORY_LOOKBACK = 250
_ROC_HISTORY_MIN_SAMPLES = 30
_ROC_EXTREME_PERCENTILE = 5.0
_ROC_DIVERGENCE_LOOKBACK = 250
_ROC_DIVERGENCE_PIVOT_RADIUS = 2
_ROC_DIVERGENCE_PRICE_CHANGE_PCT = 1.0
_ROC_DIVERGENCE_VALUE_CHANGE_PCT_POINTS = 0.5
_ROC_DIVERGENCE_ACTIVE_BARS = 5

_ROC_STATE_LABELS = {
    "STRONG_BULL_ACCEL": "强多加速",
    "BULL_RUN": "多头运行",
    "BULL_DECAY": "多头衰减",
    "TURNING_BEARISH": "多转空",
    "STRONG_BEAR_ACCEL": "强空加速",
    "BEAR_RUN": "空头运行",
    "BEAR_DECAY": "空头衰减",
    "TURNING_BULLISH": "空转多",
    "NEUTRAL": "零轴附近",
    "MIXED": "方向分化",
    "INSUFFICIENT": "数据不足",
}
_ROC_STATE_SCORES = {
    "STRONG_BULL_ACCEL": 100.0,
    "BULL_RUN": 70.0,
    "BULL_DECAY": 60.0,
    "TURNING_BEARISH": 35.0,
    "STRONG_BEAR_ACCEL": 0.0,
    "BEAR_RUN": 30.0,
    "BEAR_DECAY": 40.0,
    "TURNING_BULLISH": 65.0,
    "NEUTRAL": 50.0,
}
_ROC_EVENT_LABELS = {
    "ROC_CROSS_ZERO_UP": "ROC上穿0",
    "ROC_CROSS_ZERO_DOWN": "ROC下穿0",
}
_ROC_DIRECTION_LABELS = {
    "POSITIVE": "正动能",
    "NEGATIVE": "负动能",
    "MIXED": "方向分化",
    "NEUTRAL": "零轴附近",
    "INSUFFICIENT": "数据不足",
}
_ROC_EXTREME_LABELS = {
    "EXTREME_OVERBOUGHT": "极端过热",
    "EXTREME_OVERSOLD": "极端超跌",
}
_ROC_DIVERGENCE_LABELS = {
    "BOTTOM_DIVERGENCE": "底背离",
    "TOP_DIVERGENCE": "顶背离",
}

_ROC_FIELD_BY_PERIOD = {
    period: field
    for period, field, _ in _ROC_PERIODS
}


@dataclass(frozen=True)
class _RocContext:
    values: dict[int, list[float | None]]
    pivots: dict[tuple[int, str], list[int]]


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


def _rsi_effective_value(records: list[dict], index: int) -> float | None:
    value = _number(records[index].get("rsi_14"))
    # 平盘时递推 RSI 可能落在 0/100; 这不是实际的极端动能, 与旧评分口径保持一致.
    if value in {0.0, 100.0} and _flat_close_window(records, index):
        return 50.0
    return value if value is not None and 0.0 <= value <= 100.0 else None


def _rsi_position_state(value: float | None) -> tuple[str, str]:
    if value is None:
        return "INSUFFICIENT", _RSI_STATE_LABELS["INSUFFICIENT"]
    if value >= 80.0:
        state = "EXTREME_OVERBOUGHT"
    elif value >= 70.0:
        state = "OVERBOUGHT"
    elif value >= 60.0:
        state = "BULLISH"
    elif value >= 50.0:
        state = "NEUTRAL_BULL"
    elif value >= 40.0:
        state = "NEUTRAL_BEAR"
    elif value >= 30.0:
        state = "BEARISH"
    elif value >= 20.0:
        state = "OVERSOLD"
    else:
        state = "EXTREME_OVERSOLD"
    return state, _RSI_STATE_LABELS[state]


def _rsi_direction(records: list[dict], index: int) -> tuple[str, str, float | None]:
    current = _rsi_effective_value(records, index)
    previous = _rsi_effective_value(records, index - 1) if index > 0 else None
    if current is None or previous is None:
        return "INSUFFICIENT", _RSI_DIRECTION_LABELS["INSUFFICIENT"], None
    change = current - previous
    if abs(change) <= _RSI_DIRECTION_FLAT_BAND:
        direction = "FLAT"
    else:
        direction = "RISING" if change > 0 else "FALLING"
    return direction, _RSI_DIRECTION_LABELS[direction], change


def _rsi_events(records: list[dict], index: int) -> list[str]:
    if index <= 0:
        return []
    previous = _rsi_effective_value(records, index - 1)
    current = _rsi_effective_value(records, index)
    if previous is None or current is None:
        return []
    events: list[str] = []
    if previous < 50.0 <= current:
        events.append("RSI_CROSS_50_UP")
    elif previous > 50.0 > current:
        events.append("RSI_CROSS_50_DOWN")
    if previous < 30.0 <= current:
        events.append("RSI_CROSS_30_UP")
    elif previous > 70.0 > current:
        events.append("RSI_CROSS_70_DOWN")
    return events


def _rsi_trend_zone(records: list[dict], index: int) -> tuple[str, list[float]]:
    values = [
        value
        for position in range(max(0, index - _RSI_ZONE_LOOKBACK + 1), index + 1)
        if (value := _rsi_effective_value(records, position)) is not None
    ]
    if len(values) < _RSI_ZONE_MIN_SAMPLES:
        return "INSUFFICIENT", values

    rare_count = max(1, len(values) // 10)
    below_40 = sum(value < 40.0 for value in values)
    above_60 = sum(value > 60.0 for value in values)
    if below_40 <= rare_count and max(values) >= 70.0:
        return "STRONG", values
    if above_60 <= rare_count and min(values) <= 30.0:
        return "WEAK", values
    return "NORMAL", values


def _rsi_divergence_pivots(
    records: list[dict],
    index: int,
    mode: str,
    *,
    lookback: int = _RSI_DIVERGENCE_LOOKBACK,
) -> list[int]:
    radius = _RSI_DIVERGENCE_PIVOT_RADIUS
    start = max(radius, index - lookback)
    stop = index - radius
    pivots: list[int] = []
    for pivot in range(start, stop + 1):
        center = _number(records[pivot].get("close"))
        rsi = _rsi_effective_value(records, pivot)
        if center is None or center <= 0 or rsi is None:
            continue
        neighbors = [
            _number(records[position].get("close"))
            for position in range(pivot - radius, pivot + radius + 1)
            if position != pivot
        ]
        if any(value is None for value in neighbors):
            continue
        if (mode == "high" and all(value < center for value in neighbors if value is not None)) or (
            mode == "low" and all(value > center for value in neighbors if value is not None)
        ):
            pivots.append(pivot)
    return pivots


def _rsi_divergence(records: list[dict], index: int) -> dict[str, float | int | str] | None:
    radius = _RSI_DIVERGENCE_PIVOT_RADIUS
    if index < radius * 2:
        return None

    candidates: list[dict[str, float | int | str]] = []
    for mode in ("high", "low"):
        pivots = _rsi_divergence_pivots(records, index, mode)
        for left, right in reversed(list(pairwise(pivots))):
            confirmation = right + radius
            if confirmation > index:
                continue
            left_close = _number(records[left].get("close"))
            right_close = _number(records[right].get("close"))
            left_rsi = _rsi_effective_value(records, left)
            right_rsi = _rsi_effective_value(records, right)
            if None in (left_close, right_close, left_rsi, right_rsi):
                continue
            price_change_pct = (right_close / left_close - 1.0) * 100.0
            rsi_change = right_rsi - left_rsi
            if mode == "high":
                if price_change_pct >= _RSI_DIVERGENCE_PRICE_CHANGE_PCT and rsi_change <= -_RSI_DIVERGENCE_VALUE_CHANGE:
                    kind = "TOP_DIVERGENCE"
                elif price_change_pct <= -_RSI_DIVERGENCE_PRICE_CHANGE_PCT and rsi_change >= _RSI_DIVERGENCE_VALUE_CHANGE:
                    kind = "HIDDEN_TOP_DIVERGENCE"
                else:
                    continue
            elif price_change_pct <= -_RSI_DIVERGENCE_PRICE_CHANGE_PCT and rsi_change >= _RSI_DIVERGENCE_VALUE_CHANGE:
                kind = "BOTTOM_DIVERGENCE"
            elif price_change_pct >= _RSI_DIVERGENCE_PRICE_CHANGE_PCT and rsi_change <= -_RSI_DIVERGENCE_VALUE_CHANGE:
                kind = "HIDDEN_BOTTOM_DIVERGENCE"
            else:
                continue
            candidates.append({
                "kind": kind,
                "left_rsi": left_rsi,
                "right_rsi": right_rsi,
                "price_change_pct": price_change_pct,
                "rsi_change": rsi_change,
                "pivot_age": index - right,
                "confirmation_lag": radius,
                "confirmation_index": confirmation,
            })
    return max(candidates, key=lambda item: item["confirmation_index"]) if candidates else None


def _rsi_failure_swing(records: list[dict], index: int) -> dict[str, float | int | str] | None:
    current = _rsi_effective_value(records, index)
    if current is None or index < 3:
        return None
    start = max(0, index - _RSI_FAILURE_SWING_LOOKBACK + 1)
    values = {position: _rsi_effective_value(records, position) for position in range(start, index + 1)}
    candidates: list[dict[str, float | int | str]] = []

    # 看涨失败摆动: 超卖低点 -> 反弹高点 -> 更高的第二低点 -> 突破反弹高点.
    for second_low in range(index - 1, start + 1, -1):
        second_value = values.get(second_low)
        if second_value is None or second_value >= 30.0:
            continue
        for first_high in range(second_low - 1, start, -1):
            high_value = values.get(first_high)
            if high_value is None or high_value <= 30.0:
                continue
            if any(
                value is not None and value > high_value
                for position in range(first_high + 1, second_low)
                for value in (values.get(position),)
            ):
                continue
            first_lows = [
                position for position in range(start, first_high)
                if (value := values.get(position)) is not None and value < 30.0
            ]
            if not first_lows:
                continue
            first_low = min(first_lows, key=lambda position: values[position])
            first_value = values[first_low]
            if first_value >= second_value or second_value >= high_value:
                continue
            trigger = next(
                (
                    position for position in range(second_low + 1, index + 1)
                    if (value := values.get(position)) is not None and value > high_value
                ),
                None,
            )
            if trigger is not None:
                candidates.append({
                    "kind": "BULLISH_FAILURE_SWING",
                    "first_value": first_value,
                    "second_value": second_value,
                    "trigger_level": high_value,
                    "pivot_age": index - second_low,
                    "trigger_index": trigger,
                })
                break
        if candidates:
            break

    # 看跌失败摆动: 超买高点 -> 回落低点 -> 更低的第二高点 -> 跌破回落低点.
    for second_high in range(index - 1, start + 1, -1):
        second_value = values.get(second_high)
        if second_value is None or second_value <= 70.0:
            continue
        for first_low in range(second_high - 1, start, -1):
            low_value = values.get(first_low)
            if low_value is None or low_value >= 70.0:
                continue
            if any(
                value is not None and value < low_value
                for position in range(first_low + 1, second_high)
                for value in (values.get(position),)
            ):
                continue
            first_highs = [
                position for position in range(start, first_low)
                if (value := values.get(position)) is not None and value > 70.0
            ]
            if not first_highs:
                continue
            first_high = max(first_highs, key=lambda position: values[position])
            first_value = values[first_high]
            if first_value <= second_value or second_value <= low_value:
                continue
            trigger = next(
                (
                    position for position in range(second_high + 1, index + 1)
                    if (value := values.get(position)) is not None and value < low_value
                ),
                None,
            )
            if trigger is not None:
                candidates.append({
                    "kind": "BEARISH_FAILURE_SWING",
                    "first_value": first_value,
                    "second_value": second_value,
                    "trigger_level": low_value,
                    "pivot_age": index - second_high,
                    "trigger_index": trigger,
                })
                break
        if candidates and candidates[-1]["kind"] == "BEARISH_FAILURE_SWING":
            break

    return max(candidates, key=lambda item: item["trigger_index"]) if candidates else None


def _rsi_stagnation(records: list[dict], index: int) -> tuple[str | None, int]:
    current = _rsi_effective_value(records, index)
    if current is None:
        return None, 0
    if current >= 70.0:
        kind = "HIGH_STAGNATION"
        def is_active(value: float | None) -> bool:
            return value is not None and value >= 70.0
    elif current <= 30.0:
        kind = "LOW_STAGNATION"
        def is_active(value: float | None) -> bool:
            return value is not None and value <= 30.0
    else:
        return None, 0
    count = 0
    for position in range(index, -1, -1):
        if not is_active(_rsi_effective_value(records, position)):
            break
        count += 1
    return (kind, count) if count >= _RSI_STAGNATION_MIN_BARS else (None, count)


def _rsi_analysis(records: list[dict], index: int) -> dict:
    raw_value = _number(records[index].get("rsi_14"))
    raw_previous = _number(records[index - 1].get("rsi_14")) if index > 0 else None
    value = _rsi_effective_value(records, index)
    state, status = _rsi_position_state(value)
    direction, direction_label, change = _rsi_direction(records, index)
    events = _rsi_events(records, index)
    zone, zone_values = _rsi_trend_zone(records, index)
    recent_divergence_info = _rsi_divergence(records, index)
    divergence_info = (
        recent_divergence_info
        if recent_divergence_info is not None
        and index - int(recent_divergence_info["confirmation_index"]) <= _RSI_DIVERGENCE_ACTIVE_BARS
        else None
    )
    recent_divergence = recent_divergence_info["kind"] if recent_divergence_info is not None else None
    divergence = divergence_info["kind"] if divergence_info is not None else None
    recent_divergence_index = (
        int(recent_divergence_info["confirmation_index"])
        if recent_divergence_info is not None
        else None
    )
    recent_divergence_as_of = (
        str(records[recent_divergence_index].get("date"))[:10]
        if recent_divergence_index is not None and records[recent_divergence_index].get("date") is not None
        else None
    )
    recent_failure_info = _rsi_failure_swing(records, index)
    failure_info = (
        recent_failure_info
        if recent_failure_info is not None
        and index - int(recent_failure_info["trigger_index"]) <= _RSI_DIVERGENCE_ACTIVE_BARS
        else None
    )
    recent_failure_swing = recent_failure_info["kind"] if recent_failure_info is not None else None
    failure_swing = failure_info["kind"] if failure_info is not None else None
    recent_failure_index = int(recent_failure_info["trigger_index"]) if recent_failure_info is not None else None
    recent_failure_as_of = (
        str(records[recent_failure_index].get("date"))[:10]
        if recent_failure_index is not None and records[recent_failure_index].get("date") is not None
        else None
    )
    stagnation, stagnation_bars = _rsi_stagnation(records, index)

    raw_values = _raw_values(
        rsi14=raw_value,
        rsi14_effective=value,
        previous_rsi14=raw_previous,
        rsi14_change=change,
        rsi_window_min=min(zone_values) if zone_values else None,
        rsi_window_max=max(zone_values) if zone_values else None,
        rsi_window_count=len(zone_values),
        rsi_below_40_count=sum(item < 40.0 for item in zone_values),
        rsi_above_60_count=sum(item > 60.0 for item in zone_values),
        divergence_left_rsi=recent_divergence_info.get("left_rsi") if recent_divergence_info else None,
        divergence_right_rsi=recent_divergence_info.get("right_rsi") if recent_divergence_info else None,
        divergence_price_change_pct=recent_divergence_info.get("price_change_pct") if recent_divergence_info else None,
        divergence_rsi_change=recent_divergence_info.get("rsi_change") if recent_divergence_info else None,
        divergence_pivot_age=recent_divergence_info.get("pivot_age") if recent_divergence_info else None,
        divergence_confirmation_lag=recent_divergence_info.get("confirmation_lag") if recent_divergence_info else None,
        failure_first_value=recent_failure_info.get("first_value") if recent_failure_info else None,
        failure_second_value=recent_failure_info.get("second_value") if recent_failure_info else None,
        failure_trigger_level=recent_failure_info.get("trigger_level") if recent_failure_info else None,
        failure_pivot_age=recent_failure_info.get("pivot_age") if recent_failure_info else None,
        failure_trigger_age=(index - recent_failure_index) if recent_failure_index is not None else None,
        stagnation_bars=stagnation_bars,
    )
    if value is None:
        return {
            "state": "INSUFFICIENT",
            "status": _RSI_STATE_LABELS["INSUFFICIENT"],
            "direction": "INSUFFICIENT",
            "direction_label": _RSI_DIRECTION_LABELS["INSUFFICIENT"],
            "event": None,
            "events": [],
            "zone": "INSUFFICIENT",
            "zone_label": _RSI_ZONE_LABELS["INSUFFICIENT"],
            "divergence": None,
            "recent_divergence": recent_divergence,
            "recent_divergence_as_of": recent_divergence_as_of,
            "failure_swing": None,
            "recent_failure_swing": recent_failure_swing,
            "recent_failure_swing_as_of": recent_failure_as_of,
            "stagnation": None,
            "tags": [],
            "confidence": 0,
            "summary": "数据不足",
            "value": None,
            "raw_values": raw_values,
        }

    summary_parts: list[str] = []
    if zone == "STRONG" and state in {"BULLISH", "NEUTRAL_BULL"}:
        summary_parts.append("强势区")
    elif zone == "WEAK" and state in {"NEUTRAL_BEAR", "BEARISH"}:
        summary_parts.append("弱势区")
    else:
        summary_parts.append(status)
    if divergence is not None:
        summary_parts.append(_RSI_DIVERGENCE_LABELS[divergence])
    summary_parts.extend(_RSI_EVENT_LABELS[event] for event in events)
    if failure_swing is not None:
        summary_parts.append(_RSI_FAILURE_SWING_LABELS[failure_swing])
    if stagnation is not None:
        summary_parts.append(_RSI_STAGNATION_LABELS[stagnation])
    if not divergence and not events and not failure_swing and stagnation is None and direction != "FLAT":
        summary_parts.append(direction_label)
    tags = [zone, *events]
    if divergence is not None:
        tags.append(divergence)
    if failure_swing is not None:
        tags.append(failure_swing)
    if stagnation is not None:
        tags.append(stagnation)
    return {
        "state": state,
        "status": status,
        "direction": direction,
        "direction_label": direction_label,
        "event": events[0] if events else None,
        "events": events,
        "zone": zone,
        "zone_label": _RSI_ZONE_LABELS[zone],
        "divergence": divergence,
        "recent_divergence": recent_divergence,
        "recent_divergence_as_of": recent_divergence_as_of,
        "failure_swing": failure_swing,
        "recent_failure_swing": recent_failure_swing,
        "recent_failure_swing_as_of": recent_failure_as_of,
        "stagnation": stagnation,
        "tags": tags,
        # This is input completeness, not a reversal probability.
        "confidence": 100 if raw_previous is not None else 50,
        "summary": " · ".join(summary_parts),
        "value": value,
        "raw_values": raw_values,
    }


def _kdj_values(records: list[dict], index: int) -> tuple[float | None, float | None, float | None]:
    row = records[index]
    return (
        _number(row.get("kdj_k")),
        _number(row.get("kdj_d")),
        _number(row.get("kdj_j")),
    )


def _kdj_zone(k: float | None, d: float | None) -> str:
    if k is None or d is None:
        return "INSUFFICIENT"
    if k <= _KDJ_LOW_LEVEL and d <= _KDJ_LOW_LEVEL:
        return "OVERSOLD"
    if k >= _KDJ_HIGH_LEVEL and d >= _KDJ_HIGH_LEVEL:
        return "OVERBOUGHT"
    return "MID_LOW" if (k + d) / 2.0 < 50.0 else "MID_HIGH"


def _kdj_cross_region(
    previous_k: float,
    previous_d: float,
    k: float,
    d: float,
) -> str:
    if max(previous_k, previous_d) <= _KDJ_LOW_LEVEL or max(k, d) <= _KDJ_LOW_LEVEL:
        return "LOW"
    if min(previous_k, previous_d) >= _KDJ_HIGH_LEVEL or min(k, d) >= _KDJ_HIGH_LEVEL:
        return "HIGH"
    return "MIDDLE"


def _kdj_j_turn(records: list[dict], index: int) -> str | None:
    if index < 2:
        return None
    _, _, j = _kdj_values(records, index)
    _, _, previous_j = _kdj_values(records, index - 1)
    _, _, earlier_j = _kdj_values(records, index - 2)
    if None in (j, previous_j, earlier_j):
        return None
    previous_change = previous_j - earlier_j
    current_change = j - previous_j
    if previous_change <= _KDJ_DIRECTION_FLAT_BAND and current_change > _KDJ_DIRECTION_FLAT_BAND:
        return "UP"
    if previous_change >= -_KDJ_DIRECTION_FLAT_BAND and current_change < -_KDJ_DIRECTION_FLAT_BAND:
        return "DOWN"
    return None


def _kdj_recent_j_turn(records: list[dict], index: int, lookback: int = 3) -> tuple[str | None, int | None]:
    for position in range(index, max(1, index - lookback) - 1, -1):
        turn = _kdj_j_turn(records, position)
        if turn is not None:
            return turn, index - position
    return None, None


def _kdj_events(records: list[dict], index: int) -> tuple[list[str], str | None, str | None]:
    if index <= 0:
        return [], None, None
    k, d, j = _kdj_values(records, index)
    previous_k, previous_d, previous_j = _kdj_values(records, index - 1)
    if None in (k, d, j, previous_k, previous_d, previous_j):
        return [], None, None

    events: list[str] = []
    crossover: str | None = None
    if previous_k <= previous_d and k > d:
        crossover = "GOLDEN_CROSS"
    elif previous_k >= previous_d and k < d:
        crossover = "DEATH_CROSS"
    if crossover is not None:
        region = _kdj_cross_region(previous_k, previous_d, k, d)
        cross_kind = "GOLDEN_CROSS" if crossover == "GOLDEN_CROSS" else "DEATH_CROSS"
        events.append(f"{region}_{cross_kind}")

    j_turn = _kdj_j_turn(records, index)
    if j_turn is not None:
        events.append(f"J_TURN_{j_turn}")
    return events, crossover, j_turn


def _kdj_direction_streak(records: list[dict], index: int, direction: str) -> int:
    count = 1
    moved = False
    start = max(1, index - _KDJ_STATE_LOOKBACK + 2)
    for position in range(index, start - 1, -1):
        _, _, current_j = _kdj_values(records, position)
        _, _, previous_j = _kdj_values(records, position - 1)
        if current_j is None or previous_j is None:
            break
        change = current_j - previous_j
        if (direction == "up" and change <= _KDJ_DIRECTION_FLAT_BAND) or (
            direction == "down" and change >= -_KDJ_DIRECTION_FLAT_BAND
        ):
            break
        moved = True
        count += 1
    return count if moved else 0


def _kdj_stagnation(records: list[dict], index: int) -> tuple[str | None, int]:
    k, d, _ = _kdj_values(records, index)
    zone = _kdj_zone(k, d)
    if zone not in {"OVERBOUGHT", "OVERSOLD"}:
        return None, 0
    count = 0
    start = max(0, index - _KDJ_STATE_LOOKBACK + 1)
    for position in range(index, start - 1, -1):
        current_k, current_d, _ = _kdj_values(records, position)
        if _kdj_zone(current_k, current_d) != zone:
            break
        count += 1
    if count < _KDJ_STAGNATION_MIN_BARS:
        return None, count
    if zone == "OVERBOUGHT" and k is not None and d is not None and k >= d:
        return "HIGH_STAGNATION", count
    if zone == "OVERSOLD" and k is not None and d is not None and k <= d:
        return "LOW_STAGNATION", count
    return None, count


def _kdj_divergence_pivots(records: list[dict], index: int, mode: str) -> list[int]:
    radius = _KDJ_DIVERGENCE_PIVOT_RADIUS
    start = max(radius, index - _KDJ_DIVERGENCE_LOOKBACK)
    stop = index - radius
    pivots: list[int] = []
    for pivot in range(start, stop + 1):
        center = _number(records[pivot].get("close"))
        _, _, j = _kdj_values(records, pivot)
        if center is None or center <= 0 or j is None:
            continue
        neighbors = [
            _number(records[position].get("close"))
            for position in range(pivot - radius, pivot + radius + 1)
            if position != pivot
        ]
        if any(value is None for value in neighbors):
            continue
        if (mode == "high" and all(value < center for value in neighbors if value is not None)) or (
            mode == "low" and all(value > center for value in neighbors if value is not None)
        ):
            pivots.append(pivot)
    return pivots


def _kdj_divergence(records: list[dict], index: int) -> dict[str, float | int | str] | None:
    radius = _KDJ_DIVERGENCE_PIVOT_RADIUS
    if index < radius * 2:
        return None

    candidates: list[dict[str, float | int | str]] = []
    for mode, kind in (("high", "TOP_DIVERGENCE"), ("low", "BOTTOM_DIVERGENCE")):
        pivots = _kdj_divergence_pivots(records, index, mode)
        for left, right in reversed(list(pairwise(pivots))):
            confirmation = right + radius
            if confirmation > index:
                continue
            left_close = _number(records[left].get("close"))
            right_close = _number(records[right].get("close"))
            _, _, left_j = _kdj_values(records, left)
            _, _, right_j = _kdj_values(records, right)
            if None in (left_close, right_close, left_j, right_j):
                continue
            price_change_pct = (right_close / left_close - 1.0) * 100.0
            j_change = right_j - left_j
            if mode == "high":
                divergent = (
                    price_change_pct >= _KDJ_DIVERGENCE_PRICE_CHANGE_PCT
                    and left_j >= _KDJ_HIGH_LEVEL
                    and right_j >= _KDJ_HIGH_LEVEL
                    and j_change <= -_KDJ_DIVERGENCE_J_CHANGE
                )
            else:
                divergent = (
                    price_change_pct <= -_KDJ_DIVERGENCE_PRICE_CHANGE_PCT
                    and left_j <= _KDJ_LOW_LEVEL
                    and right_j <= _KDJ_LOW_LEVEL
                    and j_change >= _KDJ_DIVERGENCE_J_CHANGE
                )
            if divergent:
                candidates.append({
                    "kind": kind,
                    "left_j": left_j,
                    "right_j": right_j,
                    "price_change_pct": price_change_pct,
                    "j_change": j_change,
                    "pivot_age": index - right,
                    "confirmation_lag": radius,
                    "confirmation_index": confirmation,
                })
    return max(candidates, key=lambda item: item["confirmation_index"]) if candidates else None


def _kdj_phase(state: str, zone: str, crossover: str | None, j_turn: str | None) -> str:
    if state == "OVERSOLD_REVERSAL":
        return "超卖 → J拐头 → 低位金叉 → 反转确认"
    if state == "LOW_GOLDEN_CROSS":
        return "超卖 → 低位金叉"
    if state == "WEAK_RECOVERY":
        return f"{'超卖' if zone == 'OVERSOLD' else '中低位'} → J拐头 → 弱势修复"
    if state == "HIGH_STAGNATION":
        return "多头动能 → 高位强势 → 高位钝化"
    if state == "HIGH_DEATH_CROSS":
        middle = " → J拐头向下" if j_turn == "DOWN" else ""
        return f"高位强势{middle} → 高位死叉"
    if state == "MOMENTUM_STRENGTHENING":
        return "修复 → 动能转强"
    if state == "MOMENTUM_WEAKENING":
        return "动能转弱 → 动能衰减"
    if state == "LOW_STAGNATION":
        return "弱势下行 → 低位钝化"
    if state == "HIGH_STRENGTH":
        return "多头动能 → 高位强势"
    if zone == "OVERSOLD":
        return "弱势下行 → 进入超卖"
    if zone == "OVERBOUGHT":
        return "多头动能 → 进入超买"
    if crossover == "GOLDEN_CROSS" or j_turn == "UP":
        return "震荡 → 动能修复"
    if crossover == "DEATH_CROSS" or j_turn == "DOWN":
        return "震荡 → 动能衰减"
    return "中位震荡"


def _kdj_analysis(records: list[dict], index: int) -> dict:
    k, d, j = _kdj_values(records, index)
    previous_k, previous_d, previous_j = _kdj_values(records, index - 1) if index > 0 else (None, None, None)
    k_change = k - previous_k if k is not None and previous_k is not None else None
    d_change = d - previous_d if d is not None and previous_d is not None else None
    j_change = j - previous_j if j is not None and previous_j is not None else None
    zone = _kdj_zone(k, d)
    events, crossover, current_j_turn = _kdj_events(records, index)
    j_turn, j_turn_age = _kdj_recent_j_turn(records, index)
    stagnation, stagnation_bars = _kdj_stagnation(records, index)
    improvement_bars = _kdj_direction_streak(records, index, "up") if j is not None else 0
    weakening_bars = _kdj_direction_streak(records, index, "down") if j is not None else 0
    recent_divergence_info = _kdj_divergence(records, index)
    divergence_info = (
        recent_divergence_info
        if recent_divergence_info is not None
        and index - int(recent_divergence_info["confirmation_index"]) <= _KDJ_DIVERGENCE_ACTIVE_BARS
        else None
    )
    divergence = divergence_info["kind"] if divergence_info is not None else None
    recent_divergence = recent_divergence_info["kind"] if recent_divergence_info is not None else None
    recent_confirmation_index = (
        int(recent_divergence_info["confirmation_index"])
        if recent_divergence_info is not None
        else None
    )
    recent_divergence_as_of = (
        str(records[recent_confirmation_index].get("date"))[:10]
        if recent_confirmation_index is not None and records[recent_confirmation_index].get("date") is not None
        else None
    )
    raw_values = _raw_values(
        k=k,
        d=d,
        j=j,
        previous_k=previous_k,
        previous_d=previous_d,
        previous_j=previous_j,
        k_change=k_change,
        d_change=d_change,
        j_change=j_change,
        j_turn_age=j_turn_age,
        improvement_bars=improvement_bars,
        weakening_bars=weakening_bars,
        stagnation_bars=stagnation_bars,
        divergence_left_j=recent_divergence_info.get("left_j") if recent_divergence_info else None,
        divergence_right_j=recent_divergence_info.get("right_j") if recent_divergence_info else None,
        divergence_price_change_pct=(
            recent_divergence_info.get("price_change_pct") if recent_divergence_info else None
        ),
        divergence_j_change=recent_divergence_info.get("j_change") if recent_divergence_info else None,
        divergence_pivot_age=recent_divergence_info.get("pivot_age") if recent_divergence_info else None,
        divergence_confirmation_lag=(
            recent_divergence_info.get("confirmation_lag") if recent_divergence_info else None
        ),
    )
    if None in (k, d, j):
        return {
            "state": "INSUFFICIENT",
            "status": _KDJ_STATE_LABELS["INSUFFICIENT"],
            "event": None,
            "events": [],
            "crossover": None,
            "zone": "INSUFFICIENT",
            "zone_label": _KDJ_ZONE_LABELS["INSUFFICIENT"],
            "j_turn": None,
            "phase": "数据不足",
            "divergence": None,
            "recent_divergence": recent_divergence,
            "recent_divergence_as_of": recent_divergence_as_of,
            "stagnation": None,
            "tags": [],
            "confidence": 0,
            "summary": "数据不足",
            "raw_values": raw_values,
        }

    rising = all(
        change is not None and change > _KDJ_DIRECTION_FLAT_BAND
        for change in (k_change, d_change, j_change)
    )
    falling = all(
        change is not None and change < -_KDJ_DIRECTION_FLAT_BAND
        for change in (k_change, d_change, j_change)
    )
    cross_event = next((event for event in events if event.endswith("CROSS")), None)
    if cross_event == "LOW_GOLDEN_CROSS" and j_turn == "UP":
        state = "OVERSOLD_REVERSAL"
    elif cross_event == "LOW_GOLDEN_CROSS":
        state = "LOW_GOLDEN_CROSS"
    elif cross_event == "HIGH_DEATH_CROSS":
        state = "HIGH_DEATH_CROSS"
    elif cross_event == "HIGH_GOLDEN_CROSS":
        state = "HIGH_STRENGTH"
    elif cross_event == "LOW_DEATH_CROSS":
        state = "LOW_STAGNATION" if stagnation == "LOW_STAGNATION" else "OVERSOLD"
    elif j_turn == "UP" and zone in {"OVERSOLD", "MID_LOW"} and k <= d:
        state = "WEAK_RECOVERY"
    elif stagnation == "HIGH_STAGNATION":
        state = "HIGH_STAGNATION"
    elif rising and k > d:
        state = "MOMENTUM_STRENGTHENING"
    elif zone == "OVERBOUGHT" and k >= d:
        state = "HIGH_STRENGTH"
    elif falling and k < d:
        state = "MOMENTUM_WEAKENING"
    elif cross_event is not None and crossover == "GOLDEN_CROSS":
        state = "MOMENTUM_STRENGTHENING"
    elif cross_event is not None and crossover == "DEATH_CROSS":
        state = "MOMENTUM_WEAKENING"
    elif stagnation == "LOW_STAGNATION":
        state = "LOW_STAGNATION"
    elif zone == "OVERSOLD":
        state = "OVERSOLD"
    elif zone == "OVERBOUGHT":
        state = "OVERBOUGHT"
    else:
        state = "NEUTRAL_OSCILLATION"

    phase = _kdj_phase(state, zone, crossover, j_turn)
    summary_parts = [_KDJ_STATE_LABELS[state]]
    if cross_event is not None and _KDJ_EVENT_LABELS[cross_event] != summary_parts[0]:
        summary_parts.append(_KDJ_EVENT_LABELS[cross_event])
    if divergence is not None:
        summary_parts.append(_KDJ_DIVERGENCE_LABELS[divergence])
    if state == "OVERSOLD_REVERSAL":
        summary_parts.append("反弹确认度提高")
    elif state == "HIGH_STAGNATION":
        summary_parts.append("多头排列延续, 不等同卖出")
    elif cross_event == "HIGH_GOLDEN_CROSS":
        summary_parts.append("强势延续, 追高风险增加")
    elif cross_event == "LOW_DEATH_CROSS":
        summary_parts.append("低位死叉不追加卖出判断")
    elif j_turn is not None and cross_event is None:
        summary_parts.append(_KDJ_EVENT_LABELS[f"J_TURN_{j_turn}"])

    tags = [zone, state, *events]
    if j_turn is not None and current_j_turn is None:
        tags.append(f"RECENT_J_TURN_{j_turn}")
    if stagnation is not None and stagnation not in tags:
        tags.append(stagnation)
    if divergence is not None:
        tags.append(divergence)
    confidence = 50
    if None not in (previous_k, previous_d, previous_j):
        confidence += 30
    if index >= 2 and _kdj_values(records, index - 2)[2] is not None:
        confidence += 20
    return {
        "state": state,
        "status": _KDJ_STATE_LABELS[state],
        "event": events[0] if events else None,
        "events": events,
        "crossover": crossover,
        "zone": zone,
        "zone_label": _KDJ_ZONE_LABELS[zone],
        "j_turn": j_turn,
        "phase": phase,
        "divergence": divergence,
        "recent_divergence": recent_divergence,
        "recent_divergence_as_of": recent_divergence_as_of,
        "stagnation": stagnation,
        "tags": tags,
        # This is input completeness, not a reversal probability.
        "confidence": confidence,
        "summary": " · ".join(summary_parts),
        "raw_values": raw_values,
    }


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


def _momentum_score(
    records: list[dict],
    index: int,
    roc_context: _RocContext | None = None,
) -> tuple[float | None, float]:
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
    # 兼容顶层方向分只需要 ROC 正负方向与覆盖率; 历史分位和背离等富分析
    # 由分类详情计算一次即可, 避免在同一根 K 线上重复扫描长窗口。
    roc = _weighted_mean([
        (_sign_score(_roc_value(records, index, period, roc_context)), weight)
        for period, _, weight in _ROC_PERIODS
    ])
    score, coverage = _weighted_score((
        (macd[0], _CATEGORY_INDICATOR_WEIGHTS["momentum"]["macd"], macd[1]),
        (rsi, _CATEGORY_INDICATOR_WEIGHTS["momentum"]["rsi"], 1.0 if rsi is not None else 0.0),
        (kdj[0], _CATEGORY_INDICATOR_WEIGHTS["momentum"]["kdj"], kdj[1]),
        (roc[0], _CATEGORY_INDICATOR_WEIGHTS["momentum"]["roc"], roc[1]),
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


def _trend_score_status(score: float | None) -> str:
    """把趋势五项加权分映射为用户可读的七档结果."""
    if score is None:
        return "数据不足"
    if score <= 20:
        return "强空"
    if score <= 40:
        return "偏空"
    if score <= 45:
        return "弱空"
    if score <= 55:
        return "中性/震荡"
    if score <= 60:
        return "弱多"
    if score <= 80:
        return "偏多"
    return "强多"


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
    "上升减速": ("", "仍为正向, 但斜率趋平"),
    "下降减速": ("", "仍为负向, 但跌势收窄"),
    "由平转升": ("", "从横盘开始转强"),
    "由平转降": ("", "从横盘开始转弱"),
}
_MA_SLOPE_FLAT_TOLERANCE = 0.0005
_MA_SLOPE_STRONG_TOLERANCE = 0.002
_MA_SLOPE_CHANGE_TOLERANCE = 0.0002
_TREND_PERSISTENCE_WINDOW = 5
_TREND_PERSISTENCE_MIN_SAMPLES = 3
_TREND_PERSISTENCE_MEANINGS = {
    5: "强多头持续",
    4: "多头持续较强",
    3: "略偏多, 但不稳定",
    2: "略偏空",
    1: "空头持续较强",
    0: "强空头持续",
}
_PRICE_POSITION_NEAR_MA20_TOLERANCE = 0.01
_PRICE_POSITION_EXTREME_MA20_TOLERANCE = 0.05
_MA_DISPERSION_FIELDS = ("ma5", "ma10", "ma20", "ma60", "ma120")
_MA_DISPERSION_SHORT_FIELDS = ("ma5", "ma10", "ma20")
_MA_DISPERSION_MEDIUM_FIELDS = ("ma20", "ma60")
_MA_DISPERSION_LONG_FIELDS = ("ma20", "ma60", "ma120")
_MA_DISPERSION_STICKY_SHORT_TOLERANCE = 0.01
_MA_DISPERSION_STICKY_LONG_TOLERANCE = 0.02
_MA_DISPERSION_CHANGE_TOLERANCE = 0.0002
_MA_DISPERSION_CONFIRMATION_LAG = 3

_TREND_DATA_MODE_FULL = "full"
_TREND_DATA_MODE_MEDIUM = "medium"
_TREND_DATA_MODE_SHORT = "short"
_TREND_DATA_MODE_INSUFFICIENT = "insufficient"
_TREND_DATA_MODE_LABELS = {
    _TREND_DATA_MODE_FULL: "完整评分",
    _TREND_DATA_MODE_MEDIUM: "中期降级",
    _TREND_DATA_MODE_SHORT: "短期参考",
    _TREND_DATA_MODE_INSUFFICIENT: "数据不足",
}


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


def _valid_ma_fields(row: dict, fields: tuple[str, ...]) -> bool:
    values = [_number(row.get(field)) for field in fields]
    return all(value is not None and value > 0 for value in values)


def _ma_indicator_scope(row: dict) -> str:
    if _valid_ma_fields(row, _MA_DISPERSION_FIELDS):
        return _TREND_DATA_MODE_FULL
    if _valid_ma_fields(row, _MA_DISPERSION_FIELDS[:-1]):
        return _TREND_DATA_MODE_MEDIUM
    if _valid_ma_fields(row, _MA_DISPERSION_SHORT_FIELDS):
        return _TREND_DATA_MODE_SHORT
    return _TREND_DATA_MODE_INSUFFICIENT


def _trend_data_mode(records: list[dict], index: int) -> str:
    """按当前可用均线和三周期确认, 选择趋势评分的最高可靠档位.

    MA120 的存在意味着至少已经形成 120 根目标周期均线; 再要求三周期
    聚散基线, 等价于完整评分至少需要 123 根有效周期。这里不直接依赖
    可见窗口长度, 因为 API 可能只把预热后的最近窗口交给 payload。
    """
    row = records[index]
    checks = (
        (
            _TREND_DATA_MODE_FULL,
            _MA_DISPERSION_FIELDS,
            _MA_DISPERSION_LONG_FIELDS,
        ),
        (
            _TREND_DATA_MODE_MEDIUM,
            _MA_DISPERSION_FIELDS[:-1],
            _MA_DISPERSION_MEDIUM_FIELDS,
        ),
        (
            _TREND_DATA_MODE_SHORT,
            _MA_DISPERSION_SHORT_FIELDS,
            None,
        ),
    )
    for mode, required_fields, long_fields in checks:
        if not _valid_ma_fields(row, required_fields):
            continue
        short_change = _ma_dispersion_change(records, index, _MA_DISPERSION_SHORT_FIELDS)
        long_change = (
            _ma_dispersion_change(records, index, long_fields)
            if long_fields is not None
            else None
        )
        if short_change is None:
            continue
        if long_fields is not None and long_change is None:
            continue
        return mode
    return _TREND_DATA_MODE_INSUFFICIENT


def _trend_category_status(score: float | None, mode: str) -> str:
    if score is None or mode == _TREND_DATA_MODE_INSUFFICIENT:
        return "数据不足"
    status = _trend_score_status(score)
    if mode == _TREND_DATA_MODE_FULL:
        return status
    return f"{status} ({_TREND_DATA_MODE_LABELS[mode]})"


def _ma_alignment_state(
    records: list[dict],
    index: int,
    *,
    scope: str = _TREND_DATA_MODE_FULL,
) -> tuple[float | None, str, str]:
    row = records[index]
    required_fields = {
        _TREND_DATA_MODE_FULL: _MA_DISPERSION_FIELDS,
        _TREND_DATA_MODE_MEDIUM: _MA_DISPERSION_FIELDS[:-1],
        _TREND_DATA_MODE_SHORT: _MA_DISPERSION_SHORT_FIELDS,
    }.get(scope)
    if required_fields is None or not _valid_ma_fields(row, required_fields):
        needed = {
            _TREND_DATA_MODE_FULL: "MA5/10/20/60/MA120",
            _TREND_DATA_MODE_MEDIUM: "MA5/10/20/60",
            _TREND_DATA_MODE_SHORT: "MA5/10/20",
        }.get(scope, "所需均线")
        return None, "数据不足", f"需要 {needed} 才能识别均线状态"

    ma5 = _number(row.get("ma5"))
    ma10 = _number(row.get("ma10"))
    ma20 = _number(row.get("ma20"))
    ma60 = _number(row.get("ma60"))
    ma120 = _number(row.get("ma120"))
    short_values = (ma5, ma10, ma20, ma60) if scope != _TREND_DATA_MODE_SHORT else (ma5, ma10, ma20)
    short_bull = _strict_order(short_values, ascending=False)
    short_bear = _strict_order(short_values, ascending=True)
    full_bull = (
        scope == _TREND_DATA_MODE_FULL
        and short_bull
        and ma60 is not None
        and ma120 is not None
        and ma60 > ma120
        and not _relative_close(ma60, ma120)
    )
    full_bear = (
        scope == _TREND_DATA_MODE_FULL
        and short_bear
        and ma60 is not None
        and ma120 is not None
        and ma60 < ma120
        and not _relative_close(ma60, ma120)
    )
    middle_bull = (
        scope != _TREND_DATA_MODE_SHORT
        and ma20 is not None
        and ma60 is not None
        and ma20 > ma60
        and not _relative_close(ma20, ma60)
    )
    middle_bear = (
        scope != _TREND_DATA_MODE_SHORT
        and ma20 is not None
        and ma60 is not None
        and ma20 < ma60
        and not _relative_close(ma20, ma60)
    )
    previous = records[index - 1] if index > 0 else {}
    previous_ma5 = _number(previous.get("ma5"))
    previous_ma10 = _number(previous.get("ma10"))
    previous_ma20 = _number(previous.get("ma20"))
    crossed_up = (
        ma5 is not None and ma10 is not None and ma20 is not None
        and ma5 > ma10 and ma5 > ma20
        and previous_ma5 is not None
        and previous_ma10 is not None
        and previous_ma20 is not None
        and (previous_ma5 <= previous_ma10 or previous_ma5 <= previous_ma20)
    )
    crossed_down = (
        ma5 is not None and ma10 is not None and ma20 is not None
        and ma5 < ma10 and ma5 < ma20
        and previous_ma5 is not None
        and previous_ma10 is not None
        and previous_ma20 is not None
        and (previous_ma5 >= previous_ma10 or previous_ma5 >= previous_ma20)
    )
    bottom_turn = crossed_up and _ma20_is_flat(records, index) and (
        scope == _TREND_DATA_MODE_SHORT
        or (ma20 is not None and ma60 is not None and ma20 < ma60)
    )
    top_turn = crossed_down and _ma20_is_flat(records, index) and (
        scope == _TREND_DATA_MODE_SHORT
        or (ma20 is not None and ma60 is not None and ma20 > ma60)
    )

    if full_bull:
        state = "强多头排列"
        rule = "MA5 > MA10 > MA20 > MA60 > MA120"
    elif full_bear:
        state = "强空头排列"
        rule = "MA5 < MA10 < MA20 < MA60 < MA120"
    elif bottom_turn:
        state = "底部转强"
        rule = "MA5上穿MA10/MA20; MA20走平"
        if scope == _TREND_DATA_MODE_MEDIUM:
            rule += "; MA20仍低于MA60; MA120暂不可用"
        elif scope == _TREND_DATA_MODE_FULL:
            rule += "; MA20仍低于MA60/MA120"
        else:
            rule += "; MA60/MA120暂不可用"
    elif top_turn:
        state = "顶部转弱"
        rule = "MA5下穿MA10/MA20; MA20走平"
        if scope == _TREND_DATA_MODE_MEDIUM:
            rule += "; MA20仍高于MA60; MA120暂不可用"
        elif scope == _TREND_DATA_MODE_FULL:
            rule += "; MA20仍高于MA60/MA120"
        else:
            rule += "; MA60/MA120暂不可用"
    elif short_bull:
        state = "多头排列"
        rule = "MA5 > MA10 > MA20 > MA60; MA120尚未完全跟随" if scope != _TREND_DATA_MODE_SHORT else "MA5 > MA10 > MA20; MA60/MA120暂不可用"
    elif short_bear:
        state = "空头排列"
        rule = "MA5 < MA10 < MA20 < MA60; MA120尚未完全转空" if scope != _TREND_DATA_MODE_SHORT else "MA5 < MA10 < MA20; MA60/MA120暂不可用"
    elif middle_bull and ma5 is not None and ma10 is not None and ma20 is not None and ma5 < ma10 and ma5 < ma20:
        state = "多头回调"
        rule = "MA5低于MA10/MA20; MA20 > MA60"
        if scope == _TREND_DATA_MODE_FULL:
            rule += " > MA120"
        else:
            rule += "; MA120暂不可用"
    elif middle_bear and ma5 is not None and ma10 is not None and ma20 is not None and ma5 > ma10 and ma5 > ma20:
        state = "空头反弹"
        rule = "MA5高于MA10/MA20; MA20 < MA60"
        if scope == _TREND_DATA_MODE_FULL:
            rule += " < MA120"
        else:
            rule += "; MA120暂不可用"
    elif _ma_converged((ma5, ma10, ma20)) or (
        scope != _TREND_DATA_MODE_SHORT
        and _ma_converged(tuple(value for value in (ma5, ma10, ma20, ma60, ma120) if value is not None))
    ):
        state = "均线收敛/缠绕"
        rule = "MA5/10/20相对价差约<=0.5%; 趋势尚未明确"
    elif middle_bull:
        state = "多头回调"
        rule = "中期均线仍为MA20 > MA60; 短期排列未完成; MA120暂不可用"
    elif middle_bear:
        state = "空头反弹"
        rule = "中期均线仍为MA20 < MA60; 短期排列未完成; MA120暂不可用"
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


def _ma_slope_components(
    records: list[dict],
    index: int,
    fields: tuple[str, ...] = _MA_SLOPE_FIELDS,
) -> dict[str, tuple[float | None, str, float | None, float | None]]:
    return {
        field: _ma_slope_state(records, index, field)
        for field in fields
    }


def _ma_slope_summary(
    records: list[dict],
    index: int,
    fields: tuple[str, ...] = _MA_SLOPE_FIELDS,
) -> tuple[float | None, float, str]:
    parts: list[tuple[float | None, float]] = []
    states: list[str] = []
    for field, (score, state, _, _) in _ma_slope_components(records, index, fields).items():
        parts.append((score, 1.0))
        if score is not None:
            states.append(f"{field.upper()}{state}")
    score, coverage = _weighted_mean(parts)
    return score, coverage, " · ".join(states) if states else "数据不足"


def _ma_slope_detail(field: str, state: str) -> str:
    symbol, meaning = _MA_SLOPE_STATE_MEANINGS[state]
    symbol_suffix = f" {symbol}" if symbol else ""
    return f"{field.upper()} {state}{symbol_suffix}: {meaning}"


def _trend_persistence_status(above_count: int, sample_count: int) -> str:
    if sample_count != _TREND_PERSISTENCE_WINDOW:
        return "数据不足"
    return _TREND_PERSISTENCE_MEANINGS[above_count]


def _trend_persistence_detail(above_count: int, sample_count: int) -> str:
    if sample_count != _TREND_PERSISTENCE_WINDOW:
        return f"最近{_TREND_PERSISTENCE_WINDOW}周期有效 {sample_count}/{_TREND_PERSISTENCE_WINDOW}, 暂不生成持续性结论"
    meaning = _TREND_PERSISTENCE_MEANINGS[above_count]
    return f"最近{_TREND_PERSISTENCE_WINDOW}周期: {above_count}/{_TREND_PERSISTENCE_WINDOW} 在上 · {meaning}"


def _price_position_state(
    close: float | None,
    ma20: float | None,
    ma60: float | None,
    ma120: float | None,
    *,
    scope: str = _TREND_DATA_MODE_FULL,
) -> tuple[float | None, str, str]:
    if close is None or close <= 0 or ma20 is None or ma20 <= 0:
        return None, "数据不足", "需要价格与 MA20 才能识别价格位置"

    ma20_distance = close / ma20 - 1.0
    if abs(ma20_distance) > _PRICE_POSITION_EXTREME_MA20_TOLERANCE:
        if ma20_distance > 0:
            return 85.0, "极端偏离区", "价格大幅高于 MA20, 可能过热"
        return 15.0, "极端偏离区", "价格大幅低于 MA20, 可能超跌"
    if abs(ma20_distance) <= _PRICE_POSITION_NEAR_MA20_TOLERANCE:
        return 50.0, "MA20附近", "多空平衡, 容易震荡/选择方向"

    if scope == _TREND_DATA_MODE_SHORT:
        if close > ma20:
            return 65.0, "短期偏强", "价格位于 MA20 上方, 短期偏强"
        return 35.0, "短期偏弱", "价格位于 MA20 下方, 短期偏弱"

    if ma60 is None or ma60 <= 0:
        return None, "数据不足", "需要 MA60 才能识别中期价格位置"

    if scope == _TREND_DATA_MODE_MEDIUM:
        if close > ma20:
            if close > ma60:
                return 75.0, "中期多头区", "价格位于 MA20/MA60 上方, 长期位置未评估"
            return 60.0, "短期转强", "价格站上 MA20, 但 MA60 仍承压, 长期位置未评估"
        if close > ma60:
            return 60.0, "短期回调", "价格仍在 MA60 上方, 短期回调, 长期位置未评估"
        return 35.0, "中期转弱", "价格跌破 MA20/MA60, 长期支撑未评估"

    if ma120 is None or ma120 <= 0:
        return None, "数据不足", "需要 MA120 才能识别完整价格位置"
    if close > ma20:
        if close > ma60:
            if close > ma120:
                return 90.0, "强势区", "主要均线上方 · 强势"
            return 75.0, "中期修复", "已站上 MA20/MA60, 长期压力仍在"
        meaning = "短期已转强, 中长期仍承压" if close < ma120 else "短期已转强, MA60仍承压"
        return 60.0, "短期转强", meaning

    if close > ma60:
        meaning = "MA60/MA120上方, 多头结构中的短期回调" if close > ma120 else "MA60上方, 长期压力仍在"
        return 60.0, "短期回调", meaning
    if close > ma120:
        return 35.0, "中期转弱", "短中期走弱, 长期支撑仍在"
    return 10.0, "弱势区", "主要成本线全部在价格上方"


def _price_position_detail(
    status: str,
    meaning: str,
) -> str:
    if status == "数据不足":
        return meaning
    return f"{status} · {meaning}"


def _ma_dispersion_spread(row: dict, fields: tuple[str, ...]) -> float | None:
    close = _number(row.get("close"))
    values = [_number(row.get(field)) for field in fields]
    if close is None or close <= 0 or any(value is None or value <= 0 for value in values):
        return None
    return (max(values) - min(values)) / close


def _ma_dispersion_direction(delta: float | None) -> str:
    if delta is None:
        return "unknown"
    if delta > _MA_DISPERSION_CHANGE_TOLERANCE:
        return "expanding"
    if delta < -_MA_DISPERSION_CHANGE_TOLERANCE:
        return "contracting"
    return "flat"


def _ma_dispersion_change(records: list[dict], index: int, fields: tuple[str, ...]) -> float | None:
    if index < _MA_DISPERSION_CONFIRMATION_LAG:
        return None
    current = _ma_dispersion_spread(records[index], fields)
    baseline = _ma_dispersion_spread(records[index - _MA_DISPERSION_CONFIRMATION_LAG], fields)
    if current is None or baseline is None:
        return None
    return (current - baseline) / _MA_DISPERSION_CONFIRMATION_LAG


def _ma_dispersion_pattern(
    short_direction: str,
    long_direction: str,
    *,
    long_label: str = "中长期",
) -> tuple[str, str]:
    compact_label = "长" if long_label == "中长期" else long_label[0]
    patterns = {
        ("expanding", "expanding"): ("整体发散", f"短期与{long_label}均发散"),
        ("contracting", "contracting"): ("整体收敛", f"短期与{long_label}均收敛"),
        ("flat", "flat"): ("聚散平稳", f"短期与{long_label}变化都不明显"),
        ("expanding", "flat"): ("短期发散", f"短期均线变散, {long_label}变化不明显"),
        ("flat", "expanding"): (f"{long_label}发散", f"{long_label}均线变散, 短期变化不明显"),
        ("contracting", "flat"): ("短期收敛", f"短期均线变拢, {long_label}变化不明显"),
        ("flat", "contracting"): (f"{long_label}收敛", f"{long_label}均线变拢, 短期变化不明显"),
        ("expanding", "contracting"): (f"短散{compact_label}收", f"短期发散, {long_label}收敛"),
        ("contracting", "expanding"): (f"短收{compact_label}散", f"短期收敛, {long_label}发散"),
    }
    return patterns.get((short_direction, long_direction), ("数据不足", "需要短期与中长期的完整聚散变化"))


def _ma_relation(left: float, right: float) -> int:
    if _relative_close(left, right):
        return 0
    return 1 if left > right else -1


def _ma_structure_components(
    row: dict,
    fields: tuple[str, ...] = _MA_DISPERSION_FIELDS,
) -> tuple[int | None, int | None, int | None]:
    values = [_number(row.get(field)) for field in fields]
    if any(value is None or value <= 0 for value in values):
        return None, None, None
    relations = [_ma_relation(left, right) for left, right in pairwise(values)]
    short_score = sum(relations[:2]) if len(relations) >= 2 else None
    long_score = sum(relations[2:]) if len(relations) > 2 else None
    components = [score for score in (short_score, long_score) if score is not None]
    return (sum(components) if components else None), short_score, long_score


def _ma_structure_status(score: int | None, *, max_score: int = 4) -> str:
    if score is None:
        return "数据不足"
    positive_threshold = max(1, math.ceil(max_score / 2))
    if score >= max_score:
        return "强多头"
    if score >= positive_threshold:
        return "偏多结构"
    if score <= -max_score:
        return "强空头"
    if score <= -positive_threshold:
        return "偏空结构"
    return "混合/过渡"


def _ma_structure_compact_status(
    short_score: int | None,
    long_score: int | None,
    *,
    max_score: int = 4,
    higher_label: str = "长",
) -> str:
    if short_score is None or long_score is None:
        return "结构数据不足"
    if short_score > 0 and long_score < 0:
        return f"短多{higher_label}空"
    if short_score < 0 and long_score > 0:
        return f"短空{higher_label}多"
    return _ma_structure_status(short_score + long_score, max_score=max_score)


def _ma_dispersion_composite(
    pattern: str,
    structure_score: int | None,
    short_structure_score: int | None,
    long_structure_score: int | None,
    *,
    structure_max_score: int = 4,
    structure_higher_label: str = "长",
) -> str:
    if pattern == "数据不足":
        return "数据不足"
    structure_status = _ma_structure_status(structure_score, max_score=structure_max_score)
    if pattern == "均线粘合":
        return "均线粘合"
    if pattern in {"短散长收", "短收长散", "短散中收", "短收中散"}:
        compact_status = _ma_structure_compact_status(
            short_structure_score,
            long_structure_score,
            max_score=structure_max_score,
            higher_label=structure_higher_label,
        )
        return f"{compact_status} · 聚散分化"
    if pattern == "整体发散":
        if structure_score is not None and structure_score >= max(1, math.ceil(structure_max_score / 2)):
            return "多头发散"
        if structure_score is not None and structure_score <= -max(1, math.ceil(structure_max_score / 2)):
            return "空头发散"
    if pattern == "整体收敛":
        if structure_score is not None and structure_score >= max(1, math.ceil(structure_max_score / 2)):
            return "多头收敛"
        if structure_score is not None and structure_score <= -max(1, math.ceil(structure_max_score / 2)):
            return "空头收敛"
    return f"{structure_status} · {pattern}"


def _ma_dispersion_score(
    pattern: str,
    structure_score: int | None,
    *,
    structure_threshold: int = 2,
) -> float:
    if structure_score is None or pattern in {
        "均线粘合", "聚散平稳", "短散长收", "短收长散", "短散中收", "短收中散",
    }:
        return 50.0
    expanding = pattern == "整体发散" or pattern.endswith("发散")
    contracting = pattern == "整体收敛" or pattern.endswith("收敛")
    if structure_score >= structure_threshold:
        return 90.0 if expanding else 65.0 if contracting else 70.0
    if structure_score <= -structure_threshold:
        return 10.0 if expanding else 35.0 if contracting else 30.0
    return 50.0


def _ma_dispersion_state(
    row: dict,
    short_spread: float | None,
    long_spread: float | None,
    short_change: float | None,
    long_change: float | None,
    *,
    scope: str = _TREND_DATA_MODE_FULL,
) -> tuple[float | None, str, str]:
    if short_spread is None:
        return None, "数据不足", "需要价格与 MA5/10/20 才能识别均线聚散"

    if scope == _TREND_DATA_MODE_SHORT:
        if short_spread <= _MA_DISPERSION_STICKY_SHORT_TOLERANCE:
            return 50.0, "均线粘合", "短期均线距离很近, 震荡或等待方向选择"
        if short_change is None:
            return None, "数据不足", f"需要最近{_MA_DISPERSION_CONFIRMATION_LAG}周期的完整均线样本才能确认聚散变化"
        direction = _ma_dispersion_direction(short_change)
        patterns = {
            "expanding": ("短期发散", "短期均线变散"),
            "contracting": ("短期收敛", "短期均线变拢"),
            "flat": ("聚散平稳", "短期均线变化不明显"),
        }
        status, meaning = patterns[direction]
        structure_score, _, _ = _ma_structure_components(row, _MA_DISPERSION_SHORT_FIELDS)
        return _ma_dispersion_score(status, structure_score, structure_threshold=1), status, meaning

    if long_spread is None:
        fields_label = "MA5/10/20/60" if scope == _TREND_DATA_MODE_MEDIUM else "MA5/10/20/60/120"
        return None, "数据不足", f"需要价格与 {fields_label} 才能识别均线聚散"

    if (
        short_spread <= _MA_DISPERSION_STICKY_SHORT_TOLERANCE
        and long_spread <= _MA_DISPERSION_STICKY_LONG_TOLERANCE
    ):
        label = "中期" if scope == _TREND_DATA_MODE_MEDIUM else "中长期"
        return 50.0, "均线粘合", f"短期与{label}均线距离很近, 震荡或等待方向选择"
    if short_change is None or long_change is None:
        return None, "数据不足", f"需要最近{_MA_DISPERSION_CONFIRMATION_LAG}周期的完整均线样本才能确认聚散变化"

    short_direction = _ma_dispersion_direction(short_change)
    long_direction = _ma_dispersion_direction(long_change)
    long_label = "中期" if scope == _TREND_DATA_MODE_MEDIUM else "中长期"
    pattern, meaning = _ma_dispersion_pattern(short_direction, long_direction, long_label=long_label)
    structure_fields = _MA_DISPERSION_FIELDS if scope == _TREND_DATA_MODE_FULL else _MA_DISPERSION_FIELDS[:-1]
    structure_score, _, _ = _ma_structure_components(row, structure_fields)
    return _ma_dispersion_score(pattern, structure_score), pattern, meaning


def _ma_dispersion_detail(
    status: str,
    meaning: str,
    composite: str,
) -> str:
    if status == "数据不足":
        return meaning
    return "\n".join([
        f"{status} · {meaning}",
        f"综合: {composite}",
    ])


def _trend_scope_note(scope: str) -> str:
    return {
        _TREND_DATA_MODE_FULL: "",
        _TREND_DATA_MODE_MEDIUM: " (MA120暂不可用)",
        _TREND_DATA_MODE_SHORT: " (MA60/MA120暂不可用)",
        _TREND_DATA_MODE_INSUFFICIENT: " (均线样本不足)",
    }.get(scope, "")


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
    category_score = round(score) if category_available and score is not None else None
    return {
        "id": category_id,
        "name": meta["name"],
        "kind": meta["kind"],
        "weight": meta["weight"],
        "score": category_score,
        "status": _trend_score_status(category_score) if category_id == "trend" else None,
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


def _macd_normalized(value: float | None, close: float | None) -> float | None:
    if value is None or close is None or close <= 0:
        return None
    return value / close * 100.0


def _macd_zero_axis(dif: float | None, dea: float | None) -> str:
    if dif is None or dea is None:
        return "UNKNOWN"
    if abs(dif) <= _MACD_ZERO_NEAR_BAND_PCT and abs(dea) <= _MACD_ZERO_NEAR_BAND_PCT:
        return "NEAR"
    if dif > _MACD_ZERO_BAND_PCT and dea > _MACD_ZERO_BAND_PCT:
        return "ABOVE"
    if dif < -_MACD_ZERO_BAND_PCT and dea < -_MACD_ZERO_BAND_PCT:
        return "BELOW"
    return "CROSSING"


def _macd_events(records: list[dict], index: int) -> list[str]:
    if index <= 0:
        return []
    row = records[index]
    previous = records[index - 1]
    dif = _number(row.get("macd_dif"))
    dea = _number(row.get("macd_dea"))
    previous_dif = _number(previous.get("macd_dif"))
    previous_dea = _number(previous.get("macd_dea"))
    if None in (dif, dea, previous_dif, previous_dea):
        return []

    events: list[str] = []
    if previous_dif <= previous_dea and dif > dea:
        events.append("GOLDEN_CROSS")
    elif previous_dif >= previous_dea and dif < dea:
        events.append("DEATH_CROSS")
    if previous_dif <= 0 < dif:
        events.append("DIF_CROSS_ZERO_UP")
    elif previous_dif >= 0 > dif:
        events.append("DIF_CROSS_ZERO_DOWN")
    if previous_dea <= 0 < dea:
        events.append("DEA_CROSS_ZERO_UP")
    elif previous_dea >= 0 > dea:
        events.append("DEA_CROSS_ZERO_DOWN")
    return events


def _macd_cross_count(records: list[dict], index: int) -> int:
    start = max(1, index - _MACD_CROSS_LOOKBACK + 1)
    count = 0
    for position in range(start, index + 1):
        current = records[position]
        previous = records[position - 1]
        dif = _number(current.get("macd_dif"))
        dea = _number(current.get("macd_dea"))
        previous_dif = _number(previous.get("macd_dif"))
        previous_dea = _number(previous.get("macd_dea"))
        if None in (dif, dea, previous_dif, previous_dea):
            continue
        if (previous_dif <= previous_dea and dif > dea) or (previous_dif >= previous_dea and dif < dea):
            count += 1
    return count


def _macd_momentum_state(hist: float | None, previous_hist: float | None) -> str:
    if hist is None:
        return "INSUFFICIENT"
    if abs(hist) <= _MACD_HIST_FLAT_BAND_PCT or previous_hist is None:
        return "FLAT"
    change = hist - previous_hist
    if abs(change) <= _MACD_HIST_CHANGE_FLAT_BAND_PCT:
        return "FLAT"
    if hist > 0:
        return "BULL_EXPANDING" if change > 0 else "BULL_SHRINKING"
    return "BEAR_EXPANDING" if change < 0 else "BEAR_SHRINKING"


def _macd_pivot_indices(
    records: list[dict],
    index: int,
    mode: str,
    *,
    lookback: int = _MACD_DIVERGENCE_LOOKBACK,
) -> list[int]:
    radius = _MACD_DIVERGENCE_PIVOT_RADIUS
    start = max(radius, index - lookback)
    stop = index - radius
    pivots: list[int] = []
    for pivot in range(start, stop + 1):
        center = _number(records[pivot].get("close"))
        if center is None or center <= 0:
            continue
        neighbors = [
            _number(records[position].get("close"))
            for position in range(pivot - radius, pivot + radius + 1)
            if position != pivot
        ]
        if any(value is None for value in neighbors):
            continue
        if (mode == "high" and all(value < center for value in neighbors if value is not None)) or (
            mode == "low" and all(value > center for value in neighbors if value is not None)
        ):
            pivots.append(pivot)
    return pivots


def _macd_divergence(records: list[dict], index: int) -> dict[str, float | int | str] | None:
    radius = _MACD_DIVERGENCE_PIVOT_RADIUS
    if index < radius * 2:
        return None

    candidates: list[dict[str, float | int | str]] = []
    for mode, kind in (("high", "TOP_DIVERGENCE"), ("low", "BOTTOM_DIVERGENCE")):
        pivots = _macd_pivot_indices(
            records,
            index,
            mode,
            lookback=_MACD_DIVERGENCE_HISTORY_LOOKBACK,
        )
        for left, right in reversed(list(pairwise(pivots))):
            confirmation = right + radius
            if confirmation > index:
                continue
            left_close = _number(records[left].get("close"))
            right_close = _number(records[right].get("close"))
            left_dif = _macd_normalized(_number(records[left].get("macd_dif")), left_close)
            right_dif = _macd_normalized(_number(records[right].get("macd_dif")), right_close)
            if None in (left_close, right_close, left_dif, right_dif):
                continue
            price_change_pct = (right_close / left_close - 1.0) * 100.0
            dif_change_pct = right_dif - left_dif
            if mode == "high":
                divergent = (
                    price_change_pct >= _MACD_DIVERGENCE_PRICE_CHANGE_PCT
                    and left_dif > _MACD_ZERO_BAND_PCT
                    and right_dif > _MACD_ZERO_BAND_PCT
                    and dif_change_pct <= -_MACD_DIVERGENCE_DIF_CHANGE_PCT
                )
            else:
                divergent = (
                    price_change_pct <= -_MACD_DIVERGENCE_PRICE_CHANGE_PCT
                    and left_dif < -_MACD_ZERO_BAND_PCT
                    and right_dif < -_MACD_ZERO_BAND_PCT
                    and dif_change_pct >= _MACD_DIVERGENCE_DIF_CHANGE_PCT
                )
            if divergent:
                candidates.append({
                    "kind": kind,
                    "price_change_pct": price_change_pct,
                    "dif_change_pct": dif_change_pct,
                    "pivot_age": index - right,
                    "confirmation_lag": radius,
                    "confirmation_index": confirmation,
                })
    return max(candidates, key=lambda item: item["confirmation_index"]) if candidates else None


def _macd_event_label(event: str | None, zero_axis: str, dif: float, dea: float) -> str:
    if event in {"GOLDEN_CROSS", "DEATH_CROSS"} and zero_axis in {"ABOVE", "BELOW"}:
        axis_prefix = {"ABOVE": "零轴上", "BELOW": "零轴下"}[zero_axis]
        return f"{axis_prefix}{_MACD_EVENT_LABELS[event]}"
    if event is not None:
        return _MACD_EVENT_LABELS[event]
    if dif > dea:
        return "DIF在DEA上方"
    if dif < dea:
        return "DIF在DEA下方"
    return "DIF/DEA暂未分出方向"


def _macd_analysis(records: list[dict], index: int) -> dict:
    row = records[index]
    previous = records[index - 1] if index > 0 else {}
    close = _number(row.get("close"))
    dif = _number(row.get("macd_dif"))
    dea = _number(row.get("macd_dea"))
    hist = _number(row.get("macd_hist"))
    previous_dif = _number(previous.get("macd_dif"))
    previous_dea = _number(previous.get("macd_dea"))
    previous_hist = _number(previous.get("macd_hist"))
    previous_close = _number(previous.get("close"))
    normalized_dif = _macd_normalized(dif, close)
    normalized_dea = _macd_normalized(dea, close)
    normalized_hist = _macd_normalized(hist, close)
    previous_normalized_dif = _macd_normalized(previous_dif, previous_close)
    previous_normalized_dea = _macd_normalized(previous_dea, previous_close)
    previous_normalized_hist = _macd_normalized(previous_hist, previous_close)
    hist_change = (
        normalized_hist - previous_normalized_hist
        if normalized_hist is not None and previous_normalized_hist is not None
        else None
    )
    raw_values = _raw_values(
        dif=dif,
        dea=dea,
        hist=hist,
        previous_dif=previous_dif,
        previous_dea=previous_dea,
        previous_hist=previous_hist,
        dif_pct=normalized_dif,
        dea_pct=normalized_dea,
        hist_pct=normalized_hist,
        previous_dif_pct=previous_normalized_dif,
        previous_dea_pct=previous_normalized_dea,
        previous_hist_pct=previous_normalized_hist,
        hist_change_pct=hist_change,
    )
    if None in (close, dif, dea, hist, normalized_dif, normalized_dea, normalized_hist):
        return {
            "state": "INSUFFICIENT",
            "status": _MACD_STATE_LABELS["INSUFFICIENT"],
            "event": None,
            "events": [],
            "crossover": None,
            "zero_axis": "UNKNOWN",
            "momentum": "INSUFFICIENT",
            "divergence": None,
            "recent_divergence": None,
            "recent_divergence_as_of": None,
            "tags": [],
            "confidence": 0,
            "summary": "数据不足",
            "raw_values": raw_values,
        }

    zero_axis = _macd_zero_axis(normalized_dif, normalized_dea)
    events = _macd_events(records, index)
    crossover = next((event for event in events if event in {"GOLDEN_CROSS", "DEATH_CROSS"}), None)
    event = events[0] if events else None
    momentum = _macd_momentum_state(normalized_hist, previous_normalized_hist)
    recent_divergence_info = _macd_divergence(records, index)
    divergence_info = (
        recent_divergence_info
        if recent_divergence_info is not None
        and index - int(recent_divergence_info["confirmation_index"]) <= _MACD_DIVERGENCE_ACTIVE_BARS
        else None
    )
    divergence = divergence_info["kind"] if divergence_info is not None else None
    recent_divergence = recent_divergence_info["kind"] if recent_divergence_info is not None else None
    recent_confirmation_index = (
        int(recent_divergence_info["confirmation_index"])
        if recent_divergence_info is not None
        else None
    )
    recent_divergence_as_of = (
        str(records[recent_confirmation_index].get("date"))[:10]
        if recent_confirmation_index is not None and records[recent_confirmation_index].get("date") is not None
        else None
    )
    cross_count = _macd_cross_count(records, index)
    dif_rising = previous_normalized_dif is not None and normalized_dif > previous_normalized_dif
    dif_falling = previous_normalized_dif is not None and normalized_dif < previous_normalized_dif

    bullish_relation = dif > dea
    bearish_relation = dif < dea
    strong_bull = (
        zero_axis == "ABOVE"
        and bullish_relation
        and normalized_hist > _MACD_HIST_FLAT_BAND_PCT
        and (
            momentum == "BULL_EXPANDING"
            or dif_rising
        )
    )
    strong_bear = (
        zero_axis == "BELOW"
        and bearish_relation
        and normalized_hist < -_MACD_HIST_FLAT_BAND_PCT
        and (
            momentum == "BEAR_EXPANDING"
            or dif_falling
        )
    )
    if zero_axis == "NEAR" and (abs(normalized_hist) <= _MACD_HIST_FLAT_BAND_PCT or cross_count >= 3):
        state = "RANGE"
    elif strong_bull:
        state = "STRONG_BULL"
    elif strong_bear:
        state = "STRONG_BEAR"
    elif zero_axis == "BELOW" and bearish_relation and momentum == "BEAR_SHRINKING":
        state = "RECOVERY"
    elif zero_axis == "ABOVE" and bullish_relation and momentum == "BULL_SHRINKING":
        state = "TURNING_BEARISH"
    elif bullish_relation and (
        crossover == "GOLDEN_CROSS"
        or "DIF_CROSS_ZERO_UP" in events
        or "DEA_CROSS_ZERO_UP" in events
        or momentum == "BULL_EXPANDING"
        or (zero_axis == "BELOW" and dif_rising)
    ):
        state = "TURNING_BULLISH"
    elif bearish_relation and (
        crossover == "DEATH_CROSS"
        or "DIF_CROSS_ZERO_DOWN" in events
        or "DEA_CROSS_ZERO_DOWN" in events
        or momentum == "BEAR_EXPANDING"
        or (zero_axis == "ABOVE" and dif_falling)
    ):
        state = "TURNING_BEARISH"
    elif bullish_relation:
        state = "TURNING_BULLISH"
    elif bearish_relation:
        state = "TURNING_BEARISH"
    else:
        state = "RANGE"

    zero_axis_tag = {
        "ABOVE": "ABOVE_ZERO",
        "BELOW": "BELOW_ZERO",
        "NEAR": "NEAR_ZERO",
        "CROSSING": "CROSSING_ZERO",
    }[zero_axis]
    tags = [zero_axis_tag, *events]
    if momentum != "FLAT":
        tags.append(momentum)
    if divergence is not None:
        tags.append(divergence)
    event_label = _macd_event_label(event, zero_axis, dif, dea)
    momentum_label = _MACD_MOMENTUM_LABELS[momentum]
    summary_parts = [event_label, momentum_label]
    if divergence is not None:
        summary_parts.append(_MACD_DIVERGENCE_LABELS[divergence])
    raw_values.update(_raw_values(
        divergence_price_change_pct=divergence_info.get("price_change_pct") if divergence_info else None,
        divergence_dif_change_pct=divergence_info.get("dif_change_pct") if divergence_info else None,
        divergence_pivot_age=divergence_info.get("pivot_age") if divergence_info else None,
        divergence_confirmation_lag=divergence_info.get("confirmation_lag") if divergence_info else None,
    ))
    return {
        "state": state,
        "status": _MACD_STATE_LABELS[state],
        "event": event,
        "events": events,
        "crossover": crossover,
        "zero_axis": zero_axis,
        "momentum": momentum,
        "divergence": divergence,
        "recent_divergence": recent_divergence,
        "recent_divergence_as_of": recent_divergence_as_of,
        "tags": tags,
        # This is input completeness, not a reversal probability.
        "confidence": 100 if None not in (
            previous_dif,
            previous_dea,
            previous_hist,
            previous_normalized_dif,
            previous_normalized_dea,
            previous_normalized_hist,
        ) else 80,
        "summary": " · ".join(summary_parts),
        "raw_values": raw_values,
    }


def _build_roc_context(records: list[dict]) -> _RocContext:
    """Precompute ROC series and confirmed price pivots for one symbol.

    Rich ROC analysis queries the same values across rolling history, slope and
    divergence windows. Keeping these arrays local to one scoring call avoids
    repeated dict parsing while remaining safe for concurrent requests.
    """
    closes = [_number(record.get("close")) for record in records]
    values_by_period: dict[int, list[float | None]] = {}
    pivots: dict[tuple[int, str], list[int]] = {}
    radius = _ROC_DIVERGENCE_PIVOT_RADIUS

    for period, field, _ in _ROC_PERIODS:
        values: list[float | None] = []
        for index, record in enumerate(records):
            value = _number(record.get(field))
            if value is None and index >= period:
                current = closes[index]
                base = closes[index - period]
                if current is not None and base is not None and base > 0:
                    value = current / base - 1.0
            values.append(value)
        values_by_period[period] = values

        high_pivots: list[int] = []
        low_pivots: list[int] = []
        for pivot in range(radius, max(radius, len(records) - radius)):
            center = closes[pivot]
            if center is None or center <= 0 or values[pivot] is None:
                continue
            neighbors = [
                closes[position]
                for position in range(pivot - radius, pivot + radius + 1)
                if position != pivot
            ]
            if any(value is None for value in neighbors):
                continue
            if all(value < center for value in neighbors if value is not None):
                high_pivots.append(pivot)
            if all(value > center for value in neighbors if value is not None):
                low_pivots.append(pivot)
        pivots[(period, "high")] = high_pivots
        pivots[(period, "low")] = low_pivots

    return _RocContext(values=values_by_period, pivots=pivots)


def _roc_value(
    records: list[dict],
    index: int,
    period: int,
    context: _RocContext | None = None,
) -> float | None:
    if index < 0 or index >= len(records):
        return None
    if context is not None and period in context.values:
        return context.values[period][index]
    field = _ROC_FIELD_BY_PERIOD.get(period, f"momentum_{period}d")
    value = _number(records[index].get(field))
    if value is not None:
        return value
    if index < period:
        return None
    current = _number(records[index].get("close"))
    base = _number(records[index - period].get("close"))
    if current is None or base is None or base <= 0:
        return None
    return current / base - 1.0


def _roc_slope_context(
    records: list[dict],
    index: int,
    period: int,
    current: float | None,
    context: _RocContext | None = None,
) -> tuple[float, float]:
    deltas: list[float] = []
    start = max(1, index - _ROC_SLOPE_LOOKBACK + 1)
    for position in range(start, index):
        value = _roc_value(records, position, period, context)
        previous = _roc_value(records, position - 1, period, context)
        if value is not None and previous is not None:
            deltas.append(abs(value - previous))
    baseline = _median(deltas)
    if baseline is None or baseline <= 0:
        baseline = max(abs(current or 0.0) * 0.25, _ROC_ACCELERATION_MIN)
    flat_band = max(_ROC_SLOPE_FLAT_BAND, baseline * 0.10)
    acceleration = max(_ROC_ACCELERATION_MIN, baseline * _ROC_ACCELERATION_MULTIPLIER)
    return flat_band, acceleration


def _roc_history(
    records: list[dict],
    index: int,
    period: int,
    current: float | None,
    context: _RocContext | None = None,
) -> tuple[float | None, int, float | None, float | None]:
    values = [
        value
        for position in range(max(0, index - _ROC_HISTORY_LOOKBACK + 1), index + 1)
        if (value := _roc_value(records, position, period, context)) is not None
    ]
    if current is None or len(values) < _ROC_HISTORY_MIN_SAMPLES:
        return None, len(values), None, None
    ordered = sorted(values)
    if ordered[-1] - ordered[0] <= _ROC_SLOPE_FLAT_BAND:
        return None, len(values), None, None

    less_count = sum(value < current for value in ordered)
    equal_count = sum(value == current for value in ordered)
    percentile = (less_count + equal_count * 0.5) / len(ordered) * 100.0

    def quantile(ratio: float) -> float:
        position = (len(ordered) - 1) * ratio
        lower = math.floor(position)
        upper = math.ceil(position)
        if lower == upper:
            return ordered[lower]
        fraction = position - lower
        return ordered[lower] + (ordered[upper] - ordered[lower]) * fraction

    return percentile, len(values), quantile(0.05), quantile(0.95)


def _roc_pivot_indices(
    records: list[dict],
    index: int,
    period: int,
    mode: str,
    *,
    lookback: int = _ROC_DIVERGENCE_LOOKBACK,
    context: _RocContext | None = None,
) -> list[int]:
    radius = _ROC_DIVERGENCE_PIVOT_RADIUS
    start = max(radius, index - lookback)
    stop = index - radius
    if context is not None:
        candidates = context.pivots.get((period, mode), [])
        left = bisect_left(candidates, start)
        right = bisect_right(candidates, stop)
        return candidates[left:right]
    pivots: list[int] = []
    for pivot in range(start, stop + 1):
        center = _number(records[pivot].get("close"))
        roc = _roc_value(records, pivot, period)
        if center is None or center <= 0 or roc is None:
            continue
        neighbors = [
            _number(records[position].get("close"))
            for position in range(pivot - radius, pivot + radius + 1)
            if position != pivot
        ]
        if any(value is None for value in neighbors):
            continue
        if (mode == "high" and all(value < center for value in neighbors if value is not None)) or (
            mode == "low" and all(value > center for value in neighbors if value is not None)
        ):
            pivots.append(pivot)
    return pivots


def _roc_divergence(
    records: list[dict],
    index: int,
    period: int,
    context: _RocContext | None = None,
) -> dict[str, float | int | str] | None:
    radius = _ROC_DIVERGENCE_PIVOT_RADIUS
    if index < radius * 2:
        return None

    candidates: list[dict[str, float | int | str]] = []
    for mode in ("high", "low"):
        pivots = _roc_pivot_indices(records, index, period, mode, context=context)
        for left, right in reversed(list(pairwise(pivots))):
            confirmation = right + radius
            if confirmation > index:
                continue
            left_close = _number(records[left].get("close"))
            right_close = _number(records[right].get("close"))
            left_roc = _roc_value(records, left, period, context)
            right_roc = _roc_value(records, right, period, context)
            if None in (left_close, right_close, left_roc, right_roc):
                continue
            price_change_pct = (right_close / left_close - 1.0) * 100.0
            roc_change_pct_points = (right_roc - left_roc) * 100.0
            if mode == "high":
                divergent = (
                    price_change_pct >= _ROC_DIVERGENCE_PRICE_CHANGE_PCT
                    and left_roc > 0
                    and right_roc > 0
                    and roc_change_pct_points <= -_ROC_DIVERGENCE_VALUE_CHANGE_PCT_POINTS
                )
                kind = "TOP_DIVERGENCE"
            else:
                divergent = (
                    price_change_pct <= -_ROC_DIVERGENCE_PRICE_CHANGE_PCT
                    and left_roc < 0
                    and right_roc < 0
                    and roc_change_pct_points >= _ROC_DIVERGENCE_VALUE_CHANGE_PCT_POINTS
                )
                kind = "BOTTOM_DIVERGENCE"
            if divergent:
                candidates.append({
                    "kind": kind,
                    "price_change_pct": price_change_pct,
                    "roc_change_pct_points": roc_change_pct_points,
                    "pivot_age": index - right,
                    "confirmation_lag": radius,
                    "confirmation_index": confirmation,
                })
    return max(candidates, key=lambda item: item["confirmation_index"]) if candidates else None


def _roc_period_state(
    value: float | None,
    previous: float | None,
    change: float | None,
    flat_band: float,
    acceleration: float,
) -> tuple[str, str | None]:
    if value is None:
        return "INSUFFICIENT", None
    if previous is None or change is None:
        return "INSUFFICIENT", None
    if previous <= 0 < value:
        return "TURNING_BULLISH", "ROC_CROSS_ZERO_UP"
    if previous >= 0 > value:
        return "TURNING_BEARISH", "ROC_CROSS_ZERO_DOWN"
    if value == 0:
        return "NEUTRAL", None
    if value > 0:
        if change > acceleration:
            return "STRONG_BULL_ACCEL", None
        if change < -flat_band:
            return "BULL_DECAY", None
        return "BULL_RUN", None
    if change < -acceleration:
        return "STRONG_BEAR_ACCEL", None
    if change > flat_band:
        return "BEAR_DECAY", None
    return "BEAR_RUN", None


def _roc_period_analysis(
    records: list[dict],
    index: int,
    period: int,
    weight: float,
    context: _RocContext | None = None,
) -> dict:
    value = _roc_value(records, index, period, context)
    previous = _roc_value(records, index - 1, period, context)
    change = value - previous if value is not None and previous is not None else None
    flat_band, acceleration = _roc_slope_context(records, index, period, value, context)
    state, event = _roc_period_state(value, previous, change, flat_band, acceleration)
    score = _ROC_STATE_SCORES.get(state, _sign_score(value))
    percentile, history_count, history_q05, history_q95 = _roc_history(
        records,
        index,
        period,
        value,
        context,
    )
    extreme = None
    if value is not None and percentile is not None:
        if value > 0 and percentile >= 100.0 - _ROC_EXTREME_PERCENTILE:
            extreme = "EXTREME_OVERBOUGHT"
        elif value < 0 and percentile <= _ROC_EXTREME_PERCENTILE:
            extreme = "EXTREME_OVERSOLD"

    recent_divergence_info = _roc_divergence(records, index, period, context)
    divergence_info = (
        recent_divergence_info
        if recent_divergence_info is not None
        and index - int(recent_divergence_info["confirmation_index"]) <= _ROC_DIVERGENCE_ACTIVE_BARS
        else None
    )
    recent_divergence = recent_divergence_info["kind"] if recent_divergence_info is not None else None
    divergence = divergence_info["kind"] if divergence_info is not None else None
    recent_confirmation_index = (
        int(recent_divergence_info["confirmation_index"])
        if recent_divergence_info is not None
        else None
    )
    recent_divergence_as_of = (
        str(records[recent_confirmation_index].get("date"))[:10]
        if recent_confirmation_index is not None and records[recent_confirmation_index].get("date") is not None
        else None
    )
    period_tags: list[str] = []
    if event is not None:
        period_tags.append(event)
    if extreme is not None:
        period_tags.append(extreme)
    if divergence is not None:
        period_tags.append(divergence)

    summary_parts = [_ROC_STATE_LABELS[state]]
    if event is not None:
        summary_parts.append(_ROC_EVENT_LABELS[event])
    if extreme is not None:
        summary_parts.append(_ROC_EXTREME_LABELS[extreme])
    if divergence is not None:
        summary_parts.append(_ROC_DIVERGENCE_LABELS[divergence])
    return {
        "period": period,
        "weight": weight,
        "value": value,
        "previous_value": previous,
        "change": change,
        "value_pct": value * 100.0 if value is not None else None,
        "previous_value_pct": previous * 100.0 if previous is not None else None,
        "change_pct_points": change * 100.0 if change is not None else None,
        "state": state,
        "status": _ROC_STATE_LABELS[state],
        "event": event,
        "percentile": percentile,
        "history_count": history_count,
        "history_q05_pct": history_q05 * 100.0 if history_q05 is not None else None,
        "history_q95_pct": history_q95 * 100.0 if history_q95 is not None else None,
        "extreme": extreme,
        "divergence": divergence,
        "recent_divergence": recent_divergence,
        "recent_divergence_as_of": recent_divergence_as_of,
        "divergence_confirmation_index": (
            int(divergence_info["confirmation_index"]) if divergence_info is not None else None
        ),
        "recent_divergence_confirmation_index": recent_confirmation_index,
        "divergence_price_change_pct": (
            divergence_info.get("price_change_pct") if divergence_info is not None else None
        ),
        "divergence_roc_change_pct_points": (
            divergence_info.get("roc_change_pct_points") if divergence_info is not None else None
        ),
        "divergence_pivot_age": (
            divergence_info.get("pivot_age") if divergence_info is not None else None
        ),
        "divergence_confirmation_lag": (
            divergence_info.get("confirmation_lag") if divergence_info is not None else None
        ),
        "tags": period_tags,
        "score": score,
        "summary": " · ".join(summary_parts),
    }


def _roc_summary(periods: list[dict]) -> str:
    by_period = {int(item["period"]): item for item in periods}
    roc5 = by_period.get(5)
    roc20 = by_period.get(20)
    roc60 = by_period.get(60)

    def usable(item: dict | None) -> bool:
        return item is not None and item.get("value") is not None and item.get("state") != "INSUFFICIENT"

    short_mid_items = (roc5, roc20)
    usable_short_mid = [item for item in short_mid_items if usable(item)]
    if len(usable_short_mid) < 2:
        short_mid = "短中期动能数据不足" if not usable_short_mid else "短中期动能数据不完整"
    else:
        assert roc5 is not None and roc20 is not None
        bearish_states = {"STRONG_BEAR_ACCEL", "BEAR_RUN"}
        if roc5["state"] in bearish_states and roc20["state"] in bearish_states:
            if roc20.get("extreme") == "EXTREME_OVERSOLD":
                short_mid = "短中期动能继续走弱, ROC20 已进入极端超跌"
            elif any(item.get("extreme") == "EXTREME_OVERSOLD" for item in (roc5, roc20)):
                short_mid = "短中期动能继续走弱, 并已进入超跌区域"
            else:
                short_mid = "短中期动能继续走弱"
        elif roc5["state"] == "BEAR_DECAY" and roc20["state"] == "BEAR_DECAY":
            short_mid = "短中期仍处弱势, 但下跌动能正在明显减弱"
        elif roc5["state"] == "TURNING_BULLISH" and float(roc20["value"]) < 0:
            short_mid = "短期动能率先转强, 但中期仍处弱势"
        elif float(roc5["value"]) > 0 and float(roc20["value"]) > 0:
            short_mid = "短中期动能保持偏强"
        else:
            short_mid = "短中期动能分化"

    if not usable(roc60):
        long_term = "长期 ROC60 数据不足"
    else:
        assert roc60 is not None
        value = float(roc60["value"])
        state = roc60["state"]
        if value > 0:
            if state == "BULL_DECAY":
                change = roc60.get("change_pct_points")
                if change is not None and float(change) <= -3.0:
                    long_term = "长期 ROC60 仍为正, 但多头动能正在快速衰减"
                else:
                    long_term = "长期 ROC60 仍为正, 但多头动能有所衰减"
            elif state == "STRONG_BULL_ACCEL":
                long_term = "长期 ROC60 保持正值, 多头动能仍在增强"
            else:
                long_term = "长期 ROC60 仍保持正动能"
        elif value < 0:
            long_term = (
                "长期 ROC60 仍为负, 但空头动能正在减弱"
                if state == "BEAR_DECAY"
                else "长期 ROC60 已转为负动能"
            )
        else:
            long_term = "长期 ROC60 处于零轴附近"

    return f"{short_mid}; {long_term}."


def _roc_analysis(
    records: list[dict],
    index: int,
    context: _RocContext | None = None,
) -> dict:
    context = context or _build_roc_context(records)
    periods = [
        _roc_period_analysis(records, index, period, weight, context)
        for period, _, weight in _ROC_PERIODS
    ]
    score, coverage = _weighted_mean([
        (item["score"], item["weight"])
        for item in periods
    ])
    direction_score, _ = _weighted_mean([
        (_sign_score(item["value"]), item["weight"])
        for item in periods
    ])
    current_periods = [item for item in periods if item["value"] is not None]
    stateful_periods = [
        item for item in current_periods
        if item["state"] != "INSUFFICIENT"
    ]
    bullish_weight = sum(float(item["weight"]) for item in current_periods if item["value"] > 0)
    bearish_weight = sum(float(item["weight"]) for item in current_periods if item["value"] < 0)
    neutral_weight = sum(float(item["weight"]) for item in current_periods if item["value"] == 0)

    def dominant_state(candidates: list[dict]) -> str:
        if not candidates:
            return "NEUTRAL"
        return max(
            candidates,
            key=lambda item: (float(item["weight"]), int(item["period"])),
        )["state"]

    bullish_states = [item for item in stateful_periods if item["value"] > 0]
    bearish_states = [item for item in stateful_periods if item["value"] < 0]
    if not stateful_periods:
        state = "INSUFFICIENT"
    elif bullish_weight > 0 and bearish_weight == 0:
        state = dominant_state(bullish_states)
    elif bearish_weight > 0 and bullish_weight == 0:
        state = dominant_state(bearish_states)
    elif bullish_weight >= 0.60 and bullish_weight > bearish_weight:
        state = dominant_state(bullish_states)
    elif bearish_weight >= 0.60 and bearish_weight > bullish_weight:
        state = dominant_state(bearish_states)
    else:
        state = "MIXED"

    if bullish_weight > 0 and bearish_weight > 0:
        direction = "MIXED"
    elif bullish_weight > 0:
        direction = "POSITIVE"
    elif bearish_weight > 0:
        direction = "NEGATIVE"
    elif neutral_weight > 0:
        direction = "NEUTRAL"
    else:
        direction = "INSUFFICIENT"

    event_periods = [item for item in current_periods if item["event"] is not None]
    events: list[str] = []
    for item in event_periods:
        if item["event"] not in events:
            events.append(item["event"])
    selected_event = (
        max(event_periods, key=lambda item: (float(item["weight"]), int(item["period"])))
        if event_periods
        else None
    )
    event = selected_event["event"] if selected_event is not None else None
    event_period = selected_event["period"] if selected_event is not None else None

    extreme_periods = [item for item in current_periods if item["extreme"] is not None]
    extreme_weights = {
        extreme: sum(float(item["weight"]) for item in extreme_periods if item["extreme"] == extreme)
        for extreme in _ROC_EXTREME_LABELS
    }
    extreme = max(extreme_weights, key=extreme_weights.get) if extreme_periods else None
    if extreme is not None and extreme_weights[extreme] == 0:
        extreme = None

    active_divergences = [item for item in current_periods if item["divergence"] is not None]
    selected_divergence = (
        max(
            active_divergences,
            key=lambda item: (
                int(item["divergence_confirmation_index"] or -1),
                float(item["weight"]),
            ),
        )
        if active_divergences
        else None
    )
    divergence = selected_divergence["divergence"] if selected_divergence is not None else None
    divergence_period = selected_divergence["period"] if selected_divergence is not None else None

    recent_divergences = [item for item in current_periods if item["recent_divergence"] is not None]
    selected_recent_divergence = (
        max(
            recent_divergences,
            key=lambda item: (
                int(item["recent_divergence_confirmation_index"] or -1),
                float(item["weight"]),
            ),
        )
        if recent_divergences
        else None
    )
    recent_divergence = (
        selected_recent_divergence["recent_divergence"]
        if selected_recent_divergence is not None
        else None
    )
    recent_divergence_as_of = (
        selected_recent_divergence["recent_divergence_as_of"]
        if selected_recent_divergence is not None
        else None
    )

    tags: list[str] = []
    for item in current_periods:
        period_label = f"ROC{item['period']}"
        for tag in item["tags"]:
            tagged = f"{period_label}_{tag}"
            if tagged not in tags:
                tags.append(tagged)
    for tag in (event, extreme, divergence):
        if tag is not None and tag not in tags:
            tags.append(tag)

    raw_kwargs: dict[str, object] = {}
    for item in periods:
        period = item["period"]
        raw_kwargs.update({
            f"momentum_{period}": item["value"],
            f"roc_{period}_pct": item["value_pct"],
            f"previous_roc_{period}_pct": item["previous_value_pct"],
            f"roc_{period}_change_pct_points": item["change_pct_points"],
            f"roc_{period}_percentile": item["percentile"],
            f"roc_{period}_history_count": item["history_count"],
            f"roc_{period}_history_q05_pct": item["history_q05_pct"],
            f"roc_{period}_history_q95_pct": item["history_q95_pct"],
            f"roc_{period}_divergence_price_change_pct": item["divergence_price_change_pct"],
            f"roc_{period}_divergence_change_pct_points": item["divergence_roc_change_pct_points"],
            f"roc_{period}_divergence_pivot_age": item["divergence_pivot_age"],
            f"roc_{period}_divergence_confirmation_lag": item["divergence_confirmation_lag"],
        })

    confidence = 0
    if current_periods:
        confidence = 100 if all(item["previous_value"] is not None for item in current_periods) else 80
    return {
        "state": state,
        "status": _ROC_STATE_LABELS[state],
        "event": event,
        "event_period": event_period,
        "events": events,
        "direction": direction,
        "direction_label": _ROC_DIRECTION_LABELS[direction],
        "extreme": extreme,
        "extreme_periods": [item["period"] for item in extreme_periods],
        "divergence": divergence,
        "divergence_period": divergence_period,
        "recent_divergence": recent_divergence,
        "recent_divergence_as_of": recent_divergence_as_of,
        "tags": tags,
        "confidence": confidence,
        "score": score,
        "direction_score": direction_score,
        "coverage": coverage,
        "summary": _roc_summary(periods),
        "detail": "识别 5/20/60 周期 ROC 的方向、斜率、零轴穿越、历史分位与价格背离",
        "periods": periods,
        "raw_values": _raw_values(**raw_kwargs),
    }


def _category_scores(
    records: list[dict],
    index: int,
    roc_context: _RocContext | None = None,
) -> dict:
    row = records[index]
    previous = records[index - 1] if index > 0 else {}

    trend_mode = _trend_data_mode(records, index)
    indicator_scope = trend_mode if trend_mode != _TREND_DATA_MODE_INSUFFICIENT else _ma_indicator_scope(row)
    scope_note = _trend_scope_note(indicator_scope)
    alignment_score, alignment_status, _ = _ma_alignment_state(records, index, scope=indicator_scope)
    alignment_meaning = _MA_ALIGNMENT_STATE_MEANINGS.get(alignment_status, "数据不足")
    alignment_fields_label = {
        _TREND_DATA_MODE_FULL: "MA5/10/20/60/120",
        _TREND_DATA_MODE_MEDIUM: "MA5/10/20/60",
        _TREND_DATA_MODE_SHORT: "MA5/10/20",
    }.get(indicator_scope, "MA5/10/20")

    slope_fields = (
        _MA_SLOPE_FIELDS
        if indicator_scope in {_TREND_DATA_MODE_FULL, _TREND_DATA_MODE_MEDIUM}
        else tuple(field for field in ("ma5", "ma20") if _number(row.get(field)) is not None)
    )
    slope_components = _ma_slope_components(records, index, slope_fields)
    slope_score, _ = _weighted_mean([(component[0], 1.0) for component in slope_components.values()])
    slope_meaning = "\n".join(
        _ma_slope_detail(field, component[1])
        for field, component in slope_components.items()
        if component[0] is not None
    ) or "数据不足"
    slope_status = _score_status(slope_score)

    close = _number(row.get("close"))
    ma20 = _number(row.get("ma20"))
    ma60 = _number(row.get("ma60"))
    ma120 = _number(row.get("ma120"))
    atr14 = _number(row.get("atr_14"))
    price_position_score, price_position_status, price_position_meaning = _price_position_state(
        close,
        ma20,
        ma60,
        ma120,
        scope=indicator_scope,
    )
    price_position_detail = _price_position_detail(
        price_position_status,
        price_position_meaning,
    )
    ma_dispersion_short_spread = _ma_dispersion_spread(row, _MA_DISPERSION_SHORT_FIELDS)
    dispersion_long_fields = {
        _TREND_DATA_MODE_FULL: _MA_DISPERSION_LONG_FIELDS,
        _TREND_DATA_MODE_MEDIUM: _MA_DISPERSION_MEDIUM_FIELDS,
    }.get(indicator_scope)
    ma_dispersion_long_spread = (
        _ma_dispersion_spread(row, dispersion_long_fields)
        if dispersion_long_fields is not None
        else None
    )
    ma_dispersion_short_change = _ma_dispersion_change(records, index, _MA_DISPERSION_SHORT_FIELDS)
    ma_dispersion_long_change = (
        _ma_dispersion_change(records, index, dispersion_long_fields)
        if dispersion_long_fields is not None
        else None
    )
    ma_dispersion_short_baseline = (
        _ma_dispersion_spread(records[index - _MA_DISPERSION_CONFIRMATION_LAG], _MA_DISPERSION_SHORT_FIELDS)
        if index >= _MA_DISPERSION_CONFIRMATION_LAG
        else None
    )
    ma_dispersion_long_baseline = (
        _ma_dispersion_spread(records[index - _MA_DISPERSION_CONFIRMATION_LAG], dispersion_long_fields)
        if dispersion_long_fields is not None and index >= _MA_DISPERSION_CONFIRMATION_LAG
        else None
    )
    structure_fields = {
        _TREND_DATA_MODE_FULL: _MA_DISPERSION_FIELDS,
        _TREND_DATA_MODE_MEDIUM: _MA_DISPERSION_FIELDS[:-1],
        _TREND_DATA_MODE_SHORT: _MA_DISPERSION_SHORT_FIELDS,
    }.get(indicator_scope, _MA_DISPERSION_SHORT_FIELDS)
    ma_structure_score, ma_structure_short_score, ma_structure_long_score = _ma_structure_components(row, structure_fields)
    ma_dispersion_score, ma_dispersion_status, ma_dispersion_meaning = _ma_dispersion_state(
        row,
        ma_dispersion_short_spread,
        ma_dispersion_long_spread,
        ma_dispersion_short_change,
        ma_dispersion_long_change,
        scope=indicator_scope,
    )
    structure_max_score = {
        _TREND_DATA_MODE_FULL: 4,
        _TREND_DATA_MODE_MEDIUM: 3,
        _TREND_DATA_MODE_SHORT: 2,
    }.get(indicator_scope, 2)
    ma_dispersion_composite = _ma_dispersion_composite(
        ma_dispersion_status,
        ma_structure_score,
        ma_structure_short_score,
        ma_structure_long_score,
        structure_max_score=structure_max_score,
        structure_higher_label="中" if indicator_scope == _TREND_DATA_MODE_MEDIUM else "长",
    )
    ma_dispersion_detail = _ma_dispersion_detail(
        ma_dispersion_status,
        ma_dispersion_meaning,
        ma_dispersion_composite,
    )

    persistence_values = []
    for position in range(max(0, index - (_TREND_PERSISTENCE_WINDOW - 1)), index + 1):
        window_close = _number(records[position].get("close"))
        window_ma20 = _number(records[position].get("ma20"))
        if window_close is not None and window_ma20 is not None:
            persistence_values.append(_sign_score(window_close - window_ma20))
    persistence_sample_count = len(persistence_values)
    persistence_above_count = sum(value >= 50 for value in persistence_values)
    persistence = sum(persistence_values) / persistence_sample_count if persistence_sample_count >= _TREND_PERSISTENCE_MIN_SAMPLES else None
    persistence_status = _trend_persistence_status(persistence_above_count, persistence_sample_count)
    persistence_detail = _trend_persistence_detail(persistence_above_count, persistence_sample_count)

    slope_fields_label = "MA5/20/60" if len(slope_fields) == 3 else "MA5/20"
    dispersion_long_label = {
        _TREND_DATA_MODE_FULL: "MA20/60/120",
        _TREND_DATA_MODE_MEDIUM: "MA20/60",
    }.get(indicator_scope)
    dispersion_description = "观察 MA5/10/20 的离散度变化" if dispersion_long_label is None else f"观察 MA5/10/20 与 {dispersion_long_label} 的离散度变化"
    price_fields_label = {
        _TREND_DATA_MODE_FULL: "MA20/MA60/MA120",
        _TREND_DATA_MODE_MEDIUM: "MA20/MA60",
        _TREND_DATA_MODE_SHORT: "MA20",
    }.get(indicator_scope, "MA20")

    def slope_value(field: str, position: int) -> float | None:
        component = slope_components.get(field)
        return component[position] if component is not None else None

    dispersion_raw_values = _raw_values(
        short_spread_pct=ma_dispersion_short_spread,
        baseline_short_spread_pct=ma_dispersion_short_baseline,
        short_spread_change_3_pct=ma_dispersion_short_change,
        structure_score=ma_structure_score,
        short_structure_score=ma_structure_short_score,
    )
    if indicator_scope == _TREND_DATA_MODE_FULL:
        dispersion_raw_values.update(_raw_values(
            long_spread_pct=ma_dispersion_long_spread,
            baseline_long_spread_pct=ma_dispersion_long_baseline,
            long_spread_change_3_pct=ma_dispersion_long_change,
            long_structure_score=ma_structure_long_score,
        ))
    elif indicator_scope == _TREND_DATA_MODE_MEDIUM:
        dispersion_raw_values.update(_raw_values(
            medium_spread_pct=ma_dispersion_long_spread,
            baseline_medium_spread_pct=ma_dispersion_long_baseline,
            medium_spread_change_3_pct=ma_dispersion_long_change,
            medium_structure_score=ma_structure_long_score,
        ))

    trend_indicators = [
        {
            "id": "ma_alignment", "name": "均线排列", "score": round(alignment_score) if alignment_score is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["trend"]["ma_alignment"],
            "status": alignment_status,
            "detail": f"比较价格、{alignment_fields_label} 的相对排列{scope_note}\n{alignment_meaning}",
            "raw_values": _raw_values(close=row.get("close"), ma5=row.get("ma5"), ma10=row.get("ma10"), ma20=row.get("ma20"), ma60=row.get("ma60"), ma120=row.get("ma120")),
        },
        {
            "id": "price_vs_ma", "name": "价格位置", "score": round(price_position_score) if price_position_score is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["trend"]["price_vs_ma"],
            "status": price_position_status,
            "detail": f"比较价格与 {price_fields_label} 的位置{scope_note}\n{price_position_detail}",
            "raw_values": _raw_values(
                close=close,
                ma20=ma20,
                ma60=ma60,
                ma120=ma120,
                distance_ma20_pct=_relative_change(close, ma20),
                distance_ma60_pct=_relative_change(close, ma60),
                distance_ma120_pct=_relative_change(close, ma120),
                distance_ma20_atr=(close - ma20) / atr14 if close is not None and ma20 is not None and atr14 is not None and atr14 > 0 else None,
            ),
        },
        {
            "id": "ma_slope", "name": "均线斜率", "score": round(slope_score) if slope_score is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["trend"]["ma_slope"],
            "status": slope_status,
            "detail": f"分别识别 {slope_fields_label} 的方向、力度与拐点状态\n{slope_meaning}",
            "raw_values": _raw_values(
                ma5=row.get("ma5"),
                ma20=row.get("ma20"),
                ma60=row.get("ma60"),
                previous_ma5=previous.get("ma5"),
                previous_ma20=previous.get("ma20"),
                previous_ma60=previous.get("ma60"),
                ma5_slope_pct=slope_value("ma5", 2),
                ma20_slope_pct=slope_value("ma20", 2),
                ma60_slope_pct=slope_value("ma60", 2),
                previous_ma5_slope_pct=slope_value("ma5", 3),
                previous_ma20_slope_pct=slope_value("ma20", 3),
                previous_ma60_slope_pct=slope_value("ma60", 3),
            ),
        },
        {
            "id": "ma_dispersion", "name": "均线聚散", "score": round(ma_dispersion_score) if ma_dispersion_score is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["trend"]["ma_dispersion"],
            "status": ma_dispersion_status,
            "detail": f"{dispersion_description}{scope_note}\n{ma_dispersion_detail}",
            "raw_values": dispersion_raw_values,
        },
        {
            "id": "trend_persistence", "name": "趋势持续性", "score": round(persistence) if persistence is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["trend"]["trend_persistence"],
            "status": persistence_status,
            "detail": f"统计最近{_TREND_PERSISTENCE_WINDOW}周期收盘价相对 MA20 的状态\n{persistence_detail}",
            "raw_values": _raw_values(above_count=persistence_above_count, sample_count=persistence_sample_count),
        },
    ]

    dif = _number(row.get("macd_dif"))
    dea = _number(row.get("macd_dea"))
    hist = _number(row.get("macd_hist"))
    previous_hist = _number(previous.get("macd_hist"))
    macd_analysis = _macd_analysis(records, index)
    macd = _weighted_mean((
        (_sign_score(dif - dea) if dif is not None and dea is not None else None, 0.5),
        (_sign_score(dif) if dif is not None else None, 0.3),
        (_sign_score(hist - previous_hist) if hist is not None and previous_hist is not None else None, 0.2),
    ))
    rsi_analysis = _rsi_analysis(records, index)
    rsi = _rsi_score(rsi_analysis["value"])
    k = _number(row.get("kdj_k"))
    d = _number(row.get("kdj_d"))
    kdj_analysis = _kdj_analysis(records, index)
    kdj = _weighted_mean((
        (_clamp(50.0 + (k - d) * 2.0) if k is not None and d is not None else None, 0.6),
        (_clamp(k) if k is not None else None, 0.4),
    ))
    roc_analysis = _roc_analysis(records, index, roc_context)
    if macd_analysis["divergence"] is not None:
        divergence_detail = f"背离: {_MACD_DIVERGENCE_LABELS[macd_analysis['divergence']]}"
    elif macd_analysis["recent_divergence"] is not None:
        recent_label = _MACD_DIVERGENCE_LABELS[macd_analysis["recent_divergence"]]
        recent_date = macd_analysis["recent_divergence_as_of"]
        divergence_detail = f"最近一次: {recent_label}"
        if recent_date is not None:
            divergence_detail += f" · {recent_date}"
    else:
        divergence_detail = "背离: 当前无有效背离"
    macd_detail_lines = [
        "DIF/DEA交叉、零轴位置、柱体变化与价格背离",
    ]
    if macd_analysis["event"] is not None:
        macd_detail_lines.append(f"{macd_analysis['status']} · {macd_analysis['summary']}")
    macd_detail_lines.extend([
        f"趋势位置: {_MACD_ZERO_AXIS_LABELS[macd_analysis['zero_axis']]} · 动能: {_MACD_MOMENTUM_LABELS[macd_analysis['momentum']]}",
        divergence_detail,
    ])
    kdj_cross_event = next(
        (event for event in kdj_analysis["events"] if event.endswith("CROSS")),
        None,
    )
    kdj_cross_detail = (
        _KDJ_EVENT_LABELS[kdj_cross_event]
        if kdj_cross_event is not None
        else "K在D上方" if k is not None and d is not None and k > d
        else "K在D下方" if k is not None and d is not None and k < d
        else "K/D暂未分出方向"
    )
    if kdj_analysis["j_turn"] is not None:
        kdj_j_detail = _KDJ_EVENT_LABELS[f"J_TURN_{kdj_analysis['j_turn']}"]
    else:
        kdj_j_change = kdj_analysis["raw_values"].get("j_change")
        kdj_j_detail = (
            "J向上" if kdj_j_change is not None and kdj_j_change > _KDJ_DIRECTION_FLAT_BAND
            else "J向下" if kdj_j_change is not None and kdj_j_change < -_KDJ_DIRECTION_FLAT_BAND
            else "J走平"
        )
    kdj_detail_lines = [
        "K/D位置与交叉、J拐点、钝化及价格背离",
        kdj_analysis["summary"],
        f"位置: {kdj_analysis['zone_label']} · 交叉: {kdj_cross_detail} · 极端动能: {kdj_j_detail}",
        f"阶段: {kdj_analysis['phase']}",
    ]
    if kdj_analysis["recent_divergence"] is not None and kdj_analysis["divergence"] is None:
        kdj_recent = f"最近一次: {_KDJ_DIVERGENCE_LABELS[kdj_analysis['recent_divergence']]}"
        if kdj_analysis["recent_divergence_as_of"] is not None:
            kdj_recent += f" · {kdj_analysis['recent_divergence_as_of']}"
        kdj_detail_lines.append(kdj_recent)
    momentum_indicators = [
        {
            "id": "macd", "name": "MACD动能", "score": round(macd[0]) if macd[0] is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["momentum"]["macd"],
            "status": macd_analysis["status"],
            "detail": "\n".join(macd_detail_lines),
            "state": macd_analysis["state"],
            "event": macd_analysis["event"],
            "events": macd_analysis["events"],
            "crossover": macd_analysis["crossover"],
            "zero_axis": macd_analysis["zero_axis"],
            "momentum": macd_analysis["momentum"],
            "divergence": macd_analysis["divergence"],
            "recent_divergence": macd_analysis["recent_divergence"],
            "recent_divergence_as_of": macd_analysis["recent_divergence_as_of"],
            "tags": macd_analysis["tags"],
            "confidence": macd_analysis["confidence"],
            "summary": macd_analysis["summary"],
            "raw_values": macd_analysis["raw_values"],
        },
        {
            "id": "rsi", "name": "RSI14", "score": round(rsi) if rsi is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["momentum"]["rsi"],
            "status": rsi_analysis["status"],
            "detail": "\n".join([
                "RSI14位置、方向、50/30/70穿越、背离与趋势区间",
                rsi_analysis["summary"],
                *(
                    [
                        f"最近一次: {_RSI_DIVERGENCE_LABELS[rsi_analysis['recent_divergence']]}"
                        + (f" · {rsi_analysis['recent_divergence_as_of']}" if rsi_analysis["recent_divergence_as_of"] else "")
                    ]
                    if rsi_analysis["recent_divergence"] is not None and rsi_analysis["divergence"] is None
                    else []
                ),
                *(
                    [
                        f"最近一次: {_RSI_FAILURE_SWING_LABELS[rsi_analysis['recent_failure_swing']]}"
                        + (f" · {rsi_analysis['recent_failure_swing_as_of']}" if rsi_analysis["recent_failure_swing_as_of"] else "")
                    ]
                    if rsi_analysis["recent_failure_swing"] is not None and rsi_analysis["failure_swing"] is None
                    else []
                ),
            ]),
            "state": rsi_analysis["state"],
            "event": rsi_analysis["event"],
            "events": rsi_analysis["events"],
            "direction": rsi_analysis["direction"],
            "zone": rsi_analysis["zone"],
            "zone_label": rsi_analysis["zone_label"],
            "divergence": rsi_analysis["divergence"],
            "recent_divergence": rsi_analysis["recent_divergence"],
            "recent_divergence_as_of": rsi_analysis["recent_divergence_as_of"],
            "failure_swing": rsi_analysis["failure_swing"],
            "recent_failure_swing": rsi_analysis["recent_failure_swing"],
            "recent_failure_swing_as_of": rsi_analysis["recent_failure_swing_as_of"],
            "stagnation": rsi_analysis["stagnation"],
            "tags": rsi_analysis["tags"],
            "confidence": rsi_analysis["confidence"],
            "summary": rsi_analysis["summary"],
            "raw_values": rsi_analysis["raw_values"],
        },
        {
            "id": "kdj", "name": "KDJ", "score": round(kdj[0]) if kdj[0] is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["momentum"]["kdj"],
            "status": kdj_analysis["status"],
            "detail": "\n".join(kdj_detail_lines),
            "state": kdj_analysis["state"],
            "event": kdj_analysis["event"],
            "events": kdj_analysis["events"],
            "crossover": kdj_analysis["crossover"],
            "zone": kdj_analysis["zone"],
            "zone_label": kdj_analysis["zone_label"],
            "j_turn": kdj_analysis["j_turn"],
            "phase": kdj_analysis["phase"],
            "divergence": kdj_analysis["divergence"],
            "recent_divergence": kdj_analysis["recent_divergence"],
            "recent_divergence_as_of": kdj_analysis["recent_divergence_as_of"],
            "stagnation": kdj_analysis["stagnation"],
            "tags": kdj_analysis["tags"],
            "confidence": kdj_analysis["confidence"],
            "summary": kdj_analysis["summary"],
            "raw_values": kdj_analysis["raw_values"],
        },
        {
            "id": "roc", "name": "多周期ROC", "score": round(roc_analysis["score"]) if roc_analysis["score"] is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["momentum"]["roc"],
            "status": roc_analysis["status"],
            "detail": roc_analysis["detail"],
            "state": roc_analysis["state"],
            "event": roc_analysis["event"],
            "event_period": roc_analysis["event_period"],
            "events": roc_analysis["events"],
            "direction": roc_analysis["direction"],
            "direction_label": roc_analysis["direction_label"],
            "extreme": roc_analysis["extreme"],
            "extreme_periods": roc_analysis["extreme_periods"],
            "divergence": roc_analysis["divergence"],
            "divergence_period": roc_analysis["divergence_period"],
            "recent_divergence": roc_analysis["recent_divergence"],
            "recent_divergence_as_of": roc_analysis["recent_divergence_as_of"],
            "tags": roc_analysis["tags"],
            "confidence": roc_analysis["confidence"],
            "summary": roc_analysis["summary"],
            "periods": roc_analysis["periods"],
            "raw_values": roc_analysis["raw_values"],
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

    trend_category = _weighted_category("trend", trend_indicators)
    if trend_mode == _TREND_DATA_MODE_INSUFFICIENT:
        trend_category.update(score=None, status="数据不足", coverage=0, available=False)
    else:
        trend_category["status"] = _trend_category_status(trend_category["score"], trend_mode)

    categories = [
        trend_category,
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


def _score_records(
    records: list[dict],
) -> tuple[list[dict[str, float | bool | None]], list[dict]]:
    result: list[dict[str, float | bool | None]] = []
    category_rows: list[dict] = []
    roc_context = _build_roc_context(records)
    for index in range(len(records)):
        trend, trend_coverage = _trend_score(records, index)
        momentum, momentum_coverage = _momentum_score(records, index, roc_context)
        volume_price, volume_price_coverage = _volume_price_score(records, index)
        state_confirmation, state_coverage = _state_confirmation_score((trend, momentum, volume_price))
        volatility = _volatility_risk(records, index)
        activity = _activity_score(records, index)
        category_scores = _category_scores(records, index, roc_context)
        category_rows.append(category_scores)

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
    return result, category_rows


def _empty_score_columns(frame: pl.DataFrame) -> pl.DataFrame:
    existing = [
        column
        for column in (*TECHNICAL_SCORE_COLUMNS, *TECHNICAL_SCORE_INTERNAL_COLUMNS)
        if column in frame.columns
    ]
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
    all_category_rows: list[dict] = []
    for group in grouped:
        scores, category_rows = _score_records(group.to_dicts())
        all_scores.extend(scores)
        all_category_rows.extend(category_rows)
    if len(all_scores) != working.height:
        raise RuntimeError("technical score row count mismatch")
    return working.with_columns([
        pl.Series(name=column, values=[score[column] for score in all_scores])
        for column in TECHNICAL_SCORE_COLUMNS
    ] + [
        pl.Series(
            name=TECHNICAL_SCORE_INTERNAL_COLUMNS[0],
            values=[category["categories"] for category in all_category_rows],
            dtype=pl.Object,
        ),
    ])


def technical_score_payload(frame: pl.DataFrame) -> dict:
    """把评分列压缩成 KlineResponse 的附加序列。"""
    if frame.is_empty() or "date" not in frame.columns:
        return {"version": TECHNICAL_SCORE_VERSION, "rows": []}
    category_column = TECHNICAL_SCORE_INTERNAL_COLUMNS[0]
    if category_column in frame.columns:
        categories = frame[category_column].to_list()
    else:
        categories = []
        groups = frame.partition_by("symbol", maintain_order=True) if "symbol" in frame.columns else [frame]
        for group in groups:
            records = group.to_dicts()
            roc_context = _build_roc_context(records)
            categories.extend(
                _category_scores(records, index, roc_context)["categories"]
                for index in range(len(records))
            )
    rows = []
    for index, row in enumerate(frame.select(["date", *TECHNICAL_SCORE_COLUMNS]).to_dicts()):
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
            "categories": categories[index],
        })
    return {"version": TECHNICAL_SCORE_VERSION, "rows": rows}
