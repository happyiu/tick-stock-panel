"""外部因子入口回归: 动态扩展字段必须能直接进入兼容因子列视图。"""
from __future__ import annotations

import pytest

from app.factors import ext_factors
from app.factors.registry import factor_columns_view
from app.services.ext_data import ExtConfig, ExtConfigStore, ExtField


@pytest.fixture(autouse=True)
def _isolate_runtime_ext_factors(tmp_path, monkeypatch):
    from app import config as app_config
    from app.factors import registry

    monkeypatch.setattr(app_config.settings, "data_dir", tmp_path)
    ext_factors._frame_cache.clear()
    ext_factors._sync_state = None
    for factor_id in [key for key in list(registry._REGISTRY) if key.startswith(ext_factors.EXT_PREFIX)]:
        registry._REGISTRY.pop(factor_id, None)
    yield
    ext_factors._frame_cache.clear()
    ext_factors._sync_state = None
    for factor_id in [key for key in list(registry._REGISTRY) if key.startswith(ext_factors.EXT_PREFIX)]:
        registry._REGISTRY.pop(factor_id, None)


def test_factor_columns_view_syncs_new_external_numeric_fields(tmp_path):
    store = ExtConfigStore(tmp_path)
    store.upsert(ExtConfig(
        id="fund_flow",
        label="资金流",
        mode="timeseries",
        fields=[ExtField(name="score", dtype="float", label="资金流评分")],
    ))

    columns = factor_columns_view()

    item = next(item for item in columns if item["id"] == "ext_fund_flow_score")
    assert item["label"] == "资金流·资金流评分"
    assert item["group"] == "扩展数据"
