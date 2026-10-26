"""Official native parity and project event semantics (no market/network dependencies)."""

import random
from collections import Counter
from datetime import datetime, timedelta
from types import SimpleNamespace

import czsc
import pytest
from czsc._native.signals import call_signal

from app.services import chanlun as adapter


def make_rows(n=1500):
    rng = random.Random(42)
    price, rows = 20, []
    for i in range(n):
        price = max(2, price + rng.uniform(-0.6, 0.6))
        rows.append(
            dict(
                date=str((datetime(2020, 1, 1) + timedelta(days=i)).date()),
                open=price,
                close=price,
                high=price + 0.1,
                low=price - 0.1,
                volume=rng.uniform(100, 10000),
                amount=10000,
                is_closed=True,
            )
        )
    return rows


def native_bar(row, i):
    return czsc.RawBar(
        symbol="TEST",
        dt=datetime.fromisoformat(row["date"]),
        freq=czsc.Freq.D,
        id=i,
        open=row["open"],
        close=row["close"],
        high=row["high"],
        low=row["low"],
        vol=row["volume"],
        amount=row["amount"],
    )


def raw_endpoint(fx):
    # Independent oracle uses official middle candle constituent prices.
    bars = fx.elements[1].elements
    return [b for b in bars if (b.high if fx.mark == czsc.Mark.G else b.low) == fx.fx][-1]


@pytest.fixture(scope="module")
def official_replay():
    rows = make_rows()
    c = czsc.CZSC([native_bar(rows[0], 0)], max_bi_num=len(rows), min_bi_len=6)
    hits, snapshots, counters = {}, {}, Counter()
    # These are fixed official rules, independent of the adapter registry.
    rules = [
        ("cxt_first_buy_V221126", {"di": 1}),
        ("cxt_first_sell_V221126", {"di": 1}),
        ("cxt_second_bs_V240524", {"di": 1, "w": 9, "t": 2}),
        ("cxt_third_bs_V230318", {"di": 1, "timeperiod": 34, "ma_type": "SMA"}),
    ]
    last_len, rollbacks = 0, 0
    for i, row in enumerate(rows):
        if i:
            c.update(native_bar(row, i))
        bis = c.bi_list
        if len(bis) < last_len:
            rollbacks += 1
        last_len = len(bis)
        for name, params in rules:
            for signal in call_signal(name, c, params):
                counters[signal.v1] += 1
                if signal.v1 != "其他":
                    hits[(name, raw_endpoint(bis[-1].fx_b).id, row["date"])] = signal.value
        if i in {39, 79, 119, 159, 199, 249, 359, 749, len(rows) - 1}:
            snapshots[i] = {
                "bis": [
                    (
                        raw_endpoint(b.fx_a).id,
                        raw_endpoint(b.fx_b).id,
                        b.fx_a.fx,
                        b.fx_b.fx,
                        b.length,
                    )
                    for b in bis
                ],
                "finished": {
                    (raw_endpoint(b.fx_a).id, raw_endpoint(b.fx_b).id) for b in c.finished_bis
                },
                "centers": [
                    (z.zd, z.zg, z.dd, z.gg, len(z.bis))
                    for z in c.zs_list
                    if len(z.bis) >= 3 and z.is_valid()
                ],
                "fx": [(raw_endpoint(f).id, f.fx) for f in c.fx_list],
            }
    return rows, snapshots, hits, counters, rollbacks


def test_native_parity_at_historical_checkpoints(official_replay):
    rows, snapshots, _, _, rollbacks = official_replay
    assert rollbacks > 0
    for i, oracle in snapshots.items():
        result = adapter.analyze_chanlun(rows[: i + 1])
        assert result["status"] in {"ready", "insufficient"}
        assert [
            (
                s["start"]["sourceIndex"],
                s["end"]["sourceIndex"],
                s["startPrice"],
                s["endPrice"],
                s["mergedBars"],
            )
            for s in result["strokes"]
        ] == oracle["bis"]
        assert {
            (s["start"]["sourceIndex"], s["end"]["sourceIndex"])
            for s in result["strokes"]
            if s["confirmed"]
        } == oracle["finished"]
        assert [
            (c["zd"], c["zg"], c["dd"], c["gg"], c["componentCount"]) for c in result["centers"]
        ] == oracle["centers"]
        assert [(f["sourceIndex"], f["price"]) for f in result["fractals"]] == oracle["fx"]


