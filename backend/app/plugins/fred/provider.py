"""FRED daily WTI and Brent series provider."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Any

import httpx

from app import secrets_store
from app.data_providers.commodity import definitions_for, get_json, parse_date, parse_value, utc_now

API_KEY_ENV = "FRED_API_KEY"
SECRETS_FIELD = "fred_api_key"
API_URL = "https://api.stlouisfed.org/fred/series/observations"
SOURCE = "fred"


def get_api_key() -> str:
    return secrets_store.get_env_backed_secret(SECRETS_FIELD, API_KEY_ENV)


def availability() -> tuple[bool, str]:
    if get_api_key():
        return True, "ok"
    return False, f"缺少 API Key(可在下方输入框填写,或配置环境变量 {API_KEY_ENV})"


def _fetch(
    client: httpx.Client,
    api_key: str,
    series_id: str,
    *,
    start: date | None,
    end: date | None,
) -> Any:
    params: dict[str, Any] = {
        "api_key": api_key,
        "file_type": "json",
        "series_id": series_id,
        "sort_order": "asc",
    }
    if start is not None:
        params["observation_start"] = start.isoformat()
    if end is not None:
        params["observation_end"] = end.isoformat()
    payload = get_json(client, API_URL, params=params, source="FRED")
    if not isinstance(payload, dict):
        raise ValueError("FRED 返回格式不是对象")
    if payload.get("error_code"):
        raise ValueError(f"FRED: {payload.get('error_message') or 'API 返回错误'}")
    return payload


def _rows(payload: Any, definition, retrieved_at: str) -> list[dict[str, Any]]:
    observations = payload.get("observations") if isinstance(payload, dict) else None
    if not isinstance(observations, list):
        raise ValueError(f"FRED {definition.source_series_id} 返回缺少 observations")
    rows: list[dict[str, Any]] = []
    for raw in observations:
        if not isinstance(raw, dict):
            raise ValueError(f"FRED {definition.source_series_id} 记录不是对象")
        value = parse_value(raw.get("value"), field=f"{definition.source_series_id} value")
        if value is None:
            continue
        rows.append({
            **definition.__dict__,
            "date": parse_date(raw.get("date"), field=f"{definition.source_series_id} date"),
            "value": value,
            "retrieved_at": retrieved_at,
        })
    return rows


def probe_api_key(api_key: str) -> tuple[bool, str]:
    try:
        with httpx.Client(timeout=10.0) as client:
            _fetch(client, api_key.strip(), "DCOILWTICO", start=None, end=None)
        return True, "ok"
    except (httpx.HTTPError, OSError, ValueError) as exc:
        return False, f"API Key 无效或网络失败: {exc}"


@dataclass
class _Config:
    name: str = "fred"
    display_name: str = "FRED"
    datasets: dict = field(default_factory=lambda: {"commodity": {}})
    path: None = None
    builtin: bool = True


class FredProvider:
    name = "fred"
    display_name = "FRED"

    def __init__(self) -> None:
        self.config = _Config()
        self._client = httpx.Client(timeout=30.0)

    def close(self) -> None:
        self._client.close()

    def get_commodity_series(
        self,
        *,
        start: date | None = None,
        end: date | None = None,
        symbols: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        definitions = [item for item in definitions_for(symbols) if item.source == SOURCE]
        retrieved_at = utc_now()
        rows: list[dict[str, Any]] = []
        for definition in definitions:
            rows.extend(_rows(
                _fetch(self._client, get_api_key(), definition.source_series_id, start=start, end=end),
                definition,
                retrieved_at,
            ))
        return sorted(rows, key=lambda row: (row["date"], row["symbol"]))
