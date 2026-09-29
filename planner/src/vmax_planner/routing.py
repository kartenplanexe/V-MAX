"""Eligibility first, bounded routing graph second; no network in Python."""
from datetime import datetime, timedelta
from math import ceil
from zoneinfo import ZoneInfo

from .selection import MAX_OPTIONS_PER_DAY, POLICY_VERSION, clock, direct_meters, integer, prepare, validate_selection
from .replacement import slot_index

ROUTING_POLICY = "dated-routing.v3"

# A compact suggestion, NOT measured travel or a verified itinerary.
EXTERNAL_COMPACT_POLICY = {"version": "external-compact.v5", "max_stops": 6,
                           "detour_factor": 1.5, "meters_per_minute": 60, "transition_buffer": 5,
                           "beam_width": 96, "alternatives_per_order": 12,
                           "same_activity_min_meters": 400, "event_order_limit": 8}


def compact_external_pool(p, ranked_groups, walk_scores=None):
    policy = EXTERNAL_COMPACT_POLICY
    walk_scores = walk_scores or {}
    if not isinstance(walk_scores, dict): raise ValueError('invalid walk type policy')
    for score in walk_scores.values(): integer(score, 'walk type score', 0, 2)
    activities = {a['id']: a for d in p['days'] for a in d['activities']}
    event_ids = {aid for aid, activity in activities.items() if activity.get('intent_kind') == 'event_visit'}
    profiles = {}
    for _, aid, rows in ranked_groups:
        activity = activities[aid]
        is_walk = activity.get('intent_kind') in {'route_walk', 'area_walk'} or aid in p['multi_stop']
        allowed = set(activity.get('categories', {}).get('include_any', []))
        for o in rows:
            profiles[(aid, o.place_id)] = max((walk_scores.get(c, 0) for c in
                allowed & set(p['places'][o.place_id].get('rubric_ids', []))), default=0) if is_walk else 0
    def profile(option): return profiles[(option.activity_id, option.place_id)]
    def scenic_count(path): return len({o.activity_id for o in path if profile(o) == 2})
    def type_score(path): return sum(profile(o) for o in path)
    origin = p['intent']['points']['origin']
    points = {'@origin': origin, **{pid: place['point'] for pid, place in p['places'].items() if place.get('point')}}
    distance_cache = {}
    def distance(a, b):
        key = (a, b)
        if key not in distance_cache:
            distance_cache[key] = direct_meters(points[a], points[b])
        return distance_cache[key]
    def allowance(a, b):
        return ceil(distance(a, b) * policy['detour_factor'] / policy['meters_per_minute']) + policy['transition_buffer']
    def prune(states):
        # Preserve different stop counts, so an extra walk stop cannot crowd out
        # the shorter prefix needed for food. Keep different last places too.
        best = {}
        for state in states:
            path, cursor, point, spent, covered, preference = state
            key = (point, spent, covered, frozenset((o.activity_id, o.place_id) for o in path))
            if key not in best or (cursor, -preference) < (best[key][1], -best[key][5]):
                best[key] = state
        buckets = {}
        for state in best.values():
            buckets.setdefault((len(state[4] & event_ids), len(state[4]), scenic_count(state[0]), len(state[0])), []).append(state)
        for values in buckets.values():
            values.sort(key=lambda s: (-s[5], -type_score(s[0]), s[1], s[3], tuple(o.place_id for o in s[0])))
        keys = sorted(buckets, key=lambda k: (-k[0], -k[1], -k[2], k[3]))
        selected = []
        for index in range(policy['beam_width']):
            for key in keys:
                if index < len(buckets[key]): selected.append(buckets[key][index])
                if len(selected) == policy['beam_width']: return selected
        return selected
    pool, trip_spent = [], 0
    for day in p['days']:
        begin, end = clock(day['window']['start']), clock(day['window']['end'])
        if p['destination']: points['@destination'] = p['destination']
        # Topological order is independent of whether an earlier activity fits.
        ordered, done = [], set()
        pending = list(day['activities'])
        while pending:
            activity = next((a for a in pending if not any(
                after == a['id'] and before not in done for before, after in day.get('order', []))), None)
            if activity is None: break
            ordered.append(activity); done.add(activity['id']); pending.remove(activity)
        groups = {aid: rows for did, aid, rows in ranked_groups if did == day['day_id']}
        def plan_order(activity_order):
            # path, end minute, last place, charged cost, covered activities, preference
            states = [((), begin, '@origin', 0, frozenset(), 0)]
            for activity in activity_order:
                aid = activity['id']
                choices = groups.get(aid, [])
                choice_cache = {}
                def candidates(point, same_activity):
                    key = (point, same_activity)
                    if key not in choice_cache:
                        # Filter all pairs before truncation: otherwise a dense first
                        # page crowds out eligible alternatives farther along the walk.
                        spaced = [o for o in choices if all(distance(pid, o.place_id) >=
                            policy['same_activity_min_meters'] for pid in same_activity)]
                        rankings = [sorted(spaced, key=lambda o: (distance(point, o.place_id), -o.preference, -o.quality, o.place_id)),
                                    sorted(spaced, key=lambda o: (o.duration, distance(point, o.place_id), o.place_id)),
                                    sorted(spaced, key=lambda o: (o.charged, distance(point, o.place_id), o.place_id)),
                                    sorted(spaced, key=lambda o: (o.windows[-1][1], distance(point, o.place_id), o.place_id)),
                                    sorted(spaced, key=lambda o: (-o.preference, -profile(o), distance(point, o.place_id), o.place_id))]
                        unique = {}
                        for ranking in rankings:
                            for option in ranking[:policy['alternatives_per_order']]: unique[option.place_id] = option
                        choice_cache[key] = list(unique.values())
                    return choice_cache[key]
                generated = list(states)
                frontier = [s for s in states if not any(after == aid and before not in s[4]
                    for before, after in p['precedence'][day['day_id']])]
                for _ in range(min(p['multi_stop'].get(aid, 1), policy['max_stops'])):
                    following = []
                    for path, cursor, point, spent, covered, preference in frontier:
                        if len(path) >= policy['max_stops']: continue
                        used = {o.place_id for o in path}
                        same_activity = frozenset(o.place_id for o in path if o.activity_id == aid)
                        for option in candidates(point, same_activity):
                            if option.place_id in used: continue
                            charged = spent + option.charged
                            cost = charged + (trip_spent if p['period'] == 'whole_trip' else 0)
                            if p['budget_limit'] is not None and cost > p['budget_limit']: continue
                            arrival = cursor + allowance(point, option.place_id) + p['buffer']
                            start = next((max(arrival, lo) for lo, hi in option.windows if max(arrival, lo) <= hi), None)
                            finish_allowance = allowance(option.place_id, '@destination') if p['destination'] else 0
                            if start is None or start + option.duration + finish_allowance > end: continue
                            following.append((path + (option,), start + option.duration, option.place_id,
                                              charged, covered | {aid}, preference + option.preference))
                    frontier = prune(following)
                    generated.extend(frontier)
                    if not frontier: break
                states = prune(generated)
            return states
        orders = [ordered]
        for event in [a for a in ordered if a['id'] in event_ids]:
            alternatives = []
            for ordering in orders:
                others = [a for a in ordering if a['id'] != event['id']]
                for index in range(len(others) + 1):
                    candidate = others[:index] + [event] + others[index:]
                    positions = {a['id']: i for i, a in enumerate(candidate)}
                    if all(positions[before] < positions[after] for before, after in day.get('order', [])) and candidate not in alternatives:
                        alternatives.append(candidate)
            orders = ([ordered] + [value for value in alternatives if value != ordered])[:policy['event_order_limit']]
        states = [state for ordering in orders for state in plan_order(ordering)]
        selected = min(states, key=lambda s: (-len(s[4] & event_ids), -len(s[4]), -s[5], -scenic_count(s[0]), -len(s[0]),
            -type_score(s[0]), s[1], s[3], tuple(o.place_id for o in s[0])))
        cursor, point = begin, '@origin'
        for option in selected[0]:
            arrival = cursor + allowance(point, option.place_id) + p['buffer']
            start = next(max(arrival, lo) for lo, hi in option.windows if max(arrival, lo) <= hi)
            place = p['places'][option.place_id]
            row = {'day_id': day['day_id'], 'activity_id': option.activity_id,
                   'place_id': option.place_id, 'estimated_visit_minutes': option.duration}
            if place.get('kind') == 'event':
                row['event_visit'] = {'starts_at': start, 'ends_at': start + option.duration,
                    'schedule_kind': place['schedule']['kind'], 'admission_upper_minor': option.upper}
            pool.append(row)
            cursor, point = start + option.duration, option.place_id
        trip_spent += selected[3]
    return pool


