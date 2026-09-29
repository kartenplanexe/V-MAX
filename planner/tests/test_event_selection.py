from copy import deepcopy
from datetime import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import sys

import pytest

from test_selection import job
from vmax_planner.selection import select_places, validate_selection
from vmax_planner.routing import prepare_routes, route_checks
from vmax_planner.cli import project_batches
from vmax_planner.events import event_candidate_id


def epoch(value):
    return int(datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp())


def selected_event(job, only=False):
    day = job['intent']['days'][0]
    ref = {'provider': 'kudago', 'event_id': '99', 'occurrence_key': 'a' * 64}
    activity = {'id': 'culture', 'label': 'Выбранное событие', 'intent_kind': 'event_visit',
                'requirements': [], 'target': {'kind': 'event', **ref}}
    day['activities'][0] = activity
    if only:
        day['activities'] = [activity]
        day['order'] = []
    identity = json.dumps([ref['event_id'], ref['occurrence_key'], 'd1', 'culture'], ensure_ascii=False, separators=(',', ':'))
    event = {'kind': 'event', 'id': 'event:kudago:' + hashlib.sha256(identity.encode()).hexdigest(),
             'name': 'Синтетический сеанс', 'location_label': None, 'locality_id': 'mow', 'region_id': '32', 'date': day['date'],
             'event_ref': ref, 'day_id': 'd1', 'activity_id': 'culture', 'point': {'lat': 55.75, 'lon': 37.62},
             'source': {'provider': 'kudago', 'url': 'https://kudago.com/msk/event/test-session/',
                        'fetched_at': '2026-09-24T08:00:00Z', 'valid_until': '2026-09-25T08:00:00Z', 'data_mode': 'test'},
             'schedule': {'kind': 'fixed', 'windows_utc': [{'start_utc': epoch('2026-09-25T10:00:00Z'),
                                                          'end_utc': epoch('2026-09-25T11:00:00Z')}]},
             'duration': {'minutes': 60, 'basis': 'provider_session'}, 'age': {'minimum_age': 0},
             'price': {'expected_minor': 0, 'upper_minor': 0, 'basis': 'whole_party', 'estimate_kind': 'verified_admission'},
             'normalization_warnings': []}
    job['places'].append(event)
    for old in list(job['route_legs']):
        if old['from_id'] == 'museum-near' or old['to_id'] == 'museum-near':
            job['route_legs'].append({**old, 'from_id': event['id'] if old['from_id'] == 'museum-near' else old['from_id'],
                                    'to_id': event['id'] if old['to_id'] == 'museum-near' else old['to_id']})
    return activity, event


def solve_prepared(job):
    prepared = prepare_routes(job)
    assert prepared['status'] == 'AVAILABLE'
    planned = prepared['job']
    planned['route_legs'] = [{**pair, 'safe_minutes': 10, 'source': deepcopy(job['places'][0]['source'])}
                            for pair in prepared['pairs']]
    result = select_places(planned)
    validate_selection(planned, result)
    return planned, result


def test_selected_event_then_food_uses_real_routing_and_exact_session_without_fake_rubrics(job):
    _, event = selected_event(job)
    planned, result = solve_prepared(job)
    assert result['status'] == 'AVAILABLE'
    visits = result['days'][0]['visits']
    assert [v['place_id'] for v in visits] == [event['id'], 'cafe']
    assert (visits[0]['starts_at'], visits[0]['ends_at']) == (780, 840)
    assert visits[0]['event']['event_id'] == '99'
    assert visits[0]['event']['duration_basis'] == 'provider_session'
    assert visits[0]['source']['provider'] == 'kudago'
    assert 'rubric_ids' not in planned['places'][-1]
    checks = route_checks({'job': planned, 'result': result})['checks']
    assert checks[1]['departure_utc'] == epoch('2026-09-25T11:00:00Z')


def test_event_only_is_available_without_any_poi_or_category_leaf(job):
    _, event = selected_event(job, only=True)
    job['places'] = [event]
    job['catalog']['leaf_ids'] = []
    job['visit_policy']['by_category'] = {}
    _, result = solve_prepared(job)
    assert result['status'] == 'AVAILABLE'
    assert result['total_budget_upper_minor'] == 0


