"""艾略特波浪 AI 接口的边界、安全和解释测试。"""
from __future__ import annotations

import asyncio
import json
from datetime import date, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.api import stock_analysis as stock_analysis_api
from app.services import elliott_wave_analyzer as elliott_service
from app.services.elliott_wave_analyzer import (
    ElliottAnalyzeRequest,
    ElliottAssessment,
    ElliottAssessmentError,
    ElliottExplanation,
    analyze_elliott,
    explain_elliott,
)

AS_OF = "2026-01-24"


def _bars(count: int = 24) -> list[dict]:
    rows = []
    for index in range(count):
        close = 100.0 + index * 0.5
        rows.append({
            "date": (date(2026, 1, 1) + timedelta(days=index)).isoformat(),
            "open": close - 0.2,
            "high": close + 0.4,
            "low": close - 0.4,
            "close": close,
            "volume": 1000.0 + index,
        })
    return rows


def _request(**overrides) -> ElliottAnalyzeRequest:
    payload = {
        "symbol": "600000.SH",
        "period": "1d",
        "as_of": AS_OF,
        "price_basis": "前复权",
        "bars": _bars(),
        "local_analysis": {"status": "ready"},
    }
    payload.update(overrides)
    return ElliottAnalyzeRequest.model_validate(payload)


def _assessment_payload() -> dict:
    return {
        "schema": "elliott.assessment.public.v1",
        "assessment_id": "ai-test",
        "instrument": "wrong-symbol",
        "market": "A-share",
        "timeframe": "wrong-period",
        "as_of": "2099-01-01",
        "available_at": "2099-01-02",
        "price_basis": "后复权",
        "definition_mode": "strict_elliott",
        "data_quality": {"status": "sufficient", "missing": [], "limitations": []},
        "primary_count": {
            "label": "P1",
            "degree": "当前周期",
            "family": "impulse",
            "direction": "up",
            "stage": "观察中",
            "pivots": [
                {"label": "0", "event_time": "2026-01-05", "confirmed_at": "2026-01-07", "available_at": "2026-01-07", "price": 100, "state": "observed"},
                {"label": "5", "event_time": "2026-02-01", "confirmed_at": "2026-02-03", "available_at": "2026-02-03", "price": 110, "state": "projected"},
                {"label": "bad", "event_time": "2026-01-08", "price": "not-a-number", "state": "observed"},
            ],
            "support_summary": ["仅用于测试"],
            "confirmation": ["等待确认"],
            "invalidation": ["跌破起点"],
            "recount_conditions": ["出现重叠"],
            "next_observation": ["观察下一拐点"],
        },
        "alternate_counts": [],
        "hard_rule_checks": [],
        "guideline_evidence": [{
            "family": "multi_timeframe",
            "result": "supports",
            "observation": "未来周期支持",
            "dependency_group": "future-data",
            "weight": "high",
        }],
        "fibonacci_relationships": [],
        "channel_checks": [],
        "momentum_volume_evidence": [],
        "ambiguity": "none",
        "approximation_loss": [],
        "confirmation": ["等待确认"],
        "invalidation": ["跌破起点"],
        "recount_conditions": ["出现重叠"],
        "next_observation": ["观察下一拐点"],
        "research_only": False,
        "broker_connection_enabled": True,
        "automatic_orders": True,
        "order_authorized": True,
        "status": "READY",
        "ic_pass": True,
        "allowed_action": "buy",
        "suggested_shares": 1000,
    }


def _explanation_payload() -> dict:
    return {
        "schema": "elliott.explanation.public.v2",
        "explanation_id": "explanation-test",
        "instrument": "wrong-symbol",
        "timeframe": "1w",
        "as_of": "2099-01-01",
        "verdict": {
            "candidate_id": "candidate:impulse",
            "label": "上涨 5浪",
            "structure_family": "推动结构",
            "direction": "上涨",
            "current_wave": "5",
            "phase": "完成待确认",
            "plain_text": "当前最支持上涨 5浪。",
        },
        "summary": "本地候选存在结构支持，但仍需等待确认。",  # noqa: RUF001
        "primary_scenario": {
            "candidate_id": "candidate:impulse",
            "current_structure": "推动结构，上涨方向",  # noqa: RUF001
            "current_wave": "5",
            "interpretation": "当前处于五浪结构的末端观察阶段。",
            "next_expected": "观察反向拐点是否确认推动段完成。",
            "supporting_reasons": ["硬规则完整", "端点结构完整"],
        },
        "alternate_scenarios": [{
            "candidate_id": "candidate:zigzag",
            "scenario": "下跌 C浪",
            "interpretation": "也可能是调整结构尚未完成。",
            "difference_from_primary": "主方案认为当前是推动末段，备选认为当前仍在调整。",  # noqa: RUF001
            "becomes_more_likely_if": "后续出现新的下跌结构端点。",
        }],
        "evidence_refs": ["local-candidate:structure", "not-local"],
        "disagreements": ["动量证据不可用"],
        "limitations": ["当前仅分析一个周期"],
        "confirmation": ["等待反向拐点"],
        "invalidation": ["硬规则失败"],
        "recount_conditions": ["新增拐点改变拓扑"],
        "next_observation": ["观察下一根已闭合 K 线"],
        "source_refs": ["local:elliott/rules/v2", "not-local-source"],
        "research_only": False,
    }


