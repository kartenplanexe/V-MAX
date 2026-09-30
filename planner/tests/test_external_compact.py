from test_routing_budget import candidates_job
from vmax_planner.routing import prepare_routes
from vmax_planner.selection import direct_meters

def compact(job):
    job['routing_policy'] = {'strategy': 'progressive', 'external_compact': True}
    result = prepare_routes(job)
    assert result['pairs'] == []
    return result['preview_job']['candidate_pool']

def test_single_place_visits_stay_compact_and_deterministic():
    job = candidates_job(activities=2, candidates=30)
    job['intent']['days'][0]['window'] = {'start': '16:00', 'end': '19:00'}
    result = compact(job)
    assert len(result) == 2
    assert [row['activity_id'] for row in result] == ['activity-0', 'activity-1']
    job['places'].reverse()
    assert compact(job) == result

def test_sum_of_visit_durations_not_each_visit_alone_limits_selection():
    job = candidates_job(activities=2)
    day = job['intent']['days'][0]
    day['window'] = {'start': '16:00', 'end': '17:00'}
    for activity in day['activities']:
        activity['duration_minutes'] = 40
    assert len(compact(job)) == 1

def test_far_places_and_distant_finish_do_not_fit_short_window():
    job = candidates_job()
    job['intent']['days'][0]['window'] = {'start': '16:00', 'end': '17:00'}
    for place in job['places']:
        place['point']['lat'] += 0.03
    assert compact(job) == []
    job = candidates_job()
    job['intent']['days'][0]['window'] = {'start': '16:00', 'end': '17:00'}
    job['intent']['points']['destination'] = dict(job['intent']['points']['origin'], lat=55.85, lon=37.62)
    assert compact(job) == []

def test_precedence_and_budget_are_global_and_no_place_reused():
    job = candidates_job(activities=2)
    day = job['intent']['days'][0]
    day['order'] = [['activity-1', 'activity-0']]
    assert [r['activity_id'] for r in compact(job)] == ['activity-1', 'activity-0']
    job['intent']['shared']['budget'] = {'kind': 'limit', 'amount_rub': 100,
        'basis': 'whole_party', 'period': 'per_day'}
    for place in job['places']:
        place['price'] = {'basis': 'whole_party', 'expected_minor': 8000, 'upper_minor': 8000}
    assert len(compact(job)) == 1

def test_daily_cap_and_closed_places():
    job = candidates_job(activities=10, candidates=1)
    assert len(compact(job)) <= 6
    for place in job['places']:
        place['opening_intervals'] = {job['intent']['days'][0]['date']: [[0, 10]]}
    assert compact(job) == []

def walk_and_food(end='18:00'):
    job = candidates_job(activities=2, candidates=8, walk=True)
    day = job['intent']['days'][0]
    day['window'] = {'start': '16:00', 'end': end}
    day['order'] = [['activity-0', 'activity-1']]
    day['activities'][0]['intent_kind'] = 'route_walk'
    job['visit_policy']['by_category'] = {'category-0': 60, 'category-1': 60}
    for index, place in enumerate(job['places'][:8]):
        place['point']['lat'] = 55.751 + index * 0.005
    return job

def test_two_hour_walk_then_food_keeps_both_instead_of_filling_window_with_walk():
    job = walk_and_food()
    result = compact(job)
    assert [r['activity_id'] for r in result] == ['activity-0', 'activity-1']
    assert [r['estimated_visit_minutes'] for r in result] == [5, 60]

def test_extra_time_adds_walk_points_but_only_one_food_place():
    job = walk_and_food('19:00')
    result = compact(job)
    walking = [r for r in result if r['activity_id'] == 'activity-0']
    assert len(walking) >= 2
    assert result[-1]['activity_id'] == 'activity-1'
    assert len([r for r in result if r['activity_id'] == 'activity-1']) == 1
    assert len({r['place_id'] for r in result}) == len(result) <= 6

def test_explicit_walk_duration_is_not_shortened_to_squeeze_in_food():
    job = walk_and_food()
    job['intent']['days'][0]['activities'][0]['duration_minutes'] = 90
    result = compact(job)
    assert len(result) == 1
    assert result[0]['activity_id'] == 'activity-0'
    assert result[0]['estimated_visit_minutes'] == 90

def test_a_flexible_park_walk_can_fit_before_a_full_meal():
    job = walk_and_food()
    job['intent']['days'][0]['activities'][0]['intent_kind'] = 'area_walk'
    job['visit_policy'].pop('max_stops_by_activity')
    result = compact(job)
    assert [r['activity_id'] for r in result] == ['activity-0', 'activity-1']
    assert result[0]['estimated_visit_minutes'] == 5

def test_search_selects_a_different_walk_place_when_nearest_cannot_connect_to_food():
    job = candidates_job(activities=2, candidates=2)
    day = job['intent']['days'][0]
    day['window'] = {'start': '16:00', 'end': '17:20'}
    day['order'] = [['activity-0', 'activity-1']]

    job['places'][0]['opening_intervals'] = {day['date']: [[1000, 1440]]}
    result = compact(job)
    assert len(result) == 2
    assert result[0]['place_id'] == 'activity-0-place-1'

