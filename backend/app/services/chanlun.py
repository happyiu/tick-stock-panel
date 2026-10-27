"""Official CZSC Rust adapter. Consumes existing candles; never fetches or trades.

Replay records first-observed events rather than backdating final shapes.
"""

# ruff: noqa: RUF001
from __future__ import annotations

import copy
import json
import logging
import math
from datetime import date, datetime
from functools import lru_cache
from hashlib import sha256
from importlib.metadata import version

from app.services.chanlun_geometry import build_center_extensions, build_trends
from app.services.chanlun_interpretation import build_interpretation
from app.services.chanlun_projection import build_projection
from app.services.chanlun_segments import build_segments

logger = logging.getLogger(__name__)
ENGINE_VERSION = "1.0.2"
ENGINE_COMMIT = "5d350a943d6b1935561765fed5467c234973d121"
PERIODS = {"30m": "F30", "1d": "D", "1w": "W", "1mo": "M"}
SIGNAL_RULES = [
    {"function": "cxt_first_buy_V221126", "params": {"di": 1}},
    {"function": "cxt_first_sell_V221126", "params": {"di": 1}},
    {"function": "cxt_second_bs_V240524", "params": {"di": 1, "w": 9, "t": 2}},
    {"function": "cxt_third_bs_V230318", "params": {"di": 1, "ma_type": "SMA", "timeperiod": 34}},
]
DIVERGENCE_RULE = {"function": "tas_macd_bc_V230804", "params": {"di": 1}}
CHART_RULES = {"version": 1, "projectionVersion": 1, "segmentRule": "project-feature-sequence-v1", "trendRule": "project-center-core-position-v1", "divergenceRules": [DIVERGENCE_RULE]}
ENGINE_CONFIG = {"min_bi_len": 6, "max_bi_num": "max(50, closed_bars)", "signalRules": SIGNAL_RULES, "chartRules": CHART_RULES}
CAPABILITIES = {
    "supportedSources": ["stroke"],
    "segments": True,
    "divergences": True,
    "recursiveConfirmation": False,
    "trends": True,
    "centerExtensions": True,
    "projection": True,
    "segmentRuleSource": "project",
    "divergenceRules": [DIVERGENCE_RULE],
    "signalRules": SIGNAL_RULES,
}
LOSS = "CZSC官方笔与中枢；线段和趋势为项目推导；MACD背驰仅作官方条件观察；未作次级别联立确认"
KINDS = {
    "一买": "first_buy",
    "一卖": "first_sell",
    "二买": "second_buy",
    "二卖": "second_sell",
    "三买": "third_buy",
    "三卖": "third_sell",
}


class _CalculationError(RuntimeError):
    pass


def _load_engine():
    # Keep native dependency failures isolated from ordinary market-data requests.
    import czsc
    from czsc._native.signals import call_signal

    if version("czsc") != ENGINE_VERSION:
        raise ImportError(f"expected czsc=={ENGINE_VERSION}")
    return czsc, call_signal


def _text(value):
    return (value.isoformat() if isinstance(value, (date, datetime)) else str(value or "")).replace(
        "T", " "
    )


def _empty(period, source, rows, issues, status="insufficient"):
    return {
        "ruleVersion": 4,
        "period": period,
        "source": source,
        "definitionMode": "engine_rules",
        "engine": {
            "name": "czsc",
            "version": ENGINE_VERSION,
            "commit": ENGINE_COMMIT,
            "runtime": "Rust/PyO3",
            "config": copy.deepcopy(ENGINE_CONFIG),
        },
        "capabilities": copy.deepcopy(CAPABILITIES),
        "approximationLoss": LOSS,
        "status": status,
        "issues": issues,
        "window": {
            "start": rows[0]["date"] if rows else None,
            "end": rows[-1]["date"] if rows else None,
            "bars": len(rows),
            "mergedBars": 0,
        },
        "bars": rows,
        "mergedBars": [],
        "fractals": [],
        "strokes": [],
        "segments": [],
        "centers": [],
        "strokeCenters": [],
        "segmentCenters": [],
        "divergences": [],
        "trends": [],
        "centerExtensions": [],
        "candidateSignals": [],
        "thirdSignals": [],
        "trendType": "unclear",
        "latestFractal": None,
        "latestConfirmedStroke": None,
        "formingStroke": None,
        "latestCenter": None,
        "latestSignal": None,
        "currentPrice": rows[-1]["close"] if rows else None,
        "pricePosition": None,
        "interpretation": None,
        "projection": None,
    }


