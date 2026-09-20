"""统一技术指标评分.

评分是对单根 K 线当时可见信息的结构化摘要, 不是交易信号, 也不替换策略
引擎的截面评分. 模块只生成运行时列, 不修改持久化数据.

评分只使用已有图表指标: MA, MACD, RSI, KDJ, momentum/ROC, 量比,
ATR, BOLL 和 K 线成交额. 旧版顶层字段形状保持兼容; v8 另外输出 ETF 优先的
类别/子指标评分, 方向、市场风险和成交活跃度彼此独立.
"""
from __future__ import annotations

import math
from bisect import bisect_left, bisect_right
from collections.abc import Iterable
from dataclasses import dataclass
from itertools import pairwise

import polars as pl

from app.indicators.pipeline import compute_indicators

TECHNICAL_SCORE_VERSION = "technical-score-v8"

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

# v8 分类评分权重。旧 _DIRECTION_WEIGHTS 保留给兼容字段, 避免改变已有
# technical_direction_score 的历史语义; 价格位置只描述所处位置, 不参与方向分。
_CATEGORY_DIRECTION_WEIGHTS = {
    "trend": 0.35,
    "momentum": 0.30,
    "volume_price": 0.20,
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
        "rvol": 0.30,
        "price_volume": 0.40,
        "obv": 0.30,
    },
    "volatility_risk": {
        # 波动风险组内部权重 40/40/20; 下行风险组内部权重 60/40.
        "atr_relative": 0.40,
        "realized_volatility": 0.40,
        "boll_width_relative": 0.20,
        "ma20_deviation_risk": None,
        "downside_volatility": 0.60,
        "rolling_drawdown": 0.40,
    },
    "activity": {
        "amount_ratio_20": 0.60,
        "amount_ma5_ma20": 0.40,
    },
}

