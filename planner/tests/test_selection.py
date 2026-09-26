from copy import deepcopy

import pytest

from vmax_planner.selection import select_places, validate_selection


@pytest.fixture
def job():
    def activity(aid, category):
        return {"id": aid, "label": aid, "selection": {"category_policy": "related_allowed", "named_types": []},
                "requirements": [], "categories": {"state": "matched", "include_any": [category], "exclude": [],
                "region_id": "32", "catalog_version": "test-catalog"}}
    def place(pid, category, **extra):
        return {"id": pid, "name": pid, "region_id": "32", "rubric_ids": [category],
                "point": {"lat": 55.75, "lon": 37.62}, "source": {"provider": "synthetic", "data_mode": "test",
                "fetched_at": "2026-09-24T08:00:00Z", "valid_until": "2026-09-25T08:00:00Z"},
                "opening_intervals": {"2026-09-25": [[540, 1260]]},
                "price": {"expected_minor": 50000, "upper_minor": 50000, "basis": "per_person"},
                "facts": {}, **extra}
    places = [place("museum-near", "museum"), place("museum-far", "museum"), place("cafe", "cafe")]
    legs = [{"day_id": "d1", "from_id": a, "to_id": b, "safe_minutes": 30 if "museum-far" in (a, b) else 10,
             "from_point": {"lat": 55.75, "lon": 37.62}, "to_point": {"lat": 55.75, "lon": 37.62},
             "mode": "walking", "window": {"start": "12:00", "end": "16:00"},
             "date": "2026-09-25", "source": deepcopy(places[0]["source"])}
            for a in ["@origin", *[p["id"] for p in places]]
            for b in [*[p["id"] for p in places], "@destination"] if a != b]
    return {"schema_version": "place-selection.v1", "as_of": "2026-09-24T09:00:00Z",
            "intent": {"schema_version": "confirmed-daily-intent.research.v1", "session_id": "test",
                "draft_revision": 1, "locality": {"id": "mow", "name": "Москва", "region_id": "32", "timezone": "Europe/Moscow"},
                "shared": {"mobility": ["walking"], "party": {"total": 1},
                           "budget": {"kind": "limit", "amount_rub": 1500, "basis": "whole_party", "period": "whole_trip"}},
                "points": {"origin": {"lat": 55.75, "lon": 37.62, "locality_id": "mow", "label": "Начало"}},
                "days": [{"day_id": "d1", "date": "2026-09-25", "window": {"start": "12:00", "end": "16:00"},
                          "activities": [activity("culture", "museum"), activity("food", "cafe")],
                          "order": [["culture", "food"]]}]},
            "catalog": {"version": "test-catalog", "region_id": "32", "leaf_ids": ["museum", "cafe", "pub"]},
            "visit_policy": {"version": "test-durations.v1", "by_category": {"museum": 60, "cafe": 45}, "arrival_buffer_minutes": 5},
            "places": places, "route_legs": legs}


def test_selects_one_place_per_activity_and_preserves_order(job):
    result = select_places(job)
    assert result["status"] == "AVAILABLE"
    assert [v["place_id"] for v in result["days"][0]["visits"]] == ["museum-near", "cafe"]
    assert [v["activity_id"] for v in result["days"][0]["visits"]] == ["culture", "food"]
    assert result["days"][0]["total_safe_travel_minutes"] == 20
    assert result["days"][0]["visits"][0]["starts_at"] >= 12 * 60 + 15
    assert result["total_budget_upper_minor"] == 100000
    assert result["data_mode"] == "test"
    assert result["origin"]["label"] == "Начало"
    validate_selection(job, result)


def test_generic_walk_can_visit_two_distinct_waypoints(job):
    day = job["intent"]["days"][0]
    day["activities"] = day["activities"][:1]
    day["order"] = []
    job["visit_policy"]["by_activity"] = {"culture": 25}
    job["visit_policy"]["max_stops_by_activity"] = {"culture": 2}
    result = select_places(job)
    assert result["status"] == "AVAILABLE"
    assert {v["place_id"] for v in result["days"][0]["visits"]} == {"museum-near", "museum-far"}
    assert all(v["duration_minutes"] == 25 for v in result["days"][0]["visits"])
    validate_selection(job, result)