def analyze_chanlun(rows: list[dict], *, period="1d", source="stroke", as_of=None):
    if period not in PERIODS or source not in {"stroke", "segment"}:
        raise ValueError("不支持的缠论周期或结构来源")
    cutoff = _text(as_of) if as_of else None
    if cutoff:
        if datetime.fromisoformat(cutoff).tzinfo is not None:
            raise ValueError("expected Beijing wall-clock cutoff")
        if len(cutoff) == 10:
            cutoff += " 23:59:59"
    if source == "segment":
        return _empty(period, source, [], ["分析来源仅支持笔；线段图层为项目推导，不作为独立中枢分析源"], "unsupported")
    normalized = []
    for row in rows:
        label = _text(row.get("date"))[: 16 if period == "30m" else 10]
        if cutoff and label > cutoff:
            continue
        try:
            parsed = datetime.fromisoformat(_text(row.get("date")))
            end = _text(row.get("period_end") or label)
            end_at = datetime.fromisoformat(end)
            if len(end) == 10:
                end_at = end_at.replace(hour=15)
            if parsed.tzinfo is not None or end_at.tzinfo is not None:
                raise ValueError("expected Beijing wall-clock time")
            if cutoff and end_at > datetime.fromisoformat(cutoff):
                continue
            values = {k: float(row[k]) for k in ("open", "high", "low", "close")}
            if (
                not all(math.isfinite(v) and v > 0 for v in values.values())
                or values["low"] > min(values.values())
                or values["high"] < max(values.values())
                or (normalized and label <= normalized[-1]["date"])
            ):
                raise ValueError("invalid OHLC or order")
            for key in ("volume", "amount"):
                value = row.get(key)
                values[key] = float(value) if value is not None else None
                if values[key] is not None and (not math.isfinite(values[key]) or values[key] < 0):
                    raise ValueError("invalid volume or amount")
            normalized.append(
                {
                    "date": label,
                    "sourceIndex": len(normalized),
                    **values,
                    "isClosed": row.get("is_closed") is True,
                    "periodEnd": end[: 16 if period == "30m" else 10],
                }
            )
        except (KeyError, TypeError, ValueError, OverflowError):
            return _empty(period, source, [], ["K线价格、量额、日期或顺序异常"], "invalid_data")
    if not any(r["isClosed"] for r in normalized):
        return _empty(period, source, normalized, ["暂无已闭合K线，未确认缠论结构"])
    try:
        _load_engine()
    except Exception:
        logger.exception("CZSC native engine unavailable")
        return _empty(
            period,
            source,
            normalized,
            ["CZSC 1.0.2原生内核不可用，请检查后端依赖"],
            "engine_unavailable",
        )
    key = json.dumps(normalized, sort_keys=True, allow_nan=False)
    config = json.dumps(ENGINE_CONFIG, sort_keys=True)
    try:
        return copy.deepcopy(_analyze_cached(key, period, source, cutoff, ENGINE_VERSION, config))
    except _CalculationError:
        return _empty(
            period, source, normalized, ["CZSC计算失败，请检查行情或重试"], "invalid_data"
        )


def _anchor(fx):
    """The middle merged candle may carry a different time than its raw extreme."""
    top = str(fx.mark) == "顶分型"
    raw = fx.elements[1].elements
    return next(b for b in reversed(raw) if (b.high if top else b.low) == fx.fx)


def _fx_key(fx):
    return (str(fx.mark), _anchor(fx).id, fx.high, fx.low)


def _bi_key(bi):
    return (_anchor(bi.fx_a).id, _anchor(bi.fx_b).id, bi.fx_a.fx, bi.fx_b.fx)


