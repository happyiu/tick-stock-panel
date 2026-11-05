import json
import time
from copy import deepcopy
from datetime import date
from types import SimpleNamespace

import numpy as np
import pandas as pd
import polars as pl
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.custom.etf_rotation import router
from app.custom.etf_rotation.data import check_snapshot
from app.custom.etf_rotation.engine import Ledger, decide, execute, simulate
from app.custom.etf_rotation.jobs import Jobs, close_all
from app.custom.etf_rotation.models import Fees, RotationConfig, RunRequest, templates
from app.custom.etf_rotation.signals import SignalBook
from app.custom.etf_rotation.storage import Store


@pytest.fixture
def market():
    dates = pd.bdate_range("2024-01-01", periods=180).strftime("%Y-%m-%d").tolist()
    etfs = {}
    for j, symbol in enumerate(["510050.SH", "510500.SH", "518880.SH", "510300.SH"]):
        rows = []
        for i, day in enumerate(dates):
            price = 2 + i * (0.004 + 0.002 * j) + 0.03 * np.sin(i / (4 + j))
            rows.append(
                {
                    "date": day,
                    "open": price * 0.999,
                    "high": price * 1.005,
                    "low": price * 0.995,
                    "close": price,
                    "volume": 1e6 + i * (j + 1) * 100,
                    "amount": 1e8,
                }
            )
        etfs[symbol] = rows
    index = [
        {
            "date": d,
            "open": 3000 + i,
            "high": 3010 + i,
            "low": 2990 + i,
            "close": 3000 + i,
            "volume": 1e8,
            "amount": 1e9,
        }
        for i, d in enumerate(dates)
    ]
    return {"etfs": etfs, "index": index}


def config(strategy="composite_momentum"):
    c = RotationConfig.model_validate(next(t for t in templates() if t["strategy"] == strategy))
    c.symbols = ["510050.SH", "510500.SH"]
    c.parameters.risk_mode = "A"
    c.parameters.account_guard = False
    return c


def test_configuration_rejects_invalid_pool_and_weights():
    c = config().model_dump()
    c["symbols"] = ["510050.SH"] * 2
    with pytest.raises(ValueError):
        RotationConfig.model_validate(c)
    c = config().model_dump()
    c["parameters"]["trend_weight"] = 0.7
    with pytest.raises(ValueError):
        RotationConfig.model_validate(c)
    c = config("gold_safe_haven").model_dump()
    c["symbols"][0] = c["haven_symbol"]
    with pytest.raises(ValueError):
        RotationConfig.model_validate(c)


def test_fifo_partial_sale_preserves_cost_and_cash():
    fees = Fees(commission=0.001, minimum=5, slippage=0)
    ledger = Ledger(10000, fees)
    ledger.buy("510050.SH", 6000, 2, "2024-01-01", 0, "open")
    bought = ledger.shares("510050.SH")
    original_basis = sum(lot["cost"] for lot in ledger.lots["510050.SH"])
    ledger.sell("510050.SH", 1000, 3, "2024-01-03", 2, "partial")
    remaining_basis = sum(lot["cost"] for lot in ledger.lots["510050.SH"])
    assert original_basis - remaining_basis == pytest.approx(original_basis * 1000 / bought)
    ledger.sell("510050.SH", bought, 4, "2024-01-04", 3, "exit")
    assert not ledger.lots
    assert ledger.cash - 10000 == pytest.approx(
        sum(f["profit"] for f in ledger.fills if f["side"] == "sell")
    )
    assert [f["days_held"] for f in ledger.fills if f["side"] == "sell"] == [2, 3]


def test_purchase_reserves_minimum_fee_and_whole_lots():
    ledger = Ledger(1000, Fees(commission=0.0002, minimum=5))
    ledger.buy("510050.SH", 1000, 10, "2024-01-01", 0, "")
    assert ledger.cash == 1000  # 100 shares plus fees cannot fit.
    ledger.buy("510050.SH", 1000, 3, "2024-01-01", 0, "")
    assert ledger.shares("510050.SH") == 300
    assert ledger.cash >= 0


