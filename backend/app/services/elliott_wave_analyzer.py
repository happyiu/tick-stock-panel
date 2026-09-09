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


class ElliottExplanationVerdict(BaseModel):
    model_config = ConfigDict(extra="ignore")

    candidate_id: str = ""
    label: str = "无法确定"
    structure_family: str = "无法确定"
    direction: str = "无法确定"
    current_wave: str = "无法确定"
    phase: str = "无法确定"
    plain_text: str = "无法确定"


class ElliottPrimaryScenario(BaseModel):
    model_config = ConfigDict(extra="ignore")

    candidate_id: str = ""
    current_structure: str = ""
    current_wave: str = "无法确定"
    interpretation: str = ""
    next_expected: str = ""
    supporting_reasons: list[str] = Field(default_factory=list, max_length=8)


class ElliottAlternateScenario(BaseModel):
    model_config = ConfigDict(extra="ignore")

    candidate_id: str = ""
    scenario: str = ""
    interpretation: str = ""
    difference_from_primary: str = ""
    becomes_more_likely_if: str = ""


class ElliottExplanation(BaseModel):
    model_config = ConfigDict(extra="ignore")

    schema: Literal["elliott.explanation.public.v2"] = "elliott.explanation.public.v2"
    explanation_id: str = Field(min_length=1)
    instrument: str = Field(min_length=1)
    timeframe: ElliottPeriod
    as_of: str = Field(min_length=1)
    verdict: ElliottExplanationVerdict = Field(default_factory=ElliottExplanationVerdict)
    summary: str = ""
    primary_scenario: ElliottPrimaryScenario | None = None
    alternate_scenarios: list[ElliottAlternateScenario] = Field(default_factory=list, max_length=2)
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


_EXPLANATION_SYSTEM_PROMPT = """你是一个“艾略特波浪结构路径解释器”，只做研究记录。

输入中的 local_analysis 来自确定性艾略特波浪引擎。primaryCount、alternateCounts、rank、rankingBasis、wavePath、currentWave、stage、hardRuleChecks、证据和观察边界都是事实。

你的任务不是重新数浪，而是把本地候选翻译成普通投资者容易理解的结构路径：当前是什么结构、当前更支持哪一浪、该浪属于上涨/下跌/调整、如果主计数继续成立接下来观察什么、有哪些备选以及什么条件会使主备判断切换。

严格规则：
1. 候选名次由确定性引擎决定。rank=1 的 primaryCount 是唯一主判断；rank=2、rank=3 的 alternateCounts 才能作为备选。不得改排名、创造候选或修改本地计数、硬规则和证据。
2. candidate_id 必须来自对应本地候选；primary_scenario 必须引用 rank=1，alternate_scenarios 只能引用 rank=2/3。没有可用主候选时，verdict 和 summary 必须明确写“无法确定”，primary_scenario 为 null。
3. current_wave、wavePath/current_wave、structure_family/direction 必须与对应本地候选一致。local_analysis 只有 C 浪时不得扩展成 C3；没有 parentWave/subWave 时不得自行补出子浪。推动结构使用 1、2、3、4、5，调整结构使用 A、B、C，不得创造第 6 浪。
4. phase 只能依据本地 stage、确认状态和已有证据判断；证据不足时写“无法确定”。
5. 必须先给结论再解释原因。summary 用 2～4 句话直接说明“AI判断：……”，不要以 evidence id 开头。证据编号放入 evidence_refs。
6. primary_scenario 要说明当前结构、当前位置、解释、后续结构路径和支持原因。next_expected 是结构观察，不是价格预测。
7. 每个 alternate_scenario 要说明它认为当前是什么浪、与主方案的主要差异，以及什么已有条件出现后其重要性会上升；不要只返回候选名称。
8. confirmation、invalidation、recount_conditions、next_observation 只能改写 local_analysis 已有的条件、硬规则和关键结构点，不得自行创造价格边界。
9. 不得自行编造概率、胜率、分数含义、目标价、支撑位、阻力位、止损、止盈或任何买卖/仓位/订单动作。rank 只是名次，不是概率；只能说“当前最支持”“次选”“暂时无法明显区分”。
10. 只能引用 local_analysis 中已有的 evidence id 和 source_refs，不得编造引用；不得使用 as_of 之后的数据，多周期证据保持不可用。
11. 只返回合法 JSON，不要输出 Markdown、代码围栏或额外文字。

JSON 的 schema 必须是 elliott.explanation.public.v2。

输出键必须为：
schema, explanation_id, instrument, timeframe, as_of, verdict, summary,
primary_scenario, alternate_scenarios, confirmation, invalidation,
recount_conditions, next_observation, evidence_refs, disagreements,
limitations, source_refs, research_only。

verdict 结构必须包含：candidate_id、label、structure_family、direction、current_wave、phase、plain_text。
primary_scenario 结构必须包含：candidate_id、current_structure、current_wave、interpretation、next_expected、supporting_reasons。
alternate_scenarios 每项必须包含：candidate_id、scenario、interpretation、difference_from_primary、becomes_more_likely_if。
research_only 必须为 true。"""


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


