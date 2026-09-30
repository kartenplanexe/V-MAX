from datetime import date, datetime, timezone as utc_timezone
import hashlib
import json
import math
import re
from urllib.parse import urlsplit

def _int(value, minimum, maximum):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError('invalid event integer')
    return value

def _text(value, maximum=128):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError('invalid event string')
    return value

def _keys(value, required, optional=()):
    if not isinstance(value, dict) or not set(required) <= set(value) or set(value) - set(required) - set(optional):
        raise ValueError('invalid event object fields')

def _ref(value):
    _keys(value, ('provider', 'event_id', 'occurrence_key'))
    if value['provider'] != 'kudago' or not re.fullmatch(r'[1-9]\d{0,15}', str(value['event_id'])) or \
            not isinstance(value['event_id'], str) or int(value['event_id']) > 9007199254740991 or \
            not isinstance(value['occurrence_key'], str) or not re.fullmatch(r'[a-f0-9]{64}', value['occurrence_key']):
        raise ValueError('invalid event reference')

def event_candidate_id(ref, day_id, activity_id):
    payload = json.dumps([ref['event_id'], ref['occurrence_key'], day_id, activity_id], ensure_ascii=False, separators=(',', ':'))
    return 'event:kudago:' + hashlib.sha256(payload.encode('utf-8')).hexdigest()

def event_target(activity):
    if 'target' not in activity:
        if activity.get('intent_kind') == 'event_visit':
            raise ValueError('selected event target required')
        return None
    _keys(activity, ('id', 'label', 'requirements', 'intent_kind', 'target'))
    target = activity['target']
    _keys(target, ('kind', 'provider', 'event_id', 'occurrence_key'), ('visit_duration_minutes',))
    if target['kind'] != 'event' or activity['intent_kind'] != 'event_visit':
        raise ValueError('unknown activity target')
    _ref({k: target[k] for k in ('provider', 'event_id', 'occurrence_key')})
    if 'visit_duration_minutes' in target:
        _int(target['visit_duration_minutes'], 5, 720)
    return target

def _source(source):
    _keys(source, ('provider', 'url', 'fetched_at', 'valid_until', 'data_mode'))
    if source['provider'] != 'kudago' or source['data_mode'] not in ('live', 'test'):
        raise ValueError('invalid event source')
    url = urlsplit(_text(source['url'], 2048))
    if url.scheme != 'https' or not (url.hostname == 'kudago.com' or (url.hostname or '').endswith('.kudago.com')) or \
            url.username or url.password or url.port or url.fragment or url.query:
        raise ValueError('invalid event source URL')
    times = [datetime.fromisoformat(_text(source[k]).replace('Z', '+00:00')) for k in ('fetched_at', 'valid_until')]
    if any(value.tzinfo is None for value in times) or times[1] <= times[0]:
        raise ValueError('invalid event source dates')
    return times

def validate_event_candidate(value):
    _keys(value, ('kind', 'id', 'name', 'location_label', 'locality_id', 'region_id', 'date', 'event_ref',
                  'activity_id', 'day_id', 'point', 'source', 'schedule', 'duration', 'age', 'price', 'normalization_warnings'), ('venue_source',))
    if value['kind'] != 'event': raise ValueError('event candidate required')
    _ref(value['event_ref'])
    for field in ('locality_id', 'region_id', 'day_id', 'activity_id'): _text(value[field])
    _text(value['name'], 500)
    if value['location_label'] is not None and (not isinstance(value['location_label'], str) or len(value['location_label']) > 1000):
        raise ValueError('invalid event location label')
    if date.fromisoformat(value['date']).isoformat() != value['date']: raise ValueError('invalid event date')
    ref = value['event_ref']
    if value['id'] != event_candidate_id(ref, value['day_id'], value['activity_id']):
        raise ValueError('event identity does not match its binding')
    _keys(value['point'], ('lat', 'lon'))
    for field, bound in (('lat', 90), ('lon', 180)):
        number = value['point'][field]
        if type(number) not in (int, float) or not math.isfinite(number) or not -bound <= number <= bound:
            raise ValueError('invalid event point')
    source_times = _source(value['source'])
    if 'venue_source' in value and source_times[1] > _source(value['venue_source'])[1]:
        raise ValueError('event lifetime exceeds its venue source')
    schedule = value['schedule']
    _keys(schedule, ('kind', 'windows_utc'))
    if schedule['kind'] not in ('fixed', 'visit_window') or not isinstance(schedule['windows_utc'], list) or \
            not 1 <= len(schedule['windows_utc']) <= (1 if schedule['kind'] == 'fixed' else 16):
        raise ValueError('invalid event schedule')
    for window in schedule['windows_utc']:
        _keys(window, ('start_utc', 'end_utc'))
        start, end = (_int(window[k], 0, 253402300799) for k in ('start_utc', 'end_utc'))
        if end <= start: raise ValueError('empty event interval')
    _keys(value['duration'], ('minutes', 'basis'))
    _int(value['duration']['minutes'], 1, 1440)
    if value['duration']['basis'] != ('provider_session' if schedule['kind'] == 'fixed' else 'user_estimate'):
        raise ValueError('event duration basis conflicts with schedule')
    _keys(value['age'], ('minimum_age',))
    if value['age']['minimum_age'] is not None: _int(value['age']['minimum_age'], 0, 18)
    _keys(value['price'], ('expected_minor', 'upper_minor', 'basis', 'estimate_kind'))
    price = value['price']
    paid = price['estimate_kind'] == 'advertised_admission' and price['basis'] == 'per_person' and \
        type(price['upper_minor']) is int and 0 < price['upper_minor'] <= 100_000_000 and \
        type(price['expected_minor']) is int and price['expected_minor'] == price['upper_minor']
    if not (price == {'expected_minor': 0, 'upper_minor': 0, 'basis': 'whole_party', 'estimate_kind': 'verified_admission'} or
            price == {'expected_minor': None, 'upper_minor': None, 'basis': 'unknown', 'estimate_kind': 'unknown'} or paid):
        raise ValueError('event price does not match admission evidence')

    if any(type(price[k]) is bool for k in ('expected_minor', 'upper_minor')): raise ValueError('invalid event price')
    if not isinstance(value['normalization_warnings'], list) or len(value['normalization_warnings']) > 30 or \
            any(not isinstance(w, str) or len(w) > 80 for w in value['normalization_warnings']):
        raise ValueError('invalid event warnings')

