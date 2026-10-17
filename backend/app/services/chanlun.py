"""确定性缠论计算：只消费标准化 K 线，不取数、不执行交易。

逐根更新记录结构首次可知时间；不能用最终形态的端点时间代替信号时间。
"""

# ruff: noqa: RUF001, RUF002, RUF003
from __future__ import annotations

import copy
import json
import logging
import math
from datetime import date, datetime
from functools import lru_cache

from app.vendor.chanpy.ChanConfig import CChanConfig
from app.vendor.chanpy.Common.CEnum import DATA_FIELD, FX_TYPE, KL_TYPE
from app.vendor.chanpy.Common.CTime import CTime
from app.vendor.chanpy.KLine.KLine_List import CKLine_List
from app.vendor.chanpy.KLine.KLine_Unit import CKLine_Unit

logger = logging.getLogger(__name__)
ENGINE_COMMIT = "429d6ed3043e27c93a003ba2b10e70a05575e1f5"
PERIODS = {"30m": KL_TYPE.K_30M, "1d": KL_TYPE.K_DAY, "1w": KL_TYPE.K_WEEK, "1mo": KL_TYPE.K_MON}
# 显式固定业务口径。上游默认 divergence_rate=inf 会无条件放行背驰比较。
ENGINE_CONFIG = {
    "trigger_step": True,
    "bi_algo": "normal",
    "bi_strict": True,
    "bi_fx_check": "strict",
    "gap_as_kl": False,
    "bi_end_is_peak": True,
    "bi_allow_sub_peak": True,
    "seg_algo": "chan",
    "left_seg_method": "peak",
    "zs_algo": "normal",
    "zs_combine": True,
    "zs_combine_mode": "zs",
    "one_bi_zs": False,
    "divergence_rate": 0.9,
    "min_zs_cnt": 1,
    "macd_algo": "area",
    "max_bs2_rate": 0.9999,
    "bs_type": "1,1p,2,2s,3a,3b",
    "strict_bsp3": True,
    "print_warning": False,
    "print_err_time": False,
}


class _CalculationError(RuntimeError):
    pass


def _text(value) -> str:
    return (value.isoformat() if isinstance(value, (date, datetime)) else str(value or "")).replace(
        "T", " "
    )


def _empty(period, source, rows, issues, status="insufficient") -> dict:
    return {
        "ruleVersion": 3,
        "period": period,
        "source": source,
        "definitionMode": "engine_rules",
        "engine": {"name": "chan.py", "commit": ENGINE_COMMIT, "config": dict(ENGINE_CONFIG)},
        "approximationLoss": "按固定引擎规则计算；单周期结构不等于次级别递归确认，买卖点仅为候选",
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
        "trendType": "unclear",
        "divergences": [],
        "candidateSignals": [],
        "thirdSignals": [],
        "latestFractal": None,
        "latestConfirmedStroke": None,
        "formingStroke": None,
        "latestCenter": None,
        "latestSignal": None,
        "currentPrice": rows[-1]["close"] if rows else None,
        "pricePosition": None,
    }


def analyze_chanlun(
    rows: list[dict], *, period="1d", source="stroke", as_of: str | None = None
) -> dict:
    """输入为现有 K 线接口的前复权 OHLC，时间为北京墙钟。

    缓存按完整输入内容隔离，历史修订、复权、周期、闭合状态变化均自然失效。
    每次返回独立对象，调用者不能修改缓存；不缓存可变引擎实例。
    """
    if period not in PERIODS or source not in {"stroke", "segment"}:
        raise ValueError("不支持的缠论周期或结构来源")
    cutoff = _text(as_of) if as_of else None
    if cutoff:
        if datetime.fromisoformat(cutoff).tzinfo is not None:
            raise ValueError("expected Beijing wall-clock cutoff")
        if len(cutoff) == 10:
            cutoff += " 23:59:59"
    normalized = []
    for row in rows:
        label = _text(row.get("date"))[: 16 if period == "30m" else 10]
        if cutoff and label > cutoff:
            continue
        try:
            if datetime.fromisoformat(_text(row.get("date"))).tzinfo is not None:
                raise ValueError("expected Beijing wall-clock date")
            parsed = datetime.fromisoformat(label)
            values = {key: float(row[key]) for key in ("open", "high", "low", "close")}
            if (
                not all(math.isfinite(v) and v > 0 for v in values.values())
                or values["low"] > min(values.values())
                or values["high"] < max(values.values())
                or (normalized and label <= normalized[-1]["date"])
            ):
                raise ValueError("invalid OHLC or order")
            # 日/周/月的 period_end 是实际交易日，不应早于当日收盘参与历史确认。
            end_label = _text(row.get("period_end") or label)
            end_at = datetime.fromisoformat(end_label)
            if len(end_label) == 10:
                end_at = end_at.replace(hour=15)
            if cutoff and end_at > datetime.fromisoformat(cutoff):
                continue
            closed = row.get("is_closed") is True and (
                not cutoff or end_at <= datetime.fromisoformat(cutoff)
            )
            normalized.append({"date": label, **values, "isClosed": closed, "periodEnd": end_label})
            if parsed.tzinfo is not None or end_at.tzinfo is not None:
                raise ValueError("expected Beijing wall-clock time")
        except (KeyError, TypeError, ValueError, OverflowError):
            return _empty(
                period, source, [], ["K 线价格、日期或顺序异常，未计算缠论结构"], "invalid_data"
            )
    key = json.dumps(normalized, sort_keys=True, allow_nan=False, default=str)
    try:
        return copy.deepcopy(_analyze_cached(key, period, source))
    except _CalculationError:
        return _empty(period, source, [], ["缠论计算失败，请重试或检查行情数据"], "invalid_data")


