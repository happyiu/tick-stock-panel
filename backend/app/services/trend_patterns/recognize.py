# ruff: noqa: RUF001
"""Native classic-pattern rules adapted from stock-trend-pattern, MIT (see LICENSE).

The catalog defines geometry, not calibrated probabilities. Actual-price advice
is derived here; catalog teaching prices never enter diagnostic output.
"""

from __future__ import annotations

import itertools
from statistics import mean

from .structure import fit, line_at, pivots, slope_pct


def body(c):
    return abs(c["c"] - c["o"])


def span(c):
    return max(c["h"] - c["l"], 1e-9)


def upper(c):
    return c["h"] - max(c["o"], c["c"])


def lower(c):
    return min(c["o"], c["c"]) - c["l"]


def up(c):
    return c["c"] > c["o"]


def prior(cs, index, look=6):
    return slope_pct(cs, max(0, index - look), index)


def candle_matches(cs, rule, at):
    c, p = cs[at], cs[at - 1]
    # Historical hits use only the statistics available on their own bar.
    average = max(mean(body(x) for x in cs[max(0, at - 59) : at + 1]), 1e-9)
    average_span = mean(span(x) for x in cs[max(0, at - 59) : at + 1])

    def denominator(x):
        return max(body(x), average * 0.35)

    def doji(x):
        return body(x) <= max(span(x) * 0.1, average * 0.28)

    expected = rule.get("trend_before")
    context_end = (
        at - rule.get("n", 3)
        if rule["type"] == "multi"
        else at - 2
        if rule["type"] == "two"
        else at - 1
    )
    if expected and (
        prior(cs, context_end) <= 3 if expected == "up" else prior(cs, context_end) >= -3
    ):
        return False
    kind = rule["type"]
    if kind == "single":
        if "up" in rule and up(c) != rule["up"]:
            return False
        if rule.get("body_big") and body(c) < average * 1.5:
            return False
        if rule.get("body_small") and body(c) > average * 0.65:
            return False
        if rule.get("doji") and not doji(c):
            return False
        for name, value in [("upper_shadow", upper(c)), ("lower_shadow", lower(c))]:
            if name in rule:
                threshold = rule[name]
                # Small shadow parameters are maxima, not minimum requirements.
                if (threshold <= 0.5 and value / denominator(c) > threshold) or (
                    threshold > 0.5 and value / denominator(c) < threshold
                ):
                    return False
        return not (
            rule.get("upper_shadow", 1) <= 0.05
            and rule.get("lower_shadow", 1) <= 0.05
            and span(c) > average_span * 0.25
        )
    if kind == "two":
        if rule.get("key_reversal") and not (c["h"] > p["h"] and c["c"] < p["c"] and not up(c)):
            return False
        if any(
            key in rule and up(bar) != rule[key] for key, bar in [("prev_up", p), ("cur_up", c)]
        ):
            return False
        if rule.get("engulf") and not (
            max(c["o"], c["c"]) >= max(p["o"], p["c"])
            and min(c["o"], c["c"]) <= min(p["o"], p["c"])
        ):
            return False
        if rule.get("harami") and not (
            max(c["o"], c["c"]) <= max(p["o"], p["c"])
            and min(c["o"], c["c"]) >= min(p["o"], p["c"])
        ):
            return False
        if rule.get("doji") and not doji(c):
            return False
        if "pierce" in rule:
            mid = (p["o"] + p["c"]) / 2
            if rule.get("prev_up") and not (c["o"] > p["h"] and p["o"] < c["c"] < mid):
                return False
            if not rule.get("prev_up") and not (c["o"] < p["l"] and mid < c["c"] < p["o"]):
                return False
        if rule.get("counter") and abs(c["c"] / p["c"] - 1) > 0.004:
            return False
        if rule.get("thrust") and not (c["o"] < p["c"] < c["c"] <= (p["o"] + p["c"]) / 2):
            return False
        if rule.get("tweezer"):
            field = "l" if rule["tweezer"] == "bottom" else "h"
            if abs(c[field] / p[field] - 1) > 0.004:
                return False
        return True
    n = rule.get("n", 3)
    segment = cs[at - n + 1 : at + 1]
    if len(segment) != n:
        return False
    a, b, c = segment[:3]
    if "all_up" in rule and not all(up(x) == rule["all_up"] for x in segment):
        return False
    if rule.get("soldiers") and not (
        all(segment[i]["c"] > segment[i - 1]["c"] for i in (1, 2))
        and all(body(x) > average * 0.6 for x in segment)
    ):
        return False
    if rule.get("crows") and not (
        all(segment[i]["c"] < segment[i - 1]["c"] for i in (1, 2))
        and all(body(x) > average * 0.6 for x in segment)
    ):
        return False
    if rule.get("weakening") and not (body(a) > body(b) > body(c)):
        return False
    if rule.get("doji_last") and not doji(segment[-1]):
        return False
    if rule.get("star"):
        morning = rule["star"] == "morning_doji"
        if not (
            doji(b)
            and up(a) != morning
            and up(c) == morning
            and (c["c"] > (a["o"] + a["c"]) / 2 if morning else c["c"] < (a["o"] + a["c"]) / 2)
        ):
            return False
    if rule.get("methods"):
        rising = rule["methods"] == "rising"
        if not (
            up(segment[0]) == rising
            and up(segment[-1]) == rising
            and body(segment[0]) > average
            and body(segment[-1]) > average
        ):
            return False
        if not all(
            x["h"] <= segment[0]["h"] and x["l"] >= segment[0]["l"] and body(x) < body(segment[0])
            for x in segment[1:-1]
        ):
            return False
        if not (
            segment[-1]["c"] > segment[0]["h"] if rising else segment[-1]["c"] < segment[0]["l"]
        ):
            return False
    if rule.get("gap_two_crows") and not (
        up(a) and not up(b) and not up(c) and b["o"] > a["h"] and a["c"] < c["c"] < b["c"]
    ):
        return False
    if rule.get("unique_three_river") and not (
        not up(a)
        and b["l"] < a["l"]
        and lower(b) / denominator(b) > 1.5
        and body(c) < average * 0.8
        and c["h"] < b["h"]
    ):
        return False
    if rule.get("three_line_strike"):
        last = segment[-1]
        if not (
            up(a) == up(b) == up(c)
            and up(last) != up(a)
            and max(last["o"], last["c"]) >= max(x["o"] for x in segment[:3])
            and min(last["o"], last["c"]) <= min(x["c"] for x in segment[:3])
        ):
            return False
    if rule.get("side_by_side") and (
        abs(b["o"] / c["o"] - 1) > 0.006
        or not (min(b["o"], b["c"]) > a["h"] if up(a) else max(b["o"], b["c"]) < a["l"])
    ):
        return False
    if rule.get("stairway"):
        return (
            all(not up(x) for x in segment[:3])
            and all(segment[i]["c"] < segment[i - 1]["c"] for i in (1, 2))
            and body(segment[3]) < body(segment[2])
            and up(segment[-1])
            and segment[-1]["c"] > segment[3]["h"]
        )
    return True


