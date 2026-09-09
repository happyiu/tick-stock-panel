"""艾略特波浪研究评估服务。

首版只接收详情页提交的点时 K 线快照，不读取未来数据，也不把 AI 输出当作
交易信号。公开结果沿用参考工作流的主计数、备选计数、硬规则和观察边界，
并由服务端强制 research-only 安全常量。
"""
# ruff: noqa: RUF001, RUF002
from __future__ import annotations

import json
import math
import uuid
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.services.ai_provider import generate_ai_text

ElliottPeriod = Literal["30m", "1d", "1w", "1mo"]
ElliottFamily = Literal[
    "impulse",
    "leading_diagonal",
    "ending_diagonal",
    "zigzag",
    "flat",
    "triangle",
    "combination",
    "unknown",
]
ElliottDirection = Literal["up", "down", "sideways", "mixed"]


class ElliottBar(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)

    date: str = Field(min_length=1)
    open: float
    high: float
    low: float
    close: float
    volume: float | None = None


class ElliottAnalyzeRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    symbol: str = Field(min_length=1, max_length=64)
    period: ElliottPeriod
    as_of: str = Field(min_length=1, max_length=64)
    price_basis: str = Field(default="前复权", max_length=64)
    bars: list[ElliottBar] = Field(min_length=1, max_length=300)
    local_analysis: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_bars(self) -> ElliottAnalyzeRequest:
        scoped = [bar for bar in self.bars if bar.date <= self.as_of]
        valid = [
            bar
            for bar in scoped
            if all(math.isfinite(value) for value in (bar.open, bar.high, bar.low, bar.close))
            and bar.open > 0
            and bar.close > 0
            and bar.low > 0
            and bar.high >= max(bar.open, bar.close)
            and bar.low <= min(bar.open, bar.close)
            and (bar.volume is None or (math.isfinite(bar.volume) and bar.volume >= 0))
        ]
        if scoped and len(scoped) - len(valid) > len(scoped) * 0.1:
            raise ValueError("无效行情超过样本的 10%")
        if len(valid) < 20:
            raise ValueError("截至 as_of 至少需要 20 根有效 K 线")
        self.bars = sorted(valid, key=lambda bar: bar.date)[-300:]
        return self


class ElliottPivot(BaseModel):
    model_config = ConfigDict(extra="ignore")

    label: str
    event_time: str | None = None
    confirmed_at: str | None = None
    available_at: str | None = None
    price: float | None = None
    state: Literal["observed", "suspected", "projected"]


class ElliottCount(BaseModel):
    model_config = ConfigDict(extra="ignore")

    label: str
    degree: str
    family: ElliottFamily
    direction: ElliottDirection
    stage: str
    pivots: list[ElliottPivot] = Field(default_factory=list)
    support_summary: list[str] = Field(default_factory=list)
    confirmation: list[str] = Field(default_factory=list)
    invalidation: list[str] = Field(default_factory=list)
    recount_conditions: list[str] = Field(default_factory=list)
    next_observation: list[str] = Field(default_factory=list)


class ElliottRuleCheck(BaseModel):
    model_config = ConfigDict(extra="ignore")

    rule_id: str
    family: str
    result: Literal["pass", "fail", "unknown", "not_applicable"]
    evidence: str
    source_layer: Literal["original", "modern_formalization", "later_interpretation", "engine_safety"]


class ElliottEvidence(BaseModel):
    model_config = ConfigDict(extra="ignore")

    family: Literal[
        "structure",
        "alternation",
        "proportionality",
        "fibonacci",
        "channel",
        "momentum",
        "volume",
        "multi_timeframe",
    ]
    result: Literal["supports", "conflicts", "neutral", "unavailable"]
    observation: str
    dependency_group: str
    weight: str | float | None = None


class ElliottDataQuality(BaseModel):
    model_config = ConfigDict(extra="ignore")

    status: Literal["sufficient", "limited", "blocked"]
    missing: list[str] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)


