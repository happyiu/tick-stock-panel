"""全市场维表只有在所有交易所拉取成功后才可替换。"""
from types import SimpleNamespace

import polars as pl
import pytest
from polars.testing import assert_frame_equal

from app.services import instrument_sync


def _client(monkeypatch, incomplete=None, raises=False):
    def get_instruments(exchange, **kwargs):
        if exchange == incomplete:
            if raises:
                raise ConnectionError("unavailable")
            return []
        return [{"symbol": f"600000.{exchange}", "name": exchange, "exchange": exchange}]

    monkeypatch.setattr(instrument_sync, "_fetch_instruments_via_provider", lambda: None)
    monkeypatch.setattr(instrument_sync, "get_client", lambda: SimpleNamespace(
        exchanges=SimpleNamespace(get_instruments=get_instruments),
    ))


@pytest.mark.parametrize("exchange", ["SH", "SZ", "BJ"])
@pytest.mark.parametrize("raises", [False, True])
@pytest.mark.parametrize("existing", [False, True])
def test_partial_exchange_sync_does_not_publish(tmp_path, monkeypatch, raises, existing, exchange):
    _client(monkeypatch, incomplete=exchange, raises=raises)
    path = tmp_path / "instruments" / "instruments.parquet"
    old = pl.DataFrame({"symbol": ["600519.SH"], "name": ["贵州茅台"]})
    if existing:
        path.parent.mkdir()
        old.write_parquet(path)

    assert instrument_sync.sync_instruments(tmp_path) == 0
    if existing:
        assert_frame_equal(pl.read_parquet(path), old)
    else:
        assert not path.exists()


def test_complete_exchange_sync_publishes_all_markets(tmp_path, monkeypatch):
    _client(monkeypatch)
    assert instrument_sync.sync_instruments(tmp_path) == 3
    result = pl.read_parquet(tmp_path / "instruments" / "instruments.parquet")
    assert set(result["exchange"]) == {"SH", "SZ", "BJ"}