def drawing(cs, start, end, *, paths=(), zones=()):
    """Publish recognition coordinates in absolute chart time, independent of tail."""

    def point(index, price):
        return dict(date=cs[index]["d"], price=price)

    return dict(
        start=cs[start]["d"],
        end=cs[end]["d"],
        paths=[
            dict(label=label, points=[point(i, v) for i, v in points]) for label, points in paths
        ],
        zones=[
            dict(start=cs[a]["d"], end=cs[b]["d"], lower=lo, upper=hi) for a, b, lo, hi in zones
        ],
    )


def hit(
    at,
    conf,
    note,
    *,
    confirmed=True,
    trigger=None,
    stop=None,
    target=None,
    anchor=None,
    geometry=None,
):
    return dict(
        at=at,
        conf=round(min(92, conf)),
        note=note,
        status="confirmed" if confirmed else "forming",
        triggerPrice=trigger,
        stopPrice=stop,
        targetPrice=target,
        anchor=anchor,
        geometry=geometry,
    )


def gap_hits(cs, rule):
    gaps = []
    for i in range(max(1, len(cs) - 90), len(cs)):
        a, b = cs[i - 1 : i + 1]
        if b["l"] > a["h"]:
            gaps.append(dict(i=i, up=True, lo=a["h"], hi=b["l"]))
        elif b["h"] < a["l"]:
            gaps.append(dict(i=i, up=False, lo=b["h"], hi=a["l"]))
    if rule["type"] == "island":
        for g2 in reversed(gaps):
            for g1 in reversed(gaps):
                if not (
                    2 <= g2["i"] - g1["i"] <= 15
                    and g1["up"] == rule["top"]
                    and g2["up"] != g1["up"]
                ):
                    continue
                if max(g1["lo"], g2["lo"]) > min(g1["hi"], g2["hi"]):
                    continue
                middle = cs[g1["i"] : g2["i"]]
                stop = max(c["h"] for c in middle) if rule["top"] else min(c["l"] for c in middle)
                return hit(
                    g2["i"],
                    78,
                    f"两次反向缺口隔离了 {len(middle)} 根K线，岛形反转已形成。",
                    geometry=drawing(
                        cs,
                        g1["i"] - 1,
                        g2["i"],
                        zones=[
                            (g1["i"] - 1, g2["i"], g1["lo"], g1["hi"]),
                            (g2["i"] - 1, g2["i"], g2["lo"], g2["hi"]),
                        ],
                    ),
                    trigger=cs[g2["i"]]["c"],
                    stop=stop,
                )
        return None
    for gap in reversed(gaps):
        i, rising = gap["i"], gap["up"]
        if (
            rising != rule.get("up", True)
            or (gap["hi"] - gap["lo"]) / mean([gap["hi"], gap["lo"]]) < 0.0035
        ):
            continue
        after = cs[i + 1 : min(len(cs), i + 9)]
        filled = (
            next((i + k + 1 for k, c in enumerate(after) if c["l"] <= gap["lo"] if rising), None)
            if rising
            else next((i + k + 1 for k, c in enumerate(after) if c["h"] >= gap["hi"]), None)
        )
        before, run = prior(cs, i - 1, 25), prior(cs, i - 1, 60)
        volumes = [c["v"] for c in cs[max(0, i - 20) : i]]
        ratio = (
            cs[i]["v"] / mean(volumes)
            if len(volumes) == 20
            and all(v is not None for v in volumes)
            and mean(volumes) > 0
            and cs[i]["v"] is not None
            else None
        )
        kind = rule["kind"]
        filled_later = any(
            c["l"] <= gap["lo"] if rising else c["h"] >= gap["hi"] for c in cs[i + 1 :]
        )
        if (
            kind == "breakaway"
            and abs(before) < 8
            and ratio is not None
            and ratio > 1.3
            and not filled_later
        ):
            return hit(
                len(cs) - 1,
                76,
                f"突破缺口 {gap['lo']:.3f}–{gap['hi']:.3f}，跳空量为此前20周期均量 {ratio:.2f} 倍，观察期内未回补。",
                confirmed=len(after) >= 8,
                geometry=drawing(
                    cs,
                    i - 1,
                    len(cs) - 1 if filled is None else filled,
                    zones=[
                        (i - 1, len(cs) - 1 if filled is None else filled, gap["lo"], gap["hi"])
                    ],
                ),
                trigger=gap["hi"] if rising else gap["lo"],
                stop=gap["lo"] if rising else gap["hi"],
            )
        if kind == "runaway" and run > 12 and not filled_later:
            return hit(
                len(cs) - 1,
                72,
                f"趋势途中持续缺口 {gap['lo']:.3f}–{gap['hi']:.3f}，观察期内未回补。",
                confirmed=len(after) >= 8,
                geometry=drawing(
                    cs,
                    i - 1,
                    len(cs) - 1 if filled is None else filled,
                    zones=[
                        (i - 1, len(cs) - 1 if filled is None else filled, gap["lo"], gap["hi"])
                    ],
                ),
                stop=gap["lo"],
            )
        if (
            kind in ("exhaustion", "common")
            and filled is not None
            and (run > 18 if kind == "exhaustion" else abs(before) < 10)
        ):
            return hit(
                filled,
                72 if kind == "exhaustion" else 60,
                f"缺口 {gap['lo']:.3f}–{gap['hi']:.3f} 已在 {filled - i} 根K线后回补。",
                geometry=drawing(
                    cs,
                    i - 1,
                    len(cs) - 1 if filled is None else filled,
                    zones=[
                        (i - 1, len(cs) - 1 if filled is None else filled, gap["lo"], gap["hi"])
                    ],
                ),
                stop=gap["hi"],
            )
    return None


