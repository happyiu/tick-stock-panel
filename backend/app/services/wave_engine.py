"""Bounded, timestamp-aware integration of the MIT wave-alpha rule core."""

import hashlib
import json
from datetime import datetime, time, timedelta
from decimal import Decimal
from functools import lru_cache
from itertools import pairwise

from app.market_time import CN_TZ
from app.services.wave_core.domain import Interval
from app.services.wave_core.elliott.enumerator import enumerate_counts
from app.services.wave_core.elliott.models import WaveCount
from app.services.wave_core.elliott.templates import load_bundled_templates
from app.services.wave_core.elliott.validator import validate
from app.services.wave_core.pivots.models import PivotEvent, PivotState, PivotType
from app.services.wave_position import scaled_pivots

VERSION = "wave-v3-alpha-0.14.3-r1"
LABELS = {
    "impulse": ["1", "2", "3", "4", "5"],
    "leading_diagonal": ["1", "2", "3", "4", "5"],
    "ending_diagonal": ["1", "2", "3", "4", "5"],
    "zigzag": ["A", "B", "C"],
    "flat": ["A", "B", "C"],
    "expanded_flat": ["A", "B", "C"],
    "contracting_triangle": ["A", "B", "C", "D", "E"],
    "wxy": ["W", "X", "Y"],
}


def calculate(rows, period, as_of):
    base = dict(
        version=VERSION,
        period=period,
        status="insufficient",
        counts=[],
        candidates=[],
        invalidated=[],
        issues=[],
        coverageStart=None,
        dataThrough=None,
    )
    if period not in ("1d", "30m"):
        return dict(base, status="unsupported", issues=["仅支持日线和30分钟"])
    try:
        cutoff = datetime.fromisoformat(as_of) if as_of else datetime.max
        if cutoff.tzinfo:
            raise ValueError("Beijing wallclock required")
        if as_of and len(as_of) == 10:
            cutoff = datetime.combine(cutoff.date(), time.max)
        normalized = []
        previous = None
        for r in rows:
            stamp = datetime.fromisoformat(str(r["date"]))
            is_closed = r.get("is_closed") is True
            is_forming = period == "1d" and not is_closed and r.get("is_live") is True
            available = datetime.combine(stamp.date(), time(15)) if period == "1d" else stamp
            if period == "1d" and r.get("is_live") is True and r.get("quote_ts") is not None:
                try:
                    quote_ts = float(r["quote_ts"])
                    if quote_ts > 1_000_000_000_000:
                        quote_ts /= 1000
                    available = datetime.fromtimestamp(quote_ts, CN_TZ).replace(tzinfo=None)
                except (OSError, OverflowError, TypeError, ValueError):
                    pass
            if available > cutoff:
                continue
            if stamp.tzinfo or (previous and stamp <= previous):
                raise ValueError("order")
            previous = stamp
            values = [float(r[k]) for k in ("open", "high", "low", "close")]
            o, h, low, c = values
            import math

            if (
                not all(math.isfinite(v) and v > 0 for v in values)
                or low > min(o, c)
                or h < max(o, c)
            ):
                raise ValueError("OHLC")
            if is_closed or is_forming:
                normalized.append(
                    dict(
                        date=stamp.isoformat(sep=" ")
                        if period == "30m"
                        else stamp.date().isoformat(),
                        open=o,
                        high=h,
                        low=low,
                        close=c,
                        closed=is_closed,
                        forming=is_forming,
                    )
                )
        if normalized:
            end = datetime.fromisoformat(normalized[-1]["date"])
            if period == "1d":
                normalized = [
                    r
                    for r in normalized
                    if datetime.fromisoformat(r["date"]) >= end - timedelta(days=1096)
                ][-1500:]
            else:
                dates = sorted({r["date"][:10] for r in normalized})[-120:]
                normalized = [r for r in normalized if r["date"][:10] in dates]
        result = json.loads(_cached(json.dumps(normalized), period, VERSION))
        result["isProvisional"] = any(r["forming"] for r in normalized)
        if result["isProvisional"]:
            result["issues"].append("已纳入当日未收盘日K，当前结果为盘中临时分析")
        return dict(base, **result)
    except (ValueError, KeyError, TypeError, OverflowError):
        return dict(base, status="invalid_data", issues=["K线日期、顺序或价格异常"])


