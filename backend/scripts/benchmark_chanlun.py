"""Run from backend/: uv run python scripts/benchmark_chanlun.py.

Reports process RSS, including native allocations; no user data is read or written.
"""

import json
import random
import sys
from datetime import datetime, timedelta
from pathlib import Path
from threading import Event, Thread
from time import perf_counter

import psutil

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.services.chanlun import _analyze_cached, analyze_chanlun


def measure(n):
    rng = random.Random(42)
    price, rows = 20, []
    for i in range(n):
        price = max(2, price + rng.uniform(-0.6, 0.6))
        rows.append(
            dict(
                date=str((datetime(2000, 1, 1) + timedelta(days=i)).date()),
                open=price,
                close=price,
                high=price + 0.1,
                low=price - 0.1,
                volume=rng.uniform(100, 10000),
                amount=10000,
                is_closed=True,
            )
        )
    _analyze_cached.cache_clear()
    process = psutil.Process()
    start_rss = process.memory_info().rss
    peak = [start_rss]
    done = Event()

    def sample():
        while not done.wait(0.02):
            peak[0] = max(peak[0], process.memory_info().rss)

    thread = Thread(target=sample, daemon=True)
    thread.start()
    try:
        start = perf_counter()
        result = analyze_chanlun(rows)
        cold = perf_counter() - start
        assert result["status"] == "ready", result["issues"]
        start = perf_counter()
        assert analyze_chanlun(rows) == result
        warm = perf_counter() - start
    finally:
        done.set()
        thread.join()
    return dict(
        bars=n,
        cold_seconds=round(cold, 4),
        cached_seconds=round(warm, 4),
        rss_start_mib=round(start_rss / 2**20, 1),
        rss_peak_mib=round(peak[0] / 2**20, 1),
        rss_end_mib=round(process.memory_info().rss / 2**20, 1),
        strokes=len(result["strokes"]),
        events=len(result["candidateSignals"]),
    )


if __name__ == "__main__":
    for size in (500, 2000, 5000):
        print(json.dumps(measure(size)), flush=True)
