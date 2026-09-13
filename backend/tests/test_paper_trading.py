from datetime import date, datetime

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.paper_trading import router
from app.services.paper_trading import (
    PaperTradingEngine,
    PaperTradingError,
    PaperTradingStore,
)


class _PriceRepo:
    def get_name_map(self, symbols):
        return {symbol: "沪深300ETF" for symbol in symbols}

    def get_enriched_latest_asset(self, asset_type, refresh=False):
        import polars as pl

        return (
            pl.DataFrame(
                {
                    "symbol": ["510300"],
                    "date": [date(2026, 1, 5)],
                    "close": [4.2],
                }
            ),
            date(2026, 1, 5),
        )

    def get_etf_daily(self, symbol, start, end, columns=None):
        import polars as pl

        return pl.DataFrame(
            {
                "symbol": [symbol],
                "date": [date(2026, 1, 4)],
                "close": [4.2],
            }
        )


def _engine(tmp_path, *, cycle="T0", repo=None):
    engine = PaperTradingEngine(PaperTradingStore(tmp_path), repo)
    account_id = engine.create_replay("test", date(2026, 1, 5), date(2026, 1, 7), 1_000_000)
    engine.set_instrument_rule("510300", cycle, 100, 0.001)
    return engine, account_id


def _bar(minute, open_=4.0, high=4.1, low=3.9, close=4.0):
    return {
        "datetime": datetime(2026, 1, 5, 9, minute),
        "open": open_,
        "high": high,
        "low": low,
        "close": close,
    }


def _order(engine, account_id, **overrides):
    payload = {
        "idempotency_key": "key-1",
        "symbol": "510300",
        "side": "buy",
        "order_type": "market",
        "quantity": 100,
    }
    payload.update(overrides)
    return engine.create_order(account_id, payload)


def test_market_order_waits_for_next_minute_and_is_idempotent(tmp_path):
    engine, account_id = _engine(tmp_path)
    order = _order(engine, account_id)
    assert _order(engine, account_id)["id"] == order["id"]
    assert engine.process_bar(account_id, "510300", _bar(30)) is True
    assert engine.process_bar(account_id, "510300", _bar(31)) is True
    snapshot = engine.snapshot(account_id)
    assert snapshot["orders"][0]["status"] == "filled"
    assert snapshot["orders"][0]["filled_price"] == pytest.approx(4.002)
    assert snapshot["positions"][0]["quantity"] == 100
    assert engine.process_bar(account_id, "510300", _bar(31)) is False


@pytest.mark.parametrize(
    ("side", "limit", "bar", "expected"),
    [
        ("buy", 4.0, _bar(31, open_=3.95), 3.95),
        ("buy", 4.0, _bar(31, open_=4.05, low=3.99), 4.0),
        ("sell", 4.0, _bar(33, open_=4.05), 4.05),
        ("sell", 4.0, _bar(33, open_=3.95, high=4.01), 4.0),
    ],
)
def test_limit_orders_get_open_improvement_or_limit(side, limit, bar, expected, tmp_path):
    engine, account_id = _engine(tmp_path)
    if side == "sell":
        _order(engine, account_id)
        engine.process_bar(account_id, "510300", _bar(31))
    order = _order(
        engine,
        account_id,
        idempotency_key=f"{side}-limit",
        side=side,
        order_type="limit",
        limit_price=limit,
    )
    engine.process_bar(account_id, "510300", bar)
    rows = {row["id"]: row for row in engine.snapshot(account_id)["orders"]}
    assert rows[order["id"]]["filled_price"] == pytest.approx(expected)


def test_untouched_day_order_expires(tmp_path):
    engine, account_id = _engine(tmp_path)
    order = _order(engine, account_id, order_type="limit", limit_price=3.0)
    engine.process_bar(
        account_id,
        "510300",
        {**_bar(31), "datetime": datetime(2026, 1, 5, 15, 0)},
    )
    rows = {row["id"]: row for row in engine.snapshot(account_id)["orders"]}
    assert rows[order["id"]]["status"] == "expired"


