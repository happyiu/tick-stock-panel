"""个股分析 API — 关键价位 + AI 四维分析 + 报告持久化。

路由前缀: /api/stock-analysis

端点:
  GET  /levels?symbol=         13 类关键价位(图表 markLine 数据源)
  POST /analyze                AI 流式四维分析(NDJSON)
  POST /chat/stream            Hermes-only 详情页多轮对话(NDJSON)
  GET  /reports                历史报告列表
  POST /reports                保存一条报告
  DELETE /reports/{report_id}  删除一条报告
"""
from __future__ import annotations

import json
import math
from datetime import date, timedelta
from typing import Annotated

import polars as pl
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.indicators.levels import LEVEL_TYPES, compute_levels, summarize_levels
from app.market_time import cn_now, cn_today
from app.services import stock_reports
from app.services.ndjson_heartbeat import with_heartbeat
from app.services.stock_analyzer import analyze_stock_stream
from app.services.stock_chat import (
    StockChatError,
    StockChatRequest,
    prepare_stock_chat,
    stream_stock_chat,
)

router = APIRouter(prefix="/api/stock-analysis", tags=["stock-analysis"])


def _to_float_list(series: pl.Series) -> list:
    """polars Series → JSON 安全的 float 列表(null/NaN → None)。"""
    out: list = []
    for v in series.to_list():
        if v is None:
            out.append(None)
            continue
        try:
            f = float(v)
            out.append(round(f, 2) if math.isfinite(f) else None)
        except (TypeError, ValueError):
            out.append(None)
    return out


def _build_series(df: pl.DataFrame) -> dict:
    """提取带状指标(布林带 / Keltner通道 / ATR止损)的每日时间序列。

    这些指标的本质是"每日一条线",随 MA/ATR/sigma 漂移,画成曲线才能体现通道形态。
    其余固定价位(枢轴/前高前低等)不在此,仍用水平 markLine。

    返回结构(每个 value 都是按日期对齐的数组):
      {
        "boll":      {"upper": [...], "lower": [...]},
        "keltner_s": {"upper": [...], "lower": [...]},   # 短期 MA20±2ATR
        "keltner_m": {"upper": [...], "lower": [...]},   # 中期 MA60±2.5ATR
        "keltner_l": {"upper": [...], "lower": [...]},   # 长期 MA120±3ATR
        "atr":       {"stop_loss": [...], "take_profit": [...]},  # close∓2ATR
      }
    """
    if df.is_empty() or "close" not in df.columns:
        return {}

    out: dict[str, dict] = {}
    close = df["close"]
    has_atr = "atr_14" in df.columns

    # 布林带(上/下/中轨;中轨 = MA20,数据层已预计算)
    if "boll_upper" in df.columns and "boll_lower" in df.columns:
        out["boll"] = {
            "upper": _to_float_list(df["boll_upper"]),
            "lower": _to_float_list(df["boll_lower"]),
            "mid": _to_float_list(df["ma20"]) if "ma20" in df.columns else None,
        }

    # Keltner 通道三档(需要 ATR)
    if has_atr:
        atr = df["atr_14"]
        # MA120 现场算(不在预计算列中)
        ma120 = df.select(pl.col("close").rolling_mean(120))["close"] if df.height >= 120 else None

        def _channel(ma: pl.Series, n: float) -> dict:
            return {
                "upper": _to_float_list(ma + n * atr),
                "lower": _to_float_list(ma - n * atr),
            }

        if "ma20" in df.columns:
            out["keltner_s"] = _channel(df["ma20"], 2.0)
        if "ma60" in df.columns:
            out["keltner_m"] = _channel(df["ma60"], 2.5)
        if ma120 is not None:
            out["keltner_l"] = _channel(ma120, 3.0)

        # ATR 止损/止盈: close ± 2xATR(跟随行情漂移的动态止损线)
        out["atr"] = {
            "stop_loss": _to_float_list(close - 2 * atr),
            "take_profit": _to_float_list(close + 2 * atr),
        }

    return out