def geometry(cs, rule, swings):
    n, current = len(cs), cs[-1]["c"]
    highs, lows = swings["ph"], swings["pl"]
    kind = rule["type"]
    top = rule.get("top", False)
    if kind in ("double", "triple", "hs"):
        need = 2 if kind == "double" else 3
        points = (highs if top else lows)[-need:]
        opposite = lows if top else highs
        if len(points) < need:
            return None
        between = [
            [p for p in opposite if a["i"] < p["i"] < b["i"]] for a, b in itertools.pairwise(points)
        ]
        if not all(between):
            return None
        if any(
            abs(a["p"] - mean(p["p"] for p in mid)) / a["p"] < 0.035
            for a, mid in zip(points, between, strict=False)
        ):
            return None
        if kind == "hs":
            a, head, b = points
            if abs(a["p"] / b["p"] - 1) > 0.06 or not (
                head["p"] > max(a["p"], b["p"]) * 1.02
                if top
                else head["p"] < min(a["p"], b["p"]) * 0.98
            ):
                return None
            necks = [
                min(mid, key=lambda p: p["p"]) if top else max(mid, key=lambda p: p["p"])
                for mid in between
            ]
            line = fit([(p["i"], p["p"]) for p in necks])
            neck = line_at(line, n - 1)
            height = abs(head["p"] - line_at(line, head["i"]))
        else:
            if any(
                abs(p["p"] / points[0]["p"] - 1) > rule.get("tolerance", 0.03) for p in points[1:]
            ):
                return None
            neck = (min if top else max)(p["p"] for mid in between for p in mid)
            height = abs(mean(p["p"] for p in points) - neck)
        broken = current < neck if top else current > neck
        target = neck - height if top else neck + height
        return hit(
            n - 1,
            64 + (24 if broken else 0),
            f"结构极值 {' / '.join(format(p['p'], '.3f') for p in points)}；颈线 {neck:.3f}，{'收盘突破已确认' if broken else '尚未突破颈线，形态形成中'}。",
            confirmed=broken,
            trigger=neck,
            stop=points[-1]["p"],
            target=target if target > 0 else None,
            anchor=points[-1]["i"],
            geometry=drawing(
                cs,
                points[0]["i"],
                n - 1,
                paths=[
                    (
                        "结构",
                        [
                            (p["i"], p["p"])
                            for p in sorted(
                                points + [p for mid in between for p in mid], key=lambda p: p["i"]
                            )
                        ],
                    ),
                    (
                        "颈线",
                        [
                            (
                                points[0]["i"],
                                line_at(line, points[0]["i"]) if kind == "hs" else neck,
                            ),
                            (n - 1, neck),
                        ],
                    ),
                ],
            ),
        )
    if kind in ("triangle", "wedge", "broadening", "diamond", "channel", "rectangle"):
        if len(highs) < 3 or len(lows) < 3:
            return None
        hs, ls = highs[-4:], lows[-4:]
        fh, fl = fit([(p["i"], p["p"]) for p in hs]), fit([(p["i"], p["p"]) for p in ls])
        sh, sl = fh["slope"] / current * 100, fl["slope"] / current * 100
        hi, lo = line_at(fh, n - 1), line_at(fl, n - 1)
        if hi <= lo:
            return None

        def flat(value):
            return abs(value) < 0.035

        matches = False
        if kind == "triangle":
            matches = (
                flat(sh) and sl > 0.04
                if rule["kind"] == "asc"
                else flat(sl) and sh < -0.04
                if rule["kind"] == "desc"
                else sh < -0.04 and sl > 0.04
            )
        elif kind == "wedge":
            matches = sl > sh > 0.02 if rule["rising"] else sh < sl < -0.02
        elif kind == "channel":
            matches = sh > 0.02 and sl > 0.02 if rule["up"] else sh < -0.02 and sl < -0.02
            matches = matches and abs(sh - sl) < 0.06
        elif kind == "rectangle":
            matches = flat(sh) and flat(sl)
        elif kind == "broadening":
            before = prior(cs, min(hs[0]["i"], ls[0]["i"]), 30)
            matches = sh > 0.03 and sl < -0.03 and (before > 3 if top else before < -3)
        elif kind == "diamond":
            points = sorted(highs + lows, key=lambda p: p["i"])[-9:]
            widths = [abs(a["p"] - b["p"]) for a, b in itertools.pairwise(points)]
            before = prior(cs, points[0]["i"], 30)
            matches = (
                len(widths) >= 6
                and max(widths[: len(widths) // 2]) > widths[0] * 1.1
                and mean(widths[: len(widths) // 2]) > mean(widths[len(widths) // 2 :]) * 1.25
                and (before > 3 if top else before < -3)
            )
        if not matches or not ((flat(sh) or fh["r2"] >= 0.35) and (flat(sl) or fl["r2"] >= 0.35)):
            return None
        direction_up = rule.get(
            "up",
            rule.get("kind") == "asc"
            or (kind == "wedge" and not rule["rising"])
            or (kind in ("diamond", "broadening") and not top),
        )
        neutral = kind == "rectangle" or (kind == "triangle" and rule["kind"] == "sym")
        if not neutral and (current < lo * 0.995 if direction_up else current > hi * 1.005):
            return None
        broken = current > hi if direction_up else current < lo
        if neutral:
            broken = False
        return hit(
            n - 1,
            60 + min(fh["r2"], fl["r2"]) * 20,
            f"拟合上沿 {hi:.3f}、下沿 {lo:.3f}；{'价格已突破对应边界' if broken else '等待价格突破边界确认'}。",
            confirmed=broken,
            geometry=drawing(
                cs,
                min(hs[0]["i"], ls[0]["i"]),
                n - 1,
                paths=[
                    ("上沿", [(hs[0]["i"], line_at(fh, hs[0]["i"])), (n - 1, hi)]),
                    ("下沿", [(ls[0]["i"], line_at(fl, ls[0]["i"])), (n - 1, lo)]),
                ],
            ),
            trigger=hi if direction_up else lo,
            stop=lo if direction_up else hi,
            target=hi + (hi - lo) if direction_up else max(0.0, lo - (hi - lo)),
        )
    if kind in ("flag", "pennant"):
        candidates = [
            (s, end, (cs[end]["c"] / cs[s]["c"] - 1) * 100)
            for end in range(max(6, n - 23), n - 4)
            for s in range(max(0, end - 17), max(0, end - 5))
        ]
        if not candidates:
            return None
        start, end, change = max(candidates, key=lambda p: abs(p[2]))
        if abs(change) < 9 or (change > 0) != rule["bull"]:
            return None
        segment = cs[end + 1 :]
        hi, lo = max(c["h"] for c in segment), min(c["l"] for c in segment)
        if not 4 <= len(segment) <= 22 or (hi - lo) / cs[end]["c"] * 100 > abs(change) * 0.55:
            return None
        if kind == "pennant":
            a, b = [p for p in highs if p["i"] > end], [p for p in lows if p["i"] > end]
            if (
                len(a) < 2
                or len(b) < 2
                or not (
                    fit([(p["i"], p["p"]) for p in a])["slope"]
                    < 0
                    < fit([(p["i"], p["p"]) for p in b])["slope"]
                )
            ):
                return None
        prior_segment = cs[end + 1 : -1]
        trigger = (
            max(c["h"] for c in prior_segment)
            if rule["bull"]
            else min(c["l"] for c in prior_segment)
        )
        broken = current > trigger if rule["bull"] else current < trigger
        height = abs(cs[end]["c"] - cs[start]["c"])
        return hit(
            n - 1,
            70,
            f"旗杆变化 {change:+.1f}%，随后 {len(segment)} 根整理；突破参考 {trigger:.3f}。",
            confirmed=broken,
            geometry=drawing(
                cs,
                start,
                n - 1,
                paths=[("旗杆", [(start, cs[start]["c"]), (end, cs[end]["c"])])]
                + (
                    [
                        (
                            "上沿",
                            [
                                (a[0]["i"], line_at(fit([(p["i"], p["p"]) for p in a]), a[0]["i"])),
                                (n - 1, line_at(fit([(p["i"], p["p"]) for p in a]), n - 1)),
                            ],
                        ),
                        (
                            "下沿",
                            [
                                (b[0]["i"], line_at(fit([(p["i"], p["p"]) for p in b]), b[0]["i"])),
                                (n - 1, line_at(fit([(p["i"], p["p"]) for p in b]), n - 1)),
                            ],
                        ),
                    ]
                    if kind == "pennant"
                    else [
                        ("上沿", [(end + 1, hi), (n - 1, hi)]),
                        ("下沿", [(end + 1, lo), (n - 1, lo)]),
                    ]
                ),
            ),
            trigger=trigger,
            stop=lo if rule["bull"] else hi,
            target=trigger + height if rule["bull"] else max(0.0, trigger - height),
        )
    if kind == "rounding":
        segment = cs[-60:]
        if len(segment) < 30:
            return None
        # Quadratic coefficient from centered least squares, without a new numeric dependency.
        xs = [i - (len(segment) - 1) / 2 for i in range(len(segment))]
        ys = [c["c"] for c in segment]
        x2mean, ymean = mean(x * x for x in xs), mean(ys)
        a = sum((x * x - x2mean) * (y - ymean) for x, y in zip(xs, ys, strict=True)) / sum(
            (x * x - x2mean) ** 2 for x in xs
        )
        b = sum(x * y for x, y in zip(xs, ys, strict=True)) / sum(x * x for x in xs)
        fitted = [ymean + a * (x * x - x2mean) + b * x for x in xs]
        total = sum((y - ymean) ** 2 for y in ys)
        r2 = 1 - sum((y - f) ** 2 for y, f in zip(ys, fitted, strict=True)) / total if total else 0
        vertex = -b / (2 * a) if a else float("inf")
        before = prior(cs, n - len(segment), 30)
        if (
            r2 < 0.55
            or not (xs[0] < vertex < xs[-1])
            or not (a < 0 and before > 2 if top else a > 0 and before < -2)
        ):
            return None
        return hit(
            n - 1,
            50 + r2 * 30,
            f"近 {len(segment)} 根二次拟合 R²={r2:.2f}，曲线拐点位于窗口内，等待边界突破。",
            confirmed=False,
            geometry=drawing(
                cs,
                n - len(segment),
                n - 1,
                paths=[("拟合曲线", list(enumerate(fitted, n - len(segment))))],
            ),
        )
    if kind in ("spike", "v_reversal"):
        segment = range(max(0, n - 30), n - 2)
        anchor = (max if top else min)(segment, key=lambda i: cs[i]["h" if top else "l"])
        before, after = prior(cs, anchor, 12), slope_pct(cs, anchor, n - 1)
        if not (before > 10 and after < -8 if top else before < -10 and after > 8):
            return None
        return hit(
            n - 1,
            78,
            f"极值 {cs[anchor]['h' if top else 'l']:.3f} 前后趋势由 {before:+.1f}% 变为 {after:+.1f}%。",
            stop=cs[anchor]["h" if top else "l"],
            anchor=anchor,
            geometry=drawing(
                cs,
                max(0, anchor - 12),
                n - 1,
                paths=[
                    (
                        "反转结构",
                        [
                            (max(0, anchor - 12), cs[max(0, anchor - 12)]["c"]),
                            (anchor, cs[anchor]["h" if top else "l"]),
                            (n - 1, current),
                        ],
                    )
                ],
            ),
        )
    if kind == "cup_handle":
        start = max(0, n - 90)
        hi_i = max(range(start, n - 6), key=lambda i: cs[i]["h"])
        low_i = min(range(hi_i + 1, n - 4), key=lambda i: cs[i]["l"]) if hi_i < n - 5 else hi_i
        if hi_i >= low_i:
            return None
        hi, lo = cs[hi_i]["h"], cs[low_i]["l"]
        right_i = max(range(low_i + 1, n - 2), key=lambda i: cs[i]["h"])
        right = cs[right_i]["h"]
        handle_low = min(c["l"] for c in cs[right_i + 1 :])
        if not (
            0.12 <= (hi - lo) / hi <= 0.55
            and right >= hi * 0.9
            and 3 <= n - right_i <= 20
            and 0.03 <= (right - handle_low) / right <= 0.2
        ):
            return None
        return hit(
            n - 1,
            78,
            f"杯深 {(hi - lo) / hi * 100:.1f}%，柄部回撤 {(right - handle_low) / right * 100:.1f}%，突破参考 {right:.3f}。",
            confirmed=current > right,
            geometry=drawing(
                cs,
                hi_i,
                n - 1,
                paths=[
                    (
                        "杯柄结构",
                        [
                            (hi_i, hi),
                            (low_i, lo),
                            (right_i, right),
                            (min(range(right_i + 1, n), key=lambda i: cs[i]["l"]), handle_low),
                            (n - 1, current),
                        ],
                    )
                ],
            ),
            trigger=right,
            stop=handle_low,
            target=right + right - lo,
        )
    return None


def structure(cs, rule, swings):
    n, current = len(cs), cs[-1]["c"]
    highs, lows = swings["ph"], swings["pl"]
    kind = rule["type"]
    if kind == "swing":
        points = (lows if rule["up"] else highs)[-3:]
        if len(points) < 3 or not all(
            b["p"] > a["p"] * 1.005 if rule["up"] else b["p"] < a["p"] * 0.995
            for a, b in itertools.pairwise(points)
        ):
            return None
        confirmed = points[-1]["confirmedIndex"]
        return hit(
            confirmed,
            74,
            f"已确认的三个{'低' if rule['up'] else '高'}点：{' → '.join(format(p['p'], '.3f') for p in points)}。",
            stop=points[-2]["p"],
            anchor=points[-1]["i"],
            geometry=drawing(
                cs,
                points[0]["i"],
                confirmed,
                paths=[("趋势结构", [(p["i"], p["p"]) for p in points])],
            ),
        )
    if kind == "trendline":
        rising = rule["kind"] != "rebound_down"
        points = (lows if rising else highs)[-3:]
        if len(points) < 3 or not all(
            b["p"] > a["p"] if rising else b["p"] < a["p"] for a, b in itertools.pairwise(points)
        ):
            return None
        line = fit([(p["i"], p["p"]) for p in points])
        value = line_at(line, n - 1)
        if line["r2"] < 0.6 or value <= 0:
            return None
        if rule["kind"] == "break_up":
            ok = current < value * 0.995
        elif rising:
            ok = value * 0.995 <= current <= value * 1.03 and cs[-1]["l"] <= value * 1.015
        else:
            ok = value * 0.97 <= current <= value * 1.005 and cs[-1]["h"] >= value * 0.985
        if not ok:
            return None
        return hit(
            n - 1,
            65 + line["r2"] * 15,
            f"三个{'抬高低点' if rising else '降低高点'}拟合趋势线当前为 {value:.3f}，现价 {current:.3f}。",
            geometry=drawing(
                cs,
                points[0]["i"],
                n - 1,
                paths=[
                    ("趋势线", [(points[0]["i"], line_at(line, points[0]["i"])), (n - 1, value)])
                ],
            ),
            trigger=value,
            stop=value if rule["kind"] == "break_up" else points[-1]["p"],
        )
    if kind in ("polarity", "two_b"):
        for i in range(n - 1, max(25, n - 25) - 1, -1):
            previous = cs[i - 25 : i]
            hi, lo = max(c["h"] for c in previous), min(c["l"] for c in previous)
            if kind == "two_b" and cs[i]["h"] > hi * 1.002 and cs[i]["c"] < hi * 0.998:
                return hit(
                    i,
                    76,
                    f"盘中高点 {cs[i]['h']:.3f} 突破前高 {hi:.3f}，收盘 {cs[i]['c']:.3f} 回到前高下方。",
                    geometry=drawing(cs, i - 25, i, paths=[("前高", [(i - 25, hi), (i, hi)])]),
                    trigger=hi,
                    stop=cs[i]["h"],
                    target=lo,
                )
            if kind == "polarity":
                bullish = rule["to"] == "support"
                value = hi if bullish else lo
                if n - i < 4 or not (
                    cs[i]["c"] > value * 1.005 if bullish else cs[i]["c"] < value * 0.995
                ):
                    continue
                subsequent = cs[i + 1 :]
                held = all(
                    c["c"] >= value * 0.985 if bullish else c["c"] <= value * 1.015
                    for c in subsequent
                )
                retested = any(
                    c["l"] <= value * 1.02 if bullish else c["h"] >= value * 0.98
                    for c in subsequent
                )
                if held and retested:
                    return hit(
                        n - 1,
                        76,
                        f"{'前阻力转为支撑' if bullish else '前支撑转为阻力'} {value:.3f}；突破后已回测，收盘未反向失守。",
                        geometry=drawing(
                            cs,
                            i - 25,
                            n - 1,
                            paths=[("支撑阻力转换", [(i - 25, value), (n - 1, value)])],
                        ),
                        trigger=value,
                        stop=value,
                    )
    if kind == "rule123":
        if len(highs) < 3 or len(lows) < 2:
            return None
        a, b = lows[-2:]
        between = [p for p in highs if a["i"] < p["i"] < b["i"]]
        preceding = [p for p in highs if p["i"] < a["i"]][-3:]
        if (
            not between
            or len(preceding) < 2
            or b["p"] <= a["p"]
            or fit([(p["i"], p["p"]) for p in preceding])["slope"] >= 0
        ):
            return None
        trigger = max(p["p"] for p in between)
        return hit(
            n - 1,
            88 if current > trigger else 64,
            f"下降结构后回踩低点 {b['p']:.3f} 高于前低 {a['p']:.3f}；前高确认位 {trigger:.3f}。",
            confirmed=current > trigger,
            geometry=drawing(
                cs,
                preceding[0]["i"],
                n - 1,
                paths=[
                    (
                        "123结构",
                        [(p["i"], p["p"]) for p in sorted([a, b, *between], key=lambda p: p["i"])],
                    ),
                    ("原下降趋势", [(p["i"], p["p"]) for p in preceding]),
                ],
            ),
            trigger=trigger,
            stop=a["p"],
            target=trigger + trigger - a["p"],
        )
    return None


def recognize(cs, patterns):
    swings3, swings4 = pivots(cs, 3), pivots(cs, 4)
    output = []
    for pattern in patterns:
        rule, found = pattern["detect"], None
        kind = rule["type"]
        if kind in ("single", "two", "multi"):
            for i in range(len(cs) - 1, max(7, len(cs) - 13), -1):
                if candle_matches(cs, rule, i):
                    confidence = {"single": 66, "two": 70, "multi": 74}[kind] - (
                        len(cs) - 1 - i
                    ) * 2.2
                    found = hit(
                        i,
                        confidence,
                        f"{cs[i]['d']} 已收盘K线符合{pattern['name']}规则。",
                        geometry=drawing(
                            cs, i - ({"single": 1, "two": 2}.get(kind, rule.get("n", 3))) + 1, i
                        ),
                    )
                    break
        elif kind in ("gap", "island"):
            found = gap_hits(cs, rule)
        elif kind in ("swing", "trendline", "polarity", "rule123", "two_b"):
            found = structure(cs, rule, swings4)
        else:
            found = geometry(cs, rule, swings3)
        if found is None or found["conf"] < 52:
            continue
        at = found["at"]
        if len(cs) - 1 - at > 12:
            continue
        direction = pattern["dir"]
        signal = cs[at]
        if direction == "neutral":
            found.update(triggerPrice=None, stopPrice=None, targetPrice=None)
        if direction != "neutral":
            if found["triggerPrice"] is None:
                found["triggerPrice"] = signal["h"] if direction == "bull" else signal["l"]
            if found["stopPrice"] is None:
                found["stopPrice"] = signal["l"] if direction == "bull" else signal["h"]
        trigger, stop, target = (found[key] for key in ("triggerPrice", "stopPrice", "targetPrice"))
        if target is not None and target <= 0:
            target = found["targetPrice"] = None
        volumes = [c["v"] for c in cs[max(0, at - 20) : at]]
        ratio = (
            signal["v"] / mean(volumes)
            if len(volumes) == 20
            and all(v is not None for v in volumes)
            and mean(volumes) > 0
            and signal["v"] is not None
            else None
        )
        actual = dict(
            found,
            **{key: pattern[key] for key in ("id", "name", "en", "dir", "cat", "tag")},
            date=signal["d"],
            confirmedAt=signal["d"] if found["status"] == "confirmed" else None,
            fresh=len(cs) - 1 - at <= 5,
            scaled=False,
            adviceSource="structure",
            volumeConfirmed=ratio >= 1.2 if ratio is not None else None,
            buy=f"观察收盘突破 {trigger:.3f} 后的延续性。"
            if direction == "bull" and trigger
            else "等待结构确认，不给出追涨买点。",
            sell=f"观察收盘跌破 {trigger:.3f} 后的延续性。"
            if direction == "bear" and trigger
            else "若结构失效，重新评估。",
            stop=f"{'跌破' if direction == 'bull' else '突破'} {stop:.3f} 为结构失效参考。"
            if stop and direction != "neutral"
            else "中性形态暂无方向性止损位。",
            target=f"形态高度测量参考 {target:.3f}。"
            if target and target > 0
            else "当前结构暂无可测量目标。",
            vol_note=f"信号量为此前20周期均量 {ratio:.2f} 倍；量能仅用于辅助确认。"
            if ratio is not None
            else "成交量样本不足，量能确认不可计算。",
        )
        output.append(actual)
    # Suppress duplicates by family and category; the cap is a display contract.
    selected, buckets = [], {}
    for item in sorted(
        output, key=lambda p: (p["fresh"], p["status"] == "confirmed", p["conf"]), reverse=True
    ):
        bucket = (item["cat"], item["dir"])
        family = {"key_reversal_day": "spike_top", "hs_continuation": "hs_bottom"}.get(
            item["id"], item["id"]
        )
        if buckets.get(bucket, 0) < 2 and not any(p.get("_family") == family for p in selected):
            selected.append({**item, "_family": family})
            buckets[bucket] = buckets.get(bucket, 0) + 1
    return [{k: v for k, v in item.items() if k != "_family"} for item in selected[:9]]
