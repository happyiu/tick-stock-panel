"""Commodity catalog, local history and multi-source synchronization API."""
from __future__ import annotations

import logging
from datetime import date
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from app.data_providers.commodity import (
    COMMODITY_DEFINITIONS,
    definitions_for,
)
from app.data_providers.commodity import (
    catalog as commodity_catalog,
)
from app.services.commodity_sync import CommoditySyncBusyError, sync_commodities

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/commodity", tags=["commodity"])

SOURCE_LABELS = {
    "goldapi": "Gold API",
    "fred": "FRED",
    "eia": "EIA",
}


class CommoditySyncIn(BaseModel):
    start_date: date | None = None
    end_date: date | None = None
    symbols: list[str] | None = None


def _source_status() -> dict[str, dict[str, Any]]:
    from app.data_providers import custom as custom_sources

    plugin_status = {item["name"]: item for item in custom_sources.list_plugins()}
    return {
        name: {
            "name": name,
            "display_name": SOURCE_LABELS[name],
            "configured": bool(plugin_status.get(name, {}).get("api_key_masked")),
            "available": bool(plugin_status.get(name, {}).get("available")),
            "status": plugin_status.get(name, {}).get("status", "插件未加载"),
            "api_key_env": plugin_status.get(name, {}).get("api_key_env", ""),
        }
        for name in SOURCE_LABELS
    }


@router.get("/catalog")
def get_catalog() -> dict[str, Any]:
    return {
        "items": commodity_catalog(),
        "sources": _source_status(),
    }


@router.get("/quotes")
def get_current_quotes() -> dict[str, Any]:
    from app.data_providers import custom as custom_sources

    try:
        provider = custom_sources.get_provider("goldapi")
        fetch = getattr(provider, "get_current_prices", None)
        if fetch is None:
            raise ValueError("Gold API 未实现当前价格能力")
        return {"source": "goldapi", "items": fetch()}
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("commodity current quotes failed")
        raise HTTPException(status_code=502, detail=f"Gold API 当前价格请求失败: {exc}") from exc


@router.get("")
def list_commodities(
    request: Request,
    start_date: date | None = None,
    end_date: date | None = None,
    symbol: str | None = None,
    category: str | None = None,
    limit: int = Query(10_000, ge=1, le=10_000),
) -> dict[str, Any]:
    if start_date is not None and end_date is not None and start_date > end_date:
        raise HTTPException(status_code=400, detail="开始日期不能晚于结束日期")
    if symbol:
        try:
            definitions_for([symbol])
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    valid_categories = {"precious_metal", "crypto", "energy", "energy_fundamental"}
    if category and category not in valid_categories:
        raise HTTPException(status_code=400, detail=f"不支持的商品分类: {category}")

    conditions: list[str] = []
    params: list[Any] = []
    active_sources = sorted({definition.source for definition in COMMODITY_DEFINITIONS})
    conditions.append("source IN (" + ", ".join("?" for _ in active_sources) + ")")
    params.extend(active_sources)
    if start_date is not None:
        conditions.append("date >= ?")
        params.append(start_date)
    if end_date is not None:
        conditions.append("date <= ?")
        params.append(end_date)
    if symbol:
        conditions.append("symbol = ?")
        params.append(symbol.strip().upper())
    if category:
        conditions.append("category = ?")
        params.append(category)
    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    sql = f"""
        SELECT symbol, name, category, kind, date, value, unit, frequency,
               source, source_series_id, retrieved_at
        FROM commodity
        {where}
        ORDER BY date ASC, symbol ASC, source ASC
        LIMIT ?
    """
    params.append(limit)
    try:
        rows = request.app.state.repo.execute_all(sql, params)
    except Exception as exc:
        logger.debug("commodity view unavailable: %s", exc)
        rows = []
    items = [
        {
            "symbol": row[0],
            "name": row[1],
            "category": row[2],
            "kind": row[3],
            "date": row[4].isoformat() if hasattr(row[4], "isoformat") else str(row[4]),
            "value": float(row[5]),
            "unit": row[6],
            "frequency": row[7],
            "source": row[8],
            "source_series_id": row[9],
            "retrieved_at": row[10],
        }
        for row in rows
    ]
    return {"items": items, "count": len(items)}


@router.post("/sync")
def sync_commodity_data(req: CommoditySyncIn, request: Request) -> dict[str, Any]:
    try:
        result = sync_commodities(
            request.app.state.repo,
            start=req.start_date,
            end=req.end_date,
            symbols=req.symbols,
        )
        if not result["ok"]:
            raise HTTPException(
                status_code=502,
                detail={"message": "所有商品数据源均同步失败", "result": result},
            )
        return result
    except CommoditySyncBusyError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("commodity sync failed")
        raise HTTPException(status_code=502, detail=f"商品数据源请求失败: {exc}") from exc