@pytest.mark.parametrize("strategy", ["composite_momentum", "gold_safe_haven", "cross_border"])
def test_no_future_data_and_first_fill_next_session(market, strategy):
    c = config(strategy)
    dates = [r["date"] for r in market["index"]]
    initial = simulate(c, market, dates[70], dates[120], 10000)
    assert initial["fills"]
    assert initial["fills"][0]["date"] == dates[71]
    mutated = deepcopy(market)
    for rows in mutated["etfs"].values():
        for row in rows[121:]:
            for key in ["open", "high", "low", "close"]:
                row[key] *= 7
    replay = simulate(c, mutated, dates[70], dates[150], 10000)
    assert replay["daily"][:51] == initial["daily"]
    assert replay["signals"][:51] == initial["signals"]
    assert [f for f in replay["fills"] if f["date"] <= dates[120]] == initial["fills"]
    assert initial["stats"]["final_value"] == pytest.approx(
        initial["state"]["cash"]
        + sum(p["close"] * p["shares"] for p in initial["daily"][-1]["positions"])
    )
    assert initial["fills"][-1]["reason"] != "期末虚拟平仓"


def test_composite_numerical_factors_match_independent_formula(market):
    c = config()
    book = SignalBook(c, market)
    day = market["index"][90]["date"]
    result = book.calculate(day)
    for row in result["ranking"]:
        prices = np.array([r["close"] for r in market["etfs"][row["symbol"]][:91]])
        trend = (
            0.15 * (prices[-1] / prices[-6] - 1)
            + 0.5 * (prices[-1] / prices[-21] - 1)
            + 0.35 * (prices[-1] / prices[-61] - 1)
        )
        ret = prices[-20:] / prices[-21:-1] - 1
        assert row["factors"]["trend"]["raw"] == pytest.approx(trend)
        assert row["factors"]["sharpe"]["raw"] == pytest.approx(
            ret.mean() / ret.std() * np.sqrt(252)
        )
    assert sum(r["factors"]["trend"]["zscore"] for r in result["ranking"]) == pytest.approx(0)


def test_common_start_missing_reference_and_missing_calendar_day(market):
    c = config("gold_safe_haven")
    dates = [r["date"] for r in market["index"]]
    shortened = deepcopy(market)
    shortened["etfs"][c.symbols[0]] = shortened["etfs"][c.symbols[0]][30:]
    check = check_snapshot(c, shortened, dates[70], dates[-1])
    assert not check["ready"]
    assert check["proposed_start"] == dates[93]
    shortened["etfs"][c.reference_symbol] = []
    assert not check_snapshot(c, shortened, dates[70], dates[-1])["ready"]
    missing = deepcopy(market)
    missing["index"].pop(100)
    book = SignalBook(c, missing)
    assert dates[100] in book.dates
    assert not book.calculate(dates[100])["valid"]


def state_for(ledger, index=90):
    return {
        "marks": {s: 2 for s in ledger.lots},
        "peak_value": 10000,
        "pending": None,
        "index": index,
        "mode": "normal",
        "gold_since": 0,
    }


def test_risk_interrupts_both_legs_and_fills_following_open(market):
    c = config()
    c.parameters.account_guard = True
    ledger = Ledger(10000, c.fees)
    ledger.buy(c.symbols[0], 4000, 2, market["index"][70]["date"], 0, "one")
    ledger.buy(c.symbols[1], 4000, 2, market["index"][70]["date"], 0, "two")
    state = state_for(ledger)
    state["peak_value"] = 20000
    state["pending"] = {"target": c.symbols[1], "steps": 2, "reason": "rotation"}
    book = SignalBook(c, market)
    day, following = market["index"][90]["date"], market["index"][91]["date"]
    state["pending"] = decide(book, day, ledger, state, book.calculate(day))
    assert state["pending"]["risk"]
    assert len(ledger.fills) == 2  # Closing decision has not filled.
    assert execute(book, ledger, state, following)
    assert not ledger.lots
    assert all(f["date"] == following for f in ledger.fills if f["side"] == "sell")


