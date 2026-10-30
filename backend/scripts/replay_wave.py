"""Offline reconstruction report: uv run python scripts/replay_wave.py bars.json --period 30m."""

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.services.wave import analyze_wave


def replay(rows, period):
    results = [analyze_wave(rows[:i], period) for i in range(1, len(rows) + 1)]
    identities = [r["counts"][0]["id"] if r.get("counts") else None for r in results]
    rates = {}
    for step in (1, 3, 5):
        pairs = [
            (a, b) for a, b in zip(identities, identities[step:], strict=False) if a is not None
        ]
        rates[str(step)] = dict(
            samples=len(pairs),
            changes=sum(a != b for a, b in pairs),
            rate=sum(a != b for a, b in pairs) / len(pairs) if pairs else None,
        )
    invalidation_delays = []
    seen_invalidations = set()
    previously_active = set()
    for index, result in enumerate(results):
        for candidate in result.get("invalidated", []):
            ident = candidate["id"]
            if ident in previously_active and ident not in seen_invalidations:
                breach = candidate.get("effectiveAt")
                breach_index = next((i for i, r in enumerate(rows) if r["date"] == breach), None)
                if breach_index is not None:
                    invalidation_delays.append(max(0, index - breach_index))
                seen_invalidations.add(ident)
        previously_active.update(
            c["id"] for c in result.get("counts", []) if c.get("currentPosition", {}).get("active")
        )
    delays = {}
    for result in results:
        for count in result.get("counts", []):
            for p in count["points"]:
                delays[(p["date"], p["confirmedAt"])] = sum(
                    p["date"] < r["date"] <= p["confirmedAt"] for r in rows
                )
    return dict(
        provenance="reconstructed_from_current_data",
        period=period,
        bars=len(rows),
        changes=rates,
        confirmationDelayBars=list(delays.values()),
        invalidationDelayBars=invalidation_delays,
        multiPeriodCoherence="requires paired daily and 30m data; not measured by this single-period report",
        generatedAt=datetime.now().isoformat(),
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--period", choices=["1d", "30m"], default="1d")
    args = parser.parse_args()
    payload = json.loads(args.input.read_text())
    print(
        json.dumps(
            replay(payload.get("rows", []) if isinstance(payload, dict) else payload, args.period),
            ensure_ascii=False,
            indent=2,
        )
    )
