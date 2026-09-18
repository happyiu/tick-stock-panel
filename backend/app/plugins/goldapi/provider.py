"""Gold API daily precious-metal history provider."""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Any

import httpx

from app import secrets_store
from app.data_providers.commodity import definitions_for, get_json, parse_date, parse_value, utc_now

API_KEY_ENV = "GOLD_API_KEY"
SECRETS_FIELD = "goldapi_api_key"
HISTORY_URL = "https://api.gold-api.com/history"
SOURCE = "goldapi"
logger = logging.getLogger(__name__)


def get_api_key() -> str:
    return secrets_store.get_env_backed_secret(SECRETS_FIELD, API_KEY_ENV)


def availability() -> tuple[bool, str]:
    if get_api_key():
        return True, "ok"
    return False, f"缺少 API Key(可在下方输入框填写,或配置环境变量 {API_KEY_ENV})"


def _query_range(start: date | None, end: date | None) -> tuple[date, date]:
    today = datetime.now(UTC).date()
    query_start = start or (today - timedelta(days=7))
    query_end = end or today
    if query_start > query_end:
        raise ValueError("Gold API 开始日期不能晚于结束日期")
    return query_start, query_end


def _timestamp(value: date) -> int:
    return int(datetime(value.year, value.month, value.day, tzinfo=UTC).timestamp())


def _fetch(
    client: httpx.Client,
    api_key: str,
    symbol: str,
    *,
    start: date | None,
    end: date | None,
) -> Any:
    query_start, query_end = _query_range(start, end)
    payload = get_json(
        client,
        HISTORY_URL,
        params={
            "symbol": symbol,
            "startTimestamp": _timestamp(query_start),
            "endTimestamp": _timestamp(query_end),
            "groupBy": "day",
            "aggregation": "avg",
            "orderBy": "asc",
        },
        headers={"x-api-key": api_key},
        source="Gold API",
    )
    if isinstance(payload, dict):
        raise ValueError(f"Gold API: {payload.get('message') or payload.get('error') or 'API 返回错误'}")
    if not isinstance(payload, list):
        raise ValueError("Gold API 返回格式不是数组")
    return payload


def _rows(payload: Any, definition, retrieved_at: str) -> list[dict[str, Any]]:
    if not isinstance(payload, list):
        raise ValueError(f"Gold API {definition.symbol} 返回格式不是数组")
    rows: list[dict[str, Any]] = []
    for raw in payload:
        if not isinstance(raw, dict):
            raise ValueError(f"Gold API {definition.symbol} 记录不是对象")
        value = parse_value(raw.get("avg_price"), field=f"{definition.symbol} avg_price")
        if value is None:
            continue
        rows.append({
            **definition.__dict__,
            "date": parse_date(raw.get("day"), field=f"{definition.symbol} day"),
            "value": value,
            "retrieved_at": retrieved_at,
        })
    return rows


def probe_api_key(api_key: str) -> tuple[bool, str]:
    try:
        with httpx.Client(timeout=10.0) as client:
            _fetch(client, api_key.strip(), "XAU", start=None, end=None)
        return True, "ok"
    except (httpx.HTTPError, OSError, ValueError) as exc:
        return False, f"Gold API 探测失败: {exc}"


@dataclass
class _Config:
    name: str = "goldapi"
    display_name: str = "Gold API"
    datasets: dict = field(default_factory=lambda: {"commodity": {}})
    path: None = None
    builtin: bool = True


class GoldApiProvider:
    name = "goldapi"
    display_name = "Gold API"

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
        errors: list[str] = []
        for definition in definitions:
            try:
                rows.extend(_rows(
                    _fetch(self._client, get_api_key(), definition.source_series_id, start=start, end=end),
                    definition,
                    retrieved_at,
                ))
            except (httpx.HTTPError, OSError, ValueError) as exc:
                errors.append(f"{definition.symbol}: {exc}")
                logger.warning("Gold API %s failed: %s", definition.symbol, exc)
        if not rows and errors:
            raise ValueError("Gold API: " + "; ".join(errors))
        return sorted(rows, key=lambda row: (row["date"], row["symbol"]))