def test_progressive_sale_uses_fifo_and_locks_target(market):
    c = config("cross_border")
    book = SignalBook(c, market)
    ledger = Ledger(10000, c.fees)
    ledger.buy(c.symbols[0], 9000, 2, market["index"][60]["date"], 0, "open")
    state = state_for(ledger)
    state["pending"] = {"target": c.symbols[1], "steps": 5, "reason": "rotation"}
    for i in range(90, 95):
        day = market["index"][i]["date"]
        state["index"] = i
        execute(book, ledger, state, day)
        for symbol in ledger.lots:
            state["marks"][symbol] = book.bars[symbol][day]["close"]
        decision = decide(book, day, ledger, state, book.calculate(day))
        if i < 94:
            assert decision["target"] == c.symbols[1]
    assert state["pending"] is None
    assert c.symbols[0] not in ledger.lots
    assert ledger.cash >= 0
    assert all(f["profit"] is not None for f in ledger.fills if f["side"] == "sell")
    assert all(
        lot["shares"] > 0 and lot["cost"] > 0 for lots in ledger.lots.values() for lot in lots
    )


def test_suspension_retains_pending_without_buying_target(market):
    c = config("cross_border")
    day = market["index"][90]["date"]
    market["etfs"][c.symbols[0]][90]["volume"] = 0
    book = SignalBook(c, market)
    ledger = Ledger(10000, c.fees)
    ledger.buy(c.symbols[0], 9000, 2, day, 0, "open")
    state = state_for(ledger)
    state["pending"] = {"target": c.symbols[1], "steps": 5, "reason": "rotation"}
    execute(book, ledger, state, day)
    assert state["pending"]["steps"] == 5
    assert ledger.shares(c.symbols[1]) == 0


def test_gold_panic_pool_denominator_and_proxy_outside_pool(market):
    c = config("gold_safe_haven")
    c.parameters.bull_filter = False
    for symbol in c.symbols:
        for i in range(85, 91):
            market["etfs"][symbol][i]["close"] *= 1 - 0.025 * (i - 84)
    book = SignalBook(c, market)
    signal = book.calculate(market["index"][90]["date"])
    assert c.reference_symbol not in c.symbols
    assert signal["panic"]["breadth"] == 1
    # Strict threshold is configurable; deterministic panic transition and min-hold exit.
    signal["panic_triggered"] = True
    ledger = Ledger(10000, c.fees)
    state = state_for(ledger)
    order = decide(book, signal["date"], ledger, state, signal)
    assert order["target"] == c.haven_symbol and order["steps"] == 1
    state.update(mode="gold", gold_since=89)
    assert decide(book, signal["date"], ledger, state, signal) is None


class Repo:
    def __init__(self, root, snapshot):
        self.store = SimpleNamespace(data_dir=root)
        self.snapshot = snapshot

    def get_etf_symbol_set(self):
        return set(self.snapshot["etfs"])

    def get_etf_daily(self, symbol, start, end, columns=None):
        return pl.DataFrame(
            [
                r
                for r in self.snapshot["etfs"].get(symbol, [])
                if start.isoformat() <= r["date"] <= end.isoformat()
            ]
        )

    def get_index_daily(self, symbol, start, end, columns=None):
        return pl.DataFrame(
            [r for r in self.snapshot["index"] if start.isoformat() <= r["date"] <= end.isoformat()]
        )


def request_for(market):
    return RunRequest(
        config=config(),
        start=date.fromisoformat(market["index"][70]["date"]),
        end=date.fromisoformat(market["index"][120]["date"]),
    )