@router.get("/levels")
def get_levels(
    request: Request,
    symbol: str = Query(..., description="标的代码,如 000001.SZ"),
    days: int = Query(120, ge=30, le=500, description="计算样本天数"),
    end_date: Annotated[date | None, Query(description="历史观察截止日期,缺省为北京今天")] = None,
):
    """计算 13 类关键价位(成交密集区压力支撑 / 枢轴点 / 反转拐点 / 供需区域 / 前高前低 /
    布林带 / Keltner短中长 / ATR止损 / 缺口 / 斐波那契 / 整数关口)。

    返回 {levels: {sr, pivot, extreme, boll, keltner_s, keltner_m, keltner_l,
    atr_stop, gap, fib, round, reversal_pivot, supply_demand}, close, summary, dates, series}。
    前端按 levels 的 key 渲染开关按钮,逐组显隐 markLine / 曲线。
    """
    if not symbol:
        raise HTTPException(400, "symbol 不能为空")

    repo = request.app.state.repo
    end = min(end_date, cn_today()) if end_date else cn_today()
    start = end - timedelta(days=days * 2)
    # 按资产类型分流: ETF/指数走独立 enriched 存储, 股票保持原路径
    asset_type = repo.resolve_asset_type(symbol)
    df = repo.get_daily_asset(asset_type, symbol, start, end)
    if not df.is_empty():
        df = df.filter(pl.col("date").cast(pl.Date) <= end)
    if df.is_empty():
        return {"levels": {key: [] for key in LEVEL_TYPES},
                "close": None, "summary": "无数据", "symbol": symbol,
                "asset_type": asset_type,
                "dates": [], "series": {}}

    levels = compute_levels(df, as_of=cn_now())
    close = float(df.tail(1)["close"][0]) if "close" in df.columns else None
    # 日期 + 带状曲线序列(供前端画 Keltner/ATR/布林带曲线)
    dates = df["date"].to_list()
    series = _build_series(df)
    return {
        "levels": levels,
        "close": close,
        "summary": summarize_levels(levels, close),
        "symbol": symbol,
        "asset_type": asset_type,
        "dates": [str(d) for d in dates],
        "series": series,
    }


class AnalyzeRequest(BaseModel):
    """AI 个股分析请求。"""
    symbol: str
    focus: str = ""  # 可选:用户追加的分析关注点