def test_t1_blocks_same_day_sell_and_unlocks_next_day(tmp_path):
    engine, account_id = _engine(tmp_path, cycle="T1")
    _order(engine, account_id)
    engine.process_bar(account_id, "510300", _bar(31))
    with pytest.raises(PaperTradingError, match="可卖数量不足"):
        _order(engine, account_id, idempotency_key="sell-today", side="sell")
    with engine.store.connection() as con:
        con.execute(
            "UPDATE accounts SET replay_cursor=? WHERE id=?",
            ("2026-01-06T09:30:00", account_id),
        )
    assert (
        _order(engine, account_id, idempotency_key="sell-next", side="sell")["status"] == "queued"
    )


def test_default_rule_is_t1_and_can_be_overridden(tmp_path):
    engine = PaperTradingEngine(PaperTradingStore(tmp_path))
    account_id = engine.create_replay("test", date(2026, 1, 5), date(2026, 1, 5), 1_000_000)

    assert engine.instrument_rule("510300")["settlement_cycle"] == "T1"
    _order(engine, account_id)
    engine.process_bar(account_id, "510300", _bar(31))
    with pytest.raises(PaperTradingError, match="可卖数量不足"):
        _order(engine, account_id, idempotency_key="sell-today", side="sell")
    with pytest.raises(PaperTradingError, match="暂不能修改"):
        engine.set_instrument_rule("510300", "T0", 100, 0.001)

    override = PaperTradingEngine(PaperTradingStore(tmp_path / "override"))
    override_account_id = override.create_replay(
        "test", date(2026, 1, 5), date(2026, 1, 5), 1_000_000
    )
    override.set_instrument_rule("510300", "T0", 100, 0.001)
    assert override.instrument_rule("510300")["settlement_cycle"] == "T0"
    _order(override, override_account_id)
    override.process_bar(override_account_id, "510300", _bar(31))
    with pytest.raises(PaperTradingError, match="暂不能修改"):
        override.set_instrument_rule("510300", "T1", 100, 0.001)


def test_manual_position_updates_snapshot_metrics_and_cash(tmp_path):
    engine, account_id = _engine(tmp_path, repo=_PriceRepo())

    snapshot = engine.add_manual_position(account_id, "510300", 100, 4.0)

    position = snapshot["positions"][0]
    assert position["quantity"] == 100
    assert position["editable"] is True
    assert position["available_quantity"] == 100
    assert position["average_cost"] == pytest.approx(4.0)
    assert position["last_price"] == pytest.approx(4.2)
    assert position["market_value"] == pytest.approx(420.0)
    assert position["unrealized_pnl"] == pytest.approx(20.0)
    assert position["price_time"] == "2026-01-04T15:00:00"
    assert snapshot["summary"]["cash"] == pytest.approx(999_600.0)
    assert snapshot["summary"]["equity"] == pytest.approx(1_000_020.0)
    assert snapshot["summary"]["total_pnl"] == pytest.approx(20.0)
    assert snapshot["summary"]["unrealized_pnl"] == pytest.approx(20.0)
    assert len(snapshot["equity_curve"]) == 1


def test_position_description_is_persisted_per_account_and_symbol(tmp_path):
    engine, account_id = _engine(tmp_path, repo=_PriceRepo())
    engine.add_manual_position(account_id, "510300", 100, 4.0)

    description = "分批观察\n等待趋势确认"
    updated = engine.update_position_description(account_id, "510300", description)

    assert updated["positions"][0]["description"] == description
    with engine.store.connection() as con:
        row = con.execute(
            "SELECT description FROM position_notes WHERE account_id=? AND symbol=?",
            (account_id, "510300"),
        ).fetchone()
    assert row["description"] == description

    reloaded = PaperTradingEngine(PaperTradingStore(tmp_path), _PriceRepo())
    assert reloaded.snapshot(account_id)["positions"][0]["description"] == description
    assert reloaded.update_position_description(account_id, "510300", "")["positions"][0]["description"] == ""


def test_manual_position_can_be_edited_and_deleted(tmp_path):
    engine, account_id = _engine(tmp_path, repo=_PriceRepo())

    engine.add_manual_position(account_id, "510300", 100, 4.0)
    edited = engine.edit_manual_position(account_id, "510300", 200, 3.5)

    position = edited["positions"][0]
    assert position["editable"] is True
    assert position["quantity"] == 200
    assert position["average_cost"] == pytest.approx(3.5)
    assert position["last_price"] == pytest.approx(4.2)
    assert position["market_value"] == pytest.approx(840.0)
    assert position["unrealized_pnl"] == pytest.approx(140.0)
    assert edited["summary"]["cash"] == pytest.approx(999_300.0)
    assert edited["summary"]["equity"] == pytest.approx(1_000_140.0)

    deleted = engine.delete_manual_position(account_id, "510300")
    assert deleted["positions"] == []
    assert deleted["summary"]["cash"] == pytest.approx(1_000_000.0)
    assert deleted["summary"]["equity"] == pytest.approx(1_000_000.0)


