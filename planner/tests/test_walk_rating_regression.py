from test_routing_budget import candidates_job
from vmax_planner.routing import prepare_routes
from vmax_planner.selection import select_places, validate_selection


def test_small_differences_between_good_ratings_do_not_end_a_six_hour_walk_after_two_stops():
    job = candidates_job(1, 8, walk=True)
    for i, place in enumerate(job['places']):
        place['reviews'] = {'rating': 4.1 + i / 10, 'count': 100}
    prepared = prepare_routes(job)
    measured = prepared['job'] | {'route_legs': [pair | {'safe_minutes': 5, 'source': job['places'][0]['source']}
                                               for pair in prepared['pairs']]}
    result = select_places(measured)
    validate_selection(measured, result)
    assert len(result['days'][0]['visits']) == 8
