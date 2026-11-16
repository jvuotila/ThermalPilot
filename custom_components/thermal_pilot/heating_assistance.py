"""Capacity-based coordination of an air heat pump and electric floor thermostat.

This policy does not estimate COP. Recent measured room response determines
whether the pump can maintain comfort; the floor model supplies its response lag
and residual warmth. Mixed-source trends guide control, never parameter fitting.
"""
from copy import deepcopy
from datetime import datetime
from typing import Any

from .model import curve_hours, effective_loss, response_step, thermostat_state

PUMP_WARMUP_SECONDS = 1800
MINIMUM_TREND_SECONDS = 900
ASSISTANCE_PAUSE_SECONDS = 900


def temperature_trend(samples: list[dict[str, float]]) -> float | None:
    """Fit a half-hour room trend, smoothing quantized sensor steps."""
    if len(samples) < 2 or samples[-1]['time'] - samples[0]['time'] < MINIMUM_TREND_SECONDS:
        return None
    origin = samples[0]['time']
    hours = [(sample['time'] - origin) / 3600 for sample in samples]
    average_time = sum(hours) / len(hours)
    average_temperature = sum(sample['temperature'] for sample in samples) / len(samples)
    numerator = sum((time - average_time) * (sample['temperature'] - average_temperature)
                    for time, sample in zip(hours, samples))
    denominator = sum((time - average_time) ** 2 for time in hours)
    if denominator == 0:
        return None
    return max(-12, min(12, numerator / denominator))


def coast_temperature(temperature: float, outdoor: float, future_outdoor: list[float],
                      trend: float, response: float, model: dict[str, Any],
                      lag: float, wind: float | None = None) -> float:
    """Project the observed net trend with no further floor input.

    Existing floor warmth decays through its modeled lag. Weather and indoor
    temperature changes adjust heat loss. The observed pump contribution is held
    constant over this short lookahead; it is not a measured thermal output.
    """
    reference_temperature = temperature
    initial_response = response
    loss = effective_loss(model, wind)
    step = lag / max(1, len(future_outdoor))
    for outside in future_outdoor:
        response, average = response_step(response, 0, step, lag)
        rate = (trend + model['gain'] * (average - initial_response)
                + loss * (outside - outdoor + reference_temperature - temperature))
        temperature += step * rate
    return temperature


def decide(state: dict[str, Any], room: dict[str, Any], settings: dict[str, Any],
           temperature: float, predicted: float | None, now: float,
           pump_available: bool, pump_heating: bool) -> dict[str, Any]:
    """Choose requests with hysteresis, a fixed minimum and coasting recovery."""
    baseline = room['baseline']
    reserve = max(settings['minimum'], baseline - room['assist_below_target'])
    upper = settings['maximum']
    minimum_until = state.get('minimum_until', 0)
    assisting = bool(state.get('assisting'))
    was_assisting = assisting
    emergency = temperature <= settings['minimum']
    if temperature >= upper:
        assisting = False
    elif temperature <= reserve:
        if emergency or now >= state.get('resume_after', 0):
            assisting = True
    elif assisting:
        recovered = temperature >= baseline + .2 or (predicted is not None and predicted >= baseline)
        if now >= minimum_until and recovered:
            assisting = False
    elif (predicted is not None and predicted < reserve and pump_heating
          and state.get('pump_since') is not None
          and now - state['pump_since'] >= PUMP_WARMUP_SECONDS
          and now >= state.get('resume_after', 0)):
        assisting = True
    if assisting and not was_assisting:
        state['started'] = now
        state['minimum_until'] = now + settings['minimum_run_minutes'] * 60
    elif was_assisting and not assisting:
        state['resume_after'] = now + ASSISTANCE_PAUSE_SECONDS
    state['assisting'] = assisting
    pump_requested = bool(state.get('pump_requested'))
    if temperature <= baseline or assisting:
        pump_requested = True
    elif temperature >= baseline + .2:
        pump_requested = False
    state['pump_requested'] = pump_requested and pump_available and temperature < upper
    if not pump_available:
        # A missing or protected pump cannot be a reason to withhold floor heat.
        target = baseline
        reason = 'Floor heating backup'
    else:
        target = reserve
        reason = 'Heat pump preferred'
    if assisting:
        target = min(upper, baseline + settings['boost'])
        if pump_available:
            reason = 'Floor heating assists'
        if temperature >= baseline and now >= state['minimum_until']:
            # Once the protected boost has completed, use the normal target if
            # residual warmth is not yet sufficient to coast through the lag.
            # Actual relay demand still belongs to the floor thermostat.
            target = baseline
    if temperature >= upper:
        target = reserve
        reason = 'Upper temperature limit reached'
    return {'floor_target': target, 'pump_requested': state['pump_requested'],
            'assisting': assisting, 'reason': reason, 'reserve_target': reserve,
            'minimum_until': state.get('minimum_until') if assisting else None,
            'predicted_temperature': predicted}