def test_position_equity_curve_tracks_the_selected_holding(tmp_path):
    engine, account_id = _engine(tmp_path, repo=_PriceRepo())

    initial = engine.add_manual_position(account_id, "510300", 100, 4.0)
    first = initial["position_equity_curves"]["510300"][0]
    assert first["market_value"] == pytest.approx(420.0)
    assert first["total_pnl"] == pytest.approx(20.0)
    assert first["return_rate"] == pytest.approx(0.05)
    assert first["drawdown"] == pytest.approx(0.0)

    engine.process_bar(account_id, "510300", _bar(31, close=4.0))
    points = engine.snapshot(account_id)["position_equity_curves"]["510300"]
    assert len(points) == 2
    assert points[-1]["equity"] == pytest.approx(400.0)
    assert points[-1]["return_rate"] == pytest.approx(0.0)
    assert points[-1]["drawdown"] == pytest.approx(-20 / 420)


def test_matched_position_is_not_editable(tmp_path):
    engine, account_id = _engine(tmp_path)
    _order(engine, account_id)
    engine.process_bar(account_id, "510300", _bar(30))
    engine.process_bar(account_id, "510300", _bar(31))

    assert engine.snapshot(account_id)["positions"][0]["editable"] is False
    with pytest.raises(PaperTradingError, match="手动录入"):
        engine.edit_manual_position(account_id, "510300", 200, 4.0)
    with pytest.raises(PaperTradingError, match="手动录入"):
        engine.delete_manual_position(account_id, "510300")


def test_manual_position_without_rule_can_confirm_rule_later(tmp_path):
    engine = PaperTradingEngine(PaperTradingStore(tmp_path), _PriceRepo())
    account_id = engine.create_replay("test", date(2026, 1, 5), date(2026, 1, 5), 1_000_000)

    snapshot = engine.add_manual_position(account_id, "510300", 100, 4.0)
    assert snapshot["positions"][0]["available_quantity"] == 100
    engine.set_instrument_rule("510300", "T1", 100, 0.001)
    assert engine.snapshot(account_id)["positions"][0]["available_quantity"] == 100


def test_buy_order_checks_cash_before_accepting_known_limit(tmp_path):
    engine, account_id = _engine(tmp_path)
    engine.update_config(
        account_id,
        {
            "max_exposure_pct": 1.0,
            "max_symbol_exposure_pct": 1.0,
        },
    )
    with pytest.raises(PaperTradingError, match="可用资金不足"):
        _order(engine, account_id, order_type="limit", limit_price=20_000)


def test_lot_quantity_is_normalized_to_shares(tmp_path):
    engine, account_id = _engine(tmp_path)
    order = _order(engine, account_id, quantity=2, quantity_unit="lots")
    assert order["quantity"] == 200


def test_oco_same_minute_chooses_stop_and_child_waits_one_bar(tmp_path):
    engine, account_id = _engine(tmp_path)
    _order(engine, account_id)
    engine.process_bar(account_id, "510300", _bar(31))
    engine.create_condition(
        account_id,
        {
            "kind": "oco",
            "symbol": "510300",
            "side": "sell",
            "quantity": 100,
            "take_profit_price": 4.2,
            "stop_loss_price": 3.8,
            "child_order_type": "market",
        },
    )
    engine.process_bar(account_id, "510300", _bar(32, high=4.3, low=3.7))
    snapshot = engine.snapshot(account_id)
    by_direction = {row["direction"]: row for row in snapshot["conditions"]}
    assert by_direction["below"]["status"] == "triggered"
    assert "分钟内顺序不可判定" in by_direction["below"]["reason"]
    assert by_direction["above"]["status"] == "cancelled"
    assert snapshot["positions"][0]["quantity"] == 100
    engine.process_bar(account_id, "510300", _bar(33))
    assert engine.snapshot(account_id)["positions"] == []


