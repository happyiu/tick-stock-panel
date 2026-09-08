"""Hermes Agent Gateway adapter.

The gateway intentionally lives behind the Tick Panel backend.  The frontend
only talks to the local settings API, so the Hermes API key is never exposed to
the browser and no CORS configuration is needed here.
"""
from __future__ import annotations

import json
from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx

HERMES_AGENT_PROVIDER = "hermes_agent"
HERMES_DEFAULT_PROBE_TIMEOUT = 8.0
HERMES_DEFAULT_REQUEST_TIMEOUT = 180.0


class HermesGatewayError(RuntimeError):
    """A safe, user-facing Hermes error without credentials or response dumps."""

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


@dataclass(frozen=True)
class HermesProbeResult:
    ok: bool
    gateway_url: str
    mode: str
    health: bool
    capabilities: bool
    models: bool
    chat_completions: bool
    runs: bool
    sessions: bool
    model_ids: tuple[str, ...]
    model: str
    error: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "gateway_url": self.gateway_url,
            "mode": self.mode,
            "health": self.health,
            "capabilities": self.capabilities,
            "models": self.models,
            "chat_completions": self.chat_completions,
            "runs": self.runs,
            "sessions": self.sessions,
            "model_ids": list(self.model_ids),
            "model": self.model,
            "error": self.error,
        }


def normalize_hermes_gateway_url(url: str) -> str:
    """Normalize a Gateway root or profile URL.

    Users commonly copy an OpenAI-compatible ``/v1`` URL or the complete chat
    endpoint.  Accept those forms while keeping the stored value at the
    Gateway/profile root, where the Hermes health and capability endpoints
    live.  Query strings, fragments and embedded credentials are rejected.
    """
    raw = (url or "").strip().rstrip("/")
    if not raw:
        raise ValueError("Hermes Gateway 地址不能为空")

    parsed = urlsplit(raw)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("Hermes Gateway 地址必须是 http:// 或 https:// 地址")
    if parsed.username or parsed.password:
        raise ValueError("Hermes Gateway 地址不能包含用户名或密码")
    if parsed.query or parsed.fragment:
        raise ValueError("Hermes Gateway 地址不能包含查询参数或片段")

    path = parsed.path.rstrip("/")
    lowered = path.lower()
    for suffix in ("/v1/chat/completions", "/chat/completions", "/v1"):
        if lowered.endswith(suffix):
            path = path[: -len(suffix)].rstrip("/")
            break

    return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def _endpoint(base_url: str, path: str) -> str:
    return f"{base_url.rstrip('/')}/{path.lstrip('/')}"


def _headers(api_key: str, *, accept: str = "application/json") -> dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        "Accept": accept,
        "User-Agent": "tick-stock-panel/1.0",
    }


def _timeout(seconds: float) -> httpx.Timeout:
    return httpx.Timeout(seconds, connect=min(seconds, 8.0))


def _response_detail(response: httpx.Response, *, secret: str = "") -> str:
    """Extract a short upstream error without echoing headers or credentials."""
    messages = {
        400: "请求参数无效, 请检查模型名称和 Gateway 配置",
        401: "API Server Key 无效或未授权",
        403: "Gateway 拒绝访问, 请检查 profile 或 Key 权限",
        404: "Hermes Gateway 接口不存在, 请检查地址和版本",
        408: "Hermes Gateway 请求超时",
        429: "Hermes Gateway 限流, 请稍后重试",
        500: "Hermes Agent 内部错误",
        502: "Hermes Gateway 上游错误",
        503: "Hermes Gateway 暂不可用",
        504: "Hermes Gateway 上游超时",
    }
    # 鉴权错误的上游 body 可能回显敏感诊断信息,只显示稳定的本地文案。
    if response.status_code in {401, 403}:
        return messages[response.status_code]

    try:
        payload = response.json()
    except ValueError:
        payload = None

    detail: Any = payload
    if isinstance(payload, Mapping):
        detail = payload.get("detail") or payload.get("message") or payload.get("error")
        if isinstance(detail, Mapping):
            detail = detail.get("message") or detail.get("detail")
    if not isinstance(detail, str) or not detail.strip():
        detail = ""
    detail = " ".join(detail.split())[:240]
    if secret:
        detail = detail.replace(secret, "[redacted]")

    return detail or messages.get(response.status_code, "Hermes Gateway 请求失败")


