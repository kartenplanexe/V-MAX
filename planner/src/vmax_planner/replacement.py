def roster(job, days):
    value = job.get('replacement')
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != {'version', 'target', 'days'} or value['version'] != 'stop-replacement.v1':
        raise ValueError('invalid replacement contract')
    target = value['target']
    if not isinstance(target, dict) or set(target) != {'day_id', 'activity_id', 'place_id'}:
        raise ValueError('invalid replacement target')
    rows = value['days']
    if not isinstance(rows, list) or len(rows) != len(days):
        raise ValueError('replacement day mismatch')
    result, found, total = {}, 0, 0
    for row in rows:
        if not isinstance(row, dict) or set(row) != {'day_id', 'visits'} or row['day_id'] in result:
            raise ValueError('invalid replacement day')
        day = next((d for d in days if d['day_id'] == row['day_id']), None)
        if day is None or not isinstance(row['visits'], list):
            raise ValueError('unknown replacement day')
        seen, slots = set(), []
        for visit in row['visits']:
            if not isinstance(visit, dict) or set(visit) != {'activity_id', 'place_id'} or \
                    visit['activity_id'] not in {a['id'] for a in day['activities']} or \
                    not isinstance(visit['place_id'], str) or not visit['place_id'] or \
                    visit['place_id'].startswith('@') or visit['place_id'] in seen:
                raise ValueError('invalid replacement visit')
            seen.add(visit['place_id'])
            changing = dict(day_id=row['day_id'], **visit) == target
            found += changing
            slots.append({**visit, 'replacing': changing})
        total += len(slots)
        result[row['day_id']] = slots
    if found != 1 or total > 120:
        raise ValueError('replacement target must occur once')
    return result

def slot_index(slots, activity_id, place_id):
    for index, slot in enumerate(slots):
        if slot['activity_id'] != activity_id:
            continue
        if not slot['replacing'] and slot['place_id'] == place_id:
            return index
        if slot['replacing'] and place_id not in {s['place_id'] for s in slots}:
            return index
    return None

def filter_options(rows, options):
    if rows is None:
        return options, []
    options = [o for o in options if slot_index(rows[o.day_id], o.activity_id, o.place_id) is not None]
    issues = []
    for did, slots in rows.items():
        for i, slot in enumerate(slots):
            if not any(o.day_id == did and slot_index(slots, o.activity_id, o.place_id) == i for o in options):
                issues.append('REPLACEMENT_NO_ELIGIBLE_ALTERNATIVE' if slot['replacing'] else 'REPLACEMENT_CURRENT_PLACE_UNAVAILABLE')
    return options, issues

def validate_roster(rows, result):
    if rows is None:
        return
    for day in result['days']:
        slots = rows[day['day_id']]
        actual = [slot_index(slots, v['activity_id'], v['place_id']) for v in day['visits']]
        if actual != list(range(len(slots))):
            raise ValueError('replacement roster/order violation')
