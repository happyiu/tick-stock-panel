# ruff: noqa: RUF001
"""Native stock-trend-pattern analysis over the existing chart snapshot.

Source: https://github.com/CrabOctopus/stock-trend-pattern
Pinned commit: 53d1945f373e8bb617c5cb2884518509b76e0d50 (MIT; see LICENSE).
No network, subprocess, user-data writes, or unbounded analysis cache.
"""

from __future__ import annotations

import copy
import json
import math
from datetime import datetime
from functools import lru_cache
from pathlib import Path

import polars as pl

from app.indicators.pipeline import compute_indicators

from .momentum_reversion import analyze_momentum_reversion
from .recognize import recognize
from .structure import levels, pivots, trend, verdict

VERSION = "trend-pattern-v1"


@lru_cache(maxsize=1)
def _catalog():
    items = json.loads(Path(__file__).with_name("patterns.json").read_text(encoding="utf-8"))
    for item in items:
        item.setdefault("candles", item.get("raw_candles") or [])
        if item["id"] in ("rising_three_methods", "falling_three_methods"):
            item["detect"] = dict(
                type="multi",
                n=5,
                methods="rising" if item["id"].startswith("rising") else "falling",
            )
        if item["id"] == "three_white_soldiers":
            item["detect"]["soldiers"] = True
        if item["id"] == "three_black_crows":
            item["detect"]["crows"] = True
        if item["id"] == "key_reversal_day":
            item["detect"] = dict(type="two", key_reversal=True, trend_before="up")
        if item["id"] == "stairway_bottom":
            item["detect"] = dict(type="multi", n=5, stairway=True, trend_before="down")
    return items


def catalog():
    """Teaching illustrations and example prices are confined to this endpoint."""
    return copy.deepcopy(_catalog())


def _stamp(value, *, end=False):
    text = value.isoformat() if hasattr(value, "isoformat") else str(value)
    stamp = datetime.fromisoformat(text.replace("T", " "))
    if stamp.tzinfo:
        raise ValueError("时间必须为北京时间墙钟")
    if len(text) == 10 and end:
        stamp = stamp.replace(hour=23, minute=59, second=59)
    return stamp


def _normalize(rows, as_of):
    cutoff = _stamp(as_of, end=True) if as_of else None
    result, previous, forming = [], None, False
    for row in rows:
        when = _stamp(row["date"])
        if cutoff and when > cutoff:
            continue
        end_text = row.get("period_end") or row["date"]
        end = _stamp(end_text)
        if len(str(end_text)) == 10:
            end = end.replace(hour=15)
        if cutoff and end > cutoff:
            continue
        if previous and when <= previous:
            raise ValueError("K线日期必须严格递增且不能重复")
        previous = when
        if row.get("is_closed") is not True:
            forming = True
            continue
        o, h, low, close = [float(row[k]) for k in ("open", "high", "low", "close")]
        volume = float(row["volume"]) if row.get("volume") is not None else None
        if (
            not all(math.isfinite(v) and v > 0 for v in (o, h, low, close))
            or low > min(o, close)
            or h < max(o, close)
            or low > h
        ):
            raise ValueError("K线价格无效")
        if volume is not None and (not math.isfinite(volume) or volume < 0):
            raise ValueError("成交量无效")
        result.append(
            dict(
                d=when.isoformat(sep=" ")
                if len(str(row["date"])) > 10
                else when.date().isoformat(),
                o=o,
                h=h,
                l=low,
                c=close,
                v=volume,
            )
        )
    return result, forming


def _indicators(cs, symbol):
    if not cs:
        return dict(
            ma={f"ma{p}": [] for p in (5, 10, 20, 60)},
            macd=dict(dif=[], dea=[], hist=[]),
            rsi=[],
            kdj=dict(k=[], d=[], j=[]),
            boll=dict(mid=[], up=[], dn=[]),
            obv=[],
            volMa5=[],
            volMa20=[],
            atr14=[],
        )
    frame = pl.DataFrame(
        [
            dict(
                symbol=symbol,
                date=c["d"],
                open=c["o"],
                high=c["h"],
                low=c["l"],
                close=c["c"],
                volume=c["v"],
            )
            for c in cs
        ],
        infer_schema_length=None,
    ).with_columns(pl.col("volume").cast(pl.Float64))
    required = {
        "ma5",
        "ma10",
        "ma20",
        "ma60",
        "macd_dif",
        "macd_dea",
        "macd_hist",
        "rsi_14",
        "kdj_k",
        "kdj_d",
        "kdj_j",
        "boll_upper",
        "boll_lower",
        "vol_ma5",
        "atr_14",
    }
    frame = compute_indicators(frame, needed=required, assume_sorted=True)
    frame = frame.with_columns(
        pl.col("volume").rolling_mean(20).alias("vol_ma20"),
        pl.when(pl.col("close").diff().abs().rolling_max(14) == 0)
        .then(50.0)
        .otherwise(pl.col("rsi_14"))
        .alias("rsi_14"),
        pl.when(pl.col("volume").is_null().cum_sum() == 0)
        .then((pl.col("close").diff().sign().fill_null(0) * pl.col("volume")).cum_sum())
        .otherwise(None)
        .alias("obv"),
    )

    def series(key):
        return [v if v is not None and math.isfinite(v) else None for v in frame[key].to_list()]

    return dict(
        ma={f"ma{p}": series(f"ma{p}") for p in (5, 10, 20, 60)},
        macd={
            k: series(f"macd_{field}")
            for k, field in [("dif", "dif"), ("dea", "dea"), ("hist", "hist")]
        },
        rsi=series("rsi_14"),
        kdj={k: series(f"kdj_{k}") for k in ("k", "d", "j")},
        boll={
            k: series(field)
            for k, field in [("mid", "ma20"), ("up", "boll_upper"), ("dn", "boll_lower")]
        },
        obv=series("obv"),
        volMa5=series("vol_ma5"),
        volMa20=series("vol_ma20"),
        atr14=series("atr_14"),
    )