@lru_cache(maxsize=16)
def _analyze_cached(serialized: str, period: str, source: str) -> dict:
    rows = json.loads(serialized)
    result = _empty(period, source, rows, [])
    if not rows:
        result["issues"] = ["暂无当前周期 K 线"]
        return result
    closed = [r for r in rows if r["isClosed"]]
    conf = CChanConfig(dict(ENGINE_CONFIG))
    engine = CKLine_List(PERIODS[period], conf)
    dates = [r["date"] for r in closed]
    known: dict[tuple, str] = {}
    signals: dict[str, dict] = {}
    previous = None
    try:
        for i, row in enumerate(closed):
            dt = datetime.fromisoformat(row["date"])
            unit = CKLine_Unit(
                {
                    DATA_FIELD.FIELD_TIME: CTime(
                        dt.year, dt.month, dt.day, dt.hour, dt.minute, auto=False
                    ),
                    **{
                        getattr(DATA_FIELD, f"FIELD_{key.upper()}"): row[key]
                        for key in ("open", "high", "low", "close")
                    },
                }
            )
            unit.set_idx(i)
            unit.kl_type = PERIODS[period]
            unit.set_pre_klu(previous)
            previous = unit
            engine.add_single_klu(unit)
            available = row["periodEnd"][: 16 if period == "30m" else 10]
            for klc in engine.lst:
                if klc.fx != FX_TYPE.UNKNOWN:
                    peak = klc.get_peak_klu(is_high=klc.fx == FX_TYPE.TOP)
                    known.setdefault(
                        ("fractal", klc.idx, peak.idx, klc.fx, klc.high, klc.low), available
                    )
            for kind, items in (("stroke", engine.bi_list), ("segment", engine.seg_list)):
                for item in items:
                    if item.is_sure:
                        known.setdefault(
                            (kind, item.get_begin_klu().idx, item.get_end_klu().idx), available
                        )
            for kind, items in (("stroke", engine.zs_list), ("segment", engine.segzs_list)):
                for item in items:
                    known.setdefault(
                        ("center", kind, item.begin.idx, item.low, item.high), available
                    )
            _update_signals(engine, source, row, dates, signals)
            for divergence in _divergences(engine, source, dates):
                if divergence["status"] == "candidate":
                    known.setdefault(("divergence", divergence["id"]), available)
        result["fractals"] = [
            _fractal(klc, dates, known) for klc in engine.lst if klc.fx != FX_TYPE.UNKNOWN
        ]
        result["strokes"] = [_movement(bi, "stroke", dates, known) for bi in engine.bi_list]
        result["segments"] = [_movement(seg, "segment", dates, known) for seg in engine.seg_list]
        result["strokeCenters"] = [
            _center(z, "stroke", dates, known) for z in engine.zs_list if z.high > z.low
        ]
        result["segmentCenters"] = [
            _center(z, "segment", dates, known) for z in engine.segzs_list if z.high > z.low
        ]
        result["centers"] = result["strokeCenters" if source == "stroke" else "segmentCenters"]
        result["candidateSignals"] = sorted(
            signals.values(), key=lambda s: (s["availableDate"], s["id"])
        )
        # 未闭合尾部只可使价格边界失效，不能创建或确认结构。
        for row in rows:
            for signal in result["candidateSignals"]:
                _invalidate_at_boundary(signal, row)
        result["divergences"] = _divergences(engine, source, dates)
        for divergence in result["divergences"]:
            divergence["availableDate"] = known.get(("divergence", divergence["id"]))
        result["mergedBars"] = [_merged_bar(klc, dates) for klc in engine.lst]
    except Exception as exc:
        logger.exception("chan.py calculation failed for period=%s source=%s", period, source)
        # 不缓存瞬时计算失败，否则同一输入的重试永远返回旧错误。
        raise _CalculationError from exc
    result["window"]["mergedBars"] = len(engine.lst)
    confirmed = [s for s in result["strokes"] if s["confirmed"]]
    result["latestConfirmedStroke"] = confirmed[-1] if confirmed else None
    forming = [s for s in result["strokes"] if not s["confirmed"]]
    result["formingStroke"] = forming[-1] if forming else None
    result["latestFractal"] = result["fractals"][-1] if result["fractals"] else None
    centers = result["centers"]
    result["latestCenter"] = centers[-1] if centers else None
    if len(centers) >= 2 and centers[-1]["zd"] > centers[-2]["zg"]:
        result["trendType"] = "uptrend_proxy"
    elif len(centers) >= 2 and centers[-1]["zg"] < centers[-2]["zd"]:
        result["trendType"] = "downtrend_proxy"
    elif centers:
        result["trendType"] = "consolidation_proxy"
    if centers:
        price = result["currentPrice"]
        result["pricePosition"] = (
            "above"
            if price > centers[-1]["zg"]
            else "below"
            if price < centers[-1]["zd"]
            else "inside"
        )
    result["status"] = "ready" if result["strokes"] else "insufficient"
    if len(closed) != len(rows):
        result["issues"].append("未闭合或闭合状态未知的 K 线不参与结构确认")
    if not result["strokes"]:
        result["issues"].append("尚未形成满足当前引擎规则的有效笔")
    return result