def test_spawned_worker_persists_snapshot_and_reproducible_result(market, tmp_path):
    jobs = Jobs(tmp_path)
    try:
        request = request_for(market)
        job = jobs.submit("backtest", request, Repo(tmp_path, market), None)
        until = time.monotonic() + 20
        while time.monotonic() < until:
            status = jobs.store.read("jobs", job["id"])
            if status["status"] not in {"queued", "running"}:
                break
            time.sleep(0.05)
        assert status["status"] == "completed", status
        stored = jobs.store.read("results", job["id"])
        payload = jobs.store.read("inputs", job["id"])
        replay = simulate(
            request.config,
            payload["snapshot"],
            request.start.isoformat(),
            request.end.isoformat(),
            request.initial_cash,
        )
        assert stored["daily"] == replay["daily"]
        assert stored["fills"] == replay["fills"]
        assert len(payload["data_digest"]) == 64
    finally:
        jobs.close()


def test_store_rejects_path_traversal_and_restart_interrupts_jobs(tmp_path):
    store = Store(tmp_path)
    with pytest.raises(ValueError):
        store.read("configs", "../secret")
    identifier = "a" * 32
    store.write("jobs", identifier, {"id": identifier, "status": "running"})
    jobs = Jobs(tmp_path)
    try:
        assert jobs.store.read("jobs", identifier)["status"] == "interrupted"
    finally:
        jobs.close()


def test_api_configs_validation_data_check_preview_and_exports(market, tmp_path, monkeypatch):
    monkeypatch.setattr(
        "app.custom.etf_rotation.closed_date",
        lambda: date.fromisoformat(market["index"][-1]["date"]),
    )
    app = FastAPI()
    app.include_router(router)
    app.state.repo = Repo(tmp_path, market)
    app.state.capabilities = None
    try:
        with TestClient(app) as client:
            prefix = "/api/etf-rotation"
            assert len(client.get(prefix + "/strategies").json()["templates"]) == 4
            c = config()
            value = client.post(prefix + "/configs", json={"config": c.model_dump()})
            assert value.status_code == 200, value.text
            saved = value.json()
            assert (
                client.put(
                    prefix + "/configs/" + saved["id"],
                    json={"config": c.model_dump(), "revision": 99},
                ).status_code
                == 409
            )
            assert client.post(
                prefix + "/data-check", json=request_for(market).model_dump(mode="json")
            ).json()["ready"]
            preview = client.post(prefix + "/preview", json={"config": c.model_dump()})
            assert preview.status_code == 200, preview.text
            signal = SignalBook(c, market).calculate(market["index"][-1]["date"])
            assert preview.json()["signal"]["ranking"] == signal["ranking"]
            bad = c.model_dump()
            bad["symbols"][0] = "999999.SH"
            assert client.post(prefix + "/configs", json={"config": bad}).status_code == 422
            assert client.get(prefix + "/backtests/" + "a" * 32 + "/result").status_code == 404
            assert (
                client.delete(
                    prefix + "/configs/" + saved["id"], params={"revision": 1}
                ).status_code
                == 200
            )
            assert client.get(prefix + "/configs").json()["items"] == []
    finally:
        close_all()


def test_snapshot_config_does_not_mutate_after_edit(market):
    c = config()
    before = json.dumps(c.model_dump(), sort_keys=True)
    simulate(c, market, market["index"][70]["date"], market["index"][95]["date"], 10000)
    assert json.dumps(c.model_dump(), sort_keys=True) == before


