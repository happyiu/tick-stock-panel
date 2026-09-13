"""ETF paper trading API. Local-only simulation; no broker connection."""

from __future__ import annotations

import asyncio
import json
from datetime import date
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field, model_validator
from sse_starlette.sse import EventSourceResponse

from app.services.paper_trading import PaperTradingEngine, PaperTradingError

router = APIRouter(prefix="/api/paper-trading", tags=["paper-trading"])


def _engine(request: Request) -> PaperTradingEngine:
    engine = getattr(request.app.state, "paper_trading_engine", None)
    if engine is None:
        raise HTTPException(status_code=503, detail="模拟交易服务尚未就绪")
    return engine


def _wake(request: Request) -> None:
    service = getattr(request.app.state, "paper_trading_service", None)
    if service is not None:
        service.wake()


def _run(action):
    try:
        return action()
    except PaperTradingError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


class AccountConfigRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    initial_cash: float | None = Field(default=None, ge=0)
    commission_rate: float | None = Field(default=None, ge=0)
    minimum_commission: float | None = Field(default=None, ge=0)
    slippage_bps: float | None = Field(default=None, ge=0)
    max_positions: int | None = Field(default=None, ge=1)
    max_exposure_pct: float | None = Field(default=None, gt=0, le=1)
    max_symbol_exposure_pct: float | None = Field(default=None, gt=0, le=1)


class LiveAccountSetupRequest(AccountConfigRequest):
    name: str = Field(min_length=1, max_length=80)


class InstrumentRuleRequest(BaseModel):
    settlement_cycle: Literal["T0", "T1"]
    lot_size: int = Field(gt=0)
    price_tick: float = Field(gt=0)


class OrderRequest(BaseModel):
    account_id: str
    idempotency_key: str = Field(min_length=1, max_length=128)
    symbol: str = Field(min_length=1, max_length=32)
    side: Literal["buy", "sell"]
    order_type: Literal["market", "limit"]
    quantity: int = Field(gt=0)
    quantity_unit: Literal["shares", "lots"] = "shares"
    limit_price: float | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def validate_limit(self):
        if self.order_type == "limit" and self.limit_price is None:
            raise ValueError("限价单必须填写限价")
        return self


class ManualPositionRequest(BaseModel):
    account_id: str
    symbol: str = Field(min_length=1, max_length=32)
    quantity: int = Field(gt=0)
    average_cost: float = Field(gt=0)


class PositionDescriptionRequest(BaseModel):
    account_id: str
    symbol: str = Field(min_length=1, max_length=32)
    description: str = Field(default="", max_length=2000)


class ConditionRequest(BaseModel):
    account_id: str
    kind: Literal["single", "oco"] = "single"
    symbol: str = Field(min_length=1, max_length=32)
    side: Literal["buy", "sell"] = "sell"
    quantity: int = Field(gt=0)
    quantity_unit: Literal["shares", "lots"] = "shares"
    direction: Literal["above", "below"] | None = None
    trigger_price: float | None = Field(default=None, gt=0)
    take_profit_price: float | None = Field(default=None, gt=0)
    stop_loss_price: float | None = Field(default=None, gt=0)
    child_order_type: Literal["market", "limit"] = "market"
    child_limit_price: float | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def validate_shape(self):
        if self.kind == "single" and (self.direction is None or self.trigger_price is None):
            raise ValueError("价格条件单必须填写方向和触发价")
        if self.kind == "oco" and (self.take_profit_price is None or self.stop_loss_price is None):
            raise ValueError("OCO 必须填写止盈价和止损价")
        if self.child_order_type == "limit" and self.child_limit_price is None:
            raise ValueError("限价子订单必须填写限价")
        return self


class ReplayCreateRequest(BaseModel):
    name: str = Field(default="", max_length=80)
    start: date
    end: date
    initial_cash: float = Field(default=1_000_000, gt=0)


class ReplayControlRequest(BaseModel):
    action: Literal["play", "pause", "archive"]
    speed: int | None = Field(default=None, ge=1, le=60)


@router.get("/snapshot")
def snapshot(
    request: Request,
    mode: Literal["live", "replay"] = "live",
    account_id: str | None = None,
):
    engine = _engine(request)
    if mode == "live" and account_id is None and engine.store.live_account_id() is None:
        return {"setup_required": True, "message": "请先完成实时模拟账户设置"}
    return _run(lambda: engine.snapshot(engine.resolve_account(account_id, mode)))


@router.post("/live/setup")
def setup_live(body: LiveAccountSetupRequest, request: Request):
    engine = _engine(request)
    payload = body.model_dump(exclude={"name"}, exclude_none=True)
    account_id = _run(lambda: engine.create_live_account(body.name, payload))
    _wake(request)
    return engine.snapshot(account_id)


@router.put("/accounts/{account_id}/config")
def update_config(account_id: str, body: AccountConfigRequest, request: Request):
    engine = _engine(request)
    result = _run(lambda: engine.update_config(account_id, body.model_dump(exclude_none=True)))
    _wake(request)
    return result


@router.post("/live/rebuild")
def rebuild_live(request: Request):
    engine = _engine(request)
    _run(engine.rebuild_live)
    _wake(request)
    return {"setup_required": True, "message": "请先完成新的实时模拟账户设置"}


@router.get("/accounts/archived")
def archived_accounts(request: Request):
    return {"items": _engine(request).list_archived_accounts()}


@router.delete("/accounts/{account_id}")
def delete_archived_account(account_id: str, request: Request):
    _run(lambda: _engine(request).delete_archived_account(account_id))
    return {"ok": True}


@router.get("/rules")
def list_rules(request: Request):
    return {"items": _engine(request).list_instrument_rules()}