def _raise_for_response(response: httpx.Response, *, secret: str = "") -> None:
    if response.is_success:
        return
    raise HermesGatewayError(
        f"Hermes Gateway 请求失败({response.status_code}): {_response_detail(response, secret=secret)}",
        status_code=response.status_code,
    )


def _transport_error(exc: Exception) -> HermesGatewayError:
    if isinstance(exc, httpx.TimeoutException):
        return HermesGatewayError("Hermes Gateway 请求超时, 请检查地址和网络")
    if isinstance(exc, httpx.ConnectError):
        return HermesGatewayError("Hermes Gateway 连接失败, 请检查地址和网络")
    if isinstance(exc, httpx.HTTPError):
        return HermesGatewayError("Hermes Gateway 网络请求失败, 请稍后重试")
    return HermesGatewayError("Hermes Gateway 请求失败, 请稍后重试")


def _bool_from(payload: Any, *names: str) -> bool:
    """Read capability flags from a few compatible response shapes."""
    if not isinstance(payload, Mapping):
        return False
    containers: list[Mapping[str, Any]] = [payload]
    for key in ("capabilities", "features", "supports", "endpoints", "api", "routes"):
        nested = payload.get(key)
        if isinstance(nested, Mapping):
            containers.append(nested)
    lowered = {name.lower() for name in names}
    for container in containers:
        for key, value in container.items():
            normalized = str(key).lower().replace("-", "_").replace("/", "_")
            if normalized in lowered and value is True:
                return True
            if normalized in lowered and isinstance(value, str) and value.lower() in {"true", "yes", "1"}:
                return True
            if normalized in lowered and isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
                return bool(value)
            if normalized in lowered and isinstance(value, Mapping):
                return True
    return False


def _model_ids(payload: Any) -> tuple[str, ...]:
    if not isinstance(payload, Mapping):
        return ()
    values = payload.get("data") or payload.get("models") or payload.get("items") or []
    if isinstance(values, Mapping):
        values = [{"id": key} for key in values]
    if not isinstance(values, Sequence) or isinstance(values, (str, bytes)):
        return ()

    ids: list[str] = []
    for item in values:
        value = item.get("id") if isinstance(item, Mapping) else item
        if isinstance(value, str) and value.strip() and value.strip() not in ids:
            ids.append(value.strip())
    return tuple(ids)


def _content_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, Mapping) and isinstance(value.get("text"), str):
        return value["text"]
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        parts: list[str] = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, Mapping) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "".join(parts)
    return ""