class ElliottAssessment(BaseModel):
    model_config = ConfigDict(extra="ignore")

    schema: Literal["elliott.assessment.public.v1"] = "elliott.assessment.public.v1"
    assessment_id: str = Field(min_length=1)
    instrument: str = Field(min_length=1)
    market: str = "A-share"
    timeframe: str = Field(min_length=1)
    as_of: str = Field(min_length=1)
    available_at: str = Field(min_length=1)
    price_basis: str = "前复权"
    definition_mode: Literal["swing_proxy", "structure_proxy", "untradable_unclear"]
    data_quality: ElliottDataQuality
    primary_count: ElliottCount
    alternate_counts: list[ElliottCount] = Field(default_factory=list)
    hard_rule_checks: list[ElliottRuleCheck] = Field(default_factory=list)
    guideline_evidence: list[ElliottEvidence] = Field(default_factory=list)
    fibonacci_relationships: list[ElliottEvidence] = Field(default_factory=list)
    channel_checks: list[ElliottEvidence] = Field(default_factory=list)
    momentum_volume_evidence: list[ElliottEvidence] = Field(default_factory=list)
    ambiguity: Literal["none", "multiple_viable", "unresolved"]
    approximation_loss: list[str] = Field(default_factory=list)
    confirmation: list[str] = Field(default_factory=list)
    invalidation: list[str] = Field(default_factory=list)
    recount_conditions: list[str] = Field(default_factory=list)
    next_observation: list[str] = Field(min_length=1)
    research_only: Literal[True] = True
    broker_connection_enabled: Literal[False] = False
    automatic_orders: Literal[False] = False
    order_authorized: Literal[False] = False
    status: Literal["DRAFT_REVIEW"] = "DRAFT_REVIEW"
    ic_pass: Literal[False] = False
    allowed_action: Literal["observe"] = "observe"
    suggested_shares: Literal[0] = 0


class ElliottAssessmentError(ValueError):
    """AI 返回无法修复的评估结构。"""


class ElliottExplanation(BaseModel):
    model_config = ConfigDict(extra="ignore")

    schema: Literal["elliott.explanation.public.v1"] = "elliott.explanation.public.v1"
    explanation_id: str = Field(min_length=1)
    instrument: str = Field(min_length=1)
    timeframe: ElliottPeriod
    as_of: str = Field(min_length=1)
    summary: str = ""
    evidence_refs: list[str] = Field(default_factory=list, max_length=12)
    disagreements: list[str] = Field(default_factory=list, max_length=8)
    limitations: list[str] = Field(default_factory=list, max_length=8)
    confirmation: list[str] = Field(default_factory=list, max_length=8)
    invalidation: list[str] = Field(default_factory=list, max_length=8)
    recount_conditions: list[str] = Field(default_factory=list, max_length=8)
    next_observation: list[str] = Field(default_factory=list, max_length=8)
    source_refs: list[str] = Field(default_factory=list, max_length=12)
    research_only: Literal[True] = True


_EXPLANATION_BLOCKED_TERMS = (
    "买入", "卖出", "减仓", "加仓", "仓位", "下单", "订单", "交易动作",
    "概率", "胜率", "目标价", "支撑位", "阻力位", "止损", "止盈", "价格边界",
)


_EXPLANATION_SYSTEM_PROMPT = """你是一个只做研究记录的艾略特波浪解释器。输入中的 local_analysis 是确定性引擎已经生成的事实。
只返回 JSON，不要输出 Markdown、代码围栏或交易建议。

规则：
1. local_analysis 是确定性引擎计算出的候选和证据。可以在已有的 primaryCount、alternateCounts 候选中判断当前更支持的类型（family）；没有可用候选或证据不足时必须写“无法确定”。不得创造新类型、新候选或改写本地计数和硬规则。
2. summary 必须明确写出“AI判断类型：...”或“AI判断类型：无法确定”，并用已有证据说明支持、冲突和限制；这只是对本地候选的解释性佐证，不改变 primaryCount、alternateCounts 或 hardRuleChecks。
3. 只能引用 local_analysis 中已有的 evidence id 和 source_refs；不得编造引用。
4. 只能解释主计数、备选、硬规则结果、独立证据、歧义和限制。
5. 不得输出概率、胜率、买入、减仓、卖出、仓位或订单动作。
6. 不得使用 as_of 之后的数据；多周期证据保持不可用。
7. 输出键必须为：
schema, explanation_id, instrument, timeframe, as_of, summary, evidence_refs,
disagreements, limitations, confirmation, invalidation, recount_conditions,
next_observation, source_refs, research_only。
8. research_only 必须为 true。
"""


