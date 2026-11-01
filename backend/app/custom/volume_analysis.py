"""Index turnover trend, registered through the supported backend extension API."""
from __future__ import annotations

import math
from datetime import date, datetime, timedelta
from itertools import pairwise
from zoneinfo import ZoneInfo

import polars as pl
from fastapi import APIRouter, HTTPException, Query, Request

from app.extensions import BACKEND_EXTENSION_API_VERSION, BackendExtensionRegistrar
from app.market_time import cn_today
from app.services.chart_candles import latest_live_candle
from app.services.index_const import CORE_INDEX_NAMES, INDEX_PAGE_SYMBOLS

EXTENSION_ID = "analysis.volume"
EXTENSION_API_VERSION = BACKEND_EXTENSION_API_VERSION
INDEX_SYMBOLS = (*CORE_INDEX_NAMES, *INDEX_PAGE_SYMBOLS)
PAIRS = (("ma5", "ma13"), ("ma5", "ma28"), ("ma13", "ma28"))


def calculate_trend(rows: list[dict], today: date) -> tuple[list[dict], list[dict]]:
    """Compute complete-window means before clipping to 90 observed sessions."""
    valid_rows = []
    for row in rows:
        day = row.get("date")
        if isinstance(day, str):
            day = date.fromisoformat(day[:10])
        amount = row.get("amount")
        amount = float(amount) if amount is not None else None
        if amount is not None and (not math.isfinite(amount) or amount < 0):
            amount = None
        if day is not None and day <= today:
            clean = {"date": day, "amount": amount}
            for field in ("open", "high", "low", "close"):
                value = row.get(field)
                try:
                    number = float(value) if value is not None else None
                except (TypeError, ValueError):
                    number = None
                clean[field] = number if number is not None and math.isfinite(number) else None
            valid_rows.append(clean)
    by_date = {row["date"]: row for row in valid_rows}
    ordered = [by_date[day] for day in sorted(by_date)]
    if not ordered:
        return [], []
    frame = pl.DataFrame(ordered).with_columns(pl.col("amount").cast(pl.Float64))
    frame = frame.with_columns(
        pl.col("amount").rolling_mean(window_size=period, min_samples=period).alias(f"ma{period}")
        for period in (5, 13, 28)
    )
    points = [{**row, "date": row["date"].isoformat(), "provisional": row["date"] == today}
              for row in frame.to_dicts()]
    crosses = []
    for previous, current in pairwise(points):
        for fast, slow in PAIRS:
            a, b, c, d = previous[fast], previous[slow], current[fast], current[slow]
            if any(value is None for value in (a, b, c, d)):
                continue
            kind = "golden" if a <= b and c > d else "death" if a >= b and c < d else None
            if kind:
                crosses.append({"date": current["date"], "fast": fast, "slow": slow,
                                "kind": kind, "value": c, "provisional": current["provisional"]})
    shown = points[-90:]
    return shown, [event for event in crosses if event["date"] >= shown[0]["date"]]


router = APIRouter(prefix="/api/custom/volume-analysis", tags=["volume-analysis"])


@router.get("/trend")
def get_trend(request: Request, symbol: str = Query(...)) -> dict:
    if symbol not in INDEX_SYMBOLS:
        raise HTTPException(status_code=422, detail="不支持的指数代码")
    today = cn_today()
    repo = request.app.state.repo
    # Column pushdown avoids the enriched indicator recalculation. A calendar-year
    # scan covers the required 90 + 28 trading rows, including holiday gaps.
    history = repo.get_index_daily(symbol, today - timedelta(days=365), today,
                                   columns=["date", "amount", "open", "high", "low", "close"])
    rows = history.to_dicts() if not history.is_empty() else []
    live = latest_live_candle(request.app.state, symbol, "index", refresh_asset=False, today=today)
    source = "stored" if rows else "none"
    data_time = None
    if live is not None and live.get("amount") is not None:
        amount = float(live["amount"])
        if math.isfinite(amount) and amount >= 0:
            rows = [row for row in rows if str(row["date"])[:10] != today.isoformat()]
            rows.append({"date": today, "amount": amount,
                         **{field: live.get(field) for field in ("open", "high", "low", "close")}})
            source = "live"
            stamp = live.get("quote_ts")
            if stamp is not None:
                data_time = datetime.fromtimestamp(float(stamp) / 1000, ZoneInfo("Asia/Shanghai")).isoformat()
    points, crosses = calculate_trend(rows, today)
    if points and data_time is None:
        data_time = points[-1]["date"]
    return {"symbol": symbol, "name": CORE_INDEX_NAMES.get(symbol) or repo.get_name_map([symbol]).get(symbol) or symbol,
            "unit": "CNY", "as_of": points[-1]["date"] if points else None,
            "data_time": data_time, "source": source, "provisional": points[-1]["provisional"] if points else False,
            "points": points, "crosses": crosses}


def setup(registrar: BackendExtensionRegistrar) -> None:
    registrar.include_router(router)
