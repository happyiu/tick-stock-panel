"""K 线策略标记接口 — 只返回当前单只标的的历史入场/退出信号。"""

# FastAPI Query defaults are intentionally declared in the route signature.
# ruff: noqa: B008
from __future__ import annotations

from datetime import date
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request

from app.services.strategy_chart import StrategyChartService

router = APIRouter(prefix="/api/strategy-chart", tags=["strategy-chart"])


@router.get("/signals/{strategy_id}")
def get_strategy_chart_signals(
    strategy_id: str,
    request: Request,
    symbol: str = Query(..., description="标的代码"),
    asset_type: Literal["stock", "etf"] = Query(..., description="资产类型"),
    timeframe: Literal["1d", "1w", "30m"] = Query("1d", description="K线周期"),
    start_date: date = Query(..., description="展示起始日期"),
    end_date: date = Query(..., description="展示截止日期"),
    days: int = Query(20, ge=1, le=120, description="30F 可见交易日数量"),
):
    if start_date > end_date:
        raise HTTPException(status_code=422, detail="起始日期不能晚于截止日期")

    engine = getattr(request.app.state, "strategy_engine", None)
    if engine is None:
        raise HTTPException(status_code=503, detail="策略引擎未初始化")
    try:
        strategy = engine.get(strategy_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if strategy.meta.get("research_only"):
        raise HTTPException(status_code=404, detail=f"unknown strategy: {strategy_id}")

    supported_assets = strategy.meta.get("asset_types", ["stock"])
    if asset_type not in supported_assets:
        raise HTTPException(
            status_code=400,
            detail=f"策略 {strategy_id} 不支持资产类型 {asset_type}",
        )
    supported_timeframes = strategy.meta.get("timeframes", ["1d"])
    if timeframe not in supported_timeframes:
        raise HTTPException(
            status_code=400,
            detail=f"策略 {strategy_id} 不支持 K 线周期 {timeframe}",
        )

    repo = request.app.state.repo
    try:
        actual_asset_type = repo.resolve_asset_type(symbol)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"无法确认标的资产类型: {exc}") from exc
    if actual_asset_type != asset_type:
        raise HTTPException(
            status_code=400,
            detail=f"标的 {symbol} 实际为 {actual_asset_type}, 与请求的 {asset_type} 不一致",
        )

    try:
        markers = StrategyChartService(repo, engine).signals(
            strategy_id=strategy_id,
            symbol=symbol,
            asset_type=asset_type,
            timeframe=timeframe,
            start=start_date,
            end=end_date,
            days=days,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return {
        "symbol": symbol,
        "asset_type": asset_type,
        "timeframe": timeframe,
        "strategy_id": strategy_id,
        "markers": markers,
        "count": len(markers),
    }