def _fractal(fx, rows, known, merged_indices):
    bar = _anchor(fx)
    top = str(fx.mark) == "顶分型"
    return {
        "type": "top" if top else "bottom",
        "mergedIndex": merged_indices.get(fx.elements[1].id, -1),
        "sourceIndex": rows[bar.id]["sourceIndex"],
        "date": rows[bar.id]["date"],
        "price": fx.fx,
        "confirmedAt": known[("fx", _fx_key(fx))],
        "confirmedSourceIndex": known[("fx_index", _fx_key(fx))],
    }


def _invalidate(signal, when, reason):
    signal.update(status="invalidated", invalidatedAt=when, invalidationReason=reason)


def _invalidate_at_boundary(signal, row):
    when = row["periodEnd"]
    if (
        signal["invalidatedAt"]
        or when < signal["availableDate"]
        or row["date"] == signal["structureDate"]
    ):
        return
    if (
        row["low"] <= signal["boundary"]
        if signal["kind"].endswith("_buy")
        else row["high"] >= signal["boundary"]
    ):
        _invalidate(signal, when, "price_boundary")


def _update_signals(signals, episodes, bis, finished, matches, row, rows, bi_keys=None):
    """Only a disappearing current condition or withdrawn endpoint replaces a shape.

    A later pen makes the dispatcher inspect a new endpoint; it must not erase history.
    """
    bi_keys = bi_keys if bi_keys is not None else [_bi_key(b) for b in bis]
    keys = set(bi_keys)
    current = bi_keys[-1] if bi_keys else None
    active = set()
    for rule, raw in matches:
        kind = KINDS[raw.v1]
        base = (rule["function"], current)
        active.add(base)
        old = episodes.get(base)
        if old is None or (old["status"] == "invalidated" and not old.get("_ruleActive")):
            bi = bis[-1]
            anchor = _anchor(bi.fx_b)
            identity = [
                rule,
                rows[current[0]]["date"],
                rows[current[1]]["date"],
                bi.fx_a.fx,
                bi.fx_b.fx,
                row["periodEnd"],
            ]
            event_id = sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:24]
            signal = {
                "id": f"czsc-{event_id}",
                "kind": kind,
                "status": "candidate",
                "source": "stroke",
                "structureConfirmed": current in finished,
                "structureDate": rows[anchor.id]["date"],
                "availableDate": row["periodEnd"],
                "observedAt": row["periodEnd"],
                "price": bi.fx_b.fx,
                "boundary": rows[anchor.id]["low" if kind.endswith("_buy") else "high"],
                "boundaryRule": "signal_bar_extreme",
                "boundaryRuleSource": "project",
                "invalidatedAt": None,
                "invalidationReason": None,
                "relatedSignalId": None,
                "rule": copy.deepcopy(rule),
                "rawSignal": {"key": raw.key, "value": raw.value},
                "conditions": [
                    {
                        "id": "lower_level",
                        "label": "次级别确认",
                        "state": "unavailable",
                        "evidence": "官方单周期辅助信号，未联立次级别",
                    }
                ],
                "nextWatch": "观察后续结构；触及信号K线极值边界则失效",
                "_biKey": current,
            }
            signal["variant"] = ("B" if kind.endswith("_buy") else "S") + str(
                {"first": 1, "second": 2, "third": 3}[kind.split("_")[0]]
            )
            signals.append(signal)
            episodes[base] = signal
    for signal in signals:
        signal["_ruleActive"] = (signal["rule"]["function"], signal["_biKey"]) in active
        if signal["invalidatedAt"]:
            continue
        key = signal["_biKey"]
        signal["structureConfirmed"] = key in finished
        if key not in keys or (key == current and (signal["rule"]["function"], key) not in active):
            _invalidate(signal, row["periodEnd"], "structure_replaced")
        _invalidate_at_boundary(signal, row)


