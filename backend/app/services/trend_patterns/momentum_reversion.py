# ruff: noqa: RUF001

"""Versioned descriptive rules over closed candles; scores are not probabilities."""

import math


def clip(value, low=0, high=1):
    return max(low, min(high, value))


def opportunity(env, metrics, score, delta, reversion, price):
    """Candidate observations; no position, execution or reward/risk assumptions."""
    pending = []
    code, title, tone = "wait", "等待确认，低吸条件不足", "neutral"
    reason = "环境或回归确认尚不充分，暂未形成低吸候选。"
    low = reversion["side"] == "low"
    recovering = reversion["state"] == "recovering" and reversion["started"]
    # A pullback below MA20 can retain an upward medium-term structure.
    medium_up = (
        metrics["ma20"] > metrics["ma60"] and metrics["slope"] > 0.25 and price > metrics["ma60"]
    )
    ready = low and recovering and reversion["score"] >= 70 and delta >= 5
    z = metrics["z20"]
    if env == "down":
        if low and recovering and delta > 0:
            code, title = "weak_rebound", "弱势反弹观察，低吸条件不足"
            reason = "低位回归开始且动量改善，但下跌环境仍未扭转。"
        else:
            code, title = "defend", "下跌防守，等待止跌"
            reason = "当前处于下跌环境，超跌或回归高分不足以确认低吸机会。"
        tone = "warning"
    elif reversion["state"] == "completed":
        code, title = "completed", "本次回归已完成，等待新机会"
        reason = "价格已穿过或接近均值，原回归过程不再作为低吸依据。"
    elif reversion["side"] == "high" and (
        (recovering and delta <= -5) or (z is not None and z >= 1.5 and delta <= -5)
    ):
        code, title, tone = "high_risk", "高位回落风险，谨慎追高", "warning"
        reason = "近期存在高位偏离，且动量正在减弱。"
    elif ready and env == "range":
        code, title, tone = "range_buy", "区间低吸候选", "candidate"
        reason = "震荡环境、低位回归确认、成熟度至少70分，且动量较3根前增强至少5分。"
    elif ready and medium_up:
        code, title, tone = "pullback", "顺势回调低吸候选", "candidate"
        reason = "MA20高于MA60且继续上行，价格守在MA60上方；低位回归确认，成熟度至少70分且动量增强至少5分。"
    elif z is not None and z >= 1.5:
        code, title, tone = "overheat", "短期偏热，谨慎追高", "warning"
        reason = "价格明显高于均值，但尚未同时出现动量减弱；偏热不等于趋势结束。"
    elif env == "up" and score >= 20:
        code, title = "trend", "趋势延续观察，等待回调"
        reason = "上涨环境且动量偏强，当前没有已确认的低位回归机会。"
    if code == "wait":
        if not low:
            pending.append("尚无有效低位偏离")
        elif not recovering:
            pending.append("价格与Z尚未同时向均值回升")
        elif reversion["score"] < 70:
            pending.append("回归成熟度尚未达到70分")
        if delta < 5:
            pending.append("动量较3根前尚未增强5分")
        if env != "range" and not medium_up:
            pending.append("尚未满足震荡环境或中期上行结构")
    return dict(
        version="opportunity-v1", code=code, title=title, tone=tone, reason=reason, pending=pending
    )