def test_missing_food_is_distinguished_from_no_joint_combination():
    job = walk_and_food()
    date = job['intent']['days'][0]['date']
    for place in job['places']:
        if place['rubric_ids'] == ['category-1']:
            place['opening_intervals'] = {date: [[0, 10]]}
    compact(job)
    assert prepare_routes(job)['preview_job']['selection_gaps'] == [
        {'day_id': job['intent']['days'][0]['day_id'], 'activity_id': 'activity-1', 'reason': 'NO_ELIGIBLE_PLACES'}]
    job = walk_and_food()
    job['intent']['days'][0]['activities'][0]['duration_minutes'] = 90
    compact(job)
    assert prepare_routes(job)['preview_job']['selection_gaps'][0]['reason'] == 'COMBINATION_NOT_FOUND'

def test_only_walking_uses_spare_time_for_multiple_stops():
    job = candidates_job(candidates=30, walk=True)
    for index, place in enumerate(job['places']):
        place['point']['lat'] = 55.751 + index * 0.004
    result = compact(job)
    assert 2 <= len(result) <= 6

def test_transfers_limit_five_minute_walk_stops_in_a_one_hour_window():
    job = candidates_job(candidates=2, walk=True)
    day = job['intent']['days'][0]
    day['window'] = {'start': '16:00', 'end': '17:00'}
    job['intent']['points']['origin'].update(job['places'][0]['point'])
    job['places'][1]['point']['lat'] = job['places'][0]['point']['lat'] + 0.004
    assert len(compact(job)) == 2

    job['places'][1]['point']['lat'] += 0.02
    assert len(compact(job)) == 1

def test_dense_cluster_is_not_filled_even_in_a_long_window():
    job = candidates_job(candidates=30, walk=True)
    assert len(compact(job)) == 1

def test_separation_applies_to_all_pairs_not_only_consecutive_stops():
    job = candidates_job(candidates=3, walk=True)

    for place, lat in zip(job['places'], [55.751, 55.756, 55.7515]):
        place['point']['lat'] = lat
    result = compact(job)
    assert len(result) == 2
    points = {p['id']: p['point'] for p in job['places']}
    assert direct_meters(points[result[0]['place_id']], points[result[1]['place_id']]) >= 400
    job['places'].reverse()
    assert compact(job) == result

def test_spaced_alternative_after_first_twelve_candidates_is_still_available():
    job = candidates_job(candidates=25, walk=True)

    job['places'][-1]['point']['lat'] = 55.756
    result = compact(job)
    assert len(result) == 2
    assert any(r['place_id'] == 'activity-0-place-24' for r in result)

def test_nearby_food_is_not_rejected_by_same_activity_density():
    job = walk_and_food()
    food = job['places'][8]
    food['point'] = dict(job['places'][0]['point'])
    for place in job['places'][9:]:
        place['opening_intervals'] = {job['intent']['days'][0]['date']: [[0, 10]]}
    result = compact(job)
    assert [r['activity_id'] for r in result] == ['activity-0', 'activity-1']
    assert result[-1]['place_id'] == food['id']

def test_a_scenic_walk_type_survives_many_nearer_incidental_points():
    job = walk_and_food('20:00')

    job['catalog']['leaf_ids'].append('park')
    job['intent']['days'][0]['activities'][0]['categories']['include_any'].append('park')
    job['visit_policy']['by_category']['park'] = 5
    job['visit_policy']['walk_rubric_scores'] = {'park': 2, 'category-0': 0}
    park = dict(job['places'][0], id='park-place', rubric_ids=['park'], point={'lat': 55.761, 'lon': 37.622})
    job['places'].append(park)
    result = compact(job)
    assert any(r['place_id'] == 'park-place' for r in result)
    assert result[-1]['activity_id'] == 'activity-1'
    assert len(result) >= 3
    points = {p['id']: p['point'] for p in job['places']}
    walk = [r for r in result if r['activity_id'] == 'activity-0']
    assert all(direct_meters(points[a['place_id']], points[b['place_id']]) >= 400
        for i, a in enumerate(walk) for b in walk[i+1:])

def test_scenic_type_cannot_replace_meal_or_violate_time():
    job = walk_and_food()
    job['catalog']['leaf_ids'].append('park')
    job['intent']['days'][0]['activities'][0]['categories']['include_any'].append('park')
    job['visit_policy']['by_category']['park'] = 5
    job['visit_policy']['walk_rubric_scores'] = {'park': 2}
    job['places'].append(dict(job['places'][0], id='far-park', rubric_ids=['park'],
        point={'lat': 55.82, 'lon': 37.622}))
    result = compact(job)
    assert [r['activity_id'] for r in result] == ['activity-0', 'activity-1']
    assert not any(r['place_id'] == 'far-park' for r in result)
