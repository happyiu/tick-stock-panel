# ruff: noqa: RUF001
"""Price structure adapted from CrabOctopus/stock-trend-pattern (MIT; see LICENSE)."""

from __future__ import annotations

from statistics import mean


def fit(points):
    xs, ys = zip(*points, strict=True)
    mx, my = mean(xs), mean(ys)
    denominator = sum((x - mx) ** 2 for x in xs)
    slope = sum((x - mx) * (y - my) for x, y in points) / denominator if denominator else 0.0
    intercept = my - slope * mx
    total = sum((y - my) ** 2 for y in ys)
    error = sum((y - slope * x - intercept) ** 2 for x, y in points)
    return dict(slope=slope, intercept=intercept, r2=1 - error / total if total else 0.0)


def line_at(line, index):
    return line["slope"] * index + line["intercept"]


def slope_pct(cs, start, end):
    segment = cs[max(0, start) : end + 1]
    if len(segment) < 3:
        return 0.0
    return (
        fit(list(enumerate(c["c"] for c in segment)))["slope"]
        * len(segment)
        / mean(c["c"] for c in segment)
        * 100
    )


def pivots(cs, order=3):
    result = dict(ph=[], pl=[])
    for i in range(order, len(cs) - order):
        neighbors = cs[i - order : i] + cs[i + 1 : i + order + 1]
        for key, field, direction in [("ph", "h", 1), ("pl", "l", -1)]:
            if all(direction * cs[i][field] > direction * c[field] for c in neighbors):
                result[key].append(
                    dict(
                        i=i,
                        p=cs[i][field],
                        d=cs[i]["d"],
                        confirmedIndex=i + order,
                        confirmedAt=cs[i + order]["d"],
                    )
                )
    return result


def levels(cs, swings):
    current = cs[-1]["c"]
    result = dict(support=[], resistance=[])
    for key, side in [("ph", "resistance"), ("pl", "support")]:
        groups = []
        for point in swings[key]:
            group = next(
                (
                    g
                    for g in groups
                    if abs(mean(p["p"] for p in g) - point["p"]) / point["p"] <= 0.018
                ),
                None,
            )
            if group is None:
                groups.append([point])
            else:
                group.append(point)
        for group in groups:
            price = mean(p["p"] for p in group)
            if (side == "support" and price < current * 0.998) or (
                side == "resistance" and price > current * 1.002
            ):
                result[side].append(
                    dict(
                        price=price,
                        touches=len(group),
                        lastIdx=group[-1]["i"],
                        lastDate=group[-1]["d"],
                        dist=(price / current - 1) * 100,
                        kind="sup" if side == "support" else "res",
                    )
                )
        result[side].sort(key=lambda item: abs(item["dist"]))
        result[side] = result[side][:4]
    return result


TREND_NAMES = {
    "up": "上升",
    "up-warn": "上升转弱",
    "down": "下降",
    "down-warn": "下降企稳",
    "flat": "横盘",
    "unknown": "样本不足",
}


def trend(cs):
    swings = pivots(cs, 4)
    result = {}
    for key, window in [("short", 20), ("mid", 60), ("long", 120)]:
        highs = [p["p"] for p in swings["ph"] if p["i"] >= len(cs) - window]
        lows = [p["p"] for p in swings["pl"] if p["i"] >= len(cs) - window]

        def direction(values):
            if len(values) < 2:
                return None
            return (
                "up"
                if values[-1] > values[-2] * 1.005
                else "down"
                if values[-1] < values[-2] * 0.995
                else "flat"
            )

        high, low = direction(highs), direction(lows)
        verdict = "unknown"
        if len(cs) >= window:
            verdict = {
                ("up", "up"): "up",
                ("down", "down"): "down",
                ("up", "down"): "up-warn",
                ("down", "up"): "down-warn",
            }.get((high, low))
            if verdict is None:
                slope = slope_pct(cs, len(cs) - window, len(cs) - 1)
                verdict = "up" if slope > 6 else "down" if slope < -6 else "flat"
        result[key] = dict(
            verdict=verdict, window=window, swingHighs=highs[-3:], swingLows=lows[-3:]
        )
    return result


