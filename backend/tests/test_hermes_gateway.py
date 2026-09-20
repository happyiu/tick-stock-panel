from __future__ import annotations

import json

import httpx
import pytest

from app import secrets_store
from app.api import settings as settings_api
from app.config import settings
from app.services import ai_provider, hermes_gateway

_REAL_ASYNC_CLIENT = httpx.AsyncClient


def _mock_async_client(monkeypatch, handler):
    transport = httpx.MockTransport(handler)

    class FakeAsyncClient:
        def __init__(self, **kwargs):
            self._client = _REAL_ASYNC_CLIENT(transport=transport, **kwargs)

        async def __aenter__(self):
            await self._client.__aenter__()
            return self

        async def __aexit__(self, exc_type, exc_value, traceback):
            return await self._client.__aexit__(exc_type, exc_value, traceback)

        async def get(self, *args, **kwargs):
            return await self._client.get(*args, **kwargs)

        async def post(self, *args, **kwargs):
            return await self._client.post(*args, **kwargs)

        def stream(self, *args, **kwargs):
            return self._client.stream(*args, **kwargs)

    monkeypatch.setattr(hermes_gateway.httpx, "AsyncClient", FakeAsyncClient)


def test_normalize_hermes_gateway_url_accepts_root_profile_and_v1():
    assert hermes_gateway.normalize_hermes_gateway_url("http://127.0.0.1:8642/") == "http://127.0.0.1:8642"
    assert hermes_gateway.normalize_hermes_gateway_url("https://hermes.example/p/research/v1") == "https://hermes.example/p/research"
    assert hermes_gateway.normalize_hermes_gateway_url("https://hermes.example/v1/chat/completions") == "https://hermes.example"

    with pytest.raises(ValueError, match="用户名或密码"):
        hermes_gateway.normalize_hermes_gateway_url("https://user:pass@hermes.example")
    with pytest.raises(ValueError, match="查询参数"):
        hermes_gateway.normalize_hermes_gateway_url("https://hermes.example?token=secret")


@pytest.mark.asyncio
async def test_probe_gateway_reports_enhanced_capabilities_and_models(monkeypatch):
    seen_headers: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_headers.append(request.headers["authorization"])
        if request.url.path == "/health":
            return httpx.Response(200, json={"status": "ok"})
        if request.url.path == "/v1/capabilities":
            return httpx.Response(
                200,
                json={"capabilities": {"chat_completions": True, "runs": True, "sessions": True}},
            )
        if request.url.path == "/v1/models":
            return httpx.Response(200, json={"data": [{"id": "hermes-agent"}, {"id": "research"}]})
        return httpx.Response(404)

    _mock_async_client(monkeypatch, handler)
    result = await hermes_gateway.probe_gateway(
        "http://hermes.example/v1",
        "test-secret-key",
    )

    assert result.ok is True
    assert result.mode == "enhanced"
    assert result.model_ids == ("hermes-agent", "research")
    assert result.model == "hermes-agent"
    assert result.chat_completions is True
    assert seen_headers == ["Bearer test-secret-key"] * 3
    assert "test-secret-key" not in json.dumps(result.as_dict())


@pytest.mark.asyncio
async def test_probe_gateway_allows_compatible_mode_when_capabilities_is_missing(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/health":
            return httpx.Response(200)
        if request.url.path == "/v1/capabilities":
            return httpx.Response(404)
        if request.url.path == "/v1/models":
            return httpx.Response(200, json={"data": [{"id": "hermes-agent"}]})
        return httpx.Response(404)

    _mock_async_client(monkeypatch, handler)
    result = await hermes_gateway.probe_gateway("http://hermes.example", "key")

    assert result.ok is True
    assert result.mode == "compatible"
    assert result.capabilities is False
    assert result.model == "hermes-agent"


@pytest.mark.asyncio
async def test_probe_gateway_hides_auth_error_and_does_not_leak_key(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"detail": "top-secret invalid key"})

    _mock_async_client(monkeypatch, handler)
    result = await hermes_gateway.probe_gateway("http://hermes.example", "top-secret")

    assert result.ok is False
    assert "top-secret" not in (result.error or "")
    assert "API Server Key" in (result.error or "")


@pytest.mark.asyncio
async def test_complete_chat_retries_once_when_temperature_is_rejected(monkeypatch):
    payloads: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        payloads.append(json.loads(request.content))
        if len(payloads) == 1:
            return httpx.Response(400, json={"error": {"message": "unsupported parameter: temperature"}})
        return httpx.Response(200, json={"choices": [{"message": {"content": "OK"}}]})

    _mock_async_client(monkeypatch, handler)
    secret = "key"
    result = await hermes_gateway.complete_chat(
        "http://hermes.example",
        secret,
        [{"role": "user", "content": "hello"}],
        model="hermes-agent",
        temperature=0.2,
        max_tokens=8,
    )

    assert result == "OK"
    assert "temperature" in payloads[0]
    assert "temperature" not in payloads[1]