async def probe_gateway(
    gateway_url: str,
    api_key: str,
    *,
    model: str = "",
    timeout: float = HERMES_DEFAULT_PROBE_TIMEOUT,
) -> HermesProbeResult:
    """Probe health, capabilities and model discovery without generating text."""
    try:
        base_url = normalize_hermes_gateway_url(gateway_url)
    except ValueError as exc:
        return HermesProbeResult(
            ok=False,
            gateway_url="",
            mode="unavailable",
            health=False,
            capabilities=False,
            models=False,
            chat_completions=False,
            runs=False,
            sessions=False,
            model_ids=(),
            model=model.strip(),
            error=str(exc),
        )

    if not api_key.strip():
        return HermesProbeResult(
            ok=False,
            gateway_url=base_url,
            mode="unavailable",
            health=False,
            capabilities=False,
            models=False,
            chat_completions=False,
            runs=False,
            sessions=False,
            model_ids=(),
            model=model.strip(),
            error="Hermes API Server Key 未配置",
        )

    headers = _headers(api_key.strip())
    health = False
    capabilities = False
    models = False
    chat_completions = False
    runs = False
    sessions = False
    model_ids: tuple[str, ...] = ()

    try:
        async with httpx.AsyncClient(
            timeout=_timeout(timeout), follow_redirects=True
        ) as client:
            health_response = await client.get(_endpoint(base_url, "/health"), headers=headers)
            if health_response.is_success:
                health = True
            elif health_response.status_code not in {404, 405}:
                _raise_for_response(health_response, secret=api_key.strip())

            capabilities_response = await client.get(
                _endpoint(base_url, "/v1/capabilities"), headers=headers
            )
            capability_payload: Any = None
            if capabilities_response.is_success:
                capabilities = True
                capability_payload = capabilities_response.json()
                runs = _bool_from(capability_payload, "runs", "run", "v1_runs")
                sessions = _bool_from(
                    capability_payload, "sessions", "session", "api_sessions"
                )
                chat_completions = _bool_from(
                    capability_payload,
                    "chat_completions",
                    "chat_completion",
                    "chat",
                    "v1_chat_completions",
                )
            elif capabilities_response.status_code not in {404, 405}:
                _raise_for_response(capabilities_response, secret=api_key.strip())

            models_response = await client.get(_endpoint(base_url, "/v1/models"), headers=headers)
            if models_response.is_success:
                models = True
                model_ids = _model_ids(models_response.json())
            elif models_response.status_code not in {404, 405}:
                _raise_for_response(models_response, secret=api_key.strip())
    except HermesGatewayError as exc:
        return HermesProbeResult(
            ok=False,
            gateway_url=base_url,
            mode="unavailable",
            health=health,
            capabilities=capabilities,
            models=models,
            chat_completions=chat_completions,
            runs=runs,
            sessions=sessions,
            model_ids=model_ids,
            model=model.strip() or (model_ids[0] if model_ids else ""),
            error=str(exc),
        )
    except (httpx.HTTPError, ValueError, OSError) as exc:
        error_message = str(_transport_error(exc))
        return HermesProbeResult(
            ok=False,
            gateway_url=base_url,
            mode="unavailable",
            health=health,
            capabilities=capabilities,
            models=models,
            chat_completions=chat_completions,
            runs=runs,
            sessions=sessions,
            model_ids=model_ids,
            model=model.strip() or (model_ids[0] if model_ids else ""),
            error=error_message,
        )

    selected_model = model.strip() or (model_ids[0] if model_ids else "")
    # 老版本 Gateway 可能没有 capabilities/models,但仍提供健康检查和
    # Chat Completions;手动填写模型时允许以兼容模式保存,实际推理由测试按钮验证。
    chat_completions = chat_completions or models or bool(health and selected_model)
    ok = bool((health or capabilities or models) and chat_completions)
    if capabilities and (runs or sessions):
        mode = "enhanced"
    elif ok:
        mode = "compatible"
    else:
        mode = "unavailable"

    error: str | None = None
    if not ok:
        error = "未发现可用的 Hermes Chat Completions 或模型接口"
    elif not selected_model:
        error = "Gateway 未返回模型列表, 请手动填写模型名称"

    return HermesProbeResult(
        ok=ok,
        gateway_url=base_url,
        mode=mode,
        health=health,
        capabilities=capabilities,
        models=models,
        chat_completions=chat_completions,
        runs=runs,
        sessions=sessions,
        model_ids=model_ids,
        model=selected_model,
        error=error,
    )


def _chat_payload(
    messages: Sequence[Mapping[str, Any]],
    *,
    model: str,
    temperature: float | None,
    max_tokens: int | None,
    stream: bool,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": model,
        "messages": list(messages),
        "stream": stream,
    }
    if temperature is not None:
        payload["temperature"] = temperature
    if max_tokens is not None:
        payload["max_tokens"] = max_tokens
    return payload


def _is_optional_param_error(exc: HermesGatewayError, param: str) -> bool:
    return exc.status_code == 400 and param.lower() in str(exc).lower()


async def complete_chat(
    gateway_url: str,
    api_key: str,
    messages: Sequence[Mapping[str, Any]],
    *,
    model: str,
    temperature: float | None,
    max_tokens: int | None,
    timeout: float = HERMES_DEFAULT_REQUEST_TIMEOUT,
) -> str:
    """Run a non-streaming Chat Completions request and return visible text."""
    base_url = normalize_hermes_gateway_url(gateway_url)
    if not api_key.strip():
        raise HermesGatewayError("Hermes API Server Key 未配置")
    if not model.strip():
        raise HermesGatewayError("Hermes Agent 模型未配置")

    payload = _chat_payload(
        messages,
        model=model.strip(),
        temperature=temperature,
        max_tokens=max_tokens,
        stream=False,
    )
    try:
        async with httpx.AsyncClient(
            timeout=_timeout(timeout), follow_redirects=True
        ) as client:
            while True:
                response = await client.post(
                    _endpoint(base_url, "/v1/chat/completions"),
                    headers=_headers(api_key.strip()),
                    json=payload,
                )
                try:
                    _raise_for_response(response, secret=api_key.strip())
                    try:
                        body = response.json()
                    except ValueError as exc:
                        raise HermesGatewayError("Hermes 响应格式异常") from exc
                    choices = body.get("choices") if isinstance(body, Mapping) else None
                    if not isinstance(choices, Sequence) or not choices:
                        raise HermesGatewayError("Hermes 服务未返回 choices")
                    first = choices[0]
                    message = first.get("message") if isinstance(first, Mapping) else None
                    content = _content_text(message.get("content") if isinstance(message, Mapping) else "")
                    if content.strip():
                        return content.strip()
                    raise HermesGatewayError("Hermes 服务未返回正文内容")
                except HermesGatewayError as exc:
                    if "temperature" in payload and _is_optional_param_error(exc, "temperature"):
                        payload.pop("temperature", None)
                        continue
                    raise
    except HermesGatewayError:
        raise
    except (httpx.HTTPError, OSError) as exc:
        raise _transport_error(exc) from exc