def verdict(cs, ind, trends, price_levels, patterns):
    current = cs[-1]["c"]
    # Unconfirmed geometry is shown for observation, but cannot count as a confirmed signal.
    signed = {"bull": 1, "bear": -1, "neutral": 0}
    pattern_score = max(
        -10.0,
        min(
            10.0,
            sum(signed[p["dir"]] * p["conf"] / 22 for p in patterns if p["status"] == "confirmed"),
        ),
    )
    ma_values = {f"m{period}": ind["ma"][f"ma{period}"][-1] for period in (5, 10, 20, 60)}
    m5, m10, m20, m60 = ma_values.values()
    ma_score, alignment = 0.0, "均线样本不足"
    if all(v is not None for v in ma_values.values()):
        if m5 > m10 > m20 > m60:
            ma_score, alignment = 3.0, "完美多头排列"
        elif m5 < m10 < m20 < m60:
            ma_score, alignment = -3.0, "完全空头排列"
        elif m5 > m20 > m60:
            ma_score, alignment = 1.5, "偏多排列"
        elif m5 < m20 < m60:
            ma_score, alignment = -1.5, "偏空排列"
        else:
            alignment = "均线缠绕"
    if m20 is not None and current != m20:
        ma_score += 0.5 if current > m20 else -0.5
    values = {"up": 1, "up-warn": 0.4, "flat": 0, "down-warn": -0.4, "down": -1, "unknown": 0}
    trend_score = sum(
        values[trends[k]["verdict"]] * weight
        for k, weight in [("long", 2), ("mid", 1.6), ("short", 1.2)]
    )
    total = round(pattern_score + ma_score + trend_score, 1)
    agree = (pattern_score >= 1 and ma_score >= 0.5 and trend_score >= 0.5) or (
        pattern_score <= -1 and ma_score <= -0.5 and trend_score <= -0.5
    )
    if agree and abs(total) >= 5:
        stance, stance_en = ("看涨", "bull") if total > 0 else ("看跌", "bear")
    elif agree and abs(total) >= 2:
        stance, stance_en = ("偏多", "weak-bull") if total > 0 else ("偏空", "weak-bear")
    elif abs(total) >= 1.5:
        stance, stance_en = ("震荡偏多", "flat-bull") if total > 0 else ("震荡偏空", "flat-bear")
    else:
        stance, stance_en = "震荡 / 方向不明", "flat"
    resistance = next(iter(price_levels["resistance"]), None)
    support = next(iter(price_levels["support"]), None)
    rr = (
        (resistance["price"] - current) / (current - support["price"])
        if resistance and support
        else None
    )
    v5, v20 = ind["volMa5"][-1], ind["volMa20"][-1]
    advice = (
        "；".join(
            f"{label}{TREND_NAMES[trends[k]['verdict']]}"
            for k, label in [("long", "长期"), ("mid", "中期"), ("short", "短期")]
        )
        + "。"
    )
    advice += (
        "形态、均线与趋势同向，仍需观察延续性。" if agree else "形态、均线与趋势尚未形成同向确认。"
    )
    return dict(
        stance=stance,
        stanceEn=stance_en,
        score=total,
        patternScore=round(pattern_score, 1),
        maScore=ma_score,
        trendScore=round(trend_score, 1),
        agree=agree,
        advice=advice,
        bullCount=sum(p["dir"] == "bull" for p in patterns),
        bearCount=sum(p["dir"] == "bear" for p in patterns),
        neutralCount=sum(p["dir"] == "neutral" for p in patterns),
        maAlign=alignment,
        ma=ma_values,
        volRatio=v5 / v20 if v5 is not None and v20 else None,
        nearestRes=resistance,
        nearestSup=support,
        rr=round(rr, 2) if rr is not None else None,
    )
