"""Eligibility first, bounded routing graph second; no network in Python."""
from datetime import datetime, timedelta
import math
from zoneinfo import ZoneInfo

from .selection import MAX_OPTIONS_PER_DAY, POLICY_VERSION, clock, integer, prepare, validate_selection

ROUTING_POLICY = "dated-routing.v1"


def departure_utc(day, minutes, timezone):
    # Includes 24:00 at the next midnight. Host OS timezone is irrelevant.
    local = datetime.fromisoformat(day["date"]).replace(tzinfo=ZoneInfo(timezone)) + timedelta(minutes=minutes)
    return int(local.timestamp())


def _distance(a, b):
    """Haversine for shortlist priority ONLY; never a route/time estimate."""
    lat1, lat2 = math.radians(a["lat"]), math.radians(b["lat"])
    dl, dn = lat2 - lat1, math.radians(b["lon"] - a["lon"])
    value = math.sin(dl / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dn / 2) ** 2
    return 6371000 * 2 * math.asin(math.sqrt(min(1, value)))


def prepare_routes(job):
    if "candidate_pool" in job: raise ValueError("shortlist must be built by the server")
    job = job | {"route_legs": []}
    p = prepare(job, enforce_option_limit=False)
    if p["issues"]:
        return {"schema_version": POLICY_VERSION, "status": "NEEDS_INPUT", "issues": p["issues"], "days": []}
    mode = p["intent"]["shared"]["mobility"][0]
    if mode != "walking" and p["budget_limit"] is not None:
        return {"schema_version": POLICY_VERSION, "status": "NEEDS_INPUT", "issues": ["TRANSPORT_COST_POLICY_REQUIRED"], "days": []}
    limit = integer(job.get("routing_policy", {}).get("candidates_per_activity", 4), "shortlist size", 1, 8)
    points = p["intent"]["points"]
    origin, selected, groups, pairs = points["origin"], [], [], []
    for day in p["days"]:
        did = day["day_id"]
        chosen = []
        for activity in day["activities"]:
            options = [o for o in p["options"] if o.day_id == did and o.activity_id == activity["id"]]
            ranked = sorted(options, key=lambda o: (-o.preference, _distance(origin, p["places"][o.place_id]["point"]), -o.quality, o.place_id))
            chosen.extend(ranked[:limit])
            groups.append({"day_id": did, "activity_id": activity["id"], "eligible": len(ranked),
                           "selected": len(ranked[:limit]), "truncated": len(ranked) > limit})
        if len(chosen) > MAX_OPTIONS_PER_DAY:
            return {"schema_version": POLICY_VERSION, "status": "NEEDS_INPUT", "issues": ["CANDIDATE_POOL_TOO_LARGE"], "days": []}
        selected.extend(chosen)
        edges = {("@origin", o.place_id) for o in chosen}
        if p["destination"] is not None:
            edges.update((o.place_id, "@destination") for o in chosen)
        for a in chosen:
            for b in chosen:
                if a.activity_id != b.activity_id and a.place_id != b.place_id and (b.activity_id, a.activity_id) not in p["precedence"][did]:
                    edges.add((a.place_id, b.place_id))
        start, end = clock(day["window"]["start"]), clock(day["window"]["end"])
        # Three traffic-statistics samples for a car; not a proven upper bound.
        samples = sorted({start, (start + end) // 2, end - 1}) if mode == "driving" else [start]
        for before, after in sorted(edges):
            pairs.append({"day_id": did, "from_id": before, "to_id": after,
                          "from_point": origin if before == "@origin" else p["places"][before]["point"],
                          "to_point": p["destination"] if after == "@destination" else p["places"][after]["point"],
                          "date": day["date"], "window": day["window"], "mode": mode,
                          "sample_utc": [departure_utc(day, minute, p["intent"]["locality"]["timezone"]) for minute in samples]})
    pool = [{"day_id": o.day_id, "activity_id": o.activity_id, "place_id": o.place_id} for o in selected]
    narrowed = job | {"candidate_pool": pool}
    # Solver cap is still enforced after bounded shortlisting.
    checked = prepare(narrowed)
    if checked["issues"]:
        return {"schema_version": POLICY_VERSION, "status": "NEEDS_INPUT", "issues": checked["issues"], "days": []}
    return {"schema_version": POLICY_VERSION, "status": "AVAILABLE", "job": narrowed,
            "pairs": pairs, "shortlist": {"policy": ROUTING_POLICY, "groups": groups,
            "method": "verified_preferences_then_origin_distance_then_shrunk_rating", "global_optimality_claimed": False},
            "maximum_selected_legs": sum(len(d["activities"]) + int(p["destination"] is not None) for d in p["days"])}


def route_checks(envelope):
    """Independently validate the solved plan, then emit exact departure instants."""
    job, result = envelope["job"], envelope["result"]
    validate_selection(job, result)
    p = prepare(job)
    checks = []
    for day, output in zip(p["days"], result["days"], strict=True):
        previous, minute = "@origin", clock(day["window"]["start"])
        for visit in output["visits"]:
            leg = p["legs"][(day["day_id"], previous, visit["place_id"])]
            checks.append(leg | {"departure_utc": departure_utc(day, minute, p["intent"]["locality"]["timezone"])})
            previous, minute = visit["place_id"], visit["ends_at"]
        if output["visits"] and p["destination"] is not None:
            leg = p["legs"][(day["day_id"], previous, "@destination")]
            checks.append(leg | {"departure_utc": departure_utc(day, minute, p["intent"]["locality"]["timezone"])})
    return {"schema_version": POLICY_VERSION, "status": "AVAILABLE", "checks": checks}
