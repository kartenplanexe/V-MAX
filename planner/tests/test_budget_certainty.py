"""Real provider normalization, eligibility, solver and independent validation."""
from copy import deepcopy

import pytest

from vmax_planner.demo import demo_job
from vmax_planner.dgis import normalize_place
from vmax_planner.routing import prepare_routes
from vmax_planner.selection import select_places, validate_selection


def average_bill_job(*, amount=1500, people=1, enforcement=None, consent=False, priced=True):
    job = demo_job()
    day = job["intent"]["days"][0]
    day["activities"] = [day["activities"][1]]
    day["order"] = []
    budget = job["intent"]["shared"]["budget"]
    budget["amount_rub"] = amount
    if enforcement is not None:
        budget["enforcement"] = enforcement
    if consent:
        budget["price_basis_assumption"] = "per_person"
    job["intent"]["shared"]["party"] = {} if people is None else {"total": people}
    source = job["places"][0]["source"]
    item = {"id": "cafe", "name": "Synthetic cafe", "point": job["places"][2]["point"],
            "rubrics": [{"id": "cafe"}], "schedule": {"is_24x7": True}}
    if priced:
        item["attribute_groups"] = [{"attributes": [{"tag": "food_service_avg_price", "name": "Средний чек 1 200 ₽"}]}]
    job["places"] = [normalize_place(item, dates=[day["date"]], requested_region_id="32",
                        fetched_at=source["fetched_at"], valid_until=source["valid_until"], data_mode="test")]
    job["route_legs"] = [leg for leg in job["route_legs"] if leg["from_id"] == "@origin" and leg["to_id"] == "cafe"]
    return job


def solved(job):
    prepared = prepare_routes(job)
    if prepared["status"] != "AVAILABLE":
        return prepared
    narrowed = prepared["job"] | {"route_legs": job["route_legs"]}
    result = select_places(narrowed)
    validate_selection(narrowed, result)
    return result


def test_strict_default_never_turns_average_bill_into_upper_bound():
    job = average_bill_job()
    result = solved(job)
    assert result["status"] == "UNAVAILABLE"
    assert result["issues"] == ["BUDGET_PRICE_DATA_REQUIRED"]
    assert result["total_budget_upper_minor"] is None
    assert result["days"][0]["missing_activity_ids"] == ["food"]


def test_internal_policy_cannot_silently_relax_confirmed_strict_budget():
    job = average_bill_job()
    job["budget_policy"] = "estimate"
    with pytest.raises(ValueError, match="confirmed budget"):
        solved(job)


def test_explicit_estimate_consent_uses_average_bill_without_fabricating_upper():
    job = average_bill_job(enforcement="estimated", consent=True)
    result = solved(job)
    assert result["status"] == "AVAILABLE"
    assert result["total_expected_cost_minor"] == 120000
    assert result["total_budget_upper_minor"] is None
    assert {"BUDGET_ESTIMATED_NOT_GUARANTEED", "AVERAGE_CHECK_BASIS_ASSUMED_PER_PERSON"} <= set(result["warnings"])
    assert job["places"][0]["price"]["basis"] == "unknown"
    assert job["places"][0]["price"]["upper_minor"] is None


@pytest.mark.parametrize("people,consent,issue", [(1, False, "BUDGET_PRICE_BASIS_REQUIRED"), (None, True, "PARTY_REQUIRED")])
def test_estimate_requires_user_basis_consent_and_known_group(people, consent, issue):
    result = solved(average_bill_job(enforcement="estimated", consent=consent, people=people))
    assert result["status"] == "NEEDS_INPUT"
    assert issue in result["issues"]


def test_unknown_prices_are_not_zero_even_with_estimate_consent():
    result = solved(average_bill_job(enforcement="estimated", consent=True, priced=False))
    assert result["status"] == "UNAVAILABLE"
    assert result["total_expected_cost_minor"] is None
    assert result["issues"] == ["BUDGET_PRICE_DATA_REQUIRED"]
    assert result["excluded"][0]["reasons"] == ["PRICE_ESTIMATE_UNKNOWN"]


def test_average_bill_estimate_is_scaled_to_group_and_respects_limit():
    job = average_bill_job(enforcement="estimated", consent=True, people=2, amount=2300)
    assert solved(job)["status"] == "UNAVAILABLE"
    job["intent"]["shared"]["budget"]["amount_rub"] = 2400
    result = solved(job)
    assert result["status"] == "AVAILABLE"
    assert result["total_expected_cost_minor"] == 240000


def test_estimated_trip_budget_is_not_repeated_for_each_day():
    job = average_bill_job(enforcement="estimated", consent=True)
    day = deepcopy(job["intent"]["days"][0])
    day.update(day_id="day-2", date="2026-09-26")
    job["intent"]["days"].append(day)
    job["places"][0]["opening_intervals"][day["date"]] = [[0, 1440]]
    job["route_legs"].extend(dict(leg, day_id=day["day_id"], date=day["date"]) for leg in list(job["route_legs"]))
    assert solved(job)["status"] == "LIMITED"
    job["intent"]["shared"]["budget"]["period"] = "per_day"
    result = solved(job)
    assert result["status"] == "AVAILABLE"
    assert result["total_expected_cost_minor"] == 240000


def test_estimated_mode_accepts_a_verified_upper_bound_without_inventing_expected_price():
    job = average_bill_job(amount=1500, people=2)
    job["places"][0]["price"] = {"basis": "whole_party", "expected_minor": None, "upper_minor": 120000}
    assert solved(job)["status"] == "AVAILABLE"

    job["intent"]["shared"]["budget"].update(enforcement="estimated", price_basis_assumption="per_person")
    result = solved(job)
    assert result["status"] == "AVAILABLE"
    assert result["total_expected_cost_minor"] is None
    assert result["total_budget_upper_minor"] == 120000
    assert result["days"][0]["visits"][0]["price_expected_minor"] is None
    assert result["days"][0]["visits"][0]["price_upper_minor"] == 120000

    job["intent"]["shared"]["budget"]["amount_rub"] = 1100
    assert solved(job)["status"] == "UNAVAILABLE"