def _local_counts(local_analysis: dict[str, Any]) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    primary = local_analysis.get("primaryCount", local_analysis.get("primary_count"))
    alternates = local_analysis.get("alternateCounts", local_analysis.get("alternate_counts"))
    return (
        primary if isinstance(primary, dict) else None,
        [item for item in alternates if isinstance(item, dict)] if isinstance(alternates, list) else [],
    )


def _local_count_value(count: dict[str, Any], key: str, default: Any = None) -> Any:
    camel_key = {
        "candidate_id": "candidateId",
        "current_wave": "currentWave",
        "wave_path": "wavePath",
        "ranking_basis": "rankingBasis",
        "next_observation": "nextObservation",
    }.get(key)
    value = count.get(key)
    if value is None and camel_key:
        value = count.get(camel_key)
    if value is None and key == "candidate_id":
        value = count.get("id")
    return default if value is None else value


def _local_candidate_ranking(local_analysis: dict[str, Any]) -> list[dict[str, Any]]:
    primary, alternates = _local_counts(local_analysis)
    counts = ([primary] if primary else []) + alternates
    return [{
        "rank": count.get("rank"),
        "candidate_id": _local_count_value(count, "candidate_id"),
        "family": count.get("family"),
        "direction": count.get("direction"),
        "current_wave": _local_count_value(count, "current_wave"),
        "wave_path": _local_count_value(count, "wave_path", []),
        "stage": count.get("stage"),
        "ranking_basis": _local_count_value(count, "ranking_basis", {}),
    } for count in counts]


_EXPLANATION_FAMILY_LABELS = {
    "impulse": "推动结构",
    "leading_diagonal": "推动结构",
    "ending_diagonal": "推动结构",
    "zigzag": "调整结构",
    "flat": "调整结构",
    "triangle": "三角形调整",
    "combination": "复杂调整",
    "unknown": "无法确定",
}
_EXPLANATION_DIRECTION_LABELS = {
    "up": "上涨",
    "down": "下跌",
    "sideways": "横向调整",
    "mixed": "混合方向",
}
_EXPLANATION_PHASES = {"起始阶段", "延伸阶段", "末段", "完成待确认", "无法确定"}


def _candidate_label(count: dict[str, Any] | None) -> str:
    if not count:
        return "无法确定"
    direction = _EXPLANATION_DIRECTION_LABELS.get(str(count.get("direction")), "无法确定")
    current_wave = _local_count_value(count, "current_wave")
    if not isinstance(current_wave, str) or not current_wave.strip():
        return direction if direction != "无法确定" else "无法确定"
    return f"{direction} {current_wave.strip()}浪"


def _candidate_structure(count: dict[str, Any] | None) -> str:
    if not count:
        return "无法确定"
    family = _EXPLANATION_FAMILY_LABELS.get(str(count.get("family")), "无法确定")
    direction = _EXPLANATION_DIRECTION_LABELS.get(str(count.get("direction")), "无法确定")
    return f"{family}，{direction}方向"


def _explanation_prompt(req: ElliottAnalyzeRequest, *, repair: str | None = None) -> list[dict[str, str]]:
    user: dict[str, Any] = {
        "symbol": req.symbol,
        "period": req.period,
        "as_of": req.as_of,
        "price_basis": req.price_basis,
        "candidate_ranking": _local_candidate_ranking(req.local_analysis),
        "local_analysis": req.local_analysis,
    }
    if repair:
        user = {
            "original_invalid_output": repair,
            "repair_instruction": "只返回符合 elliott.explanation.public.v2 的完整 JSON；不得输出计数、规则、价格边界或交易动作。",
            **user,
        }
    return [
        {"role": "system", "content": _EXPLANATION_SYSTEM_PROMPT},
        {"role": "user", "content": json.dumps(user, ensure_ascii=False, separators=(",", ":"))},
    ]