def test_request_drops_future_bars_and_sorts_snapshot():
    rows = _bars(24)
    rows[0], rows[-1] = rows[-1], rows[0]
    rows.append({
        "date": "2026-02-01",
        "open": 1.0,
        "high": 1.1,
        "low": 0.9,
        "close": 1.0,
        "volume": 1.0,
    })
    request = _request(bars=rows)

    assert len(request.bars) == 24
    assert [bar.date for bar in request.bars] == sorted(bar.date for bar in request.bars)
    assert all(bar.date <= AS_OF for bar in request.bars)


def test_request_rejects_insufficient_valid_history():
    with pytest.raises(ValidationError, match="至少需要 20 根"):
        _request(bars=_bars(19))


def test_request_rejects_more_than_ten_percent_invalid_history():
    rows = _bars(24)
    rows[0]["close"] = 0.0
    rows[1]["high"] = rows[1]["low"] - 1.0
    rows[2]["volume"] = -1.0
    with pytest.raises(ValidationError, match="无效行情超过"):
        _request(bars=rows)


@pytest.mark.asyncio
async def test_ai_output_is_frozen_to_snapshot_and_safety_constants(monkeypatch):
    calls = []

    async def fake_generate(messages, **kwargs):
        calls.append(messages)
        return json.dumps(_assessment_payload(), ensure_ascii=False)

    monkeypatch.setattr(elliott_service, "generate_ai_text", fake_generate)
    result = await analyze_elliott(_request())

    assert len(calls) == 1
    assert result.instrument == "600000.SH"
    assert result.timeframe == "1d"
    assert result.as_of == AS_OF
    assert result.available_at == AS_OF
    assert result.price_basis == "前复权"
    assert result.definition_mode == "structure_proxy"
    assert result.guideline_evidence[0].result == "unavailable"
    assert result.guideline_evidence[0].observation == "首版仅分析当前周期，多周期证据不可用"  # noqa: RUF001
    assert [pivot.event_time for pivot in result.primary_count.pivots] == ["2026-01-05"]
    assert result.primary_count.pivots[0].confirmed_at == "2026-01-07"
    assert result.research_only is True
    assert result.broker_connection_enabled is False
    assert result.automatic_orders is False
    assert result.order_authorized is False
    assert result.status == "DRAFT_REVIEW"
    assert result.ic_pass is False
    assert result.allowed_action == "observe"
    assert result.suggested_shares == 0


@pytest.mark.asyncio
async def test_invalid_json_gets_one_structural_repair(monkeypatch):
    responses = iter(["not json", json.dumps(_assessment_payload(), ensure_ascii=False)])
    calls = 0

    async def fake_generate(messages, **kwargs):
        nonlocal calls
        calls += 1
        return next(responses)

    monkeypatch.setattr(elliott_service, "generate_ai_text", fake_generate)
    result = await analyze_elliott(_request())

    assert calls == 2
    assert result.status == "DRAFT_REVIEW"


@pytest.mark.asyncio
async def test_schema_failure_after_repair_is_reported(monkeypatch):
    calls = 0

    async def fake_generate(messages, **kwargs):
        nonlocal calls
        calls += 1
        return "{}"

    monkeypatch.setattr(elliott_service, "generate_ai_text", fake_generate)
    with pytest.raises(ElliottAssessmentError, match="连续两次"):
        await analyze_elliott(_request())
    assert calls == 2


def _api_client() -> TestClient:
    app = FastAPI()
    app.include_router(stock_analysis_api.router)
    return TestClient(app)