def test_price_condition_requires_crossing_not_just_being_above(tmp_path):
    engine, account_id = _engine(tmp_path)
    engine.set_instrument_rule("510300", "T0", 100, 0.001)
    engine.process_bar(account_id, "510300", _bar(30, open_=4.2, high=4.3, low=4.1, close=4.2))
    engine.create_condition(
        account_id,
        {
            "kind": "single",
            "symbol": "510300",
            "side": "buy",
            "quantity": 100,
            "direction": "above",
            "trigger_price": 4.1,
            "child_order_type": "market",
        },
    )
    engine.process_bar(account_id, "510300", _bar(31, open_=4.2, high=4.3, low=4.1, close=4.2))
    row = engine.snapshot(account_id)["conditions"][0]
    assert row["status"] == "armed"
    engine.create_condition(
        account_id,
        {
            "kind": "single",
            "symbol": "510300",
            "side": "buy",
            "quantity": 100,
            "direction": "above",
            "trigger_price": 4.3,
            "child_order_type": "market",
        },
    )
    engine.process_bar(account_id, "510300", _bar(32, open_=4.2, high=4.4, low=4.1))
    rows = {x["trigger_price"]: x for x in engine.snapshot(account_id)["conditions"]}
    assert rows[4.3]["status"] == "triggered"


def test_replay_clock_and_visible_bars_never_expose_future(tmp_path):
    class Repo:
        def get_name_map(self, symbols):
            return {}

        def get_minute_batch(self, symbols, day, asset_type):
            import polars as pl

            return pl.DataFrame(
                {
                    "symbol": [symbols[0], symbols[0]],
                    "datetime": [datetime(2026, 1, 5, 9, 31), datetime(2026, 1, 5, 9, 32)],
                    "open": [4.0, 4.0],
                    "high": [4.1, 4.1],
                    "low": [3.9, 3.9],
                    "close": [4.0, 4.0],
                    "volume": [1.0, 1.0],
                    "amount": [4.0, 4.0],
                }
            )

    engine = PaperTradingEngine(PaperTradingStore(tmp_path), Repo())
    account_id = engine.create_replay("test", date(2026, 1, 5), date(2026, 1, 5), 1_000_000)
    assert engine.visible_replay_bars(account_id, "510300") == []
    engine.step_replay(account_id)
    bars = engine.visible_replay_bars(account_id, "510300")
    assert [row["datetime"].minute for row in bars] == [31]


def test_paper_trading_api_snapshot_rule_and_idempotent_order(tmp_path):
    app = FastAPI()
    engine = PaperTradingEngine(PaperTradingStore(tmp_path))
    app.state.paper_trading_engine = engine
    app.include_router(router)
    client = TestClient(app)

    default_rule = client.get("/api/paper-trading/rules/510300")
    assert default_rule.status_code == 200
    assert default_rule.json()["settlement_cycle"] == "T1"

    setup = client.get("/api/paper-trading/snapshot")
    assert setup.status_code == 200
    assert setup.json()["setup_required"] is True
    snapshot = client.post(
        "/api/paper-trading/live/setup",
        json={"name": "实时模拟账户"},
    ).json()
    account_id = snapshot["account"]["id"]
    assert (
        client.put(
            f"/api/paper-trading/accounts/{account_id}/config",
            json={"slippage_bps": 7},
        ).status_code
        == 200
    )
    assert (
        client.put(
            "/api/paper-trading/rules/510300",
            json={
                "settlement_cycle": "T0",
                "lot_size": 100,
                "price_tick": 0.001,
            },
        ).status_code
        == 200
    )
    payload = {
        "account_id": account_id,
        "idempotency_key": "browser-double-click",
        "symbol": "510300",
        "side": "buy",
        "order_type": "market",
        "quantity": 100,
    }
    first = client.post("/api/paper-trading/orders", json=payload)
    second = client.post("/api/paper-trading/orders", json=payload)
    assert first.status_code == 200
    assert second.json()["id"] == first.json()["id"]


