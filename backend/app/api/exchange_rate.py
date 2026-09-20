"""Exchange-rate API: read local data and trigger current or historical sync."""
from __future__ import annotations

import logging
from datetime import date

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from app.services.exchange_rate_sync import ExchangeRateSyncBusyError, sync_exchange_rates

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/exchange-rate", tags=["exchange-rate"])


class ExchangeRateSyncIn(BaseModel):
    start_date: date | None = None
    end_date: date | None = None


@router.get("")
def list_exchange_rates(
    request: Request,
    start_date: date | None = None,
    end_date: date | None = None,
    limit: int = Query(1000, ge=1, le=10000),
) -> dict:
    """Read normalized exchange-rate rows from the local DuckDB view."""
    if start_date is not None and end_date is not None and start_date > end_date:
        raise HTTPException(status_code=400, detail="开始日期不能晚于结束日期")

    conditions: list[str] = []
    params: list[date | int] = []
    if start_date is not None:
        conditions.append("date >= ?")
        params.append(start_date)
    if end_date is not None:
        conditions.append("date <= ?")
        params.append(end_date)
    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    sql = f"""
        SELECT symbol, date, base, quote, rate, source, frequency, retrieved_at
        FROM exchange_rate
        {where}
        ORDER BY date ASC, symbol ASC
        LIMIT ?
    """
    params.append(limit)
    try:
        rows = request.app.state.repo.execute_all(sql, params)
    except Exception as exc:
        # 首次启动尚未有 parquet 时视图不存在, 读接口按空表处理。
        logger.debug("exchange_rate view unavailable: %s", exc)
        rows = []
    items = [
        {
            "symbol": row[0],
            "date": row[1].isoformat() if hasattr(row[1], "isoformat") else str(row[1]),
            "base": row[2],
            "quote": row[3],
            "rate": float(row[4]),
            "source": row[5],
            "frequency": row[6],
            "retrieved_at": row[7],
        }
        for row in rows
    ]
    return {"items": items, "count": len(items)}


@router.post("/sync")
def sync_exchange_rate_data(req: ExchangeRateSyncIn, request: Request) -> dict:
    """Fetch latest or a date range from the configured exchange-rate source."""
    try:
        return sync_exchange_rates(
            request.app.state.repo,
            start=req.start_date,
            end=req.end_date,
            # Open Exchange Rates owns the current snapshot; bounded history
            # remains reproducible on the Frankfurter/CFETS daily source.
            provider_name=(
                "frankfurter"
                if req.start_date is not None or req.end_date is not None
                else None
            ),
        )
    except ExchangeRateSyncBusyError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("exchange rate sync failed")
        raise HTTPException(status_code=502, detail=f"汇率数据源请求失败: {exc}") from exc
