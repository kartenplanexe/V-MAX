from copy import deepcopy

from test_routing_budget import candidates_job
from vmax_planner.routing import prepare_routes, recover_routes
from vmax_planner.selection import select_places, validate_selection

def broken_job(*, destination=False):
    job = candidates_job(activities=2, candidates=25)
    job['intent']['days'][0]['order'] = [['activity-0', 'activity-1']]
    if destination:
        job['intent']['points']['destination'] = dict(job['intent']['points']['origin'])
    prepared = prepare_routes(job)
    blocked = {row['place_id'] for row in prepared['job']['candidate_pool'] if row['activity_id'] == 'activity-1'}
    legs = [pair | {'safe_minutes': 5, 'source': job['places'][0]['source']}
            for pair in prepared['pairs'] if pair['to_id'] not in blocked]
    narrowed = prepared['job'] | {'route_legs': legs}
    return prepared, narrowed, select_places(narrowed)

def apply_proposal(job, proposal):
    return job | {'candidate_pool': job['candidate_pool'] + [proposal['candidate']],
                  'route_legs': job['route_legs'] + [pair | {'safe_minutes': 5, 'source': job['places'][0]['source']}
                                                   for pair in proposal['pairs']]}

def test_recovers_ordered_activity_with_one_connector_inside_default_budget():
    prepared, job, result = broken_job()
    assert result['status'] == 'LIMITED'
    recovery = recover_routes({'job': job, 'result': result, 'attempted': []})
    assert recovery['status'] == 'AVAILABLE'
    proposal = recovery['proposal']
    assert proposal['candidate']['activity_id'] == 'activity-1'
    assert len(proposal['pairs']) == 1
    assert proposal['pairs'][0]['from_id'] == result['days'][0]['visits'][-1]['place_id']
    assert len(prepared['pairs']) + len(proposal['pairs']) + 2 * recovery['maximum_selected_legs'] <= 200
    expanded = apply_proposal(job, proposal)
    complete = select_places(expanded)
    assert complete['status'] == 'AVAILABLE'
    assert complete['days'][0]['missing_activity_ids'] == []
    validate_selection(expanded, complete)
    assert recover_routes({'job': expanded, 'result': complete, 'attempted': []})['stop_reason'] == 'COVERAGE_COMPLETE'

def test_recovery_requires_the_explicit_finish_leg_and_keeps_order():
    _, job, result = broken_job(destination=True)
    recovery = recover_routes({'job': job, 'result': result, 'attempted': []})
    pairs = recovery['proposal']['pairs']
    assert len(pairs) == 2
    assert pairs[-1]['to_id'] == '@destination'
    assert pairs[0]['from_id'] == result['days'][0]['visits'][-1]['place_id']
    expanded = apply_proposal(job, recovery['proposal'])
    complete = select_places(expanded)
    validate_selection(expanded, complete)
    assert [v['activity_id'] for v in complete['days'][0]['visits']] == ['activity-0', 'activity-1']

def test_attempted_insertions_are_not_repeated_and_order_is_deterministic():
    _, job, result = broken_job()
    first = recover_routes({'job': job, 'result': result, 'attempted': []})
    shuffled = deepcopy(job)
    shuffled['places'].reverse()
    assert recover_routes({'job': shuffled, 'result': result, 'attempted': []}) == first
    second = recover_routes({'job': job, 'result': result, 'attempted': [first['proposal']['key']]})
    assert second['proposal']['key'] != first['proposal']['key']
    assert second['proposal']['candidate'] != first['proposal']['candidate']

def test_recovery_does_not_reintroduce_ineligible_places_or_relax_time():
    _, job, result = broken_job()
    selected = {row['place_id'] for row in job['candidate_pool']}
    for place in job['places']:
        if place['id'] not in selected:
            place['opening_intervals'] = {}
    result = select_places(job)
    recovery = recover_routes({'job': job, 'result': result, 'attempted': []})
    assert recovery['stop_reason'] == 'ELIGIBLE_POOL_EXHAUSTED'
    assert result['days'][0]['missing_activity_ids'] == ['activity-1']

def test_recovery_honors_an_explicit_operator_candidate_cap():
    _, job, result = broken_job()
    job['routing_policy'] = {'candidates_per_activity': 13}
    recovery = recover_routes({'job': job, 'result': result, 'attempted': []})
    assert recovery['stop_reason'] == 'SOLVER_SCOPE_LIMIT'