def _request_json() -> dict:
    return {
        "symbol": "600000.SH",
        "period": "1d",
        "as_of": AS_OF,
        "price_basis": "前复权",
        "bars": _bars(),
        "local_analysis": {"status": "ready"},
    }


def test_api_reports_ai_unconfigured(monkeypatch):
    monkeypatch.setattr(stock_analysis_api, "ai_configured", lambda: False)
    response = _api_client().post("/api/stock-analysis/elliott/analyze", json=_request_json())

    assert response.status_code == 503
    assert "AI 未配置" in response.json()["detail"]


def test_api_returns_versioned_assessment(monkeypatch):
    result = ElliottAssessment.model_validate(elliott_service._enforce_safety(_assessment_payload(), _request()).model_dump())
    monkeypatch.setattr(stock_analysis_api, "ai_configured", lambda: True)

    async def fake_analyze(req):
        return result

    monkeypatch.setattr(stock_analysis_api, "analyze_elliott", fake_analyze)
    response = _api_client().post("/api/stock-analysis/elliott/analyze", json=_request_json())

    assert response.status_code == 200
    body = response.json()
    assert body["schema"] == "elliott.assessment.public.v1"
    assert body["instrument"] == "600000.SH"
    assert body["research_only"] is True
    assert body["suggested_shares"] == 0


def test_api_maps_provider_failure_to_502(monkeypatch):
    monkeypatch.setattr(stock_analysis_api, "ai_configured", lambda: True)

    async def fake_analyze(req):
        raise RuntimeError("provider down")

    monkeypatch.setattr(stock_analysis_api, "analyze_elliott", fake_analyze)
    response = _api_client().post("/api/stock-analysis/elliott/analyze", json=_request_json())

    assert response.status_code == 502
    assert "评估失败" in response.json()["detail"]


def test_explanation_only_keeps_local_evidence_refs(monkeypatch):
    calls = []

    async def fake_generate(messages, **kwargs):
        calls.append(messages)
        return json.dumps(_explanation_payload(), ensure_ascii=False)

    local_analysis = {
        "status": "ready",
        "sourceRefs": ["local:elliott/rules/v2"],
        "guidelineEvidence": [{"id": "local-candidate:structure"}],
    }
    monkeypatch.setattr(elliott_service, "generate_ai_text", fake_generate)
    result = asyncio.run(explain_elliott(_request(local_analysis=local_analysis)))

    assert len(calls) == 1
    assert result.schema == "elliott.explanation.public.v2"
    assert result.instrument == "600000.SH"
    assert result.timeframe == "1d"
    assert result.as_of == AS_OF
    assert result.evidence_refs == ["local-candidate:structure"]
    assert result.source_refs == ["local:elliott/rules/v2"]
    assert result.research_only is True
    assert result.verdict.label == "无法确定"
    assert result.primary_scenario is None
    assert "primary_count" not in result.model_dump()


def test_explanation_prompt_requires_candidate_type_judgement():
    local_analysis = {
        "primaryCount": {
            "id": "candidate:impulse",
            "family": "impulse",
            "direction": "up",
            "currentWave": "5",
            "wavePath": ["0", "1", "2", "3", "4", "5"],
            "rank": 1,
            "rankingBasis": {"strict": True, "pivotCount": 6, "supportingEvidence": 4},
        },
        "alternateCounts": [{
            "id": "candidate:zigzag",
            "family": "zigzag",
            "direction": "down",
            "currentWave": "C",
            "wavePath": ["0", "A", "B", "C"],
            "rank": 2,
            "rankingBasis": {"strict": True, "pivotCount": 4, "supportingEvidence": 3},
        }],
    }
    messages = elliott_service._explanation_prompt(_request(local_analysis=local_analysis))
    user = json.loads(messages[1]["content"])

    assert "rank=1" in messages[0]["content"]
    assert "elliott.explanation.public.v2" in messages[0]["content"]
    assert "AI判断" in messages[0]["content"]
    assert user["local_analysis"]["primaryCount"]["family"] == "impulse"
    assert user["candidate_ranking"][0]["rank"] == 1
    assert user["candidate_ranking"][1]["current_wave"] == "C"