def test_fixed_session_rounds_outward_and_cannot_shift_or_shorten(job):
    _, event = selected_event(job, only=True)
    event['schedule']['windows_utc'][0]['start_utc'] += 30
    event['schedule']['windows_utc'][0]['end_utc'] += 10
    event['duration']['minutes'] = 61
    result = select_places(job)
    visit = result['days'][0]['visits'][0]
    assert (visit['starts_at'], visit['ends_at']) == (780, 841)
    shifted = deepcopy(result)
    shifted['days'][0]['visits'][0]['starts_at'] += 1
    shifted['days'][0]['visits'][0]['ends_at'] += 1
    with pytest.raises(ValueError):
        validate_selection(job, shifted)
    event['duration']['minutes'] = 60
    with pytest.raises(ValueError):
        select_places(job)


def test_visit_window_uses_explicit_duration_and_fits_whole_visit(job):
    activity, event = selected_event(job, only=True)
    activity['target']['visit_duration_minutes'] = 45
    event['schedule']['kind'] = 'visit_window'
    event['schedule']['windows_utc'][0]['start_utc'] += 30
    event['duration'] = {'minutes': 45, 'basis': 'user_estimate'}
    result = select_places(job)
    assert result['days'][0]['visits'][0]['starts_at'] >= 781
    assert result['days'][0]['visits'][0]['ends_at'] <= 840
    assert 'EVENT_VISIT_DURATION_ESTIMATED' in result['warnings']
    event['schedule']['windows_utc'][0]['end_utc'] = event['schedule']['windows_utc'][0]['start_utc'] + 30 * 60
    assert select_places(job)['status'] == 'UNAVAILABLE'


@pytest.mark.parametrize('change', ['missing', 'other_occurrence', 'stale', 'wrong_day', 'wrong_city'])
def test_selected_event_missing_or_changed_is_never_replaced_by_a_museum(job, change):
    _, event = selected_event(job, only=True)
    if change == 'missing':
        job['places'].remove(event)
    elif change == 'other_occurrence':
        job['intent']['days'][0]['activities'][0]['target']['occurrence_key'] = 'b' * 64
    elif change == 'stale':
        event['source']['valid_until'] = job['as_of']
    elif change == 'wrong_day':
        event['date'] = '2026-09-26'
    else:
        event['locality_id'] = 'another-city'
    result = select_places(job)
    assert result['status'] == 'UNAVAILABLE'
    assert result['days'][0]['visits'] == []
    assert result['days'][0]['missing_activity_ids'] == ['culture']
    assert any(code.startswith('EVENT_') for code in result['issues'])


def test_age_is_checked_per_candidate_and_unknown_poi_age_is_an_explicit_gap(job):
    _, event = selected_event(job)
    job['intent']['shared']['party'] = {'total': 2, 'child_ages': [7]}
    result = select_places(job)
    assert result['status'] == 'AVAILABLE'
    assert event['id'] in [v['place_id'] for v in result['days'][0]['visits']]
    assert any('AGE_ELIGIBILITY_UNVERIFIED' in v['warnings'] for v in result['days'][0]['visits'])
    event['age']['minimum_age'] = None
    result = select_places(job)
    assert result['status'] == 'LIMITED'
    assert event['id'] not in [v['place_id'] for v in result['days'][0]['visits']]
    assert 'AGE_ELIGIBILITY_DATA_REQUIRED' in result['issues']
    event['age']['minimum_age'] = 12
    result = select_places(job)
    assert any('AGE_RESTRICTION' in row['reasons'] for row in result['excluded'])


def test_paid_unknown_price_never_becomes_free_even_in_estimated_budget(job):
    _, event = selected_event(job, only=True)
    event['price'] = {'expected_minor': None, 'upper_minor': None, 'basis': 'unknown', 'estimate_kind': 'unknown'}
    for enforcement in ['strict', 'estimated']:
        job['intent']['shared']['budget'].update(enforcement=enforcement, price_basis_assumption='per_person')
        result = select_places(job)
        assert result['status'] == 'UNAVAILABLE'
        assert 'BUDGET_PRICE_DATA_REQUIRED' in result['issues']
    job['intent']['shared']['budget'] = {'kind': 'unlimited'}
    result = select_places(job)
    assert result['status'] == 'AVAILABLE'
    assert result['total_expected_cost_minor'] is None


