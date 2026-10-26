"""Chart geometry derived from CZSC structures; never fetches market data."""


def _visible_centers(centers, through):
    return [c for c in centers if c["formedAt"] <= through and c["endDate"] <= through]


def build_trends(centers, through):
    """Use the same core-bound relation as the existing trendType proxy."""
    centers = _visible_centers(centers, through)
    groups = []
    for i, center in enumerate(centers):
        if not groups:
            groups.append({"direction": "none", "centers": [center]})
            continue
        previous = centers[i - 1]
        direction = (
            "up" if center["zd"] > previous["zg"]
            else "down" if center["zg"] < previous["zd"] else "none"
        )
        group = groups[-1]
        if group["direction"] == direction or len(group["centers"]) == 1:
            group["direction"] = direction
            group["centers"].append(center)
        else:
            groups.append({"direction": direction, "centers": [previous, center]})
    result = []
    for i, group in enumerate(groups):
        members = group["centers"]
        band = [
            {"date": date, "lower": c["zd"], "upper": c["zg"]}
            for c in members for date in (c["startDate"], c["endDate"])
        ]
        current = i == len(groups) - 1
        if current and through > band[-1]["date"]:
            band.append({**band[-1], "date": through})
        result.append({
            "id": f"trend-{members[0]['id']}-{group['direction']}",
            "direction": group["direction"],
            "centerIds": [c["id"] for c in members],
            "startDate": members[0]["startDate"], "endDate": band[-1]["date"],
            "availableDate": max(c["formedAt"] for c in members),
            "current": current, "band": band, "ruleSource": "project",
        })
    return result


def build_center_extensions(centers, through):
    visible = _visible_centers(centers, through)
    return [{
        "id": f"extension-{center['id']}", "centerId": center["id"],
        "startDate": center["endDate"], "endDate": through,
        "availableDate": center["formedAt"], "zd": center["zd"], "zg": center["zg"],
        "latest": i == len(visible) - 1, "ruleSource": "project",
    } for i, center in enumerate(visible) if center["endDate"] < through]
