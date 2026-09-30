from copy import deepcopy

from vmax_planner.demo import demo_job
from vmax_planner.routing import prepare_routes
from vmax_planner.selection import select_places, validate_selection

def candidates_job(activities=1, candidates=8, *, walk=False, mode="walking"):
    job = demo_job()
    job["intent"]["shared"].pop("budget")
    job["intent"]["shared"]["mobility"] = [mode]
    day = job["intent"]["days"][0]
    day["window"]["end"] = "22:00"
    activity_template = deepcopy(day["activities"][0])
    place_template = deepcopy(job["places"][0])
    day["activities"], day["order"], job["places"] = [], [], []
    job["catalog"]["leaf_ids"] = []
    job["visit_policy"]["by_category"] = {}
    for index in range(activities):
        aid, category = f"activity-{index}", f"category-{index}"
        activity = deepcopy(activity_template)
        activity.update(id=aid, label=aid)
        activity["categories"]["include_any"] = [category]
        day["activities"].append(activity)
        job["catalog"]["leaf_ids"].append(category)
        job["visit_policy"]["by_category"][category] = 25
        for candidate in range(candidates):
            place = deepcopy(place_template)
            place.update(id=f"{aid}-place-{candidate}", rubric_ids=[category],
                         point={"lat": 55.751 + (index * candidates + candidate) * 0.0001, "lon": 37.622},
                         opening_intervals={day["date"]: [[0, 1440]]})
            job["places"].append(place)
    if walk:
        job["visit_policy"].update(by_activity={"activity-0": 25}, max_stops_by_activity={"activity-0": 14})
    job["route_legs"] = []
    return job

def test_walk_pool_has_no_fixed_four_candidate_or_stop_ceiling():
    job = candidates_job(walk=True)
    prepared = prepare_routes(job)
    assert prepared["status"] == "AVAILABLE"
    assert prepared["shortlist"]["groups"][0]["selected"] == 8
    assert prepared["maximum_selected_legs"] == 8
    assert len(prepared["pairs"]) == 64
    source = job["places"][0]["source"]
    narrowed = prepared["job"] | {"route_legs": [pair | {"safe_minutes": 5, "source": source} for pair in prepared["pairs"]]}
    result = select_places(narrowed)
    assert len(result["days"][0]["visits"]) == 8
    validate_selection(narrowed, result)

def test_four_unordered_activities_expand_fairly_inside_paid_work_budget():
    prepared = prepare_routes(candidates_job(activities=4, candidates=8))
    assert prepared["status"] == "AVAILABLE"
    counts = [group["selected"] for group in prepared["shortlist"]["groups"]]
    assert min(counts) >= 2
    assert max(counts) - min(counts) <= 1
    assert prepared["routing_budget"]["pair_calculations"] <= 200
    assert prepared["routing_budget"]["http_calls"] <= 30
    assert all(group["truncated"] for group in prepared["shortlist"]["groups"])

def test_minimum_activity_coverage_too_large_returns_actionable_scope():
    job = candidates_job(activities=4, candidates=8)
    job["routing_policy"] = {"max_route_pair_calculations": 20, "max_routing_http_calls": 30}
    result = prepare_routes(job)
    assert result["status"] == "NEEDS_INPUT"
    assert result["issues"] == ["ROUTING_SCOPE_TOO_LARGE"]

def test_driving_samples_and_two_rechecks_fit_together():
    prepared = prepare_routes(candidates_job(activities=3, candidates=8, mode="driving"))
    assert prepared["status"] == "AVAILABLE"
    assert all(len(pair["sample_utc"]) == 3 for pair in prepared["pairs"])
    assert prepared["routing_budget"]["pair_calculations"] <= 200
    assert prepared["routing_budget"]["http_calls"] <= 30
    assert min(group["selected"] for group in prepared["shortlist"]["groups"]) >= 2

def test_shortlist_is_deterministic_when_candidate_order_changes():
    job = candidates_job(activities=4, candidates=8)
    first = prepare_routes(job)
    job["places"].reverse()
    assert prepare_routes(job) == first
