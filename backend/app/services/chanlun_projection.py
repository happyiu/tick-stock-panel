"""Project conditional scenarios, inspired by chanL exploration, without forecasts."""
# ruff: noqa: RUF001
from __future__ import annotations

import math

from app.services.chanlun_interpretation import _price


def build_projection(analysis):
    closed = [b for b in analysis["bars"] if b["isClosed"]]
    last = closed[-1] if closed else None
    result = {"version": 1, "ruleSource": "project", "status": "insufficient", "anchor": None,
              "center": None, "zones": [], "branches": [], "side": None,
              "description": "虚线为结构条件示意，不表示目标价、发生概率或预计到达时间。"}
    if not last:
        return result
    result["anchor"] = {"date": last["date"], "availableDate": last["periodEnd"], "price": last["close"]}
    centers = sorted((c for c in analysis["centers"]
                      if c["formedAt"] <= last["periodEnd"] and c["endDate"] <= last["periodEnd"]
                      and all(math.isfinite(c[k]) and c[k] > 0 for k in ("zd", "zg")) and c["zd"] <= c["zg"]),
                     key=lambda c: (c["endDate"], c["formedAt"]))
    if not centers:
        return result
    center = centers[-1]
    upper, lower = center["zg"], center["zd"]
    above = sorted((c for c in centers[:-1] if c["zd"] > upper), key=lambda c: c["zd"])
    below = sorted((c for c in centers[:-1] if c["zg"] < lower), key=lambda c: -c["zg"])
    zones = [("current", "当前中枢", center)]
    if above:
        zones.append(("upper", "上方中枢", above[0]))
    if below:
        zones.append(("lower", "下方中枢", below[0]))
    result["zones"] = [{"kind": kind, "label": label, "centerId": c["id"], "zd": c["zd"], "zg": c["zg"],
                        "formedAt": c["formedAt"]} for kind, label, c in zones]
    result["center"] = result["zones"][0]
    side = "above" if last["close"] > upper else "below" if last["close"] < lower else "inside"
    result.update(status="ready", side=side)
    upper_text, lower_text = _price(upper), _price(lower)
    if side == "inside":
        branches = [
            ("向上离开", "upper", f"已闭合K线收盘高于上沿 {upper_text}，随后回调结构仍保持在上沿之外。", "再核对完成笔及官方 B3 辅助条件；越过边界本身不确认三买。"),
            ("向下离开", "lower", f"已闭合K线收盘低于下沿 {lower_text}，随后反弹结构仍保持在下沿之外。", "再核对完成笔及官方 S3 辅助条件；跌破边界本身不确认三卖。"),
            ("继续震荡", "middle", f"已闭合K线继续在 {lower_text}—{upper_text} 之间往返。", "观察中枢延伸，等待后续离开及回抽结构。"),
        ]
    else:
        up = side == "above"
        hold = ("回抽未回", "upper", f"后续回落笔完成，整个回抽区间保持在上沿 {upper_text} 之上，随后向上。", "核对官方 B3 辅助条件及笔完成情况；未作次级别联立确认。") if up else (
            "反弹未回", "lower", f"后续反弹笔完成，整个反弹区间保持在下沿 {lower_text} 之下，随后向下。", "核对官方 S3 辅助条件及笔完成情况；未作次级别联立确认。")
        returned = ("回到中枢", "middle", f"后续已闭合K线收盘回到 {lower_text}—{upper_text} 区间。", "离开未能保持，重新观察中枢震荡。")
        power = ("新高力度观察" if up else "新低力度观察", "upper" if up else "lower",
                 f"继续创出{'新高' if up else '新低'}时，核对官方 MACD 背驰观察是否出现{'空头' if up else '多头'}条件。",
                 "仅为官方 MACD12/26/9 条件观察，不能直接确认严格趋势背驰或反转。")
        branches = [hold, returned, power] if up else [returned, hold, power]
    result["branches"] = [{"id": i + 1, "label": label, "target": target, "condition": condition, "meaning": meaning,
                           **({"rule": {"function": "tas_macd_bc_V230804", "params": {"di": 1}}} if side != "inside" and i == 2 else {})}
                          for i, (label, target, condition, meaning) in enumerate(branches)]
    return result
