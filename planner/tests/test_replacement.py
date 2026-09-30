from copy import deepcopy

import pytest

from test_selection import job
from vmax_planner.selection import select_places, validate_selection
from vmax_planner.routing import prepare_routes

def replacement(job):
    job['replacement'] = {'version': 'stop-replacement.v1',
        'target': {'day_id': 'd1', 'activity_id': 'culture', 'place_id': 'museum-near'},
        'days': [{'day_id': 'd1', 'visits': [
            {'activity_id': 'culture', 'place_id': 'museum-near'},
            {'activity_id': 'food', 'place_id': 'cafe'}]}]}
    return job

def test_replaces_only_target_and_validator_enforces_roster(job):
    original = select_places(job)
    changed = replacement(job)
    result = select_places(changed)
    assert result['status'] == 'AVAILABLE'
    assert [v['place_id'] for v in result['days'][0]['visits']] == ['museum-far', 'cafe']
    validate_selection(changed, result)
    with pytest.raises(ValueError):
        validate_selection(changed, original)

def test_missing_fresh_fixed_place_does_not_silently_drop_activity(job):
    replacement(job)
    job['places'] = [p for p in job['places'] if p['id'] != 'cafe']
    result = select_places(job)
    assert result['status'] == 'NEEDS_INPUT'
    assert 'REPLACEMENT_CURRENT_PLACE_UNAVAILABLE' in result['issues']

def test_replacement_cannot_break_budget_or_window(job):
    replacement(job)
    job['places'][1]['price']['upper_minor'] = 200000
    assert select_places(job)['status'] not in ['AVAILABLE', 'LIMITED']

def test_replacement_cannot_remove_required_finish_or_overrun_window(job):
    replacement(job)
    job['intent']['points']['destination'] = deepcopy(job['intent']['points']['origin'])
    job['route_legs'] = [r for r in job['route_legs'] if r['to_id'] != '@destination']
    assert select_places(job)['status'] not in ['AVAILABLE', 'LIMITED']

def test_replacement_uses_fresh_schedule_and_exact_visit_duration(job):
    replacement(job)
    job['places'][1]['opening_intervals']['2026-09-25'] = [[12 * 60, 12 * 60 + 20]]
    result = select_places(job)
    assert result['status'] == 'NEEDS_INPUT'
    assert 'REPLACEMENT_NO_ELIGIBLE_ALTERNATIVE' in result['issues']

def test_replacement_preserves_other_days_and_all_original_constraints(job):
    replacement(job)
    day = deepcopy(job['intent']['days'][0]); day['day_id'] = 'd2'; day['date'] = '2026-09-26'
    job['intent']['days'].append(day)
    job['replacement']['days'].append({'day_id': 'd2', 'visits': [
        {'activity_id': 'culture', 'place_id': 'museum-near'}, {'activity_id': 'food', 'place_id': 'cafe'}]})
    for place in job['places']:
        place['opening_intervals']['2026-09-26'] = [[540, 1260]]
    job['route_legs'] += [dict(r, day_id='d2', date='2026-09-26') for r in job['route_legs']]

    assert select_places(job)['status'] not in ['AVAILABLE', 'LIMITED']
    job['intent']['shared']['budget']['amount_rub'] = 2500
    result = select_places(job)
    assert result['status'] == 'AVAILABLE'
    assert [v['place_id'] for v in result['days'][1]['visits']] == ['museum-near', 'cafe']
    validate_selection(job, result)

def test_route_walk_pins_all_other_slots_and_order(job):
    replacement(job)
    day = job['intent']['days'][0]
    day['activities'] = day['activities'][:1]
    day['order'] = []
    job['visit_policy']['by_activity'] = {'culture': 25}
    job['visit_policy']['max_stops_by_activity'] = {'culture': 8}
    job['replacement']['days'][0]['visits'] = [
        {'activity_id': 'culture', 'place_id': 'museum-near'},
        {'activity_id': 'culture', 'place_id': 'museum-far'}]
    extra = deepcopy(job['places'][0]); extra['id'] = 'museum-new'
    job['places'].append(extra)
    prepared = prepare_routes(job)
    assert prepared['status'] == 'AVAILABLE'
    assert {(x['from_id'], x['to_id']) for x in prepared['pairs']} == {
        ('@origin', 'museum-new'), ('museum-new', 'museum-far')}
    new_job = prepared['job']
    source = extra['source']
    new_job['route_legs'] = [{**p, 'safe_minutes': 10, 'source': source} for p in prepared['pairs']]
    result = select_places(new_job)
    assert [v['place_id'] for v in result['days'][0]['visits']] == ['museum-new', 'museum-far']
    validate_selection(new_job, result)