def _enforce_explanation_safety(payload: dict[str, Any], req: ElliottAnalyzeRequest) -> ElliottExplanation:
    local_evidence = _local_evidence_ids(req.local_analysis)
    local_sources = _local_source_refs(req.local_analysis)
    primary, alternates = _local_counts(req.local_analysis)
    raw_verdict = payload.get("verdict") if isinstance(payload.get("verdict"), dict) else {}
    primary_id = _local_count_value(primary, "candidate_id", "") if primary else ""
    current_wave = _local_count_value(primary, "current_wave", "无法确定") if primary else "无法确定"
    if not isinstance(current_wave, str) or not current_wave.strip():
        current_wave = "无法确定"
    phase = _safe_explanation_text(raw_verdict.get("phase"))
    if phase not in _EXPLANATION_PHASES:
        phase = "无法确定"
    label = _candidate_label(primary)
    raw_plain_text = _safe_explanation_text(raw_verdict.get("plain_text"))
    if not raw_plain_text:
        raw_plain_text = f"当前最支持本地排名 #1 的{label}。" if primary else "当前没有可用的本地主计数，无法确定波浪路径。"

    normalized_primary = None
    if primary:
        raw_primary = payload.get("primary_scenario") if isinstance(payload.get("primary_scenario"), dict) else {}
        local_next = _local_count_value(primary, "next_observation", [])
        local_next_text = local_next[0] if isinstance(local_next, list) and local_next and isinstance(local_next[0], str) else ""
        normalized_primary = {
            "candidate_id": primary_id if isinstance(primary_id, str) else "",
            "current_structure": _safe_explanation_text(raw_primary.get("current_structure")) or _candidate_structure(primary),
            "current_wave": current_wave,
            "interpretation": _safe_explanation_text(raw_primary.get("interpretation")),
            "next_expected": _safe_explanation_text(raw_primary.get("next_expected")) or _safe_explanation_text(local_next_text),
            "supporting_reasons": _safe_explanation_list(raw_primary.get("supporting_reasons")),
        }

    alternate_ids = {
        _local_count_value(count, "candidate_id")
        for count in alternates
        if isinstance(_local_count_value(count, "candidate_id"), str) and _local_count_value(count, "candidate_id")
    }
    normalized_alternates = []
    raw_alternates = payload.get("alternate_scenarios")
    if isinstance(raw_alternates, list):
        for raw_alternate in raw_alternates[:2]:
            if not isinstance(raw_alternate, dict):
                continue
            candidate_id = raw_alternate.get("candidate_id")
            if not isinstance(candidate_id, str) or candidate_id not in alternate_ids:
                continue
            normalized_alternates.append({
                "candidate_id": candidate_id,
                "scenario": _safe_explanation_text(raw_alternate.get("scenario")),
                "interpretation": _safe_explanation_text(raw_alternate.get("interpretation")),
                "difference_from_primary": _safe_explanation_text(raw_alternate.get("difference_from_primary")),
                "becomes_more_likely_if": _safe_explanation_text(raw_alternate.get("becomes_more_likely_if")),
            })

    verdict = {
        "candidate_id": primary_id if isinstance(primary_id, str) else "",
        "label": label,
        "structure_family": _EXPLANATION_FAMILY_LABELS.get(str(primary.get("family")), "无法确定") if primary else "无法确定",
        "direction": _EXPLANATION_DIRECTION_LABELS.get(str(primary.get("direction")), "无法确定") if primary else "无法确定",
        "current_wave": current_wave,
        "phase": phase,
        "plain_text": raw_plain_text,
    }
    normalized = {
        "schema": "elliott.explanation.public.v2",
        "explanation_id": str(payload.get("explanation_id") or f"explanation-{uuid.uuid4().hex[:12]}"),
        "instrument": req.symbol,
        "timeframe": req.period,
        "as_of": req.as_of,
        "verdict": verdict,
        "summary": _safe_explanation_text(payload.get("summary")),
        "primary_scenario": normalized_primary,
        "alternate_scenarios": normalized_alternates,
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
        normalized["summary"] = (
            f"AI判断：当前最支持{label}。请结合主判断的后续结构观察和备选切换条件理解本次解释。"
            if primary
            else "AI判断：无法确定。当前没有通过本地硬规则的有效主计数，请以确定性结果和后续确认拐点为准。"
        )
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