def test_all_six_signal_types_match_native_at_first_observation(official_replay):
    rows, _, hits, counts, _ = official_replay
    assert set(counts) >= {"一买", "一卖", "二买", "二卖", "三买", "三卖", "其他"}
    result = adapter.analyze_chanlun(rows)
    events = result["candidateSignals"]
    assert {s["kind"] for s in events} == set(adapter.KINDS.values())
    for s in events:
        index = next(i for i, r in enumerate(rows) if r["date"] == s["structureDate"])
        assert hits[(s["rule"]["function"], index, s["availableDate"])] == s["rawSignal"]["value"]
        assert s["availableDate"] >= s["structureDate"]
    assert len({s["id"] for s in events}) == len(events)


def test_missing_volume_disables_only_first_class_and_is_prefix_local():
    rows = make_rows(400)
    before = adapter.analyze_chanlun(rows[:200])
    rows[200]["volume"] = None
    result = adapter.analyze_chanlun(rows)
    assert result["strokes"] and result["issues"]
    assert not any(
        s["kind"].startswith("first_") and s["availableDate"] >= rows[200]["date"]
        for s in result["candidateSignals"]
    )
    assert adapter.analyze_chanlun(rows, as_of=rows[199]["date"]) == before
    missing = [{k: v for k, v in r.items() if k != "volume"} for r in rows]
    assert not any(
        s["kind"].startswith("first_") for s in adapter.analyze_chanlun(missing)["candidateSignals"]
    )


@pytest.mark.parametrize("field,value", [("volume", -1), ("volume", float("inf")), ("amount", -1)])
def test_invalid_volume_and_amount_fail_closed(field, value):
    rows = make_rows(50)
    rows[0][field] = value
    assert adapter.analyze_chanlun(rows)["status"] == "invalid_data"


def test_cache_accounts_for_volume_amount_and_engine_config():
    rows = make_rows(80)
    adapter._analyze_cached.cache_clear()
    for key in (None, "volume", "amount"):
        sample = [dict(r) for r in rows]
        if key:
            sample[0][key] *= 2
        adapter.analyze_chanlun(sample)
    assert adapter._analyze_cached.cache_info().misses == 3
    assert adapter._analyze_cached.cache_info().maxsize == 16


def test_no_closed_bars_does_not_load_native_and_segment_is_explicit(monkeypatch):
    def fail():
        raise AssertionError("must not load engine")

    monkeypatch.setattr(adapter, "_load_engine", fail)
    assert adapter.analyze_chanlun([])["status"] == "insufficient"
    assert adapter.analyze_chanlun(make_rows(3), source="segment")["status"] == "unsupported"
    assert (
        adapter.analyze_chanlun([{**r, "is_closed": False} for r in make_rows(3)])["status"]
        == "insufficient"
    )


def test_weekly_monthly_first_knowledge_uses_actual_period_end():
    rows = make_rows(100)
    for r in rows:
        r["period_end"] = str(datetime.fromisoformat(r["date"]).date() + timedelta(days=3))
    for period in ("1w", "1mo"):
        result = adapter.analyze_chanlun(rows, period=period)
        assert result["strokes"]
        for s in result["strokes"]:
            assert s["observedAt"] >= str(
                datetime.fromisoformat(s["endDate"]).date() + timedelta(days=3)
            )
        assert adapter.analyze_chanlun(
            rows, period=period, as_of=rows[-1]["date"] + " 10:00"
        ) == adapter.analyze_chanlun(rows[:-4], period=period)


def test_event_lifecycle_dedup_withdrawal_reappearance_and_moving_window():
    rows = make_rows(100)
    c = czsc.CZSC([native_bar(r, i) for i, r in enumerate(rows)], max_bi_num=100, min_bi_len=6)
    bis = c.bi_list
    key = adapter._bi_key(bis[-1])
    finished = {key}
    events, episodes = [], {}
    rule = adapter.SIGNAL_RULES[2]
    raw = SimpleNamespace(v1="二买", key="test", value="二买_任意_任意_0")

    # Prices stay safely above the endpoint boundary for this lifecycle test.
    def step(day, matches, current_bis=bis):
        row = dict(date=f"2025-01-{day:02}", periodEnd=f"2025-01-{day:02}", low=100, high=101)
        adapter._update_signals(events, episodes, current_bis, finished, matches, row, rows)

    step(1, [(rule, raw)])
    step(2, [(rule, raw)])
    assert len(events) == 1 and events[0]["status"] == "candidate"
    step(3, [])
    assert events[0]["invalidationReason"] == "structure_replaced"
    step(4, [(rule, raw)])
    assert len(events) == 2 and events[1]["availableDate"] == "2025-01-04"
    # A newer pen moves the dispatch window; the old signal is retained.
    step(5, [], [bis[-1], bis[0]])
    assert events[1]["status"] == "candidate"
    # Removing its actual endpoint invalidates it.
    step(6, [], [bis[0]])
    assert events[1]["status"] == "invalidated"


