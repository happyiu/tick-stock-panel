"""独立外部因子层: 指数/扩展数据按日期广播与相对强弱。"""
from __future__ import annotations

from datetime import date
from pathlib import Path
from types import SimpleNamespace

import polars as pl
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.external_factors import router
from app.external_factors import engine
from app.external_factors.models import ExternalFactorDefinition
from app.external_factors.store import ExternalFactorStore, now
from app.factors.registry import get_factor, unregister_factor
from app.services.ext_data import ExtConfig, ExtConfigStore, ExtField, write_ext_parquet


@pytest.fixture(autouse=True)
def _isolate_external_factors(tmp_path, monkeypatch):
    from app import config as app_config

    monkeypatch.setattr(app_config.settings, "data_dir", tmp_path)
    engine.invalidate(tmp_path)
    yield tmp_path
    engine.invalidate(tmp_path)
    from app.factors.registry import _REGISTRY

    for factor_id in [key for key in list(_REGISTRY) if key.startswith("ef_")]:
        unregister_factor(factor_id)


def _write_index(data_dir: Path) -> None:
    rows = [
        (date(2026, 1, 5), 100.0),
        (date(2026, 1, 6), 110.0),
        (date(2026, 1, 7), 121.0),
    ]
    for day, close in rows:
        target = data_dir / "kline_index_daily" / f"date={day.isoformat()}"
        target.mkdir(parents=True, exist_ok=True)
        pl.DataFrame({
            "symbol": ["000300.SH"], "date": [day], "close": [close],
        }).write_parquet(target / "part.parquet")


def _definition(**overrides) -> ExternalFactorDefinition:
    values = {
        "id": "ef_market_hs300_return_2",
        "label": "沪深300 2日收益",
        "category": "market",
        "operation": "direct",
        "source_type": "index_daily",
        "source_symbol": "000300.SH",
        "source_field": "close",
        "transform": "return",
        "window": 2,
        "status": "active",
        "created_at": now(),
        "updated_at": now(),
    }
    values.update(overrides)
    return ExternalFactorDefinition(**values)


def test_index_return_is_broadcast_by_exact_date(tmp_path):
    _write_index(tmp_path)
    ExternalFactorStore(tmp_path).save(_definition())

    panel = pl.DataFrame({
        "symbol": ["510300.SH"] * 4,
        "date": [date(2026, 1, 5), date(2026, 1, 6), date(2026, 1, 7), date(2026, 1, 8)],
        "close": [10.0, 10.0, 10.0, 10.0],
    })
    result = engine.attach_external_factors(panel, {"ef_market_hs300_return_2"}, tmp_path)

    assert result["ef_market_hs300_return_2"].to_list()[:2] == [None, None]
    assert result["ef_market_hs300_return_2"][2] == pytest.approx(0.21)
    assert result["ef_market_hs300_return_2"][3] is None


def test_factor_backtest_missing_path_materializes_external_factor(tmp_path):
    _write_index(tmp_path)
    ExternalFactorStore(tmp_path).save(_definition())
    from app.backtest.factor import FactorBacktestService

    panel = pl.DataFrame({
        "symbol": ["510300.SH"] * 3,
        "date": [date(2026, 1, 5), date(2026, 1, 6), date(2026, 1, 7)],
        "open": [10.0, 10.0, 10.0],
        "high": [10.0, 10.0, 10.0],
        "low": [10.0, 10.0, 10.0],
        "close": [10.0, 10.0, 10.0],
        "volume": [1.0, 1.0, 1.0],
    })
    result = FactorBacktestService._compute_missing_factors(
        panel, {"ef_market_hs300_return_2"},
    )

    assert result["ef_market_hs300_return_2"][2] == pytest.approx(0.21)


def test_difference_factor_composes_internal_and_external_columns(tmp_path):
    _write_index(tmp_path)
    store = ExternalFactorStore(tmp_path)
    store.save(_definition())
    store.save(_definition(
        id="ef_relative_momentum_vs_hs300",
        label="ETF相对沪深300强弱",
        category="relative",
        operation="difference",
        source_type="factor_pair",
        source_symbol=None,
        source_field=None,
        transform="value",
        window=1,
        left_factor_id="momentum_20d",
        right_factor_id="ef_market_hs300_return_2",
    ))

    panel = pl.DataFrame({
        "symbol": ["510300.SH"] * 3,
        "date": [date(2026, 1, 5), date(2026, 1, 6), date(2026, 1, 7)],
        "close": [10.0, 10.0, 10.0],
        "momentum_20d": [0.1, 0.3, 0.5],
    })
    result = engine.attach_external_factors(panel, {"ef_relative_momentum_vs_hs300"}, tmp_path)

    assert result["ef_relative_momentum_vs_hs300"][2] == pytest.approx(0.29)
    assert get_factor("ef_relative_momentum_vs_hs300") is not None


def test_timeseries_ext_value_is_broadcast_and_api_registers(tmp_path):
    config = ExtConfig(
        id="market_context",
        label="市场环境",
        mode="timeseries",
        fields=[ExtField("score", "float", "环境分数")],
    )
    ExtConfigStore(tmp_path).upsert(config)
    write_ext_parquet(
        pl.DataFrame({"symbol": ["MARKET"], "score": [0.4]}),
        config,
        tmp_path,
        snapshot_date=date(2026, 1, 5),
    )

    app = FastAPI()
    app.include_router(router)
    app.state.repo = SimpleNamespace(store=SimpleNamespace(data_dir=tmp_path))
    client = TestClient(app)
    response = client.post("/api/external-factors", json={
        "id": "ef_market_context_score",
        "label": "市场环境分数",
        "category": "market",
        "operation": "direct",
        "source_type": "ext_timeseries",
        "source_config_id": "market_context",
        "source_field": "score",
        "transform": "value",
        "window": 1,
        "status": "active",
    })
    assert response.status_code == 200
    assert response.json()["factor"]["alignment"] == "date_broadcast"

    panel = pl.DataFrame({
        "symbol": ["510300.SH", "510300.SH"],
        "date": [date(2026, 1, 5), date(2026, 1, 6)],
        "close": [10.0, 10.0],
    })
    result = engine.attach_external_factors(panel, {"ef_market_context_score"}, tmp_path)
    assert result["ef_market_context_score"].to_list() == [pytest.approx(0.4), None]