def test_generic_walk_with_one_reachable_waypoint_is_marked_incomplete(job):
    day = job["intent"]["days"][0]
    day["activities"] = day["activities"][:1]
    day["order"] = []
    job["places"] = job["places"][:1]
    job["visit_policy"]["by_activity"] = {"culture": 25}
    job["visit_policy"]["max_stops_by_activity"] = {"culture": 2}
    result = select_places(job)
    assert result["status"] == "LIMITED"
    assert len(result["days"][0]["visits"]) == 1
    assert "WALK_WAYPOINTS_INCOMPLETE" in result["warnings"]
    validate_selection(job, result)


def test_no_implicit_return_to_origin(job):
    job["route_legs"] = [leg for leg in job["route_legs"] if leg["to_id"] != "@destination"]
    assert select_places(job)["status"] == "AVAILABLE"
    job["intent"]["points"]["destination"] = deepcopy(job["intent"]["points"]["origin"])
    result = select_places(job)
    assert result["status"] == "UNAVAILABLE"


def test_departure_and_return_must_fit_day(job):
    job["intent"]["points"]["destination"] = deepcopy(job["intent"]["points"]["origin"])
    for leg in job["route_legs"]:
        if leg["to_id"] == "@destination":
            leg["safe_minutes"] = 240
    assert select_places(job)["status"] == "UNAVAILABLE"


@pytest.mark.parametrize("change,reason", [
    ({"opening_intervals": {}}, "SCHEDULE_UNKNOWN"),
    ({"opening_intervals": {"2026-09-25": [[540, 660]]}}, "NO_VISIT_WINDOW"),
    ({"point": None}, "POINT_UNKNOWN"),
    ({"region_id": "other"}, "REGION_MISMATCH"),
    ({"rubric_ids": ["pub"]}, "CATEGORY_MISMATCH"),
    ({"price": {"expected_minor": 50000, "upper_minor": None, "basis": "per_person"}}, "PRICE_UPPER_UNKNOWN"),
])
def test_ineligible_places_are_explained(job, change, reason):
    for place in job["places"]:
        if "museum" in place["id"]:
            place.update(deepcopy(change))
    result = select_places(job)
    assert result["status"] == "LIMITED"
    assert result["days"][0]["missing_activity_ids"] == ["culture"]
    assert any(reason in item["reasons"] for item in result["excluded"])


def test_exclusions_win_over_matching_category(job):
    job["intent"]["days"][0]["activities"][1]["categories"]["exclude"] = ["pub"]
    job["places"][-1]["rubric_ids"] = ["cafe", "pub"]
    result = select_places(job)
    assert result["days"][0]["missing_activity_ids"] == ["food"]


def test_known_matching_duration_survives_unmapped_secondary_rubric(job):
    activity = job["intent"]["days"][0]["activities"][0]
    activity["categories"]["include_any"].append("pub")
    job["places"][0]["rubric_ids"].append("pub")
    result = select_places(job)
    assert result["status"] == "AVAILABLE"
    assert result["days"][0]["visits"][0]["duration_minutes"] == 60


def test_no_known_matching_duration_still_excludes_place(job):
    activity = job["intent"]["days"][0]["activities"][0]
    activity["categories"]["include_any"] = ["pub"]
    job["places"][0]["rubric_ids"] = ["pub"]
    result = select_places(job)
    assert any("DURATION_UNKNOWN" in item["reasons"] for item in result["excluded"] if item["place_id"] == "museum-near")


def test_walk_activity_estimate_recovers_unmapped_matching_rubric_without_guessing_hours(job):
    activity = job["intent"]["days"][0]["activities"][0]
    activity["categories"]["include_any"] = ["pub"]
    job["places"][0]["rubric_ids"] = ["pub"]
    job["visit_policy"]["by_activity"] = {"culture": 60}
    result = select_places(job)
    visit = next(v for v in result["days"][0]["visits"] if v["activity_id"] == "culture")
    assert visit["duration_minutes"] == 60
    job["places"][0]["opening_intervals"] = {}
    result = select_places(job)
    assert any("SCHEDULE_UNKNOWN" in item["reasons"] for item in result["excluded"] if item["place_id"] == "museum-near")


def test_walk_activity_duration_is_not_shortened_by_poi_estimate(job):
    job["visit_policy"]["by_activity"] = {"culture": 60}
    job["visit_policy"]["by_category"]["museum"] = 20
    result = select_places(job)
    visit = next(v for v in result["days"][0]["visits"] if v["activity_id"] == "culture")
    assert visit["duration_minutes"] == 60