def test_context_preview_matches_uninterrupted_replay_and_csv(market, tmp_path, monkeypatch):
    import app.custom.etf_rotation as extension
    from app.custom.etf_rotation.jobs import manager
    from app.custom.etf_rotation.models import SOURCE_REVISION, VERSION

    monkeypatch.setattr(extension, "closed_date", lambda: date(2026, 11, 3))
    app = FastAPI()
    app.include_router(router)
    app.state.repo = Repo(tmp_path, market)
    app.state.capabilities = None
    c = config()
    request = request_for(market)
    output = simulate(c, market, request.start.isoformat(), request.end.isoformat(), 10000)
    metadata = {
        "request": request.model_dump(mode="json"),
        "data_digest": "a" * 64,
        "source_revision": SOURCE_REVISION,
        "algorithm_version": VERSION,
    }
    output["metadata"] = metadata
    jobs = manager(tmp_path)
    identifier = "b" * 32
    from app.custom.etf_rotation.data import load_snapshot

    frozen = load_snapshot(Repo(tmp_path, market), request)
    jobs.store.write("inputs", identifier, {**metadata, "snapshot": frozen})
    jobs.store.write("results", identifier, output)
    jobs.store.write(
        "jobs", identifier, {"id": identifier, "kind": "backtest", "status": "completed"}
    )
    try:
        with TestClient(app) as client:
            prefix = "/api/etf-rotation"
            response = client.post(
                prefix + "/preview", json={"config": c.model_dump(), "backtest_id": identifier}
            )
            assert response.status_code == 200, response.text
            replay = simulate(
                c, market, request.start.isoformat(), market["index"][-1]["date"], 10000
            )
            assert response.json()["pending"] == replay["state"]["pending"]
            assert response.json()["state"]["lots"] == replay["state"]["lots"]
            assert response.json()["state"]["cash"] == replay["state"]["cash"]
            for kind in ["stats", "daily", "signals", "fills"]:
                exported = client.get(f"{prefix}/backtests/{identifier}/export/{kind}")
                assert exported.status_code == 200
                assert exported.headers["content-type"].startswith("text/csv")
            changed = c.model_dump()
            changed["parameters"]["min_hold"] = 15
            assert (
                client.post(
                    prefix + "/preview", json={"config": changed, "backtest_id": identifier}
                ).status_code
                == 422
            )
            # Reading/previewing old results never rewrites their snapshot.
            assert jobs.store.read("results", identifier) == output
    finally:
        close_all()


def test_cancel_running_load_and_queued_task_without_starting_worker(market, tmp_path, monkeypatch):
    import threading

    import app.custom.etf_rotation.jobs as module

    entered, release = threading.Event(), threading.Event()
    original = module.load_snapshot

    def slow_load(repo, request):
        entered.set()
        assert release.wait(5)
        return original(repo, request)

    monkeypatch.setattr(module, "load_snapshot", slow_load)
    jobs = Jobs(tmp_path)
    try:
        request = request_for(market)
        first = jobs.submit("backtest", request, Repo(tmp_path, market), None)
        assert entered.wait(5)
        second = jobs.submit("backtest", request, Repo(tmp_path, market), None)
        jobs.cancel(first["id"])
        jobs.cancel(second["id"])
        release.set()
        jobs.queue.join()
        assert jobs.store.read("jobs", first["id"])["status"] == "canceled"
        assert jobs.store.read("jobs", second["id"])["status"] == "canceled"
        assert not jobs.store.path("results", first["id"]).exists()
        assert not jobs.store.path("inputs", second["id"]).exists()
    finally:
        release.set()
        jobs.close()


@pytest.mark.parametrize("template", templates())
def test_production_risk_modes_serialize_all_results(market, template):
    c = RotationConfig.model_validate(template)
    c.symbols = ["510050.SH", "510500.SH"]
    output = simulate(c, market, market["index"][70]["date"], market["index"][-1]["date"], 10000)
    serialized = json.dumps(output, allow_nan=False)
    assert serialized


def test_one_queue_owner_and_release(tmp_path):
    first = Jobs(tmp_path)
    try:
        with pytest.raises(OSError):
            Jobs(tmp_path)
    finally:
        first.close()
    replacement = Jobs(tmp_path)
    replacement.close()


def test_large_minimum_fee_never_makes_cash_negative():
    ledger = Ledger(10000, Fees(commission=0, minimum=1000, slippage=0))
    ledger.buy("510050.SH", 10000, 2, "2024-01-01", 0, "")
    previous = deepcopy(ledger.lots)
    assert not ledger.sell("510050.SH", ledger.shares("510050.SH"), 0.001, "2024-01-02", 1, "")
    assert ledger.lots == previous
    assert ledger.cash >= 0