def shape_guard(count):
    """Price geometry supplements upstream ratio-only templates."""
    sign = 1 if count.pivots[1].price > count.pivots[0].price else -1
    v = [sign * p.price for p in count.pivots]
    if any((b - a) * (1 if i % 2 == 0 else -1) <= 0 for i, (a, b) in enumerate(pairwise(v))):
        return False
    if count.pattern == "contracting_triangle":
        return v[3] < v[1] and v[4] > v[2] and v[5] < v[3]
    if count.pattern in ("impulse", "leading_diagonal", "ending_diagonal"):
        if not (v[2] > v[0] and v[3] > v[1] and v[4] > v[2] and v[5] > v[3]):
            return False
        if count.pattern == "impulse":
            return v[4] > v[1]
        lengths = [abs(v[i + 1] - v[i]) for i in (0, 2, 4)]
        return v[4] < v[1] and (
            lengths[0] > lengths[1] > lengths[2] or lengths[0] < lengths[1] < lengths[2]
        )
    if count.pattern == "zigzag":
        return v[2] > v[0] and v[3] > v[1]
    if count.pattern in ("flat", "expanded_flat"):
        return v[3] >= v[1]
    return True


def _tree(count, templates, scales, depth=0):
    tpl = templates[count.pattern]
    nodes = []
    for label, start, end in zip(tpl.waves, count.pivots, count.pivots[1:], strict=False):
        node = dict(
            label=label,
            start=_point(start, "0"),
            end=_point(end, label),
            children=[],
            validation="unresolved",
        )
        if depth < 2 and count.degree > 0:
            sub = [
                p
                for p in scales[count.degree - 1]
                if start.timestamp <= p.timestamp <= end.timestamp
            ]
            for name in tpl.allowed_sub_patterns.get(label, []):
                child_tpl = templates.get(name)
                if (
                    child_tpl is None
                    or len(sub) != len(child_tpl.waves) + 1
                    or sub[0].timestamp != start.timestamp
                    or sub[-1].timestamp != end.timestamp
                    or sub[0].type != start.type
                    or sub[-1].type != end.type
                ):
                    continue
                child = validate(
                    WaveCount(pattern=name, degree=count.degree - 1, pivots=sub), child_tpl
                )
                if not child.hard_violations and shape_guard(child):
                    node["children"] = _tree(child, templates, scales, depth + 1)
                    node["validation"] = "subdivision_validated"
                    break
        nodes.append(node)
    return nodes


def _point(p, label):
    return dict(
        date=p.timestamp.isoformat(sep=" "),
        confirmedAt=p.confirmed_at.isoformat(sep=" ") if p.confirmed_at else None,
        value=float(p.price),
        label=label,
    )