def _fractal(klc, dates, known):
    top = klc.fx == FX_TYPE.TOP
    unit = klc.get_peak_klu(is_high=top)
    # 分型至少需要右侧合并K线；其最早形成时刻在逐根处理时记录。
    right = klc.next.lst[0] if klc.next is not None else unit
    confirmed_at = known.get(
        ("fractal", klc.idx, unit.idx, klc.fx, klc.high, klc.low), dates[right.idx]
    )
    return {
        "type": "top" if top else "bottom",
        "mergedIndex": klc.idx,
        "sourceIndex": unit.idx,
        "date": dates[unit.idx],
        "price": klc.high if top else klc.low,
        "confirmedAt": confirmed_at,
        "confirmedSourceIndex": dates.index(confirmed_at),
    }


def _merged_bar(klc, dates):
    high, low = klc.get_peak_klu(is_high=True), klc.get_peak_klu(is_high=False)
    return {
        "sourceStartIndex": klc.lst[0].idx,
        "sourceEndIndex": klc.lst[-1].idx,
        "startDate": dates[klc.lst[0].idx],
        "endDate": dates[klc.lst[-1].idx],
        "high": klc.high,
        "low": klc.low,
        "highDate": dates[high.idx],
        "lowDate": dates[low.idx],
        "highSourceIndex": high.idx,
        "lowSourceIndex": low.idx,
        "direction": "up" if klc.dir.name == "UP" else "down",
        "uncertain": klc.idx == 0,
        "closed": True,
        "periodEnd": dates[klc.lst[-1].idx],
    }


def _movement(item, kind, dates, known):
    begin, end = item.get_begin_klu(), item.get_end_klu()
    start, finish = dates[begin.idx], dates[end.idx]
    a, b = item.get_begin_val(), item.get_end_val()
    row = {
        "id": f"{kind}-{start}-{finish}",
        "index": item.idx,
        "direction": "up" if item.is_up() else "down",
        "startDate": start,
        "endDate": finish,
        "startPrice": a,
        "endPrice": b,
        "low": min(a, b),
        "high": max(a, b),
        "changePct": b / a - 1,
        "confirmed": bool(item.is_sure),
        "confirmedAt": known.get((kind, begin.idx, end.idx)) if item.is_sure else None,
        "bars": end.idx - begin.idx + 1,
    }
    if kind == "stroke":
        row.update(
            start=_fractal(item.begin_klc, dates, known),
            end=_fractal(item.end_klc, dates, known),
            mergedBars=item.end_klc.idx - item.begin_klc.idx + 1,
        )
    else:
        row.update(
            startStrokeIndex=item.start_bi.idx,
            endStrokeIndex=item.end_bi.idx,
            componentCount=item.end_bi.idx - item.start_bi.idx + 1,
        )
    return row


def _center(z, source, dates, known):
    outside = z.bi_out
    state = "extension" if z.end_bi.idx - z.begin_bi.idx > 2 else "newborn"
    if outside is not None and outside.is_sure:
        if outside.get_end_val() > z.high:
            state = "broken_up"
        elif outside.get_end_val() < z.low:
            state = "broken_down"
    return {
        "id": f"center-{source}-{dates[z.begin.idx]}-{z.low}-{z.high}",
        "source": source,
        "startStrokeIndex": z.begin_bi.idx,
        "endStrokeIndex": z.end_bi.idx,
        "startDate": dates[z.begin.idx],
        "endDate": dates[z.end.idx],
        "formedAt": known[("center", source, z.begin.idx, z.low, z.high)],
        "zd": z.low,
        "zg": z.high,
        "dd": z.peak_low,
        "gg": z.peak_high,
        "componentCount": z.end_bi.idx - z.begin_bi.idx + 1,
        "state": state,
        "confirmed": bool(z.is_sure),
    }


