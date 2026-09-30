from test_routing_budget import candidates_job
from vmax_planner.routing import prepare_routes, recover_routes
from vmax_planner.selection import select_places, validate_selection

def replay(job):
    job['routing_policy'] = {'strategy': 'progressive'}
    prepared = prepare_routes(job)
    assert prepared['pairs'] == []
    measured, attempts, purchases = prepared['job'], [], 0
    for _ in range(30):
        result = select_places(measured)
        validate_selection(measured, result)
        next = recover_routes({'job': measured, 'result': result, 'attempted': attempts})
        if next['status'] == 'DONE':
            return result, purchases
        proposal = next['proposal']
        attempts.append(proposal['key'])
        purchases += len(proposal['pairs'])
        measured['route_legs'].extend(pair | {'safe_minutes': 5, 'source': job['places'][0]['source']}
                                      for pair in proposal['pairs'])
        measured['candidate_pool'].append(proposal['candidate'])
    raise AssertionError('non-terminating search')

def test_progressive_walk_can_use_eight_places_without_quadratic_matrix():
    result, purchases = replay(candidates_job(walk=True))
    assert len(result['days'][0]['visits']) == 8
    assert purchases == 8

def test_progressive_prioritizes_food_before_extra_walk_and_keeps_hard_order():
    job = candidates_job(activities=2, walk=True)
    day = job['intent']['days'][0]
    day['order'] = [['activity-0', 'activity-1']]
    result, purchases = replay(job)
    assert result['status'] == 'AVAILABLE'
    assert result['days'][0]['visits'][-1]['activity_id'] == 'activity-1'
    assert purchases < 30

def test_impossible_window_does_not_purchase_impossible_insertions():
    job = candidates_job(activities=2, walk=True)
    job['intent']['days'][0]['window']['end'] = '16:20'
    result, purchases = replay(job)
    assert result['status'] == 'UNAVAILABLE'
    assert purchases == 0