@pytest.mark.asyncio
async def test_stream_chat_yields_text_and_ignores_hermes_tool_progress(monkeypatch):
    body = (
        "event: hermes.tool.progress\n"
        "data: {\"type\": \"hermes.tool.progress\", \"message\": \"running\"}\n\n"
        "data: {\"choices\": [{\"delta\": {\"content\": \"hello \"}}]}\n\n"
        "data: {\"choices\": [{\"delta\": {\"content\": \"world\"}, \"finish_reason\": \"stop\"}]}\n\n"
        "data: [DONE]\n\n"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, text=body)

    _mock_async_client(monkeypatch, handler)
    chunks = [
        chunk
        async for chunk in hermes_gateway.stream_chat(
            "http://hermes.example",
            "key",
            [{"role": "user", "content": "hello"}],
            model="hermes-agent",
            temperature=None,
            max_tokens=16,
        )
    ]

    assert chunks == ["hello ", "world"]


@pytest.mark.asyncio
async def test_stream_chat_rejects_malformed_sse_and_empty_content(monkeypatch):
    def malformed(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            text="data: definitely-not-json\n\n",
        )

    _mock_async_client(monkeypatch, malformed)
    with pytest.raises(hermes_gateway.HermesGatewayError, match="格式异常"):
        async for _ in hermes_gateway.stream_chat(
            "http://hermes.example",
            "key",
            [{"role": "user", "content": "hello"}],
            model="hermes-agent",
            temperature=None,
            max_tokens=16,
        ):
            pass

    def empty(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            text="data: {\"choices\": [{\"delta\": {}, \"finish_reason\": \"stop\"}]}\n\n",
        )

    _mock_async_client(monkeypatch, empty)
    with pytest.raises(hermes_gateway.HermesGatewayError, match="未返回正文"):
        async for _ in hermes_gateway.stream_chat(
            "http://hermes.example",
            "key",
            [{"role": "user", "content": "hello"}],
            model="hermes-agent",
            temperature=None,
            max_tokens=16,
        ):
            pass


@pytest.mark.asyncio
async def test_ai_provider_routes_generate_and_stream_to_hermes(monkeypatch):
    monkeypatch.setattr(ai_provider, "current_ai_provider", lambda: hermes_gateway.HERMES_AGENT_PROVIDER)
    monkeypatch.setattr(ai_provider, "current_hermes_gateway_url", lambda: "http://hermes.example")
    monkeypatch.setattr(ai_provider, "current_hermes_key", lambda: "key")
    monkeypatch.setattr(ai_provider, "current_hermes_model", lambda: "hermes-agent")
    monkeypatch.setattr(ai_provider, "current_ai_max_output_tokens", lambda: 8192)
    monkeypatch.setattr(ai_provider, "current_ai_context_window", lambda: 64000)

    async def fake_complete(*args, **kwargs):
        assert kwargs["model"] == "hermes-agent"
        return "complete"

    async def fake_stream(*args, **kwargs):
        assert kwargs["model"] == "hermes-agent"
        yield "stream"

    monkeypatch.setattr(ai_provider, "hermes_complete_chat", fake_complete)
    monkeypatch.setattr(ai_provider, "hermes_stream_chat", fake_stream)

    messages = [{"role": "user", "content": "hello"}]
    assert await ai_provider.generate_ai_text(messages, max_tokens=8) == "complete"
    assert [chunk async for chunk in ai_provider.stream_ai_text(messages, max_tokens=8)] == ["stream"]


@pytest.mark.asyncio
async def test_save_and_clear_hermes_preserves_generic_provider_config(monkeypatch):
    stored = {
        "ai_provider": "openai_compat",
        "ai_api_key": "openai-key",
        "ai_base_url": "https://example.com/v1",
        "ai_model": "custom-model",
    }
    original_provider = settings.ai_provider

    def save(updates: dict) -> dict:
        stored.update(updates)
        return stored

    def clear(*keys: str) -> dict:
        for key in keys:
            stored.pop(key, None)
        return stored

    async def fake_probe(*args, **kwargs):
        return hermes_gateway.HermesProbeResult(
            ok=True,
            gateway_url="http://hermes.example",
            mode="enhanced",
            health=True,
            capabilities=True,
            models=True,
            chat_completions=True,
            runs=True,
            sessions=True,
            model_ids=("hermes-agent",),
            model="hermes-agent",
        )

    monkeypatch.setattr(secrets_store, "load", lambda: stored)
    monkeypatch.setattr(secrets_store, "save", save)
    monkeypatch.setattr(secrets_store, "clear", clear)
    monkeypatch.setattr(hermes_gateway, "probe_gateway", fake_probe)
    try:
        result = await settings_api.save_hermes_settings(
            settings_api.HermesSettingsIn(
                gateway_url="http://hermes.example/v1",
                api_key="hermes-key",
                model="hermes-agent",
            )
        )
        assert result["ok"] is True
        assert stored["ai_provider"] == hermes_gateway.HERMES_AGENT_PROVIDER
        assert stored["hermes_gateway_url"] == "http://hermes.example"
        assert stored["hermes_api_key"] == "hermes-key"
        assert stored["ai_api_key"] == "openai-key"

        settings_api.clear_hermes_settings()
        assert "hermes_api_key" not in stored
        assert stored["ai_provider"] == ai_provider.OPENAI_COMPAT_PROVIDER
        assert stored["ai_api_key"] == "openai-key"
    finally:
        settings.ai_provider = original_provider
