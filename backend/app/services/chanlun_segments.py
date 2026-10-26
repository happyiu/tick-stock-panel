"""Project feature-sequence segments, using CZSC pens without recalculating them."""
from hashlib import sha256


def _features(strokes, start, end, direction):
    sequence = []
    for i in range(start, end + 1):
        pen = strokes[i]
        if pen["direction"] == direction or not pen["confirmed"]:
            continue
        item = {"high": pen["high"], "low": pen["low"], "index": i}
        previous = sequence[-1] if sequence else None
        if previous and (
            (previous["high"] >= item["high"] and previous["low"] <= item["low"])
            or (item["high"] >= previous["high"] and item["low"] <= previous["low"])
        ):
            up = direction == "up"
            extreme = max if up else min
            replaces = item["high"] >= previous["high"] if up else item["low"] <= previous["low"]
            sequence[-1] = {
                "high": extreme(previous["high"], item["high"]),
                "low": extreme(previous["low"], item["low"]),
                "index": i if replaces else previous["index"],
            }
        else:
            sequence.append(item)
    return sequence


def _turn(sequence, direction):
    for a, b, c in zip(sequence, sequence[1:], sequence[2:], strict=False):
        if direction == "up":
            valid = b["high"] > max(a["high"], c["high"]) and b["low"] > max(a["low"], c["low"])
        else:
            valid = b["high"] < min(a["high"], c["high"]) and b["low"] < min(a["low"], c["low"])
        if valid:
            return a, b, c
    return None


def build_segments(strokes, *, confirmed_prefix=()):
    result = list(confirmed_prefix)
    start = result[-1]["endStrokeIndex"] + 1 if result else 0
    while start + 2 < len(strokes):
        initial = strokes[start:start + 3]
        if max(p["low"] for p in initial) > min(p["high"] for p in initial):
            start += 1
            continue
        direction = strokes[start]["direction"]
        turn, reverse, confirmation_index, gap = None, None, None, False
        for end in range(start + 4, len(strokes)):
            found = _turn(_features(strokes, start + 1, end, direction), direction)
            if not found or found[1]["index"] - start < 3:
                continue
            a, b, _ = found
            has_gap = a["high"] < b["low"] if direction == "up" else a["low"] > b["high"]
            opposite = "down" if direction == "up" else "up"
            reverse_turn = _turn(_features(strokes, b["index"], end, opposite), opposite) if has_gap else None
            if has_gap and not reverse_turn:
                continue
            turn, reverse, confirmation_index, gap = found, reverse_turn, end, has_gap
            break
        if turn:
            endpoint = turn[1]["index"] - 1
        else:
            endpoint = start + 2
            for i in range(start + 2, len(strokes)):
                if strokes[i]["direction"] != direction:
                    continue
                value, previous = strokes[i]["endPrice"], strokes[endpoint]["endPrice"]
                extends = value >= previous if direction == "up" else value <= previous
                if extends:
                    endpoint = i
        first, last = strokes[start], strokes[endpoint]
        members = strokes[start:endpoint + 1]
        identity = f"{first['startDate']}|{last['endDate']}|{first['startPrice']}|{last['endPrice']}"
        result.append({
            "id": f"segment-{sha256(identity.encode()).hexdigest()[:20]}",
            "index": len(result), "direction": direction,
            "startStrokeIndex": start, "endStrokeIndex": endpoint,
            "startDate": first["startDate"], "endDate": last["endDate"],
            "startPrice": first["startPrice"], "endPrice": last["endPrice"],
            "low": min(p["low"] for p in members), "high": max(p["high"] for p in members),
            "componentCount": len(members),
            "bars": last["endSourceIndex"] - first["startSourceIndex"] + 1,
            "changePct": last["endPrice"] / first["startPrice"] - 1,
            "confirmed": turn is not None,
            "confirmedAt": max(p["confirmedAt"] for p in strokes[start:confirmation_index + 1] if p["confirmedAt"]) if turn else None,
            "confirmation": {
                "hasGap": gap,
                "featureStrokeIndices": [p["index"] for p in turn] if turn else [],
                "reverseFeatureStrokeIndices": [p["index"] for p in reverse] if reverse else [],
                "lastStrokeIndex": confirmation_index,
            },
            "ruleSource": "project", "rule": "feature-sequence-v1",
        })
        if not turn:
            break
        start = endpoint + 1
    return result
