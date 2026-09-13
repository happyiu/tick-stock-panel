"""ETF 模拟交易: 事务存储, 分钟撮合, 实时轮询与历史回放.

该模块只产生本地模拟订单. 它不连接券商, 也不复用批量 BacktestEngine 的
编排状态; 仅复用标准分钟数据, 北京时间和交易日能力.
"""

from __future__ import annotations

import logging
import math
import secrets
import sqlite3
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from datetime import time as dt_time
from pathlib import Path
from typing import Any

import polars as pl

from app.market_time import CN_TZ, cn_now, in_continuous_session

logger = logging.getLogger(__name__)

DEFAULT_CONFIG = {
    "initial_cash": 1_000_000.0,
    "commission_rate": 0.0002,
    "minimum_commission": 5.0,
    "slippage_bps": 5.0,
    "max_positions": 10,
    "max_exposure_pct": 1.0,
    "max_symbol_exposure_pct": 0.2,
}
ACTIVE_ORDER_STATUSES = ("queued", "active")
ACTIVE_CONDITION_STATUSES = ("armed", "waiting_sellable")
DEFAULT_SETTLEMENT_CYCLE = "T1"
DEFAULT_LOT_SIZE = 100
DEFAULT_PRICE_TICK = 0.001


class PaperTradingError(ValueError):
    """可直接映射为 4xx 的模拟交易业务错误。"""


def _now_iso() -> str:
    return cn_now().isoformat()


def _id(prefix: str) -> str:
    return f"{prefix}_{int(time.time() * 1000):x}_{secrets.token_hex(3)}"


