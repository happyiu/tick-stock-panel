"""Minimal HTTP client for Hermes Studio's persistent chat-run sessions."""
from __future__ import annotations

import os
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx

from app import secrets_store

HERMES_STUDIO_DEFAULT_URL = "http://127.0.0.1:6060"
HERMES_STUDIO_DEFAULT_PROFILE = "seekhub"
HERMES_STUDIO_DEFAULT_TIMEOUT_MS = 300_000
HERMES_STUDIO_MAX_TIMEOUT_MS = 1_800_000


class HermesStudioError(RuntimeError):
    """Safe upstream error with the HTTP status to expose to the caller."""

    def __init__(self, message: str, *, status_code: int = 502) -> None:
        super().__init__(message)
        self.status_code = status_code


def normalize_studio_url(value: str) -> str:
    """Accept only an HTTP(S) origin/path, never credentials or query secrets."""
    raw = (value or "").strip().rstrip("/")
    parsed = urlsplit(raw)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("Hermes Studio 地址必须是 http(s) URL")
    if parsed.username or parsed.password:
        raise ValueError("Hermes Studio 地址不能包含用户名或密码")
    if parsed.query or parsed.fragment:
        raise ValueError("Hermes Studio 地址不能包含查询参数或片段")
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))


def current_studio_url() -> str:
    value = secrets_store.get_hermes_config("hermes_studio_url")
    return normalize_studio_url(
        value or os.environ.get("HERMES_STUDIO_URL", HERMES_STUDIO_DEFAULT_URL),
    )


def current_studio_profile() -> str:
    return (
        secrets_store.get_hermes_config("hermes_studio_profile")
        or os.environ.get("HERMES_STUDIO_PROFILE", HERMES_STUDIO_DEFAULT_PROFILE)
    ).strip()


def current_studio_token() -> str:
    return secrets_store.get_env_backed_secret("hermes_studio_token", "HERMES_STUDIO_TOKEN") or os.environ.get("STUDIO_TOKEN", "").strip()


def current_studio_username() -> str:
    return secrets_store.get_env_backed_secret("hermes_studio_username", "HERMES_STUDIO_USERNAME")


def current_studio_password() -> str:
    return secrets_store.get_env_backed_secret("hermes_studio_password", "HERMES_STUDIO_PASSWORD")


def studio_configured() -> bool:
    return bool(current_studio_profile() and (current_studio_token() or (
        current_studio_username() and current_studio_password()
    )))


def _response_detail(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        return ""
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
            return str(error.get("message") or error.get("detail") or "")
        return str(payload.get("detail") or payload.get("message") or "")
    return ""


def _safe_detail(response: httpx.Response) -> str:
    detail = " ".join(_response_detail(response).split())
    return detail[:240]


async def _login(client: httpx.AsyncClient, base_url: str, username: str, password: str) -> str:
    try:
        response = await client.post(
            f"{base_url}/api/auth/login",
            json={"username": username, "password": password},
        )
    except httpx.TimeoutException as exc:
        raise HermesStudioError("Hermes Studio 登录超时", status_code=504) from exc
    except httpx.RequestError as exc:
        raise HermesStudioError("Hermes Studio 登录连接失败", status_code=503) from exc
    if response.status_code != 200:
        detail = _safe_detail(response)
        raise HermesStudioError(
            f"Hermes Studio 登录失败{': ' + detail if detail else ''}",
            status_code=401 if response.status_code == 401 else 502,
        )
    try:
        token = str(response.json().get("token") or "").strip()
    except (ValueError, AttributeError):
        token = ""
    if not token:
        raise HermesStudioError("Hermes Studio 登录未返回 token", status_code=502)
    # 登录换来的 token 覆盖环境变量, 避免每一轮重复登录。
    secrets_store.save({"hermes_studio_token": token})
    return token


async def run_chat(
    input_text: str,
    *,
    session_id: str | None = None,
    profile: str | None = None,
    timeout_ms: int = HERMES_STUDIO_DEFAULT_TIMEOUT_MS,
    include_events: bool = False,
    workspace: str | None = None,
) -> dict[str, Any]:
    """Run one Studio turn and return its durable session id and output."""
    if not input_text.strip():
        raise HermesStudioError("Hermes Studio 输入不能为空", status_code=400)
    if timeout_ms < 1 or timeout_ms > HERMES_STUDIO_MAX_TIMEOUT_MS:
        raise HermesStudioError(
            f"Hermes Studio timeout_ms 必须在 1 到 {HERMES_STUDIO_MAX_TIMEOUT_MS} 之间",
            status_code=400,
        )
    base_url = current_studio_url()
    selected_profile = (profile or current_studio_profile()).strip()
    if not selected_profile:
        raise HermesStudioError("Hermes Studio profile 未配置", status_code=503)

    token = current_studio_token()
    username = current_studio_username()
    password = current_studio_password()
    if not token and not (username and password):
        raise HermesStudioError(
            "Hermes Studio 未配置 token 或登录账号, 请在设置 → AI 中配置",
            status_code=503,
        )

    payload: dict[str, Any] = {
        "input": input_text,
        "profile": selected_profile,
        "timeout_ms": timeout_ms,
    }
    if session_id:
        payload["session_id"] = session_id
    if include_events:
        payload["include_events"] = True
    if workspace:
        payload["workspace"] = workspace

    timeout = timeout_ms / 1000 + 5
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            if not token:
                token = await _login(client, base_url, username, password)
            headers = {
                "Authorization": f"Bearer {token}",
                "X-Hermes-Profile": selected_profile,
                "Content-Type": "application/json",
            }
            response = await client.post(
                f"{base_url}/api/studio/chat-run/runs",
                headers=headers,
                json=payload,
            )
            if response.status_code == 401 and username and password:
                token = await _login(client, base_url, username, password)
                headers["Authorization"] = f"Bearer {token}"
                response = await client.post(
                    f"{base_url}/api/studio/chat-run/runs",
                    headers=headers,
                    json=payload,
                )
    except httpx.TimeoutException as exc:
        raise HermesStudioError("Hermes Studio 对话超时", status_code=504) from exc
    except httpx.RequestError as exc:
        raise HermesStudioError("Hermes Studio 连接失败", status_code=503) from exc

    if response.status_code != 200:
        detail = _safe_detail(response)
        if response.status_code == 409:
            message = "Hermes Studio 需要审批或澄清"
        elif response.status_code == 401:
            message = "Hermes Studio 鉴权失败, 请检查 token 或登录账号"
        elif response.status_code == 504:
            message = "Hermes Studio 对话超时"
        else:
            message = f"Hermes Studio 请求失败 ({response.status_code})"
        raise HermesStudioError(f"{message}{': ' + detail if detail else ''}", status_code=response.status_code)

    try:
        result = response.json()
    except ValueError as exc:
        raise HermesStudioError("Hermes Studio 返回不是有效 JSON", status_code=502) from exc
    if not isinstance(result, dict) or result.get("ok") is not True:
        raise HermesStudioError("Hermes Studio 返回失败结果", status_code=502)
    returned_session_id = str(result.get("session_id") or "").strip()
    if not returned_session_id:
        raise HermesStudioError("Hermes Studio 未返回 session_id", status_code=502)
    output = result.get("output")
    if isinstance(output, list):
        output = "".join(
            str(block.get("text") or block.get("content") or "")
            if isinstance(block, dict) else str(block)
            for block in output
        )
    return {
        "session_id": returned_session_id,
        "run_id": result.get("run_id"),
        "output": str(output or ""),
        "reasoning": result.get("reasoning"),
        "events": result.get("events") if include_events else None,
    }