def _update_divergences(events, episodes, bis, bi_keys, finished, matches, row, rows):
    current = bi_keys[-1] if bi_keys else None
    matched = bool(matches)
    old = episodes.get(current)
    if matched and (old is None or (old["status"] == "invalidated" and not old["_active"])):
        bi, raw = bis[-1], matches[0]
        references = []
        for index in (-5, -3):
            reference = bis[index]
            end = rows[_anchor(reference.fx_b).id]
            references.append({"endDate": end["date"], "endPrice": reference.fx_b.fx})
        identity = [DIVERGENCE_RULE, rows[current[0]]["date"], rows[current[1]]["date"], *current[2:], row["periodEnd"]]
        event = {
            "id": f"macd-{sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:24]}",
            "kind": "macd", "source": "stroke", "ruleSource": "czsc",
            "direction": "up" if raw.v1 == "空头" else "down", "status": "candidate",
            "structureDate": rows[current[1]]["date"], "price": bi.fx_b.fx,
            "availableDate": row["periodEnd"], "observedAt": row["periodEnd"],
            "structureConfirmed": current in finished, "references": references,
            "rule": copy.deepcopy(DIVERGENCE_RULE), "rawSignal": {"key": raw.key, "value": raw.value},
            "invalidatedAt": None, "invalidationReason": None,
            "evidence": "官方MACD12/26/9黄白线背驰条件命中；仅作背驰观察，未确认递归走势背驰",
            "_biKey": current,
        }
        events.append(event)
        episodes[current] = event
    keys = set(bi_keys)
    for event in events:
        event["_active"] = event["_biKey"] == current and matched
        if event["status"] == "invalidated":
            continue
        key = event["_biKey"]
        event["structureConfirmed"] = key in finished
        if key not in keys:
            _invalidate(event, row["periodEnd"], "structure_replaced")
        elif key == current and not matched:
            _invalidate(event, row["periodEnd"], "condition_disappeared")


