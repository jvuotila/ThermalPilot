"""Timed and zone-based heating setbacks, separate from source learning."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4
from zoneinfo import ZoneInfo

from .model import curve_hours, effective_loss, number, response_lag, response_step, stamp, thermostat_state


REPEAT_DAYS = {'daily': 1, 'weekly': 7}
CALENDAR_HORIZON_DAYS = 8
UPCOMING_OCCURRENCES = 4
LEGACY_OCCURRENCE_LIMIT = 52
MAX_REMINDER_HOURS = 30 * 24
MAX_REPEAT_COUNT = 365


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


def local_timestamp(local: datetime, zone: ZoneInfo) -> float | None:
    """Reject wall times that are nonexistent or ambiguous at a DST change."""
    first = local.replace(tzinfo=zone, fold=0)
    second = local.replace(tzinfo=zone, fold=1)
    restored = first.astimezone(timezone.utc).astimezone(zone).replace(tzinfo=None)
    if restored != local or first.utcoffset() != second.utcoffset():
        return None
    return first.timestamp()


def parse_schedule(start: str | None, end: str | None, zone: str, now: datetime,
                   repeat: str = 'once') -> dict[str, float]:
    """Interpret wall-clock inputs in Home Assistant's time zone."""
    if repeat not in ('once', *REPEAT_DAYS):
        raise ValueError('Choose a valid repeat option.')
    try:
        dates = [datetime.fromisoformat(value) for value in (start, end)]
    except (TypeError, ValueError):
        raise ValueError('Choose valid start and end dates and times.') from None
    if any(date.tzinfo is not None for date in dates):
        raise ValueError('Use local dates and times in the Home Assistant time zone.')
    local_zone = ZoneInfo(zone)
    starts, ends = (local_timestamp(date, local_zone) for date in dates)
    if starts is None or ends is None:
        raise ValueError('This local time changes with daylight saving. Choose another time.')
    if ends <= starts or ends <= now.timestamp():
        raise ValueError('The end must be after the start and in the future.')
    return {'start': starts, 'end': ends}


def calendar_bookings(state: dict[str, Any]) -> list[dict[str, Any]]:
    """Migrate the former single booking and keep any confirmed departure."""
    bookings = state.setdefault('schedules', [])
    old = state.pop('schedule', None)
    started = state.pop('manual_started', False)
    if old and not bookings:
        booking = {**old, 'id': 'legacy', 'repeat': 'once'}
        if started:
            booking['active_start'] = old['start']
        bookings.append(booking)
    return bookings


