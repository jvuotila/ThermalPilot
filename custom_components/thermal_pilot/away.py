"""Timed and zone-based heating setbacks, separate from source learning."""
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

from .model import curve_hours, effective_loss, number, response_lag, response_step, stamp, thermostat_state


def person_count(state: Any) -> int | None:
    """Unknown/unavailable zones must never be treated as an empty home."""
    value = number(state.state) if state is not None else None
    if value is None or value < 0 or not value.is_integer():
        return None
    return int(value)


def room_exempt(room: dict[str, Any], settings: dict[str, Any]) -> bool:
    """A shared pump cannot give one member a separate away target."""
    if room.get('is_garage') or room.get('away_exempt'):
        return True
    zone_id = room.get('heating_zone_id')
    zone = next((item for item in settings.get('heating_zones', [])
                 if item['id'] == zone_id and item.get('heating_enabled', True)
                 and item.get('source_type', 'air_to_air') == 'air_to_air'), None)
    if zone is None:
        return False
    return any(member.get('away_exempt') for member in settings.get('rooms', [])
               if member.get('heating_zone_id') == zone_id)


def parse_schedule(start: str, end: str, zone: str, now: datetime) -> dict[str, float]:
    """Interpret wall-clock inputs in HA's zone, including DST validation.

    A browser may be travelling in a different zone. Do not use its UTC offset.
    Reject ambiguous autumn times rather than silently selecting the wrong hour.
    """
    moments = []
    local_zone = ZoneInfo(zone)
    for value in (start, end):
        try:
            local = datetime.fromisoformat(value)
        except (TypeError, ValueError):
            raise ValueError('Choose valid start and end dates and times.') from None
        if local.tzinfo is not None:
            raise ValueError('Use local dates and times in the Home Assistant time zone.')
        first = local.replace(tzinfo=local_zone, fold=0)
        second = local.replace(tzinfo=local_zone, fold=1)
        restored = first.astimezone(timezone.utc).astimezone(local_zone).replace(tzinfo=None)
        if restored != local or first.utcoffset() != second.utcoffset():
            raise ValueError('This local time changes with daylight saving. Choose another time.')
        moments.append(first.timestamp())
    if moments[1] <= moments[0] or moments[1] <= now.timestamp():
        raise ValueError('The end must be after the start and in the future.')
    return {'start': moments[0], 'end': moments[1]}


def update(previous: dict[str, Any], settings: dict[str, Any], count: int | None,
           now: float) -> tuple[dict[str, Any], dict[str, Any]]:
    """Calendar remains available independently of automatic detection.

    A future booking made while home waits for departure if a zone is selected.
    Once an active booking has started, a detected return cancels that booking,
    so it cannot reactivate when the user next leaves for shopping or work.
    """
    state = deepcopy(previous)
    signature = [settings['away_zone'], settings['away_automatic'], settings['away_delay_hours']]
    if state.get('signature') != signature:
        state.update(signature=signature, empty_since=None, last_count=None)
    previous_count = state.get('last_count')
    if count == 0 and settings['away_zone'] and settings['away_automatic']:
        if state.get('empty_since') is None or state['empty_since'] > now:
            state['empty_since'] = now
    else:
        state['empty_since'] = None
    state['last_count'] = count
    schedule = state.get('schedule')
    manual_active = False
    if schedule and now >= schedule['end']:
        state.pop('schedule', None)
        state.pop('manual_started', None)
        schedule = None
    if schedule and schedule['start'] <= now < schedule['end']:
        if settings['away_automatic'] and count is not None and count > 0:
            if state.get('manual_started') or previous_count == 0:
                state.pop('schedule', None)
                state.pop('manual_started', None)
                state['last_cancel_reason'] = 'Returned home'
                schedule = None
        else:
            manual_active = True
            state['manual_started'] = True
    empty_since = state.get('empty_since')
    automatic_start = None
    if settings['away_automatic'] and empty_since is not None:
        automatic_start = empty_since + settings['away_delay_hours'] * 3600
    automatic_active = automatic_start is not None and now >= automatic_start
    active = manual_active or automatic_active
    source = 'calendar' if manual_active else 'automatic' if automatic_active else None
    status = {'active': active, 'source': source, 'temperature': settings['away_temperature'], 'cooling_temperature': settings['away_cooling_temperature'],
              'schedule': deepcopy(schedule), 'person_count': count,
              'automatic_start': automatic_start, 'empty_since': empty_since,
              'zone': settings['away_zone'], 'automatic_enabled': settings['away_automatic'], 'warning': None}
    if settings['away_automatic'] and settings['away_zone'] and count is None:
        status['warning'] = 'Home zone person count is unavailable; automatic away temperatures are paused.'
    return state, status


def temperature_at(status: dict[str, Any], moment: float) -> float | None:
    """Only known calendar/delay boundaries are projected; no return is invented."""
    if status.get('automatic_enabled') and status.get('zone') and status.get('person_count') not in (None, 0):
        return None
    schedule = status.get('schedule')
    if schedule and schedule['start'] <= moment < schedule['end']:
        return status['temperature']
    automatic_start = status.get('automatic_start')
    if automatic_start is not None and moment >= automatic_start:
        return status['temperature']
    return None