def test_tentative_outdoor_walk_never_claims_verified_opening_hours(job):
    job["intent"]["days"][0]["activities"] = [job["intent"]["days"][0]["activities"][0]]
    job["intent"]["days"][0]["order"] = []
    activity = job["intent"]["days"][0]["activities"][0]
    activity["categories"]["include_any"] = ["pub"]
    job["places"][0]["rubric_ids"] = ["pub"]
    job["places"][0]["opening_intervals"] = {}
    job["places"][1]["rubric_ids"] = ["cafe"]
    job["visit_policy"]["by_activity"] = {"culture": 60}
    job["visit_policy"]["tentative_schedule_category_ids"] = ["pub"]
    result = select_places(job)
    assert result["status"] == "LIMITED"
    visit = result["days"][0]["visits"][0]
    assert visit["place_id"] == "museum-near"
    assert "OPENING_HOURS_UNVERIFIED" in visit["warnings"]
    assert "OPEN_FOR_FULL_VISIT" not in visit["reasons"]
    assert "OPENING_HOURS_UNVERIFIED" in result["warnings"]


def test_required_facts_are_not_guessed(job):
    activity = job["intent"]["days"][0]["activities"][0]
    activity["requirements"] = [{"text": "доступно на коляске", "strength": "required"}]
    job["places"][1]["facts"]["доступно на коляске"] = True
    result = select_places(job)
    assert result["days"][0]["visits"][0]["place_id"] == "museum-far"


def test_preference_beats_distance_when_verified(job):
    job["intent"]["days"][0]["activities"][0]["requirements"] = [{"text": "тихо", "strength": "preferred"}]
    job["places"][1]["facts"]["тихо"] = True
    assert select_places(job)["days"][0]["visits"][0]["place_id"] == "museum-far"


def test_no_routes_means_no_invented_travel(job):
    job["route_legs"] = []
    result = select_places(job)
    assert result["status"] == "UNAVAILABLE"
    assert result["total_expected_cost_minor"] is None
    assert result["total_budget_upper_minor"] is None


def test_stale_place_and_route_data_are_not_used(job):
    for place in job["places"]:
        place["source"]["valid_until"] = "2026-09-24T08:30:00Z"
    assert select_places(job)["status"] == "UNAVAILABLE"


def test_same_place_cannot_fill_two_activities(job):
    job["places"] = [job["places"][-1]]
    job["intent"]["days"][0]["activities"][0]["categories"]["include_any"] = ["cafe"]
    result = select_places(job)
    assert result["status"] == "LIMITED"
    assert len(result["days"][0]["visits"]) == 1


def test_three_days_share_budget_not_three_copies(job):
    first_day = job["intent"]["days"][0]
    first_day["activities"] = first_day["activities"][:1]
    first_day["order"] = []
    job["intent"]["shared"]["budget"]["amount_rub"] = 1000
    original_legs = deepcopy(job["route_legs"])
    for n in (2, 3):
        day = deepcopy(first_day)
        day.update(day_id=f"d{n}", date=f"2026-09-{24+n}")
        job["intent"]["days"].append(day)
        for place in job["places"]:
            place["opening_intervals"][day["date"]] = [[540, 1260]]
        job["route_legs"].extend(dict(leg, day_id=day["day_id"], date=day["date"]) for leg in original_legs)
    result = select_places(job)
    assert result["status"] == "LIMITED"
    assert sum(len(day["visits"]) for day in result["days"]) == 2
    assert result["total_budget_upper_minor"] == 100000
    job["intent"]["shared"]["budget"]["period"] = "per_day"
    assert select_places(job)["status"] == "AVAILABLE"


def test_higher_average_check_is_not_treated_as_proven_upper_bound(job):
    job["places"][-1]["price"]["upper_minor"] = None
    result = select_places(job)
    assert result["status"] == "LIMITED"
    job["budget_policy"] = "estimate"
    result = select_places(job)
    assert result["status"] == "AVAILABLE"
    assert result["total_budget_upper_minor"] is None
    assert "BUDGET_ESTIMATED_NOT_GUARANTEED" in result["warnings"]


def test_optional_budget_allows_unknown_price_with_warning(job):
    job["intent"]["shared"].pop("budget")
    job["places"][-1]["price"] = None
    result = select_places(job)
    assert result["status"] == "AVAILABLE"
    assert result["total_expected_cost_minor"] is None
    assert "PRICE_UNKNOWN" in result["warnings"]


def test_unsupported_transport_is_not_substituted(job):
    job["intent"]["shared"]["mobility"] = ["public_transport"]
    result = select_places(job)
    assert result["status"] == "NEEDS_INPUT"
    assert "UNSUPPORTED_TRANSPORT" in result["issues"]