def _local(epoch, timezone):
    try: result = datetime.fromtimestamp(epoch, utc_timezone.utc).astimezone(timezone)
    except (OverflowError, OSError, ValueError) as error: raise ValueError('unrepresentable event time') from error
    naive = result.replace(tzinfo=None)
    matches = {naive.replace(tzinfo=timezone, fold=fold).timestamp() for fold in (0, 1)
               if naive.replace(tzinfo=timezone, fold=fold).astimezone(utc_timezone.utc).astimezone(timezone).replace(tzinfo=None) == naive}
    return result, len(matches) == 1

def event_window(candidate, target, day, locality, timezone, start, end):

    reasons, warnings, windows = [], ['EVENT_BOOKING_NOT_VERIFIED'], []
    ref = candidate['event_ref']
    if any(ref[k] != target[k] for k in ref): reasons.append('EVENT_SELECTION_CHANGED')
    if candidate['day_id'] != day['day_id'] or candidate['date'] != day['date']: reasons.append('EVENT_DAY_MISMATCH')
    if candidate['locality_id'] != locality['id']: reasons.append('EVENT_LOCALITY_MISMATCH')
    duration = candidate['duration']['minutes']
    fixed = candidate['schedule']['kind'] == 'fixed'
    if fixed and 'visit_duration_minutes' in target or not fixed and target.get('visit_duration_minutes') != duration:
        reasons.append('EVENT_DURATION_CONFIRMATION_REQUIRED')
    if not fixed: warnings.append('EVENT_VISIT_DURATION_ESTIMATED')
    current_date = date.fromisoformat(day['date'])
    for interval in candidate['schedule']['windows_utc']:
        begin, finish = interval['start_utc'], interval['end_utc']
        if fixed and duration != (finish + 59) // 60 - begin // 60:
            raise ValueError('fixed session cannot be shortened')
        a, known_a = _local(begin, timezone)
        b, known_b = _local(finish, timezone)
        if not known_a or not known_b or a.utcoffset() != b.utcoffset():
            reasons.append('EVENT_LOCAL_TIME_UNSUPPORTED'); continue
        low = (a.date() - current_date).days * 1440 + a.hour * 60 + a.minute
        high = (b.date() - current_date).days * 1440 + b.hour * 60 + b.minute
        if fixed:
            high += int(b.second != 0)
            if high - low != duration: reasons.append('EVENT_LOCAL_TIME_UNSUPPORTED'); continue
            if start <= low and high <= end: windows.append((low, low))
        else:
            low += int(a.second != 0)
            opening, closing = max(start, low), min(end, high) - duration
            if opening <= closing: windows.append((opening, closing))
    if not windows: reasons.append('EVENT_NO_VISIT_WINDOW')
    return duration, windows, reasons, warnings

def event_display(candidate):
    if candidate.get('kind') != 'event': return {}
    value = {**candidate['event_ref'], 'schedule_kind': candidate['schedule']['kind'],
             'duration_basis': candidate['duration']['basis'], 'minimum_age': candidate['age']['minimum_age']}
    if candidate['schedule']['kind'] == 'fixed':
        window = candidate['schedule']['windows_utc'][0]
        value.update(official_start_utc=window['start_utc'], official_end_utc=window['end_utc'])
    return {'event': value}
