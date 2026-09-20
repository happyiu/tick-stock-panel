"""外部因子定义模型。

外部因子的来源与计算类型独立于 ext_data 的原始接入配置:
ext_data 负责保存数据, ExternalFactorDefinition 负责说明这些数据如何进入
ETF/股票面板。首期只开放按日期广播, 避免把全市场数据误当成标的自身字段。
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from app.factors.registry import FactorSpec, get_factor

ExternalCategory = Literal[
    "market", "industry", "constituents", "relative", "cross_market",
    "flow", "liquidity", "sentiment", "valuation", "fundamental",
    "commodity", "event",
]
ExternalOperation = Literal["direct", "difference"]
ExternalSourceType = Literal["index_daily", "ext_timeseries", "factor_pair"]

EXTERNAL_FACTOR_PREFIX = "ef_"
EXTERNAL_FACTOR_ID_PATTERN = re.compile(r"^ef_[a-z0-9_]{1,40}$")
EXTERNAL_ALIGNMENT = "date_broadcast"
CATEGORY_LABELS: dict[str, str] = {
    "market": "市场",
    "industry": "行业",
    "constituents": "成分股",
    "relative": "相对强弱",
    "cross_market": "跨市场",
    "flow": "资金流",
    "liquidity": "流动性",
    "sentiment": "情绪",
    "valuation": "估值",
    "fundamental": "基本面",
    "commodity": "商品",
    "event": "事件",
}


@dataclass(frozen=True)
class ExternalFactorDefinition:
    id: str
    label: str
    category: str
    operation: str
    source_type: str
    source_symbol: str | None = None
    source_config_id: str | None = None
    source_field: str | None = None
    transform: str = "value"
    window: int = 1
    left_factor_id: str | None = None
    right_factor_id: str | None = None
    group: str = ""
    description: str = ""
    direction: str = "none"
    unit: str = "ratio"
    asset_types: tuple[str, ...] = ("stock", "etf")
    pit: bool = True
    status: str = "draft"
    version: int = 1
    alignment: str = EXTERNAL_ALIGNMENT
    created_at: str = ""
    updated_at: str = ""

    @classmethod
    def from_dict(cls, raw: dict) -> ExternalFactorDefinition:
        return cls(
            id=str(raw.get("id", "")),
            label=str(raw.get("label", "")),
            category=str(raw.get("category", "market")),
            operation=str(raw.get("operation", "direct")),
            source_type=str(raw.get("source_type", "ext_timeseries")),
            source_symbol=_optional_text(raw.get("source_symbol")),
            source_config_id=_optional_text(raw.get("source_config_id")),
            source_field=_optional_text(raw.get("source_field")),
            transform=str(raw.get("transform", "value")),
            window=int(raw.get("window", 1)),
            left_factor_id=_optional_text(raw.get("left_factor_id")),
            right_factor_id=_optional_text(raw.get("right_factor_id")),
            group=str(raw.get("group", "")),
            description=str(raw.get("description", "")),
            direction=str(raw.get("direction", "none")),
            unit=str(raw.get("unit", "ratio")),
            asset_types=tuple(str(v) for v in raw.get("asset_types", ("stock", "etf"))),
            pit=bool(raw.get("pit", True)),
            status=str(raw.get("status", "draft")),
            version=int(raw.get("version", 1)),
            alignment=str(raw.get("alignment", EXTERNAL_ALIGNMENT)),
            created_at=str(raw.get("created_at", "")),
            updated_at=str(raw.get("updated_at", "")),
        )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "category": self.category,
            "operation": self.operation,
            "source_type": self.source_type,
            "source_symbol": self.source_symbol,
            "source_config_id": self.source_config_id,
            "source_field": self.source_field,
            "transform": self.transform,
            "window": self.window,
            "left_factor_id": self.left_factor_id,
            "right_factor_id": self.right_factor_id,
            "group": self.group or f"外部·{CATEGORY_LABELS.get(self.category, self.category)}",
            "description": self.description,
            "direction": self.direction,
            "unit": self.unit,
            "asset_types": list(self.asset_types),
            "pit": self.pit,
            "status": self.status,
            "version": self.version,
            "alignment": self.alignment,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


def _optional_text(value) -> str | None:
    text = str(value).strip() if value is not None else ""
    return text or None


def validate_definition_shape(definition: ExternalFactorDefinition) -> None:
    if not EXTERNAL_FACTOR_ID_PATTERN.fullmatch(definition.id):
        raise ValueError(f"id 必须匹配 {EXTERNAL_FACTOR_ID_PATTERN.pattern}")
    if not definition.label.strip():
        raise ValueError("label 不能为空")
    if definition.category not in CATEGORY_LABELS:
        raise ValueError(f"未知外部因子分类: {definition.category}")
    if definition.alignment != EXTERNAL_ALIGNMENT:
        raise ValueError("当前只支持按日期广播")
    if definition.operation not in ("direct", "difference"):
        raise ValueError("operation 必须是 direct 或 difference")
    if definition.window < 1 or definition.window > 512:
        raise ValueError("window 必须在 1~512 之间")
    if definition.direction not in ("high", "low", "none"):
        raise ValueError("direction 必须是 high、low 或 none")
    if definition.status not in ("draft", "active", "watch", "retired"):
        raise ValueError("status 不合法")
    if not definition.asset_types or not set(definition.asset_types).issubset({"stock", "etf"}):
        raise ValueError("asset_types 只能包含 stock、etf")

    if definition.operation == "direct":
        if definition.source_type not in ("index_daily", "ext_timeseries"):
            raise ValueError("direct 因子来源必须是 index_daily 或 ext_timeseries")
        if definition.source_type == "index_daily":
            if not definition.source_symbol:
                raise ValueError("指数来源必须填写 source_symbol")
            if definition.source_field != "close":
                raise ValueError("指数来源首期只支持 close")
            if definition.transform != "return":
                raise ValueError("指数来源首期只支持收益率变换")
        else:
            if not definition.source_config_id or not definition.source_field:
                raise ValueError("扩展数据来源必须填写 source_config_id、source_field")
            if definition.transform != "value":
                raise ValueError("扩展数据来源首期只支持原值广播")
        return

    if definition.source_type != "factor_pair":
        raise ValueError("difference 因子来源必须是 factor_pair")
    if not definition.left_factor_id or not definition.right_factor_id:
        raise ValueError("difference 因子必须填写左右两侧因子")
    if definition.left_factor_id == definition.right_factor_id:
        raise ValueError("difference 因子的左右两侧不能相同")


def to_factor_spec(definition: ExternalFactorDefinition) -> FactorSpec:
    """把独立定义转换为注册表条目; 来源数据由 engine 物化。"""
    validate_definition_shape(definition)
    group = definition.group or f"外部·{CATEGORY_LABELS.get(definition.category, definition.category)}"
    if definition.operation == "difference":
        assert definition.left_factor_id and definition.right_factor_id
        left = get_factor(definition.left_factor_id)
        right = get_factor(definition.right_factor_id)
        if left is None or right is None:
            missing = definition.left_factor_id if left is None else definition.right_factor_id
            raise ValueError(f"未知差值因子: {missing}")
        dependencies = frozenset((left.id, right.id))
        warmup = max(left.warmup_bars, right.warmup_bars)
        formula = f"{left.id} - {right.id} (按日期广播)"
        scale_free = True
    elif definition.source_type == "index_daily":
        formula = f"指数 {definition.source_symbol} 收盘价 {definition.window}日收益 (按日期广播)"
        dependencies = frozenset()
        warmup = definition.window + 1
        scale_free = True
    else:
        formula = f"扩展数据 {definition.source_config_id}.{definition.source_field} (按日期广播)"
        dependencies = frozenset()
        warmup = 1
        scale_free = False

    return FactorSpec(
        id=definition.id,
        label=definition.label.strip(),
        group=group,
        formula_text=formula,
        kind="base",
        version=definition.version,
        dependencies=dependencies,
        direction=definition.direction,  # type: ignore[arg-type]
        unit=definition.unit,  # type: ignore[arg-type]
        warmup_bars=warmup,
        pit=definition.pit,
        asset_types=frozenset(definition.asset_types),
        scale_free=scale_free,
        stability="stable" if definition.status == "active" else "experimental",
        tags=("external-factor", definition.category, definition.alignment),
    )
