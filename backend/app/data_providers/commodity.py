"""Commodity dataset contract and the fixed v1 series catalog."""
from __future__ import annotations

import logging
from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime
from typing import Any

import httpx

# httpx INFO records contain full query URLs, including provider API keys.
logging.getLogger("httpx").setLevel(logging.WARNING)


@dataclass(frozen=True)
class CommodityDefinition:
    symbol: str
    name: str
    category: str
    kind: str
    unit: str
    frequency: str
    source: str
    source_series_id: str


COMMODITY_DEFINITIONS: tuple[CommodityDefinition, ...] = (
    CommodityDefinition(
        "XAU/USD", "黄金", "precious_metal", "price", "USD/oz", "1d", "goldapi", "XAU",
    ),
    CommodityDefinition(
        "XAG/USD", "白银", "precious_metal", "price", "USD/oz", "1d", "goldapi", "XAG",
    ),
    CommodityDefinition(
        "WTI", "WTI 原油", "energy", "price", "USD/bbl", "1d", "fred", "DCOILWTICO",
    ),
    CommodityDefinition(
        "BRENT", "Brent 原油", "energy", "price", "USD/bbl", "1d", "fred", "DCOILBRENTEU",
    ),
    CommodityDefinition(
        "NATURAL_GAS", "天然气", "energy", "price", "USD/MMBtu", "1d", "eia", "RNGWHHD",
    ),
    CommodityDefinition(
        "CRUDE_STOCKS", "原油库存", "energy_fundamental", "inventory", "千桶", "1w", "eia", "WCRSTUS1",
    ),
    CommodityDefinition(
        "CRUDE_PRODUCTION", "原油产量", "energy_fundamental", "production", "千桶/日", "1w", "eia", "WCRFPUS2",
    ),
    CommodityDefinition(
        "GASOLINE_STOCKS", "汽油库存", "energy_fundamental", "inventory", "千桶", "1w", "eia", "WGTSTUS1",
    ),
    CommodityDefinition(
        "REFINERY_UTILIZATION", "炼厂开工率", "energy_fundamental", "utilization", "%", "1w", "eia", "WPULEUS3",
    ),
)

DEFINITIONS_BY_SYMBOL = {item.symbol: item for item in COMMODITY_DEFINITIONS}
DEFINITIONS_BY_SOURCE = {
    source: tuple(item for item in COMMODITY_DEFINITIONS if item.source == source)
    for source in {item.source for item in COMMODITY_DEFINITIONS}
}


def catalog() -> list[dict[str, Any]]:
    return [asdict(item) for item in COMMODITY_DEFINITIONS]


def definitions_for(symbols: list[str] | None = None) -> tuple[CommodityDefinition, ...]:
    if not symbols:
        return COMMODITY_DEFINITIONS
    requested = {symbol.strip().upper() for symbol in symbols if symbol.strip()}
    unknown = sorted(requested - DEFINITIONS_BY_SYMBOL.keys())
    if unknown:
        raise ValueError(f"不支持的商品: {', '.join(unknown)}")
    return tuple(item for item in COMMODITY_DEFINITIONS if item.symbol in requested)


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def parse_date(value: Any, *, field: str = "date") -> date:
    try:
        return date.fromisoformat(str(value)[:10])
    except (TypeError, ValueError) as exc:
        raise ValueError(f"商品 {field} 无效: {value!r}") from exc


def parse_value(value: Any, *, field: str = "value") -> float | None:
    if value is None or str(value).strip() in {"", ".", "NA", "N/A", "null", "None"}:
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"商品 {field} 不是有效数字: {value!r}") from exc
    if parsed != parsed or parsed in {float("inf"), float("-inf")}:
        raise ValueError(f"商品 {field} 不是有限数字: {value!r}")
    return parsed


def get_json(
    client: httpx.Client,
    url: str,
    *,
    params: dict[str, Any],
    headers: dict[str, str] | None = None,
    source: str,
) -> Any:
    """Fetch JSON without exposing API keys in exception text."""
    try:
        response = client.get(url, params=params, headers=headers)
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        detail = ""
        try:
            payload = exc.response.json()
            if isinstance(payload, dict):
                detail = str(payload.get("message") or payload.get("error") or "").strip()
        except Exception:
            pass
        for secret_name in ("api_key", "apikey"):
            secret = params.get(secret_name)
            if secret:
                detail = detail.replace(str(secret), "[redacted]")
        suffix = f": {detail}" if detail else ""
        raise ValueError(f"{source} HTTP {exc.response.status_code}{suffix}") from exc
    except httpx.HTTPError as exc:
        raise ValueError(f"{source} 请求失败: {type(exc).__name__}") from exc
    try:
        return response.json()
    except Exception as exc:
        raise ValueError(f"{source} 返回不是有效 JSON") from exc