def analyze_momentum_reversion(cs, ind):
    result = dict(
        version="ammr-v1",
        status="insufficient",
        lastDate=cs[-1]["d"] if cs else None,
        environment="unknown",
        momentum=None,
        reversion=None,
        metrics={},
        issues=["至少需要65根已收盘K线"],
        interpretation="样本不足，暂不评分。",
        opportunity=None,
    )
    if len(cs) < 65:
        return result

    def metrics(i):
        c = cs[i]["c"]
        atr = ind["atr14"][i]
        m20, m60 = ind["ma"]["ma20"][i], ind["ma"]["ma60"][i]
        sigma = (ind["boll"]["up"][i] - ind["boll"]["dn"][i]) / 4
        travel = sum(abs(cs[j]["c"] - cs[j - 1]["c"]) for j in range(i - 19, i + 1))
        return dict(
            roc5=c / cs[i - 5]["c"] - 1,
            roc20=c / cs[i - 20]["c"] - 1,
            atr14=atr,
            ma20=m20,
            ma60=m60,
            slope=(m20 - ind["ma"]["ma20"][i - 5]) / atr if atr > 0 else 0,
            er20=abs(c - cs[i - 20]["c"]) / travel if travel else 0,
            z20=(c - m20) / sigma if sigma > 0 else None,
            macd=ind["macd"]["hist"][i],
            rsi14=ind["rsi"][i],
        )

    def momentum(i):
        m = metrics(i)
        flat = all(c["c"] == cs[0]["c"] for c in cs[: i + 1])
        if flat:
            return 0.0, dict.fromkeys(("roc20", "roc5", "macd", "rsi14", "slope"), 0.0)
        a = m["atr14"] / cs[i]["c"]
        if a <= 0:
            raise ValueError("ATR不足以计算动量")
        values = dict(
            roc20=(m["roc20"] / (2 * a * math.sqrt(20)), 30),
            roc5=(m["roc5"] / (2 * a * math.sqrt(5)), 20),
            macd=(m["macd"] / m["atr14"], 20),
            rsi14=((m["rsi14"] - 50) / 25, 15),
            slope=(m["slope"], 15),
        )
        parts = {k: round(clip(v, -1, 1) * w, 4) for k, (v, w) in values.items()}
        return round(sum(parts.values()), 1), parts

    try:
        i = len(cs) - 1
        m = metrics(i)
        score, parts = momentum(i)
        delta = round(score - momentum(i - 3)[0], 1)
        if not all(
            math.isfinite(v) for v in [score, delta, *[v for v in m.values() if v is not None]]
        ):
            raise ValueError("指标不可计算")
        c = cs[i]["c"]
        env = "unknown"
        if c > m["ma20"] > m["ma60"] and m["slope"] > 0.25:
            env = "up"
        elif c < m["ma20"] < m["ma60"] and m["slope"] < -0.25:
            env = "down"
        elif m["er20"] <= 0.3 and abs(m["ma20"] - m["ma60"]) <= m["atr14"]:
            env = "range"
        rev = dict(
            score=0.0,
            state="none",
            side="none",
            started=False,
            anchorDate=None,
            anchorZ=None,
            components=dict(deviation=0.0, recovery=0.0, turn=0.0),
            conditions=["暂无明显回归条件"],
        )
        candidates = [(j, metrics(j)["z20"]) for j in range(i - 4, i + 1)]
        candidates = [(j, z) for j, z in candidates if z is not None and abs(z) >= 1.5]
        if candidates and m["z20"] is not None:
            j, z = max(candidates, key=lambda pair: (abs(pair[1]), pair[0]))
            direction = 1 if z < 0 else -1
            rev.update(side="low" if z < 0 else "high", anchorDate=cs[j]["d"], anchorZ=z)
            if m["z20"] * z <= 0 or abs(m["z20"]) <= 0.25:
                rev.update(state="completed", conditions=["价格已穿过或接近均值，当前回归过程结束"])
            else:
                prev_z = metrics(i - 1)["z20"]
                started = (
                    prev_z is not None
                    and direction * (c - cs[i - 1]["c"]) > 0
                    and direction * (m["z20"] - prev_z) > 0
                )
                contributions = dict(
                    deviation=40 * clip((abs(z) - 1) / 1.5),
                    recovery=35 * clip((abs(z) - abs(m["z20"])) / abs(z)),
                    turn=25 * clip(direction * delta / 30),
                )
                total = sum(contributions.values())
                rev.update(
                    score=round(total if started else min(39, total), 1),
                    state="recovering" if started else "deviation",
                    started=started,
                    components={k: round(v, 4) for k, v in contributions.items()},
                    conditions=[
                        ("价格与Z均向均值移动" if started else "尚未同时满足价格与Z向均值移动"),
                        ("动量向回归方向改善" if direction * delta > 0 else "动量转向尚未确认"),
                    ],
                )
        labels = {
            "up": "上涨环境，优先观察趋势延续及回调过程。",
            "down": "下跌环境，偏离较大不代表已经止跌，优先防守观察。",
            "range": "震荡环境，结合偏离与回归确认观察区间变化。",
            "unknown": "方向不明确，保留观察，等待条件改善。",
        }
        side_text = {"low": "低位回升", "high": "高位回落", "none": "均值回归"}[rev["side"]]
        state_text = {
            "none": "暂无明显条件",
            "completed": "本次回归已完成",
            "recovering": "已开始改善",
            "deviation": "仅有偏离，尚待确认",
        }[rev["state"]]
        result.update(
            status="ok",
            environment=env,
            issues=[],
            metrics=m,
            momentum=dict(
                score=score,
                delta=delta,
                components=parts,
                direction="strong" if score >= 20 else "weak" if score <= -20 else "neutral",
                change="增强" if delta >= 5 else "减弱" if delta <= -5 else "基本稳定",
            ),
            reversion=rev,
            opportunity=opportunity(env, m, score, delta, rev, c),
            interpretation=labels[env] + side_text + "：" + state_text + "。",
        )
    except (ValueError, TypeError, ZeroDivisionError, KeyError, OverflowError):
        result.update(
            status="unavailable",
            issues=["必要指标不可计算"],
            interpretation="必要指标不可计算，暂不评分。",
        )
    return result
