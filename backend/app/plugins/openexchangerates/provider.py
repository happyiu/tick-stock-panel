"""Open Exchange Rates latest exchange-rate provider.

The API returns USD-based rates.  This provider only owns the current snapshot
path; bounded historical ranges deliberately remain on Frankfurter/CFETS.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Any

import httpx

from app import secrets_store

API_KEY_ENV = "OPENEXCHANGERATES_APP_ID"
SECRETS_FIELD = "openexchangerates_api_key"
BASE_URL = "https://openexchangerates.org/api"
SOURCE = "OPEN_EXCHANGE_RATES"
DERIVED_SOURCE = "OPEN_EXCHANGE_RATES_DERIVED"
FREQUENCY = "latest"

_REQUIRED_QUOTES = ("CNY", "CNH", "JPY", "HKD", "EUR", "GBP", "CAD", "SEK", "CHF")
_DXY_WEIGHTS = {
    "EUR": -0.576,
    "JPY": 0.136,
    "GBP": -0.119,
    "CAD": 0.091,
    "SEK": 0.042,
    "CHF": 0.036,
}
_DXY_INVERTED_QUOTES = frozenset({"EUR", "GBP"})
_DXY_CONSTANT = 50.14348112


def get_api_key() -> str:
    return secrets_store.get_env_backed_secret(SECRETS_FIELD, API_KEY_ENV)


def availability() -> tuple[bool, str]:
    """Return whether an App ID is configured, without making a network call."""
    if get_api_key():
        return True, "ok"
    return False, f"缺少 App ID(可在下方输入框直接填写,或配置环境变量 {API_KEY_ENV})"


def _request(client: httpx.Client, api_key: str) -> dict[str, Any]:
    try:
        response = client.get(
            f"{BASE_URL}/latest.json",
            params={
                "app_id": api_key,
                "symbols": ",".join(_REQUIRED_QUOTES),
            },
        )
    except httpx.HTTPError as exc:
        # HTTPX errors may include the request URL, which contains the App ID.
        raise ValueError(f"Open Exchange Rates 请求失败: {type(exc).__name__}") from exc
    try:
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        # Do not include exc.request.url: it contains the App ID query parameter.
        raise ValueError(f"Open Exchange Rates HTTP {exc.response.status_code}") from exc
    try:
        payload = response.json()
    except Exception as exc:
        raise ValueError("Open Exchange Rates 返回不是有效 JSON") from exc
    if not isinstance(payload, dict):
        raise ValueError("Open Exchange Rates 返回格式不是对象")
    if payload.get("error"):
        description = payload.get("description") or payload.get("message") or "API 返回错误"
        raise ValueError(f"Open Exchange Rates: {description}")
    return payload


def probe_api_key(api_key: str) -> tuple[bool, str]:
    """Probe a candidate App ID before the settings API persists it."""
    try:
        with httpx.Client(timeout=10.0) as client:
            _request(client, api_key)
        return True, "ok"
    except (httpx.HTTPError, OSError, ValueError) as exc:
        return False, f"App ID 无效或网络失败: {exc}"


@dataclass
class _OpenExchangeRatesConfig:
    """Minimal loader-compatible metadata for a built-in provider."""

    name: str = "openexchangerates"
    display_name: str = "Open Exchange Rates"
    datasets: dict = field(default_factory=lambda: {"exchange_rate": {}})
    path: None = None
    builtin: bool = True


def _positive_rate(rates: dict[str, Any], currency: str) -> float:
    try:
        rate = float(rates[currency])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError(f"Open Exchange Rates 缺少 {currency} 汇率") from exc
    if not math.isfinite(rate) or rate <= 0:
        raise ValueError(f"Open Exchange Rates {currency} 汇率必须是正数")
    return rate


def _snapshot_date(timestamp: Any) -> date:
    try:
        value = int(timestamp)
        return datetime.fromtimestamp(value, tz=UTC).date()
    except (TypeError, ValueError, OSError, OverflowError) as exc:
        raise ValueError("Open Exchange Rates timestamp 无效") from exc


class OpenExchangeRatesProvider:
    """Fetch the latest Open Exchange Rates snapshot and derive project rows."""

    name = "openexchangerates"
    display_name = "Open Exchange Rates"

    def __init__(self) -> None:
        self.config = _OpenExchangeRatesConfig()
        self._client = httpx.Client(timeout=30.0)

    def close(self) -> None:
        self._client.close()

    def get_exchange_rates(
        self,
        start: date | None = None,
        end: date | None = None,
    ) -> list[dict[str, Any]]:
        if start is not None or end is not None:
            raise ValueError("Open Exchange Rates 仅用于当前快照, 历史范围请使用 Frankfurter")
        payload = _request(self._client, get_api_key())
        rates = payload.get("rates")
        if not isinstance(rates, dict):
            raise ValueError("Open Exchange Rates 返回缺少 rates")
        quote_date = _snapshot_date(payload.get("timestamp"))
        retrieved_at = datetime.now(UTC).isoformat()

        usd_cny = _positive_rate(rates, "CNY")
        rows = [
            self._row("USD/CNY", "USD", "CNY", usd_cny, quote_date, retrieved_at),
            self._row("USD/CNH", "USD", "CNH", _positive_rate(rates, "CNH"), quote_date, retrieved_at),
            self._row(
                "JPY/CNY", "JPY", "CNY", usd_cny / _positive_rate(rates, "JPY"),
                quote_date, retrieved_at,
            ),
            self._row(
                "HKD/CNY", "HKD", "CNY", usd_cny / _positive_rate(rates, "HKD"),
                quote_date, retrieved_at,
            ),
            self._row(
                "EUR/CNY", "EUR", "CNY", usd_cny / _positive_rate(rates, "EUR"),
                quote_date, retrieved_at,
            ),
        ]

        dxy = _DXY_CONSTANT
        for currency, weight in _DXY_WEIGHTS.items():
            component = _positive_rate(rates, currency)
            if currency in _DXY_INVERTED_QUOTES:
                component = 1 / component
            dxy *= component ** weight
        if not math.isfinite(dxy) or dxy <= 0:
            raise ValueError("Open Exchange Rates DXY 计算结果无效")
        rows.append(self._row(
            "DXY", "USD", "DXY", dxy, quote_date, retrieved_at,
            source=DERIVED_SOURCE,
        ))
        return sorted(rows, key=lambda row: row["symbol"])

    @staticmethod
    def _row(
        symbol: str,
        base: str,
        quote: str,
        rate: float,
        quote_date: date,
        retrieved_at: str,
        *,
        source: str = SOURCE,
    ) -> dict[str, Any]:
        if not math.isfinite(rate) or rate <= 0:
            raise ValueError(f"Open Exchange Rates {symbol} 汇率必须是正数")
        return {
            "symbol": symbol,
            "date": quote_date,
            "base": base,
            "quote": quote,
            "rate": rate,
            "source": source,
            "frequency": FREQUENCY,
            "retrieved_at": retrieved_at,
        }