@lru_cache(maxsize=16)
def _analyze_cached(serialized, period, source, cutoff, engine_version, config):
    rows = json.loads(serialized)
    result = _empty(period, source, rows, [])
    closed = [r for r in rows if r["isClosed"]]
    czsc, call_signal = _load_engine()
    engine = None
    previous_state = None
    known, episodes, signals = {}, {}, []
    divergence_events, divergence_episodes, segments = [], {}, []
    volume_available = True
    open_rows = iter(r for r in rows if not r["isClosed"])
    pending_open = next(open_rows, None)
    try:
        for i, row in enumerate(closed):
            if row["volume"] is None:
                volume_available = False
            bar = czsc.RawBar(
                symbol="ANALYSIS",
                dt=datetime.fromisoformat(row["date"]),
                freq=getattr(czsc.Freq, PERIODS[period]),
                id=i,
                open=row["open"],
                close=row["close"],
                high=row["high"],
                low=row["low"],
                # Native objects require numbers. Missingness stays explicit in rows;
                # volume-dependent dispatch is disabled for the entire affected prefix.
                vol=row["volume"] if row["volume"] is not None else 0,
                amount=row["amount"] if row["amount"] is not None else 0,
            )
            if engine is None:
                engine = czsc.CZSC([bar], min_bi_len=6, max_bi_num=max(50, len(closed)))
            else:
                engine.update(bar)
            available = row["periodEnd"]
            for fx in engine.fx_list:
                key = _fx_key(fx)
                known.setdefault(("fx", key), available)
                known.setdefault(("fx_index", key), row["sourceIndex"])
            bis = engine.bi_list
            bi_keys = [_bi_key(b) for b in bis]
            finished = set(bi_keys[: len(engine.finished_bis)])
            state = (tuple(bi_keys), len(finished))
            # Completed history is immutable until the official endpoint sequence changes.
            if state != previous_state:
                for bi, key in zip(bis, bi_keys, strict=True):
                    known.setdefault(("observed", key), available)
                    if key in finished:
                        known.setdefault(("finished", key), available)
                    for fx in (bi.fx_a, bi.fx_b):
                        k = _fx_key(fx)
                        known.setdefault(("fx", k), available)
                        known.setdefault(("fx_index", k), row["sourceIndex"])
                for z in engine.zs_list:
                    if len(z.bis) >= 3 and z.is_valid():
                        key = (_bi_key(z.bis[0]), z.zd, z.zg)
                        known.setdefault(("center", key), available)
                segment_inputs = [{
                    "index": j, "direction": "up" if key[3] > key[2] else "down",
                    "startDate": closed[key[0]]["date"], "endDate": closed[key[1]]["date"],
                    "startPrice": key[2], "endPrice": key[3], "low": min(key[2], key[3]), "high": max(key[2], key[3]),
                    "startSourceIndex": closed[key[0]]["sourceIndex"], "endSourceIndex": closed[key[1]]["sourceIndex"],
                    "confirmed": key in finished, "confirmedAt": known.get(("finished", key)),
                } for j, (bi, key) in enumerate(zip(bis, bi_keys, strict=True))]
                common = 0
                if previous_state:
                    old_keys, old_finished = previous_state
                    for j, (key, old_key) in enumerate(zip(bi_keys, old_keys, strict=False)):
                        if key != old_key or (key in finished) != (j < old_finished):
                            break
                        common += 1
                # Reuse only segments whose entire confirmation proof is unchanged.
                prefix = [s for s in segments if s["confirmed"] and s["confirmation"]["lastStrokeIndex"] < common]
                segments = build_segments(segment_inputs, confirmed_prefix=prefix)
                for segment in segments:
                    segment["observedAt"] = known.setdefault(("segment", segment["id"]), available)
                    if segment["confirmed"]:
                        segment["confirmedAt"] = known.setdefault(("segment_finished", segment["id"]), available)
                previous_state = state
            matches = []
            if bis:
                for rule in SIGNAL_RULES:
                    if "first_" in rule["function"] and not volume_available:
                        continue
                    for raw in call_signal(rule["function"], engine, rule["params"]):
                        if raw.v1 in KINDS:
                            matches.append((rule, raw))
            divergence_matches = [raw for raw in call_signal(DIVERGENCE_RULE["function"], engine, DIVERGENCE_RULE["params"])
                                  if raw.v1 in {"多头", "空头"}] if len(bis) >= 7 else []
            _update_divergences(divergence_events, divergence_episodes, bis, bi_keys, finished,
                                divergence_matches, row, closed)
            # Process any unclosed intervening candle at its actual time, not after later events.
            while pending_open is not None and pending_open["date"] < row["date"]:
                for signal in signals:
                    _invalidate_at_boundary(signal, pending_open)
                pending_open = next(open_rows, None)
            _update_signals(signals, episodes, bis, finished, matches, row, closed, bi_keys)
        _project_structures(result, engine, closed, known)
        result["segments"] = segments
        result["trends"] = build_trends(result["centers"], closed[-1]["periodEnd"])
        result["centerExtensions"] = build_center_extensions(result["centers"], closed[-1]["periodEnd"])
        for row in rows:
            if not row["isClosed"] and row["date"] > closed[-1]["date"]:
                for signal in signals:
                    _invalidate_at_boundary(signal, row)
        for signal in signals:
            signal.pop("_biKey")
            signal.pop("_ruleActive", None)
        result["candidateSignals"] = signals
        for event in divergence_events:
            event.pop("_biKey")
            event.pop("_active")
        result["divergences"] = divergence_events
    except BaseException as exc:
        # PyO3 PanicException derives directly from BaseException. Never swallow cancellation/exit.
        if not isinstance(exc, Exception) and type(exc).__name__ != "PanicException":
            raise
        logger.exception("CZSC calculation failed for %s", period)
        raise _CalculationError from exc
    if not volume_available:
        result["issues"].append(
            "成交量缺失，相关历史之后的一类辅助信号停用；基础结构和二三类仍可计算"
        )
    if len(closed) != len(rows):
        result["issues"].append("未闭合或闭合状态未知的K线不参与结构确认")
    result["status"] = "ready" if result["strokes"] else "insufficient"
    if not result["strokes"]:
        result["issues"].append("尚未形成满足CZSC规则的有效笔")
    result["interpretation"] = build_interpretation(result)
    result["projection"] = build_projection(result)
    return result