def test_event_replacement_requires_explicit_selection_but_other_stop_keeps_event_pinned(job):
    _, event = selected_event(job)
    job['replacement'] = {'version': 'stop-replacement.v1',
        'target': {'day_id': 'd1', 'activity_id': 'culture', 'place_id': event['id']},
        'days': [{'day_id': 'd1', 'visits': [{'activity_id': 'culture', 'place_id': event['id']}, {'activity_id': 'food', 'place_id': 'cafe'}]}]}
    assert 'EVENT_EXPLICIT_SELECTION_REQUIRED' in select_places(job)['issues']
    job['replacement']['target'] = {'day_id': 'd1', 'activity_id': 'food', 'place_id': 'cafe'}
    cafe = deepcopy(job['places'][2]); cafe['id'] = 'cafe-alternative'; job['places'].append(cafe)
    _, result = solve_prepared(job)
    assert [v['place_id'] for v in result['days'][0]['visits']] == [event['id'], 'cafe-alternative']


def test_cli_combines_events_and_provider_batches_without_projecting_events_as_2gis(job):
    _, event = selected_event(job, only=True)
    job.pop('places')
    job['provider_batches'] = []
    job['event_candidates'] = [event]
    projected = project_batches(job)
    assert projected['places'] == [event]
    assert 'event_candidates' not in projected
    assert select_places(projected)['status'] == 'AVAILABLE'


def test_event_activity_rejects_poi_fields_and_unknown_target_branches(job):
    activity, _ = selected_event(job)
    activity['categories'] = {'state': 'matched', 'include_any': ['museum'], 'exclude': [], 'region_id': '32', 'catalog_version': 'test-catalog'}
    with pytest.raises(ValueError):
        select_places(job)
    activity.pop('categories')
    activity['target']['kind'] = 'unrecognized'
    with pytest.raises(ValueError):
        select_places(job)


def test_event_and_venue_sources_limit_validation_and_changed_coordinates_require_new_edges(job):
    _, event = selected_event(job, only=True)
    event['venue_source'] = {**event['source'], 'valid_until': '2026-09-24T09:05:00Z'}
    event['source']['valid_until'] = event['venue_source']['valid_until']
    result = select_places(job)
    assert result['status'] == 'AVAILABLE'
    assert result['days'][0]['visits'][0]['source']['valid_until'] == event['venue_source']['valid_until']
    stale = {**job, 'as_of': '2026-09-24T09:05:00Z'}
    with pytest.raises(ValueError): validate_selection(stale, result)
    event['point']['lat'] += 0.001
    assert select_places(job)['status'] == 'UNAVAILABLE'
    event['source']['valid_until'] = '2026-09-24T09:06:00Z'
    with pytest.raises(ValueError): select_places(job)


@pytest.mark.parametrize('day_date,begin,end', [
    ('2026-10-25', '2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z'),
    ('2027-03-28', '2027-03-28T00:30:00Z', '2027-03-28T01:30:00Z'),
])
def test_ambiguous_or_offset_changing_sessions_are_not_compressed_into_local_minutes(job, day_date, begin, end):
    _, event = selected_event(job, only=True)
    day = job['intent']['days'][0]; day['date'] = event['date'] = day_date
    day['window'] = {'start': '01:00', 'end': '05:00'}
    job['intent']['locality']['timezone'] = 'Europe/Berlin'
    event['schedule']['windows_utc'] = [{'start_utc': epoch(begin), 'end_utc': epoch(end)}]
    for leg in job['route_legs']: leg.update(date=day_date, window=deepcopy(day['window']))
    result = select_places(job)
    assert result['status'] == 'UNAVAILABLE'
    assert 'EVENT_LOCAL_TIME_UNSUPPORTED' in result['issues']


