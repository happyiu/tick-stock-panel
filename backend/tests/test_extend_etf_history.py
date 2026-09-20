from datetime import date
from types import SimpleNamespace

import polars as pl

from app.services import extend_etf_history, index_sync


class _Repo:
    def __init__(self, data_dir):
        self.store = SimpleNamespace(data_dir=data_dir)

    def earliest_daily_date(self, asset_type="stock"):
        assert asset_type == "etf"
        return date(2024, 9, 9)

    def get_etf_instruments(self):
        return pl.DataFrame({"symbol": ["510300.SH", "159915.SZ", "510300.SH"]})

    def refresh_index_views(self):
        pass


def test_run_extend_etf_history_uses_etf_storage_and_date_range(monkeypatch, tmp_path):
    calls = {}

    def fake_sync(repo, capset, **kwargs):
        calls.update(kwargs)
        return 123

    monkeypatch.setattr(index_sync, "sync_and_persist_etf_daily", fake_sync)
    events = []
    result = extend_etf_history.run_extend_etf_history(
        _Repo(tmp_path),
        SimpleNamespace(has=lambda _cap: True),
        value=1,
        unit="year",
        on_progress=lambda stage, pct, msg, **kwargs: events.append((stage, pct, msg)),
    )

    assert calls["symbols_override"] == ["159915.SZ", "510300.SH"]
    assert calls["start_date"].date() == date(2023, 9, 10)
    assert calls["end_date"].date() == date(2024, 9, 9)
    assert result["asset_type"] == "etf"
    assert result["etf_daily_rows"] == 123
    assert result["earliest_before"] == "2024-09-09"
    assert result["earliest_after"] == "2023-09-10"
    assert events[-1][0] == "extend_etf_history"
    assert events[-1][1] == 100


def test_run_extend_etf_history_can_repair_explicit_range(monkeypatch, tmp_path):
    calls = {}

    def fake_sync(repo, capset, **kwargs):
        calls.update(kwargs)
        return 456

    monkeypatch.setattr(index_sync, "sync_and_persist_etf_daily", fake_sync)
    result = extend_etf_history.run_extend_etf_history(
        _Repo(tmp_path),
        SimpleNamespace(has=lambda _cap: True),
        value=1,
        unit="year",
        start_date=date(2023, 9, 10),
        end_date=date(2024, 9, 9),
    )

    assert calls["start_date"].date() == date(2023, 9, 10)
    assert calls["end_date"].date() == date(2024, 9, 9)
    assert result["mode"] == "range"
    assert result["requested_start"] == "2023-09-10"
    assert result["requested_end"] == "2024-09-09"
    assert result["etf_daily_rows"] == 456


def test_run_extend_etf_history_requires_existing_etf_data(monkeypatch, tmp_path):
    class EmptyRepo(_Repo):
        def earliest_daily_date(self, asset_type="stock"):
            assert asset_type == "etf"
            return None

    result = extend_etf_history.run_extend_etf_history(
        EmptyRepo(tmp_path),
        SimpleNamespace(has=lambda _cap: True),
        value=1,
        unit="year",
    )

    assert result == {"error": "本地无 ETF 日K数据,请先执行一次 ETF 同步"}