def _project_structures(result, engine, rows, known):
    merged = {}
    for bi in engine.bi_list:
        for b in bi.bars:
            merged[b.id] = b
    for b in engine.bars_ubi:
        merged[b.id] = b
    merged = sorted(merged.values(), key=lambda b: b.elements[0].id)
    indices = {b.id: i for i, b in enumerate(merged)}
    result["mergedBars"] = [
        {
            "sourceStartIndex": rows[b.elements[0].id]["sourceIndex"],
            "sourceEndIndex": rows[b.elements[-1].id]["sourceIndex"],
            "startDate": rows[b.elements[0].id]["date"],
            "endDate": rows[b.elements[-1].id]["date"],
            "high": b.high,
            "low": b.low,
            "highDate": rows[next(x.id for x in reversed(b.elements) if x.high == b.high)]["date"],
            "lowDate": rows[next(x.id for x in reversed(b.elements) if x.low == b.low)]["date"],
            "highSourceIndex": rows[next(x.id for x in reversed(b.elements) if x.high == b.high)][
                "sourceIndex"
            ],
            "lowSourceIndex": rows[next(x.id for x in reversed(b.elements) if x.low == b.low)][
                "sourceIndex"
            ],
            "direction": "unknown",
            "uncertain": i == 0,
            "closed": True,
            "periodEnd": rows[b.elements[-1].id]["periodEnd"],
        }
        for i, b in enumerate(merged)
    ]
    result["window"]["mergedBars"] = len(merged)
    result["fractals"] = [_fractal(fx, rows, known, indices) for fx in engine.fx_list]
    finished = {_bi_key(b) for b in engine.finished_bis}
    for i, bi in enumerate(engine.bi_list):
        key = _bi_key(bi)
        start, end = (
            _fractal(bi.fx_a, rows, known, indices),
            _fractal(bi.fx_b, rows, known, indices),
        )
        result["strokes"].append(
            {
                "id": f"stroke-{key}",
                "index": i,
                "direction": "up" if bi.fx_b.fx > bi.fx_a.fx else "down",
                "start": start,
                "end": end,
                "startDate": start["date"],
                "endDate": end["date"],
                "startPrice": bi.fx_a.fx,
                "endPrice": bi.fx_b.fx,
                "low": bi.low,
                "high": bi.high,
                "changePct": bi.fx_b.fx / bi.fx_a.fx - 1,
                "mergedBars": bi.length,
                "confirmed": key in finished,
                "confirmedAt": known.get(("finished", key)) if key in finished else None,
                "observedAt": known[("observed", key)],
                "bars": end["sourceIndex"] - start["sourceIndex"] + 1,
            }
        )
    by_key = {_bi_key(b): i for i, b in enumerate(engine.bi_list)}
    for z in engine.zs_list:
        if len(z.bis) < 3 or not z.is_valid():
            continue
        a, b = by_key[_bi_key(z.bis[0])], by_key[_bi_key(z.bis[-1])]
        key = (_bi_key(z.bis[0]), z.zd, z.zg)
        result["centers"].append(
            {
                "id": f"center-{key}",
                "source": "stroke",
                "startStrokeIndex": a,
                "endStrokeIndex": b,
                "startDate": result["strokes"][a]["startDate"],
                "endDate": result["strokes"][b]["endDate"],
                "formedAt": known[("center", key)],
                "zd": z.zd,
                "zg": z.zg,
                "dd": z.dd,
                "gg": z.gg,
                "componentCount": len(z.bis),
                "state": "extension" if len(z.bis) > 3 else "newborn",
                "confirmed": True,
            }
        )
    result["strokeCenters"] = result["centers"]
    result["latestFractal"] = result["fractals"][-1] if result["fractals"] else None
    sure = [b for b in result["strokes"] if b["confirmed"]]
    forming = [b for b in result["strokes"] if not b["confirmed"]]
    result["latestConfirmedStroke"] = sure[-1] if sure else None
    result["formingStroke"] = forming[-1] if forming else None
    centers = result["centers"]
    result["latestCenter"] = centers[-1] if centers else None
    if centers:
        result["trendType"] = "consolidation_proxy"
        if len(centers) >= 2:
            if centers[-1]["zd"] > centers[-2]["zg"]:
                result["trendType"] = "uptrend_proxy"
            elif centers[-1]["zg"] < centers[-2]["zd"]:
                result["trendType"] = "downtrend_proxy"
        p = result["currentPrice"]
        result["pricePosition"] = (
            "above" if p > centers[-1]["zg"] else "below" if p < centers[-1]["zd"] else "inside"
        )
