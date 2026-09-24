"""A tiny synthetic job, not a real 2GIS response or a live route measurement."""
from copy import deepcopy


def demo_job():
    source = {"provider": "synthetic", "data_mode": "test", "fetched_at": "2026-09-24T09:00:00Z",
              "valid_until": "2026-09-24T10:00:00Z"}
    origin = {"lat": 55.75, "lon": 37.62, "locality_id": "demo-city"}
    places = [
        {"id": "museum-near", "name": "Учебный музей рядом", "rubric_ids": ["museum"],
         "point": {"lat": 55.751, "lon": 37.622}, "rating": 4.5, "price_rub": 400},
        {"id": "museum-far", "name": "Учебный музей далеко", "rubric_ids": ["museum"],
         "point": {"lat": 55.761, "lon": 37.642}, "rating": 4.9, "price_rub": 500},
        {"id": "cafe", "name": "Учебное кафе", "rubric_ids": ["cafe"],
         "point": {"lat": 55.752, "lon": 37.624}, "rating": 4.4, "price_rub": 600},
    ]
    for p in places:
        p.update(region_id="32", source=deepcopy(source), opening_intervals={"2026-09-25": [[600, 1200]]}, facts={},
                 reviews={"rating": p.pop("rating"), "count": 100})
        price = p.pop("price_rub") * 100
        p["price"] = {"expected_minor": price, "upper_minor": price, "basis": "per_person"}
    def activity(aid, label, category):
        return {"id": aid, "label": label, "selection": {"category_policy": "related_allowed", "named_types": []},
                "requirements": [], "categories": {"state": "matched", "include_any": [category], "exclude": [],
                "region_id": "32", "catalog_version": "synthetic-catalog.v1"}}
    day = {"day_id": "day-1", "date": "2026-09-25", "window": {"start": "16:00", "end": "19:00"},
           "activities": [activity("culture", "Сначала музей", "museum"), activity("food", "Потом кафе", "cafe")],
           "order": [["culture", "food"]]}
    by_id = {p["id"]: p["point"] for p in places}
    legs = [{"day_id": day["day_id"], "from_id": a, "to_id": b,
             "from_point": origin if a == "@origin" else by_id[a], "to_point": by_id[b],
             "safe_minutes": 40 if "museum-far" in (a, b) else 10,
             "mode": "walking", "date": day["date"], "window": dict(day["window"]), "source": dict(source)}
            for a in ["@origin", *by_id] for b in by_id if a != b]
    return {"schema_version": "place-selection.v1", "as_of": "2026-09-24T09:30:00Z",
            "intent": {"schema_version": "confirmed-daily-intent.research.v1", "session_id": "synthetic-demo", "draft_revision": 1,
                       "locality": {"id": "demo-city", "name": "Учебный город", "region_id": "32", "timezone": "Europe/Moscow"},
                       "shared": {"mobility": ["walking"], "party": {"total": 1},
                                  "budget": {"kind": "limit", "amount_rub": 1500, "basis": "whole_party", "period": "whole_trip"}},
                       "points": {"origin": origin}, "days": [day]},
            "catalog": {"version": "synthetic-catalog.v1", "region_id": "32", "leaf_ids": ["museum", "cafe"]},
            "visit_policy": {"version": "demo-durations.v1", "by_category": {"museum": 60, "cafe": 45}, "arrival_buffer_minutes": 5},
            "places": places, "route_legs": legs}