def analyze(rows, *, symbol, name="", period="1d", as_of=None, n=250, tail=160):
    """Return the seven stock-trend-pattern fields from closed, cutoff-safe OHLCV.

    `rows` must follow the current chart contract, including explicit is_closed.
    n/tail are counts of actual bars, never calendar days; indices address candles.
    """
    if period not in ("1d", "1w", "1mo", "30m"):
        raise ValueError("不支持的K线周期")
    if not 30 <= n <= 1500 or not 1 <= tail <= 1500 or len(rows) > 1500:
        raise ValueError("K线根数超出范围")
    cs, forming = _normalize(rows, as_of)
    cs = cs[-n:]
    raw_ind = _indicators(cs, symbol)
    momentum_reversion = analyze_momentum_reversion(cs, raw_ind)

    def rounded(values):
        return [round(v, 6) if v is not None else None for v in values]

    ind = {
        k: {name: rounded(values) for name, values in value.items()}
        if isinstance(value, dict)
        else rounded(value)
        for k, value in raw_ind.items()
    }
    result = dict(
        version=VERSION,
        momentumReversion=momentum_reversion,
        symbol=symbol,
        name=name,
        period=period,
        status="ok" if len(cs) >= 30 else "insufficient",
        lastDate=cs[-1]["d"] if cs else None,
        price=cs[-1]["c"] if cs else None,
        prev=cs[-2]["c"] if len(cs) >= 2 else None,
        forming=forming,
        sampleCount=len(cs),
        catalogCount=84,
        issues=[] if len(cs) >= 30 else ["至少需要30根已收盘K线"],
        candles=[],
        indicators={},
        trend={},
        swings=dict(ph=[], pl=[]),
        levels=dict(support=[], resistance=[]),
        patterns=[],
        verdict=dict(
            stance="数据不足",
            stanceEn="unknown",
            score=None,
            patternScore=None,
            maScore=None,
            trendScore=None,
            agree=False,
            advice="样本不足，暂不形成方向判断。",
            bullCount=0,
            bearCount=0,
            neutralCount=0,
            maAlign="样本不足",
            ma={},
            volRatio=None,
            nearestRes=None,
            nearestSup=None,
            rr=None,
        ),
    )
    off = max(0, len(cs) - tail)
    result["candles"] = [[c["d"], c["o"], c["h"], c["l"], c["c"], c["v"]] for c in cs[off:]]
    result["indicators"] = {
        k: {name: series[off:] for name, series in value.items()}
        if isinstance(value, dict)
        else value[off:]
        for k, value in ind.items()
    }
    result["trend"] = (
        trend(cs)
        if cs
        else {
            key: dict(verdict="unknown", window=window, swingHighs=[], swingLows=[])
            for key, window in [("short", 20), ("mid", 60), ("long", 120)]
        }
    )
    if cs:
        swings = pivots(cs)
        result["levels"] = levels(cs, swings)
        for group in result["levels"].values():
            for level in group:
                level["lastIdx"] = level["lastIdx"] - off if level["lastIdx"] >= off else None
        result["swings"] = {
            key: [
                {**p, "i": p["i"] - off, "confirmedIndex": p["confirmedIndex"] - off}
                for p in points
                if p["i"] >= off
            ]
            for key, points in swings.items()
        }
    if len(cs) >= 30:
        patterns = recognize(cs, _catalog())
        result["verdict"] = verdict(cs, ind, result["trend"], result["levels"], patterns)
        result["patterns"] = [
            {
                **p,
                "at": p["at"] - off if p["at"] >= off else None,
                "anchorAt": p["anchor"] - off
                if p["anchor"] is not None and p["anchor"] >= off
                else None,
            }
            for p in patterns
        ]
    return result
