"""EIA API v2 provider for the fixed commodity series."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Any

import httpx

from app import secrets_store
from app.data_providers.commodity import definitions_for, get_json, parse_date, parse_value, utc_now

API_KEY_ENV = "EIA_API_KEY"
SECRETS_FIELD = "eia_api_key"
API_BASE = "https://api.eia.gov/v2"
SOURCE = "eia"

# APIv2 routes are dataset-specific; the legacy series IDs are sent as the
# series facet and remain the stable source_series_id in our stored rows.
EIA_SERIES_ROUTES = {
    "RNGWHHD": ("natural-gas/pri/fut/data/", "daily"),
    "WCRSTUS1": ("petroleum/stoc/wstk/data/", "weekly"),
    "WCRFPUS2": ("petroleum/sum/sndw/data/", "weekly"),
    "WGTSTUS1": ("petroleum/stoc/wstk/data/", "weekly"),
    "WPULEUS3": ("petroleum/pnp/wiup/data/", "weekly"),
}


def get_api_key() -> str:
    return secrets_store.get_env_backed_secret(SECRETS_FIELD, API_KEY_ENV)


def availability() -> tuple[bool, str]:
    if get_api_key():
        return True, "ok"
    return False, f"缺少 API Key(可在下方输入框填写,或配置环境变量 {API_KEY_ENV})"


def _fetch(
    client: httpx.Client,
    api_key: str,
    source_series_id: str,
    *,
    start: date | None,
    end: date | None,
) -> Any:
    route, frequency = EIA_SERIES_ROUTES[source_series_id]
    params: dict[str, Any] = {
        "api_key": api_key,
        "frequency": frequency,
        "data[0]": "value",
        "facets[series][]": source_series_id,
        "sort[0][column]": "period",
        "sort[0][direction]": "asc",
        "length": 5000,
    }
    if start is not None:
        params["start"] = start.isoformat()
    if end is not None:
        params["end"] = end.isoformat()
    payload = get_json(
        client,
        f"{API_BASE}/{route}",
        params=params,
        source="EIA",
    )
    if not isinstance(payload, dict):
        raise ValueError("EIA 返回格式不是对象")
    if payload.get("error"):
        error = payload["error"]
        detail = error.get("description") if isinstance(error, dict) else str(error)
        raise ValueError(f"EIA: {detail or 'API 返回错误'}")
    return payload


def _rows(payload: Any, definition, retrieved_at: str) -> list[dict[str, Any]]:
    response = payload.get("response") if isinstance(payload, dict) else None
    records = response.get("data") if isinstance(response, dict) else None
    if not isinstance(records, list):
        raise ValueError(f"EIA {definition.source_series_id} 返回缺少 data")
    rows: list[dict[str, Any]] = []
    for raw in records:
        if not isinstance(raw, dict):
            raise ValueError(f"EIA {definition.source_series_id} 记录不是对象")
        value = parse_value(raw.get("value"), field=f"{definition.source_series_id} value")
        if value is None:
            continue
        rows.append({
            **definition.__dict__,
            "date": parse_date(raw.get("period"), field=f"{definition.source_series_id} period"),
            "value": value,
            "retrieved_at": retrieved_at,
        })
    return rows


def probe_api_key(api_key: str) -> tuple[bool, str]:
    try:
        with httpx.Client(timeout=10.0) as client:
            _fetch(client, api_key.strip(), "RNGWHHD", start=None, end=None)
        return True, "ok"
    except (httpx.HTTPError, OSError, ValueError) as exc:
        return False, f"API Key 无效或网络失败: {exc}"


@dataclass
class _Config:
    name: str = "eia"
    display_name: str = "EIA"
    datasets: dict = field(default_factory=lambda: {"commodity": {}})
    path: None = None
    builtin: bool = True


class EiaProvider:
    name = "eia"
    display_name = "EIA"

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