_CATEGORY_META = {
    "trend": {"name": "趋势", "kind": "direction", "weight": 0.35},
    "momentum": {"name": "动能", "kind": "direction", "weight": 0.30},
    "volume_price": {"name": "量价确认", "kind": "direction", "weight": 0.20},
    "price_position": {"name": "价格位置", "kind": "position", "weight": None},
    "volatility_risk": {"name": "市场风险", "kind": "risk", "weight": None},
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

_RVOL_WINDOW = 20
_RVOL_PRICE_CHANGE_THRESHOLD = 0.003
_RVOL_INCREASE_THRESHOLD = 1.10
_RVOL_SHRINK_THRESHOLD = 0.80
_RVOL_WEIGHTS = {
    "rvol": 0.30,
    "price_volume": 0.40,
    "obv": 0.30,
}
_OBV_TREND_SCORES = {
    "STRONG_INFLOW": 90.0,
    "INFLOW": 75.0,
    "INFLOW_IMPROVING": 65.0,
    "RANGE": 50.0,
    "OUTFLOW_WORSENING": 35.0,
    "OUTFLOW": 25.0,
    "STRONG_OUTFLOW": 10.0,
}

_RISK_HISTORY_WINDOW = 250
_RISK_MIN_HISTORY = 20
_BOLL_CHANGE_WINDOW = 5
_DOWNSIDE_VOLATILITY_WINDOW = 20
_DRAWDOWN_SHORT_WINDOW = 20
_DRAWDOWN_MEDIUM_WINDOW = 60
_RISK_GROUP_WEIGHTS = {
    "volatility": 0.45,
    "downside": 0.55,
}
_RISK_GROUP_INDICATOR_IDS = {
    "volatility": ("atr_relative", "realized_volatility", "boll_width_relative"),
    "downside": ("downside_volatility", "rolling_drawdown"),
}
_RISK_PERCENTILE_ANCHORS = (
    (0.0, 10.0),
    (50.0, 10.0),
    (60.0, 20.0),
    (70.0, 30.0),
    (80.0, 45.0),
    (85.0, 55.0),
    (90.0, 68.0),
    (95.0, 82.0),
    (98.0, 92.0),
    (100.0, 100.0),
)

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


@dataclass(frozen=True)
class _RiskMetricContext:
    """一次评分请求内复用的风险基础序列, 避免逐日期重复扫描历史窗口."""

    atr_pct: list[float | None]
    realized_volatility: list[float | None]
    boll_width: list[float | None]
    downside_volatility: list[float | None]
    drawdown_20: list[float | None]
    drawdown_60: list[float | None]
    negative_return_count: list[int]


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


def _weighted_partial_score(
    parts: Iterable[tuple[float | None, float, float]],
) -> tuple[float | None, float]:
    """Combine scores while letting partial evidence reduce its effective weight."""
    values = list(parts)
    expected = sum(weight for _, weight, _ in values)
    effective = [
        (value, weight * _clamp(coverage, 0.0, 1.0))
        for value, weight, coverage in values
        if value is not None and coverage > 0
    ]
    total = sum(weight for _, weight in effective)
    if expected <= 0 or total <= 0:
        return None, 0.0
    return sum(value * weight for value, weight in effective) / total, total / expected


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


def _rvol20(records: list[dict], index: int) -> float | None:
    """Return current volume relative to the previous 20 bars, excluding today."""
    current = _number(records[index].get("volume"))
    if current is None or current <= 0 or index < _RVOL_WINDOW:
        return None
    previous = [_number(row.get("volume")) for row in records[index - _RVOL_WINDOW:index]]
    if any(value is None or value < 0 for value in previous):
        return None
    average = sum(value for value in previous if value is not None) / _RVOL_WINDOW
    return current / average if average > 0 else None


def _rvol_level(value: float | None) -> tuple[float | None, str, float | None]:
    if value is None:
        return None, "数据不足", None
    if value < 0.60:
        return 25.0, "极度缩量", 0.75
    if value < 0.80:
        return 40.0, "明显缩量", 0.85
    if value < 1.20:
        return 60.0, "正常量能", 1.00
    if value < 1.50:
        return 75.0, "温和放量", 1.08
    if value <= 2.00:
        return 90.0, "明显放量", 1.15
    return 95.0, "巨量", 1.20


def _rvol_directional_score(rvol_score: float | None, change: float | None) -> float | None:
    """Turn volume confirmation into a direction-aware component, not a bullish bonus."""
    if rvol_score is None or change is None:
        return None
    if abs(change) < _RVOL_PRICE_CHANGE_THRESHOLD:
        return 50.0
    direction = 1.0 if change > 0 else -1.0
    if rvol_score >= 60.0:
        return _clamp(50.0 + direction * (rvol_score - 50.0))
    # 缩量只能降低上涨确认或减轻下跌确认, 不应把弱势直接翻成看多.
    relief_or_penalty = (60.0 - rvol_score) * 0.20
    return _clamp(50.0 - direction * relief_or_penalty)


def _volume_ratio_for_relation(records: list[dict], index: int) -> float | None:
    """Use RVOL20 for the relation and retain the existing 5-bar proxy as a warm-up."""
    return _rvol20(records, index) or _volume_ratio(records, index)


def _price_volume_status(change: float | None, ratio: float | None) -> str:
    if change is None or ratio is None:
        return "数据不足"
    if abs(change) < _RVOL_PRICE_CHANGE_THRESHOLD:
        if ratio > _RVOL_INCREASE_THRESHOLD:
            return "价平放量"
        if ratio < _RVOL_SHRINK_THRESHOLD:
            return "价平缩量"
        return "价格震荡"
    if change > 0:
        return "价涨量增" if ratio > _RVOL_INCREASE_THRESHOLD else "价涨量缩" if ratio < _RVOL_SHRINK_THRESHOLD else "价涨量平"
    return "价跌量增" if ratio > _RVOL_INCREASE_THRESHOLD else "价跌量缩" if ratio < _RVOL_SHRINK_THRESHOLD else "价跌量平"


def _price_volume_current_score(change: float | None, ratio: float | None) -> float | None:
    if change is None or ratio is None:
        return None
    if abs(change) < _RVOL_PRICE_CHANGE_THRESHOLD:
        if ratio > _RVOL_INCREASE_THRESHOLD:
            return 47.0
        if ratio < _RVOL_SHRINK_THRESHOLD:
            return 53.0
        return 50.0

    change_strength = _clamp(
        (abs(change) - _RVOL_PRICE_CHANGE_THRESHOLD) / 0.02,
        0.0,
        1.0,
    )
    volume_strength = _clamp(
        (ratio - _RVOL_INCREASE_THRESHOLD) / 0.90,
        0.0,
        1.0,
    )
    if change > 0:
        if ratio > _RVOL_INCREASE_THRESHOLD:
            return _clamp(80.0 + 8.0 * change_strength + 12.0 * volume_strength)
        if ratio < _RVOL_SHRINK_THRESHOLD:
            return 55.0 + 15.0 * _clamp(abs(change) / 0.03, 0.0, 1.0)
        return 68.0 + 10.0 * change_strength
    if ratio > _RVOL_INCREASE_THRESHOLD:
        return _clamp(25.0 - 8.0 * change_strength - 12.0 * volume_strength)
    if ratio < _RVOL_SHRINK_THRESHOLD:
        return 35.0 + 15.0 * _clamp(abs(change) / 0.03, 0.0, 1.0)
    return _clamp(35.0 - 5.0 * change_strength)


def _price_volume_signal(change: float | None, ratio: float | None) -> int | None:
    if change is None or ratio is None:
        return None
    if abs(change) < _RVOL_PRICE_CHANGE_THRESHOLD:
        return 0
    if change > 0:
        return 2 if ratio > _RVOL_INCREASE_THRESHOLD else 0 if ratio < _RVOL_SHRINK_THRESHOLD else 1
    return -2 if ratio > _RVOL_INCREASE_THRESHOLD else 0 if ratio < _RVOL_SHRINK_THRESHOLD else -1


def _price_volume_persistence(records: list[dict], index: int) -> dict:
    weights = (0.40, 0.25, 0.15, 0.12, 0.08)
    signals: list[tuple[int, float, int]] = []
    for offset, weight in enumerate(weights):
        position = index - offset
        if position <= 0:
            continue
        signal = _price_volume_signal(
            _change_pct(records, position),
            _volume_ratio_for_relation(records, position),
        )
        if signal is not None:
            signals.append((signal, weight, position))
    available_weight = sum(weight for _, weight, _ in signals)
    if available_weight <= 0:
        return {
            "score": None,
            "coverage": 0.0,
            "signal": None,
            "status": "数据不足",
            "sample_count": 0,
            "shrink_weight": 0.0,
        }

    signal = sum(value * weight for value, weight, _ in signals) / available_weight
    score = _clamp(50.0 + 25.0 * signal)
    shrink_weight = sum(
        weight
        for value, weight, position in signals
        if value == 0
        and (_change_pct(records, position) or 0.0) < -_RVOL_PRICE_CHANGE_THRESHOLD
    ) / available_weight
    if signal >= 0.75:
        status = "持续偏多"
    elif signal >= 0.20:
        status = "持续改善"
    elif signal <= -0.75:
        status = "持续偏空"
    elif signal <= -0.20:
        status = "持续转弱"
    elif shrink_weight >= 0.40:
        status = "卖压持续减弱"
    else:
        status = "多空均衡"
    return {
        "score": score,
        "coverage": available_weight,
        "signal": signal,
        "status": status,
        "sample_count": len(signals),
        "shrink_weight": shrink_weight,
    }


def _obv_series(records: list[dict], index: int) -> list[float | None]:
    values: list[float | None] = [0.0]
    for position in range(1, index + 1):
        previous = records[position - 1]
        current = records[position]
        previous_obv = values[-1]
        previous_close = _number(previous.get("close"))
        close = _number(current.get("close"))
        volume = _number(current.get("volume"))
        if (
            previous_obv is None
            or previous_close is None
            or close is None
            or previous_close <= 0
            or volume is None
            or volume < 0
        ):
            values.append(None)
            continue
        direction = 1.0 if close > previous_close else -1.0 if close < previous_close else 0.0
        values.append(previous_obv + direction * volume)
    return values


def _obv_slope(
    records: list[dict],
    values: list[float | None],
    index: int,
    window: int,
) -> tuple[float | None, float]:
    effective_window = min(window, index)
    if effective_window < 1 or values[index] is None or values[index - effective_window] is None:
        return None, 0.0
    volumes = [
        _number(row.get("volume"))
        for row in records[index - effective_window + 1:index + 1]
    ]
    if any(volume is None or volume < 0 for volume in volumes):
        return None, 0.0
    denominator = sum(volume for volume in volumes if volume is not None)
    if denominator <= 0:
        return None, 0.0
    return (values[index] - values[index - effective_window]) / denominator, effective_window / window


def _obv_direction(slope: float | None) -> int | None:
    if slope is None:
        return None
    if slope > 0.05:
        return 1
    if slope < -0.05:
        return -1
    return 0


def _obv_direction_label(direction: int | None) -> str:
    return {1: "上行", 0: "走平", -1: "下行", None: "数据不足"}[direction]


def _obv_trend_state(short_direction: int | None, medium_direction: int | None) -> tuple[str, str, float | None]:
    if short_direction is None and medium_direction is None:
        return "INSUFFICIENT", "数据不足", None
    if short_direction == 1 and medium_direction == 1:
        state = "STRONG_INFLOW"
    elif short_direction == 0 and medium_direction == 1:
        state = "INFLOW"
    elif short_direction == 1 and medium_direction == 0:
        state = "INFLOW_IMPROVING"
    elif short_direction == -1 and medium_direction == -1:
        state = "STRONG_OUTFLOW"
    elif short_direction == 0 and medium_direction == -1:
        state = "OUTFLOW"
    elif short_direction == -1 and medium_direction == 0:
        state = "OUTFLOW_WORSENING"
    elif short_direction in {-1, 1} and medium_direction in {-1, 1}:
        return "DIVERGING", "资金分歧", 50.0
    elif medium_direction == 1:
        state = "INFLOW"
    elif medium_direction == -1:
        state = "OUTFLOW"
    elif short_direction == 1:
        state = "INFLOW_IMPROVING"
    elif short_direction == -1:
        state = "OUTFLOW_WORSENING"
    else:
        state = "RANGE"
    labels = {
        "STRONG_INFLOW": "强流入",
        "INFLOW": "流入",
        "INFLOW_IMPROVING": "流入改善",
        "RANGE": "震荡",
        "OUTFLOW_WORSENING": "流出加剧",
        "OUTFLOW": "流出",
        "STRONG_OUTFLOW": "强流出",
    }
    return state, labels[state], _OBV_TREND_SCORES[state]


def _obv_breakout(values: list[float | None], index: int) -> dict:
    previous = [
        value
        for value in values[max(0, index - _RVOL_WINDOW):index]
        if value is not None and math.isfinite(value)
    ]
    coverage = min(1.0, len(previous) / _RVOL_WINDOW)
    if len(previous) < 5 or values[index] is None:
        return {"score": None, "coverage": coverage, "status": "数据不足"}
    if values[index] > max(previous):
        return {"score": 70.0, "coverage": coverage, "status": "向上突破"}
    if values[index] < min(previous):
        return {"score": 30.0, "coverage": coverage, "status": "向下突破"}
    return {"score": 50.0, "coverage": coverage, "status": "未突破"}


def _obv_divergence(records: list[dict], values: list[float | None], index: int) -> dict:
    previous: list[tuple[float, float]] = []
    for position in range(max(0, index - _RVOL_WINDOW), index):
        close = _number(records[position].get("close"))
        obv = values[position] if position < len(values) else None
        if close is not None and close > 0 and obv is not None and math.isfinite(obv):
            previous.append((close, obv))
    if len(previous) < 5 or values[index] is None:
        return {
            "score": None,
            "coverage": min(1.0, len(previous) / _RVOL_WINDOW),
            "divergence": None,
            "status": "样本不足",
            "price_change_pct": None,
        }
    close = _number(records[index].get("close"))
    if close is None or close <= 0:
        return {"score": None, "coverage": 0.0, "divergence": None, "status": "样本不足", "price_change_pct": None}
    previous_low_close = min(close for close, _ in previous)
    previous_high_close = max(close for close, _ in previous)
    previous_low_obv = min(obv for _, obv in previous)
    previous_high_obv = max(obv for _, obv in previous)
    current_obv = values[index]
    if close < previous_low_close and current_obv >= previous_low_obv:
        return {
            "score": 65.0,
            "coverage": 1.0,
            "divergence": "BOTTOM_DIVERGENCE",
            "status": "底背离",
            "price_change_pct": (close / previous_low_close - 1.0) * 100.0,
        }
    if close > previous_high_close and current_obv <= previous_high_obv:
        return {
            "score": 35.0,
            "coverage": 1.0,
            "divergence": "TOP_DIVERGENCE",
            "status": "顶背离",
            "price_change_pct": (close / previous_high_close - 1.0) * 100.0,
        }
    return {"score": 50.0, "coverage": 1.0, "divergence": None, "status": "当前无有效背离", "price_change_pct": None}


def _obv_analysis(
    records: list[dict],
    index: int,
    values: list[float | None] | None = None,
) -> dict:
    values = values if values is not None else _obv_series(records, index)
    short_slope, short_coverage = _obv_slope(records, values, index, 5)
    medium_slope, medium_coverage = _obv_slope(records, values, index, _RVOL_WINDOW)
    short_direction = _obv_direction(short_slope)
    medium_direction = _obv_direction(medium_slope)
    trend_state, trend_status, trend_score = _obv_trend_state(short_direction, medium_direction)
    trend_coverage = (short_coverage + medium_coverage) / 2.0 if trend_score is not None else 0.0
    breakout = _obv_breakout(values, index)
    divergence = _obv_divergence(records, values, index)
    score, coverage = _weighted_partial_score((
        (trend_score, 0.50, trend_coverage),
        (breakout["score"], 0.25, breakout["coverage"]),
        (divergence["score"], 0.25, divergence["coverage"]),
    ))
    direction_summary = (
        f"短期{_obv_direction_label(short_direction)}, 中期{_obv_direction_label(medium_direction)}"
    )
    detail_lines = [
        f"趋势: {trend_status} · {direction_summary}",
        f"突破: {breakout['status']}",
        f"背离: {divergence['status']}",
    ]
    summary_parts = [trend_status, direction_summary]
    if divergence["divergence"] == "BOTTOM_DIVERGENCE":
        summary_parts.append("出现底背离")
    elif divergence["divergence"] == "TOP_DIVERGENCE":
        summary_parts.append("出现顶背离")
    obv_values = values[index] if values[index] is not None else None
    obv_ma5 = sum(values[index - 4:index + 1]) / 5.0 if index >= 4 and all(value is not None for value in values[index - 4:index + 1]) else None
    obv_ma20 = sum(values[index - 19:index + 1]) / _RVOL_WINDOW if index >= _RVOL_WINDOW - 1 and all(value is not None for value in values[index - 19:index + 1]) else None
    return {
        "score": score,
        "coverage": coverage,
        "status": trend_status,
        "trend_state": trend_state,
        "trend_score": trend_score,
        "trend_coverage": trend_coverage,
        "breakout": breakout["status"],
        "breakout_score": breakout["score"],
        "divergence": divergence["divergence"],
        "divergence_status": divergence["status"],
        "divergence_score": divergence["score"],
        "summary": " · ".join(summary_parts),
        "detail": "\n".join(detail_lines),
        "raw_values": _raw_values(
            obv=obv_values,
            obv_ma5=obv_ma5,
            obv_ma20=obv_ma20,
            obv_short_slope=short_slope,
            obv_medium_slope=medium_slope,
            obv_trend_score=trend_score,
            obv_breakout_score=breakout["score"],
            obv_divergence_score=divergence["score"],
            divergence_price_change_pct=divergence["price_change_pct"],
        ),
    }


def _volume_price_direction_status(score: float | None) -> str:
    if score is None:
        return "数据不足"
    if score >= 85:
        return "强多头确认"
    if score >= 70:
        return "多头确认"
    if score >= 55:
        return "偏多"
    if score >= 45:
        return "中性"
    if score >= 30:
        return "偏空"
    if score >= 15:
        return "空头确认"
    return "强空头确认"


def _volume_price_phase(
    score: float | None,
    relation_status: str,
    obv: dict,
    divergence: str | None,
) -> tuple[str, str | None]:
    if score is None:
        return "数据不足", None
    if divergence == "BOTTOM_DIVERGENCE":
        return ("空头衰减" if relation_status.startswith("价跌") or score <= 54 else "多头增强"), "反转预警"
    if divergence == "TOP_DIVERGENCE":
        return ("多头衰减" if relation_status.startswith("价涨") or score >= 46 else "空头增强"), "反转预警"
    obv_score = obv.get("score")
    if score >= 55:
        if relation_status == "价涨量缩" or (obv_score is not None and obv_score < 45):
            return "多头衰减", None
        return "多头增强", None
    if score <= 44:
        if relation_status == "价跌量缩" or (obv_score is not None and obv_score >= 50):
            return "空头衰减", None
        return "空头增强", None
    return "震荡", None


def _volume_price_conclusion(
    relation_status: str,
    relation_persistence: str,
    obv: dict,
    divergence: str | None,
) -> str:
    obv_status = obv.get("status", "数据不足")
    if relation_status == "价涨量增":
        if obv_status in {"强流入", "流入"}:
            return "上涨获得量能支持, OBV同步走强, 量价确认较强。"
        return "上涨获得量能支持, 但资金趋势仍在改善, 需观察持续性。"
    if relation_status == "价涨量缩":
        return "价格仍在上涨, 但成交量不足, 上行确认度下降。"
    if relation_status == "价涨量平":
        return "价格仍在上涨, 但量能未明显放大, 当前多头确认有限, 需观察后续持续性。"
    if relation_status == "价跌量增":
        return "下跌伴随明显放量, OBV同步走弱, 当前卖压较强, 尚未出现止跌迹象。"
    if relation_status == "价跌量平":
        return f"价格仍在下跌, 但量能未明显放大, {relation_persistence}, 当前空头确认有限, 需观察后续量能方向。"
    if relation_status == "价跌量缩":
        if divergence == "BOTTOM_DIVERGENCE":
            return "价格仍处弱势, 但成交量持续萎缩, OBV出现底背离, 卖压正在衰减, 进入潜在反转观察阶段。"
        return f"价格仍处弱势, 但成交量持续萎缩, {relation_persistence}, 卖压正在衰减。"
    if relation_status == "价平放量":
        return "价格波动有限但量能放大, 多空分歧加剧, 暂未形成方向确认。"
    if relation_status == "价格震荡":
        return "价格波动有限且量能正常, 多空暂未形成方向确认。"
    if relation_status == "价平缩量":
        return "价格波动有限且成交量收缩, 市场处于观望和变盘前收敛阶段。"
    return "当前量价证据不足, 暂不形成方向结论。"


def _volume_price_analysis(
    records: list[dict],
    index: int,
    obv_values: list[float | None] | None = None,
) -> dict:
    change = _change_pct(records, index)
    rvol = _rvol20(records, index)
    rvol_score, rvol_status, confirmation_factor = _rvol_level(rvol)
    relation_ratio = _volume_ratio_for_relation(records, index)
    relation_status = _price_volume_status(change, relation_ratio)
    rvol_directional_score = _rvol_directional_score(rvol_score, change)
    current_relation_score = _price_volume_current_score(change, relation_ratio)
    persistence = _price_volume_persistence(records, index)
    relation_score, relation_coverage = _weighted_partial_score((
        (current_relation_score, 0.60, 1.0 if current_relation_score is not None else 0.0),
        (persistence["score"], 0.40, persistence["coverage"]),
    ))
    if relation_score is not None and confirmation_factor is not None:
        relation_score = _clamp(50.0 + (relation_score - 50.0) * confirmation_factor)
    obv = _obv_analysis(records, index, obv_values)
    score, coverage = _weighted_partial_score((
        (rvol_directional_score, _RVOL_WEIGHTS["rvol"], 1.0 if rvol_directional_score is not None else 0.0),
        (relation_score, _RVOL_WEIGHTS["price_volume"], relation_coverage),
        (obv["score"], _RVOL_WEIGHTS["obv"], obv["coverage"]),
    ))
    if score is not None:
        score = {
            "价跌量增": min(score, 29.0),
            "价跌量平": min(score, 44.0),
            "价跌量缩": min(score, 54.0),
            "价涨量缩": min(score, 69.0),
        }.get(relation_status, score)
    if coverage < 0.60:
        score = None
    direction_status = _volume_price_direction_status(score)
    phase, alert = _volume_price_phase(score, relation_status, obv, obv["divergence"])
    conclusion = _volume_price_conclusion(
        relation_status,
        persistence["status"],
        obv,
        obv["divergence"],
    )
    return {
        "score": score,
        "coverage": coverage,
        "rvol": rvol,
        "rvol_score": rvol_score,
        "rvol_directional_score": rvol_directional_score,
        "rvol_status": rvol_status,
        "confirmation_factor": confirmation_factor,
        "change": change,
        "relation_ratio": relation_ratio,
        "relation_status": relation_status,
        "current_relation_score": current_relation_score,
        "relation_score": relation_score,
        "relation_coverage": relation_coverage,
        "persistence": persistence,
        "obv": obv,
        "direction_status": direction_status,
        "phase": phase,
        "alert": alert,
        "conclusion": conclusion,
    }


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
    analysis = _volume_price_analysis(records, index)
    return analysis["score"], analysis["coverage"]


def _volatility_risk(records: list[dict], index: int) -> float | None:
    return _risk_category_score(records, index)


def _activity_metrics(records: list[dict], index: int) -> dict[str, float | None]:
    """Return the two amount-based activity ratios used by every score surface."""
    amount = _number(records[index].get("amount"))
    previous_amounts = [_number(item.get("amount")) for item in records[max(0, index - 20):index]]
    amount_average = (
        sum(value for value in previous_amounts if value is not None) / len(previous_amounts)
        if len(previous_amounts) == 20 and all(value is not None for value in previous_amounts)
        else None
    )
    amount_ratio = (
        amount / amount_average
        if amount is not None and amount > 0 and amount_average is not None and amount_average > 0
        else None
    )

    amount_values_5 = [_number(item.get("amount")) for item in records[max(0, index - 4):index + 1]]
    amount_values_20 = [_number(item.get("amount")) for item in records[max(0, index - 19):index + 1]]
    amount_ma5 = (
        sum(value for value in amount_values_5 if value is not None) / len(amount_values_5)
        if len(amount_values_5) == 5 and all(value is not None for value in amount_values_5)
        else None
    )
    amount_ma20 = (
        sum(value for value in amount_values_20 if value is not None) / len(amount_values_20)
        if len(amount_values_20) == 20 and all(value is not None for value in amount_values_20)
        else None
    )
    amount_ma_ratio = (
        amount_ma5 / amount_ma20
        if amount_ma5 is not None and amount_ma20 is not None and amount_ma20 > 0
        else None
    )
    return {
        "amount": amount,
        "amount_average": amount_average,
        "amount_ratio": amount_ratio,
        "amount_ma5": amount_ma5,
        "amount_ma20": amount_ma20,
        "amount_ma_ratio": amount_ma_ratio,
    }


def _activity_score(records: list[dict], index: int) -> float | None:
    metrics = _activity_metrics(records, index)
    amount_score = _activity_level_score(metrics["amount_ratio"])
    amount_ma_score = _activity_level_score(metrics["amount_ma_ratio"])
    score, _ = _weighted_mean(((amount_score, 0.60), (amount_ma_score, 0.40)))
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


def _activity_indicator_status(
    score: float | None,
    *,
    high: str,
    low: str,
    middle: str,
) -> str:
    if score is None:
        return "数据不足"
    if score >= 60:
        return high
    if score <= 40:
        return low
    return middle


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


def _price_position_category_status(
    range20: float | None,
    range60: float | None,
    boll_position: float | None,
    ma20_atr_position: float | None,
) -> str:
    range_values = [value for value in (range20, range60) if value is not None]
    if len(range_values) == 2:
        if all(value <= 10.0 for value in range_values):
            return "极低位"
        if all(value >= 90.0 for value in range_values):
            return "极高位"
        if all(value <= 30.0 for value in range_values):
            return "低位"
        if all(value >= 70.0 for value in range_values):
            return "高位"
        return "位置分化"
    if range_values:
        return _position_percentile_status(range_values[0])
    other_values = [value for value in (boll_position, ma20_atr_position) if value is not None]
    return _position_percentile_status(sum(other_values) / len(other_values)) if other_values else "数据不足"


def _price_position_category_conclusion(
    range20: float | None,
    range60: float | None,
    boll_position: float | None,
    ma20_atr_distance: float | None,
) -> str:
    parts: list[str] = []
    range_values = [value for value in (range20, range60) if value is not None]
    low_context = False
    high_context = False
    if len(range_values) == 2:
        if all(value <= 10.0 for value in range_values):
            parts.append("短中期均处于极低位置")
            low_context = True
        elif all(value <= 30.0 for value in range_values):
            parts.append("短中期均处于低位区域")
            low_context = True
        elif all(value >= 90.0 for value in range_values):
            parts.append("短中期均处于极高位置")
            high_context = True
        elif all(value >= 70.0 for value in range_values):
            parts.append("短中期均处于高位区域")
            high_context = True
        else:
            parts.append("短中期位置存在分化")
            low_context = any(value <= 30.0 for value in range_values)
            high_context = any(value >= 70.0 for value in range_values)
    elif range20 is not None:
        range20_status = _position_percentile_status(range20)
        parts.append(f"近20周期处于{range20_status}")
        low_context = range20 <= 30.0
        high_context = range20 >= 70.0
    elif range60 is not None:
        range60_status = _position_percentile_status(range60)
        parts.append(f"近60周期处于{range60_status}")
        low_context = range60 <= 30.0
        high_context = range60 >= 70.0

    if boll_position is not None:
        boll_status = _boll_position_status(boll_position)
        boll_phrases = {
            "接近下轨": "价格接近BOLL下轨",
            "通道偏下": "BOLL位置偏下",
            "通道中部": "BOLL位于通道中部",
            "通道偏上": "BOLL位置偏上",
            "接近上轨": "价格接近BOLL上轨",
        }
        parts.append(boll_phrases[boll_status])
        low_context = low_context or boll_position <= 30.0
        high_context = high_context or boll_position >= 70.0

    if ma20_atr_distance is not None:
        distance = abs(ma20_atr_distance)
        if ma20_atr_distance <= -0.25:
            parts.append(f"MA20下方约{distance:.1f}ATR")
            low_context = True
        elif ma20_atr_distance >= 0.25:
            parts.append(f"MA20上方约{distance:.1f}ATR")
            high_context = True
        else:
            parts.append("价格接近MA20")

    if not parts:
        return "位置数据不足, 暂无法形成价格位置结论."
    if low_context and not high_context:
        parts.extend(("当前属于低位偏离状态", "低位本身不代表反转, 仍需等待动能与量价确认"))
    elif high_context and not low_context:
        parts.extend(("当前属于高位运行状态", "高位本身不代表继续上涨, 需结合趋势与动能观察"))
    else:
        parts.append("位置只描述价格所处区间, 不单独形成多空结论")
    return ", ".join(parts) + "."


def _price_position_category(indicators: list[dict]) -> dict:
    values = {str(indicator["id"]): indicator.get("value") for indicator in indicators}
    observed_count = sum(value is not None for value in values.values())
    range20 = values.get("range_position_20")
    range60 = values.get("range_position_60")
    boll_position = values.get("boll_position")
    ma20_atr_position = values.get("ma20_atr_position")
    distance = next(
        (
            indicator.get("raw_values", {}).get("distance_atr")
            for indicator in indicators
            if indicator.get("id") == "ma20_atr_position"
        ),
        None,
    )
    return {
        "id": "price_position",
        "name": "价格位置",
        "kind": "position",
        "weight": None,
        "score": None,
        "status": _price_position_category_status(range20, range60, boll_position, ma20_atr_position),
        "coverage": round(observed_count / len(indicators) * 100.0) if indicators else 0,
        "available": observed_count >= 2,
        "conclusion": _price_position_category_conclusion(range20, range60, boll_position, distance),
        "indicators": indicators,
    }


def _weighted_category(category_id: str, indicators: list[dict]) -> dict:
    expected = sum(float(item["weight"]) for item in indicators)
    available = [
        item
        for item in indicators
        if item.get("score") is not None and float(item.get("coverage", 1.0)) > 0
    ]
    effective_weights = {
        id(item): float(item["weight"]) * _clamp(float(item.get("coverage", 1.0)), 0.0, 1.0)
        for item in available
    }
    available_weight = sum(effective_weights.values())
    coverage = available_weight / expected if expected > 0 else 0.0
    score = (
        sum(float(item["score"]) * effective_weights[id(item)] for item in available) / available_weight
        if available_weight > 0 else None
    )
    minimum_coverage = 0.60
    category_available = score is not None and coverage >= minimum_coverage
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


def _category_conclusion_evidence(
    category: dict,
    labels: tuple[tuple[str, str], ...],
) -> str:
    statuses = {
        str(indicator.get("id")): indicator.get("status")
        for indicator in category.get("indicators", [])
    }
    return ", ".join(
        f"{label}{statuses[indicator_id]}"
        for indicator_id, label in labels
        if statuses.get(indicator_id) not in {None, "数据不足"}
    )


def _trend_category_conclusion(category: dict) -> str:
    score = _number(category.get("score"))
    if score is None:
        return "趋势数据不足, 暂无法形成趋势结论。"

    evidence = _category_conclusion_evidence(
        category,
        (("ma_alignment", "均线"), ("ma_slope", "斜率"), ("trend_persistence", "持续性")),
    )
    if score <= 40:
        summary = "当前趋势偏空, 需观察均线是否止跌收敛。"
    elif score >= 60:
        summary = "当前趋势偏多, 需观察均线能否继续发散。"
    else:
        summary = "当前趋势处于中性区间, 需观察均线排列与斜率是否形成一致方向。"
    return f"{evidence}, {summary}" if evidence else summary


def _momentum_category_conclusion(category: dict) -> str:
    score = _number(category.get("score"))
    if score is None:
        return "动能数据不足, 暂无法形成动能结论。"

    evidence = _category_conclusion_evidence(
        category,
        (("macd", "MACD"), ("rsi", "RSI"), ("kdj", "KDJ"), ("roc", "ROC")),
    )
    if score <= 40:
        summary = "当前动能偏弱, 需观察后续是否出现修复信号。"
    elif score >= 60:
        summary = "当前动能偏强, 需观察动能能否延续。"
    else:
        summary = "当前动能处于中性区间, 需观察各指标是否形成一致方向。"
    return f"{evidence}, {summary}" if evidence else summary


def _activity_category_status(score: float | None) -> str:
    if score is None:
        return "数据不足"
    if score >= 60:
        return "市场参与度较高"
    if score <= 40:
        return "市场参与度较低"
    return "市场参与度中等"


def _activity_category_conclusion(category: dict) -> str:
    score = _number(category.get("score"))
    if score is None:
        return "成交活跃度数据不足, 暂无法形成市场参与度结论。"

    statuses = {
        str(indicator.get("id")): indicator.get("status")
        for indicator in category.get("indicators", [])
    }
    evidence = []
    amount_status = statuses.get("amount_ratio_20")
    trend_status = statuses.get("amount_ma5_ma20")
    if amount_status not in {None, "数据不足"}:
        evidence.append(f"近期{amount_status}")
    if trend_status not in {None, "数据不足"}:
        evidence.append(str(trend_status))
    evidence.append(_activity_category_status(score))
    return ", ".join(evidence) + "。成交活跃度只反映市场参与程度, 不代表涨跌方向。"


def _risk_category_status(score: float | None) -> str:
    if score is None:
        return "数据不足"
    if score >= 75.0:
        return "风险偏高"
    if score >= 60.0:
        return "风险中等偏高"
    if score >= 40.0:
        return "风险中性"
    if score >= 25.0:
        return "风险中等偏低"
    return "风险偏低"


def _risk_category_conclusion(category: dict, analysis: dict) -> str:
    score = _number(category.get("score"))
    if score is None:
        return "市场风险数据不足, 暂无法形成波动与下行风险结论。"

    volatility_score = _number(category.get("volatility_score"))
    if volatility_score is None:
        percentile_scores = [
            _percentile_to_risk_score(value)
            for value in (analysis.get("atr_percentile"), analysis.get("realized_vol_percentile"))
        ]
        available_scores = [value for value in percentile_scores if value is not None]
        volatility_score = sum(available_scores) / len(available_scores) if available_scores else None
    volatility = (
        "整体波动明显偏高" if volatility_score is not None and volatility_score >= 70.0
        else "整体波动偏高但未失控" if volatility_score is not None and volatility_score >= 55.0
        else "整体波动略高但未失控" if volatility_score is not None and volatility_score >= 35.0
        else "整体波动处于正常范围" if volatility_score is not None
        else "波动数据不足"
    )

    boll_status = (analysis.get("boll") or {}).get("status")
    if boll_status and ("扩张" in boll_status or "收缩" in boll_status):
        volatility += f", {boll_status}"

    distance = analysis.get("distance_atr")
    if distance is None:
        deviation = "价格乖离数据不足"
    elif distance <= -1.0:
        deviation = f"价格已偏离 MA20 约 {distance:+.2f} ATR, 处于明显超跌区, 需关注超跌修复"
    elif distance < -0.25:
        deviation = f"价格位于 MA20 下方, 乖离 {distance:+.2f} ATR, 存在向下偏离"
    elif distance >= 1.0:
        deviation = f"价格已向上偏离 MA20 约 {distance:+.2f} ATR, 处于明显过热区, 需关注过热回归"
    elif distance > 0.25:
        deviation = f"价格位于 MA20 上方, 乖离 {distance:+.2f} ATR, 存在向上偏离"
    else:
        deviation = "价格接近 MA20"

    downside_score = _number(category.get("downside_score"))
    if downside_score is None:
        downside_score = _percentile_to_risk_score(analysis.get("downside_percentile"))
    downside_text = (
        "下行波动明显偏高" if downside_score is not None and downside_score >= 80.0
        else "下行波动偏高" if downside_score is not None and downside_score >= 70.0
        else "下行波动有所升高" if downside_score is not None and downside_score >= 45.0
        else "下行波动处于低位" if downside_score is not None and downside_score < 25.0
        else "下行波动尚未显著升高" if downside_score is not None
        else "下行波动数据不足"
    )

    drawdown = analysis.get("drawdown_score")
    damage = (
        "趋势损伤较深" if drawdown is not None and drawdown >= 70.0
        else "已有一定趋势损伤" if drawdown is not None and drawdown >= 40.0
        else "趋势损伤有限" if drawdown is not None
        else "趋势损伤数据不足"
    )

    if downside_score is not None and downside_score >= 70.0 and drawdown is not None and drawdown >= 70.0:
        dominant = "近期风险主要来自较高的下行波动和较深的趋势损伤"
    elif downside_score is not None and downside_score >= 70.0:
        dominant = "近期风险主要来自较高的下行波动"
    elif drawdown is not None and drawdown >= 70.0:
        dominant = "近期风险主要来自较深的趋势损伤"
    elif (volatility_score is not None and volatility_score >= 70.0) or (boll_status and "扩张" in boll_status):
        dominant = "近期风险主要来自波动扩张"
    else:
        dominant = "当前未见单一风险因子显著占优"

    risk_change = _number(category.get("risk_change_5"))
    risk_trend = category.get("risk_trend")
    trend_text = f"近5周期风险{risk_trend}" if risk_change is not None and risk_trend else None
    conclusion_parts = [volatility, downside_text, damage, dominant, deviation]
    if trend_text:
        conclusion_parts.append(trend_text)
    return "; ".join(conclusion_parts) + "."


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


def _historical_percentile(
    current: float | None,
    history: Iterable[float | None],
    *,
    minimum: int = _RISK_MIN_HISTORY,
) -> tuple[float | None, int]:
    """Return a point-in-time empirical percentile from prior observations only."""
    values = sorted(
        value
        for value in history
        if value is not None and math.isfinite(value) and value >= 0
    )
    if current is None or current < 0 or not math.isfinite(current) or len(values) < minimum:
        return None, len(values)
    if values[-1] == values[0] and current == values[0]:
        return 50.0, len(values)
    return bisect_right(values, current) / len(values) * 100.0, len(values)


def _percentile_to_risk_score(percentile: float | None) -> float | None:
    """Map a historical percentile to a tail-sensitive risk score."""
    if percentile is None or not math.isfinite(percentile):
        return None
    value = _clamp(percentile, 0.0, 100.0)
    for (left_percentile, left_score), (right_percentile, right_score) in pairwise(_RISK_PERCENTILE_ANCHORS):
        if value <= right_percentile:
            span = right_percentile - left_percentile
            if span <= 0:
                return right_score
            ratio = (value - left_percentile) / span
            return left_score + ratio * (right_score - left_score)
    return _RISK_PERCENTILE_ANCHORS[-1][1]


def _prior_metric_values(
    records: list[dict],
    index: int,
    metric,
) -> list[float | None]:
    return [metric(records, position) for position in range(max(0, index - _RISK_HISTORY_WINDOW), index)]


def _prior_series_values(values: list[float | None], index: int) -> list[float | None]:
    return values[max(0, index - _RISK_HISTORY_WINDOW):index]


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


def _return_window(records: list[dict], index: int, window: int) -> list[float] | None:
    if index < window:
        return None
    returns: list[float] = []
    for position in range(index - window + 1, index + 1):
        current = _number(records[position].get("close"))
        previous = _number(records[position - 1].get("close"))
        if current is None or previous is None or previous <= 0:
            return None
        returns.append(current / previous - 1.0)
    return returns


def _realized_volatility(records: list[dict], index: int, window: int = 20) -> float | None:
    returns = _return_window(records, index, window)
    if returns is None:
        return None
    average = sum(returns) / len(returns)
    return math.sqrt(sum((value - average) ** 2 for value in returns) / len(returns))


def _downside_volatility(records: list[dict], index: int, window: int = _DOWNSIDE_VOLATILITY_WINDOW) -> float | None:
    """Return downside deviation, with positive returns contributing zero."""
    returns = _return_window(records, index, window)
    if returns is None:
        return None
    negative = [value for value in returns if value < 0]
    return math.sqrt(sum(value * value for value in negative) / len(returns))


def _rolling_drawdown_pct(records: list[dict], index: int, window: int) -> float | None:
    if index < window - 1:
        return None
    closes = [_number(item.get("close")) for item in records[index - window + 1:index + 1]]
    if any(value is None or value <= 0 for value in closes):
        return None
    current = closes[-1]
    peak = max(value for value in closes if value is not None)
    return current / peak - 1.0 if peak > 0 else None


def _drawdown_magnitude(records: list[dict], index: int, window: int) -> float | None:
    value = _rolling_drawdown_pct(records, index, window)
    return -value if value is not None else None


def _negative_return_count(records: list[dict], index: int, window: int = _DOWNSIDE_VOLATILITY_WINDOW) -> int:
    return sum(1 for value in (_return_window(records, index, window) or []) if value < 0)


def _build_risk_metric_context(records: list[dict]) -> _RiskMetricContext:
    return _RiskMetricContext(
        atr_pct=[_atr_pct(records, index) for index in range(len(records))],
        realized_volatility=[_realized_volatility(records, index) for index in range(len(records))],
        boll_width=[_boll_width(records, index) for index in range(len(records))],
        downside_volatility=[_downside_volatility(records, index) for index in range(len(records))],
        drawdown_20=[_rolling_drawdown_pct(records, index, _DRAWDOWN_SHORT_WINDOW) for index in range(len(records))],
        drawdown_60=[_rolling_drawdown_pct(records, index, _DRAWDOWN_MEDIUM_WINDOW) for index in range(len(records))],
        negative_return_count=[_negative_return_count(records, index) for index in range(len(records))],
    )


def _drawdown_history_percentile(
    records: list[dict],
    index: int,
    window: int,
) -> tuple[float | None, int]:
    current = _drawdown_magnitude(records, index, window)
    history = _prior_metric_values(
        records,
        index,
        lambda rows, position: _drawdown_magnitude(rows, position, window),
    )
    return _historical_percentile(current, history)


def _drawdown_score(percentile: float | None) -> float | None:
    """Map current drawdown percentile to damage severity, not absolute loss."""
    return _percentile_to_risk_score(percentile)


def _format_drawdown_detail(value: float | None, percentile: float | None) -> str:
    if value is None:
        return "数据不足"
    if percentile is None:
        return f"{value:.1%} (历史分位数据不足)"
    return f"{value:.1%} (历史分位 {percentile:.0f}%)"


def _risk_trend_label(change: float | None) -> str | None:
    if change is None or not math.isfinite(change):
        return None
    if change <= -8.0:
        return "快速回落"
    if change < -1.5:
        return "正在下降"
    if change <= 1.5:
        return "基本稳定"
    if change < 8.0:
        return "正在上升"
    return "快速上升"


def _risk_percentile_status(
    percentile: float | None,
    *,
    high: str,
    low: str,
) -> str:
    if percentile is None:
        return "数据不足"
    if percentile >= 75.0:
        return high
    if percentile <= 25.0:
        return low
    if percentile >= 60.0:
        return "略高"
    if percentile <= 40.0:
        return "略低"
    return "中性"


def _risk_change_score(change: float | None) -> float | None:
    if change is None or not math.isfinite(change):
        return None
    return _clamp(50.0 + change * 100.0)


def _boll_width_analysis(
    records: list[dict],
    index: int,
    boll_width_values: list[float | None] | None = None,
) -> dict:
    current = boll_width_values[index] if boll_width_values is not None else _boll_width(records, index)
    percentile, history_count = _historical_percentile(
        current,
        _prior_series_values(boll_width_values, index)
        if boll_width_values is not None
        else _prior_metric_values(records, index, _boll_width),
    )
    previous = (
        _boll_width(records, index - _BOLL_CHANGE_WINDOW)
        if index >= _BOLL_CHANGE_WINDOW
        else None
    )
    change = current / previous - 1.0 if current is not None and previous is not None and previous > 0 else None
    change_score = _risk_change_score(change)
    percentile_score = _percentile_to_risk_score(percentile)
    score, coverage = _weighted_mean(((percentile_score, 0.70), (change_score, 0.30)))
    if change is not None and change >= 0.15:
        status = "波动明显扩张"
    elif change is not None and change >= 0.03:
        status = "波动温和扩张"
    elif change is not None and change <= -0.15:
        status = "波动明显收缩"
    elif change is not None and change <= -0.03:
        status = "波动温和收缩"
    else:
        status = _risk_percentile_status(percentile, high="波动水平偏高", low="波动水平偏低")
    return {
        "score": score,
        "coverage": coverage,
        "current": current,
        "percentile": percentile,
        "percentile_score": percentile_score,
        "history_count": history_count,
        "change": change,
        "change_score": change_score,
        "status": status,
    }


def _ma20_deviation_score(distance: float | None) -> float | None:
    if distance is None or not math.isfinite(distance):
        return None
    magnitude = abs(distance)
    if magnitude <= 1.0:
        return magnitude * 50.0
    if magnitude <= 2.0:
        return 50.0 + (magnitude - 1.0) * 35.0
    return _clamp(85.0 + (magnitude - 2.0) * 15.0)


def _ma20_deviation_status(distance: float | None) -> str:
    if distance is None:
        return "数据不足"
    if distance <= -1.0:
        return "下方明显偏离"
    if distance < -0.25:
        return "下方偏离"
    if distance <= 0.25:
        return "MA20附近"
    if distance < 1.0:
        return "上方偏离"
    return "上方明显偏离"


def _risk_analysis(
    records: list[dict],
    index: int,
    metric_context: _RiskMetricContext | None = None,
) -> dict:
    if metric_context is None:
        current_atr_pct = _atr_pct(records, index)
        atr_history = _prior_metric_values(records, index, _atr_pct)
        current_realized_vol = _realized_volatility(records, index)
        realized_vol_history = _prior_metric_values(records, index, _realized_volatility)
        current_downside = _downside_volatility(records, index)
        downside_history = _prior_metric_values(records, index, _downside_volatility)
    else:
        current_atr_pct = metric_context.atr_pct[index]
        atr_history = _prior_series_values(metric_context.atr_pct, index)
        current_realized_vol = metric_context.realized_volatility[index]
        realized_vol_history = _prior_series_values(metric_context.realized_volatility, index)
        current_downside = metric_context.downside_volatility[index]
        downside_history = _prior_series_values(metric_context.downside_volatility, index)

    atr_percentile, atr_history_count = _historical_percentile(current_atr_pct, atr_history)
    realized_vol_percentile, realized_vol_history_count = _historical_percentile(
        current_realized_vol,
        realized_vol_history,
    )

    boll = _boll_width_analysis(
        records,
        index,
        metric_context.boll_width if metric_context is not None else None,
    )
    distance = _ma20_atr_distance(records, index)
    deviation_score = _ma20_deviation_score(distance)
    if distance is None:
        oversold_score = None
        overheat_score = None
    else:
        oversold_score = deviation_score if distance < -0.25 else 0.0
        overheat_score = deviation_score if distance > 0.25 else 0.0

    downside_percentile, downside_history_count = _historical_percentile(
        current_downside,
        downside_history,
    )

    if metric_context is None:
        drawdown_20 = _rolling_drawdown_pct(records, index, _DRAWDOWN_SHORT_WINDOW)
        drawdown_60 = _rolling_drawdown_pct(records, index, _DRAWDOWN_MEDIUM_WINDOW)
        drawdown_20_percentile, drawdown_20_history_count = _drawdown_history_percentile(
            records, index, _DRAWDOWN_SHORT_WINDOW,
        )
        drawdown_60_percentile, drawdown_60_history_count = _drawdown_history_percentile(
            records, index, _DRAWDOWN_MEDIUM_WINDOW,
        )
    else:
        drawdown_20 = metric_context.drawdown_20[index]
        drawdown_60 = metric_context.drawdown_60[index]
        drawdown_20_percentile, drawdown_20_history_count = _historical_percentile(
            -drawdown_20 if drawdown_20 is not None else None,
            [-value if value is not None else None for value in _prior_series_values(metric_context.drawdown_20, index)],
        )
        drawdown_60_percentile, drawdown_60_history_count = _historical_percentile(
            -drawdown_60 if drawdown_60 is not None else None,
            [-value if value is not None else None for value in _prior_series_values(metric_context.drawdown_60, index)],
        )
    drawdown_20_score = _drawdown_score(drawdown_20_percentile)
    drawdown_60_score = _drawdown_score(drawdown_60_percentile)
    drawdown_score, drawdown_coverage = _weighted_mean((
        (drawdown_20_score, 0.50),
        (drawdown_60_score, 0.50),
    ))
    atr_risk_score = _percentile_to_risk_score(atr_percentile)
    realized_vol_risk_score = _percentile_to_risk_score(realized_vol_percentile)
    downside_risk_score = _percentile_to_risk_score(downside_percentile)
    deviation_label = (
        "超跌程度" if distance is not None and distance < -0.25
        else "过热程度" if distance is not None and distance > 0.25
        else "乖离程度"
    )
    negative_return_count = (
        metric_context.negative_return_count[index]
        if metric_context is not None
        else _negative_return_count(records, index)
    )

    risk_indicators = [
        {
            "id": "atr_relative", "name": "ATR波动分位", "score": round(atr_risk_score) if atr_risk_score is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["volatility_risk"]["atr_relative"],
            "group": "volatility", "score_label": "风险",
            "status": _risk_percentile_status(atr_percentile, high="波动明显偏高", low="波动明显偏低"),
            "detail": "ATR/价格在此前250周期中的历史分位\n"
            + (f"历史分位 {atr_percentile:.0f}% / {atr_history_count}个样本; 当前波动状态可比历史" if atr_percentile is not None else f"历史有效样本 {atr_history_count}个, 数据不足"),
            "coverage": 1.0 if atr_percentile is not None else 0.0,
            "raw_values": _raw_values(
                atr14=_number(records[index].get("atr_14")),
                atr_pct=current_atr_pct,
                percentile=atr_percentile,
                risk_score=atr_risk_score,
                history_count=atr_history_count,
                history_window=_RISK_HISTORY_WINDOW,
            ),
        },
        {
            "id": "realized_volatility", "name": "20周期实现波动率", "score": round(realized_vol_risk_score) if realized_vol_risk_score is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["volatility_risk"]["realized_volatility"],
            "group": "volatility", "score_label": "风险",
            "status": _risk_percentile_status(realized_vol_percentile, high="波动明显偏高", low="波动明显偏低"),
            "detail": "最近20周期收益率标准差的历史分位\n"
            + (f"历史分位 {realized_vol_percentile:.0f}% / {realized_vol_history_count}个样本; 关注收益率变化的实际波动" if realized_vol_percentile is not None else f"历史有效样本 {realized_vol_history_count}个, 数据不足"),
            "coverage": 1.0 if realized_vol_percentile is not None else 0.0,
            "raw_values": _raw_values(
                realized_volatility=current_realized_vol,
                percentile=realized_vol_percentile,
                risk_score=realized_vol_risk_score,
                history_count=realized_vol_history_count,
                history_window=_RISK_HISTORY_WINDOW,
            ),
        },
        {
            "id": "boll_width_relative", "name": "BOLL带宽状态", "score": round(boll["score"]) if boll["score"] is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["volatility_risk"]["boll_width_relative"],
            "group": "volatility", "score_label": "风险",
            "status": boll["status"],
            "detail": "BOLL带宽历史分位与近5周期变化率\n"
            + (f"历史分位 {boll['percentile']:.0f}%" if boll["percentile"] is not None else "历史分位数据不足")
            + (f"; 近5周期 {boll['change']:+.1%}; {boll['status']}" if boll["change"] is not None else f"; 近5周期变化数据不足; {boll['status']}"),
            "coverage": boll["coverage"],
            "raw_values": _raw_values(
                boll_width=boll["current"],
                percentile=boll["percentile"],
                percentile_score=boll["percentile_score"],
                change_5_pct=boll["change"],
                change_score=boll["change_score"],
                risk_score=boll["score"],
                history_count=boll["history_count"],
                history_window=_RISK_HISTORY_WINDOW,
            ),
        },
        {
            "id": "ma20_deviation_risk", "name": "MA20乖离", "score": round(deviation_score) if deviation_score is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["volatility_risk"]["ma20_deviation_risk"],
            "group": "extreme", "score_label": deviation_label,
            "status": _ma20_deviation_status(distance),
            "detail": "价格相对MA20的偏离按ATR归一化\n"
            + (f"MA20乖离 {distance:+.2f} ATR; {_ma20_deviation_status(distance)}"
               if distance is not None else "当前缺少价格, MA20或ATR数据"),
            "coverage": 1.0 if deviation_score is not None else 0.0,
            "raw_values": _raw_values(
                close=_number(records[index].get("close")),
                ma20=_number(records[index].get("ma20")),
                atr14=_number(records[index].get("atr_14")),
                distance_atr=distance,
                deviation_score=deviation_score,
                oversold_score=oversold_score,
                overheat_score=overheat_score,
            ),
        },
        {
            "id": "downside_volatility", "name": "下行波动率", "score": round(downside_risk_score) if downside_risk_score is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["volatility_risk"]["downside_volatility"],
            "group": "downside", "score_label": "风险",
            "status": _risk_percentile_status(downside_percentile, high="下行波动偏高", low="下行波动偏低"),
            "detail": "仅使用负收益计算20周期下行波动率\n"
            + (f"历史分位 {downside_percentile:.0f}% / {downside_history_count}个样本; 负收益 {negative_return_count}个"
               if downside_percentile is not None else f"历史有效样本 {downside_history_count}个, 数据不足"),
            "coverage": 1.0 if downside_percentile is not None else 0.0,
            "raw_values": _raw_values(
                downside_volatility=current_downside,
                percentile=downside_percentile,
                risk_score=downside_risk_score,
                negative_count=negative_return_count,
                history_count=downside_history_count,
                history_window=_RISK_HISTORY_WINDOW,
            ),
        },
        {
            "id": "rolling_drawdown", "name": "回撤损伤", "score": round(drawdown_score) if drawdown_score is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["volatility_risk"]["rolling_drawdown"],
            "group": "downside", "score_label": "损伤",
            "status": _score_status(drawdown_score, high="回撤损伤较深", low="回撤损伤有限"),
            "detail": "20/60周期当前回撤的历史分位组合, 表示市场损伤而非未来下跌风险\n"
            + (f"20周期 {_format_drawdown_detail(drawdown_20, drawdown_20_percentile)}; "
               f"60周期 {_format_drawdown_detail(drawdown_60, drawdown_60_percentile)}; "
               f"{'市场损伤状态' if drawdown_score is not None else '历史回撤分位样本不足'}"
               if drawdown_20 is not None or drawdown_60 is not None else "回撤窗口数据不足"),
            "coverage": drawdown_coverage,
            "raw_values": _raw_values(
                drawdown_20_pct=drawdown_20,
                drawdown_60_pct=drawdown_60,
                drawdown_20_percentile=drawdown_20_percentile,
                drawdown_60_percentile=drawdown_60_percentile,
                drawdown_20_history_count=drawdown_20_history_count,
                drawdown_60_history_count=drawdown_60_history_count,
                drawdown_20_score=drawdown_20_score,
                drawdown_60_score=drawdown_60_score,
                drawdown_pct=drawdown_20,
            ),
        },
    ]
    return {
        "indicators": risk_indicators,
        "atr_percentile": atr_percentile,
        "realized_vol_percentile": realized_vol_percentile,
        "boll": boll,
        "distance_atr": distance,
        "deviation_score": deviation_score,
        "oversold_score": oversold_score,
        "overheat_score": overheat_score,
        "downside_percentile": downside_percentile,
        "drawdown_20_percentile": drawdown_20_percentile,
        "drawdown_60_percentile": drawdown_60_percentile,
        "drawdown_score": drawdown_score,
    }


def _risk_group_score(indicators: list[dict], group: str) -> tuple[float | None, float]:
    by_id = {str(indicator.get("id")): indicator for indicator in indicators}
    weights = _CATEGORY_INDICATOR_WEIGHTS["volatility_risk"]
    parts = [
        (
            by_id.get(indicator_id, {}).get("score"),
            float(weights[indicator_id]),
            float(by_id.get(indicator_id, {}).get("coverage", 0.0)),
        )
        for indicator_id in _RISK_GROUP_INDICATOR_IDS[group]
    ]
    return _weighted_partial_score(parts)


def _risk_category(analysis: dict, *, risk_change_5: float | None = None) -> dict:
    indicators = analysis["indicators"]
    volatility_score, volatility_coverage = _risk_group_score(indicators, "volatility")
    downside_score, downside_coverage = _risk_group_score(indicators, "downside")
    total_score, total_coverage = _weighted_partial_score((
        (volatility_score, _RISK_GROUP_WEIGHTS["volatility"], volatility_coverage),
        (downside_score, _RISK_GROUP_WEIGHTS["downside"], downside_coverage),
    ))
    minimum_coverage = 0.60
    category_available = total_score is not None and total_coverage >= minimum_coverage
    meta = _CATEGORY_META["volatility_risk"]
    category = {
        "id": "volatility_risk",
        "name": meta["name"],
        "kind": meta["kind"],
        "weight": meta["weight"],
        "score": round(total_score) if category_available and total_score is not None else None,
        "status": _risk_category_status(round(total_score) if category_available and total_score is not None else None),
        "coverage": round(total_coverage * 100.0),
        "available": category_available,
        "volatility_score": round(volatility_score) if volatility_score is not None and volatility_coverage >= minimum_coverage else None,
        "volatility_coverage": round(volatility_coverage * 100.0),
        "downside_score": round(downside_score) if downside_score is not None and downside_coverage >= minimum_coverage else None,
        "downside_coverage": round(downside_coverage * 100.0),
        "volatility_weight": _RISK_GROUP_WEIGHTS["volatility"],
        "downside_weight": _RISK_GROUP_WEIGHTS["downside"],
        "risk_change_5": round(risk_change_5) if risk_change_5 is not None else None,
        "risk_trend": _risk_trend_label(risk_change_5),
        "indicators": indicators,
        "oversold_score": round(analysis["oversold_score"]) if analysis["oversold_score"] is not None else None,
        "overheat_score": round(analysis["overheat_score"]) if analysis["overheat_score"] is not None else None,
    }
    category["conclusion"] = _risk_category_conclusion(category, analysis)
    return category


def _risk_category_score(records: list[dict], index: int) -> float | None:
    return _risk_category(_risk_analysis(records, index))["score"]


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


def _range_bounds(records: list[dict], index: int, window: int) -> tuple[float | None, float | None]:
    if index < window - 1:
        return None, None
    highs = [_number(row.get("high")) for row in records[index - window + 1:index + 1]]
    lows = [_number(row.get("low")) for row in records[index - window + 1:index + 1]]
    if any(value is None for value in (*highs, *lows)):
        return None, None
    return (
        min(value for value in lows if value is not None),
        max(value for value in highs if value is not None),
    )


def _range_position(records: list[dict], index: int, window: int) -> float | None:
    low, high = _range_bounds(records, index, window)
    close = _number(records[index].get("close"))
    if close is None or low is None or high is None:
        return None
    return _clamp((close - low) / (high - low) * 100.0) if high > low else 50.0


def _position_percentile_status(value: float | None) -> str:
    if value is None:
        return "数据不足"
    if value <= 10.0:
        return "极低位"
    if value <= 30.0:
        return "低位"
    if value < 70.0:
        return "中位"
    if value < 90.0:
        return "高位"
    return "极高位"


def _boll_position(records: list[dict], index: int) -> float | None:
    row = records[index]
    close = _number(row.get("close"))
    upper = _number(row.get("boll_upper"))
    lower = _number(row.get("boll_lower"))
    if close is None or upper is None or lower is None or upper <= lower:
        return None
    return _clamp((close - lower) / (upper - lower) * 100.0)


def _boll_position_status(value: float | None) -> str:
    if value is None:
        return "数据不足"
    if value <= 10.0:
        return "接近下轨"
    if value <= 30.0:
        return "通道偏下"
    if value < 70.0:
        return "通道中部"
    if value < 90.0:
        return "通道偏上"
    return "接近上轨"


def _ma20_atr_distance(records: list[dict], index: int) -> float | None:
    row = records[index]
    close = _number(row.get("close"))
    ma20 = _number(row.get("ma20"))
    atr = _number(row.get("atr_14"))
    if close is None or ma20 is None or atr is None or atr <= 0:
        return None
    return (close - ma20) / atr


def _ma20_atr_position_status(distance: float | None) -> str:
    if distance is None:
        return "数据不足"
    if distance <= -2.0:
        return "极端偏低"
    if distance <= -1.0:
        return "明显偏低"
    if distance < -0.25:
        return "偏低"
    if distance <= 0.25:
        return "MA20附近"
    if distance < 1.0:
        return "偏高"
    if distance < 2.0:
        return "明显偏高"
    return "极端偏高"


def _ma20_atr_position(records: list[dict], index: int) -> float | None:
    distance = _ma20_atr_distance(records, index)
    if distance is None:
        return None
    return _clamp(50.0 + 50.0 * math.tanh(distance / 2.0))


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
    volume_price_analysis: dict | None = None,
    obv_values: list[float | None] | None = None,
    metric_context: _RiskMetricContext | None = None,
    risk_cache: dict[int, dict] | None = None,
) -> dict:
    row = records[index]
    previous = records[index - 1] if index > 0 else {}
    volume_price_analysis = volume_price_analysis or _volume_price_analysis(records, index, obv_values)

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

    volume_price = volume_price_analysis
    rvol_score = volume_price["rvol_score"]
    rvol_status = volume_price["rvol_status"]
    persistence = volume_price["persistence"]
    obv = volume_price["obv"]
    volume_price_indicators = [
        {
            "id": "rvol", "name": "RVOL 相对量能", "score": round(volume_price["rvol_directional_score"]) if volume_price["rvol_directional_score"] is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["volume_price"]["rvol"],
            "status": rvol_status,
            "detail": "当前成交量相对前20周期均量, 当前量不参与基准均值",
            "summary": f"RVOL {volume_price['rvol']:.2f}x · {rvol_status}" if volume_price["rvol"] is not None else rvol_status,
            "raw_values": _raw_values(
                rvol=volume_price["rvol"],
                confirmation_score=rvol_score,
                directional_score=volume_price["rvol_directional_score"],
                confirmation_factor=volume_price["confirmation_factor"],
            ),
        },
        {
            "id": "price_volume", "name": "量价关系", "score": round(volume_price["relation_score"]) if volume_price["relation_score"] is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["volume_price"]["price_volume"],
            "coverage": volume_price["relation_coverage"],
            "status": volume_price["relation_status"],
            "detail": "当前周期占60%, 最近5周期按近高远低加权占40%\n"
            + f"{volume_price['relation_status']} · {persistence['status']}",
            "persistence": persistence["status"],
            "summary": f"{volume_price['relation_status']} · {persistence['status']}",
            "raw_values": _raw_values(
                change_pct=volume_price["change"],
                relation_ratio=volume_price["relation_ratio"],
                current_score=volume_price["current_relation_score"],
                persistence_score=persistence["score"],
                persistence_signal=persistence["signal"],
                persistence_sample_count=persistence["sample_count"],
                shrink_weight=persistence["shrink_weight"],
                confirmation_factor=volume_price["confirmation_factor"],
            ),
        },
        {
            "id": "obv", "name": "OBV 资金趋势", "score": round(obv["score"]) if obv["score"] is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["volume_price"]["obv"],
            "coverage": obv["coverage"],
            "status": obv["status"],
            "detail": "OBV趋势、突破与价格背离\n" + obv["detail"],
            "state": obv["trend_state"],
            "breakout": obv["breakout"],
            "divergence": obv["divergence"],
            "summary": obv["summary"],
            "raw_values": obv["raw_values"],
        },
    ]

    range20 = _range_position(records, index, 20)
    range60 = _range_position(records, index, 60)
    range20_low, range20_high = _range_bounds(records, index, 20)
    range60_low, range60_high = _range_bounds(records, index, 60)
    boll_position = _boll_position(records, index)
    boll_status = _boll_position_status(boll_position)
    ma20_atr_distance = _ma20_atr_distance(records, index)
    ma20_atr_position = _ma20_atr_position(records, index)
    position_indicators = [
        {
            "id": "range_position_20", "name": "短期位置", "score": None,
            "value": round(range20, 2) if range20 is not None else None,
            "weight": None,
            "status": _position_percentile_status(range20),
            "detail": "近20周期价格区间的位置百分位\n"
            + _position_percentile_status(range20),
            "raw_values": _raw_values(
                close=close,
                period_low=range20_low,
                period_high=range20_high,
                position=range20,
            ),
        },
        {
            "id": "range_position_60", "name": "中期位置", "score": None,
            "value": round(range60, 2) if range60 is not None else None,
            "weight": None,
            "status": _position_percentile_status(range60),
            "detail": "近60周期价格区间的位置百分位\n"
            + _position_percentile_status(range60),
            "raw_values": _raw_values(
                close=close,
                period_low=range60_low,
                period_high=range60_high,
                position=range60,
            ),
        },
        {
            "id": "boll_position", "name": "BOLL位置", "score": None,
            "value": round(boll_position, 2) if boll_position is not None else None,
            "weight": None,
            "status": boll_status,
            "detail": "价格在BOLL上下轨之间的通道百分位\n"
            + boll_status,
            "raw_values": _raw_values(
                close=close,
                upper=row.get("boll_upper"),
                middle=ma20,
                lower=row.get("boll_lower"),
                position=boll_position,
            ),
        },
        {
            "id": "ma20_atr_position", "name": "均值偏离", "score": None,
            "value": round(ma20_atr_position, 2) if ma20_atr_position is not None else None,
            "weight": None,
            "status": _ma20_atr_position_status(ma20_atr_distance),
            "detail": "价格相对MA20的偏离按ATR归一化\n"
            + _ma20_atr_position_status(ma20_atr_distance),
            "raw_values": _raw_values(
                close=close,
                ma20=ma20,
                atr14=atr14,
                distance_atr=ma20_atr_distance,
                position=ma20_atr_position,
            ),
        },
    ]
    price_position_category = _price_position_category(position_indicators)

    if risk_cache is None:
        risk_analysis = _risk_analysis(records, index, metric_context)
    else:
        risk_analysis = risk_cache.get(index)
        if risk_analysis is None:
            risk_analysis = _risk_analysis(records, index, metric_context)
            risk_cache[index] = risk_analysis

    activity_metrics = _activity_metrics(records, index)
    amount = activity_metrics["amount"]
    amount_average = activity_metrics["amount_average"]
    amount_ratio = activity_metrics["amount_ratio"]
    amount_ratio_score = _activity_level_score(amount_ratio)
    amount_ma5 = activity_metrics["amount_ma5"]
    amount_ma20 = activity_metrics["amount_ma20"]
    amount_ma_ratio = activity_metrics["amount_ma_ratio"]
    amount_ma_score = _activity_level_score(amount_ma_ratio)
    activity_indicators = [
        {
            "id": "amount_ratio_20", "name": "成交额 / 前20周期均额", "score": round(amount_ratio_score) if amount_ratio_score is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["activity"]["amount_ratio_20"],
            "status": _activity_indicator_status(amount_ratio_score, high="成交放大", low="成交收缩", middle="成交一般"),
            "detail": "当前成交额相对前20周期平均成交额",
            "raw_values": _raw_values(amount=amount, average_amount=amount_average, ratio=amount_ratio),
        },
        {
            "id": "amount_ma5_ma20", "name": "成交额 MA5 / MA20", "score": round(amount_ma_score) if amount_ma_score is not None else None,
            "weight": _CATEGORY_INDICATOR_WEIGHTS["activity"]["amount_ma5_ma20"],
            "status": _activity_indicator_status(amount_ma_score, high="短期有所升温", low="短期有所降温", middle="短期平稳"),
            "detail": "成交额短期均值相对20周期均值",
            "raw_values": _raw_values(amount_ma5=amount_ma5, amount_ma20=amount_ma20, ratio=amount_ma_ratio),
        },
    ]

    trend_category = _weighted_category("trend", trend_indicators)
    if trend_mode == _TREND_DATA_MODE_INSUFFICIENT:
        trend_category.update(score=None, status="数据不足", coverage=0, available=False)
    else:
        trend_category["status"] = _trend_category_status(trend_category["score"], trend_mode)
    trend_category["conclusion"] = _trend_category_conclusion(trend_category)

    volume_price_category = _weighted_category("volume_price", volume_price_indicators)
    volume_price_category.update({
        "direction_status": volume_price["direction_status"],
        "phase": volume_price["phase"],
        "alert": volume_price["alert"],
        "conclusion": volume_price["conclusion"],
    })
    if volume_price_category["score"] is None:
        volume_price_category["status"] = "数据不足"
        volume_price_category["phase"] = "数据不足"
    else:
        volume_price_category["status"] = _volume_price_direction_status(volume_price_category["score"])

    momentum_category = _weighted_category("momentum", momentum_indicators)
    momentum_category["conclusion"] = _momentum_category_conclusion(momentum_category)

    risk_category = _risk_category(risk_analysis)
    risk_change_5 = None
    if index >= 5 and risk_category["score"] is not None:
        if risk_cache is None:
            previous_risk_analysis = _risk_analysis(records, index - 5, metric_context)
        else:
            previous_risk_analysis = risk_cache.get(index - 5)
            if previous_risk_analysis is None:
                previous_risk_analysis = _risk_analysis(records, index - 5, metric_context)
                risk_cache[index - 5] = previous_risk_analysis
        previous_risk = _risk_category(previous_risk_analysis)["score"]
        if previous_risk is not None:
            risk_change_5 = risk_category["score"] - previous_risk
    if risk_change_5 is not None:
        risk_category = _risk_category(risk_analysis, risk_change_5=risk_change_5)

    categories = [
        trend_category,
        momentum_category,
        volume_price_category,
        price_position_category,
        risk_category,
        _weighted_category("activity", activity_indicators),
    ]
    by_id = {category["id"]: category for category in categories}
    direction_weight_total = sum(_CATEGORY_DIRECTION_WEIGHTS.values())
    direction_coverage = sum(
        _CATEGORY_DIRECTION_WEIGHTS[category_id] * by_id[category_id]["coverage"] / 100.0
        for category_id in _CATEGORY_DIRECTION_WEIGHTS
    ) / direction_weight_total if direction_weight_total > 0 else 0.0
    direction_parts = [
        (by_id[category_id]["score"], weight, by_id[category_id]["coverage"] / 100.0)
        for category_id, weight in _CATEGORY_DIRECTION_WEIGHTS.items()
    ]
    direction_score, _ = _weighted_score(direction_parts)
    direction_available = (
        sum(by_id[category_id]["available"] for category_id in _CATEGORY_DIRECTION_WEIGHTS) >= 2
        and direction_coverage >= 0.70
        and direction_score is not None
    )
    activity_category = by_id["activity"]
    activity_category["status"] = _activity_category_status(activity_category["score"])
    activity_category["conclusion"] = _activity_category_conclusion(activity_category)
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
    obv_values = _obv_series(records, len(records) - 1) if records else []
    metric_context = _build_risk_metric_context(records)
    risk_cache: dict[int, dict] = {}
    for index in range(len(records)):
        trend, trend_coverage = _trend_score(records, index)
        momentum, momentum_coverage = _momentum_score(records, index, roc_context)
        volume_price_analysis = _volume_price_analysis(records, index, obv_values)
        volume_price = volume_price_analysis["score"]
        volume_price_coverage = volume_price_analysis["coverage"]
        state_confirmation, state_coverage = _state_confirmation_score((trend, momentum, volume_price))
        activity = _activity_score(records, index)
        category_scores = _category_scores(
            records,
            index,
            roc_context,
            volume_price_analysis,
            obv_values,
            metric_context=metric_context,
            risk_cache=risk_cache,
        )
        volatility = category_scores["risk_score"]
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
            obv_values = _obv_series(records, len(records) - 1) if records else []
            categories.extend(
                _category_scores(records, index, roc_context, obv_values=obv_values)["categories"]
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
