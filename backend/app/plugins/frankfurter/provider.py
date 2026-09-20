"""Frankfurter daily exchange-rate provider."""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Any

import httpx

FRANKFURTER_API_URL = "https://api.frankfurter.dev/v2"
# 保留这个名字, 兼容已有测试和调用方对 CFETS 路由的引用。
BASE_URL = f"{FRANKFURTER_API_URL}/providers/cfets"
BASE_CURRENCY = "USD"
QUOTE_CURRENCY = "CNY"
CFETS_SOURCE = "CFETS"
FRANKFURTER_SOURCE = "FRANKFURTER"
DERIVED_SOURCE = "FRANKFURTER_DERIVED"
# 兼容第一版 Provider 的来源常量。
SOURCE = CFETS_SOURCE
FREQUENCY = "1d"

# CNY 使用 CFETS 中间价; CNH 使用 Frankfurter 默认混合源。
SUPPORTED_PAIRS = (
    ("USD/CNY", "USD", "CNY", BASE_URL, CFETS_SOURCE),
    ("JPY/CNY", "JPY", "CNY", BASE_URL, CFETS_SOURCE),
    ("HKD/CNY", "HKD", "CNY", BASE_URL, CFETS_SOURCE),
    ("EUR/CNY", "EUR", "CNY", BASE_URL, CFETS_SOURCE),
    ("USD/CNH", "USD", "CNH", FRANKFURTER_API_URL, FRANKFURTER_SOURCE),
)

# Frankfurter 不提供 DXY 指数端点, 按 DXY 固定篮子公式由标准日频汇率派生。
_DXY_QUOTES = ("EUR", "JPY", "GBP", "CAD", "SEK", "CHF")
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


@dataclass
class _FrankfurterConfig:
    """Minimal loader-compatible metadata for a built-in provider."""

    name: str = "frankfurter"
    display_name: str = "Frankfurter"
    datasets: dict = field(default_factory=lambda: {"exchange_rate": {}})
    path: None = None


