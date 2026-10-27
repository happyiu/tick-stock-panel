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
        ("tas_macd_bc_V230804", {"di": 1}),
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


def test_macd_observations_match_official_hits_and_keep_first_known_time(official_replay):
    rows, _, hits, counts, _ = official_replay
    assert counts["多头"] > 0 and counts["空头"] > 0 and counts["其他"] > 0
    result = adapter.analyze_chanlun(rows)
    events = result["divergences"]
    assert {event["direction"] for event in events} == {"up", "down"}
    assert len({e["id"] for e in events}) == len(events)
    for event in events:
        index = next(i for i, r in enumerate(rows) if r["date"] == event["structureDate"])
        assert hits[("tas_macd_bc_V230804", index, event["availableDate"])] == event["rawSignal"]["value"]
        assert len(event["references"]) == 2
        assert event["availableDate"] >= event["structureDate"]
        assert event["ruleSource"] == "czsc"
    for event in events[:4]:
        prefix = adapter.analyze_chanlun(rows, as_of=event["availableDate"])
        matched = next(e for e in prefix["divergences"] if e["id"] == event["id"])
        assert matched["status"] == "candidate"
        earlier = [r for r in rows if r["date"] < event["availableDate"]]
        assert not any(e["id"] == event["id"] for e in adapter.analyze_chanlun(earlier)["divergences"])


def test_segment_completion_is_recorded_during_replay_not_backdated(official_replay):
    rows = official_replay[0]
    result = adapter.analyze_chanlun(rows)
    from app.services.chanlun_segments import build_segments
    inputs = [{**s, "startSourceIndex": s["start"]["sourceIndex"], "endSourceIndex": s["end"]["sourceIndex"],
               "low": min(s["startPrice"], s["endPrice"]), "high": max(s["startPrice"], s["endPrice"])}
              for s in result["strokes"]]
    full = build_segments(inputs)
    assert [(s["id"], s["confirmed"], s["confirmation"]) for s in result["segments"]] == [(s["id"], s["confirmed"], s["confirmation"]) for s in full]
    completed = [s for s in result["segments"] if s["confirmed"]]
    assert completed
    for segment in completed[:4]:
        assert segment["ruleSource"] == "project"
        assert segment["endDate"] < segment["confirmedAt"]
        prefix = adapter.analyze_chanlun(rows, as_of=segment["confirmedAt"])
        matched = next(s for s in prefix["segments"] if s["id"] == segment["id"])
        assert matched["confirmed"] is True
        assert matched["confirmedAt"] == segment["confirmedAt"]
        earlier = [r for r in rows if r["date"] < segment["confirmedAt"]]
        assert not any(s["id"] == segment["id"] and s["confirmed"] for s in adapter.analyze_chanlun(earlier)["segments"])


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


def test_macd_observation_lifecycle_keeps_historical_hits_and_deduplicates():
    rows = make_rows(120)
    c = czsc.CZSC([native_bar(r, i) for i, r in enumerate(rows)], max_bi_num=120, min_bi_len=6)
    bis, events, episodes = c.bi_list, [], {}
    assert len(bis) >= 7
    keys = [adapter._bi_key(b) for b in bis]
    raw = SimpleNamespace(v1="空头", key="test", value="空头_任意_任意_0")

    def step(day, matched, current_bis=bis):
        current_keys = [adapter._bi_key(b) for b in current_bis]
        adapter._update_divergences(events, episodes, current_bis, current_keys, set(keys),
                                    [raw] if matched else [], {"periodEnd": f"2025-01-{day:02}"}, rows)

    step(1, True)
    step(2, True)
    assert len(events) == 1
    step(3, False)
    assert events[0]["invalidationReason"] == "condition_disappeared"
    step(4, True)
    assert len(events) == 2 and events[1]["availableDate"] == "2025-01-04"
    step(5, False, [bis[-1], bis[0]])
    assert events[1]["status"] == "candidate"
    step(6, False, [bis[0]])
    assert events[1]["invalidationReason"] == "structure_replaced"


@pytest.mark.parametrize("period", ["1w", "1mo"])
def test_chart_geometry_uses_actual_closed_period_end(period):
    rows = make_rows(120)
    for i, row in enumerate(rows):
        start = datetime(2020, 1, 6) + timedelta(weeks=i) if period == "1w" else datetime(2020 + i // 12, i % 12 + 1, 1)
        row["date"] = str(start.date())
        row["period_end"] = str((start + timedelta(days=4 if period == "1w" else 20)).date())
    full = adapter.analyze_chanlun(rows, period=period)
    assert full["centers"]
    formed = full["centers"][-1]["formedAt"]
    prefix = [r for r in rows if r["period_end"] <= formed]
    result = adapter.analyze_chanlun(prefix, period=period)
    latest = result["centers"][-1]
    assert latest["formedAt"] == prefix[-1]["period_end"]
    assert latest["id"] in result["trends"][-1]["centerIds"]
    assert result["trends"][-1]["endDate"] == prefix[-1]["period_end"]
    assert all(e["endDate"] == prefix[-1]["period_end"] for e in result["centerExtensions"])


def test_projection_historical_prefix_and_open_tail_keep_same_scenarios():
    rows = make_rows(250)
    prefix = adapter.analyze_chanlun(rows[:200])["projection"]
    assert prefix["status"] == "ready"
    assert adapter.analyze_chanlun(rows, as_of=rows[199]["date"])["projection"] == prefix
    rows[200]["is_closed"] = False
    rows[200].update(open=100, high=101, low=99, close=100)
    assert adapter.analyze_chanlun(rows[:201])["projection"] == prefix


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