def test_impossible_hard_order_and_finish_cannot_move_the_event_or_erase_the_gap(job):
    _, event = selected_event(job)
    job['intent']['days'][0]['order'] = [['food', 'culture']]
    # First possible cafe visit lasts until 13:15 including travel+arrival buffer;
    # the fixed event starts at13:00, so covering both is impossible.
    job['visit_policy']['by_category']['cafe'] = 60
    result = select_places(job)
    assert result['status'] == 'LIMITED'
    assert len(result['days'][0]['missing_activity_ids']) == 1
    event_visits = [v for v in result['days'][0]['visits'] if v['place_id'] == event['id']]
    assert not event_visits or event_visits[0]['starts_at'] == 780
    job['intent']['days'][0]['activities'] = job['intent']['days'][0]['activities'][:1]
    job['intent']['days'][0]['order'] = []
    job['intent']['points']['destination'] = deepcopy(job['intent']['points']['origin'])
    job['route_legs'] = [leg for leg in job['route_legs'] if leg['to_id'] != '@destination']
    assert select_places(job)['status'] == 'UNAVAILABLE'


def test_event_unknown_hard_requirement_and_overlong_user_estimate_are_not_ignored(job):
    activity, event = selected_event(job, only=True)
    activity['requirements'] = [{'text': 'Пандус', 'strength': 'required'}]
    result = select_places(job)
    assert result['status'] == 'UNAVAILABLE'
    assert any('REQUIRED_FACT_UNKNOWN' in row['reasons'] for row in result['excluded'])
    activity['requirements'] = []
    activity['target']['visit_duration_minutes'] = 120
    event['schedule']['kind'] = 'visit_window'
    event['duration'] = {'minutes': 120, 'basis': 'user_estimate'}
    assert select_places(job)['status'] == 'UNAVAILABLE'


def test_canonical_event_cannot_be_downgraded_to_a_place_or_forge_binding(job):
    _, event = selected_event(job, only=True)
    event.pop('kind')
    with pytest.raises(ValueError): select_places(job)
    event['kind'] = 'event'; event['activity_id'] = 'food'
    with pytest.raises(ValueError): select_places(job)


def test_selected_event_json_reaches_real_cli_solver_and_malformed_input_is_not_echoed(job):
    _, event = selected_event(job, only=True)
    job.pop('places'); job['event_candidates'] = [event]; job['provider_batches'] = []
    runner = Path(__file__).resolve().parents[1] / 'run.py'
    def invoke():
        return subprocess.run([sys.executable, '-B', str(runner)], input=json.dumps(job),
                              capture_output=True, text=True, encoding='utf-8', timeout=20)
    success = invoke()
    assert success.returncode == 0
    assert json.loads(success.stdout)['days'][0]['visits'][0]['event']['event_id'] == '99'
    event['source']['unrecognized_secret'] = 'never-echo-this-field'
    failure = invoke()
    assert failure.returncode == 2
    assert json.loads(failure.stdout)['issues'] == ['INVALID_PLANNING_INPUT']
    assert 'never-echo-this-field' not in failure.stdout + failure.stderr


def test_event_and_food_keep_party_cost_and_whole_trip_budget_across_days(job):
    _, event = selected_event(job)
    job['intent']['shared']['party']['total'] = 2
    second_day = deepcopy(job['intent']['days'][0]); second_day.update(day_id='d2', date='2026-09-26')
    job['intent']['days'].append(second_day)
    second_event = deepcopy(event); second_event.update(day_id='d2', date=second_day['date'])
    second_event['id'] = event_candidate_id(second_event['event_ref'], 'd2', 'culture')
    second_event['schedule']['windows_utc'] = [{k: v + 86400 for k, v in row.items()} for row in event['schedule']['windows_utc']]
    job['places'].append(second_event)
    for place in job['places']:
        if place.get('opening_intervals'): place['opening_intervals']['2026-09-26'] = [[540, 1260]]
    _, result = solve_prepared(job)
    assert result['status'] == 'LIMITED'
    assert sum(len(day['visits']) for day in result['days']) == 3
    assert result['total_expected_cost_minor'] == 100000
    assert result['total_budget_upper_minor'] <= 150000
    assert sum('event' in visit for day in result['days'] for visit in day['visits']) == 2