@router.post("/analyze")
async def analyze_stock(request: Request, req: AnalyzeRequest):
    """AI 个股四维分析 — NDJSON 流式返回。

    组合 K 线(技术指标)+ 财务表 + 关键价位 → 客观技术分析提示词 →
    流式调用 LLM → 逐 chunk 以 NDJSON 推给前端(每行一个 JSON)。
    """
    if not req.symbol:
        raise HTTPException(400, "symbol 不能为空")

    repo = request.app.state.repo
    data_dir = repo.store.data_dir

    async def stream_gen():
        async for chunk in with_heartbeat(analyze_stock_stream(repo, data_dir, req.symbol, req.focus)):
            yield chunk + "\n"

    return StreamingResponse(
        stream_gen(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/chat/stream")
async def stock_chat_stream(req: StockChatRequest):
    """Hermes-only multi-turn detail-page chat (NDJSON with heartbeats)."""
    try:
        studio_input, prepared = prepare_stock_chat(req)
    except StockChatError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    async def stream_gen():
        yield json.dumps(prepared["meta"], ensure_ascii=False) + "\n"
        async for event in stream_stock_chat(
            studio_input,
            session_id=prepared["session_id"],
            profile=prepared["profile"],
        ):
            yield json.dumps(event, ensure_ascii=False) + "\n"

    return StreamingResponse(
        stream_gen(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ================================================================
# 报告 CRUD(历史报告持久化)
# ================================================================

class SaveReportRequest(BaseModel):
    """保存一条 AI 个股分析报告。"""
    symbol: str
    name: str = ""
    focus: str = ""
    content: str
    summary: str = ""
    close: float | None = None
    levels: dict | None = None


@router.get("/reports")
def list_reports(request: Request):
    """获取全部历史报告(按时间降序,后端已裁剪到上限)。"""
    return {"reports": stock_reports.list_reports()}


@router.post("/reports")
def save_report(request: Request, req: SaveReportRequest):
    """保存一条报告。"""
    report = stock_reports.save_report({
        "symbol": req.symbol,
        "name": req.name,
        "focus": req.focus,
        "content": req.content,
        "summary": req.summary,
        "close": req.close,
        "levels": req.levels,
    })
    return {"ok": True, "report": report}


@router.delete("/reports/{report_id}")
def delete_report(request: Request, report_id: str):
    """删除一条报告。"""
    ok = stock_reports.delete_report(report_id)
    return {"ok": ok}


class WaveAnalyzeRequest(BaseModel):
    symbol: str
    asset_type: str
    as_of: str


@router.post('/wave/analyze')
def wave_analyze(request: Request, body: WaveAnalyzeRequest):
    import sqlite3
    from datetime import datetime

    from app.services import wave_history
    from app.services.chart_candles import chart_snapshot
    from app.services.kline_periods import prepare_native_30m
    from app.services.wave import analyze_wave
    try:
        cutoff = datetime.fromisoformat(body.as_of)
        if cutoff.tzinfo or body.asset_type not in ('stock','etf','index'):
            raise ValueError('context')
    except ValueError as exc:
        raise HTTPException(422,'观察时间或资产类型错误') from exc
    if request.app.state.repo.resolve_asset_type(body.symbol) != body.asset_type:
        raise HTTPException(422,'资产类型与标的不一致')
    periods = {}
    for period,days in (('1d',1096),('30m',400)):
        snap = chart_snapshot(request.app.state,body.symbol,body.asset_type,period,cutoff.date()-timedelta(days=days),cutoff.date())
        rows = prepare_native_30m(snap.frame).to_dicts() if period=='30m' and not snap.frame.is_empty() else snap.frame.to_dicts()
        from app.api.kline import _annotate_bar_closure, _maybe_inject_live_candle
        if period == '1d' and hasattr(request.app.state.repo, 'get_enriched_latest_asset'):
            rows = _maybe_inject_live_candle(request, body.symbol, rows, body.asset_type)
        for row in rows:
            row['date'] = str(row['date'])
        rows = _annotate_bar_closure(rows, period, cutoff.date())
        result = analyze_wave(rows,period,body.as_of)
        result['source'] = snap.metadata()
        if period == '1d':
            from app.services.dow import analyze_dow
            from app.services.wave import confluence
            result['dowConfluence'] = confluence(analyze_dow(rows, '1d', body.as_of), result)
        if snap.stale:
            result['issues'].append('行情快照可能过期')
        if snap.adjustment not in ('forward','none'):
            result.update(status='invalid_data',counts=[],candidates=[],issues=['复权口径未知'])
        periods[period] = result
    a,b = periods['1d'].get('counts',[]),periods['30m'].get('counts',[])
    from app.services.wave_comparison import compare_periods
    comparison = compare_periods(periods)
    compatible = comparison['status'] == 'available'
    coherence = comparison['summary']
    # Cross-period nesting is evidence only when child endpoints are inside a parent leg.
    nesting = []
    if compatible:
        from datetime import time
        for daily in a:
            for minute in b:
                first = datetime.fromisoformat(minute['points'][0]['date'])
                last = datetime.fromisoformat(minute['points'][-1]['date'])
                for left, right in zip(daily['points'], daily['points'][1:], strict=False):
                    start = datetime.fromisoformat(left['date'])
                    end = datetime.combine(datetime.fromisoformat(right['date']).date(), time(15))
                    direction = 'up' if right['value'] > left['value'] else 'down'
                    if start <= first < last <= end and minute['direction'] == direction:
                        nesting.append(dict(daily=daily['id'], minute=minute['id'], parentLeg=right['label'], status='time_and_direction_only'))
        supported = {n['minute'] for n in nesting}
        b.sort(key=lambda c:(c['validation']['level']=='subdivision_validated', c['score']['total'], c['id'] in supported),reverse=True)
        periods['30m']['candidates'] = b
    payload = dict(version='wave-v3-alpha-0.14.3-r1',symbol=body.symbol,asset_type=body.asset_type,asOf=body.as_of,periods=periods,coherence=coherence,comparison=comparison,nesting=nesting,provenance='reconstructed')
    try:
        prior = wave_history.history(body.symbol, body.asset_type)
        previous = wave_history.read(prior[0]['id']) if prior else None
        payload['revisions'] = []
        if previous:
            for period, current in periods.items():
                old = previous['periods'].get(period, {})
                before, after = old.get('counts', []), current.get('counts', [])
                reason = None
                if previous.get('version') != payload['version']:
                    reason = 'engine_version_changed'
                elif previous.get('asOf') == payload['asOf'] and old.get('inputFingerprint') != current.get('inputFingerprint'):
                    reason = 'data_revision'
                elif before and after and before[0]['id'] != after[0]['id']:
                    reason = 'primary_changed'
                elif before and after and before[0]['points'] != after[0]['points']:
                    reason = 'endpoint_changed'
                if reason:
                    payload['revisions'].append(dict(period=period, reason=reason, previous=prior[0]['id']))
        payload['snapshotId'] = wave_history.save(payload)
        payload['saved'] = True
    except (OSError,sqlite3.Error):
        payload['saved'] = False
    return payload


@router.get('/wave/history')
def wave_history_list(symbol: str, asset_type: str):
    from app.services.wave_history import history
    return history(symbol,asset_type)


@router.get('/wave/history/{snapshot_id}')
def wave_history_read(snapshot_id: str):
    from app.services.wave_history import read
    result = read(snapshot_id)
    if result is None:
        raise HTTPException(404,'快照不存在')
    from app.services.wave_comparison import compare_periods
    comparison = compare_periods(result.get('periods', {}))
    return dict(result,snapshotId=snapshot_id,saved=True,comparison=comparison,coherence=comparison['summary'])