def departure_utc(day, minutes, timezone):
    # Includes 24:00 at the next midnight. Host OS timezone is irrelevant.
    local = datetime.fromisoformat(day["date"]).replace(tzinfo=ZoneInfo(timezone)) + timedelta(minutes=minutes)
    return int(local.timestamp())


def _shortlist(ranked, limit, origin, places, spread):
    if not spread or len(ranked) <= limit or limit == 1:
        return ranked[:limit]
    # A walking route needs alternatives across the local search area. Taking
    # only the nearest provider results makes a two-stop route collapse into
    # two adjacent POIs. Eligibility has already run; no distant place outside
    # the confirmed search radius can enter this pool.
    by_distance = sorted(ranked, key=lambda o: (direct_meters(origin, places[o.place_id]["point"]), o.place_id))
    # Keep nearby alternatives as well as the spread: a distant stratum may be
    # separated by a river or inaccessible even though its direct distance fits.
    chosen = ranked[:(limit + 1) // 2]
    spread_count = limit - len(chosen)
    for index in range(1, spread_count + 1):
        candidate = by_distance[round(index * (len(by_distance) - 1) / spread_count)]
        if candidate not in chosen:
            chosen.append(candidate)
    for candidate in ranked:
        if len(chosen) >= limit: break
        if candidate not in chosen: chosen.append(candidate)
    return chosen


def _route_graph(p, selected):
    """Dated directed edges and a conservative bound on final verification."""
    mode = p["intent"]["shared"]["mobility"][0]
    origin = p["intent"]["points"]["origin"]
    pairs, maximum_selected_legs = [], 0
    for day in p["days"]:
        did = day["day_id"]
        chosen = [option for option in selected if option.day_id == did]
        maximum_selected_legs += (len(p['replacement'][did]) if p['replacement'] is not None else
            sum(min(p["multi_stop"].get(a["id"], 1), sum(o.activity_id == a["id"] for o in chosen))
                for a in day["activities"])) + int(bool(chosen) and p["destination"] is not None)
        edges = {("@origin", o.place_id) for o in chosen}
        if p["destination"] is not None:
            edges.update((o.place_id, "@destination") for o in chosen)
        for a in chosen:
            for b in chosen:
                if (a.activity_id != b.activity_id or a.activity_id in p["multi_stop"]) and a.place_id != b.place_id and (b.activity_id, a.activity_id) not in p["precedence"][did]:
                    edges.add((a.place_id, b.place_id))
        if p['replacement'] is not None:
            slots = p['replacement'][did]
            groups = [[o for o in chosen if slot_index(slots, o.activity_id, o.place_id) == index]
                      for index in range(len(slots))]
            edges = {('@origin', o.place_id) for o in groups[0]} if groups else set()
            for before, after in zip(groups, groups[1:]):
                edges.update((a.place_id, b.place_id) for a in before for b in after)
            if groups and p['destination'] is not None:
                edges.update((o.place_id, '@destination') for o in groups[-1])
        start, end = clock(day["window"]["start"]), clock(day["window"]["end"])
        # Three traffic-statistics samples for a car; not a proven upper bound.
        samples = sorted({start, (start + end) // 2, end - 1}) if mode == "driving" else [start]
        for before, after in sorted(edges):
            pairs.append({"day_id": did, "from_id": before, "to_id": after,
                          "from_point": origin if before == "@origin" else p["places"][before]["point"],
                          "to_point": p["destination"] if after == "@destination" else p["places"][after]["point"],
                          "date": day["date"], "window": day["window"], "mode": mode,
                          "sample_utc": [departure_utc(day, minute, p["intent"]["locality"]["timezone"]) for minute in samples],
                          **({"search_sample_utc": [departure_utc(day, minute, p["intent"]["locality"]["timezone"])
                              for minute in [(start + end) // 2, end - 1]]} if mode == 'public_transport' else {})})
    return pairs, maximum_selected_legs


def _routing_usage(pairs, maximum_selected_legs):
    # Matches coordinate deduplication: PT is one HTTP per pair, other modes batch50.
    batches = {}
    for pair in pairs:
        a, b = pair["from_point"], pair["to_point"]
        coordinates = (a["lat"], a["lon"], b["lat"], b["lon"])
        for instant in pair["sample_utc"]:
            batches.setdefault((instant, pair["mode"]), set()).add(coordinates)
    reserve = maximum_selected_legs * 2
    return {"pair_calculations": sum(len(pairs) for pairs in batches.values()) + reserve,
            "http_calls": sum(len(pairs) if mode == 'public_transport' else (len(pairs) + 49) // 50
                              for (_, mode), pairs in batches.items()) + reserve,
            "reserved_verification_legs": reserve}


def prepare_routes(job):
    if "candidate_pool" in job: raise ValueError("shortlist must be built by the server")
    job = job | {"route_legs": []}
    p = prepare(job, enforce_option_limit=False)
    if p["issues"]:
        return {"schema_version": POLICY_VERSION, "status": "NEEDS_INPUT", "issues": p["issues"], "days": []}
    mode = p["intent"]["shared"]["mobility"][0]
    if mode != "walking" and p["budget_limit"] is not None:
        return {"schema_version": POLICY_VERSION, "status": "NEEDS_INPUT", "issues": ["TRANSPORT_COST_POLICY_REQUIRED"], "days": []}
    policy = job.get("routing_policy", {})
    progressive = policy.get("strategy") == "progressive"
    limit = integer(policy.get("candidates_per_activity", MAX_OPTIONS_PER_DAY), "shortlist size", 1, MAX_OPTIONS_PER_DAY)
    max_pairs = integer(policy.get("max_route_pair_calculations", 200), "route pair budget", 1, 1000)
    max_http = integer(policy.get("max_routing_http_calls", 30), "routing HTTP budget", 1, 100)
    origin = p["intent"]["points"]["origin"]
    ranked_groups = []
    for day in p["days"]:
        for activity in day["activities"]:
            options = [o for o in p["options"] if o.day_id == day["day_id"] and o.activity_id == activity["id"]]
            ranked = sorted(options, key=lambda o: (-o.preference, direct_meters(origin, p["places"][o.place_id]["point"]), -o.quality, o.place_id))
            ranked_groups.append((day["day_id"], activity["id"], ranked))

    if progressive and p['replacement'] is None:
        groups = [{"day_id": did, "activity_id": aid, "eligible": len(ranked),
                   "selected": 0, "truncated": bool(ranked)} for did, aid, ranked in ranked_groups]
        preview_pool = (compact_external_pool(p, ranked_groups, job.get('visit_policy', {}).get('walk_rubric_scores')) if policy.get('external_compact') else [
            {"day_id": did, "activity_id": aid, "place_id": o.place_id}
            for did, aid, ranked in ranked_groups for o in ranked[:120]])
        gaps = [{'day_id': did, 'activity_id': aid, 'reason': 'COMBINATION_NOT_FOUND' if ranked else 'NO_ELIGIBLE_PLACES'}
                for did, aid, ranked in ranked_groups if not any(r['day_id'] == did and r['activity_id'] == aid for r in preview_pool)]
        if policy.get('external_compact'):
            for group, (_, _, ranked) in zip(groups, ranked_groups, strict=True):
                group['selected'] = sum(r['day_id'] == group['day_id'] and r['activity_id'] == group['activity_id'] for r in preview_pool)
                group['minimum_visit_minutes'] = min((o.duration for o in ranked), default=None)
                group['minimum_start_allowance_minutes'] = min((ceil(direct_meters(origin, p['places'][o.place_id]['point']) *
                    EXTERNAL_COMPACT_POLICY['detour_factor'] / EXTERNAL_COMPACT_POLICY['meters_per_minute']) +
                    EXTERNAL_COMPACT_POLICY['transition_buffer'] + p['buffer'] for o in ranked), default=None)
        return {"schema_version": POLICY_VERSION, "status": "AVAILABLE",
                "job": job | {"candidate_pool": []}, "preview_job": job | {"candidate_pool": preview_pool,
                    **({'selection_gaps': gaps} if policy.get('external_compact') else {})},
                "pairs": [], "maximum_selected_legs": 0,
                "shortlist": {"policy": "progressive-routing.v2", "groups": groups,
                    "method": "estimated_compact_search" if policy.get('external_compact') else "measured_insertions", "global_optimality_claimed": False}}

    def materialize(counts):
        selected = []
        for (did, aid, ranked), count in zip(ranked_groups, counts, strict=True):
            fixed = [o for o in ranked if p['replacement'] is not None and any(
                not slot['replacing'] and slot['place_id'] == o.place_id and slot['activity_id'] == aid
                for slot in p['replacement'][did])]
            selected.extend(fixed)
            selected.extend(_shortlist([o for o in ranked if o not in fixed], count - len(fixed), origin,
                                      p['places'], aid in p['multi_stop']) if count > len(fixed) else [])
        return selected

    def candidate_graph(counts):
        selected = materialize(counts)
        if any(sum(o.day_id == day["day_id"] for o in selected) > MAX_OPTIONS_PER_DAY for day in p["days"]):
            return None
        pairs, selected_legs = _route_graph(p, selected)
        usage = _routing_usage(pairs, selected_legs)
        if usage["pair_calculations"] > max_pairs or usage["http_calls"] > max_http:
            return None
        return selected, pairs, selected_legs, usage

    # Never purchase alternatives for one activity at the expense of dropping
    # another requested activity. The minimum is represented before expansion.
    counts = [int(bool(ranked)) for _, _, ranked in ranked_groups]
    if p['replacement'] is not None:
        counts = [sum(slot['activity_id'] == aid for slot in p['replacement'][did])
                  for did, aid, _ in ranked_groups]
    graph = candidate_graph(counts)
    if graph is None:
        return {"schema_version": POLICY_VERSION, "status": "NEEDS_INPUT", "issues": ["ROUTING_SCOPE_TOO_LARGE"], "days": []}
    while True:
        expanded = False
        for index, (_, _, ranked) in enumerate(ranked_groups):
            if counts[index] >= min(limit, len(ranked)):
                continue
            trial = list(counts)
            trial[index] += 1
            trial_graph = candidate_graph(trial)
            if trial_graph is not None:
                counts, graph, expanded = trial, trial_graph, True
        if not expanded:
            break
    selected, pairs, maximum_selected_legs, usage = graph
    groups = [{"day_id": did, "activity_id": aid, "eligible": len(ranked),
               "selected": count, "truncated": len(ranked) > count}
              for (did, aid, ranked), count in zip(ranked_groups, counts, strict=True)]
    pool = [{"day_id": o.day_id, "activity_id": o.activity_id, "place_id": o.place_id} for o in selected]
    narrowed = job | {"candidate_pool": pool}
    # Solver cap is still enforced after bounded shortlisting.
    checked = prepare(narrowed)
    if checked["issues"]:
        return {"schema_version": POLICY_VERSION, "status": "NEEDS_INPUT", "issues": checked["issues"], "days": []}
    return {"schema_version": POLICY_VERSION, "status": "AVAILABLE", "job": narrowed,
            "pairs": pairs, "shortlist": {"policy": ROUTING_POLICY, "groups": groups,
            "method": "eligibility_then_fair_budgeted_expansion", "global_optimality_claimed": False},
            "routing_budget": usage, "maximum_selected_legs": maximum_selected_legs}


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


def recover_routes(envelope):
    """Propose one measured insertion from the same-request eligible reservoir.

    This internal operation never fabricates a leg or relaxes an activity. The
    adapter owns physical request budgets and must measure every returned pair
    before admitting the candidate, then run the normal solver and validator.
    """
    job, result = envelope["job"], envelope["result"]
    if "candidate_pool" not in job:
        raise ValueError("recovery requires a server shortlist")
    validate_selection(job, result)
    current = prepare(job)
    if current['replacement'] is not None:
        return {'schema_version': POLICY_VERSION, 'status': 'DONE', 'stop_reason': 'COVERAGE_COMPLETE'}
    full = prepare({k: v for k, v in job.items() if k != "candidate_pool"}, enforce_option_limit=False)
    attempted = {tuple(key) for key in envelope.get("attempted", [])}
    if any(len(key) != 5 or any(not isinstance(value, str) for value in key) for key in attempted):
        raise ValueError("invalid insertion receipt")
    allowed = {(row["day_id"], row["activity_id"], row["place_id"]) for row in job["candidate_pool"]}
    by_day = {row["day_id"]: row for row in result["days"]}
    origin, destination = full["intent"]["points"]["origin"], full["destination"]
    mode, timezone = full["intent"]["shared"]["mobility"][0], full["intent"]["locality"]["timezone"]
    operator_limit = integer(job.get("routing_policy", {}).get("candidates_per_activity", MAX_OPTIONS_PER_DAY),
                             "shortlist size", 1, MAX_OPTIONS_PER_DAY)
    progressive = job.get("routing_policy", {}).get("strategy") == "progressive"
    proposals, targets, option_limit = [], 0, False
    for day_index, day in enumerate(full["days"]):
        did = day["day_id"]
        visits = by_day[did]["visits"]
        visited_places = {visit["place_id"] for visit in visits}
        day_count = sum(row["day_id"] == did for row in job["candidate_pool"])
        for activity_index, activity in enumerate(day["activities"]):
            aid = activity["id"]
            count = sum(visit["activity_id"] == aid for visit in visits)
            if count and not (aid in full["multi_stop"] and count < (full["multi_stop"][aid] if progressive else 2)):
                continue
            targets += 1
            group_count = sum(row["day_id"] == did and row["activity_id"] == aid for row in job["candidate_pool"])
            if day_count >= MAX_OPTIONS_PER_DAY or group_count >= operator_limit:
                option_limit = True
                continue
            options = [option for option in full["options"] if option.day_id == did and option.activity_id == aid
                       and (did, aid, option.place_id) not in allowed and option.place_id not in visited_places]
            group_attempts = sum(key[:2] == (did, aid) for key in attempted)
            for option in options:
                if progressive and count >= 2 and option.quality < 350:
                    continue
                for position in range(len(visits) + 1):
                    # Preserve every hard precedence relation with the existing
                    # prefix/suffix. The complete solver checks it again later.
                    if any((visit["activity_id"], aid) in full["precedence"][did] and index >= position
                           or (aid, visit["activity_id"]) in full["precedence"][did] and index < position
                           for index, visit in enumerate(visits)):
                        continue
                    before = visits[position - 1]["place_id"] if position else "@origin"
                    after = visits[position]["place_id"] if position < len(visits) else "@destination"
                    key = (did, aid, option.place_id, before, after)
                    if key in attempted:
                        continue
                    if progressive:
                        # Optimistic feasibility only: zero NEW travel never certifies
                        # a route. It avoids buying an insertion that cannot fit even
                        # before measuring its two new edges. Existing travel is kept.
                        sequence = visits[:position] + [{"activity_id": aid, "place_id": option.place_id}] + visits[position:]
                        minute, previous, feasible = clock(day["window"]["start"]), "@origin", True
                        for visit in sequence:
                            candidate = next(o for o in full["options"] if o.day_id == did and
                                o.activity_id == visit["activity_id"] and o.place_id == visit["place_id"])
                            old_leg = current["legs"].get((did, previous, candidate.place_id))
                            minute += (old_leg["safe_minutes"] if old_leg else 0) + full["buffer"]
                            starts = [max(minute, left) for left, right in candidate.windows
                                      if max(minute, left) <= right]
                            if not starts:
                                feasible = False
                                break
                            minute = min(starts) + candidate.duration
                            previous = candidate.place_id
                        if not feasible or minute > clock(day["window"]["end"]):
                            continue
                    edges = [(before, option.place_id)]
                    if after != "@destination" or destination is not None:
                        edges.append((option.place_id, after))
                    start, end = clock(day["window"]["start"]), clock(day["window"]["end"])
                    samples = sorted({start, (start + end) // 2, end - 1}) if mode == "driving" else [start]
                    pairs = []
                    for a, b in edges:
                        if (did, a, b) in current["legs"]:
                            continue
                        pairs.append({"day_id": did, "from_id": a, "to_id": b,
                                      "from_point": origin if a == "@origin" else full["places"][a]["point"],
                                      "to_point": destination if b == "@destination" else full["places"][b]["point"],
                                      "date": day["date"], "window": day["window"], "mode": mode,
                                      "sample_utc": [departure_utc(day, minute, timezone) for minute in samples]})
                    predecessors_missing = sum(1 for before_aid, after_aid in full["precedence"][did]
                        if after_aid == aid and not any(v["activity_id"] == before_aid for v in visits))
                    score = (int(count > 0), predecessors_missing if progressive else 0, group_attempts, len(pairs), -option.preference,
                             direct_meters(origin, full["places"][option.place_id]["point"]), -option.quality,
                             day_index, activity_index, option.place_id, position)
                    proposals.append((score, option, {"key": list(key), "candidate": {
                        "day_id": did, "activity_id": aid, "place_id": option.place_id}, "pairs": pairs}))
    if not proposals:
        return {"schema_version": POLICY_VERSION, "status": "DONE", "stop_reason":
                "COVERAGE_COMPLETE" if not targets else "SOLVER_SCOPE_LIMIT" if option_limit else "ELIGIBLE_POOL_EXHAUSTED"}
    _, option, proposal = min(proposals, key=lambda row: row[0])
    selected = current["options"] + [option]
    _, maximum_selected_legs = _route_graph(full, selected)
    if progressive:
        maximum_selected_legs = sum(len(day['visits']) + int(bool(day['visits']) and destination is not None)
                                    for day in result['days']) + 1
        if destination is not None and not by_day[option.day_id]['visits']:
            maximum_selected_legs += 1
    return {"schema_version": POLICY_VERSION, "status": "AVAILABLE", "proposal": proposal,
            "maximum_selected_legs": maximum_selected_legs}
