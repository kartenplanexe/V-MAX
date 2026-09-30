from test_selection import job
from vmax_planner.selection import select_places, validate_selection
from vmax_planner.routing import prepare_routes, route_checks

def pt(job):
    job['intent']['shared']['mobility'] = ['public_transport']
    job['intent']['shared']['budget'] = {'kind': 'unlimited'}
    for index, place in enumerate(job['places']):
        place['point']['lon'] += (index + 1) / 1000
    return job

def test_public_transport_minimum_graph_accounts_one_http_per_dated_pair(job):
    pt(job)
    job['routing_policy'] = {'max_routing_http_calls': 6}
    result = prepare_routes(job)
    assert result['status'] == 'NEEDS_INPUT'
    assert result['issues'] == ['ROUTING_SCOPE_TOO_LARGE']
    job['routing_policy']['max_routing_http_calls'] = 7
    result = prepare_routes(job)
    assert result['status'] == 'AVAILABLE'
    assert all(group['selected'] >= 1 for group in result['shortlist']['groups'])
    assert result['routing_budget']['http_calls'] == 7
    assert all(len(pair['sample_utc']) == 1 for pair in result['pairs'])

def test_public_transport_preserves_unknown_fare_and_emits_actual_departure_checks(job):
    pt(job)
    prepared = prepare_routes(job)
    assert prepared['status'] == 'AVAILABLE'
    planned = prepared['job']
    planned['route_legs'] = [{**pair, 'safe_minutes': 20, 'source': job['places'][0]['source']}
                             for pair in prepared['pairs']]
    result = select_places(planned)
    assert result['status'] == 'AVAILABLE'
    assert result['total_expected_cost_minor'] is None
    validate_selection(planned, result)
    checks = route_checks({'job': planned, 'result': result})['checks']
    assert all(row['mode'] == 'public_transport' for row in checks)
    assert checks[1]['departure_utc'] > checks[0]['departure_utc']

    planned['intent']['shared']['budget'] = {'kind': 'limit', 'amount_rub': 5000, 'basis': 'whole_party', 'period': 'whole_trip'}
    assert prepare_routes({k: v for k, v in planned.items() if k != 'candidate_pool'})['issues'] == ['TRANSPORT_COST_POLICY_REQUIRED']
