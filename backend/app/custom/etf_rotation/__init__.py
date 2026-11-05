# ruff: noqa: RUF001
"""ETF rotation extension: independently registered research backtests."""

import csv
import io
import json
import logging
import uuid
from contextlib import asynccontextmanager

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import Field

from app.extensions import BACKEND_EXTENSION_API_VERSION

from .data import check_snapshot, closed_date, load_snapshot, validate_catalog
from .engine import Ledger, decide, simulate
from .jobs import close_all, manager, now
from .models import (
    VERSION,
    Parameters,
    PreviewRequest,
    RotationConfig,
    RunRequest,
    StrictModel,
    templates,
)
from .signals import SignalBook

EXTENSION_ID = "research.etf-rotation"
EXTENSION_API_VERSION = BACKEND_EXTENSION_API_VERSION
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app):
    yield
    close_all()


router = APIRouter(prefix="/api/etf-rotation", tags=["etf-rotation"], lifespan=lifespan)


def setup(registrar):
    registrar.include_router(router)


def startup(context):
    manager(context.data_dir)


def _jobs(request):
    return manager(request.app.state.repo.store.data_dir)


def _safe(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except OSError as exc:
        logger.exception("ETF轮动存储或数据读取失败")
        raise HTTPException(503, "数据读写失败，请检查数据目录及数据源状态") from exc


@router.get("/strategies")
def strategies():
    return {
        "templates": templates(),
        "parameters": Parameters.model_json_schema(),
        "closed_date": closed_date().isoformat(),
    }


@router.get("/configs")
def configs(request: Request):
    return {"items": _safe(_jobs(request).store.list, "configs")}


class SaveRequest(StrictModel):
    config: RotationConfig
    revision: int | None = Field(None, ge=1)


def _save(request, value, identifier=None):
    jobs = _jobs(request)
    validate_catalog(request.app.state.repo, value.config)
    with jobs.store.lock:
        revision = 1
        if identifier:
            old = jobs.store.read("configs", identifier)
            if value.revision != old["revision"]:
                raise HTTPException(409, "配置已被修改，请重新载入后保存")
            revision = old["revision"] + 1
        identifier = identifier or uuid.uuid4().hex
        record = {
            "id": identifier,
            "revision": revision,
            "config": value.config.model_dump(),
            "updated_at": now(),
        }
        jobs.store.write("configs", identifier, record)
        return record


@router.post("/configs")
def create_config(value: SaveRequest, request: Request):
    return _safe(_save, request, value)


@router.put("/configs/{identifier}")
def update_config(identifier: str, value: SaveRequest, request: Request):
    return _safe(_save, request, value, identifier)


@router.delete("/configs/{identifier}")
def delete_config(identifier: str, revision: int, request: Request):
    store = _jobs(request).store
    with store.lock:
        record = _safe(store.read, "configs", identifier)
        if record["revision"] != revision:
            raise HTTPException(409, "配置已被修改，请重新载入")
        _safe(_safe(store.path, "configs", identifier).unlink)
    return {"deleted": True}


@router.post("/data-check")
def data_check(value: RunRequest, request: Request):
    snap = _safe(load_snapshot, request.app.state.repo, value)
    return _safe(check_snapshot, value.config, snap, value.start.isoformat(), value.end.isoformat())


@router.post("/data-prepare")
def data_prepare(value: RunRequest, request: Request):
    _safe(validate_catalog, request.app.state.repo, value.config)
    return _safe(
        _jobs(request).submit,
        "prepare",
        value,
        request.app.state.repo,
        request.app.state.capabilities,
    )


@router.post("/backtests")
def start_backtest(value: RunRequest, request: Request):
    _safe(validate_catalog, request.app.state.repo, value.config)
    return _safe(
        _jobs(request).submit,
        "backtest",
        value,
        request.app.state.repo,
        request.app.state.capabilities,
    )


@router.get("/backtests")
def backtests(request: Request):
    return {"items": _safe(_jobs(request).store.list, "jobs")}


@router.get("/backtests/{identifier}")
def job(identifier: str, request: Request):
    return _safe(_jobs(request).store.read, "jobs", identifier)


@router.post("/backtests/{identifier}/cancel")
def cancel(identifier: str, request: Request):
    return _safe(_jobs(request).cancel, identifier)


def _result(identifier, request):
    store = _jobs(request).store
    job = store.read("jobs", identifier)
    if job["status"] != "completed" or job["kind"] != "backtest":
        raise HTTPException(409, "回测尚未成功完成")
    return store.read("results", identifier)


@router.get("/backtests/{identifier}/result")
def result(identifier: str, request: Request):
    return _safe(_result, identifier, request)


@router.get("/backtests/{identifier}/export/{kind}")
def export(identifier: str, kind: str, request: Request):
    result = _safe(_result, identifier, request)
    if kind not in {"stats", "daily", "signals", "fills"}:
        raise HTTPException(422, "不支持的导出类型")
    rows = [result["stats"]] if kind == "stats" else result[kind]
    buffer = io.StringIO()
    if rows:
        writer = csv.DictWriter(
            buffer, fieldnames=list(dict.fromkeys(key for row in rows for key in row))
        )
        writer.writeheader()
        for row in rows:
            values = {
                k: json.dumps(v, ensure_ascii=False) if isinstance(v, (list, dict)) else v
                for k, v in row.items()
            }
            # Protect spreadsheet consumers from formula injection in configurable names/reasons.
            values = {
                k: "'" + v if isinstance(v, str) and v.startswith(("=", "+", "-", "@")) else v
                for k, v in values.items()
            }
            writer.writerow(values)
    return Response(
        "\ufeff" + buffer.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="rotation-{identifier}-{kind}.csv"'},
    )


def _value_changed(left, right):
    if left is None or right is None:
        return left != right
    return abs(left - right) > 1e-8


def _preview(value, request):
    repo = request.app.state.repo
    end = closed_date()
    from datetime import timedelta

    start = end - timedelta(days=366)
    stored = payload = None
    if value.backtest_id:
        stored = _result(value.backtest_id, request)
        payload = _jobs(request).store.read("inputs", value.backtest_id)
        if payload["algorithm_version"] != VERSION:
            raise ValueError("算法版本已经变化，请重新回测后预览")
        if payload["request"]["config"] != value.config.model_dump():
            raise ValueError("配置与所选回测快照不同，请载入该回测配置或重新回测")
        start = min(start, date_from(stored["state"]["last_date"]))
    run = RunRequest(config=value.config, start=start, end=end)
    snapshot = load_snapshot(repo, run)
    book = SignalBook(value.config, snapshot)
    valid = [d for d in book.dates if book.valid(d)]
    if not valid:
        raise ValueError("没有全池完整收盘且预热就绪的数据，请先准备数据")
    latest = valid[-1]
    # Do not label a much older valid window as the latest decision when recent bars are missing.
    if latest != book.dates[-1]:
        raise ValueError("最新交易日全池数据不完整，请先准备数据")
    if not value.backtest_id:
        signal = book.calculate(latest)
        state = {"marks": {}, "peak_value": 10000, "pending": None, "index": 0, "mode": "normal"}
        order = decide(book, latest, Ledger(10000, value.config.fees), state, signal)
        return {
            "as_of": latest,
            "context": "空仓开仓判断，不代表已有账户调仓",
            "signal": signal,
            "pending": order,
            "state": None,
        }
    assert stored is not None and payload is not None
    old_snapshot, state = payload["snapshot"], stored["state"]
    previous = state["last_date"]
    if latest < previous:
        raise ValueError("当前行情早于所选回测结束日")
    for symbol, old_rows in old_snapshot["etfs"].items():
        fresh = {r["date"]: r for r in snapshot["etfs"].get(symbol, [])}
        overlap = [r for r in old_rows if r["date"] in fresh]
        if any(
            _value_changed(r.get(key), fresh[r["date"]].get(key))
            for r in overlap
            for key in ["open", "high", "low", "close", "volume", "amount"]
        ):
            raise ValueError("行情或复权版本已变化，请重新回测后预览")
        old_snapshot["etfs"][symbol] = old_rows + [
            r for r in snapshot["etfs"][symbol] if r["date"] > previous
        ]
    fresh_index = {r["date"]: r for r in snapshot["index"]}
    if any(
        _value_changed(r.get("close"), fresh_index[r["date"]].get("close"))
        for r in old_snapshot["index"]
        if r["date"] in fresh_index
    ):
        raise ValueError("参考指数行情已变化，请重新回测后预览")
    old_snapshot["index"] += [r for r in snapshot["index"] if r["date"] > previous]
    old_snapshot.setdefault("market_environment", []).extend(
        r for r in snapshot.get("market_environment", []) if r["date"] > previous
    )
    if latest > previous:
        advanced = simulate(
            value.config,
            old_snapshot,
            (date_from(previous) + timedelta(days=1)).isoformat(),
            latest,
            payload["request"]["initial_cash"],
            state=state,
        )
        state = advanced["state"]
    return {
        "as_of": latest,
        "context": "所选回测期末状态延续预览（不写入账户）",
        "signal": state["last_signal"],
        "pending": state["pending"],
        "state": state,
    }


def date_from(value):
    from datetime import date

    return date.fromisoformat(value)


@router.post("/preview")
def preview(value: PreviewRequest, request: Request):
    return _safe(_preview, value, request)