async def _iter_sse_events(response: httpx.Response) -> AsyncIterator[tuple[str, str]]:
    event_name = "message"
    data_lines: list[str] = []

    async for line in response.aiter_lines():
        if line == "":
            if data_lines:
                yield event_name, "\n".join(data_lines)
            event_name = "message"
            data_lines = []
            continue
        if line.startswith(":"):
            continue
        if line.startswith("event:"):
            event_name = line[6:].strip() or "message"
        elif line.startswith("data:"):
            data_lines.append(line[5:].lstrip())

    if data_lines:
        yield event_name, "\n".join(data_lines)


async def stream_chat(
    gateway_url: str,
    api_key: str,
    messages: Sequence[Mapping[str, Any]],
    *,
    model: str,
    temperature: float | None,
    max_tokens: int | None,
    timeout: float = HERMES_DEFAULT_REQUEST_TIMEOUT,
) -> AsyncIterator[str]:
    """Stream only assistant text from Hermes SSE responses."""
    base_url = normalize_hermes_gateway_url(gateway_url)
    if not api_key.strip():
        raise HermesGatewayError("Hermes API Server Key 未配置")
    if not model.strip():
        raise HermesGatewayError("Hermes Agent 模型未配置")

    payload = _chat_payload(
        messages,
        model=model.strip(),
        temperature=temperature,
        max_tokens=max_tokens,
        stream=True,
    )
    content_seen = False
    reasoning_seen = False
    finish_reason = ""

    try:
        async with httpx.AsyncClient(
            timeout=_timeout(timeout), follow_redirects=True
        ) as client:
            while True:
                try:
                    async with client.stream(
                        "POST",
                        _endpoint(base_url, "/v1/chat/completions"),
                        headers=_headers(api_key.strip(), accept="text/event-stream"),
                        json=payload,
                    ) as response:
                        _raise_for_response(response, secret=api_key.strip())
                        async for event_name, raw_data in _iter_sse_events(response):
                            if raw_data.strip() == "[DONE]":
                                continue
                            if event_name.startswith("hermes."):
                                continue
                            try:
                                chunk = json.loads(raw_data)
                            except json.JSONDecodeError as exc:
                                raise HermesGatewayError("Hermes 流式响应格式异常") from exc
                            if not isinstance(chunk, Mapping):
                                continue
                            if str(chunk.get("type") or "").startswith("hermes."):
                                continue
                            choices = chunk.get("choices")
                            if not isinstance(choices, Sequence) or not choices:
                                continue
                            choice = choices[0]
                            if not isinstance(choice, Mapping):
                                continue
                            if choice.get("finish_reason"):
                                finish_reason = str(choice["finish_reason"])
                            delta = choice.get("delta")
                            if not isinstance(delta, Mapping):
                                continue
                            if delta.get("reasoning_content"):
                                reasoning_seen = True
                            content = _content_text(delta.get("content"))
                            if content:
                                content_seen = True
                                yield content
                    break
                except HermesGatewayError as exc:
                    if "temperature" in payload and _is_optional_param_error(exc, "temperature"):
                        payload.pop("temperature", None)
                        continue
                    raise

    except HermesGatewayError:
        raise
    except (httpx.HTTPError, OSError) as exc:
        raise _transport_error(exc) from exc

    if finish_reason in {"length", "max_tokens", "max_output_tokens"}:
        if reasoning_seen and not content_seen:
            raise HermesGatewayError("Hermes 推理达到输出长度上限, 未生成正文")
        raise HermesGatewayError("Hermes 输出达到长度上限, 内容不完整")
    if not content_seen:
        if reasoning_seen:
            raise HermesGatewayError("Hermes 仅返回推理内容, 未生成正文")
        raise HermesGatewayError("Hermes 服务未返回正文内容")