_SYSTEM_PROMPT = """你是一个只做研究记录的艾略特波浪结构分析器。请基于给定的点时 OHLCV 和本地摆动代理，生成一个 JSON 对象，不要输出 Markdown、代码围栏或交易建议。

要求：
1. 先冻结 instrument、timeframe、as_of、available_at 和价格口径；不能使用 as_of 之后的数据。
2. 保留一个 primary_count，最多两个 alternate_counts。主计数是当前最有支持的假设，不是确定结论。
3. 对每个候选先检查普通推动浪硬规则：二浪不得越过一浪起点，三浪不得是 1/3/5 中最短，四浪不得进入一浪价格区间；内部子浪不足时写 unknown，不能写 pass。
4. 硬规则失败不能由斐波那契、通道、动能或成交量证据挽救；这些证据必须分开记录，不能合成一个分数。
5. projected 拐点不能伪装成 observed；明确写出确认、失效、重计数条件和下一观察点。
6. 首版只分析当前周期，多周期证据 unavailable；definition_mode 只能是 swing_proxy、structure_proxy 或 untradable_unclear，不能使用 strict_elliott。
7. 输出必须包含以下键：
schema, assessment_id, instrument, market, timeframe, as_of, available_at, price_basis,
definition_mode, data_quality, primary_count, alternate_counts, hard_rule_checks,
guideline_evidence, fibonacci_relationships, channel_checks, momentum_volume_evidence,
ambiguity, approximation_loss, confirmation, invalidation, recount_conditions,
next_observation, research_only, broker_connection_enabled, automatic_orders,
order_authorized, status, ic_pass, allowed_action, suggested_shares。
8. 安全常量必须固定为：research_only=true、broker_connection_enabled=false、automatic_orders=false、order_authorized=false、status=DRAFT_REVIEW、ic_pass=false、allowed_action=observe、suggested_shares=0。
"""