def test_paper_trading_api_manual_position_returns_recalculated_snapshot(tmp_path):
    app = FastAPI()
    engine = PaperTradingEngine(PaperTradingStore(tmp_path), _PriceRepo())
    app.state.paper_trading_engine = engine
    app.include_router(router)
    client = TestClient(app)
    account_id = engine.create_live_account("手动持仓账户")

    response = client.post(
        "/api/paper-trading/positions/manual",
        json={
            "account_id": account_id,
            "symbol": "510300",
            "quantity": 100,
            "average_cost": 4.0,
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["positions"][0]["market_value"] == pytest.approx(420.0)
    assert body["positions"][0]["editable"] is True
    assert body["summary"]["cash"] == pytest.approx(999_600.0)
    assert body["summary"]["total_pnl"] == pytest.approx(20.0)

    described = client.put(
        "/api/paper-trading/positions/description",
        json={
            "account_id": account_id,
            "symbol": "510300",
            "description": "API 备注",
        },
    )
    assert described.status_code == 200
    assert described.json()["positions"][0]["description"] == "API 备注"

    edited = client.put(
        "/api/paper-trading/positions/manual",
        json={
            "account_id": account_id,
            "symbol": "510300",
            "quantity": 200,
            "average_cost": 3.5,
        },
    )
    assert edited.status_code == 200
    assert edited.json()["positions"][0]["quantity"] == 200
    assert edited.json()["summary"]["cash"] == pytest.approx(999_300.0)

    deleted = client.delete(
        "/api/paper-trading/positions/manual/510300",
        params={"account_id": account_id},
    )
    assert deleted.status_code == 200
    assert deleted.json()["positions"] == []


def test_live_account_setup_archives_previous_account_without_recreating(tmp_path):
    engine = PaperTradingEngine(PaperTradingStore(tmp_path))
    first_id = engine.create_live_account("第一账户")

    engine.rebuild_live()

    assert engine.store.live_account_id() is None
    assert engine.store.account(first_id)["archived"] == 1
    second_id = engine.create_live_account("第二账户")
    assert second_id != first_id
    assert engine.store.live_account_id() == second_id


def test_deleting_archived_account_clears_all_account_records(tmp_path):
    engine, account_id = _engine(tmp_path)
    _order(engine, account_id)
    engine.process_bar(account_id, "510300", _bar(30))
    engine.process_bar(account_id, "510300", _bar(31))
    engine.update_position_description(account_id, "510300", "归档前备注")
    engine.create_condition(
        account_id,
        {
            "kind": "single",
            "symbol": "510300",
            "side": "buy",
            "quantity": 100,
            "direction": "above",
            "trigger_price": 4.2,
            "child_order_type": "market",
        },
    )
    engine.control_replay(account_id, "archive")

    with engine.store.connection() as con:
        before = {
            table: con.execute(
                f"SELECT COUNT(*) AS count FROM {table} WHERE account_id=?", (account_id,)
            ).fetchone()["count"]
            for table in (
                "orders",
                "conditions",
                "fills",
                "position_lots",
                "cash_ledger",
                "prices",
                "equity_points",
                "position_equity_points",
                "position_notes",
                "processed_bars",
            )
        }
    assert before["orders"]
    assert before["conditions"]
    assert before["fills"]

    engine.delete_archived_account(account_id)

    with engine.store.connection() as con:
        assert con.execute("SELECT 1 FROM accounts WHERE id=?", (account_id,)).fetchone() is None
        for table in before:
            assert con.execute(
                f"SELECT COUNT(*) AS count FROM {table} WHERE account_id=?", (account_id,)
            ).fetchone()["count"] == 0


def test_archived_account_api_lists_and_deletes_only_archived_accounts(tmp_path):
    app = FastAPI()
    engine = PaperTradingEngine(PaperTradingStore(tmp_path))
    app.state.paper_trading_engine = engine
    app.include_router(router)
    client = TestClient(app)

    account_id = engine.create_live_account("待归档账户")
    assert client.delete(f"/api/paper-trading/accounts/{account_id}").status_code == 400

    engine.rebuild_live()
    listed = client.get("/api/paper-trading/accounts/archived")
    assert listed.status_code == 200
    assert [item["id"] for item in listed.json()["items"]] == [account_id]

    deleted = client.delete(f"/api/paper-trading/accounts/{account_id}")
    assert deleted.status_code == 200
    assert deleted.json() == {"ok": True}
    assert client.get("/api/paper-trading/accounts/archived").json()["items"] == []