def test_prepare_uses_selected_pool_and_provider_index_boundary(market, tmp_path, monkeypatch):
    from app.custom.etf_rotation.data import prepare
    from app.data_providers import custom as providers
    from app.indicators import pipeline
    from app.services import index_sync, preferences

    calls = {}
    repo = Repo(tmp_path, market)
    repo.append_index_daily = lambda frame: calls.update(index_rows=frame.height)
    repo.append_index_enriched = lambda frame: None
    repo.refresh_index_views = lambda: None
    monkeypatch.setattr(
        index_sync,
        "sync_etf_adj_factor",
        lambda symbols, *a, **kw: calls.update(factors=symbols) or (0, []),
    )
    monkeypatch.setattr(
        index_sync,
        "sync_and_persist_etf_daily",
        lambda *a, **kw: calls.update(etfs=kw["symbols_override"]),
    )
    monkeypatch.setattr(preferences, "get_daily_data_provider", lambda: "custom-test")
    monkeypatch.setattr(providers, "provider_has_dataset", lambda name, dataset: dataset == "daily")

    def get_daily(symbols, **kwargs):
        calls.update(index_symbols=symbols, asset_type=kwargs["asset_type"])
        return pl.DataFrame([{**row, "symbol": "000300.SH"} for row in market["index"]])

    monkeypatch.setattr(
        providers, "get_provider", lambda name: SimpleNamespace(get_daily=get_daily)
    )
    monkeypatch.setattr(pipeline, "compute_enriched", lambda frame, **kwargs: frame)
    request = request_for(market)
    check = prepare(repo, None, request, lambda pct: None)
    assert check["ready"]
    assert calls["etfs"] == request.config.symbols
    assert calls["factors"] == request.config.symbols
    assert calls["index_symbols"] == ["000300.SH"]
    assert calls["asset_type"] == "index"
    assert calls["index_rows"] > 0


def test_prepare_stops_on_factor_failure(market, tmp_path, monkeypatch):
    from app.custom.etf_rotation.data import prepare
    from app.services import index_sync

    monkeypatch.setattr(index_sync, "sync_etf_adj_factor", lambda *a, **kw: (0, ["510050.SH"]))
    with pytest.raises(ValueError, match=r"510050\.SH"):
        prepare(Repo(tmp_path, market), None, request_for(market), lambda pct: None)


def test_repository_snapshot_reads_narrow_persisted_columns(market, tmp_path, monkeypatch):
    from app.custom.etf_rotation.data import load_snapshot
    from app.tickflow.repository import KlineRepository

    request = request_for(market)
    rows = []
    for symbol in request.config.symbols:
        for row in market["etfs"][symbol]:
            rows.append(
                {
                    **row,
                    "symbol": symbol,
                    "raw_close": row["close"],
                    "raw_high": row["high"],
                    "raw_low": row["low"],
                }
            )
    frame = pl.DataFrame(rows).with_columns(pl.col("date").str.to_date())
    etf_path, index_path = tmp_path / "etf.parquet", tmp_path / "index.parquet"
    frame.write_parquet(etf_path)
    pl.DataFrame([{**row, "symbol": "000300.SH"} for row in market["index"]]).with_columns(
        pl.col("date").str.to_date()
    ).write_parquet(index_path)
    repo = object.__new__(KlineRepository)
    repo._etf_enriched_glob = str(etf_path)
    repo._index_enriched_glob = str(index_path)
    monkeypatch.setattr(repo, "get_etf_symbol_set", lambda: set(request.config.symbols))

    def unwanted_compute(frame):
        raise AssertionError("snapshot loading must not recompute all system indicators")

    monkeypatch.setattr(repo, "_compute_index_enriched_range", unwanted_compute)
    snapshot = load_snapshot(repo, request)
    assert check_snapshot(
        request.config, snapshot, request.start.isoformat(), request.end.isoformat()
    )["ready"]
    assert "raw_high" in snapshot["etfs"][request.config.symbols[0]][0]


def test_single_price_raw_bar_is_conservatively_not_filled(market):
    from app.custom.etf_rotation.engine import _tradeable

    c = config()
    day = market["index"][90]["date"]
    row = market["etfs"][c.symbols[0]][90]
    row.update(raw_high=2.5, raw_low=2.5, raw_close=2.5)
    book = SignalBook(c, market)
    assert not _tradeable(book, c.symbols[0], day, "buy")
    assert not _tradeable(book, c.symbols[0], day, "sell")


