from __future__ import annotations

import json

import httpx
import pytest

from app import secrets_store
from app.services import hermes_studio

_REAL_ASYNC_CLIENT = httpx.AsyncClient


def _mock_async_client(monkeypatch: pytest.MonkeyPatch, handler) -> None:
    transport = httpx.MockTransport(handler)

    class FakeAsyncClient:
        def __init__(self, **kwargs):
            self._client = _REAL_ASYNC_CLIENT(transport=transport, **kwargs)

        async def __aenter__(self):
            await self._client.__aenter__()
            return self

        async def __aexit__(self, exc_type, exc_value, traceback):
            return await self._client.__aexit__(exc_type, exc_value, traceback)

        async def post(self, *args, **kwargs):
            return await self._client.post(*args, **kwargs)

    monkeypatch.setattr(hermes_studio.httpx, "AsyncClient", FakeAsyncClient)


def test_normalize_studio_url_rejects_credentials_and_query() -> None:
    assert hermes_studio.normalize_studio_url("http://127.0.0.1:6060/") == "http://127.0.0.1:6060"
    with pytest.raises(ValueError, match="用户名或密码"):
        hermes_studio.normalize_studio_url("https://user:pass@studio.example")
    with pytest.raises(ValueError, match="查询参数"):
        hermes_studio.normalize_studio_url("https://studio.example?token=secret")


@pytest.mark.asyncio
async def test_run_chat_sends_profile_bearer_and_continuation_session(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(secrets_store, "load", lambda: {"hermes_studio_token": "studio-secret"})
    seen: list[tuple[str, dict, str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        seen.append((request.url.path, payload, request.headers["authorization"], request.headers["x-hermes-profile"]))
        return httpx.Response(200, json={"ok": True, "status": "completed", "session_id": "s-1", "run_id": "r-1", "output": "OK"})

    _mock_async_client(monkeypatch, handler)
    first = await hermes_studio.run_chat("你好", profile="seekhub")
    second = await hermes_studio.run_chat("继续", session_id=first["session_id"], profile="seekhub")

    assert first["session_id"] == second["session_id"] == "s-1"
    assert seen[0][0] == "/api/studio/chat-run/runs"
    assert seen[0][1]["input"] == "你好"
    assert "session_id" not in seen[0][1]
    assert seen[1][1]["session_id"] == "s-1"
    assert seen[0][2:] == ("Bearer studio-secret", "seekhub")
    assert "studio-secret" not in str(first)


@pytest.mark.asyncio
async def test_run_chat_logs_in_and_refreshes_once_after_401(monkeypatch: pytest.MonkeyPatch) -> None:
    stored = {"hermes_studio_username": "seekhub-app", "hermes_studio_password": "password"}
    saved: list[dict] = []

    def load() -> dict:
        return stored

    def save(updates: dict) -> dict:
        stored.update(updates)
        saved.append(updates)
        return stored

    monkeypatch.setattr(secrets_store, "load", load)
    monkeypatch.setattr(secrets_store, "save", save)
    calls = {"login": 0, "run": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/login":
            calls["login"] += 1
            return httpx.Response(200, json={"token": f"token-{calls['login']}"})
        calls["run"] += 1
        if calls["run"] == 1:
            return httpx.Response(401, json={"detail": "expired"})
        assert request.headers["authorization"] == "Bearer token-2"
        return httpx.Response(200, json={"ok": True, "session_id": "s-2", "output": "OK"})

    _mock_async_client(monkeypatch, handler)
    result = await hermes_studio.run_chat("你好")

    assert result["session_id"] == "s-2"
    assert calls == {"login": 2, "run": 2}
    assert saved == [{"hermes_studio_token": "token-1"}, {"hermes_studio_token": "token-2"}]


@pytest.mark.asyncio
async def test_run_chat_maps_studio_approval_to_409(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(secrets_store, "load", lambda: {"hermes_studio_token": "secret"})

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(409, json={"detail": "approval required"})

    _mock_async_client(monkeypatch, handler)
    with pytest.raises(hermes_studio.HermesStudioError, match="需要审批或澄清") as exc_info:
        await hermes_studio.run_chat("执行危险操作")
    assert exc_info.value.status_code == 409