def _bar_time(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value.replace(tzinfo=None)
    parsed = datetime.fromisoformat(str(value))
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(CN_TZ).replace(tzinfo=None)
    return parsed


def _money(value: float) -> float:
    return round(float(value), 4)


class PaperTradingStore:
    """SQLite v1 存储. 每个写操作独立事务, 跨线程使用进程内互斥."""

    def __init__(self, data_dir: Path):
        root = data_dir / "user_data" / "etf_simulation"
        root.mkdir(parents=True, exist_ok=True)
        self.path = root / "trading.sqlite3"
        self._lock = threading.RLock()
        self._init_schema()

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            con = sqlite3.connect(self.path, timeout=10)
            con.row_factory = sqlite3.Row
            con.execute("PRAGMA foreign_keys=ON")
            con.execute("PRAGMA journal_mode=WAL")
            try:
                with con:
                    yield con
            finally:
                con.close()

    def _init_schema(self) -> None:
        with self.connection() as con:
            con.executescript(
                """
                CREATE TABLE IF NOT EXISTS schema_meta (
                  key TEXT PRIMARY KEY, value TEXT NOT NULL
                );
                INSERT OR IGNORE INTO schema_meta(key,value) VALUES ('version','1');
                CREATE TABLE IF NOT EXISTS accounts (
                  id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('live','replay')),
                  name TEXT NOT NULL, initial_cash REAL NOT NULL, cash REAL NOT NULL,
                  commission_rate REAL NOT NULL, minimum_commission REAL NOT NULL,
                  slippage_bps REAL NOT NULL, max_positions INTEGER NOT NULL,
                  max_exposure_pct REAL NOT NULL, max_symbol_exposure_pct REAL NOT NULL,
                  revision INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
                  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                  replay_start TEXT, replay_end TEXT, replay_cursor TEXT,
                  replay_status TEXT, replay_speed INTEGER NOT NULL DEFAULT 1,
                  runtime_status TEXT NOT NULL DEFAULT 'idle', runtime_message TEXT NOT NULL DEFAULT ''
                );
                CREATE UNIQUE INDEX IF NOT EXISTS one_live_account
                  ON accounts(mode) WHERE mode='live' AND archived=0;
                CREATE TABLE IF NOT EXISTS instrument_rules (
                  symbol TEXT PRIMARY KEY, settlement_cycle TEXT NOT NULL,
                  lot_size INTEGER NOT NULL, price_tick REAL NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS orders (
                  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
                  idempotency_key TEXT NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL,
                  order_type TEXT NOT NULL, quantity INTEGER NOT NULL, limit_price REAL,
                  status TEXT NOT NULL, submitted_at TEXT NOT NULL, eligible_after TEXT NOT NULL,
                  active_date TEXT, filled_at TEXT, filled_price REAL, fee REAL NOT NULL DEFAULT 0,
                  condition_id TEXT, oco_group TEXT, reason TEXT NOT NULL DEFAULT '',
                  UNIQUE(account_id,idempotency_key)
                );
                CREATE INDEX IF NOT EXISTS orders_account_status ON orders(account_id,status);
                CREATE TABLE IF NOT EXISTS conditions (
                  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
                  symbol TEXT NOT NULL, side TEXT NOT NULL, direction TEXT NOT NULL,
                  trigger_price REAL NOT NULL, quantity INTEGER NOT NULL,
                  child_order_type TEXT NOT NULL, child_limit_price REAL,
                  status TEXT NOT NULL, oco_group TEXT, created_at TEXT NOT NULL,
                  triggered_at TEXT, child_order_id TEXT, reason TEXT NOT NULL DEFAULT ''
                );
                CREATE INDEX IF NOT EXISTS conditions_account_status ON conditions(account_id,status);
                CREATE TABLE IF NOT EXISTS fills (
                  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
                  order_id TEXT NOT NULL UNIQUE, symbol TEXT NOT NULL, side TEXT NOT NULL,
                  quantity INTEGER NOT NULL, price REAL NOT NULL, gross REAL NOT NULL,
                  fee REAL NOT NULL, realized_pnl REAL NOT NULL DEFAULT 0, filled_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS position_lots (
                  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
                  symbol TEXT NOT NULL, trade_date TEXT NOT NULL, quantity INTEGER NOT NULL,
                  remaining INTEGER NOT NULL, unit_cost REAL NOT NULL,
                  source TEXT NOT NULL DEFAULT 'trade'
                );
                CREATE INDEX IF NOT EXISTS lots_account_symbol ON position_lots(account_id,symbol);
                CREATE TABLE IF NOT EXISTS cash_ledger (
                  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
                  event_type TEXT NOT NULL, amount REAL NOT NULL, balance REAL NOT NULL,
                  symbol TEXT, order_id TEXT, occurred_at TEXT NOT NULL, note TEXT NOT NULL DEFAULT ''
                );
                CREATE TABLE IF NOT EXISTS prices (
                  account_id TEXT NOT NULL REFERENCES accounts(id), symbol TEXT NOT NULL,
                  price REAL NOT NULL, bar_time TEXT NOT NULL,
                  PRIMARY KEY(account_id,symbol)
                );
                CREATE TABLE IF NOT EXISTS equity_points (
                  account_id TEXT NOT NULL REFERENCES accounts(id), bar_time TEXT NOT NULL,
                  equity REAL NOT NULL, cash REAL NOT NULL, market_value REAL NOT NULL,
                  realized_pnl REAL NOT NULL, unrealized_pnl REAL NOT NULL,
                  drawdown REAL NOT NULL, PRIMARY KEY(account_id,bar_time)
                );
                CREATE TABLE IF NOT EXISTS position_equity_points (
                  account_id TEXT NOT NULL REFERENCES accounts(id), symbol TEXT NOT NULL,
                  bar_time TEXT NOT NULL, equity REAL NOT NULL, market_value REAL NOT NULL,
                  realized_pnl REAL NOT NULL, unrealized_pnl REAL NOT NULL,
                  total_pnl REAL NOT NULL, return_rate REAL NOT NULL,
                  drawdown REAL NOT NULL, capital_base REAL NOT NULL,
                  PRIMARY KEY(account_id,symbol,bar_time)
                );
                CREATE TABLE IF NOT EXISTS position_notes (
                  account_id TEXT NOT NULL REFERENCES accounts(id), symbol TEXT NOT NULL,
                  description TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
                  PRIMARY KEY(account_id,symbol)
                );
                CREATE TABLE IF NOT EXISTS processed_bars (
                  account_id TEXT NOT NULL REFERENCES accounts(id), symbol TEXT NOT NULL,
                  bar_time TEXT NOT NULL, PRIMARY KEY(account_id,symbol,bar_time)
                );
                """
            )
            lot_columns = {
                row["name"] for row in con.execute("PRAGMA table_info(position_lots)").fetchall()
            }
            if "source" not in lot_columns:
                con.execute(
                    "ALTER TABLE position_lots ADD COLUMN source TEXT NOT NULL DEFAULT 'trade'"
                )
            # Older manual imports predate the source column. Recover their
            # marker from the ledger when the symbol has no matched fills.
            con.execute(
                """UPDATE position_lots SET source='manual'
                   WHERE source='trade' AND remaining>0
                     AND EXISTS (
                       SELECT 1 FROM cash_ledger ledger
                       WHERE ledger.account_id=position_lots.account_id
                         AND ledger.symbol=position_lots.symbol
                         AND ledger.event_type='manual_position'
                     )
                     AND NOT EXISTS (
                       SELECT 1 FROM fills fill
                       WHERE fill.account_id=position_lots.account_id
                         AND fill.symbol=position_lots.symbol
                     )"""
            )

    def live_account_id(self) -> str | None:
        with self.connection() as con:
            row = con.execute("SELECT id FROM accounts WHERE mode='live' AND archived=0").fetchone()
            return str(row["id"]) if row else None

    def account(self, account_id: str) -> dict:
        with self.connection() as con:
            row = con.execute("SELECT * FROM accounts WHERE id=?", (account_id,)).fetchone()
            if not row:
                raise PaperTradingError("模拟账户不存在")
            return dict(row)

    def bump(self, con: sqlite3.Connection, account_id: str) -> None:
        con.execute(
            "UPDATE accounts SET revision=revision+1,updated_at=? WHERE id=?",
            (_now_iso(), account_id),
        )


class PaperTradingEngine:
    def __init__(self, store: PaperTradingStore, repo: Any | None = None):
        self.store = store
        self.repo = repo

    # ---------- public state/config ----------
    def resolve_account(self, account_id: str | None = None, mode: str = "live") -> str:
        if account_id:
            self.store.account(account_id)
            return account_id
        if mode == "live":
            live_id = self.store.live_account_id()
            if live_id:
                return live_id
            raise PaperTradingError("尚未创建实时模拟账户")
        raise PaperTradingError("历史回放必须指定 session_id")

    def create_live_account(self, name: str, updates: dict | None = None) -> str:
        account_name = str(name or "").strip()
        if not account_name:
            raise PaperTradingError("账户名称不能为空")
        updates = dict(updates or {})
        allowed = set(DEFAULT_CONFIG)
        if set(updates) - allowed:
            raise PaperTradingError("账户配置字段不合法")
        values = {**DEFAULT_CONFIG, **updates}
        self._validate_config(values)
        with self.store.connection() as con:
            if con.execute(
                "SELECT 1 FROM accounts WHERE mode='live' AND archived=0 LIMIT 1"
            ).fetchone():
                raise PaperTradingError("实时模拟账户已存在")
            account_id = _id("live")
            now = _now_iso()
            con.execute(
                """INSERT INTO accounts(
                  id,mode,name,initial_cash,cash,commission_rate,minimum_commission,
                  slippage_bps,max_positions,max_exposure_pct,max_symbol_exposure_pct,
                  created_at,updated_at,runtime_status,runtime_message
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    account_id,
                    "live",
                    account_name,
                    values["initial_cash"],
                    values["initial_cash"],
                    values["commission_rate"],
                    values["minimum_commission"],
                    values["slippage_bps"],
                    values["max_positions"],
                    values["max_exposure_pct"],
                    values["max_symbol_exposure_pct"],
                    now,
                    now,
                    "idle",
                    "",
                ),
            )
            con.execute(
                "INSERT INTO cash_ledger VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    _id("cash"),
                    account_id,
                    "initial",
                    float(values["initial_cash"]),
                    float(values["initial_cash"]),
                    None,
                    None,
                    now,
                    "初始资金",
                ),
            )
        return account_id

    def set_instrument_rule(
        self,
        symbol: str,
        settlement_cycle: str,
        lot_size: int,
        price_tick: float,
    ) -> dict:
        symbol = symbol.strip()
        if settlement_cycle not in {"T0", "T1"}:
            raise PaperTradingError("settlement_cycle 必须是 T0 或 T1")
        if lot_size <= 0 or price_tick <= 0:
            raise PaperTradingError("每手股数和价格步长必须为正数")
        with self.store.connection() as con:
            current = con.execute(
                "SELECT * FROM instrument_rules WHERE symbol=?", (symbol,)
            ).fetchone()
            busy = con.execute(
                """SELECT 1 FROM position_lots p JOIN accounts a ON a.id=p.account_id
                     WHERE p.symbol=? AND p.remaining>0 AND a.archived=0
                   UNION ALL SELECT 1 FROM orders o JOIN accounts a ON a.id=o.account_id
                     WHERE o.symbol=? AND o.status IN ('queued','active') AND a.archived=0
                   UNION ALL SELECT 1 FROM conditions c JOIN accounts a ON a.id=c.account_id
                     WHERE c.symbol=? AND c.status IN ('armed','waiting_sellable') AND a.archived=0
                   LIMIT 1""",
                (symbol, symbol, symbol),
            ).fetchone()
            effective = current or {
                "settlement_cycle": DEFAULT_SETTLEMENT_CYCLE,
                "lot_size": DEFAULT_LOT_SIZE,
                "price_tick": DEFAULT_PRICE_TICK,
            }
            if busy and (
                effective["settlement_cycle"] != settlement_cycle
                or int(effective["lot_size"]) != lot_size
                or float(effective["price_tick"]) != price_tick
            ):
                raise PaperTradingError("该 ETF 存在持仓或活动订单, 暂不能修改交易制度")
            now = _now_iso()
            con.execute(
                """INSERT INTO instrument_rules VALUES (?,?,?,?,?)
                   ON CONFLICT(symbol) DO UPDATE SET settlement_cycle=excluded.settlement_cycle,
                   lot_size=excluded.lot_size,price_tick=excluded.price_tick,updated_at=excluded.updated_at""",
                (symbol, settlement_cycle, lot_size, price_tick, now),
            )
        return self.instrument_rule(symbol)

    def instrument_rule(self, symbol: str) -> dict:
        with self.store.connection() as con:
            row = con.execute("SELECT * FROM instrument_rules WHERE symbol=?", (symbol,)).fetchone()
            return (
                dict(row)
                if row
                else {
                    "symbol": symbol,
                    "settlement_cycle": DEFAULT_SETTLEMENT_CYCLE,
                    "lot_size": DEFAULT_LOT_SIZE,
                    "price_tick": DEFAULT_PRICE_TICK,
                    "updated_at": None,
                }
            )

    def list_instrument_rules(self) -> list[dict]:
        with self.store.connection() as con:
            return [
                dict(r)
                for r in con.execute("SELECT * FROM instrument_rules ORDER BY symbol").fetchall()
            ]

    def update_config(self, account_id: str, updates: dict) -> dict:
        updates = dict(updates)
        allowed = set(DEFAULT_CONFIG) | {"name"}
        if not updates or set(updates) - allowed:
            raise PaperTradingError("账户配置字段不合法")
        if "name" in updates:
            updates["name"] = str(updates["name"] or "").strip()
            if not updates["name"]:
                raise PaperTradingError("账户名称不能为空")
        with self.store.connection() as con:
            basic_updates = {key: value for key, value in updates.items() if key != "name"}
            if basic_updates and con.execute(
                "SELECT 1 FROM fills WHERE account_id=? LIMIT 1", (account_id,)
            ).fetchone():
                raise PaperTradingError("已有成交后不能修改账户基础配置, 请重建账户")
            current = con.execute("SELECT * FROM accounts WHERE id=?", (account_id,)).fetchone()
            if not current:
                raise PaperTradingError("模拟账户不存在")
            values = dict(current)
            values.update(updates)
            self._validate_config(values)
            assignments = ",".join(f"{key}=?" for key in updates)
            params = [updates[key] for key in updates]
            if "initial_cash" in updates:
                assignments += ",cash=?"
                params.append(updates["initial_cash"])
                con.execute("DELETE FROM cash_ledger WHERE account_id=?", (account_id,))
                con.execute(
                    "INSERT INTO cash_ledger VALUES (?,?,?,?,?,?,?,?,?)",
                    (
                        _id("cash"),
                        account_id,
                        "initial",
                        float(updates["initial_cash"]),
                        float(updates["initial_cash"]),
                        None,
                        None,
                        _now_iso(),
                        "初始资金",
                    ),
                )
            params.append(account_id)
            con.execute(f"UPDATE accounts SET {assignments} WHERE id=?", params)
            self.store.bump(con, account_id)
        return self.snapshot(account_id)

    @staticmethod
    def _validate_config(values: dict) -> None:
        for key in ("initial_cash", "minimum_commission"):
            if not math.isfinite(float(values[key])) or float(values[key]) < 0:
                raise PaperTradingError(f"{key} 不能为负数")
        for key in ("commission_rate", "slippage_bps"):
            if not math.isfinite(float(values[key])) or float(values[key]) < 0:
                raise PaperTradingError(f"{key} 不能为负数")
        if int(values["max_positions"]) < 1:
            raise PaperTradingError("最大持仓数至少为 1")
        for key in ("max_exposure_pct", "max_symbol_exposure_pct"):
            if not 0 < float(values[key]) <= 1:
                raise PaperTradingError(f"{key} 必须在 0 到 1 之间")

    def rebuild_live(self) -> None:
        with self.store.connection() as con:
            old = con.execute("SELECT id FROM accounts WHERE mode='live' AND archived=0").fetchone()
            if old:
                con.execute(
                    "UPDATE accounts SET archived=1,name=name||' · 已归档',updated_at=? WHERE id=?",
                    (_now_iso(), old["id"]),
                )

    def list_archived_accounts(self) -> list[dict]:
        with self.store.connection() as con:
            return [
                dict(row)
                for row in con.execute(
                    "SELECT * FROM accounts WHERE archived=1 ORDER BY updated_at DESC, created_at DESC"
                ).fetchall()
            ]

    def delete_archived_account(self, account_id: str) -> None:
        with self.store.connection() as con:
            account = con.execute(
                "SELECT archived FROM accounts WHERE id=?", (account_id,)
            ).fetchone()
            if not account:
                raise PaperTradingError("模拟账户不存在")
            if not account["archived"]:
                raise PaperTradingError("活动账户不能删除, 请先归档")
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
            ):
                con.execute(f"DELETE FROM {table} WHERE account_id=?", (account_id,))
            con.execute("DELETE FROM accounts WHERE id=? AND archived=1", (account_id,))

    def add_manual_position(
        self,
        account_id: str,
        symbol: str,
        quantity: int,
        average_cost: float,
    ) -> dict:
        """以持仓导入的方式建立一笔不经过撮合的初始持仓."""
        symbol = str(symbol or "").strip()
        if not symbol:
            raise PaperTradingError("持仓标的不能为空")
        try:
            quantity = int(quantity)
            average_cost = float(average_cost)
        except (TypeError, ValueError) as exc:
            raise PaperTradingError("持仓数量和成本必须是有效数字") from exc
        if quantity <= 0:
            raise PaperTradingError("持仓数量必须为正整数")
        if not math.isfinite(average_cost) or average_cost <= 0:
            raise PaperTradingError("持仓成本必须为正数")
        account = self.store.account(account_id)
        if account["archived"]:
            raise PaperTradingError("归档账户不能添加持仓")
        clock = self._account_clock(account)
        current_price, marked_at = self._latest_market_price(symbol, account, clock)

        with self.store.connection() as con:
            account = con.execute("SELECT * FROM accounts WHERE id=?", (account_id,)).fetchone()
            if not account:
                raise PaperTradingError("模拟账户不存在")
            if account["archived"]:
                raise PaperTradingError("归档账户不能添加持仓")
            total_cost = average_cost * quantity
            if not math.isfinite(total_cost) or not math.isfinite(current_price * quantity):
                raise PaperTradingError("持仓金额超出可计算范围")
            if total_cost > float(account["cash"]) + 1e-6:
                raise PaperTradingError("可用资金不足, 无法按持仓成本导入")
            balance = _money(float(account["cash"]) - total_cost)
            trade_date = (clock.date() - timedelta(days=1)).isoformat()
            con.execute(
                """INSERT INTO position_lots(
                   id,account_id,symbol,trade_date,quantity,remaining,unit_cost,source
                ) VALUES (?,?,?,?,?,?,?,?)""",
                (
                    _id("lot"),
                    account_id,
                    symbol,
                    trade_date,
                    quantity,
                    quantity,
                    average_cost,
                    "manual",
                ),
            )
            con.execute(
                """INSERT INTO prices VALUES (?,?,?,?)
                   ON CONFLICT(account_id,symbol) DO UPDATE SET price=excluded.price,
                   bar_time=excluded.bar_time""",
                (account_id, symbol, current_price, marked_at.isoformat()),
            )
            con.execute("UPDATE accounts SET cash=? WHERE id=?", (balance, account_id))
            con.execute(
                "INSERT INTO cash_ledger VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    _id("cash"),
                    account_id,
                    "manual_position",
                    _money(-total_cost),
                    balance,
                    symbol,
                    None,
                    marked_at.isoformat(),
                    "手动添加持仓",
                ),
            )
            self._write_equity(con, account_id, clock)
            self.store.bump(con, account_id)
        return self.snapshot(account_id)

    def edit_manual_position(
        self,
        account_id: str,
        symbol: str,
        quantity: int,
        average_cost: float,
    ) -> dict:
        """修改一笔完全由手动录入构成的当前持仓."""
        symbol = str(symbol or "").strip()
        if not symbol:
            raise PaperTradingError("持仓标的不能为空")
        try:
            quantity = int(quantity)
            average_cost = float(average_cost)
        except (TypeError, ValueError) as exc:
            raise PaperTradingError("持仓数量和成本必须是有效数字") from exc
        if quantity <= 0:
            raise PaperTradingError("持仓数量必须为正整数")
        if not math.isfinite(average_cost) or average_cost <= 0:
            raise PaperTradingError("持仓成本必须为正数")
        account = self.store.account(account_id)
        if account["archived"]:
            raise PaperTradingError("归档账户不能编辑持仓")
        clock = self._account_clock(account)

        with self.store.connection() as con:
            account = con.execute("SELECT * FROM accounts WHERE id=?", (account_id,)).fetchone()
            manual_lots = con.execute(
                """SELECT * FROM position_lots
                   WHERE account_id=? AND symbol=? AND source='manual' AND remaining>0
                   ORDER BY trade_date,id""",
                (account_id, symbol),
            ).fetchall()
            if not manual_lots:
                raise PaperTradingError("该持仓不是手动录入数据")
            total_quantity = self._position_qty(con, account_id, symbol)
            manual_quantity = sum(int(lot["remaining"]) for lot in manual_lots)
            if manual_quantity != total_quantity:
                raise PaperTradingError("该标的包含撮合成交持仓, 不能手动编辑")
            if self._reserved_sell(con, account_id, symbol) > quantity:
                raise PaperTradingError("新数量低于活动卖出数量")
            old_cost = sum(
                int(lot["remaining"]) * float(lot["unit_cost"]) for lot in manual_lots
            )
            new_cost = average_cost * quantity
            new_cash = float(account["cash"]) + old_cost - new_cost
            if not math.isfinite(new_cost) or not math.isfinite(new_cash):
                raise PaperTradingError("持仓金额超出可计算范围")
            if new_cash < -1e-6:
                raise PaperTradingError("可用资金不足, 无法修改持仓")
            current_price, marked_at = self._latest_market_price(symbol, dict(account), clock)
            trade_date = (clock.date() - timedelta(days=1)).isoformat()
            con.execute(
                """DELETE FROM position_lots
                   WHERE account_id=? AND symbol=? AND source='manual' AND remaining>0""",
                (account_id, symbol),
            )
            con.execute(
                """INSERT INTO position_lots(
                   id,account_id,symbol,trade_date,quantity,remaining,unit_cost,source
                ) VALUES (?,?,?,?,?,?,?,?)""",
                (
                    _id("lot"),
                    account_id,
                    symbol,
                    trade_date,
                    quantity,
                    quantity,
                    average_cost,
                    "manual",
                ),
            )
            con.execute(
                """INSERT INTO prices VALUES (?,?,?,?)
                   ON CONFLICT(account_id,symbol) DO UPDATE SET price=excluded.price,
                   bar_time=excluded.bar_time""",
                (account_id, symbol, current_price, marked_at.isoformat()),
            )
            balance = _money(new_cash)
            con.execute("UPDATE accounts SET cash=? WHERE id=?", (balance, account_id))
            con.execute(
                "INSERT INTO cash_ledger VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    _id("cash"),
                    account_id,
                    "manual_position_edit",
                    _money(old_cost - new_cost),
                    balance,
                    symbol,
                    None,
                    clock.isoformat(),
                    "修改手动持仓",
                ),
            )
            self._write_equity(con, account_id, clock)
            self.store.bump(con, account_id)
        return self.snapshot(account_id)

    def update_position_description(
        self,
        account_id: str,
        symbol: str,
        description: str,
    ) -> dict:
        """更新当前持仓的用户备注, 不产生交易或账户流水."""
        symbol = str(symbol or "").strip()
        if not symbol:
            raise PaperTradingError("持仓标的不能为空")
        description = str(description or "")
        if len(description) > 2000:
            raise PaperTradingError("持仓描述不能超过 2000 个字符")
        account = self.store.account(account_id)
        if account["archived"]:
            raise PaperTradingError("归档账户不能编辑持仓描述")

        with self.store.connection() as con:
            if not con.execute(
                """SELECT 1 FROM position_lots
                   WHERE account_id=? AND symbol=? AND remaining>0 LIMIT 1""",
                (account_id, symbol),
            ).fetchone():
                raise PaperTradingError("该标的当前没有持仓")
            con.execute(
                """INSERT INTO position_notes(account_id,symbol,description,updated_at)
                   VALUES (?,?,?,?)
                   ON CONFLICT(account_id,symbol) DO UPDATE SET
                     description=excluded.description, updated_at=excluded.updated_at""",
                (account_id, symbol, description, _now_iso()),
            )
            self.store.bump(con, account_id)
        return self.snapshot(account_id)

    def delete_manual_position(self, account_id: str, symbol: str) -> dict:
        """删除一笔完全由手动录入构成的当前持仓并返还其成本资金."""
        symbol = str(symbol or "").strip()
        if not symbol:
            raise PaperTradingError("持仓标的不能为空")
        account = self.store.account(account_id)
        if account["archived"]:
            raise PaperTradingError("归档账户不能删除持仓")
        clock = self._account_clock(account)

        with self.store.connection() as con:
            account = con.execute("SELECT * FROM accounts WHERE id=?", (account_id,)).fetchone()
            manual_lots = con.execute(
                """SELECT * FROM position_lots
                   WHERE account_id=? AND symbol=? AND source='manual' AND remaining>0
                   ORDER BY trade_date,id""",
                (account_id, symbol),
            ).fetchall()
            if not manual_lots:
                raise PaperTradingError("该持仓不是手动录入数据")
            total_quantity = self._position_qty(con, account_id, symbol)
            manual_quantity = sum(int(lot["remaining"]) for lot in manual_lots)
            if manual_quantity != total_quantity:
                raise PaperTradingError("该标的包含撮合成交持仓, 不能删除手动数据")
            if self._reserved_sell(con, account_id, symbol) > 0:
                raise PaperTradingError("存在活动卖出订单或条件单, 请先取消")
            returned_cost = sum(
                int(lot["remaining"]) * float(lot["unit_cost"]) for lot in manual_lots
            )
            balance = _money(float(account["cash"]) + returned_cost)
            con.execute(
                """DELETE FROM position_lots
                   WHERE account_id=? AND symbol=? AND source='manual' AND remaining>0""",
                (account_id, symbol),
            )
            con.execute(
                """DELETE FROM prices WHERE account_id=? AND symbol=?
                   AND NOT EXISTS (SELECT 1 FROM position_lots
                                   WHERE account_id=? AND symbol=? AND remaining>0)
                   AND NOT EXISTS (SELECT 1 FROM orders
                                   WHERE account_id=? AND symbol=? AND status IN ('queued','active'))
                   AND NOT EXISTS (SELECT 1 FROM conditions
                                   WHERE account_id=? AND symbol=? AND status IN ('armed','waiting_sellable'))""",
                (
                    account_id,
                    symbol,
                    account_id,
                    symbol,
                    account_id,
                    symbol,
                    account_id,
                    symbol,
                ),
            )
            con.execute("UPDATE accounts SET cash=? WHERE id=?", (balance, account_id))
            con.execute(
                "INSERT INTO cash_ledger VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    _id("cash"),
                    account_id,
                    "manual_position_delete",
                    _money(returned_cost),
                    balance,
                    symbol,
                    None,
                    clock.isoformat(),
                    "删除手动持仓",
                ),
            )
            self._write_equity(con, account_id, clock)
            self.store.bump(con, account_id)
        return self.snapshot(account_id)

    # ---------- order creation ----------
    def create_order(self, account_id: str, payload: dict) -> dict:
        symbol, side, order_type, quantity, limit_price = self._validate_order_payload(payload)
        rule = self.instrument_rule(symbol)
        if payload.get("quantity_unit", "shares") == "lots":
            quantity *= int(rule["lot_size"])
        if rule["settlement_cycle"] == "unknown":
            raise PaperTradingError("请先确认该 ETF 的 T+0/T+1 交易制度")
        if quantity % int(rule["lot_size"]) != 0:
            raise PaperTradingError(f"数量必须是每手 {rule['lot_size']} 股的整数倍")
        idem = str(payload.get("idempotency_key") or "").strip()
        if not idem:
            raise PaperTradingError("缺少 idempotency_key")
        account = self.store.account(account_id)
        submitted = self._account_clock(account)
        with self.store.connection() as con:
            existing = con.execute(
                "SELECT * FROM orders WHERE account_id=? AND idempotency_key=?",
                (account_id, idem),
            ).fetchone()
            if existing:
                return dict(existing)
            if side == "sell":
                available = self._sellable(con, account_id, symbol, submitted.date())
                reserved = self._reserved_sell(con, account_id, symbol)
                if available - reserved < quantity:
                    raise PaperTradingError("可卖数量不足 (已扣除 T+1 冻结和活动订单)")
            else:
                price_row = con.execute(
                    "SELECT price FROM prices WHERE account_id=? AND symbol=?",
                    (account_id, symbol),
                ).fetchone()
                reference_price = limit_price or (float(price_row["price"]) if price_row else None)
                if reference_price is not None:
                    fee = max(
                        reference_price * quantity * float(account["commission_rate"]),
                        float(account["minimum_commission"]),
                    )
                    if (
                        float(account["cash"]) - self._reserved_buy_cash(con, account_id)
                        < reference_price * quantity + fee - 1e-6
                    ):
                        raise PaperTradingError("可用资金不足 (已扣除活动买单冻结)")
                    reason = self._fill_guard(
                        con,
                        account,
                        {
                            "account_id": account_id,
                            "symbol": symbol,
                            "side": side,
                            "quantity": quantity,
                        },
                        reference_price,
                        fee,
                        submitted.date(),
                    )
                    if reason:
                        raise PaperTradingError(reason)
            order_id = _id("ord")
            con.execute(
                """INSERT INTO orders(id,account_id,idempotency_key,symbol,side,order_type,
                   quantity,limit_price,status,submitted_at,eligible_after,condition_id,oco_group)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    order_id,
                    account_id,
                    idem,
                    symbol,
                    side,
                    order_type,
                    quantity,
                    limit_price,
                    "queued",
                    submitted.isoformat(),
                    submitted.isoformat(),
                    payload.get("condition_id"),
                    payload.get("oco_group"),
                ),
            )
            self.store.bump(con, account_id)
            return dict(con.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone())

    def _validate_order_payload(self, payload: dict) -> tuple[str, str, str, int, float | None]:
        symbol = str(payload.get("symbol") or "").strip()
        side = str(payload.get("side") or "")
        order_type = str(payload.get("order_type") or "")
        try:
            quantity = int(payload.get("quantity"))
        except (TypeError, ValueError):
            quantity = 0
        limit_price = payload.get("limit_price")
        limit_price = float(limit_price) if limit_price is not None else None
        if not symbol or side not in {"buy", "sell"} or order_type not in {"market", "limit"}:
            raise PaperTradingError("订单标的、方向或类型不合法")
        if quantity <= 0:
            raise PaperTradingError("订单数量必须为正整数")
        if order_type == "limit" and (limit_price is None or limit_price <= 0):
            raise PaperTradingError("限价单必须填写正数限价")
        rule = self.instrument_rule(symbol)
        if limit_price is not None and rule["settlement_cycle"] != "unknown":
            tick = float(rule["price_tick"])
            steps = round(limit_price / tick)
            if abs(limit_price - steps * tick) > tick / 100:
                raise PaperTradingError(f"限价必须符合最小价格步长 {tick:g}")
        return symbol, side, order_type, quantity, limit_price

    def cancel_order(self, account_id: str, order_id: str) -> dict:
        with self.store.connection() as con:
            row = con.execute(
                "SELECT * FROM orders WHERE id=? AND account_id=?", (order_id, account_id)
            ).fetchone()
            if not row:
                raise PaperTradingError("订单不存在")
            if row["status"] not in ACTIVE_ORDER_STATUSES:
                raise PaperTradingError("当前订单状态不能撤销")
            con.execute(
                "UPDATE orders SET status='cancelled',reason='用户撤单' WHERE id=?", (order_id,)
            )
            self.store.bump(con, account_id)
            return dict(con.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone())

    def create_condition(self, account_id: str, payload: dict) -> list[dict]:
        kind = str(payload.get("kind") or "single")
        symbol = str(payload.get("symbol") or "").strip()
        side = str(payload.get("side") or "sell")
        quantity = int(payload.get("quantity") or 0)
        rule = self.instrument_rule(symbol)
        if payload.get("quantity_unit", "shares") == "lots":
            quantity *= int(rule["lot_size"])
        if rule["settlement_cycle"] == "unknown":
            raise PaperTradingError("请先确认该 ETF 的 T+0/T+1 交易制度")
        if not symbol or side not in {"buy", "sell"} or quantity <= 0:
            raise PaperTradingError("条件单标的、方向或数量不合法")
        if quantity % int(rule["lot_size"]) != 0:
            raise PaperTradingError(f"数量必须是每手 {rule['lot_size']} 股的整数倍")
        child_order_type = str(payload.get("child_order_type") or "market")
        child_limit_price = payload.get("child_limit_price")
        if child_order_type not in {"market", "limit"}:
            raise PaperTradingError("条件单子订单类型不合法")
        if child_order_type == "limit" and (
            child_limit_price is None or float(child_limit_price) <= 0
        ):
            raise PaperTradingError("限价子订单必须填写正数限价")
        specs: list[tuple[str, float]] = []
        oco_group = None
        if kind == "oco":
            if side != "sell":
                raise PaperTradingError("首版 OCO 仅支持持仓卖出止盈止损")
            take = float(payload.get("take_profit_price") or 0)
            stop = float(payload.get("stop_loss_price") or 0)
            if take <= 0 or stop <= 0 or take <= stop:
                raise PaperTradingError("OCO 止盈价必须大于止损价, 且均为正数")
            specs = [("above", take), ("below", stop)]
            oco_group = _id("oco")
        else:
            direction = str(payload.get("direction") or "")
            trigger = float(payload.get("trigger_price") or 0)
            if direction not in {"above", "below"} or trigger <= 0:
                raise PaperTradingError("条件方向或触发价不合法")
            specs = [(direction, trigger)]
        tick = float(rule["price_tick"])
        for _, trigger in specs:
            if abs(trigger - round(trigger / tick) * tick) > tick / 100:
                raise PaperTradingError(f"触发价必须符合最小价格步长 {tick:g}")
        if (
            child_limit_price is not None
            and abs(float(child_limit_price) - round(float(child_limit_price) / tick) * tick)
            > tick / 100
        ):
            raise PaperTradingError(f"子订单限价必须符合最小价格步长 {tick:g}")
        account = self.store.account(account_id)
        clock = self._account_clock(account)
        with self.store.connection() as con:
            if side == "sell":
                available = self._sellable(con, account_id, symbol, clock.date())
                reserved = self._reserved_sell(con, account_id, symbol)
                if available - reserved < quantity:
                    # T+1 当日买入允许建立保护单, 但必须确实持有足够总数量.
                    total = self._position_qty(con, account_id, symbol)
                    if total - reserved < quantity:
                        raise PaperTradingError("持仓数量不足, 无法建立条件卖单")
            out = []
            for direction, trigger in specs:
                condition_id = _id("cond")
                con.execute(
                    """INSERT INTO conditions(id,account_id,symbol,side,direction,trigger_price,
                       quantity,child_order_type,child_limit_price,status,oco_group,created_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        condition_id,
                        account_id,
                        symbol,
                        side,
                        direction,
                        trigger,
                        quantity,
                        child_order_type,
                        child_limit_price,
                        "armed",
                        oco_group,
                        _now_iso(),
                    ),
                )
                out.append(
                    dict(
                        con.execute(
                            "SELECT * FROM conditions WHERE id=?", (condition_id,)
                        ).fetchone()
                    )
                )
            self.store.bump(con, account_id)
            return out

    def cancel_condition(self, account_id: str, condition_id: str) -> None:
        with self.store.connection() as con:
            row = con.execute(
                "SELECT * FROM conditions WHERE id=? AND account_id=?", (condition_id, account_id)
            ).fetchone()
            if not row:
                raise PaperTradingError("条件单不存在")
            if row["status"] not in ACTIVE_CONDITION_STATUSES:
                raise PaperTradingError("当前条件单状态不能撤销")
            if row["oco_group"]:
                con.execute(
                    "UPDATE conditions SET status='cancelled',reason='用户取消 OCO' WHERE account_id=? AND oco_group=? AND status IN ('armed','waiting_sellable')",
                    (account_id, row["oco_group"]),
                )
            else:
                con.execute(
                    "UPDATE conditions SET status='cancelled',reason='用户取消' WHERE id=?",
                    (condition_id,),
                )
            self.store.bump(con, account_id)

    # ---------- matching ----------
    def process_bar(self, account_id: str, symbol: str, bar: dict) -> bool:
        bt = _bar_time(bar["datetime"])
        if not all(float(bar.get(k) or 0) > 0 for k in ("open", "high", "low", "close")):
            return False
        with self.store.connection() as con:
            try:
                con.execute(
                    "INSERT INTO processed_bars VALUES (?,?,?)",
                    (account_id, symbol, bt.isoformat()),
                )
            except sqlite3.IntegrityError:
                return False
            # 处理成功的每根分钟 K 都会推进账户 revision, 让持仓市值/未实现盈亏及时可见。
            changed = True
            previous = con.execute(
                "SELECT price FROM prices WHERE account_id=? AND symbol=?",
                (account_id, symbol),
            ).fetchone()
            previous_price = float(previous["price"]) if previous else None
            con.execute(
                """INSERT INTO prices VALUES (?,?,?,?) ON CONFLICT(account_id,symbol)
                   DO UPDATE SET price=excluded.price,bar_time=excluded.bar_time""",
                (account_id, symbol, float(bar["close"]), bt.isoformat()),
            )
            changed |= self._process_conditions(con, account_id, symbol, bar, bt, previous_price)
            orders = con.execute(
                """SELECT * FROM orders WHERE account_id=? AND symbol=?
                   AND status IN ('queued','active') ORDER BY submitted_at,id""",
                (account_id, symbol),
            ).fetchall()
            for order in orders:
                if _bar_time(order["eligible_after"]) >= bt:
                    continue
                if not order["active_date"]:
                    con.execute(
                        "UPDATE orders SET status='active',active_date=? WHERE id=?",
                        (bt.date().isoformat(), order["id"]),
                    )
                    order = con.execute(
                        "SELECT * FROM orders WHERE id=?", (order["id"],)
                    ).fetchone()
                    changed = True
                price = self._match_price(
                    dict(order),
                    bar,
                    con.execute("SELECT * FROM accounts WHERE id=?", (account_id,)).fetchone(),
                )
                if price is not None:
                    self._fill(con, dict(order), price, bt)
                    changed = True
            if bt.time() >= dt_time(15, 0):
                cur = con.execute(
                    """UPDATE orders SET status='expired',reason='DAY 订单收盘未成交'
                       WHERE account_id=? AND status IN ('queued','active')
                       AND active_date=?""",
                    (account_id, bt.date().isoformat()),
                )
                changed |= cur.rowcount > 0
            self._write_equity(con, account_id, bt)
            if changed:
                self.store.bump(con, account_id)
        return changed

    def _process_conditions(
        self,
        con: sqlite3.Connection,
        account_id: str,
        symbol: str,
        bar: dict,
        bt: datetime,
        previous_price: float | None = None,
    ) -> bool:
        rows = [
            dict(r)
            for r in con.execute(
                """SELECT * FROM conditions WHERE account_id=? AND symbol=?
               AND status IN ('armed','waiting_sellable') ORDER BY created_at,id""",
                (account_id, symbol),
            ).fetchall()
        ]
        if not rows:
            return False
        selected: list[dict] = []
        groups: dict[str, list[dict]] = {}
        for row in rows:
            groups.setdefault(row.get("oco_group") or row["id"], []).append(row)
        for items in groups.values():
            waiting = next((x for x in items if x["status"] == "waiting_sellable"), None)
            if waiting:
                selected.append(waiting)
                continue
            hits = [
                x
                for x in items
                if (
                    float(bar["high"]) >= float(x["trigger_price"])
                    and (previous_price is None or previous_price <= float(x["trigger_price"]))
                    if x["direction"] == "above"
                    else float(bar["low"]) <= float(x["trigger_price"])
                    and (previous_price is None or previous_price >= float(x["trigger_price"]))
                )
            ]
            if not hits:
                continue
            # 卖出 OCO 同柱双触发时, 止损 (below) 优先.
            hits.sort(
                key=lambda x: (
                    0 if x["side"] == "sell" and x["direction"] == "below" else 1,
                    x["id"],
                )
            )
            chosen = hits[0]
            if len(hits) > 1:
                chosen["reason"] = "同一分钟多条件触发, 按不利侧优先; 分钟内顺序不可判定"
            selected.append(chosen)
        changed = False
        for condition in selected:
            if condition["side"] == "sell":
                available = self._sellable(con, account_id, symbol, bt.date())
                reserved_other = self._reserved_sell(
                    con,
                    account_id,
                    symbol,
                    exclude_condition_id=condition["id"],
                    exclude_oco_group=condition.get("oco_group"),
                )
                if available - reserved_other < int(condition["quantity"]):
                    con.execute(
                        "UPDATE conditions SET status='waiting_sellable',triggered_at=COALESCE(triggered_at,?),reason=? WHERE id=?",
                        (bt.isoformat(), "条件已触发, 等待 T+1 数量可卖", condition["id"]),
                    )
                    self._cancel_oco_peers(con, condition, "另一腿已触发")
                    changed = True
                    continue
            else:
                account = dict(
                    con.execute("SELECT * FROM accounts WHERE id=?", (account_id,)).fetchone()
                )
                reference_price = float(condition["child_limit_price"] or bar["close"])
                fee = max(
                    reference_price
                    * int(condition["quantity"])
                    * float(account["commission_rate"]),
                    float(account["minimum_commission"]),
                )
                reason = self._fill_guard(con, account, condition, reference_price, fee, bt.date())
                if reason:
                    con.execute(
                        "UPDATE conditions SET status='rejected',triggered_at=?,reason=? WHERE id=?",
                        (bt.isoformat(), reason, condition["id"]),
                    )
                    changed = True
                    continue
            order_id = _id("ord")
            idem = f"condition:{condition['id']}"
            con.execute(
                """INSERT OR IGNORE INTO orders(id,account_id,idempotency_key,symbol,side,order_type,
                   quantity,limit_price,status,submitted_at,eligible_after,condition_id,oco_group)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    order_id,
                    account_id,
                    idem,
                    symbol,
                    condition["side"],
                    condition["child_order_type"],
                    condition["quantity"],
                    condition["child_limit_price"],
                    "queued",
                    bt.isoformat(),
                    bt.isoformat(),
                    condition["id"],
                    condition.get("oco_group"),
                ),
            )
            actual = con.execute(
                "SELECT id FROM orders WHERE account_id=? AND idempotency_key=?", (account_id, idem)
            ).fetchone()["id"]
            con.execute(
                "UPDATE conditions SET status='triggered',triggered_at=?,child_order_id=?,reason=? WHERE id=?",
                (
                    bt.isoformat(),
                    actual,
                    condition.get("reason") or "价格条件已触发",
                    condition["id"],
                ),
            )
            self._cancel_oco_peers(con, condition, "另一腿已触发")
            changed = True
        return changed

    @staticmethod
    def _cancel_oco_peers(con: sqlite3.Connection, condition: dict, reason: str) -> None:
        if condition.get("oco_group"):
            con.execute(
                """UPDATE conditions SET status='cancelled',reason=? WHERE account_id=?
                   AND oco_group=? AND id<>? AND status IN ('armed','waiting_sellable')""",
                (reason, condition["account_id"], condition["oco_group"], condition["id"]),
            )

    @staticmethod
    def _match_price(order: dict, bar: dict, account: sqlite3.Row) -> float | None:
        side = order["side"]
        if order["order_type"] == "market":
            slip = float(account["slippage_bps"]) / 10000
            return float(bar["open"]) * (1 + slip if side == "buy" else 1 - slip)
        limit = float(order["limit_price"])
        if side == "buy":
            if float(bar["open"]) <= limit:
                return float(bar["open"])
            return limit if float(bar["low"]) <= limit else None
        if float(bar["open"]) >= limit:
            return float(bar["open"])
        return limit if float(bar["high"]) >= limit else None

    def _fill(self, con: sqlite3.Connection, order: dict, price: float, bt: datetime) -> None:
        account = con.execute(
            "SELECT * FROM accounts WHERE id=?", (order["account_id"],)
        ).fetchone()
        quantity = int(order["quantity"])
        gross = _money(price * quantity)
        fee = _money(
            max(gross * float(account["commission_rate"]), float(account["minimum_commission"]))
        )
        reason = self._fill_guard(con, dict(account), order, price, fee, bt.date())
        if reason:
            con.execute(
                "UPDATE orders SET status='rejected',reason=? WHERE id=?", (reason, order["id"])
            )
            return
        realized = 0.0
        if order["side"] == "buy":
            balance = _money(float(account["cash"]) - gross - fee)
            unit_cost = (gross + fee) / quantity
            con.execute(
                """INSERT INTO position_lots(
                   id,account_id,symbol,trade_date,quantity,remaining,unit_cost,source
                ) VALUES (?,?,?,?,?,?,?,?)""",
                (
                    _id("lot"),
                    order["account_id"],
                    order["symbol"],
                    bt.date().isoformat(),
                    quantity,
                    quantity,
                    unit_cost,
                    "trade",
                ),
            )
            ledger_amount = -(gross + fee)
        else:
            cost = self._consume_lots(con, order["account_id"], order["symbol"], quantity)
            balance = _money(float(account["cash"]) + gross - fee)
            realized = _money(gross - fee - cost)
            ledger_amount = gross - fee
        con.execute("UPDATE accounts SET cash=? WHERE id=?", (balance, order["account_id"]))
        fill_id = _id("fill")
        con.execute(
            "INSERT INTO fills VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (
                fill_id,
                order["account_id"],
                order["id"],
                order["symbol"],
                order["side"],
                quantity,
                _money(price),
                gross,
                fee,
                realized,
                bt.isoformat(),
            ),
        )
        con.execute(
            "UPDATE orders SET status='filled',filled_at=?,filled_price=?,fee=?,reason='' WHERE id=?",
            (bt.isoformat(), _money(price), fee, order["id"]),
        )
        con.execute(
            "INSERT INTO cash_ledger VALUES (?,?,?,?,?,?,?,?,?)",
            (
                _id("cash"),
                order["account_id"],
                order["side"],
                _money(ledger_amount),
                balance,
                order["symbol"],
                order["id"],
                bt.isoformat(),
                "模拟成交",
            ),
        )

    def _fill_guard(
        self,
        con: sqlite3.Connection,
        account: dict,
        order: dict,
        price: float,
        fee: float,
        trade_date: date,
    ) -> str:
        quantity = int(order["quantity"])
        gross = price * quantity
        if order["side"] == "sell":
            if self._sellable(con, order["account_id"], order["symbol"], trade_date) < quantity:
                return "T+1 冻结或可卖数量不足"
            return ""
        if float(account["cash"]) + 1e-6 < gross + fee:
            return "可用资金不足"
        positions = self._positions(con, order["account_id"], trade_date)
        existing = next((x for x in positions if x["symbol"] == order["symbol"]), None)
        if existing is None and len(positions) >= int(account["max_positions"]):
            return "超过最大持仓数"
        equity = self._equity(con, order["account_id"])["equity"]
        market_value = sum(float(x["market_value"]) for x in positions)
        symbol_value = float(existing["market_value"]) if existing else 0.0
        if equity <= 0:
            return "账户权益不足"
        if (market_value + gross) / equity > float(account["max_exposure_pct"]) + 1e-9:
            return "超过最大总仓位"
        if (symbol_value + gross) / equity > float(account["max_symbol_exposure_pct"]) + 1e-9:
            return "超过单标的仓位上限"
        return ""

    @staticmethod
    def _consume_lots(
        con: sqlite3.Connection,
        account_id: str,
        symbol: str,
        quantity: int,
    ) -> float:
        remain = quantity
        cost = 0.0
        lots = con.execute(
            "SELECT * FROM position_lots WHERE account_id=? AND symbol=? AND remaining>0 ORDER BY trade_date,id",
            (account_id, symbol),
        ).fetchall()
        for lot in lots:
            take = min(remain, int(lot["remaining"]))
            cost += take * float(lot["unit_cost"])
            con.execute(
                "UPDATE position_lots SET remaining=remaining-? WHERE id=?", (take, lot["id"])
            )
            remain -= take
            if remain == 0:
                break
        if remain:
            raise PaperTradingError("持仓批次数量不一致")
        return cost

    # ---------- queries/snapshots ----------
    def snapshot(self, account_id: str) -> dict:
        account = self.store.account(account_id)
        clock = self._account_clock(account)
        with self.store.connection() as con:
            positions = self._positions(con, account_id, clock.date())
            equity = self._equity(con, account_id, positions)
            names = self.repo.get_name_map([p["symbol"] for p in positions]) if self.repo else {}
            for pos in positions:
                pos["name"] = names.get(pos["symbol"], "")
            self._seed_position_equity(con, account_id, positions)
            orders = [
                dict(r)
                for r in con.execute(
                    "SELECT * FROM orders WHERE account_id=? ORDER BY submitted_at DESC LIMIT 500",
                    (account_id,),
                ).fetchall()
            ]
            conditions = [
                dict(r)
                for r in con.execute(
                    "SELECT * FROM conditions WHERE account_id=? ORDER BY created_at DESC LIMIT 500",
                    (account_id,),
                ).fetchall()
            ]
            fills = [
                dict(r)
                for r in con.execute(
                    "SELECT * FROM fills WHERE account_id=? ORDER BY filled_at DESC LIMIT 500",
                    (account_id,),
                ).fetchall()
            ]
            ledger = [
                dict(r)
                for r in con.execute(
                    "SELECT * FROM cash_ledger WHERE account_id=? ORDER BY occurred_at DESC LIMIT 500",
                    (account_id,),
                ).fetchall()
            ]
            curve = [
                dict(r)
                for r in con.execute(
                    "SELECT * FROM equity_points WHERE account_id=? ORDER BY bar_time",
                    (account_id,),
                ).fetchall()
            ]
            position_curves: dict[str, list[dict]] = {}
            for row in con.execute(
                "SELECT * FROM position_equity_points WHERE account_id=? ORDER BY symbol,bar_time",
                (account_id,),
            ).fetchall():
                point = dict(row)
                symbol = str(point.pop("symbol"))
                point.pop("account_id", None)
                point.pop("capital_base", None)
                position_curves.setdefault(symbol, []).append(point)
        return {
            "account": account,
            "summary": equity,
            "positions": positions,
            "orders": orders,
            "conditions": conditions,
            "fills": fills,
            "ledger": ledger,
            "equity_curve": curve,
            "position_equity_curves": position_curves,
            "clock": clock.isoformat(),
        }

    def records(
        self,
        account_id: str,
        kind: str,
        page: int,
        page_size: int,
        status: str | None = None,
    ) -> dict:
        tables = {
            "orders": ("orders", "submitted_at"),
            "fills": ("fills", "filled_at"),
            "conditions": ("conditions", "created_at"),
            "ledger": ("cash_ledger", "occurred_at"),
        }
        if kind not in tables:
            raise PaperTradingError("未知记录类型")
        self.store.account(account_id)
        table, time_column = tables[kind]
        where = "account_id=?"
        params: list[Any] = [account_id]
        if status and kind in {"orders", "conditions"}:
            where += " AND status=?"
            params.append(status)
        with self.store.connection() as con:
            total = int(
                con.execute(
                    f"SELECT COUNT(*) count FROM {table} WHERE {where}",
                    params,
                ).fetchone()["count"]
            )
            rows = [
                dict(row)
                for row in con.execute(
                    f"SELECT * FROM {table} WHERE {where} ORDER BY {time_column} DESC LIMIT ? OFFSET ?",
                    [*params, page_size, (page - 1) * page_size],
                ).fetchall()
            ]
        return {"items": rows, "total": total, "page": page, "page_size": page_size}

    def _positions(
        self,
        con: sqlite3.Connection,
        account_id: str,
        trade_date: date,
    ) -> list[dict]:
        rows = con.execute(
            """SELECT symbol,SUM(remaining) quantity,SUM(remaining*unit_cost) cost,
                      SUM(CASE WHEN source='manual' THEN remaining ELSE 0 END) manual_quantity
               FROM position_lots WHERE account_id=? AND remaining>0 GROUP BY symbol""",
            (account_id,),
        ).fetchall()
        out = []
        for row in rows:
            qty = int(row["quantity"])
            cost = float(row["cost"])
            price_row = con.execute(
                "SELECT price,bar_time FROM prices WHERE account_id=? AND symbol=?",
                (account_id, row["symbol"]),
            ).fetchone()
            note_row = con.execute(
                "SELECT description FROM position_notes WHERE account_id=? AND symbol=?",
                (account_id, row["symbol"]),
            ).fetchone()
            price = float(price_row["price"]) if price_row else cost / qty
            available = self._sellable(con, account_id, row["symbol"], trade_date)
            reserved = self._reserved_sell(con, account_id, row["symbol"])
            out.append(
                {
                    "symbol": row["symbol"],
                    "quantity": qty,
                    "editable": int(row["manual_quantity"] or 0) == qty,
                    "available_quantity": max(0, available - reserved),
                    "reserved_quantity": min(reserved, qty),
                    "average_cost": cost / qty,
                    "last_price": price,
                    "market_value": _money(price * qty),
                    "unrealized_pnl": _money(price * qty - cost),
                    "unrealized_pnl_pct": (price * qty - cost) / cost if cost else 0.0,
                    "price_time": price_row["bar_time"] if price_row else None,
                    "description": str(note_row["description"]) if note_row else "",
                }
            )
        return out

    def _equity(
        self,
        con: sqlite3.Connection,
        account_id: str,
        positions: list[dict] | None = None,
    ) -> dict:
        account = con.execute("SELECT * FROM accounts WHERE id=?", (account_id,)).fetchone()
        positions = (
            positions
            if positions is not None
            else self._positions(con, account_id, cn_now().date())
        )
        market_value = sum(float(p["market_value"]) for p in positions)
        unrealized = sum(float(p["unrealized_pnl"]) for p in positions)
        realized_row = con.execute(
            "SELECT COALESCE(SUM(realized_pnl),0) value FROM fills WHERE account_id=?",
            (account_id,),
        ).fetchone()
        realized = float(realized_row["value"])
        equity = float(account["cash"]) + market_value
        initial = float(account["initial_cash"])
        as_of = self._account_clock(dict(account)).date()
        prior_row = con.execute(
            """SELECT equity FROM equity_points WHERE account_id=? AND bar_time<?
               ORDER BY bar_time DESC LIMIT 1""",
            (account_id, datetime.combine(as_of, dt_time.min).isoformat()),
        ).fetchone()
        day_baseline = float(prior_row["equity"]) if prior_row else initial
        peak_row = con.execute(
            "SELECT MAX(equity) peak FROM equity_points WHERE account_id=?", (account_id,)
        ).fetchone()
        peak = max(initial, float(peak_row["peak"] or 0), equity)
        return {
            "equity": _money(equity),
            "cash": _money(account["cash"]),
            "market_value": _money(market_value),
            "realized_pnl": _money(realized),
            "unrealized_pnl": _money(unrealized),
            "total_pnl": _money(equity - initial),
            "daily_pnl": _money(equity - day_baseline),
            "total_return": (equity - initial) / initial if initial else 0.0,
            "exposure_pct": market_value / equity if equity else 0.0,
            "max_drawdown": (equity - peak) / peak if peak else 0.0,
        }

    def _write_equity(self, con: sqlite3.Connection, account_id: str, bt: datetime) -> None:
        positions = self._positions(con, account_id, bt.date())
        state = self._equity(con, account_id, positions)
        con.execute(
            """INSERT INTO equity_points VALUES (?,?,?,?,?,?,?,?)
               ON CONFLICT(account_id,bar_time) DO UPDATE SET equity=excluded.equity,
               cash=excluded.cash,market_value=excluded.market_value,
               realized_pnl=excluded.realized_pnl,unrealized_pnl=excluded.unrealized_pnl,
               drawdown=excluded.drawdown""",
            (
                account_id,
                bt.isoformat(),
                state["equity"],
                state["cash"],
                state["market_value"],
                state["realized_pnl"],
                state["unrealized_pnl"],
                state["max_drawdown"],
            ),
        )
        self._write_position_equity(con, account_id, bt, positions)

    def _seed_position_equity(
        self,
        con: sqlite3.Connection,
        account_id: str,
        positions: list[dict],
    ) -> None:
        for position in positions:
            symbol = str(position["symbol"])
            exists = con.execute(
                """SELECT 1 FROM position_equity_points
                   WHERE account_id=? AND symbol=? LIMIT 1""",
                (account_id, symbol),
            ).fetchone()
            if exists or not position.get("price_time"):
                continue
            try:
                marked_at = _bar_time(position["price_time"])
            except (TypeError, ValueError, OverflowError):
                continue
            self._write_position_equity(con, account_id, marked_at, [position])

    def _write_position_equity(
        self,
        con: sqlite3.Connection,
        account_id: str,
        bt: datetime,
        positions: list[dict],
    ) -> None:
        if not positions:
            return
        realized_rows = con.execute(
            """SELECT symbol,COALESCE(SUM(realized_pnl),0) realized_pnl
               FROM fills WHERE account_id=? GROUP BY symbol""",
            (account_id,),
        ).fetchall()
        realized_by_symbol = {str(row["symbol"]): float(row["realized_pnl"]) for row in realized_rows}
        for position in positions:
            symbol = str(position["symbol"])
            cost_basis = float(position["average_cost"]) * int(position["quantity"])
            if not math.isfinite(cost_basis) or cost_basis <= 0:
                continue
            first = con.execute(
                """SELECT capital_base FROM position_equity_points
                   WHERE account_id=? AND symbol=? ORDER BY bar_time LIMIT 1""",
                (account_id, symbol),
            ).fetchone()
            capital_base = float(first["capital_base"]) if first else cost_basis
            if not math.isfinite(capital_base) or capital_base <= 0:
                continue
            realized = realized_by_symbol.get(symbol, 0.0)
            unrealized = float(position["unrealized_pnl"])
            total_pnl = realized + unrealized
            equity = capital_base + total_pnl
            peak_row = con.execute(
                """SELECT MAX(equity) peak FROM position_equity_points
                   WHERE account_id=? AND symbol=?""",
                (account_id, symbol),
            ).fetchone()
            peak = max(capital_base, float(peak_row["peak"] or 0), equity)
            drawdown = (equity - peak) / peak if peak else 0.0
            con.execute(
                """INSERT INTO position_equity_points(
                   account_id,symbol,bar_time,equity,market_value,realized_pnl,
                   unrealized_pnl,total_pnl,return_rate,drawdown,capital_base
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(account_id,symbol,bar_time) DO UPDATE SET
                   equity=excluded.equity,market_value=excluded.market_value,
                   realized_pnl=excluded.realized_pnl,unrealized_pnl=excluded.unrealized_pnl,
                   total_pnl=excluded.total_pnl,return_rate=excluded.return_rate,
                   drawdown=excluded.drawdown""",
                (
                    account_id,
                    symbol,
                    bt.isoformat(),
                    _money(equity),
                    _money(float(position["market_value"])),
                    _money(realized),
                    _money(unrealized),
                    _money(total_pnl),
                    total_pnl / capital_base,
                    drawdown,
                    _money(capital_base),
                ),
            )

    def _sellable(
        self,
        con: sqlite3.Connection,
        account_id: str,
        symbol: str,
        trade_date: date,
    ) -> int:
        rule = con.execute("SELECT * FROM instrument_rules WHERE symbol=?", (symbol,)).fetchone()
        if rule and rule["settlement_cycle"] == "T0":
            row = con.execute(
                "SELECT COALESCE(SUM(remaining),0) qty FROM position_lots WHERE account_id=? AND symbol=?",
                (account_id, symbol),
            ).fetchone()
        else:
            row = con.execute(
                """SELECT COALESCE(SUM(remaining),0) qty FROM position_lots
                   WHERE account_id=? AND symbol=? AND trade_date<?""",
                (account_id, symbol, trade_date.isoformat()),
            ).fetchone()
        return int(row["qty"] or 0)

    @staticmethod
    def _position_qty(con: sqlite3.Connection, account_id: str, symbol: str) -> int:
        row = con.execute(
            "SELECT COALESCE(SUM(remaining),0) qty FROM position_lots WHERE account_id=? AND symbol=?",
            (account_id, symbol),
        ).fetchone()
        return int(row["qty"] or 0)

    @staticmethod
    def _reserved_buy_cash(con: sqlite3.Connection, account_id: str) -> float:
        rows = con.execute(
            """SELECT o.quantity,o.limit_price,p.price,a.commission_rate,a.minimum_commission
               FROM orders o JOIN accounts a ON a.id=o.account_id
               LEFT JOIN prices p ON p.account_id=o.account_id AND p.symbol=o.symbol
               WHERE o.account_id=? AND o.side='buy' AND o.status IN ('queued','active')""",
            (account_id,),
        ).fetchall()
        reserved = 0.0
        for row in rows:
            reference = row["limit_price"] or row["price"]
            if reference is None:
                continue
            gross = float(reference) * int(row["quantity"])
            fee = max(gross * float(row["commission_rate"]), float(row["minimum_commission"]))
            reserved += gross + fee
        return reserved

    @staticmethod
    def _reserved_sell(
        con: sqlite3.Connection,
        account_id: str,
        symbol: str,
        exclude_condition_id: str | None = None,
        exclude_oco_group: str | None = None,
    ) -> int:
        order_row = con.execute(
            """SELECT COALESCE(SUM(quantity),0) qty FROM orders WHERE account_id=? AND symbol=?
               AND side='sell' AND status IN ('queued','active')""",
            (account_id, symbol),
        ).fetchone()
        params: list[Any] = [account_id, symbol]
        extra = ""
        if exclude_condition_id:
            extra += " AND id<>?"
            params.append(exclude_condition_id)
        if exclude_oco_group:
            extra += " AND COALESCE(oco_group,'')<>?"
            params.append(exclude_oco_group)
        conditions = con.execute(
            f"""SELECT quantity,COALESCE(oco_group,id) reserve_group FROM conditions
                 WHERE account_id=? AND symbol=? AND side='sell'
                 AND status IN ('armed','waiting_sellable'){extra}
                 GROUP BY reserve_group""",
            params,
        ).fetchall()
        return int(order_row["qty"] or 0) + sum(int(r["quantity"]) for r in conditions)

    @staticmethod
    def _account_clock(account: dict) -> datetime:
        if account["mode"] == "replay" and account.get("replay_cursor"):
            return _bar_time(account["replay_cursor"])
        return cn_now().replace(tzinfo=None)

    # ---------- replay ----------
    def create_replay(self, name: str, start: date, end: date, initial_cash: float) -> str:
        if end < start:
            raise PaperTradingError("回放结束日期不能早于开始日期")
        if initial_cash <= 0:
            raise PaperTradingError("初始资金必须为正数")
        account_id = _id("replay")
        now = _now_iso()
        cursor = datetime.combine(start, dt_time(9, 30)).isoformat()
        cfg = {**DEFAULT_CONFIG, "initial_cash": float(initial_cash)}
        with self.store.connection() as con:
            con.execute(
                """INSERT INTO accounts(id,mode,name,initial_cash,cash,commission_rate,
                   minimum_commission,slippage_bps,max_positions,max_exposure_pct,
                   max_symbol_exposure_pct,created_at,updated_at,replay_start,replay_end,
                   replay_cursor,replay_status,runtime_status)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    account_id,
                    "replay",
                    name.strip() or f"历史回放 {start}",
                    initial_cash,
                    initial_cash,
                    cfg["commission_rate"],
                    cfg["minimum_commission"],
                    cfg["slippage_bps"],
                    cfg["max_positions"],
                    cfg["max_exposure_pct"],
                    cfg["max_symbol_exposure_pct"],
                    now,
                    now,
                    start.isoformat(),
                    end.isoformat(),
                    cursor,
                    "paused",
                    "ready",
                ),
            )
            con.execute(
                "INSERT INTO cash_ledger VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    _id("cash"),
                    account_id,
                    "initial",
                    initial_cash,
                    initial_cash,
                    None,
                    None,
                    now,
                    "历史回放初始资金",
                ),
            )
        return account_id

    def list_replays(self) -> list[dict]:
        with self.store.connection() as con:
            return [
                dict(r)
                for r in con.execute(
                    "SELECT * FROM accounts WHERE mode='replay' AND archived=0 ORDER BY created_at DESC"
                ).fetchall()
            ]

    def control_replay(self, account_id: str, action: str, speed: int | None = None) -> dict:
        account = self.store.account(account_id)
        if account["mode"] != "replay":
            raise PaperTradingError("该账户不是历史回放")
        with self.store.connection() as con:
            if action in {"play", "pause"}:
                status = "running" if action == "play" else "paused"
                if status == "running":
                    running = con.execute(
                        """SELECT id FROM accounts WHERE mode='replay' AND replay_status='running'
                           AND id<>?""",
                        (account_id,),
                    ).fetchall()
                    con.execute(
                        """UPDATE accounts SET replay_status='paused',runtime_message='被另一回放会话暂停'
                           WHERE mode='replay' AND replay_status='running' AND id<>?""",
                        (account_id,),
                    )
                    for row in running:
                        self.store.bump(con, row["id"])
                con.execute(
                    "UPDATE accounts SET replay_status=?,replay_speed=COALESCE(?,replay_speed) WHERE id=?",
                    (status, speed, account_id),
                )
            elif action == "archive":
                con.execute(
                    "UPDATE accounts SET archived=1,replay_status='archived' WHERE id=?",
                    (account_id,),
                )
            else:
                raise PaperTradingError("未知回放操作")
            self.store.bump(con, account_id)
        return self.store.account(account_id)

    def step_replay(self, account_id: str, bars: int = 1) -> dict:
        bars = max(1, min(int(bars), 240))
        for _ in range(bars):
            account = self.store.account(account_id)
            if (
                account["mode"] != "replay"
                or account["archived"]
                or account["replay_status"] == "finished"
            ):
                break
            nxt = self._next_replay_minute(
                _bar_time(account["replay_cursor"]), date.fromisoformat(account["replay_end"])
            )
            if nxt is None:
                with self.store.connection() as con:
                    con.execute(
                        "UPDATE accounts SET replay_status='finished',runtime_status='finished' WHERE id=?",
                        (account_id,),
                    )
                    self.store.bump(con, account_id)
                break
            symbols = self.active_symbols(account_id)
            matched_rows = 0
            if symbols and self.repo is not None:
                frame = self.repo.get_minute_batch(symbols, nxt.date(), asset_type="etf")
                if not frame.is_empty():
                    for row in frame.filter(pl.col("datetime") == nxt).to_dicts():
                        self.process_bar(account_id, str(row["symbol"]), row)
                        matched_rows += 1
            runtime_status = "gap" if symbols and matched_rows < len(symbols) else "ready"
            runtime_message = (
                f"{nxt.isoformat()} 本地分钟数据缺口, 未撮合"
                if runtime_status == "gap"
                else "仅使用回放时钟之前的本地分钟 K"
            )
            with self.store.connection() as con:
                con.execute(
                    """UPDATE accounts SET replay_cursor=?,runtime_status=?,runtime_message=?
                       WHERE id=?""",
                    (nxt.isoformat(), runtime_status, runtime_message, account_id),
                )
                self._write_equity(con, account_id, nxt)
                self.store.bump(con, account_id)
        return self.snapshot(account_id)

    def _next_replay_minute(self, cursor: datetime, end: date) -> datetime | None:
        cur = cursor
        available_dates: list[date] | None = None
        if self.repo is not None and hasattr(self.repo, "list_minute_dates"):
            available_dates = self.repo.list_minute_dates(cur.date(), end, asset_type="etf")
            if not available_dates:
                return None
            if cur.date() not in available_dates:
                return datetime.combine(available_dates[0], dt_time(9, 31))
        while True:
            if cur.date() > end:
                return None
            t = cur.time()
            if t < dt_time(9, 31):
                nxt = datetime.combine(cur.date(), dt_time(9, 31))
            elif t < dt_time(11, 30):
                nxt = cur + timedelta(minutes=1)
            elif t < dt_time(13, 1):
                nxt = datetime.combine(cur.date(), dt_time(13, 1))
            elif t < dt_time(15, 0):
                nxt = cur + timedelta(minutes=1)
            else:
                day = cur.date() + timedelta(days=1)
                if available_dates is not None:
                    next_days = [item for item in available_dates if item >= day]
                    if not next_days:
                        return None
                    day = next_days[0]
                else:
                    while day.weekday() >= 5:
                        day += timedelta(days=1)
                cur = datetime.combine(day, dt_time(9, 30))
                continue
            return nxt if nxt.date() <= end else None

    def active_symbols(self, account_id: str) -> list[str]:
        with self.store.connection() as con:
            rows = con.execute(
                """SELECT symbol FROM position_lots WHERE account_id=? AND remaining>0
                   UNION SELECT symbol FROM orders WHERE account_id=? AND status IN ('queued','active')
                   UNION SELECT symbol FROM conditions WHERE account_id=? AND status IN ('armed','waiting_sellable')""",
                (account_id, account_id, account_id),
            ).fetchall()
            return sorted(str(r["symbol"]) for r in rows)

    def visible_replay_bars(self, account_id: str, symbol: str) -> list[dict]:
        account = self.store.account(account_id)
        if account["mode"] != "replay":
            raise PaperTradingError("实时账户不使用历史回放 K 线接口")
        cursor = _bar_time(account["replay_cursor"])
        if self.repo is None:
            return []
        frame = self.repo.get_minute_batch([symbol], cursor.date(), asset_type="etf")
        if frame.is_empty():
            return []
        return frame.filter(pl.col("datetime") <= cursor).sort("datetime").to_dicts()

    @staticmethod
    def _price_from_frame(
        frame: pl.DataFrame,
        symbol: str,
        cutoff: datetime | None = None,
        fallback_date: date | None = None,
    ) -> tuple[float, datetime] | None:
        if frame.is_empty() or "symbol" not in frame.columns:
            return None
        candidates: list[tuple[datetime, float]] = []
        for row in frame.to_dicts():
            if str(row.get("symbol") or "").strip() != symbol:
                continue
            raw_price = next(
                (row.get(key) for key in ("last_price", "close") if row.get(key) is not None),
                None,
            )
            try:
                price = float(raw_price)
            except (TypeError, ValueError):
                continue
            if not math.isfinite(price) or price <= 0:
                continue
            raw_time = row.get("datetime") or row.get("bar_time")
            if raw_time is not None:
                try:
                    marked_at = _bar_time(raw_time)
                except (TypeError, ValueError, OverflowError):
                    continue
            else:
                raw_date = row.get("date") or fallback_date
                if raw_date is None:
                    continue
                try:
                    marked_at = (
                        raw_date.replace(tzinfo=None)
                        if isinstance(raw_date, datetime)
                        else datetime.combine(raw_date, dt_time(15, 0))
                        if isinstance(raw_date, date)
                        else datetime.combine(date.fromisoformat(str(raw_date)[:10]), dt_time(15, 0))
                    )
                except (TypeError, ValueError, OverflowError):
                    continue
            if cutoff is not None and marked_at > cutoff:
                continue
            candidates.append((marked_at, price))
        if not candidates:
            return None
        marked_at, price = max(candidates, key=lambda item: item[0])
        return price, marked_at

    def _latest_market_price(
        self,
        symbol: str,
        account: dict,
        clock: datetime,
    ) -> tuple[float, datetime]:
        if self.repo is None:
            raise PaperTradingError("行情数据库尚未就绪, 无法取得当前价格")

        if account["mode"] == "live":
            latest_asset = getattr(self.repo, "get_enriched_latest_asset", None)
            if callable(latest_asset):
                try:
                    frame, latest_date = latest_asset("etf", refresh=False)
                    result = self._price_from_frame(
                        frame,
                        symbol,
                        fallback_date=latest_date,
                    )
                    if result:
                        return result
                except Exception:
                    logger.debug("读取 ETF 最新行情缓存失败: %s", symbol, exc_info=True)

        latest_minute = getattr(self.repo, "get_minute", None)
        if callable(latest_minute):
            try:
                frame = latest_minute(symbol, clock.date(), asset_type="etf")
                result = self._price_from_frame(frame, symbol, cutoff=clock)
                if result:
                    return result
            except Exception:
                logger.debug("读取 ETF 最新分钟行情失败: %s", symbol, exc_info=True)

        get_daily = getattr(self.repo, "get_etf_daily", None)
        if callable(get_daily):
            try:
                frame = get_daily(
                    symbol,
                    date(1990, 1, 1),
                    clock.date(),
                    columns=["symbol", "date", "close"],
                )
                result = self._price_from_frame(frame, symbol, cutoff=clock)
                if result:
                    return result
            except Exception:
                logger.debug("读取 ETF 最新日行情失败: %s", symbol, exc_info=True)

        raise PaperTradingError(f"行情数据库中没有 {symbol} 的最新价格")


class PaperTradingService:
    """后台增量服务: 实时账户拉取分钟 K, 并推进一个运行中的回放."""

    def __init__(self, engine: PaperTradingEngine, repo: Any, capabilities: Any):
        self.engine = engine
        self.repo = repo
        self.capabilities = capabilities
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None
        self._boot_cutoff = cn_now().replace(second=0, microsecond=0, tzinfo=None)
        self._last_live_poll = 0.0

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="paper-trading", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread:
            self._thread.join(timeout=5)

    def wake(self) -> None:
        self._wake.set()

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self._advance_running_replay()
                self._poll_live()
            except Exception:
                logger.exception("paper trading loop failed")
            self._wake.wait(1.0)
            self._wake.clear()

    def _advance_running_replay(self) -> None:
        for account in self.engine.list_replays():
            if account["replay_status"] == "running":
                self.engine.step_replay(account["id"], int(account["replay_speed"] or 1))
                break

    def minute_available(self) -> bool:
        from app.services import kline_sync, preferences
        from app.tickflow.capabilities import Cap

        if self.capabilities.has(Cap.KLINE_MINUTE_BATCH):
            return True
        provider = preferences.get_minute_data_provider()
        _, fallback, _ = kline_sync._resolve_minute_provider(provider)
        return not fallback

    def _poll_live(self) -> None:
        account_id = self.engine.store.live_account_id()
        if not account_id:
            return
        symbols = self.engine.active_symbols(account_id)
        if not symbols:
            self._set_runtime(account_id, "idle", "暂无持仓或活动订单")
            return
        now = cn_now()
        if not in_continuous_session(now):
            self._set_runtime(account_id, "closed", "当前不在连续交易时段")
            return
        from app.services import trading_day

        trading_state = trading_day.is_trading_day(now)
        if trading_state is False:
            self._set_runtime(account_id, "closed", "当前为非交易日")
            return
        if trading_state is not True:
            self._set_runtime(account_id, "unavailable", "交易日状态无法确认, 撮合已冻结")
            return
        if not self.minute_available():
            self._set_runtime(account_id, "unavailable", "分钟 K 数据能力不可用, 撮合已冻结")
            return
        monotonic_now = time.monotonic()
        if monotonic_now - self._last_live_poll < 5.0:
            return
        self._last_live_poll = monotonic_now
        from app.services import kline_sync

        naive_now = now.replace(tzinfo=None)
        start = max(
            self._boot_cutoff, naive_now.replace(hour=9, minute=25, second=0, microsecond=0)
        )
        frame = kline_sync.sync_minute_batch(
            symbols, start_time=start, end_time=naive_now, asset_type="etf"
        )
        if frame.is_empty():
            self._set_runtime(account_id, "stale", "暂未取得新的 ETF 分钟 K")
            return
        completed_before = naive_now.replace(second=0, microsecond=0)
        latest_value = frame.select(pl.col("datetime").max()).item()
        if latest_value is None or naive_now - _bar_time(latest_value) > timedelta(minutes=3):
            latest_text = _bar_time(latest_value).isoformat() if latest_value else "未知"
            self._set_runtime(
                account_id,
                "stale",
                f"ETF 分钟 K 已陈旧 (最新 {latest_text}), 撮合已冻结",
            )
            return
        rows = frame.filter(pl.col("datetime") < completed_before).sort(["datetime", "symbol"])
        for row in rows.to_dicts():
            if _bar_time(row["datetime"]) >= self._boot_cutoff:
                self.engine.process_bar(account_id, str(row["symbol"]), row)
        self._set_runtime(account_id, "running", "按已完成 1 分钟 K 撮合")

    def _set_runtime(self, account_id: str, status: str, message: str) -> None:
        with self.engine.store.connection() as con:
            row = con.execute(
                "SELECT runtime_status,runtime_message FROM accounts WHERE id=?", (account_id,)
            ).fetchone()
            if row and (row["runtime_status"] != status or row["runtime_message"] != message):
                con.execute(
                    "UPDATE accounts SET runtime_status=?,runtime_message=? WHERE id=?",
                    (status, message, account_id),
                )
                self.engine.store.bump(con, account_id)