def test_enhanced_configuration_exposure_order_and_warmup():
    c = config("composite_momentum_enhanced")
    c.parameters.market_ma_period = 120
    from app.custom.etf_rotation.signals import history_bars

    assert history_bars(c) == 121
    bad = c.model_dump()
    bad["parameters"]["bear_exposure"] = 0.8
    with pytest.raises(ValueError, match="仓位"):
        RotationConfig.model_validate(bad)


def test_environment_exposes_asof_evidence_and_preserves_base_scores(market):
    day = market["index"][90]["date"]
    market["market_environment"] = [
        {"date": day, "state": "weak", "score": 25},
        {"date": market["index"][91]["date"], "state": "strong", "score": 80},
    ]
    base = SignalBook(config(), market).calculate(day)
    enhanced = SignalBook(config("composite_momentum_enhanced"), market).calculate(day)
    assert base["ranking"] == enhanced["ranking"]
    assert base["environment"]["controls_exposure"] is False
    assert enhanced["environment"]["controls_exposure"] is True
    assert enhanced["environment"]["target_exposure"] == 0.5
    assert enhanced["environment"]["market_context"]["score"] == 25
    assert enhanced["environment"]["ma"] == pytest.approx(
        np.mean([r["close"] for r in market["index"][31:91]])
    )


def bear_market(market):
    for i, row in enumerate(market["index"]):
        if i >= 100:
            row["close"] = 3200 - (i - 100) * 8
    return market


def test_enhanced_bear_exit_is_next_session_and_overrides_minimum_hold(market):
    c = config("composite_momentum_enhanced")
    c.parameters.min_hold = 252
    bear_market(market)
    dates = [r["date"] for r in market["index"]]
    result = simulate(c, market, dates[70], dates[-1], 10000)
    first_bear = next(i for i, signal in enumerate(result["signals"]) if signal["regime"] == "bear")
    trigger = result["signals"][first_bear]
    assert trigger["decision"]["target"] is None
    assert trigger["decision"]["target_exposure"] == 0
    assert result["daily"][first_bear]["positions"]  # Still held at the signal close.
    assert not result["daily"][first_bear + 1]["positions"]
    exit_fills = [f for f in result["fills"] if f["reason"] == "市场环境降仓至现金"]
    assert exit_fills[0]["date"] == result["daily"][first_bear + 1]["date"]
    assert all(not row["positions"] for row in result["daily"][first_bear + 1 :])
    assert all(
        row["exposure"] < 0.51
        for row, signal in zip(
            result["daily"][:first_bear], result["signals"][:first_bear], strict=True
        )
        if signal["regime"] == "neutral" and row["pending"] is None
    )
    assert result["stats"]["average_exposure"] < 0.5
    altered = deepcopy(market)
    for row in altered["index"][150:]:
        row["close"] *= 2
    prefix = simulate(c, altered, dates[70], dates[-1], 10000)
    assert prefix["daily"][:80] == result["daily"][:80]


def test_enhanced_retains_cash_exit_when_open_cannot_fill(market):
    c = config("composite_momentum_enhanced")
    bear_market(market)
    book = SignalBook(c, market)
    day = market["index"][150]["date"]
    ledger = Ledger(10000, c.fees)
    ledger.buy(c.symbols[0], 8000, 2, market["index"][110]["date"], 0, "open")
    state = state_for(ledger, 10)
    state["pending"] = decide(book, day, ledger, state, book.calculate(day))
    following = market["index"][151]["date"]
    book.bars[c.symbols[0]][following]["volume"] = 0
    execute(book, ledger, state, following)
    assert ledger.lots and state["pending"]["target"] is None
    assert state["execution_warning"]