def overlay_plan(original: dict[str, Any] | None, room: dict[str, Any], model: dict[str, Any],
                 slots: list[dict[str, Any]], status: dict[str, Any], temperature: float,
                 now: datetime, water_factor: float = 1, wind: float | None = None) -> dict[str, Any] | None:
    """Forecast actual lowered targets instead of showing the old comfort boost.

    Keep the normal tariff choices outside the absence, but recompute the room
    response through the whole horizon. Unknown gains remain model estimates;
    these predictions never become observations or source-learning evidence.
    """
    if not slots or not any(temperature_at(status, slot['start'].timestamp()) is not None for slot in slots):
        return original
    rows = []
    response = model.get('response', 0)
    loss = effective_loss(model, wind)
    for slot in slots:
        start = max(now, slot['start'])
        if slot['end'] <= start:
            continue
        # Split a price interval at calendar boundaries so commands are exact,
        # even when an absence starts at 18:07 rather than a quarter hour.
        boundaries = [start, slot['end']]
        schedule = status.get('schedule') or {}
        for value in (schedule.get('start'), schedule.get('end'), status.get('automatic_start')):
            if value is not None and start.timestamp() < value < slot['end'].timestamp():
                boundaries.append(datetime.fromtimestamp(value, now.tzinfo))
        boundaries = sorted(set(boundaries))
        for begin, finish in zip(boundaries, boundaries[1:]):
            away = temperature_at(status, begin.timestamp())
            requested = thermostat_state(original, begin) if original else {'setpoint': room['baseline'], 'mode': 'normal'}
            target = requested['setpoint']
            mode = requested['mode']
            if away is not None:
                target = min(room['baseline'], away)
                mode = 'away'
            hours = (finish - begin).total_seconds() / 3600
            demand = temperature < target
            response, average = response_step(response, float(demand), hours, response_lag(room, model))
            temperature += hours * (loss * (slot['outdoor'] - temperature)
                + model['gain'] * water_factor * average + model.get('base_gain', 0))
            rows.append({'start': begin.isoformat(), 'end': finish.isoformat(), 'price': slot.get('price'),
                'outdoor': slot['outdoor'], 'temperature': round(temperature, 3), 'setpoint': target,
                'mode': mode, 'heat': mode == 'boost', 'predicted_demand': demand,
                'reduction_available': True})
    if not rows:
        return original
    commands = []
    windows = []
    for row in rows:
        if not commands or commands[-1]['mode'] != row['mode'] or commands[-1]['setpoint'] != row['setpoint']:
            action = 'lower' if row['mode'] in ('away', 'reduced') else 'raise' if row['mode'] == 'boost' else 'restore'
            commands.append({'time': row['start'], 'mode': row['mode'], 'setpoint': row['setpoint'], 'action': action})
        if row['heat']:
            if windows and windows[-1]['end'] == row['start']:
                windows[-1]['end'] = row['end']
            else:
                windows.append({'start': row['start'], 'end': row['end']})
    baseline = room['baseline']
    result = {**(original or {}), 'slots': rows, 'commands': commands, 'thermostat_windows': windows,
        'sessions': deepcopy(windows), 'default_mode': rows[0]['mode'],
        'normal_setpoint': (original or {}).get('normal_setpoint', baseline),
        'boosted_setpoint': (original or {}).get('boosted_setpoint', min(room['maximum'], baseline + room['boost'])),
        'reduced_setpoint': (original or {}).get('reduced_setpoint', max(room['minimum'], baseline + room['setback'])),
        'away_setpoint': min(baseline, status['temperature']), 'away_plan': True,
        'scheduled_heat': rows[0]['heat'], 'scheduled_mode': rows[0]['mode'], 'reduction_available': True,
        'forecast_minimum': min(row['temperature'] for row in rows),
        'forecast_maximum': max(row['temperature'] for row in rows),
        'curve_hours': round(curve_hours(room, min(slot['outdoor'] for slot in slots)), 1),
        'reason': 'Away temperature schedule',
        'comfort_risk': any(row['temperature'] < (min(room['minimum'], status['temperature'])
            if row['mode'] == 'away' else room['minimum']) for row in rows)}
    demand_hours = 0
    boost_hours = 0
    for row in rows:
        hours = (stamp(row['end']) - stamp(row['start'])).total_seconds() / 3600
        if row['predicted_demand']:
            demand_hours += hours
        if row['heat']:
            boost_hours += hours
    result['predicted_demand_hours'] = round(demand_hours, 2)
    result['suggested_heating_hours'] = round(boost_hours, 2)
    result['comfort_floor'] = room['minimum']
    result['comfort_target'] = baseline
    if status.get('active'):
        result['comfort_floor'] = min(room['minimum'], status['temperature'])
        result['comfort_target'] = min(baseline, status['temperature'])
    if result['comfort_risk']:
        result['reason'] = 'Temperature limit risk: review model assumptions and heating capacity.'
    result.update(thermostat_state(result, now))
    return result