@lru_cache(maxsize=32)
def _cached(serialized, period, version):
    rows = json.loads(serialized)
    templates = {t.name: t for t in load_bundled_templates() if t.name in LABELS}
    interval = Interval.DAILY if period == "1d" else Interval.MINUTE_30
    scales = {}
    for degree, multiplier in enumerate((0.5, 1, 2, 4, 8)):
        scales[degree] = [
            PivotEvent(
                interval=interval,
                degree=degree,
                timestamp=datetime.fromisoformat(p["date"]),
                confirmed_at=datetime.fromisoformat(p["confirmedAt"]),
                price=Decimal(str(p["value"])),
                type=PivotType.HIGH if p["side"] == "high" else PivotType.LOW,
                state=PivotState.CONFIRMED,
            )
            for p in scaled_pivots(rows, multiplier)[-96:]
        ]
    candidates = []
    invalidated = []
    for degree in (1, 2, 3, 4):
        counts = enumerate_counts(
            scales[degree],
            degree=degree,
            top_k=8,
            templates=list(templates.values()),
            sub_pivots=scales[degree - 1],
            accept=shape_guard,
        )
        for count in counts:
            if not shape_guard(count):
                continue
            tree = _tree(count, templates, scales)
            level = (
                "subdivision_validated"
                if tree and all(n["validation"] == "subdivision_validated" for n in tree)
                else "shape_only"
            )
            points = [
                _point(p, label)
                for p, label in zip(count.pivots, ["0", *LABELS[count.pattern]], strict=True)
            ]
            direction = "up" if points[1]["value"] > points[0]["value"] else "down"
            last = count.pivots[-1]
            tail = [r for r in rows if datetime.fromisoformat(r["date"]) > last.timestamp]
            # A completed pattern remains historical evidence; the continuation is provisional.
            active = (
                "A" if count.pattern in ("impulse", "leading_diagonal", "ending_diagonal") else "1"
            )
            active_up = direction == "down"
            boundary = points[-1]["value"]
            breached = next(
                (
                    r
                    for r in tail
                    if r["closed"] and (r["low"] < boundary if active_up else r["high"] > boundary)
                ),
                None,
            )
            provisional_breach = next(
                (
                    r
                    for r in tail
                    if r.get("forming")
                    and (r["low"] < boundary if active_up else r["high"] > boundary)
                ),
                None,
            )
            ident = hashlib.sha256(
                f"{period}|{degree}|{count.pattern}|{points[0]['date']}|{direction}".encode()
            ).hexdigest()[:20]
            candidate = dict(
                id=ident,
                pattern=count.pattern,
                degree=degree,
                direction=direction,
                stage=points[-1]["label"],
                status="valid",
                points=points,
                waveTree=tree,
                score=dict(
                    total=count.score,
                    template=count.template_fit_component,
                    fibonacci=count.fib_component,
                    recency=count.recency_component,
                ),
                rules=[
                    c.rationale
                    for c in templates[count.pattern].constraints
                    if c.name not in count.hard_violations + count.soft_violations
                ],
                validation=dict(
                    level=level,
                    passed=[],
                    pending=[]
                    if level == "subdivision_validated"
                    else ["子浪证据不足;递归最多两层"],
                ),
                currentPosition=dict(
                    lastCompleted=points[-1]["label"],
                    active=active if tail and not breached and not provisional_breach else None,
                    direction="up" if active_up else "down",
                    status="forming" if tail and not breached and not provisional_breach else "unresolved",
                    explanation="已完成结构保留,后续浪段仍待验证",
                ),
                nextCondition="等待反向运动及子结构确认;延伸时重新评估",
                invalidation=dict(
                    value=boundary,
                    direction="below" if active_up else "above",
                    reason="后续反向浪假设失效,历史结构保留",
                ),
                projections=[],
            )
            if provisional_breach and not breached:
                candidate["provisionalInvalidation"] = dict(
                    date=provisional_breach["date"],
                    price=provisional_breach["low"] if active_up else provisional_breach["high"],
                    boundary=boundary,
                    direction="below" if active_up else "above",
                )
            if (
                tail
                and not breached
                and count.pattern in ("impulse", "leading_diagonal", "ending_diagonal")
            ):
                length = abs(points[-1]["value"] - points[0]["value"])
                candidate["projections"] = [
                    dict(
                        ratio=r,
                        value=boundary + (1 if active_up else -1) * length * r,
                        kind="correction_reference",
                        reference=[points[0]["date"], points[-1]["date"]],
                    )
                    for r in (0.382, 0.618)
                ]
            if breached:
                invalidated.append(
                    dict(candidate, status="invalidated", effectiveAt=breached["date"])
                )
            candidates.append(candidate)
    candidates.sort(
        key=lambda c: (
            c["validation"]["level"] == "subdivision_validated",
            c["score"]["total"],
            c["points"][-1]["confirmedAt"],
            c["id"],
        ),
        reverse=True,
    )
    counts = candidates[:3]
    result = dict(
        inputFingerprint=hashlib.sha256(serialized.encode()).hexdigest(),
        status="ok" if counts else "no_candidate",
        counts=counts,
        candidates=counts,
        invalidated=invalidated,
        issues=[],
        coverageStart=rows[0]["date"] if rows else None,
        dataThrough=rows[-1]["date"] if rows else None,
        dataCoverage=dict(
            bars=sum(r["closed"] for r in rows),
            formingBars=sum(r.get("forming", False) for r in rows),
            searchPivotLimit=96,
            recursionLimit=2,
            truncated=any(len(s) >= 96 for s in scales.values()),
        ),
    )
    return json.dumps(result)