def test_enhanced_worker_includes_same_snapshot_baseline(market, tmp_path):
    import queue

    from app.custom.etf_rotation.jobs import _worker
    from app.custom.etf_rotation.models import SOURCE_REVISION, VERSION

    request = request_for(market)
    request.config.strategy = "composite_momentum_enhanced"
    identifier = "c" * 32
    store = Store(tmp_path)
    store.write(
        "inputs",
        identifier,
        {
            "request": request.model_dump(mode="json"),
            "snapshot": market,
            "data_digest": "f" * 64,
            "source_revision": SOURCE_REVISION,
            "algorithm_version": VERSION,
        },
    )
    events = queue.Queue()
    _worker(tmp_path, identifier, events)
    result = store.read("results", identifier)
    base = config()
    expected = simulate(base, market, request.start.isoformat(), request.end.isoformat(), 10000)
    assert result["comparison"]["stats"] == expected["stats"]
    assert result["comparison"]["daily"] == expected["daily"]
    assert result["stats"]["average_exposure"] < result["comparison"]["stats"]["average_exposure"]


def test_environment_resize_preserves_existing_basket_and_rotation_target(market):
    c = config("composite_momentum_enhanced")
    book = SignalBook(c, market)
    ledger = Ledger(10000, c.fees)
    ledger.buy(c.symbols[0], 4000, 2, market["index"][70]["date"], 0, "one")
    ledger.buy(c.symbols[1], 3000, 2, market["index"][70]["date"], 0, "two")
    state = state_for(ledger)
    state["exposure_target"] = 1
    state["pending"] = {
        "target": c.symbols[1],
        "steps": 3,
        "reason": "排名切换",
        "target_exposure": 1,
    }
    day, following = market["index"][90]["date"], market["index"][91]["date"]
    decision = decide(book, day, ledger, state, book.calculate(day))
    assert decision["resize_only"]
    assert decision["resume_plan"]["target"] == c.symbols[1]
    state["pending"] = decision
    repeated = decide(book, day, ledger, state, book.calculate(day))
    assert not repeated["resume_plan"].get("resize_only")
    assert repeated["resume_plan"]["target"] == c.symbols[1]
    state["pending"] = repeated
    execute(book, ledger, state, following)
    assert set(ledger.lots) == set(c.symbols)
    assert state["pending"]["target"] == c.symbols[1]
    assert state["pending"]["steps"] == 3  # Sizing does not advance the rotation.
    assert state["exposure_target"] == 0.5
    assert all(fill["side"] == "sell" for fill in ledger.fills[2:])


def test_preflight_rejects_mid_window_index_gap_even_when_start_is_ready(market):
    c = config()
    dates = [r["date"] for r in market["index"]]
    market["index"].pop(110)
    check = check_snapshot(c, market, dates[70], dates[150])
    assert not check["ready"]
    assert check["proposed_start"] is None
    assert check["missing_index_dates"] == [dates[110]]
    assert check["incomplete_days"] > 0
    assert "区间内" in check["reason"]


def test_prepare_reports_stock_only_provider_instead_of_succeeding_empty(
    market, tmp_path, monkeypatch
):
    from app.custom.etf_rotation.data import prepare
    from app.data_providers import custom as providers
    from app.data_providers import registry as provider_registry
    from app.services import index_sync, preferences

    monkeypatch.setattr(index_sync, "sync_etf_adj_factor", lambda *a, **kw: (0, []))
    monkeypatch.setattr(index_sync, "sync_and_persist_etf_daily", lambda *a, **kw: 0)
    monkeypatch.setattr(preferences, "get_daily_data_provider", lambda: "stock-only")
    monkeypatch.setattr(providers, "provider_has_dataset", lambda *args: True)
    monkeypatch.setattr(
        providers,
        "get_provider",
        lambda name: SimpleNamespace(get_daily=lambda *a, **kw: pl.DataFrame()),
    )
    monkeypatch.setattr(
        provider_registry,
        "get_provider",
        lambda name: SimpleNamespace(get_daily=lambda *a, **kw: pl.DataFrame()),
    )
    with pytest.raises(ValueError, match="stock-only"):
        prepare(Repo(tmp_path, market), None, request_for(market), lambda pct: None)