def _invalidate_at_boundary(signal, row):
    if (
        signal["invalidatedAt"]
        or row["date"] < signal["availableDate"]
        or row["date"] == signal["structureDate"]
    ):
        return
    crossed = (
        row["low"] <= signal["boundary"]
        if signal["kind"].endswith("_buy")
        else row["high"] >= signal["boundary"]
    )
    if crossed:
        signal.update(
            status="invalidated", invalidatedAt=row["date"], invalidationReason="price_boundary"
        )


def _update_signals(engine, source, row, dates, signals):
    points = engine.bs_point_lst if source == "stroke" else engine.seg_bs_point_lst
    active = set()
    for point in points.bsp_iter():
        for variant in point.type:
            side = "buy" if point.is_buy else "sell"
            kind = {"1": "first", "2": "second", "3": "third"}[variant.value[0]] + f"_{side}"
            key = f"{source}-{kind}-{variant.value}-{dates[point.klu.idx]}"
            active.add(key)
            if key not in signals:
                signals[key] = {
                    "id": key,
                    "kind": kind,
                    "variant": variant.value,
                    "status": "candidate",
                    "source": source,
                    "structureDate": dates[point.klu.idx],
                    "availableDate": row["date"],
                    "price": point.bi.get_end_val(),
                    "boundary": point.klu.low if point.is_buy else point.klu.high,
                    "boundaryRule": "signal_bar_extreme",
                    "invalidatedAt": None,
                    "relatedSignalId": None,
                    "conditions": [
                        {
                            "id": "lower_level",
                            "label": "次级别确认",
                            "state": "unavailable",
                            "evidence": "当前仅计算单周期结构，尚未联立次级别",
                        }
                    ],
                    "nextWatch": "观察次级别确认；触及信号K线极值边界则候选失效",
                }
            signals[key]["structureConfirmed"] = bool(point.bi.is_sure)
            if variant.value in {"1", "1p"}:
                signals[key]["origin"] = (
                    "trend_divergence" if variant.value == "1" else "consolidation_divergence"
                )
            if point.relate_bsp1 is not None:
                related_date = dates[point.relate_bsp1.klu.idx]
                signals[key]["relatedSignalId"] = next(
                    (
                        s["id"]
                        for s in signals.values()
                        if s["kind"] == f"first_{side}" and s["structureDate"] == related_date
                    ),
                    None,
                )
    for key, signal in signals.items():
        if not signal["invalidatedAt"] and key not in active:
            signal.update(
                status="invalidated",
                invalidatedAt=row["date"],
                invalidationReason="structure_replaced",
            )
        _invalidate_at_boundary(signal, row)


def _divergences(engine, source, dates):
    result = []
    centers = engine.zs_list if source == "stroke" else engine.segzs_list
    config = engine.config.bs_point_conf if source == "stroke" else engine.config.seg_bs_point_conf
    for z in centers:
        a, c = z.bi_in, z.bi_out
        if a is None or c is None or a.dir != c.dir:
            continue
        point_config = config.b_conf if c.is_down() else config.s_conf
        found, _ = z.is_divergence(point_config)

        def movement(item, metric_algo=point_config.macd_algo, leaving=c):
            metric = item.cal_macd_metric(metric_algo, is_reverse=item is leaving)
            return {
                "startDate": dates[item.get_begin_klu().idx],
                "endDate": dates[item.get_end_klu().idx],
                "changePct": item.get_end_val() / item.get_begin_val() - 1,
                "bars": item.get_klu_cnt(),
                "force": metric,
                "macdArea": metric if source == "stroke" else None,
            }

        result.append(
            {
                "id": f"divergence-{source}-{z.begin.idx}-{z.low}-{z.high}-{a.get_begin_klu().idx}-{a.get_end_klu().idx}-{c.get_begin_klu().idx}-{c.get_end_klu().idx}",
                "kind": "consolidation",
                "direction": "down" if c.is_down() else "up",
                "source": source,
                "status": "candidate" if found else "not_found",
                "movementAIndex": a.idx,
                "movementCIndex": c.idx,
                "a": movement(a),
                "c": movement(c),
                "evidence": "同方向进出中枢走势比较：笔使用MACD面积，线段使用斜率；不代表次级别确认",
            }
        )
    return result