def update_room(previous: dict[str, Any], signature: list[Any], room: dict[str, Any],
                settings: dict[str, Any], model: dict[str, Any], temperature: float,
                outdoor: float, future_outdoor: list[float], now: float,
                pump_available: bool, pump_heating: bool,
                wind: float | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
    """Observe actual temperatures without fabricating source-learning samples."""
    state = deepcopy(previous) if previous.get('signature') == signature else {
        'signature': signature, 'assisting': False, 'samples': [], 'pump_since': None}
    gap = now - state.get('checked', now)
    if gap < 0 or gap > 1800:
        state['samples'] = []
        state['pump_since'] = None
    state['checked'] = now
    if pump_heating:
        if state.get('pump_since') is None:
            state['pump_since'] = now
        samples = [sample for sample in state['samples'] if sample['time'] >= now - 1800]
        if not samples or now - samples[-1]['time'] >= 180:
            samples.append({'time': now, 'temperature': temperature})
        state['samples'] = samples
    else:
        state['samples'] = []
        state['pump_since'] = None
    trend = temperature_trend(state['samples'])
    predicted = None
    if trend is not None:
        predicted = coast_temperature(temperature, outdoor, future_outdoor, trend,
                                       model.get('response', 0), model, settings['lag_hours'], wind)
    report = decide(state, room, settings, temperature, predicted, now, pump_available, pump_heating)
    report['trend'] = trend
    report['pump_available'] = pump_available
    report['pump_heating'] = pump_heating
    return state, report


def forecast(room: dict[str, Any], settings: dict[str, Any], model: dict[str, Any],
             state: dict[str, Any], report: dict[str, Any], temperature: float,
             outdoor: float, slots: list[dict[str, Any]], now: datetime,
             wind: float | None = None) -> dict[str, Any] | None:
    """Conditional combined forecast from observed response, not a COP curve.

    Without a usable pump-on room trend, leave the forecast unavailable instead
    of claiming a known pump capacity. Live comfort/backup control still works.
    Future transitions are reevaluated against real readings before any command.
    """
    if report.get('trend') is None or not report['pump_available'] or not slots:
        return None
    state = deepcopy(state)
    lag = settings['lag_hours']
    loss = effective_loss(model, wind)
    floor_response = model.get('response', 0)
    # This short-term residual estimate is used only in this forecast. Never
    # store it as a learned source gain or use it to claim measured efficiency.
    pump_gain = max(0, min(12, report['trend'] - loss * (outdoor - temperature)
                           - model['gain'] * floor_response - model.get('base_gain', 0)))
    rows = []
    for slot in slots:
        start = max(now, slot['start'])
        if slot['end'] <= start:
            continue
        hours = (slot['end'] - start).total_seconds() / 3600
        outside = slot['outdoor']
        trend = (loss * (outside - temperature) + pump_gain
                 + model['gain'] * floor_response + model.get('base_gain', 0))
        predicted = coast_temperature(temperature, outside, [outside] * max(1, round(lag * 4)),
                                       trend, floor_response, model, lag, wind)
        choice = decide(state, room, settings, temperature, predicted, start.timestamp(), True, True)
        target = choice['floor_target']
        floor_demand = temperature < target
        floor_response, average = response_step(floor_response, float(floor_demand), hours, lag)
        pump_on = choice['pump_requested']
        temperature += hours * (loss * (outside - temperature) + pump_gain * pump_on
                                + model['gain'] * average + model.get('base_gain', 0))
        if target > room['baseline']:
            mode = 'boost'
        elif target == room['baseline']:
            mode = 'normal'
        else:
            mode = 'reduced'
        rows.append({'start': start.isoformat(), 'end': slot['end'].isoformat(),
                     'outdoor': outside, 'price': slot.get('price'), 'temperature': round(temperature, 3),
                     'setpoint': target, 'mode': mode, 'heat': mode == 'boost',
                     'predicted_demand': floor_demand, 'pump_requested': pump_on})
    if not rows:
        return None
    commands = []
    windows = []
    previous_mode = 'reduced'
    for row in rows:
        if row['mode'] != previous_mode:
            commands.append({'time': row['start'], 'setpoint': row['setpoint'], 'mode': row['mode'],
                             'action': {'boost': 'raise', 'normal': 'restore', 'reduced': 'lower'}[row['mode']]})
            previous_mode = row['mode']
        if row['heat']:
            if windows and windows[-1]['end'] == row['start']:
                windows[-1]['end'] = row['end']
            else:
                windows.append({'start': row['start'], 'end': row['end']})
    commands.append({'time': rows[-1]['end'], 'setpoint': report['reserve_target'],
                     'mode': 'reduced', 'action': 'lower'})
    timing = {'commands': commands, 'thermostat_windows': windows, 'sessions': deepcopy(windows),
              'default_mode': 'reduced', 'normal_setpoint': room['baseline'],
              'reduced_setpoint': report['reserve_target'],
              'boosted_setpoint': min(settings['maximum'], room['baseline'] + settings['boost'])}
    demand_hours = 0
    for row in rows:
        if row['predicted_demand']:
            duration = datetime.fromisoformat(row['end']) - datetime.fromisoformat(row['start'])
            demand_hours += duration.total_seconds() / 3600
    return {'slots': rows, **timing, **thermostat_state(timing, now),
            'scheduled_heat': rows[0]['heat'], 'scheduled_mode': rows[0]['mode'],
            'reduction_available': True, 'assistance_plan': True,
            'reason': 'Heat pump preferred; floor heating assists when needed.',
            'forecast_minimum': min(row['temperature'] for row in rows),
            'forecast_maximum': max(row['temperature'] for row in rows),
            'comfort_risk': any(row['temperature'] < settings['minimum'] for row in rows),
            'curve_hours': round(curve_hours({**room, **settings}, min(slot['outdoor'] for slot in slots)), 1),
            'predicted_demand_hours': demand_hours}
