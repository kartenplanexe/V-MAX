"""Select places for confirmed activities using OR-Tools CP-SAT.

The input is a server-owned intent plus canonical facts and directed safe route
legs. It is not a raw LLM response. Missing edges are forbidden, not estimated.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
import math
import re
import time
from zoneinfo import ZoneInfo

from ortools.sat.python import cp_model

POLICY_VERSION = "place-selection.v1"
SUPPORTED_MODES = {"walking", "driving", "cycling"}
MAX_OPTIONS_PER_DAY = 120


def integer(value, name, minimum=0, maximum=10**10):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f"{name}: invalid integer")
    return value


def clock(value):
    if not isinstance(value, str) or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d|24:00", value):
        raise ValueError("invalid local time")
    return int(value[:2]) * 60 + int(value[3:])


def instant(value):
    if not isinstance(value, str):
        raise ValueError("timestamp required")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError("invalid timestamp") from error
    if parsed.tzinfo is None:
        raise ValueError("timestamp must include timezone")
    return parsed


def fresh(source, now):
    if not isinstance(source, dict) or source.get("data_mode") not in {"live", "test", "prepared"}:
        return False
    try:
        return bool(source.get("provider")) and instant(source.get("fetched_at")) <= now < instant(source.get("valid_until"))
    except ValueError:
        return False


def point_valid(point):
    return isinstance(point, dict) and all(
        type(point.get(key)) in (float, int) and math.isfinite(point[key]) and -limit <= point[key] <= limit
        for key, limit in (("lat", 90), ("lon", 180)))


def same_point(a, b):
    return point_valid(a) and point_valid(b) and all(a[k] == b[k] for k in ("lat", "lon"))


def nonempty(value, name):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name}: nonempty string required")
    return value


def ids(values, name):
    if not isinstance(values, list) or any(not isinstance(v, str) or not v for v in values) or len(set(values)) != len(values):
        raise ValueError(f"{name}: unique string IDs required")
    return values


@dataclass(frozen=True)
class Option:
    day_id: str
    activity_id: str
    place_id: str
    duration: int
    windows: tuple[tuple[int, int], ...]
    expected: int | None
    upper: int | None
    charged: int
    preference: int
    quality: int
    reasons: tuple[str, ...]
    warnings: tuple[str, ...]


def _price(place, party):
    price = place.get("price")
    if price is None:
        return None, None
    if not isinstance(price, dict) or price.get("basis") not in {"per_person", "whole_party"}:
        return None, None
    multiplier = party if price["basis"] == "per_person" else 1
    if multiplier is None:
        return None, None
    values = [None if price.get(key) is None else integer(price[key], key) * multiplier
              for key in ("expected_minor", "upper_minor")]
    if all(v is not None for v in values) and values[0] > values[1]:
        raise ValueError("price estimate exceeds upper bound")
    return tuple(values)


def _quality(place):
    """Weak tie-break only; versioned prior, not a trained relevance model."""
    reviews = place.get("reviews") or {}
    rating, count = reviews.get("rating"), reviews.get("count")
    if rating is None or count is None:
        return 350
    if type(rating) not in (int, float) or not math.isfinite(rating) or not 0 <= rating <= 5:
        raise ValueError("invalid rating")
    integer(count, "review count", maximum=100_000_000)
    return round(100 * (rating * count + 3.5 * 20) / (count + 20))


def prepare(job, *, enforce_option_limit=True):
    if not isinstance(job, dict) or job.get("schema_version") != POLICY_VERSION:
        raise ValueError("unsupported selection schema")
    now = instant(job.get("as_of"))
    intent = job.get("intent")
    if not isinstance(intent, dict) or intent.get("schema_version") != "confirmed-daily-intent.research.v1":
        raise ValueError("confirmed daily intent required; raw model response is not accepted")
    integer(intent.get("draft_revision"), "draft_revision")
    locality, shared = intent.get("locality"), intent.get("shared", {})
    if not isinstance(locality, dict) or not isinstance(shared, dict):
        raise ValueError("locality and shared required")
    region = nonempty(locality.get("region_id"), "region_id")
    timezone = ZoneInfo(nonempty(locality.get("timezone"), "timezone"))
    local_now = now.astimezone(timezone)
    issues = []
    for field in set(shared) - {"mobility", "party", "budget", "locality_text", "origin_text", "destination_text", "exploratory"}:
        issues.append(f"UNSUPPORTED_SHARED_FIELD:{field}")
    modes = shared.get("mobility", [])
    if not isinstance(modes, list) or len(modes) != 1 or modes[0] not in SUPPORTED_MODES:
        issues.append("UNSUPPORTED_TRANSPORT")
    mode = modes[0] if isinstance(modes, list) and len(modes) == 1 else None
    points = intent.get("points", {})
    if not point_valid(points.get("origin")):
        issues.append("ORIGIN_REQUIRED")
    destination = points.get("destination")
    if shared.get("destination_text") and destination is None:
        issues.append("DESTINATION_REQUIRED")
    if destination is not None and not point_valid(destination):
        issues.append("DESTINATION_REQUIRED")
    for point in points.values():
        if isinstance(point, dict) and point.get("locality_id") != locality.get("id"):
            issues.append("POINT_LOCALITY_MISMATCH")
    party = (shared.get("party") or {}).get("total")
    if party is not None:
        integer(party, "party.total", 1, 100)
    # No inference of age suitability from the mere absence of an age restriction.
    if (shared.get("party") or {}).get("child_ages"):
        issues.append("AGE_ELIGIBILITY_NOT_IMPLEMENTED")
    budget = shared.get("budget") or {"kind": "unspecified"}
    if budget.get("kind") not in {"unspecified", "unlimited", "limit"}:
        raise ValueError("unknown budget kind")
    budget_limit = None
    period = budget.get("period")
    if budget.get("kind") == "limit":
        amount = Decimal(str(budget.get("amount_rub")))
        if not amount.is_finite() or amount < 0 or amount > 100_000_000 or amount * 100 != (amount * 100).to_integral_value():
            raise ValueError("invalid budget amount")
        if budget.get("basis") not in {"per_person", "whole_party"} or period not in {"per_day", "whole_trip"}:
            issues.append("BUDGET_SCOPE_REQUIRED")
        if budget.get("basis") == "per_person" and party is None:
            issues.append("PARTY_REQUIRED")
        budget_limit = int(amount * 100) * (party if budget.get("basis") == "per_person" and party else 1)
    budget_policy = job.get("budget_policy", "upper_bound")
    if budget_policy not in {"upper_bound", "estimate"}:
        raise ValueError("invalid budget policy")
    policy = job.get("visit_policy", {})
    nonempty(policy.get("version"), "visit_policy.version")
    durations = policy.get("by_category", {})
    if not isinstance(durations, dict):
        raise ValueError("duration policy required")
    for value in durations.values(): integer(value, "visit duration", 1, 1440)
    buffer = integer(policy.get("arrival_buffer_minutes"), "arrival buffer", 0, 120)
    catalog = job.get("catalog", {})
    leaves = set(ids(catalog.get("leaf_ids"), "catalog.leaf_ids"))
    if catalog.get("region_id") != region or not catalog.get("version"):
        issues.append("CATALOG_MISMATCH")
    days = intent.get("days")
    if not isinstance(days, list) or not days or len(days) > 31:
        raise ValueError("days must contain 1..31 items per planning job")
    if sum(len(d.get("activities", [])) for d in days) > 120:
        raise ValueError("too many activities per planning job")
    ids([d.get("day_id") for d in days], "days")
    ids([d.get("date") for d in days], "dates")
    days = sorted(days, key=lambda d: (d["date"], d["day_id"]))
    precedence = {}
    for day in days:
        parsed_date = date.fromisoformat(day["date"])
        window = day.get("window") or {}
        start, end = clock(window.get("start")), clock(window.get("end"))
        if end <= start: raise ValueError("empty or overnight day window")
        if parsed_date < local_now.date() or (parsed_date == local_now.date() and start < local_now.hour * 60 + local_now.minute):
            issues.append("WINDOW_EXPIRED")
        if day.get("duration_constraint_minutes") is not None and end - start != day["duration_constraint_minutes"]:
            issues.append("TIME_CONFLICT")
        activities = day.get("activities")
        if not isinstance(activities, list) or not activities:
            issues.append("ACTIVITIES_REQUIRED")
            continue
        if len(activities) > 120: raise ValueError("too many activities in a day")
        activity_ids = ids([a.get("id") for a in activities], "activities")
        graph = {aid: set() for aid in activity_ids}
        for edge in day.get("order", []):
            if not isinstance(edge, list) or len(edge) != 2 or any(a not in graph for a in edge) or edge[0] == edge[1]:
                raise ValueError("invalid activity order")
            graph[edge[0]].add(edge[1])
        pending = set(graph)
        while pending:
            roots = {a for a in pending if not any(a in graph[b] for b in pending)}
            if not roots: raise ValueError("cyclic activity order")
            pending -= roots
        # A -> B -> C still means A before C when B has no eligible places.
        closure = {a: set(targets) for a, targets in graph.items()}
        for intermediate in graph:
            for a in graph:
                if intermediate in closure[a]: closure[a].update(closure[intermediate])
        precedence[day["day_id"]] = [(a, b) for a in sorted(closure) for b in sorted(closure[a])]
        for activity in activities:
            selection = activity.get("selection") or {}
            if selection.get("category_policy") not in {"related_allowed", "named_types_only"}:
                issues.append("CATEGORY_POLICY_REQUIRED")
            if selection.get("category_policy") == "named_types_only" and not selection.get("named_types"):
                issues.append("STRICT_TYPES_REQUIRED")
            c = activity.get("categories") or {}
            include, exclude = ids(c.get("include_any"), "include_any"), ids(c.get("exclude"), "exclude")
            if c.get("state") != "matched" or c.get("region_id") != region or c.get("catalog_version") != catalog.get("version") or not include or not set(include + exclude) <= leaves or set(include) & set(exclude):
                issues.append("CATALOG_MISMATCH")
            for requirement in activity.get("requirements", []):
                nonempty(requirement.get("text"), "requirement")
                if requirement.get("strength") not in {"required", "preferred"}: raise ValueError("invalid requirement strength")
    places = job.get("places", [])
    if not isinstance(places, list) or len(places) > 2000: raise ValueError("invalid candidate pool")
    ids([p.get("id") for p in places], "places")
    if any(p["id"].startswith("@") for p in places): raise ValueError("reserved place ID")
    places = {p["id"]: p for p in sorted(places, key=lambda p: p["id"])}
    options, excluded = [], []
    for day in days:
        start, end = clock(day["window"]["start"]), clock(day["window"]["end"])
        day_count = 0
        for activity in sorted(day["activities"], key=lambda a: a["id"]):
            include, exclude = set(activity["categories"]["include_any"]), set(activity["categories"]["exclude"])
            for pid, place in places.items():
                reasons, warnings = [], list(place.get("normalization_warnings") or [])
                categories = set(ids(place.get("rubric_ids", []), "place.rubric_ids"))
                matching = include & categories
                if not matching: reasons.append("CATEGORY_MISMATCH")
                if categories & exclude: reasons.append("EXCLUDED_CATEGORY")
                if place.get("region_id") != region: reasons.append("REGION_MISMATCH")
                if not point_valid(place.get("point")): reasons.append("POINT_UNKNOWN")
                if not fresh(place.get("source"), now): reasons.append("STALE_OR_UNKNOWN_SOURCE")
                if any(c not in durations for c in matching): reasons.append("DURATION_UNKNOWN")
                duration = max((durations.get(c, 0) for c in matching), default=0)
                raw_windows = (place.get("opening_intervals") or {}).get(day["date"])
                windows = []
                if raw_windows is None:
                    reasons.append("SCHEDULE_UNKNOWN")
                else:
                    for opening, closing in raw_windows:
                        integer(opening, "opening", 0, 1440); integer(closing, "closing", 0, 1440)
                        if closing <= opening: raise ValueError("invalid opening interval")
                        low, high = max(start, opening), min(end, closing) - duration
                        if low <= high: windows.append((low, high))
                    if not windows: reasons.append("NO_VISIT_WINDOW")
                facts = place.get("facts") or {}
                if any(type(v) is not bool for v in facts.values()): raise ValueError("facts must be verified booleans")
                preferred = 0
                for requirement in activity.get("requirements", []):
                    known = facts.get(requirement["text"])
                    if requirement["strength"] == "required" and known is not True:
                        reasons.append("REQUIRED_FACT_UNKNOWN" if known is None else "REQUIRED_FACT_FALSE")
                    elif requirement["strength"] == "preferred":
                        preferred += int(known is True)
                        if known is not True: warnings.append("PREFERENCE_NOT_VERIFIED:" + requirement["text"])
                expected, upper = _price(place, party)
                charged = upper if budget_policy == "upper_bound" else expected
                if budget_limit is not None and charged is None:
                    reasons.append("PRICE_UPPER_UNKNOWN" if budget_policy == "upper_bound" else "PRICE_ESTIMATE_UNKNOWN")
                if expected is None: warnings.append("PRICE_UNKNOWN")
                if expected is not None and upper is None: warnings.append("PRICE_ESTIMATED")
                if place.get("crowding") is not None:
                    warnings.append("CROWDING_NOT_USED_WITHOUT_TIME_SPECIFIC_FACT")
                if reasons:
                    excluded.append({"day_id": day["day_id"], "activity_id": activity["id"], "place_id": pid, "reasons": sorted(set(reasons))})
                else:
                    options.append(Option(day["day_id"], activity["id"], pid, duration, tuple(sorted(windows)), expected, upper,
                                          charged or 0, preferred, _quality(place), ("CATEGORY_MATCH", "OPEN_FOR_FULL_VISIT"), tuple(warnings)))
                    day_count += 1
        if day_count > MAX_OPTIONS_PER_DAY and enforce_option_limit and "candidate_pool" not in job:
            issues.append("CANDIDATE_POOL_TOO_LARGE")
    if "candidate_pool" in job:
        pool = job["candidate_pool"]
        if not isinstance(pool, list): raise ValueError("invalid candidate pool filter")
        allowed = {(r["day_id"], r["activity_id"], r["place_id"]) for r in pool}
        available = {(o.day_id, o.activity_id, o.place_id) for o in options}
        if len(allowed) != len(pool) or not allowed <= available:
            raise ValueError("candidate pool references an ineligible option")
        options = [o for o in options if (o.day_id, o.activity_id, o.place_id) in allowed]
        if any(sum(o.day_id == d["day_id"] for o in options) > MAX_OPTIONS_PER_DAY for d in days):
            issues.append("CANDIDATE_POOL_TOO_LARGE")
    legs, route_issues = {}, []
    day_by_id = {d["day_id"]: d for d in days}
    for leg in job.get("route_legs", []):
        key = (leg.get("day_id"), leg.get("from_id"), leg.get("to_id"))
        if key in legs: raise ValueError("duplicate route leg")
        day = day_by_id.get(key[0])
        if day is None: raise ValueError("route references unknown day")
        if key[1] not in {"@origin", *places} or key[2] not in {"@destination", *places}:
            # Retrieval may narrow the candidate pool after routes were fetched.
            continue
        window = leg.get("window") or {}
        valid = fresh(leg.get("source"), now) and leg.get("mode") == mode and leg.get("date") == day["date"]
        from_point = points.get("origin") if key[1] == "@origin" else places[key[1]].get("point")
        to_point = destination if key[2] == "@destination" else places[key[2]].get("point")
        valid = valid and same_point(leg.get("from_point"), from_point) and same_point(leg.get("to_point"), to_point)
        valid = valid and clock(window.get("start")) <= clock(day["window"]["start"]) and clock(window.get("end")) >= clock(day["window"]["end"])
        cost = leg.get("cost_upper_minor", 0 if mode == "walking" else None)
        if cost is not None: integer(cost, "route cost upper")
        if not valid or (budget_limit is not None and cost is None):
            route_issues.append({"day_id": key[0], "from_id": key[1], "to_id": key[2], "reason": "ROUTE_UNVERIFIED"})
            continue
        integer(leg.get("safe_minutes"), "safe travel minutes", 0, 1440)
        legs[key] = leg | {"cost_upper_minor": cost}
    return dict(job=job, intent=intent, days=days, places=places, options=options, excluded=excluded,
                route_issues=sorted(route_issues, key=lambda r: (r['day_id'], r['from_id'], r['to_id'])), issues=sorted(set(issues)), legs=legs, buffer=buffer,
                budget_limit=budget_limit, period=period, budget_policy=budget_policy, destination=destination, precedence=precedence)


def _leg(p, day, before, after):
    if after == "@destination" and p["destination"] is None:
        return {"safe_minutes": 0, "cost_upper_minor": 0}
    return p["legs"].get((day, before, after))


def _sum_known(values):
    return None if any(v is None for v in values) else sum(values)


def select_places(job, *, time_limit_seconds=3.0):
    if not math.isfinite(time_limit_seconds) or not 0 < time_limit_seconds <= 30:
        raise ValueError("time limit must be in (0,30]")
    p = prepare(job)
    if p["issues"]:
        return {"schema_version": POLICY_VERSION, "status": "NEEDS_INPUT", "issues": p["issues"], "days": []}
    model = cp_model.CpModel()
    chosen, starts, covered, arcs, ends, objectives = {}, {}, [], [], {}, []
    options = p["options"]
    for i, option in enumerate(options):
        chosen[i] = model.new_bool_var(f"choose_{i}")
        starts[i] = model.new_int_var_from_domain(cp_model.Domain.from_intervals(option.windows), f"start_{i}")
    for day in p["days"]:
        did = day["day_id"]
        index = [i for i, o in enumerate(options) if o.day_id == did]
        start, end = clock(day["window"]["start"]), clock(day["window"]["end"])
        ends[did] = model.new_int_var(start, end, f"end_{did}")
        for activity in day["activities"]:
            group = [i for i in index if options[i].activity_id == activity["id"]]
            present = model.new_bool_var(f"covered_{did}_{activity['id']}")
            model.add(sum(chosen[i] for i in group) == present)
            covered.append(present)
        for pid in {options[i].place_id for i in index}:
            model.add(sum(chosen[i] for i in index if options[i].place_id == pid) <= 1)
        for before, after in p["precedence"][did]:
            for i in index:
                for j in index:
                    if options[i].activity_id == before and options[j].activity_id == after:
                        model.add(starts[j] >= starts[i] + options[i].duration).only_enforce_if([chosen[i], chosen[j]])
        circuit = [(i + 1, i + 1, chosen[i].Not()) for i in index]
        empty = model.new_bool_var(f"empty_{did}")
        circuit.append((0, 0, empty))
        model.add(sum(chosen[i] for i in index) == 0).only_enforce_if(empty)
        model.add(sum(chosen[i] for i in index) >= 1).only_enforce_if(empty.Not())
        model.add(ends[did] == start).only_enforce_if(empty)
        for a in [None, *index]:
            for b in [*index, None]:
                if a == b: continue
                if a is not None and b is not None and (options[a].place_id == options[b].place_id or options[a].activity_id == options[b].activity_id): continue
                source = "@origin" if a is None else options[a].place_id
                target = "@destination" if b is None else options[b].place_id
                leg = _leg(p, did, source, target)
                if leg is None: continue
                take = model.new_bool_var(f"arc_{did}_{a}_{b}")
                circuit.append((0 if a is None else a + 1, 0 if b is None else b + 1, take))
                travel = leg["safe_minutes"]
                arrival = start + travel if a is None else starts[a] + options[a].duration + travel
                if b is None: model.add(ends[did] >= arrival).only_enforce_if(take)
                else: model.add(starts[b] >= arrival + p["buffer"]).only_enforce_if(take)
                arcs.append((did, a, b, take, travel, leg["cost_upper_minor"]))
        model.add_circuit(circuit)
    if p["budget_limit"] is not None:
        groups = [None] if p["period"] == "whole_trip" else [d["day_id"] for d in p["days"]]
        for group in groups:
            costs = [o.charged * chosen[i] for i, o in enumerate(options) if group is None or o.day_id == group]
            costs += [(cost or 0) * take for did, _, _, take, _, cost in arcs if group is None or did == group]
            model.add(sum(costs) <= p["budget_limit"])
    # True lexicographic stages: no arbitrary coefficient trades hard constraints
    # or one requested activity against rating, distance, or provider rank.
    objectives = [sum(covered), sum(o.preference * chosen[i] for i, o in enumerate(options)),
                  -sum(travel * take for _, _, _, take, travel, _ in arcs),
                  sum(o.quality * chosen[i] for i, o in enumerate(options)),
                  -sum(ends.values())]
    deadline, final_solver, stages = time.monotonic() + time_limit_seconds, None, []
    for expression in objectives:
        remaining = deadline - time.monotonic()
        if remaining <= 0: break
        model.maximize(expression)
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = remaining
        solver.parameters.num_search_workers = 1
        solver.parameters.random_seed = 0
        status = solver.solve(model)
        if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE): break
        final_solver = solver
        value = solver.value(expression)
        stages.append({"value": value, "status": solver.status_name(status)})
        if status != cp_model.OPTIMAL: break
        model.add(expression == value)
    if final_solver is None:
        return {"schema_version": POLICY_VERSION, "status": "ERROR", "issues": ["SOLVER_NO_SOLUTION_WITHIN_LIMIT"], "days": []}
    selected = {i: final_solver.value(starts[i]) for i in chosen if final_solver.boolean_value(chosen[i])}
    result = _output(p, selected)
    result["optimization"] = {"engine": "ortools-cp-sat", "stages": stages,
                              "optimal_in_candidate_pool": len(stages) == len(objectives) and all(s["status"] == "OPTIMAL" for s in stages)}
    validate_selection(job, result)
    return result


def _output(p, selected):
    options = p["options"]
    days, expected, uppers, warnings, sources = [], [], [], set(), []
    for day in p["days"]:
        did = day["day_id"]
        indices = sorted((i for i in selected if options[i].day_id == did), key=lambda i: (selected[i], options[i].place_id))
        visits, travel, transport_costs = [], 0, []
        before = "@origin"
        for i in indices:
            o, place = options[i], p["places"][options[i].place_id]
            leg = _leg(p, did, before, o.place_id)
            if leg is None: raise ValueError("selected route leg missing")
            travel += leg["safe_minutes"]
            transport_costs.append(leg["cost_upper_minor"])
            sources.extend([place["source"], leg["source"]])
            visits.append({"activity_id": o.activity_id, "place_id": o.place_id, "name": place["name"],
                           "point": place["point"], "starts_at": selected[i], "ends_at": selected[i] + o.duration,
                           "duration_minutes": o.duration, "duration_source": p["job"]["visit_policy"]["version"],
                           "travel_before_minutes": leg["safe_minutes"], "arrival_buffer_minutes": p["buffer"],
                           "price_expected_minor": o.expected, "price_upper_minor": o.upper,
                           "source": place["source"], "reasons": list(o.reasons), "warnings": list(o.warnings)})
            warnings.update(o.warnings)
            expected.append(o.expected); uppers.append(o.upper)
            before = o.place_id
        returned = _leg(p, did, before, "@destination") if indices else {"safe_minutes": 0, "cost_upper_minor": 0}
        if returned is None: raise ValueError("required final leg missing")
        travel += returned["safe_minutes"]
        transport_costs.append(returned["cost_upper_minor"])
        if "source" in returned: sources.append(returned["source"])
        expected.extend(transport_costs); uppers.extend(transport_costs)
        if any(c is None for c in transport_costs): warnings.add("TRANSPORT_COST_UNKNOWN")
        ids_selected = {v["activity_id"] for v in visits}
        missing = [a["id"] for a in day["activities"] if a["id"] not in ids_selected]
        ends_at = visits[-1]["ends_at"] + returned["safe_minutes"] if visits else clock(day["window"]["start"])
        days.append({"day_id": did, "date": day["date"], "status": "AVAILABLE" if not missing else "LIMITED" if visits else "UNAVAILABLE",
                     "visits": visits, "ends_at": ends_at, "total_safe_travel_minutes": travel, "missing_activity_ids": missing})
    count = sum(len(d["visits"]) for d in days)
    status = "AVAILABLE" if all(d["status"] == "AVAILABLE" for d in days) else "LIMITED" if count else "UNAVAILABLE"
    if p["budget_limit"] is not None and p["budget_policy"] == "estimate": warnings.add("BUDGET_ESTIMATED_NOT_GUARANTEED")
    if p["job"].get("retrieval", {}).get("coverage") == "PARTIAL": warnings.add("RETRIEVAL_PARTIAL")
    return {"schema_version": POLICY_VERSION, "policy_version": POLICY_VERSION,
            "intent_revision": p["intent"]["draft_revision"], "status": status, "days": days,
            "total_expected_cost_minor": _sum_known(expected), "total_budget_upper_minor": _sum_known(uppers),
            "data_mode": "live" if sources and all(s["data_mode"] == "live" for s in sources) else "test" if any(s["data_mode"] == "test" for s in sources) else "prepared",
            "warnings": sorted(warnings), "excluded": p["excluded"], "route_issues": p["route_issues"],
            "recovery_options": [] if status == "AVAILABLE" else ["CHANGE_TIME_OR_DATE", "CHANGE_SEARCH_RADIUS"],
            "coverage_scope": "provided_candidate_pool_only"}


def validate_selection(job, result):
    """Recompute legality and result totals without invoking the solver."""
    p = prepare(job)
    if p["issues"]: raise ValueError("cannot validate unresolved request")
    if [d["day_id"] for d in result.get("days", [])] != [d["day_id"] for d in p["days"]]: raise ValueError("day mismatch")
    selected, charges = {}, []
    lookup = {(o.day_id, o.activity_id, o.place_id): i for i, o in enumerate(p["options"])}
    for day, output in zip(p["days"], result["days"], strict=True):
        did, before, current = day["day_id"], "@origin", clock(day["window"]["start"])
        used_places, used_activities, positions, cost = set(), set(), {}, 0
        for position, visit in enumerate(output["visits"]):
            key = (did, visit["activity_id"], visit["place_id"])
            if key not in lookup: raise ValueError("ineligible selection")
            i = lookup[key]; o = p["options"][i]
            if o.place_id in used_places or o.activity_id in used_activities: raise ValueError("duplicate visit")
            used_places.add(o.place_id); used_activities.add(o.activity_id)
            at = integer(visit["starts_at"], "visit start", 0, 1440)
            leg = _leg(p, did, before, o.place_id)
            if leg is None or at < current + leg["safe_minutes"] + p["buffer"]: raise ValueError("impossible transition")
            if not any(a <= at <= b for a, b in o.windows): raise ValueError("outside opening hours")
            if visit["ends_at"] != at + o.duration: raise ValueError("wrong duration")
            selected[i] = at; positions[o.activity_id] = position
            cost += o.charged + (leg["cost_upper_minor"] or 0)
            current, before = at + o.duration, o.place_id
        if output["visits"]:
            leg = _leg(p, did, before, "@destination")
            if leg is None: raise ValueError("no final route")
            current += leg["safe_minutes"]; cost += leg["cost_upper_minor"] or 0
        if current > clock(day["window"]["end"]): raise ValueError("outside day")
        for a, b in p["precedence"][did]:
            if a in positions and b in positions and positions[a] >= positions[b]: raise ValueError("order violation")
        if p["budget_limit"] is not None and p["period"] == "per_day" and cost > p["budget_limit"]: raise ValueError("daily budget exceeded")
        charges.append(cost)
    if p["budget_limit"] is not None and p["period"] == "whole_trip" and sum(charges) > p["budget_limit"]: raise ValueError("trip budget exceeded")
    recomputed = _output(p, selected)
    for key, value in recomputed.items():
        if result.get(key) != value: raise ValueError(f"inconsistent result: {key}")