def _json_object(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    if "```" in cleaned:
        cleaned = cleaned.replace("```json", "").replace("```", "").strip()
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start < 0 or end <= start:
        raise ElliottAssessmentError("AI 未返回 JSON 对象")
    try:
        value = json.loads(cleaned[start : end + 1])
    except json.JSONDecodeError as exc:
        raise ElliottAssessmentError(f"AI JSON 解析失败: {exc.msg}") from exc
    if not isinstance(value, dict):
        raise ElliottAssessmentError("AI 返回的顶层结构不是对象")
    return value


def _prompt(req: ElliottAnalyzeRequest, *, repair: str | None = None) -> list[dict[str, str]]:
    user = {
        "symbol": req.symbol,
        "period": req.period,
        "as_of": req.as_of,
        "price_basis": req.price_basis,
        "bars": [bar.model_dump() for bar in req.bars],
        "local_analysis": req.local_analysis,
    }
    if repair:
        user = {
            "original_invalid_output": repair,
            "repair_instruction": "只返回符合要求的完整 JSON；不得删掉 required 字段，不得输出 Markdown。",
            **user,
        }
    return [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {"role": "user", "content": json.dumps(user, ensure_ascii=False, separators=(",", ":"))},
    ]


def _enforce_safety(payload: dict[str, Any], req: ElliottAnalyzeRequest) -> ElliottAssessment:
    normalized = dict(payload)
    normalized["schema"] = "elliott.assessment.public.v1"
    normalized["assessment_id"] = str(normalized.get("assessment_id") or f"elliott-{uuid.uuid4().hex[:12]}")
    normalized["instrument"] = req.symbol
    normalized["timeframe"] = req.period
    normalized["as_of"] = req.as_of
    available_at = normalized.get("available_at")
    # AI 可能把“确认时间”误写成未来时间; 服务端不允许评估越过快照边界。
    normalized["available_at"] = available_at if isinstance(available_at, str) and available_at <= req.as_of else req.as_of
    normalized["price_basis"] = req.price_basis
    if normalized.get("definition_mode") == "strict_elliott":
        normalized["definition_mode"] = "structure_proxy"
    if normalized.get("definition_mode") not in {"swing_proxy", "structure_proxy", "untradable_unclear"}:
        normalized["definition_mode"] = "untradable_unclear"
    normalized["primary_count"] = _sanitize_count(normalized.get("primary_count"), req.as_of)
    normalized["alternate_counts"] = [
        _sanitize_count(item, req.as_of)
        for item in list(normalized.get("alternate_counts") or [])[:2]
    ]
    for key in (
        "guideline_evidence",
        "fibonacci_relationships",
        "channel_checks",
        "momentum_volume_evidence",
    ):
        normalized[key] = _sanitize_evidence(normalized.get(key))
    normalized.update({
        "research_only": True,
        "broker_connection_enabled": False,
        "automatic_orders": False,
        "order_authorized": False,
        "status": "DRAFT_REVIEW",
        "ic_pass": False,
        "allowed_action": "observe",
        "suggested_shares": 0,
    })
    normalized.setdefault("market", "A-share")
    normalized.setdefault("approximation_loss", ["首版仅使用当前周期，未验证多级别递归"])
    return ElliottAssessment.model_validate(normalized)


def _sanitize_count(value: Any, as_of: str) -> Any:
    """裁剪 AI 计数中的未来拐点，并保持拐点按事件时间排序。"""
    if not isinstance(value, dict):
        return value
    count = dict(value)
    pivots: list[dict[str, Any]] = []
    for raw in count.get("pivots") or []:
        if not isinstance(raw, dict):
            continue
        pivot = dict(raw)
        event_time = pivot.get("event_time")
        if isinstance(event_time, str) and event_time > as_of:
            continue
        for key in ("confirmed_at", "available_at"):
            timestamp = pivot.get(key)
            if isinstance(timestamp, str) and timestamp > as_of:
                pivot[key] = None
        price = pivot.get("price")
        if price is not None:
            try:
                numeric_price = float(price)
            except (TypeError, ValueError):
                continue
            if not math.isfinite(numeric_price):
                continue
            pivot["price"] = numeric_price
        pivots.append(pivot)
    pivots.sort(key=lambda item: item.get("event_time") or "")
    count["pivots"] = pivots
    return count


def _sanitize_evidence(value: Any) -> Any:
    if not isinstance(value, list):
        return value
    result: list[dict[str, Any]] = []
    for raw in value:
        if not isinstance(raw, dict):
            continue
        item = dict(raw)
        if item.get("family") == "multi_timeframe":
            item["result"] = "unavailable"
            item["observation"] = "首版仅分析当前周期，多周期证据不可用"
            item["weight"] = None
        result.append(item)
    return result


async def analyze_elliott(req: ElliottAnalyzeRequest) -> ElliottAssessment:
    """调用当前 AI Provider 生成并校验一份研究评估。"""
    raw = await generate_ai_text(_prompt(req), temperature=0.2, max_tokens=None)
    try:
        return _enforce_safety(_json_object(raw), req)
    except (ElliottAssessmentError, ValueError) as first_error:
        repair_prompt = (
            f"首次输出校验失败：{first_error}\n"
            f"首次输出如下：\n{raw[:12000]}"
        )
        repaired = await generate_ai_text(_prompt(req, repair=repair_prompt), temperature=0.0, max_tokens=None)
        try:
            return _enforce_safety(_json_object(repaired), req)
        except (ElliottAssessmentError, ValueError) as second_error:
            raise ElliottAssessmentError(f"AI 输出连续两次不符合评估契约: {second_error}") from second_error


def _string_list(value: Any, limit: int = 8) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item.strip() for item in value if isinstance(item, str) and item.strip()][:limit]


