"""Allowlisted 2GIS response projection. No requests, persistence or LLM use."""
from datetime import date, timedelta
import re

from .selection import clock, nonempty, point_valid

WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


def _hours(day):
    if not isinstance(day, dict): return None
    if day.get("is_24x7") is True: return [[0, 1440]]
    raw = day.get("working_hours")
    if not isinstance(raw, list): return None
    result = []
    for span in raw:
        if not isinstance(span, dict): return None
        try: start, end = clock(span.get("from")), clock(span.get("to"))
        except ValueError: return None
        if start == end: return None  # Never infer 24h from ambiguous 00:00–00:00.
        result.append([start, end if end > start else end + 1440])
    return result


def _intervals(item, iso):
    schedule, special = item.get("schedule"), item.get("schedule_special", [])
    if not isinstance(schedule, dict) or not isinstance(special, list): return None
    if schedule.get("comment"): return None  # A textual closure exception needs a separate resolver.
    current = date.fromisoformat(iso)
    def day_hours(target):
        matched = [s for s in special if isinstance(s, dict) and s.get("date") == target.isoformat()]
        if len(matched) > 1: return None
        if matched: return _hours(matched[0])
        try:
            if schedule.get("date_from") and target < date.fromisoformat(schedule["date_from"]): return None
            if schedule.get("date_to") and target > date.fromisoformat(schedule["date_to"]): return None
        except (TypeError, ValueError): return None
        if schedule.get("is_24x7") is True: return [[0, 1440]]
        return _hours(schedule.get(WEEKDAYS[target.weekday()]))
    today = day_hours(current)
    if today is None: return None
    intervals = [[a, min(b, 1440)] for a, b in today]
    # Explicit target-day schedule replaces carry-over assumptions.
    if not any(isinstance(s, dict) and s.get("date") == iso for s in special):
        previous = day_hours(current - timedelta(days=1))
        intervals += [[0, b - 1440] for _, b in previous or [] if b > 1440]
    merged = []
    for a, b in sorted(intervals):
        if merged and a <= merged[-1][1]: merged[-1][1] = max(b, merged[-1][1])
        else: merged.append([a, b])
    return merged


def normalize_place(item, *, dates, requested_region_id, fetched_at, valid_until, data_mode="live"):
    pid, name = nonempty(item.get("id"), "provider id"), nonempty(item.get("name"), "provider name")
    windows, warnings = {}, []
    for iso in dates:
        value = _intervals(item, iso)
        if value is None: warnings.append(f"SCHEDULE_UNRESOLVED:{iso}")
        else: windows[iso] = value
    price = None
    for group in item.get("attribute_groups") or []:
        for attribute in group.get("attributes") or []:
            if attribute.get("tag") != "food_service_avg_price": continue
            text = attribute.get("name", "")
            # Ranges/from-prices are not exact average-check numbers.
            numbers = re.findall(r"\d[\d\s\u00a0\u202f]*", text)
            if len(numbers) == 1 and not re.search(r"\bот\b|\bдо\b", text, re.I):
                amount = int(re.sub(r"\s", "", numbers[0]))
                price = {"expected_minor": amount * 100, "upper_minor": None, "basis": "unknown"}
            warnings.append("AVERAGE_CHECK_UNIT_UNVERIFIED")
    reviews = item.get("reviews") or {}
    rating, count = reviews.get("general_rating"), reviews.get("general_review_count")
    return {"id": pid, "name": name, "region_id": str(item.get("region_id") or requested_region_id),
            "rubric_ids": sorted({str(r["id"]) for r in item.get("rubrics") or [] if isinstance(r, dict) and r.get("id")}),
            "point": item.get("point") if point_valid(item.get("point")) else None,
            "opening_intervals": windows, "price": price, "facts": {},
            "reviews": {"rating": rating, "count": count} if rating is not None and count is not None else {},
            "crowding": {"state": "PRESENT_UNMAPPED"} if item.get("congestion") is not None else None,
            "source": {"provider": "2gis", "url": "https://2gis.ru/firm/" + pid,
                       "data_mode": data_mode, "fetched_at": fetched_at, "valid_until": valid_until},
            "normalization_warnings": sorted(set(warnings))}