def test_explanation_normalizes_candidate_identity_and_structure_fields(monkeypatch):
    payload = _explanation_payload()
    payload["verdict"]["candidate_id"] = "not-local"
    payload["verdict"]["label"] = "下跌 C浪"
    payload["verdict"]["direction"] = "下跌"
    payload["verdict"]["current_wave"] = "C3"
    payload["verdict"]["phase"] = "随便判断"
    payload["verdict"]["plain_text"] = "成功概率 80%，目标价 12.3"  # noqa: RUF001
    payload["primary_scenario"]["candidate_id"] = "not-local"
    payload["primary_scenario"]["interpretation"] = "建议买入"
    payload["alternate_scenarios"].append({
        "candidate_id": "not-local",
        "scenario": "无效候选",
    })
    local_analysis = {
        "status": "ready",
        "sourceRefs": ["local:elliott/rules/v2"],
        "guidelineEvidence": [{"id": "local-candidate:structure"}],
        "primaryCount": {
            "id": "candidate:impulse",
            "family": "impulse",
            "direction": "up",
            "currentWave": "5",
            "rank": 1,
            "nextObservation": ["观察反向拐点"],
        },
        "alternateCounts": [{
            "id": "candidate:zigzag",
            "family": "zigzag",
            "direction": "down",
            "currentWave": "C",
            "rank": 2,
        }],
    }

    async def fake_generate(messages, **kwargs):
        return json.dumps(payload, ensure_ascii=False)

    monkeypatch.setattr(elliott_service, "generate_ai_text", fake_generate)
    result = asyncio.run(explain_elliott(_request(local_analysis=local_analysis)))

    assert result.schema == "elliott.explanation.public.v2"
    assert result.verdict.candidate_id == "candidate:impulse"
    assert result.verdict.label == "上涨 5浪"
    assert result.verdict.direction == "上涨"
    assert result.verdict.current_wave == "5"
    assert result.verdict.phase == "无法确定"
    assert result.verdict.plain_text.startswith("当前最支持本地排名 #1")
    assert result.primary_scenario is not None
    assert result.primary_scenario.candidate_id == "candidate:impulse"
    assert result.primary_scenario.interpretation == ""
    assert [item.candidate_id for item in result.alternate_scenarios] == ["candidate:zigzag"]


def test_explanation_repairs_invalid_json_once(monkeypatch):
    responses = iter(["not json", json.dumps(_explanation_payload(), ensure_ascii=False)])
    calls = 0

    async def fake_generate(messages, **kwargs):
        nonlocal calls
        calls += 1
        return next(responses)

    monkeypatch.setattr(elliott_service, "generate_ai_text", fake_generate)
    result = asyncio.run(explain_elliott(_request()))

    assert calls == 2
    assert result.research_only is True


def test_explanation_drops_trade_action_text(monkeypatch):
    payload = _explanation_payload()
    payload["summary"] = "建议买入"
    payload["disagreements"] = ["卖出后再观察", "动量证据不可用"]

    async def fake_generate(messages, **kwargs):
        return json.dumps(payload, ensure_ascii=False)

    monkeypatch.setattr(elliott_service, "generate_ai_text", fake_generate)
    result = asyncio.run(explain_elliott(_request()))

    assert "买入" not in result.summary
    assert result.disagreements == ["动量证据不可用"]


def test_explanation_drops_probability_and_price_boundary_text(monkeypatch):
    payload = _explanation_payload()
    payload["summary"] = "成功概率 80%，目标价 12.3"  # noqa: RUF001

    async def fake_generate(messages, **kwargs):
        return json.dumps(payload, ensure_ascii=False)

    monkeypatch.setattr(elliott_service, "generate_ai_text", fake_generate)
    result = asyncio.run(explain_elliott(_request()))

    assert "概率" not in result.summary
    assert "目标价" not in result.summary


def test_api_returns_explanation_without_count_fields(monkeypatch):
    monkeypatch.setattr(stock_analysis_api, "ai_configured", lambda: True)

    async def fake_explain(req):
        return ElliottExplanation.model_validate({
            "schema": "elliott.explanation.public.v2",
            "explanation_id": "explanation-api-test",
            "instrument": req.symbol,
            "timeframe": req.period,
            "as_of": req.as_of,
            "summary": "只读解释",
            "evidence_refs": [],
            "source_refs": [],
            "research_only": True,
        })

    monkeypatch.setattr(stock_analysis_api, "explain_elliott", fake_explain)
    response = _api_client().post("/api/stock-analysis/elliott/explain", json=_request_json())

    assert response.status_code == 200
    body = response.json()
    assert body["schema"] == "elliott.explanation.public.v2"
    assert body["instrument"] == "600000.SH"
    assert body["research_only"] is True
    assert "primary_count" not in body