def _safe_explanation_text(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    text = value.strip()
    return "" if any(term in text for term in _EXPLANATION_BLOCKED_TERMS) else text


def _safe_explanation_list(value: Any, limit: int = 8) -> list[str]:
    return [text for item in _string_list(value, limit) if (text := _safe_explanation_text(item))]


def _local_evidence_ids(local_analysis: dict[str, Any]) -> set[str]:
    result: set[str] = set()
    for key in (
        "guidelineEvidence",
        "fibonacciRelationships",
        "channelChecks",
        "momentumVolumeEvidence",
        "guideline_evidence",
        "fibonacci_relationships",
        "channel_checks",
        "momentum_volume_evidence",
    ):
        values = local_analysis.get(key)
        if not isinstance(values, list):
            continue
        for item in values:
            if isinstance(item, dict) and isinstance(item.get("id"), str):
                result.add(item["id"])
    return result


def _local_source_refs(local_analysis: dict[str, Any]) -> set[str]:
    refs = local_analysis.get("sourceRefs", local_analysis.get("source_refs"))
    return {item for item in refs if isinstance(item, str)} if isinstance(refs, list) else set()


def _explanation_prompt(req: ElliottAnalyzeRequest, *, repair: str | None = None) -> list[dict[str, str]]:
    user: dict[str, Any] = {
        "symbol": req.symbol,
        "period": req.period,
        "as_of": req.as_of,
        "price_basis": req.price_basis,
        "local_analysis": req.local_analysis,
    }
    if repair:
        user = {
            "original_invalid_output": repair,
            "repair_instruction": "只返回符合要求的完整 JSON；不得输出计数、规则、价格边界或交易动作。",
            **user,
        }
    return [
        {"role": "system", "content": _EXPLANATION_SYSTEM_PROMPT},
        {"role": "user", "content": json.dumps(user, ensure_ascii=False, separators=(",", ":"))},
    ]


def _enforce_explanation_safety(payload: dict[str, Any], req: ElliottAnalyzeRequest) -> ElliottExplanation:
    local_evidence = _local_evidence_ids(req.local_analysis)
    local_sources = _local_source_refs(req.local_analysis)
    normalized = {
        "schema": "elliott.explanation.public.v1",
        "explanation_id": str(payload.get("explanation_id") or f"explanation-{uuid.uuid4().hex[:12]}"),
        "instrument": req.symbol,
        "timeframe": req.period,
        "as_of": req.as_of,
        "summary": _safe_explanation_text(payload.get("summary")),
        "evidence_refs": [item for item in _string_list(payload.get("evidence_refs"), 12) if item in local_evidence],
        "disagreements": _safe_explanation_list(payload.get("disagreements")),
        "limitations": _safe_explanation_list(payload.get("limitations")),
        "confirmation": _safe_explanation_list(payload.get("confirmation")),
        "invalidation": _safe_explanation_list(payload.get("invalidation")),
        "recount_conditions": _safe_explanation_list(payload.get("recount_conditions")),
        "next_observation": _safe_explanation_list(payload.get("next_observation")),
        "source_refs": [item for item in _string_list(payload.get("source_refs"), 12) if item in local_sources],
        "research_only": True,
    }
    if not normalized["summary"]:
        normalized["summary"] = "AI 未提供可用解释；请以本地确定性计数和证据为准。"
    return ElliottExplanation.model_validate(normalized)


async def explain_elliott(req: ElliottAnalyzeRequest) -> ElliottExplanation:
    """只解释本地确定性评估，不允许 AI 生成新的计数事实。"""
    raw = await generate_ai_text(_explanation_prompt(req), temperature=0.2, max_tokens=None)
    try:
        return _enforce_explanation_safety(_json_object(raw), req)
    except (ElliottAssessmentError, ValueError) as first_error:
        repair_prompt = f"首次输出校验失败：{first_error}\n首次输出如下：\n{raw[:12000]}"
        repaired = await generate_ai_text(
            _explanation_prompt(req, repair=repair_prompt),
            temperature=0.0,
            max_tokens=None,
        )
        try:
            return _enforce_explanation_safety(_json_object(repaired), req)
        except (ElliottAssessmentError, ValueError) as second_error:
            raise ElliottAssessmentError(f"AI 解释连续两次不符合解释契约: {second_error}") from second_error
