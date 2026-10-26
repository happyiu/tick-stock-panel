"""Display observations from official structures; no additional Chan engine."""

# ruff: noqa: RUF001
from __future__ import annotations


def _price(value):
    return f"{value:.4f}".rstrip("0").rstrip(".")


def _condition(key, text, state="waiting", warning=False):
    return {"id": key, "text": text, "state": state, "warning": warning}


def build_interpretation(analysis):
    """Only closed candles may advance the display phase, including in live views."""
    closed = [b for b in analysis["bars"] if b["isClosed"]]
    center = analysis["latestCenter"]
    result = {
        "version": 1,
        "ruleSource": "project",
        "asOf": closed[-1]["periodEnd"] if closed else None,
        "closedPrice": closed[-1]["close"] if closed else None,
        "phase": {
            "key": "insufficient", "label": "结构不足", "subtitle": "等待中枢",
            "description": "尚未形成至少三笔构成的有效中枢，先观察后续分型与笔。",
        },
        "centerOrdinal": len(analysis["centers"]),
        "legs": [],
        "facts": [],
        "observation": {"title": "等待结构形成", "conditions": []},
        "levels": [],
    }
    if not center or not closed:
        return result

    close = closed[-1]["close"]
    upper, lower = center["zg"], center["zd"]
    side = "above" if close > upper else "below" if close < lower else "inside"
    returned = side == "inside" and any(
        b["periodEnd"] >= center["formedAt"] and (b["close"] > upper or b["close"] < lower)
        for b in closed
    )
    if side != "inside":
        up = side == "above"
        phase = {
            "key": "leaving", "label": "离开中枢", "subtitle": "向上离开" if up else "向下离开",
            "description": f"最近已闭合K线收盘 {_price(close)} 位于中枢{'上' if up else '下'}沿之外，后续回抽结构仍待观察。",
        }
    elif returned:
        phase = {
            "key": "oscillating", "label": "中枢震荡", "subtitle": "回到中枢",
            "description": "中枢形成后的已闭合K线曾收于区间外，最近收盘已回到区间内，继续观察震荡。",
        }
    elif center["componentCount"] > 3:
        phase = {
            "key": "oscillating", "label": "中枢震荡", "subtitle": "中枢延伸",
            "description": "官方中枢已包含三笔以上，最近已闭合K线收盘仍在核心重叠区间内。",
        }
    else:
        phase = {
            "key": "forming", "label": "中枢形成", "subtitle": "刚形成",
            "description": "三笔已产生有效的核心重叠区间，最近已闭合K线收盘位于区间内。",
        }
    result["phase"] = phase
    result["facts"] = [
        f"最新笔中枢由 {center['componentCount']} 笔组成，核心区间 {_price(lower)}—{_price(upper)}。",
        phase["description"],
    ]
    latest = analysis["latestConfirmedStroke"]
    if latest:
        result["facts"].append(
            f"最近完成的一笔向{'上' if latest['direction'] == 'up' else '下'}，"
            f"从 {_price(latest['startPrice'])} 至 {_price(latest['endPrice'])}。"
        )

    # a / b are actual adjacent pens, not reconstructed recursive trend legs.
    for label, indices in (
        ("a", [center["startStrokeIndex"] - 1]),
        ("b", list(range(center["endStrokeIndex"] + 1, len(analysis["strokes"])))),
    ):
        pens = [analysis["strokes"][i] for i in indices if 0 <= i < len(analysis["strokes"])]
        result["legs"].append({"label": label, "strokes": pens})

    if side == "inside":
        result["observation"] = {
            "title": "观察中枢边界与后续笔",
            "conditions": [
                _condition("upper", f"已闭合K线收盘高于上沿 {_price(upper)}，再观察向上离开。"),
                _condition("lower", f"已闭合K线收盘低于下沿 {_price(lower)}，再观察向下离开。"),
                _condition("pullback", "离开后观察反向笔的完成情况及回抽位置，再核对官方 B3 / S3 辅助信号。"),
            ],
        }
    else:
        up = side == "above"
        edge = upper if up else lower
        result["observation"] = {
            "title": "观察离开后的回抽",
            "conditions": [
                _condition("leave", phase["description"], "met"),
                _condition("pullback", f"等待后续{'回落' if up else '反弹'}笔完成，观察整个价格区间能否维持在{'上' if up else '下'}沿 {_price(edge)} {'之上' if up else '之下'}。"),
                _condition("return", f"若收盘回到 {_price(lower)}—{_price(upper)}，重新评估本次离开。", warning=True),
                _condition("signal", f"继续核对官方 {'B3' if up else 'S3'} 辅助信号；边界穿越本身不足以确认。"),
            ],
        }
    result["levels"] = [
        {"key": "upper", "label": "中枢上沿", "price": upper},
        {"key": "lower", "label": "中枢下沿", "price": lower},
    ]
    return result
