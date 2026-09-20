"""外部因子定义 API。"""
from __future__ import annotations

from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app.external_factors import engine
from app.external_factors.models import (
    CATEGORY_LABELS,
    ExternalFactorDefinition,
    to_factor_spec,
)
from app.external_factors.store import ExternalFactorStore, now
from app.factors.registry import get_factor
from app.services.ext_data import ExtConfigStore

router = APIRouter(prefix="/api/external-factors", tags=["external-factors"])


class ExternalFactorCreateRequest(BaseModel):
    id: str = Field(..., min_length=4, max_length=48, pattern=r"^ef_[a-z0-9_]{1,40}$")
    label: str = Field(..., min_length=1, max_length=48)
    category: Literal[
        "market", "industry", "constituents", "relative", "cross_market",
        "flow", "liquidity", "sentiment", "valuation", "fundamental",
        "commodity", "event",
    ] = "market"
    operation: Literal["direct", "difference"] = "direct"
    source_type: Literal["index_daily", "ext_timeseries", "factor_pair"] = "index_daily"
    source_symbol: str | None = Field(default=None, max_length=64)
    source_config_id: str | None = Field(default=None, max_length=64)
    source_field: str | None = Field(default=None, max_length=64)
    transform: Literal["value", "return"] = "value"
    window: int = Field(default=1, ge=1, le=512)
    left_factor_id: str | None = Field(default=None, max_length=64)
    right_factor_id: str | None = Field(default=None, max_length=64)
    description: str = Field(default="", max_length=500)
    direction: Literal["high", "low", "none"] = "none"
    unit: Literal["ratio", "pct", "score", "count", "days", "currency", "none"] = "ratio"
    asset_types: list[Literal["stock", "etf"]] = Field(default_factory=lambda: ["stock", "etf"])
    pit: bool = True
    status: Literal["draft", "active", "watch", "retired"] = "draft"


def _data_dir(request: Request) -> Path:
    root = getattr(getattr(getattr(request.app.state, "repo", None), "store", None), "data_dir", None)
    if root is None:
        raise HTTPException(500, "数据目录不可用")
    return Path(root)


def _definition(body: ExternalFactorCreateRequest) -> ExternalFactorDefinition:
    return ExternalFactorDefinition(
        id=body.id.strip(),
        label=body.label.strip(),
        category=body.category,
        operation=body.operation,
        source_type=body.source_type,
        source_symbol=body.source_symbol.strip() if body.source_symbol else None,
        source_config_id=body.source_config_id.strip() if body.source_config_id else None,
        source_field=body.source_field.strip() if body.source_field else None,
        transform=body.transform,
        window=body.window,
        left_factor_id=body.left_factor_id.strip() if body.left_factor_id else None,
        right_factor_id=body.right_factor_id.strip() if body.right_factor_id else None,
        group=f"外部·{CATEGORY_LABELS[body.category]}",
        description=body.description.strip(),
        direction=body.direction,
        unit=body.unit,
        asset_types=tuple(body.asset_types),
        pit=body.pit,
        status=body.status,
        created_at=now(),
        updated_at=now(),
    )


def _validate_source(root: Path, definition: ExternalFactorDefinition) -> None:
    if definition.operation != "direct" or definition.source_type != "ext_timeseries":
        return
    config = ExtConfigStore(root).get(definition.source_config_id or "")
    if config is None:
        raise HTTPException(400, f"扩展数据配置不存在: {definition.source_config_id}")
    if config.mode != "timeseries":
        raise HTTPException(400, "按日期广播来源必须是 timeseries 配置")
    field = next((field for field in config.fields if field.name == definition.source_field), None)
    if field is None:
        raise HTTPException(400, f"扩展数据字段不存在: {definition.source_field}")
    if field.dtype not in ("int", "float"):
        raise HTTPException(400, "按日期广播来源字段必须是数值字段")


@router.get("")
def list_external_factors(request: Request) -> dict:
    root = _data_dir(request)
    engine.ensure_synced(root)
    return {"items": [item.to_dict() for item in ExternalFactorStore(root).load_all()]}


@router.post("")
def create_external_factor(body: ExternalFactorCreateRequest, request: Request) -> dict:
    root = _data_dir(request)
    factor_store = ExternalFactorStore(root)
    if factor_store.get(body.id):
        raise HTTPException(400, f"外部因子 '{body.id}' 已存在")

    definition = _definition(body)
    _validate_source(root, definition)
    # 相对强弱允许引用已有 ext_ 原始列; 先同步旧扩展字段, 再解析左右因子。
    from app.factors.ext_factors import ensure_synced as ensure_raw_ext_synced

    ensure_raw_ext_synced(root)
    engine.ensure_synced(root)
    if get_factor(body.id) is not None:
        raise HTTPException(400, f"因子 id '{body.id}' 已被占用")
    try:
        spec = to_factor_spec(definition)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    factor_store.save(definition)
    try:
        engine.invalidate(root)
        engine.ensure_synced(root)
    except Exception as exc:
        factor_store.delete(definition.id)
        raise HTTPException(400, f"外部因子注册失败: {exc}") from exc
    return {"ok": True, "factor": definition.to_dict(), "spec": spec.column_view()}


@router.delete("/{factor_id}")
def delete_external_factor(factor_id: str, request: Request) -> dict:
    root = _data_dir(request)
    factor_store = ExternalFactorStore(root)
    definition = factor_store.get(factor_id)
    if definition is None:
        raise HTTPException(404, f"外部因子不存在: {factor_id}")
    references = [
        item.id for item in factor_store.load_all()
        if item.id != factor_id
        and factor_id in (item.left_factor_id, item.right_factor_id)
    ]
    if references:
        raise HTTPException(409, {"message": "外部因子仍被引用", "references": references})
    factor_store.delete(factor_id)
    from app.factors.registry import unregister_factor

    unregister_factor(factor_id)
    engine.invalidate(root)
    return {"ok": True, "id": factor_id}