def test_catalog_mismatch_is_not_silently_accepted(job):
    job["catalog"]["version"] = "other"
    assert "CATALOG_MISMATCH" in select_places(job)["issues"]


@pytest.mark.parametrize("corrupt", ["time", "place", "total", "duplicate", "missing", "status"])
def test_independent_validator_rejects_corrupt_result(job, corrupt):
    result = select_places(job)
    if corrupt == "time": result["days"][0]["visits"][0]["starts_at"] = 0
    if corrupt == "place": result["days"][0]["visits"][0]["place_id"] = "invented"
    if corrupt == "total": result["total_budget_upper_minor"] = 0
    if corrupt == "duplicate": result["days"][0]["visits"].append(deepcopy(result["days"][0]["visits"][0]))
    if corrupt == "missing": result["days"][0]["missing_activity_ids"] = ["culture"]
    if corrupt == "status": result["status"] = "UNAVAILABLE"
    with pytest.raises(ValueError): validate_selection(job, result)


def test_result_is_stable_under_candidate_input_reordering(job):
    result = select_places(job)
    job["places"].reverse()
    job["route_legs"].reverse()
    assert select_places(job) == result


def test_strictly_validates_untrusted_shapes(job):
    job["intent"]["days"][0]["window"]["start"] = "12:99"
    with pytest.raises(ValueError): select_places(job)


@pytest.mark.parametrize("field,value", [
    ("mode", "driving"), ("date", "2026-09-26"),
    ("window", {"start": "12:01", "end": "16:00"}),
    ("from_point", {"lat": 55.8, "lon": 37.62}),
    ("to_point", {"lat": 55.8, "lon": 37.62}),
    ("source", {"provider": "test", "data_mode": "test", "fetched_at": "2026-09-23T08:00:00Z", "valid_until": "2026-09-24T08:30:00Z"}),
])
def test_route_evidence_is_bound_to_coordinates_mode_date_window_and_freshness(job, field, value):
    for leg in job["route_legs"]:
        leg[field] = deepcopy(value)
    result = select_places(job)
    assert result["status"] == "UNAVAILABLE"
    assert result["route_issues"]


def test_changing_origin_invalidates_previously_computed_routes(job):
    job["intent"]["points"]["origin"]["lat"] += 0.01
    assert select_places(job)["status"] == "UNAVAILABLE"


def test_transitive_order_survives_missing_intermediate_activity(job):
    day = job["intent"]["days"][0]
    absent = deepcopy(day["activities"][0])
    absent["id"] = "middle"
    absent["categories"]["include_any"] = ["pub"]
    day["activities"].append(absent)
    day["order"] = [["food", "middle"], ["middle", "culture"]]
    result = select_places(job)
    assert [v["activity_id"] for v in result["days"][0]["visits"]] == ["food", "culture"]
    assert result["days"][0]["missing_activity_ids"] == ["middle"]


@pytest.mark.parametrize("seed", range(8))
def test_tiny_solver_objective_matches_exhaustive_oracle(job, seed):
    # An independent tiny test oracle, never a production search algorithm.
    from itertools import permutations
    from random import Random
    rng = Random(seed)
    for leg in job["route_legs"]: leg["safe_minutes"] = rng.randint(1, 100)
    budget = rng.choice([500, 1000, 1500])
    job["intent"]["shared"]["budget"]["amount_rub"] = budget
    paths = { (leg["from_id"], leg["to_id"]): leg["safe_minutes"] for leg in job["route_legs"] }
    durations = {"museum-near": 60, "museum-far": 60, "cafe": 45}
    possibilities = [(0, 0, 0, -720)]
    for length in (1, 2):
        for order in permutations(durations, length):
            if length == 2 and (order[0] == "cafe" or order[1] != "cafe"): continue
            if length * 500 > budget: continue
            current, travel, before = 720, 0, "@origin"
            for pid in order:
                minutes = paths[(before, pid)]
                travel += minutes
                current += minutes + 5 + durations[pid]
                before = pid
            if current <= 960: possibilities.append((length, -travel, length * 350, -current))
    result = select_places(job)
    day = result["days"][0]
    count = len(day["visits"])
    assert (count, -day["total_safe_travel_minutes"], count * 350, -day["ends_at"]) == max(possibilities)


def test_partial_retrieval_is_visible_even_when_every_activity_fits(job):
    job["retrieval"] = {"coverage": "PARTIAL"}
    assert "RETRIEVAL_PARTIAL" in select_places(job)["warnings"]
