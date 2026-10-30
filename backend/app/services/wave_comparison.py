# ruff: noqa: RUF001
"""Explain why cross-period wave comparison is available or withheld."""

ADJUSTMENT_LABELS = {"forward": "前复权", "none": "不复权"}
PERIOD_LABELS = {"1d": "日线", "30m": "30分钟"}


def compare_periods(periods):
    reasons = []
    coverage = []
    for period, label in PERIOD_LABELS.items():
        result = periods.get(period, {})
        source = result.get("source", {})
        adjustment = source.get("adjustment")
        bars = result.get("dataCoverage", {}).get("bars", 0)
        coverage.append(
            dict(
                period=period,
                label=label,
                bars=bars,
                candidates=len(result.get("counts", [])),
                start=result.get("coverageStart"),
                end=result.get("dataThrough"),
                adjustment=ADJUSTMENT_LABELS.get(adjustment, "未知"),
                provider=source.get("provider"),
                stale=source.get("stale", False),
            )
        )
        status = result.get("status")
        if status == "unsupported":
            message = f"{label}暂不支持波浪分析"
        elif adjustment not in ADJUSTMENT_LABELS and source:
            message = f"{label}复权方式未知，暂不能对照"
        elif status == "invalid_data":
            message = f"{label}数据校验失败，暂不能对照"
        elif not result.get("dataThrough") or bars == 0:
            message = f"{label}没有可用的已收盘K线"
        elif source.get("stale"):
            message = f"{label}行情快照已过期，暂不能对照"
        elif not result.get("counts"):
            message = f"{label}已有{bars}根K线，暂未识别到有效浪形"
        else:
            continue
        reasons.append(message)
    a, b = (periods.get(p, {}) for p in PERIOD_LABELS)
    left, right = (r.get("source", {}).get("adjustment") for r in (a, b))
    mismatch = left in ADJUSTMENT_LABELS and right in ADJUSTMENT_LABELS and left != right
    if mismatch:
        reasons.append(
            f"日线为{ADJUSTMENT_LABELS[left]}，30分钟为{ADJUSTMENT_LABELS[right]}，暂不进行跨周期对照"
        )
    available = not reasons
    if reasons:
        summary = "；".join(reasons)
    else:
        summary = (
            "方向一致，嵌套关系待验证"
            if a["counts"][0]["direction"] == b["counts"][0]["direction"]
            else "周期方向不同，分别观察确认条件"
        )
    return dict(
        status="available" if available else "adjustment_mismatch" if mismatch else "unavailable",
        summary=summary,
        reasons=reasons,
        coverage=coverage,
    )
