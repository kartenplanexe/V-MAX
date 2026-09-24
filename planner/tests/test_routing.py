from copy import deepcopy
from datetime import datetime, timezone

import pytest

from vmax_planner.demo import demo_job
from vmax_planner.routing import departure_utc, prepare_routes, route_checks
from vmax_planner.selection import select_places


def test_prepare_routes_excludes_closed_places_before_requesting_edges():
    job = demo_job()
    job["places"][1]["opening_intervals"] = {"2026-09-25": []}
    result = prepare_routes(job)
    assert result["status"] == "AVAILABLE"
    assert {(p["from_id"], p["to_id"]) for p in result["pairs"]} == {
        ("@origin", "museum-near"), ("@origin", "cafe"), ("museum-near", "cafe")}
    assert all(p["mode"] == "walking" and len(p["sample_utc"]) == 1 for p in result["pairs"])
    assert result["maximum_selected_legs"] == 2


def test_shortlist_is_deterministic_and_explicit_and_not_an_eligibility_override():
    job = demo_job()
    job["routing_policy"] = {"candidates_per_activity": 1}
    result = prepare_routes(job)
    assert result["shortlist"]["groups"][0] == {"day_id": "day-1", "activity_id": "culture", "eligible": 2, "selected": 1, "truncated": True}
    assert {r["place_id"] for r in result["job"]["candidate_pool"]} == {"museum-near", "cafe"}
    narrowed = result["job"] | {"route_legs": job["route_legs"]}
    assert select_places(narrowed)["status"] == "AVAILABLE"
    narrowed["places"][0]["opening_intervals"] = {}
    with pytest.raises(ValueError, match="ineligible"):
        select_places(narrowed)


def test_can_reduce_large_eligible_pool_before_solver_cap():
    job = demo_job()
    template = job["places"][0]
    job["places"].extend(deepcopy(template) | {"id": f"museum-{i}"} for i in range(130))
    assert select_places(job)["issues"] == ["CANDIDATE_POOL_TOO_LARGE"]
    prepared = prepare_routes(job)
    assert prepared["status"] == "AVAILABLE"
    assert len(prepared["job"]["candidate_pool"]) == 5


@pytest.mark.parametrize("zone,minute,expected", [
    ("Europe/Moscow", 960, "2026-09-25T13:00:00+00:00"),
    ("Asia/Vladivostok", 960, "2026-09-25T06:00:00+00:00"),
    ("Europe/Kaliningrad", 1440, "2026-09-25T22:00:00+00:00"),
])
def test_departure_uses_locality_timezone_and_supports_24h(zone, minute, expected):
    value = departure_utc({"date": "2026-09-25"}, minute, zone)
    assert datetime.fromtimestamp(value, timezone.utc).isoformat() == expected


def test_day_specific_edges_and_driving_samples():
    job = demo_job()
    job["intent"]["shared"]["mobility"] = ["driving"]
    assert prepare_routes(job)["issues"] == ["TRANSPORT_COST_POLICY_REQUIRED"]
    job["intent"]["shared"].pop("budget")
    day = deepcopy(job["intent"]["days"][0])
    day.update(day_id="day-2", date="2026-09-26")
    job["intent"]["days"].append(day)
    for place in job["places"]: place["opening_intervals"][day["date"]] = [[600, 1200]]
    result = prepare_routes(job)
    assert len(result["pairs"]) == 10
    first, second = result["pairs"][0], result["pairs"][5]
    assert len(first["sample_utc"]) == 3
    assert second["sample_utc"][0] - first["sample_utc"][0] == 86400


def test_rechecks_use_actual_departures_and_include_explicit_return_only():
    job = demo_job()
    result = select_places(job)
    checks = route_checks({"job": job, "result": result})["checks"]
    assert [c["from_id"] for c in checks] == ["@origin", "museum-near"]
    assert checks[1]["departure_utc"] - checks[0]["departure_utc"] == 75 * 60
    job["intent"]["points"]["destination"] = deepcopy(job["intent"]["points"]["origin"])
    job["route_legs"].append(job["route_legs"][0] | {"from_id": "cafe", "to_id": "@destination",
        "from_point": job["places"][2]["point"], "to_point": job["intent"]["points"]["destination"], "safe_minutes": 10})
    result = select_places(job)
    checks = route_checks({"job": job, "result": result})["checks"]
    assert checks[-1]["to_id"] == "@destination"
    assert checks[-1]["departure_utc"] - checks[0]["departure_utc"] == 135 * 60


def test_recheck_rejects_tampered_result_and_stale_data():
    job = demo_job()
    result = select_places(job)
    changed = deepcopy(result)
    changed["days"][0]["visits"][0]["starts_at"] -= 1
    with pytest.raises(ValueError): route_checks({"job": job, "result": changed})
    job["as_of"] = "2026-09-24T11:00:00Z"
    with pytest.raises(ValueError): route_checks({"job": job, "result": result})


@pytest.mark.parametrize("mode", ["public_transport", "teleport"])
def test_unsupported_transport_does_not_fall_back_to_walking(mode):
    job = demo_job()
    job["intent"]["shared"]["mobility"] = [mode]
    assert prepare_routes(job)["issues"] == ["UNSUPPORTED_TRANSPORT"]
