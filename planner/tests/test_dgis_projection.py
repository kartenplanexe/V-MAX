from vmax_planner.dgis import normalize_place


def project(item, dates=("2026-09-25",)):
    return normalize_place(item, dates=dates, requested_region_id="32", fetched_at="2026-09-24T09:00:00Z",
                           valid_until="2026-09-24T10:00:00Z", data_mode="test")


def test_schedule_breaks_and_overnight_spill():
    item = {"id": "1", "name": "Тест", "schedule": {
        "Thu": {"working_hours": [{"from": "22:00", "to": "02:00"}]},
        "Fri": {"working_hours": [{"from": "09:00", "to": "13:00"}, {"from": "14:00", "to": "18:00"}]}}}
    assert project(item)["opening_intervals"]["2026-09-25"] == [[0, 120], [540, 780], [840, 1080]]


def test_special_closure_overrides_ordinary_schedule_and_previous_night():
    item = {"id": "1", "name": "Тест", "schedule": {"is_24x7": True},
            "schedule_special": [{"date": "2026-09-25", "working_hours": []}]}
    assert project(item)["opening_intervals"]["2026-09-25"] == []


def test_previous_special_schedule_is_used_for_overnight():
    item = {"id": "1", "name": "Тест", "schedule": {"Thu": {"working_hours": []}, "Fri": {"working_hours": []}},
            "schedule_special": [{"date": "2026-09-24", "working_hours": [{"from": "22:00", "to": "02:00"}]}]}
    assert project(item)["opening_intervals"]["2026-09-25"] == [[0, 120]]


def test_unknown_or_malformed_schedule_does_not_become_open_or_closed():
    for schedule in ({}, {"Fri": {"working_hours": [{"from": "12:99", "to": "15:00"}]}},
                     {"Fri": {"working_hours": []}, "comment": "санитарный день — последняя пятница"}):
        out = project({"id": "1", "name": "Тест", "schedule": schedule})
        assert out["opening_intervals"] == {}
        assert out["normalization_warnings"]


def test_average_check_is_only_estimate_with_unverified_unit():
    item = {"id": "1", "name": "Кафе", "rubrics": [{"id": "161"}], "attribute_groups": [{"attributes": [
        {"tag": "food_service_avg_price", "name": "Средний чек 1 200 ₽"}]}]}
    price = project(item)["price"]
    assert price == {"expected_minor": 120000, "upper_minor": None, "basis": "unknown"}


def test_payload_secrets_and_ads_are_not_projected():
    item = {"id": "1", "name": "Тест", "key": "secret", "ads": {"rank": 100}, "congestion": {"unknown": True}}
    out = project(item)
    assert "key" not in out and "ads" not in out
    assert "congestion" not in out
    assert out["crowding"] == {"state": "PRESENT_UNMAPPED"}


def test_absent_prices_are_unknown_not_free():
    assert project({"id": "1", "name": "Тест"})["price"] is None


def test_expired_seasonal_schedule_is_not_applied_to_new_date():
    item = {"id": "1", "name": "Тест", "schedule": {"is_24x7": True, "date_to": "2026-08-31"}}
    assert project(item)["opening_intervals"] == {}


def test_exact_object_link_and_location_disambiguate_same_name_places():
    item = {"id": "70030077058045532", "name": "Шуховская Башня", "type": "attraction",
            "city_alias": "n_novgorod", "adm_div": [{"type": "district", "name": "Канавинский район"}]}
    out = project(item)
    assert out["location_label"] == "Канавинский район"
    assert out["source"]["url"] == "https://2gis.ru/n_novgorod/geo/70030077058045532"


def test_untrusted_place_url_parts_are_not_reflected():
    out = project({"id": "123", "name": "Тест", "city_alias": "bad/../place"})
    assert out["source"]["url"] is None