def test_price_invalidation_does_not_repeat_while_condition_stays_true():
    rows = make_rows(100)
    c = czsc.CZSC([native_bar(r, i) for i, r in enumerate(rows)], max_bi_num=100, min_bi_len=6)
    bis = c.bi_list
    events, episodes = [], {}
    rule = adapter.SIGNAL_RULES[2]
    raw = SimpleNamespace(v1="二买", key="test", value="二买_任意_任意_0")
    for day in (1, 2, 3):
        row = dict(date=f"2025-01-{day:02}", periodEnd=f"2025-01-{day:02}", low=0, high=100)
        adapter._update_signals(events, episodes, bis, set(), [(rule, raw)], row, rows)
    assert len(events) == 1
    assert events[0]["invalidationReason"] == "price_boundary"


def test_runtime_failure_is_not_cached(monkeypatch):
    rows = make_rows(40)
    adapter._analyze_cached.cache_clear()
    native, _ = adapter._load_engine()

    def fail(*args):
        raise RuntimeError("synthetic signal failure")

    original = adapter._load_engine
    monkeypatch.setattr(adapter, "_load_engine", lambda: (native, fail))
    assert adapter.analyze_chanlun(rows)["status"] == "invalid_data"
    monkeypatch.setattr(adapter, "_load_engine", original)
    assert adapter.analyze_chanlun(rows)["status"] == "ready"


def test_source_indices_remain_aligned_with_open_intervening_candles():
    rows = make_rows(120)
    rows[30]["is_closed"] = False
    result = adapter.analyze_chanlun(rows)
    assert result["status"] == "ready"
    for fx in result["fractals"]:
        assert rows[fx["sourceIndex"]]["date"] == fx["date"]
        assert rows[fx["confirmedSourceIndex"]]["is_closed"]


def test_zero_width_native_center_is_retained():
    # The official ZS API accepts boundary contact. Test projection independently
    # of whether this artificial BI sequence would be produced by check_bi.
    rows = [
        dict(date=f"2025-01-{i + 1:02}", sourceIndex=i, periodEnd=f"2025-01-{i + 1:02}")
        for i in range(6)
    ]

    def fx(i, price):
        dt = datetime.fromisoformat(rows[i]["date"])
        raw = czsc.RawBar(
            symbol="TEST",
            dt=dt,
            freq=czsc.Freq.D,
            open=price,
            close=price,
            high=price,
            low=price,
            vol=1,
            amount=1,
            id=i,
        )
        bar = czsc.NewBar(
            symbol="TEST",
            dt=dt,
            freq=czsc.Freq.D,
            open=price,
            close=price,
            high=price,
            low=price,
            vol=1,
            amount=1,
            id=i,
            elements=[raw],
        )
        return czsc.FX(
            symbol="TEST",
            dt=dt,
            mark=czsc.Mark.G,
            high=price,
            low=price,
            fx=price,
            elements=[bar, bar, bar],
        )

    endpoints = [fx(i, price) for i, price in enumerate([10, 12, 12, 15, 12, 18])]
    bis = [
        czsc.BI(
            symbol="TEST",
            direction=czsc.Direction.Up,
            fx_a=endpoints[i],
            fx_b=endpoints[i + 1],
            fxs=endpoints[i : i + 2],
            bars=[endpoints[i].elements[1], endpoints[i + 1].elements[1]],
        )
        for i in (0, 2, 4)
    ]
    z = czsc.ZS(bis)
    assert z.is_valid() and z.zd == z.zg == 12
    known = {}
    for bi in bis:
        known[("observed", adapter._bi_key(bi))] = rows[-1]["date"]
        known[("finished", adapter._bi_key(bi))] = rows[-1]["date"]
        for f in (bi.fx_a, bi.fx_b):
            known[("fx", adapter._fx_key(f))] = rows[-1]["date"]
            known[("fx_index", adapter._fx_key(f))] = 5
    known[("center", (adapter._bi_key(bis[0]), z.zd, z.zg))] = rows[-1]["date"]
    engine = SimpleNamespace(
        bi_list=bis, finished_bis=bis, bars_ubi=[], fx_list=endpoints, zs_list=[z]
    )
    result = adapter._empty("1d", "stroke", [], [])
    result["currentPrice"] = 12
    adapter._project_structures(result, engine, rows, known)
    assert result["centers"][0]["zd"] == result["centers"][0]["zg"] == 12
