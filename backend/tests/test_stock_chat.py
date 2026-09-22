"""Hermes-only detail-page chat contract tests."""

from __future__ import annotations

import asyncio
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.api import stock_analysis as stock_analysis_api
from app.services import stock_chat
from app.services.hermes_studio import HermesStudioError


def _snapshot(symbol: str = "600000.SH") -> stock_chat.StockChatSnapshot:
    return stock_chat.StockChatSnapshot(
        version=1,
        symbol=symbol,
        name="浦发银行",
        asset_type="stock",
        period="1d",
        as_of="2026-09-12",
        captured_at="2026-09-12T10:00:00Z",
        source="chart",
        data_status={"data_through": "2026-09-12", "stale": False},
        bars=[{"date": "2026-09-12", "close": 10.2, "ma20": 10.0}],
        technical_score={"as_of": "2026-09-12", "direction_score": 0.2},
        structure={"chanlun": {"definitionMode": "structure_proxy"}},
        price_zones=[],
        signal_risk=[],
    )


def _request(
    *messages: dict[str, str],
    symbol: str = "600000.SH",
    studio_session_id: str | None = None,
) -> stock_chat.StockChatRequest:
    return stock_chat.StockChatRequest(
        symbol=symbol,
        snapshot=_snapshot(symbol),
        messages=list(messages),
        studio_session_id=studio_session_id,
    )


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(stock_analysis_api.router)
    return TestClient(app)


def test_request_requires_latest_user_and_matching_snapshot() -> None:
    with pytest.raises(ValidationError, match="最后一条消息"):
        _request({"role": "user", "content": "你好"}, {"role": "assistant", "content": "你好"})

    with pytest.raises(ValidationError, match="第一条消息"):
        _request({"role": "assistant", "content": "先回答"}, {"role": "user", "content": "你好"})

    with pytest.raises(ValidationError, match="上下文标的"):
        stock_chat.StockChatRequest(
            symbol="600000.SH",
            snapshot=_snapshot("000001.SZ"),
            messages=[{"role": "user", "content": "你好"}],
        )


def test_prepare_stock_chat_is_hermes_only(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(stock_chat, "current_ai_provider", lambda: "openai_compat")
    with pytest.raises(stock_chat.StockChatError, match="仅支持 Hermes") as exc_info:
        stock_chat.prepare_stock_chat(_request({"role": "user", "content": "你好"}))
    assert exc_info.value.status_code == 409


def test_chat_route_rejects_non_hermes_without_calling_upstream(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(stock_chat, "current_ai_provider", lambda: "openai_compat")
    with _client() as client:
        response = client.post(
            "/api/stock-analysis/chat/stream",
            json=_request({"role": "user", "content": "你好"}).model_dump(mode="json"),
        )
    assert response.status_code == 409
    assert "Hermes" in response.json()["detail"]


def test_chat_route_streams_meta_delta_and_done(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        stock_analysis_api,
        "prepare_stock_chat",
        lambda _req: (
            "固定提示",
            {
                "meta": {
                    "type": "meta",
                    "provider": "hermes_agent",
                    "transport": "studio_chat_run",
                    "symbol": "600000.SH",
                    "period": "1d",
                    "as_of": "2026-09-12",
                    "history_truncated": False,
                    "heartbeat_seconds": 15,
                },
                "session_id": None,
                "profile": "seekhub",
            },
        ),
    )

    async def fake_events(*_args, **_kwargs):
        yield {"type": "delta", "content": "回答"}
        yield {"type": "done"}

    monkeypatch.setattr(stock_analysis_api, "stream_stock_chat", fake_events)
    with _client() as client:
        response = client.post(
            "/api/stock-analysis/chat/stream",
            json=_request({"role": "user", "content": "你好"}).model_dump(mode="json"),
        )
    assert response.status_code == 200
    events = [json.loads(line) for line in response.text.splitlines() if line]
    assert [event["type"] for event in events] == ["meta", "delta", "done"]
    assert events[0]["provider"] == "hermes_agent"
    assert "secret" not in response.text


def test_prepare_stock_chat_builds_first_studio_turn(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(stock_chat, "current_ai_provider", lambda: stock_chat.HERMES_AGENT_PROVIDER)
    monkeypatch.setattr(stock_chat, "studio_configured", lambda: True)
    monkeypatch.setattr(stock_chat, "current_studio_url", lambda: "http://studio.example")
    monkeypatch.setattr(stock_chat, "current_studio_profile", lambda: "seekhub")

    input_text, prepared = stock_chat.prepare_stock_chat(_request({"role": "user", "content": "第一问"}))

    assert "600000.SH" in input_text
    assert "第一问" in input_text
    assert prepared["meta"]["provider"] == stock_chat.HERMES_AGENT_PROVIDER
    assert prepared["meta"]["transport"] == "studio_chat_run"
    assert prepared["session_id"] is None


def test_prepare_stock_chat_continuation_sends_only_latest_question(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(stock_chat, "current_ai_provider", lambda: stock_chat.HERMES_AGENT_PROVIDER)
    monkeypatch.setattr(stock_chat, "studio_configured", lambda: True)
    monkeypatch.setattr(stock_chat, "current_studio_url", lambda: "http://studio.example")
    monkeypatch.setattr(stock_chat, "current_studio_profile", lambda: "seekhub")

    input_text, prepared = stock_chat.prepare_stock_chat(_request(
        {"role": "user", "content": "旧问题 " + "x" * 80},
        {"role": "assistant", "content": "旧回答 " + "x" * 80},
        {"role": "user", "content": "新问题"},
        studio_session_id="studio-session-1",
    ))
    assert input_text == "新问题"
    assert prepared["session_id"] == "studio-session-1"
    assert prepared["meta"]["history_truncated"] is False


@pytest.mark.asyncio
async def test_stream_stock_chat_emits_heartbeat_and_delta(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_run(*_args, **_kwargs):
        await asyncio.sleep(0.03)
        return {"session_id": "studio-session-1", "output": "回答"}

    monkeypatch.setattr(stock_chat, "hermes_studio_run_chat", fake_run)
    events = [
        event
        async for event in stock_chat.stream_stock_chat(
            "你好",
            heartbeat_seconds=0.005,
        )
    ]

    assert any(event["type"] == "heartbeat" for event in events)
    assert {event.get("session_id") for event in events if event["type"] == "session"} == {"studio-session-1"}
    assert {event.get("content") for event in events if event["type"] == "delta"} == {"回答"}
    assert events[-1] == {"type": "done"}


@pytest.mark.asyncio
async def test_stream_stock_chat_converts_upstream_error_to_event(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_run(*_args, **_kwargs):
        raise HermesStudioError("Hermes Studio 请求失败", status_code=409)

    monkeypatch.setattr(stock_chat, "hermes_studio_run_chat", fake_run)
    events = [
        event
        async for event in stock_chat.stream_stock_chat(
            "你好",
            heartbeat_seconds=0.01,
        )
    ]
    assert events[-1]["type"] == "error"
    assert events[-1]["status_code"] == 409
