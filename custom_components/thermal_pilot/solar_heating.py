"""Production-triggered heat requests; independent of tariffs and passive solar gain.

The production threshold is a user policy, not a measurement of spare household
power. Minimum runs can therefore consume grid electricity after production drops.
"""
from copy import deepcopy
from datetime import datetime
from typing import Any

from .model import number

SOLAR_THRESHOLD_SECONDS = 300
SOLAR_SENSOR_MAX_AGE = 900


def production_kw(state: Any, now: datetime) -> float | None:
    """Read instantaneous production, never daily energy or an unknown unit."""
    if state is None or state.state in ('unknown', 'unavailable'):
        return None
    value = number(state.state)
    unit = str(state.attributes.get('unit_of_measurement', '')).strip().lower()
    if value is None or value < 0 or unit not in ('w', 'kw'):
        return None
    reported = getattr(state, 'last_reported', None) or getattr(state, 'last_updated', None)
    if reported is not None:
        age = (now - reported).total_seconds()
        if age < 0 or age > SOLAR_SENSOR_MAX_AGE:
            return None
    return value / 1000 if unit == 'w' else value


def update_sessions(previous: dict[str, Any], settings: dict[str, Any],
                    power: float | None, rooms: dict[str, dict[str, Any]],
                    now: float, enabled: bool) -> dict[str, Any]:
    """Apply hysteresis and individual minimum requests without extending clocks.

    Rooms passed by the coordinator have valid inputs and respect manual, season,
    door and temperature protections. Removing a room cancels its request even
    before its minimum. A room reaching its target is not restarted during the
    same production cycle. A restart preserves existing deadlines but starts a
    fresh five-minute threshold confirmation (the load path clears candidate).
    """
    if not enabled or not settings['solar_power_entity'] or power is None:
        return {}
    policy = [settings[key] for key in ('solar_power_entity', 'solar_start_kw',
              'solar_stop_kw', 'solar_minimum_run_minutes', 'simulation_enabled', 'live_control_confirmed')]
    state = deepcopy(previous) if previous.get('policy') == policy else {
        'policy': policy, 'active': False, 'candidate': None, 'sessions': {}, 'finished': []}
    if now < state.get('checked', now) or now - state.get('checked', now) > SOLAR_SENSOR_MAX_AGE:
        state['candidate'] = None
    state['checked'] = now
    desired = state['active']
    if power > settings['solar_start_kw']:
        desired = True
    elif power <= settings['solar_stop_kw']:
        desired = False
    if desired == state['active']:
        state['candidate'] = None
    else:
        candidate = state.get('candidate')
        if not candidate or candidate['active'] != desired:
            state['candidate'] = {'active': desired, 'since': now}
        elif now - candidate['since'] >= SOLAR_THRESHOLD_SECONDS:
            state['active'] = desired
            state['candidate'] = None
            if desired:
                state['finished'] = []
    for room_id, session in list(state['sessions'].items()):
        room = rooms.get(room_id)
        safe = room is not None and room['signature'] == session['signature']
        if not safe or (not state['active'] and now >= session['minimum_until']):
            state['sessions'].pop(room_id)
            if room_id not in state['finished']:
                state['finished'].append(room_id)
    if state['active'] and power > settings['solar_start_kw']:
        for room_id, room in rooms.items():
            if room_id in state['sessions'] or room_id in state['finished'] or not room['can_start']:
                continue
            state['sessions'][room_id] = {
                'entity': room['entity'], 'target': room['target'], 'signature': room['signature'],
                'started': now, 'minimum_until': now + settings['solar_minimum_run_minutes'] * 60}
    return state
