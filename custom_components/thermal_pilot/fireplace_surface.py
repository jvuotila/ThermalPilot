"""Estimate the residual heat of a fireplace from its surface temperature."""

from math import exp2, log2
from statistics import median

WARM_SURFACE_EXCESS = 2.0
MIN_FIT_HOURS = 2.0
MIN_CYCLES = 2
MAX_ROOM_HEATING_RATE = 0.5  # °C per hour credited in the planner.


def sample_surface(record, now, surface, reference, active=None):
    """Track a short cooling trend and identify distinct warm cycles."""
    if active is not None:
        if active and record.get('active') is False:
            # Masonry can still be warm when the next firing begins.
            record.pop('cycle', None)
        record['active'] = active
    bucket = int(now) // 300 * 300
    samples = [(time, value) for time, value in record.get('samples', [])
               if bucket - 3 * 3600 <= time < bucket]
    samples.append((bucket, surface))
    record['samples'] = samples

    # A single unexpected reading should not make the room plan jump.
    recent = [value for time, value in samples if time >= bucket - 600]
    excess = median(recent) - reference
    if excess < WARM_SURFACE_EXCESS - 0.5:
        record.pop('cycle', None)
        return None
    if excess < WARM_SURFACE_EXCESS:
        return None

    cycle = record.setdefault('cycle', now)
    # Compare half-hour medians instead of individual readings. If the surface
    # is warming, plan from its current heat and do not assume another firing.
    half_life = 4.0
    latest = median([value for time, value in samples if time >= bucket - 1500])
    older = [value for time, value in samples if bucket - 7200 <= time < bucket - 5400]
    if len(older) >= 3:
        older_excess = median(older) - reference
        latest_excess = latest - reference
        if older_excess > latest_excess > 0:
            decay = log2(older_excess / latest_excess)
            half_life = min(12.0, max(1.0, 1.5 / max(decay, 0.125)))
    return {'surface': reference + excess, 'cycle': cycle, 'half_life': half_life}


def learn_surface_gain(model, previous, current, hours, prediction_without_fireplace):
    """Fit one fireplace at a time from residual heat after other heating settles."""
    before = previous.get('fireplace_surfaces', {})
    after = current.get('fireplace_surfaces', {})
    if len(before) != 1 or before.keys() != after.keys():
        return
    fireplace_id, reading = next(iter(before.items()))
    next_reading = after[fireplace_id]
    if (reading['entity'], reading['cycle']) != (next_reading['entity'], next_reading['cycle']):
        return

    # A large jump is more likely to reflect a local disturbance than the
    # gradual warming of the room by a cooling masonry surface.
    residual = (current['temperature'] - prediction_without_fireplace) / hours
    if abs(residual) > 2:
        return
    excess = (reading['excess'] + next_reading['excess']) / 2
    profiles = model.setdefault('fireplace_surface_gains', {})
    profile = profiles.get(fireplace_id)
    if profile is None or profile['entity'] != reading['entity']:
        profile = profiles[fireplace_id] = {'entity': reading['entity'], 'cycles': []}
    cycles = profile['cycles']
    if not cycles or cycles[-1]['start'] != reading['cycle']:
        cycles.append({'start': reading['cycle'], 'hours': 0.0, 'xx': 0.0, 'xy': 0.0})
        del cycles[:-6]
    fit = cycles[-1]
    fit['hours'] += hours
    fit['xx'] += hours * excess ** 2
    fit['xy'] += hours * excess * residual


def surface_gain_rates(model, readings):
    """Return room warming rates only after multiple independently observed fires."""
    rates = {}
    for fireplace_id, reading in readings.items():
        profile = model.get('fireplace_surface_gains', {}).get(fireplace_id)
        if not profile or profile['entity'] != reading['entity']:
            continue
        slopes = [fit['xy'] / fit['xx'] for fit in profile['cycles']
                  if fit['hours'] >= MIN_FIT_HOURS and fit['xx'] > 0]
        if len(slopes) >= MIN_CYCLES:
            rates[fireplace_id] = max(0.0, median(slopes) * reading['excess'])
    return rates


def surface_heat_forecast(rates, surfaces, slots, now):
    """Taper residual heat within the price horizon and cap its combined credit."""
    forecast = []
    for slot in slots:
        midpoint = max(now, slot.start) + (slot.end - max(now, slot.start)) / 2
        hours = max(0.0, (midpoint - now).total_seconds() / 3600)
        rate = sum(value * exp2(-hours / surfaces[key]['half_life'])
                   for key, value in rates.items())
        forecast.append(min(MAX_ROOM_HEATING_RATE, rate))
    return forecast