@router.get("/rules/{symbol}")
def get_rule(symbol: str, request: Request):
    return _engine(request).instrument_rule(symbol)


@router.put("/rules/{symbol}")
def set_rule(symbol: str, body: InstrumentRuleRequest, request: Request):
    engine = _engine(request)
    return _run(lambda: engine.set_instrument_rule(symbol, **body.model_dump()))


@router.post("/orders")
def create_order(body: OrderRequest, request: Request):
    result = _run(lambda: _engine(request).create_order(body.account_id, body.model_dump()))
    _wake(request)
    return result


@router.post("/positions/manual")
def add_manual_position(body: ManualPositionRequest, request: Request):
    engine = _engine(request)
    result = _run(
        lambda: engine.add_manual_position(
            body.account_id,
            body.symbol,
            body.quantity,
            body.average_cost,
        )
    )
    _wake(request)
    return result


@router.put("/positions/manual")
def edit_manual_position(body: ManualPositionRequest, request: Request):
    engine = _engine(request)
    result = _run(
        lambda: engine.edit_manual_position(
            body.account_id,
            body.symbol,
            body.quantity,
            body.average_cost,
        )
    )
    _wake(request)
    return result


@router.put("/positions/description")
def update_position_description(body: PositionDescriptionRequest, request: Request):
    engine = _engine(request)
    result = _run(
        lambda: engine.update_position_description(
            body.account_id,
            body.symbol,
            body.description,
        )
    )
    _wake(request)
    return result


@router.delete("/positions/manual/{symbol}")
def delete_manual_position(symbol: str, account_id: str, request: Request):
    result = _run(lambda: _engine(request).delete_manual_position(account_id, symbol))
    _wake(request)
    return result


@router.post("/orders/{order_id}/cancel")
def cancel_order(order_id: str, account_id: str, request: Request):
    result = _run(lambda: _engine(request).cancel_order(account_id, order_id))
    _wake(request)
    return result


@router.post("/conditions")
def create_condition(body: ConditionRequest, request: Request):
    result = _run(lambda: _engine(request).create_condition(body.account_id, body.model_dump()))
    _wake(request)
    return {"items": result}


@router.post("/conditions/{condition_id}/cancel")
def cancel_condition(condition_id: str, account_id: str, request: Request):
    _run(lambda: _engine(request).cancel_condition(account_id, condition_id))
    _wake(request)
    return {"ok": True}


@router.get("/records/{kind}")
def records(
    kind: Literal["orders", "fills", "conditions", "ledger"],
    account_id: str,
    request: Request,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    status: str | None = None,
):
    engine = _engine(request)
    return _run(lambda: engine.records(account_id, kind, page, page_size, status))


@router.get("/replays")
def list_replays(request: Request):
    return {"items": _engine(request).list_replays()}


@router.post("/replays")
def create_replay(body: ReplayCreateRequest, request: Request):
    engine = _engine(request)
    account_id = _run(
        lambda: engine.create_replay(body.name, body.start, body.end, body.initial_cash)
    )
    return engine.snapshot(account_id)


@router.post("/replays/{account_id}/control")
def control_replay(account_id: str, body: ReplayControlRequest, request: Request):
    result = _run(lambda: _engine(request).control_replay(account_id, body.action, body.speed))
    _wake(request)
    return result


@router.post("/replays/{account_id}/step")
def step_replay(account_id: str, request: Request, bars: int = Query(1, ge=1, le=240)):
    return _run(lambda: _engine(request).step_replay(account_id, bars))


@router.get("/replays/{account_id}/bars")
def replay_bars(account_id: str, symbol: str, request: Request):
    return {"items": _run(lambda: _engine(request).visible_replay_bars(account_id, symbol))}


@router.get("/stream")
async def stream(account_id: str, request: Request):
    engine = _engine(request)

    async def events():
        last_revision = -1
        order_states: dict[str, str] = {}
        condition_states: dict[str, str] = {}
        fill_ids: set[str] = set()
        initialized = False
        while True:
            if await request.is_disconnected():
                return
            try:
                account = engine.store.account(account_id)
            except PaperTradingError:
                yield {"event": "error", "data": json.dumps({"detail": "账户不存在"})}
                return
            revision = int(account["revision"])
            if revision != last_revision:
                last_revision = revision
                yield {
                    "event": "paper_revision",
                    "data": json.dumps(
                        {
                            "account_id": account_id,
                            "revision": revision,
                            "clock": engine._account_clock(account).isoformat(),
                        }
                    ),
                }
                state = engine.snapshot(account_id)
                first = not initialized
                for order in state["orders"]:
                    previous = order_states.get(order["id"])
                    order_states[order["id"]] = order["status"]
                    if not first and previous != order["status"]:
                        yield {"event": "order_status", "data": json.dumps(order)}
                for condition in state["conditions"]:
                    previous = condition_states.get(condition["id"])
                    condition_states[condition["id"]] = condition["status"]
                    if not first and previous != condition["status"]:
                        yield {"event": "condition_status", "data": json.dumps(condition)}
                for fill in state["fills"]:
                    if fill["id"] not in fill_ids:
                        fill_ids.add(fill["id"])
                        if not first:
                            yield {"event": "paper_fill", "data": json.dumps(fill)}
                if account["mode"] == "replay":
                    yield {
                        "event": "replay_clock",
                        "data": json.dumps(
                            {
                                "account_id": account_id,
                                "clock": state["clock"],
                                "status": account["replay_status"],
                            }
                        ),
                    }
                initialized = True
            await asyncio.sleep(0.75)

    return EventSourceResponse(events(), ping=15)