class FrankfurterProvider:
    """Fetch requested currency pairs and a Frankfurter-derived DXY series."""

    name = "frankfurter"
    display_name = "Frankfurter"

    def __init__(self) -> None:
        self.config = _FrankfurterConfig()
        self._client = httpx.Client(timeout=30.0)

    def close(self) -> None:
        self._client.close()

    def get_exchange_rates(
        self,
        start: date | None = None,
        end: date | None = None,
    ) -> list[dict[str, Any]]:
        range_start, range_end = start, end
        if range_start is not None or range_end is not None:
            range_start = range_start or range_end
            range_end = range_end or range_start
            if range_start is None or range_end is None:
                raise ValueError("汇率日期范围不能为空")
            if range_start > range_end:
                raise ValueError("汇率开始日期不能晚于结束日期")

        retrieved_at = datetime.now(UTC).isoformat()
        rows: list[dict[str, Any]] = []
        for _symbol, base, quote, base_url, source in SUPPORTED_PAIRS:
            if range_start is None:
                payload = self._get(
                    f"/rate/{base.lower()}/{quote.lower()}",
                    base_url=base_url,
                )
            else:
                payload = self._get(
                    "/rates",
                    base_url=base_url,
                    params={
                        "base": base,
                        "quotes": quote,
                        "from": range_start.isoformat(),
                        "to": range_end.isoformat(),
                    },
                )
            rows.extend(self._normalize(
                payload,
                start=range_start,
                end=range_end,
                expected_pair=(base, quote),
                source=source,
                retrieved_at=retrieved_at,
            ))

        component_params = {
            "base": BASE_CURRENCY,
            "quotes": ",".join(_DXY_QUOTES),
        }
        if range_start is not None:
            component_params.update({
                "from": range_start.isoformat(),
                "to": range_end.isoformat(),
            })
        component_payload = self._get(
            "/rates",
            base_url=FRANKFURTER_API_URL,
            params=component_params,
        )
        rows.extend(self._normalize_dxy(
            component_payload,
            start=range_start,
            end=range_end,
            retrieved_at=retrieved_at,
        ))
        return sorted(rows, key=lambda row: (row["date"], row["symbol"]))

    def _get(
        self,
        path: str,
        *,
        base_url: str = FRANKFURTER_API_URL,
        params: dict[str, str] | None = None,
    ) -> Any:
        response = self._client.get(f"{base_url}{path}", params=params)
        response.raise_for_status()
        try:
            return response.json()
        except Exception as exc:
            raise ValueError(f"Frankfurter 返回不是有效 JSON: {exc}") from exc

    @staticmethod
    def _raw_rows(payload: Any) -> list[dict[str, Any]]:
        if isinstance(payload, dict):
            return [payload]
        if isinstance(payload, list):
            return payload
        raise ValueError("Frankfurter 返回格式不是对象或数组")

    @classmethod
    def _normalize(
        cls,
        payload: Any,
        *,
        start: date | None,
        end: date | None,
        expected_pair: tuple[str, str] = (BASE_CURRENCY, QUOTE_CURRENCY),
        source: str = CFETS_SOURCE,
        retrieved_at: str | None = None,
    ) -> list[dict[str, Any]]:
        raw_rows = cls._raw_rows(payload)

        expected_base, expected_quote = expected_pair
        retrieved_at = retrieved_at or datetime.now(UTC).isoformat()
        rows: dict[date, dict[str, Any]] = {}
        for raw in raw_rows:
            if not isinstance(raw, dict):
                raise ValueError("Frankfurter 汇率记录不是对象")
            try:
                quote_date = date.fromisoformat(str(raw["date"]))
                base = str(raw["base"]).upper()
                quote = str(raw["quote"]).upper()
                rate = float(raw["rate"])
            except (KeyError, TypeError, ValueError) as exc:
                raise ValueError(f"Frankfurter 汇率记录字段无效: {raw!r}") from exc
            if base != expected_base or quote != expected_quote:
                raise ValueError(f"不支持的货币对: {base}/{quote}")
            if not math.isfinite(rate) or rate <= 0:
                raise ValueError(f"汇率必须是正数: {rate!r}")
            if start is not None and quote_date < start:
                continue
            if end is not None and quote_date > end:
                continue
            rows[quote_date] = {
                "symbol": f"{base}/{quote}",
                "date": quote_date,
                "base": base,
                "quote": quote,
                "rate": rate,
                "source": source,
                "frequency": FREQUENCY,
                "retrieved_at": retrieved_at,
            }
        return [rows[key] for key in sorted(rows)]

    @classmethod
    def _normalize_dxy(
        cls,
        payload: Any,
        *,
        start: date | None,
        end: date | None,
        retrieved_at: str | None = None,
    ) -> list[dict[str, Any]]:
        retrieved_at = retrieved_at or datetime.now(UTC).isoformat()
        by_date: dict[date, dict[str, float]] = {}
        for raw in cls._raw_rows(payload):
            if not isinstance(raw, dict):
                raise ValueError("Frankfurter DXY 组成记录不是对象")
            try:
                quote_date = date.fromisoformat(str(raw["date"]))
                base = str(raw["base"]).upper()
                quote = str(raw["quote"]).upper()
                rate = float(raw["rate"])
            except (KeyError, TypeError, ValueError) as exc:
                raise ValueError(f"Frankfurter DXY 组成字段无效: {raw!r}") from exc
            if base != BASE_CURRENCY or quote not in _DXY_QUOTES:
                continue
            if not math.isfinite(rate) or rate <= 0:
                raise ValueError(f"DXY 组成汇率必须是正数: {rate!r}")
            if start is not None and quote_date < start:
                continue
            if end is not None and quote_date > end:
                continue
            by_date.setdefault(quote_date, {})[quote] = rate

        rows: list[dict[str, Any]] = []
        for quote_date in sorted(by_date):
            components = by_date[quote_date]
            if any(currency not in components for currency in _DXY_QUOTES):
                continue
            dxy = _DXY_CONSTANT
            for currency, weight in _DXY_WEIGHTS.items():
                component = components[currency]
                if currency in _DXY_INVERTED_QUOTES:
                    component = 1 / component
                dxy *= component ** weight
            if not math.isfinite(dxy) or dxy <= 0:
                raise ValueError(f"DXY 计算结果无效: {dxy!r}")
            rows.append({
                "symbol": "DXY",
                "date": quote_date,
                "base": BASE_CURRENCY,
                "quote": "DXY",
                "rate": dxy,
                "source": DERIVED_SOURCE,
                "frequency": FREQUENCY,
                "retrieved_at": retrieved_at,
            })
        return rows