def calendar_occurrences(booking: dict[str, Any], now: float, zone: ZoneInfo,
                         minimum: int = 1, horizon_days: int = CALENDAR_HORIZON_DAYS) -> list[dict[str, float]]:
    """Return live/upcoming occurrences, plus enough for the forecast horizon."""
    if booking['repeat'] == 'once':
        return [{'start': booking['start'], 'end': booking['end']}] if booking['end'] > now else []
    step = REPEAT_DAYS[booking['repeat']]
    first_start = datetime.fromtimestamp(booking['start'], zone).replace(tzinfo=None)
    first_end = datetime.fromtimestamp(booking['end'], zone).replace(tzinfo=None)
    today = datetime.fromtimestamp(now, zone).date()
    # Anchor the search on the end date so long, overlapping occurrences
    # that started several intervals ago can still be found.
    first_index = max(0, (today - first_end.date()).days // step)
    horizon = today + timedelta(days=horizon_days)
    skipped = set(booking.get('skipped_starts', []))
    skipped_through = booking.get('skipped_through', float('-inf'))
    occurrences = []
    index = first_index
    repeat_count = booking.get('repeat_count', 0)
    while not repeat_count or index < repeat_count:
        shift = timedelta(days=index * step)
        start = first_start + shift
        if len(occurrences) >= minimum and start.date() > horizon:
            break
        begin = local_timestamp(start, zone)
        end = local_timestamp(first_end + shift, zone)
        # The repeat stays at the chosen local time. A DST transition can
        # invalidate an individual occurrence without affecting the series.
        if begin is not None and end is not None and end > max(begin, now):
            if begin > skipped_through and begin not in skipped:
                occurrences.append({'start': begin, 'end': end, 'index': index})
        index += 1
    return occurrences


def change_calendar(state: dict[str, Any], action: str, start: str | None, end: str | None,
                    now: datetime, zone_name: str, booking_id: str | None, repeat: str,
                    occurrence: float | None, reminder_hours: int = 0, repeat_count: int = 0) -> None:
    """Save one booking, remove a series, or skip its displayed occurrence."""
    bookings = calendar_bookings(state)
    index = next((i for i, entry in enumerate(bookings) if entry['id'] == booking_id), None)
    if booking_id is not None and index is None:
        raise ValueError('This absence is no longer scheduled.')
    if action == 'set':
        if not 0 <= reminder_hours <= MAX_REMINDER_HOURS:
            raise ValueError('Choose a reminder from 1 hour to 30 days.')
        period = parse_schedule(start, end, zone_name, now, repeat)
        if repeat != 'once' and (type(repeat_count) is not int or not 1 <= repeat_count <= MAX_REPEAT_COUNT):
            raise ValueError('Enter a whole number from 1 to 365.')
        booking = {**period, 'id': booking_id or uuid4().hex, 'repeat': repeat,
                   'reminder_hours': reminder_hours, 'repeat_count': repeat_count if repeat != 'once' else 0}
        if index is None:
            bookings.append(booking)
        else:
            previous = bookings[index]
            if repeat == previous['repeat']:
                for key in ('skipped_starts', 'skipped_through', 'active_start', 'reminded_starts'):
                    if key in previous:
                        booking[key] = previous[key]
            bookings[index] = booking
    elif action == 'skip':
        booking = bookings[index] if index is not None else None
        if booking is None or booking['repeat'] == 'once':
            raise ValueError('This absence is no longer scheduled.')
        limit = booking.get('repeat_count') or LEGACY_OCCURRENCE_LIMIT
        current = calendar_occurrences(booking, now.timestamp(), ZoneInfo(zone_name), limit)
        if occurrence is None or not any(period['start'] == occurrence for period in current[:limit]):
            raise ValueError('This absence is no longer scheduled.')
        booking.setdefault('skipped_starts', []).append(occurrence)
        if booking.get('active_start') == occurrence:
            booking.pop('active_start')
    elif index is not None:
        bookings.pop(index)
    elif bookings:
        # Older callers could only cancel their single booking.
        bookings.pop(0)


def calendar_periods(status: dict[str, Any]) -> list[dict[str, float]]:
    """Use the legacy single period when an older caller supplies it."""
    if 'periods' in status:
        return status['periods']
    schedule = status.get('schedule')
    return [schedule] if schedule else []


def update(previous: dict[str, Any], settings: dict[str, Any], count: int | None,
           now: float, zone_name: str = 'UTC') -> tuple[dict[str, Any], dict[str, Any]]:
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
    zone = ZoneInfo(zone_name)
    upcoming, displayed, periods, retained, reminders = [], [], [], [], []
    occurrence_count = 0
    has_ongoing_series = False
    manual_active = False
    home = settings['away_automatic'] and count is not None and count > 0
    for booking in calendar_bookings(state):
        reminder_hours = booking.get('reminder_hours', 0)
        # Include occurrences whose reminders fall inside the next day even
        # when their start dates lie beyond the heating plan.
        horizon_days = max(CALENDAR_HORIZON_DAYS, reminder_hours // 24 + 2)
        occurrences = calendar_occurrences(booking, now, zone, UPCOMING_OCCURRENCES, horizon_days)
        if not occurrences:
            continue
        current = occurrences[0]
        started = {period['start'] for period in occurrences if period['start'] <= now}
        active = bool(started) and not home
        if started and home and (booking.get('active_start') in started or previous_count == 0):
            state['last_cancel_reason'] = 'Returned home'
            if booking['repeat'] == 'once':
                continue
            booking['skipped_through'] = max(started)
            booking.pop('active_start', None)
            occurrences = calendar_occurrences(booking, now, zone, UPCOMING_OCCURRENCES, horizon_days)
            if not occurrences:
                continue
            current = occurrences[0]
        if active:
            booking['active_start'] = max(started)
            manual_active = True
        elif booking.get('active_start') != current['start']:
            booking.pop('active_start', None)
        retained.append(booking)
        repeat_count = booking.get('repeat_count', 0)
        remaining = repeat_count - current.get('index', 0) if repeat_count else 0
        # The calendar list can extend beyond the hours needed by the heating
        # plan or reminders. Previously saved unlimited series have no last date.
        unlimited = not repeat_count and booking['repeat'] != 'once'
        list_limit = LEGACY_OCCURRENCE_LIMIT if unlimited else remaining or 1
        listed = occurrences
        if len(listed) < list_limit:
            listed = calendar_occurrences(booking, now, zone, list_limit)
        listed = listed[:list_limit]
        occurrence_count += len(listed)
        has_ongoing_series = has_ongoing_series or unlimited
        booking_summary = {'id': booking['id'], 'repeat': booking['repeat'],
                           'reminder_hours': reminder_hours, 'repeat_count': remaining}
        upcoming.append({'start': current['start'], 'end': current['end'], **booking_summary, 'active': active})
        for period in listed:
            displayed.append({'start': period['start'], 'end': period['end'],
                              **booking_summary, 'active': active and period['start'] in started})
        if 'reminded_starts' in booking:
            booking['reminded_starts'] = [start for start in booking['reminded_starts'] if start > now]
        if reminder_hours:
            reminded = set(booking.get('reminded_starts', []))
            for period in occurrences:
                start = period['start']
                if start > now and start not in reminded:
                    reminders.append({'start': start, 'end': period['end'], 'id': booking['id'],
                                      'deadline': start - reminder_hours * 3600})
        periods.extend({'start': period['start'], 'end': period['end']} for period in occurrences)
    state['schedules'] = retained
    upcoming.sort(key=lambda entry: (entry['start'], entry['end']))
    displayed.sort(key=lambda entry: (entry['start'], entry['end']))
    periods.sort(key=lambda entry: (entry['start'], entry['end']))
    schedule = {key: upcoming[0][key] for key in ('start', 'end')} if upcoming else None
    empty_since = state.get('empty_since')
    automatic_start = None
    if settings['away_automatic'] and empty_since is not None:
        automatic_start = empty_since + settings['away_delay_hours'] * 3600
    automatic_active = automatic_start is not None and now >= automatic_start
    active = manual_active or automatic_active
    source = 'calendar' if manual_active else 'automatic' if automatic_active else None
    status = {'active': active, 'source': source, 'temperature': settings['away_temperature'], 'cooling_temperature': settings['away_cooling_temperature'],
              'schedule': schedule, 'schedules': upcoming, 'occurrences': displayed,
              'occurrence_count': occurrence_count, 'has_ongoing_series': has_ongoing_series,
              'periods': periods, 'reminders': reminders, 'person_count': count,
              'automatic_start': automatic_start, 'empty_since': empty_since,
              'zone': settings['away_zone'], 'automatic_enabled': settings['away_automatic'], 'warning': None}
    if settings['away_automatic'] and settings['away_zone'] and count is None:
        status['warning'] = 'Home zone person count is unavailable; automatic away temperatures are paused.'
    return state, status


def temperature_at(status: dict[str, Any], moment: float) -> float | None:
    """Only known calendar/delay boundaries are projected; no return is invented."""
    if status.get('automatic_enabled') and status.get('zone') and status.get('person_count') not in (None, 0):
        return None
    if any(period['start'] <= moment < period['end'] for period in calendar_periods(status)):
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
    edges = {when for period in calendar_periods(status) for when in (period['start'], period['end'])}
    if status.get('automatic_start') is not None:
        edges.add(status['automatic_start'])
    if not slots:
        return original
    horizon_start = max(now, slots[0]['start']).timestamp()
    horizon_end = slots[-1]['end'].timestamp()
    checkpoints = [horizon_start, *(edge for edge in edges if horizon_start < edge < horizon_end)]
    if not any(temperature_at(status, point) is not None for point in checkpoints):
        return original
    rows = []
    response = model.get('response', 0)
    loss = effective_loss(model, wind)
    has_away = False
    for slot in slots:
        start = max(now, slot['start'])
        if slot['end'] <= start:
            continue
        # Split a price interval at calendar boundaries so commands are exact,
        # even when an absence starts at 18:07 rather than a quarter hour.
        boundaries = [start, slot['end']]
        for value in edges:
            if start.timestamp() < value < slot['end'].timestamp():
                boundaries.append(datetime.fromtimestamp(value, now.tzinfo))
        boundaries = sorted(set(boundaries))
        for begin, finish in zip(boundaries, boundaries[1:]):
            away = temperature_at(status, begin.timestamp())
            requested = thermostat_state(original, begin) if original else {'setpoint': room['baseline'], 'mode': 'normal'}
            target = requested['setpoint']
            mode = requested['mode']
            if away is not None:
                has_away = True
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
    if not has_away:
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
