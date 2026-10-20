"""Independent, dependency-free hourly planner and conservative online model.

No device commands exist in this module. A low-pass heating response approximates
slab delay; it is not a physical measurement of the slab's stored energy.
"""
from typing import Any
from dataclasses import dataclass
from datetime import date as date_type, datetime, timedelta, timezone
import math
from .const import DEFAULTS, AIR_INITIAL_LAG_HOURS, GARAGE_INITIAL_COOLING_HOURS, HOUSE_COOLING_REFERENCES


def number(value, default=None):
    try:
        result = float(value)
        return result if math.isfinite(result) else default
    except (ValueError, TypeError):
        return default


def stamp(value):
    try:
        d = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return d if d.tzinfo else None
    except (ValueError, TypeError):
        return None


@dataclass(frozen=True)
class Slot:
    start: datetime
    end: datetime
    price: float


def price_slots(attributes, config, now, tz):
    """Normalize timestamped prices to elapsed UTC hours; reject ambiguous lists.

Raw arrays are preferred and handle 23/25-hour days. List-only sources are
accepted solely on regular 24-hour days, with their interval detected from
    24 or 96 entries per day. Gaps stop the usable horizon.
"""
    factor = 100.0 if config['price_unit'] == '€/kWh' else 1.0
    raw = []
    for key in ('raw_today', 'raw_tomorrow'):
        raw.extend(attributes.get(key) or [])
    segments = []
    if raw:
        for item in raw:
            if not isinstance(item, dict):
                raise ValueError('Each raw price row must be an object.')
            start, end = (stamp(item.get('start')), stamp(item.get('end')))
            value = number(item.get('value'))
            if start is None or end is None or value is None or (end <= start):
                raise ValueError('Invalid price or timestamp in source list.')
            segments.append((start.astimezone(timezone.utc), end.astimezone(timezone.utc), value * factor))
    else:
        for offset, key in enumerate(('today', 'tomorrow')):
            values = attributes.get(key) or []
            if not values:
                continue
            day = now.astimezone(tz).date() + timedelta(days=offset)
            local_start = datetime.combine(day, datetime.min.time(), tzinfo=tz)
            local_end = datetime.combine(day + timedelta(days=1), datetime.min.time(), tzinfo=tz)
            start, end = (local_start.astimezone(timezone.utc), local_end.astimezone(timezone.utc))
            if (end - start).total_seconds() != 86400:
                raise ValueError('DST transition days require timestamped raw_today/raw_tomorrow data.')
            if not isinstance(values, (list, tuple)) or len(values) not in (24, 96):
                raise ValueError(f'{key}: expected 24 hourly or 96 quarter-hour prices for a complete day.')
            step = 60 if len(values) == 24 else 15
            for i, value in enumerate(values):
                value = number(value)
                if value is None:
                    raise ValueError('Price list contains a missing or invalid price.')
                a = start + timedelta(minutes=i * step)
                segments.append((a, a+timedelta(minutes=step), value*factor))
    segments.sort(key=lambda s: s[0])
    for a, b in zip(segments, segments[1:]):
        if a[1] > b[0]:
            raise ValueError('Price intervals contain overlapping timestamps.')
    step = 60 if config['pricing_mode'] == 'hourly' else 15
    first = now.astimezone(timezone.utc).replace(minute=now.minute // step * step, second=0, microsecond=0)
    output = []
    last_available = max((end for _, end, _ in segments), default=first)
    intervals = max(0, math.ceil((last_available - first).total_seconds() / (step * 60)))
    for i in range(intervals):
        a = first + timedelta(minutes=i * step)
        b = a + timedelta(minutes=step)
        total = duration = 0.0
        for s, e, value in segments:
            seconds = max(0.0, (min(b, e) - max(a, s)).total_seconds())
            total += seconds * value
            duration += seconds
        if duration < step * 60 - 1:
            break
        price = total / duration
        output.append(Slot(a, b, price))
    return output


def price_forecast_reserve(
    attributes: dict[str, Any], confirmed_end: datetime, base_hours: float = 6,
) -> dict[str, Any]:
    """Use forecast trends for reserve sizing, never as payable electricity prices.

    Only a continuous next-day forecast is accepted. Its next six hours are
    ranked against that day; expensive near-term hours can justify extra reserve
    at the end of the confirmed-price horizon.
    """
    points = {}
    for row in attributes.get('forecast') or []:
        if not isinstance(row, dict):
            continue
        raw_timestamp = row.get('timestamp')
        moment = stamp(raw_timestamp)
        numeric_timestamp = number(raw_timestamp)
        if moment is None and numeric_timestamp is not None:
            try:
                seconds = numeric_timestamp / 1000 if numeric_timestamp > 100000000000.0 else numeric_timestamp
                moment = datetime.fromtimestamp(seconds, timezone.utc)
            except (ValueError, OverflowError, OSError):
                continue
        value = number(row.get('value'))
        if moment is not None and value is not None:
            points[moment.timestamp()] = value

    start = confirmed_end.timestamp()
    future = sorted((timestamp, value) for timestamp, value in points.items()
                    if start <= timestamp < start + 24 * 3600)
    if (len(future) < 12 or future[0][0] - start > 3600
            or future[-1][0] < start + 18 * 3600
            or any(
                following[0] - previous[0] > 3600 for previous,
                following in zip(future, future[1:])
            )):
        return {'reserve_hours': base_hours, 'available': False,
                'reason': 'No continuous next-day price forecast beyond confirmed prices.'}
    near_term_prices = [value for timestamp, value in future if timestamp < start + 6 * 3600]
    if not near_term_prices:
        return {'reserve_hours': base_hours, 'available': False,
                'reason': 'No near-term forecast prices.'}
    values = sorted((value for _, value in future))
    spread = values[-1] - values[0]
    if spread > 1e-09:
        near_term_average = sum(near_term_prices) / len(near_term_prices)
        percentile = sum((value <= near_term_average for value in values)) / len(values)
    else:
        percentile = 0.5
    if percentile >= 0.8:
        suggested_reserve = 12
    elif percentile >= 0.65:
        suggested_reserve = 9
    else:
        suggested_reserve = base_hours
    reserve = max(base_hours, suggested_reserve)
    if reserve > base_hours:
        reason = 'Expensive period forecast after confirmed prices; extra heat reserve considered.'
    else:
        reason = 'Forecast does not call for extra heat reserve.'
    return {'reserve_hours': reserve, 'available': True, 'reason': reason}


def curve_hours(room, outdoor):
    room = {**DEFAULTS, **room}
    fraction = (room['curve_warm_temp'] - outdoor) / (room['curve_warm_temp'] - room['curve_cold_temp'])
    return room['curve_min_hours'] + max(0, min(1, fraction)) * (room['curve_max_hours'] - room['curve_min_hours'])


def cooling_reference(room):
    """Convert the broad 10-degree building example to our fixed 1-degree test.

This is a single-exponential equivalence, not a measured first-degree cooldown.
Garages deliberately do not inherit the occupied-house benchmark.
"""
    kind = room.get('house_construction', 'unknown')
    duration = HOUSE_COOLING_REFERENCES.get(kind) if not room.get('is_garage') else None
    if duration is None:
        return None
    return {
        'reference_type': kind,
        'reference_hours': duration * math.log(30 / 29) / math.log(40 / 30)
    }


def initial_model(room: dict[str, Any]) -> dict[str, Any]:
    """Seed a new model from construction cooling and daily heating estimates.

    These values are priors for later fitting, not fixed daily heating schedules.
    Persisted model keys also appear in backups, so keep their names stable.
    """
    room = {**DEFAULTS, **room}
    reference = cooling_reference(room)
    one_degree_decay = -math.log(29 / 30)
    if room.get('is_garage'):
        loss = one_degree_decay / GARAGE_INITIAL_COOLING_HOURS
    elif reference:
        loss = one_degree_decay / reference['reference_hours']
    else:
        loss = 0.007

    heating_hours_span = room['curve_max_hours'] - room['curve_min_hours']
    if heating_hours_span > 0.1:
        outdoor_temperature_span = room['curve_warm_temp'] - room['curve_cold_temp']
        gain = loss * 24 * outdoor_temperature_span / heating_hours_span
        base_gain = (
            loss * (room['baseline'] - room['curve_warm_temp'])
            - gain * room['curve_min_hours'] / 24
        )
    else:
        # A flat heating-hours curve cannot determine a slope. At its cold
        # endpoint, the configured daily heating must balance estimated losses.
        gain = loss * (room['baseline'] - room['curve_cold_temp']) * 24 / room['curve_max_hours']
        base_gain = 0.0
    base_gain = max(0.0, base_gain)
    return {
        'loss': loss, 'gain': gain, 'base_gain': base_gain,
        'samples': 0, 'heated_hours': 0.0, 'idle_hours': 0.0,
        'parameter_updates': 0,
        'xx': 0.0, 'xy': 0.0, 'yy': 0.0, 'xz': 0.0, 'yz': 0.0,
        'response': 0.0, 'mae': None,
    }


def response_step(response, heating, hours, lag):
    decay = math.exp(-hours / lag)
    end = heating + (response - heating) * decay
    average = heating + (response - heating) * lag * (1 - decay) / hours
    return (end, average)



def response_lag(room, model):
    if room.get('air_control'):
        return max(
            5 / 60,
            min(1, number(model.get('air_response_lag_hours'), AIR_INITIAL_LAG_HOURS))
        )
    return room['lag_hours']


def learn_air_response_lag(model, room, previous, current, hours):
    """Compare causal response profiles, fitting loss/gain as nuisance parameters.

Only uninterrupted, accepted observations are used. Score predictions before
fitting their outcomes. Require clean heating/idle evidence and several cycles;
flat or noisy observations leave the initial/previous estimate unchanged.
"""
    if not room.get('air_control'):
        return
    activity = number(previous.get('activity'))
    if activity not in (0, 1):
        return
    lag_history = model.setdefault(
        'air_lag_learning',
        {'profiles': {}, 'heated_hours': 0, 'idle_hours': 0, 'starts': 0, 'stops': 0}
    )
    profiles = lag_history['profiles']
    continuous = lag_history.get('last_time') == previous['time']
    if not continuous:
        lag_history['last_activity'] = None
        lag_history['transition_time'] = None
        lag_history['resume_time'] = previous['time']
        for profile in profiles.values():
            profile['response'] = 0.0
    if lag_history.get('last_activity') is not None and activity != lag_history['last_activity']:
        key = 'starts' if activity else 'stops'
        lag_history[key] += 1
        lag_history['transition_time'] = previous['time']
    lag_history['last_activity'] = activity
    lag_history['last_time'] = current['time']
    lag_history['heated_hours'] += hours * activity
    lag_history['idle_hours'] += hours * (1 - activity)
    temperature_gap = previous['outdoor'] - previous['temperature']
    background = model.get('base_gain', 0) + solar_gain(model, previous.get('solar'), solar_enabled(room))
    wind_contribution = (effective_loss(model, previous.get('wind')) - model['loss']) * temperature_gap
    temperature_rate = (current['temperature'] - previous['temperature']) / hours - background - wind_contribution
    # Let profiles settle after discontinuities before scoring a response lag.
    settled = current['time'] - lag_history['resume_time'] >= 3 * 3600
    near_transition = lag_history.get('transition_time') is not None and current['time'] - lag_history['transition_time'] <= 90 * 60
    for minutes in (5,10,15,20,30,45,60):
        profile = profiles.setdefault(
            str(minutes),
            {
                'response': 0,
                'loss': model['loss'],
                'gain': model['gain'],
                'xx': 0,
                'xy': 0,
                'yy': 0,
                'xz': 0,
                'yz': 0,
                'error_sum': 0,
                'weight': 0,
                'comparisons': 0
            }
        )
        response, average_response = response_step(profile['response'], activity, hours, minutes / 60)
        profile['response'] = response
        prediction = previous['temperature'] + hours * (profile['loss'] * temperature_gap + profile['gain'] * average_response + background + wind_contribution)
        if settled and near_transition:
            profile['error_sum'] = 0.995 * profile['error_sum'] + abs(prediction - current['temperature'])
            profile['weight'] = 0.995 * profile['weight'] + 1
            profile['comparisons'] += 1
        if not settled:
            continue
        for key,value in [('xx',temperature_gap*temperature_gap),('xy',temperature_gap*average_response),('yy',average_response*average_response),('xz',temperature_gap*temperature_rate),('yz',average_response*temperature_rate)]:
            profile[key] = 0.998 * profile[key] + value * hours
        loss_square_sum = profile['xx'] + 1
        response_square_sum = profile['yy'] + 0.01
        cross_sum = profile['xy']
        loss_rate_sum = profile['xz'] + model['loss']
        response_rate_sum = profile['yz'] + 0.01 * model['gain']
        determinant = loss_square_sum * response_square_sum - cross_sum * cross_sum
        if determinant > 1e-06:
            loss = (loss_rate_sum * response_square_sum - response_rate_sum * cross_sum) / determinant
            gain = (response_rate_sum * loss_square_sum - loss_rate_sum * cross_sum) / determinant
            if 0.001 <= loss <= 0.05 and 0.03 <= gain <= 3:
                profile.update(loss=loss,gain=gain)
    if not settled or lag_history['heated_hours'] < 12 or lag_history['idle_hours'] < 12 or (lag_history['starts'] < 3) or (lag_history['stops'] < 3):
        return
    if current['time'] - lag_history.get('last_selection_time', 0) < 3600:
        return
    eligible = [
        (int(key), profile) for key,
        profile in profiles.items() if profile['comparisons'] >= 48 and profile['weight'] > 0
    ]
    if len(eligible) != len(profiles):
        return
    # Require a meaningful improvement to avoid switching lag on near-tied noise.
    score = lambda item: item[1]['error_sum'] / item[1]['weight']
    best = min(eligible, key=score)
    existing = min(eligible, key=lambda item: abs(item[0] / 60 - response_lag(room, model)))
    lag_history['last_selection_time'] = current['time']
    if score(best) < score(existing) * 0.9 and score(existing) - score(best) >= 0.002:
        model['air_response_lag_hours'] = best[0] / 60
        model['response'] = best[1]['response']
        model['air_lag_updates'] = model.get('air_lag_updates', 0) + 1

def effective_loss(model, wind=None):
    """Optional learned wind correction around a shared 3 m/s reference.

Missing wind uses the ordinary loss coefficient; never interpret absence as calm.
"""
    speed = number(wind)
    if speed is None or not 0 <= speed <= 60:
        return model['loss']
    coefficient = max(0, min(number(model.get('wind_loss'), 0), model['loss'] / 6))
    return max(0.001, min(0.05, model['loss'] + coefficient * (min(speed, 20) - 3)))


def _solve_three(matrix, vector):
    """Solve a three-feature regression by pivoted Gaussian elimination.

    A near-zero pivot means the observed features cannot identify independent
    coefficients yet. Keep the existing model rather than fitting an unstable one.
    """
    rows = [list(row) + [value] for row, value in zip(matrix, vector)]
    for column_index in range(3):
        pivot = max(range(column_index, 3), key=lambda row_index: abs(rows[row_index][column_index]))
        rows[column_index], rows[pivot] = (rows[pivot], rows[column_index])
        if abs(rows[column_index][column_index]) < 1e-12:
            return None
        scale = rows[column_index][column_index]
        rows[column_index] = [normalized_value / scale for normalized_value in rows[column_index]]
        for row_index in range(3):
            if row_index != column_index:
                scale = rows[row_index][column_index]
                rows[row_index] = [entry - scale * pivot_entry for entry, pivot_entry in zip(rows[row_index], rows[column_index])]
    return [row[-1] for row in rows]


def learn_wind(model, room, x, y, z, wind, hours):
    """Fit wind only after varied wind and both heating states are observed.

    x is the outdoor/indoor temperature gap, y the effective heating response,
    and z the observed temperature rate after removing background gains.
    Stored matrix/vector keys remain compatible with previously learned state.
    """
    speed = number(wind)
    if speed is None or not 0 <= speed <= 60:
        return
    speed = min(speed, 20)
    stat = model.setdefault(
        'wind_statistics',
        {
            'matrix': [[0.0] * 3 for _ in range(3)],
            'vector': [0.0] * 3,
            'hours': 0.0,
            'sum': 0.0,
            'squared': 0.0
        }
    )
    features = [x, y, x * (speed - 3)]
    for i in range(3):
        stat['vector'][i] += features[i] * z * hours
        for j in range(3):
            stat['matrix'][i][j] += features[i] * features[j] * hours
    stat['hours'] += hours
    stat['sum'] += speed * hours
    stat['squared'] += speed * speed * hours
    variance = stat['squared'] / stat['hours'] - (stat['sum'] / stat['hours']) ** 2
    if stat['hours'] < 24 or variance < 1 or model.get('heated_hours', 0) < 12 or (model.get('idle_hours', 0) < 12):
        return
    matrix = [row[:] for row in stat['matrix']]
    vector = stat['vector'][:]
    prior = initial_model(room)
    for i,weight in enumerate((200,20,10000)):
        matrix[i][i] += weight
    vector[0] += 200 * prior['loss']
    vector[1] += 20 * prior['gain']
    solved = _solve_three(matrix, vector)
    if solved is None:
        return
    loss, gain, wind_loss = solved
    if 0.001 <= loss <= 0.05 and 0.03 <= gain <= 3 and (0 <= wind_loss <= loss / 6):
        model['loss'] = 0.98 * model['loss'] + 0.02 * loss
        model['gain'] = 0.98 * model['gain'] + 0.02 * gain
        model['wind_loss'] = 0.98 * model.get('wind_loss', 0) + 0.02 * wind_loss
        model['wind_updates'] = model.get('wind_updates', 0) + 1


def solar_signal(moment, latitude, longitude, weather, direction=None):
    """Approximate daylight/cloud proxy, not measured irradiance; None means unknown."""
    latitude_value, longitude_value = (number(latitude), number(longitude))
    if latitude_value is None or longitude_value is None or (not -90 <= latitude_value <= 90) or (not -180 <= longitude_value <= 180):
        return None
    moment = moment.astimezone(timezone.utc)
    day = moment.timetuple().tm_yday
    hour = moment.hour + moment.minute / 60 + moment.second / 3600
    angle = 2 * math.pi / 365 * (day - 1 + (hour - 12) / 24)
    equation = 229.18 * (7.5e-05 + 0.001868 * math.cos(angle) - 0.032077 * math.sin(angle) - 0.014615 * math.cos(2 * angle) - 0.040849 * math.sin(2 * angle))
    declination = 0.006918 - 0.399912 * math.cos(angle) + 0.070257 * math.sin(angle) - 0.006758 * math.cos(2 * angle) + 0.000907 * math.sin(2 * angle) - 0.002697 * math.cos(3 * angle) + 0.00148 * math.sin(3 * angle)
    hour_angle = math.radians((hour * 60 + equation + 4 * longitude_value) / 4 - 180)
    sin_elevation = math.sin(math.radians(latitude_value)) * math.sin(declination) + math.cos(math.radians(latitude_value)) * math.cos(declination) * math.cos(hour_angle)
    if sin_elevation <= 0:
        return 0.0
    if not isinstance(weather, dict):
        return None
    cloud = number(weather.get('cloud_coverage'))
    if cloud is not None and 0 <= cloud <= 100:
        transmission = 1 - 0.85 * cloud / 100
    else:
        transmission = {
            'sunny': 1.0,
            'clear-night': 0.0,
            'partlycloudy': 0.5,
            'cloudy': 0.15,
            'rainy': 0.1,
            'pouring': 0.05,
            'snowy': 0.1,
            'snowy-rainy': 0.1,
            'fog': 0.1,
            'lightning': 0.1,
            'lightning-rainy': 0.1
        }.get(weather.get('condition'))
        if transmission is None:
            return None
    facing = solar_facing(moment, latitude, longitude, direction) if direction else 1.0
    return max(0, min(1, sin_elevation * transmission * facing))


def solar_facing(moment, latitude, longitude, direction):
    """Azimuth incidence for the dominant window direction; no behind-window credit."""
    bearings = {
        'north': 0,
        'northeast': 45,
        'northwest': 315,
        'east': 90,
        'southeast': 135,
        'south': 180,
        'southwest': 225,
        'west': 270
    }
    if direction not in bearings:
        return 0.0
    latitude_value, longitude_value = (number(latitude), number(longitude))
    if latitude_value is None or longitude_value is None:
        return 0.0
    moment = moment.astimezone(timezone.utc)
    hour = moment.hour + moment.minute / 60 + moment.second / 3600
    angle = 2 * math.pi / 365 * (moment.timetuple().tm_yday - 1 + (hour - 12) / 24)
    equation = 229.18 * (7.5e-05 + 0.001868 * math.cos(angle) - 0.032077 * math.sin(angle) - 0.014615 * math.cos(2 * angle) - 0.040849 * math.sin(2 * angle))
    declination = 0.006918 - 0.399912 * math.cos(angle) + 0.070257 * math.sin(angle) - 0.006758 * math.cos(2 * angle) + 0.000907 * math.sin(2 * angle) - 0.002697 * math.cos(3 * angle) + 0.00148 * math.sin(3 * angle)
    hour_angle = math.radians((hour * 60 + equation + 4 * longitude_value) / 4 - 180)
    azimuth = (180 + math.degrees(math.atan2(
        math.sin(hour_angle),
        math.cos(hour_angle) * math.sin(math.radians(latitude_value)) - math.tan(declination) * math.cos(math.radians(latitude_value))
    ))) % 360
    return max(0, math.cos(math.radians(azimuth - bearings[direction])))


def solar_enabled(room):
    return room.get('solar_direction', 'disabled') != 'disabled'


def solar_exposure_factor(room):
    return {'clear': 1.0, 'partly_shaded': 0.65, 'mostly_shaded': 0.3}.get(room.get('solar_exposure', 'clear'), 0.0)


def solar_gain(model, signal, enabled=True):
    value = number(signal)
    coefficient = number(model.get('solar_gain'), 0)
    return min(0.5, max(0, coefficient)) * max(0, min(1, value)) if enabled and value is not None else 0.0


def learn_solar(model, previous, current, dt, residual):
    """Fit unexplained sunshine warming only with no heating or residual slab response."""
    signal = number(previous.get('solar'))
    if signal is None or signal < 0.1 or current.get('solar') is None or (previous['activity'] != 0) or (model['response'] > 0.05):
        return
    stat = model.setdefault('solar_statistics', {'xx': 0.0, 'xz': 0.0, 'hours': 0.0})
    stat['xx'] = 0.999 * stat['xx'] + signal * signal * dt
    stat['xz'] = 0.999 * stat['xz'] + signal * residual * dt
    stat['hours'] += dt
    if stat['hours'] < 12 or model.get('idle_hours', 0) < 12 or model.get('heated_hours', 0) < 12:
        return
    fit = max(0, min(0.5, stat['xz'] / (stat['xx'] + 12)))
    model['solar_gain'] = 0.98 * model.get('solar_gain', 0) + 0.02 * fit
    model['solar_updates'] = model.get('solar_updates', 0) + 1


def heat_retention(
    model: dict[str, Any], room: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Compare rooms at 20°C indoors and -10°C outdoors, with heating off.

    Loss combines heat leakage and thermal mass. Background gains and residual
    heating are excluded so the result compares models, not actual energy use.
    """
    loss = number(model.get('loss'))
    if loss is None or loss <= 0:
        return None
    drop_after_six_hours = 30 * -math.expm1(-loss * 6)
    hours_per_degree = -math.log(29 / 30) / loss
    reference = cooling_reference(room) or {} if room else {}
    # Older saved models predate the explicit update counter. Preserve their
    # learned badge only when the old evidence and changed-coefficient tests pass.
    legacy_learned = (
        'parameter_updates' not in model and abs(loss - .007) > 1e-9
        and model.get('heated_hours', 0) >= 12 and model.get('idle_hours', 0) >= 12
    )
    updated = (bool(model.get('retention_learned'))
               or model.get('parameter_updates', 0) > 0 or legacy_learned)
    return {
        **reference,
        'drop_6h': round(drop_after_six_hours, 3),
        'hours_per_degree': round(hours_per_degree, 2),
        'indoor': 20, 'outdoor': -10,
        'heating_hours': round(model.get('heated_hours', 0), 1),
        'idle_hours': round(model.get('idle_hours', 0), 1),
        'updated': updated,
    }


def learning_progress(model: dict[str, Any], now: datetime) -> dict[str, Any]:
    """Estimate evidence collection time, never readiness to enable control.

    Both heating and idle observations must reach their thresholds. Use only the
    last week for collection-rate estimates, and avoid extrapolating before one
    full day or when a still-needed type of observation has not been seen.
    """
    heating_hours = max(0, model.get('heated_hours', 0))
    idle_hours = max(0, model.get('idle_hours', 0))
    remaining_heat = max(0, 12 - heating_hours)
    remaining_idle = max(0, 12 - idle_hours)
    percent = 100 * (min(12, heating_hours) + min(12, idle_hours)) / 24
    rates = [row for row in model.get('learning_rates', [])
             if row['time'] >= now.timestamp() - 7 * 86400]
    since = model.get('learning_rate_since')
    elapsed = 0
    if since is not None:
        elapsed = now.timestamp() - max(since, now.timestamp() - 7 * 86400)
    estimated_days = None
    complete = remaining_heat == 0 and remaining_idle == 0
    if complete:
        estimated_days = 0
    elif elapsed >= 86400:
        heating_rate = sum(row['heat'] for row in rates) / (elapsed / 86400)
        idle_rate = sum(row['idle'] for row in rates) / (elapsed / 86400)
        can_estimate_heating = not remaining_heat or heating_rate > 0
        can_estimate_idle = not remaining_idle or idle_rate > 0
        if can_estimate_heating and can_estimate_idle:
            heating_days = remaining_heat / heating_rate if remaining_heat else 0
            idle_days = remaining_idle / idle_rate if remaining_idle else 0
            estimated_days = round(max(heating_days, idle_days), 1)
    estimated_completion = None
    if estimated_days is not None and (remaining_heat or remaining_idle):
        estimated_completion = (now + timedelta(days=estimated_days)).isoformat()
    return {
        'percent': round(percent, 1),
        'heating_hours': round(heating_hours, 1), 'idle_hours': round(idle_hours, 1),
        'required_hours_each': 12, 'initial_complete': complete,
        'estimated_days_to_initial': estimated_days,
        'estimated_initial_completion': estimated_completion,
        'rate_history_hours': round(elapsed / 3600, 1),
    }


def learn(
    model: dict[str, Any], room: dict[str, Any], previous: dict[str, Any],
    current: dict[str, Any], enabled: bool = True,
) -> float | None:
    """Validate one step, then fit loss/gain only from accepted observations.

    The validation prediction uses parameters known before the new measurement.
    Excluded or paused observations can update that validation and residual heat,
    but cannot teach new parameters. Persisted regression keys remain unchanged.
    """
    room = {**DEFAULTS, **room}
    elapsed_hours = (current['time'] - previous['time']) / 3600
    if not 0.05 <= elapsed_hours <= 0.5 or previous.get('activity') is None:
        return None
    response, average_response = response_step(
        model['response'], previous['activity'], elapsed_hours, response_lag(room, model)
    )
    temperature_gap = previous['outdoor'] - previous['temperature']
    heating_input = average_response * previous.get('water_factor', 1.0)
    prediction = previous['temperature'] + elapsed_hours * (
        effective_loss(model, previous.get('wind')) * temperature_gap
        + model['gain'] * heating_input + model.get('base_gain', 0)
        + solar_gain(model, previous.get('solar'), solar_enabled(room))
    )
    model['response'] = response
    error = abs(prediction - current['temperature'])
    if model['mae'] is None:
        model['mae'] = error
    else:
        model['mae'] = 0.95 * model['mae'] + 0.05 * error
    if not enabled or previous.get('excluded') or current.get('excluded'):
        return prediction

    temperature_rate = (
        (current['temperature'] - previous['temperature']) / elapsed_hours
        - model.get('base_gain', 0)
    )
    if abs(temperature_rate) > 2:
        return prediction
    observed_temperature_rate = temperature_rate
    temperature_rate -= (
        effective_loss(model, previous.get('wind')) - model['loss']
    ) * temperature_gap
    model['samples'] += 1
    model['heated_hours'] += elapsed_hours * previous['activity']
    model['idle_hours'] += elapsed_hours * (1 - previous['activity'])
    model.setdefault('learning_rate_since', previous['time'])

    # Hourly evidence buckets estimate collection time, not model reliability.
    bucket = math.floor(previous['time'] / 3600) * 3600
    rates = [row for row in model.get('learning_rates', [])
             if row['time'] >= current['time'] - 7 * 86400]
    rate_bucket = next((row for row in rates if row['time'] == bucket), None)
    if rate_bucket is None:
        rate_bucket = {'time': bucket, 'heat': 0.0, 'idle': 0.0}
        rates.append(rate_bucket)
    rate_bucket['heat'] += elapsed_hours * previous['activity']
    rate_bucket['idle'] += elapsed_hours * (1 - previous['activity'])
    model['learning_rates'] = rates

    if solar_enabled(room):
        residual = (
            observed_temperature_rate
            - effective_loss(model, previous.get('wind')) * temperature_gap
            - model['gain'] * heating_input
        )
        learn_solar(model, previous, current, elapsed_hours, residual)
        # Unknown or present sunshine would be misattributed to ordinary heat loss.
        if (previous.get('solar') is None or current.get('solar') is None
                or previous.get('solar', 0) > 0 or current.get('solar', 0) > 0):
            return prediction

    # Accumulate the normal equations for temperature_rate = loss*x + gain*y.
    # Keep the historical x/y/z storage keys so older learned state still loads.
    decay = 0.999
    contributions = (
        ('xx', temperature_gap * temperature_gap),
        ('xy', temperature_gap * heating_input),
        ('yy', heating_input * heating_input),
        ('xz', temperature_gap * temperature_rate),
        ('yz', heating_input * temperature_rate),
    )
    for key, value in contributions:
        model[key] = decay * model[key] + value * elapsed_hours

    # Ridge regularization anchors weak evidence to the starting estimates.
    prior = initial_model(room)
    loss_square_sum = model['xx'] + 200
    heating_square_sum = model['yy'] + 20
    cross_sum = model['xy']
    loss_rate_sum = model['xz'] + 200 * prior['loss']
    heating_rate_sum = model['yz'] + 20 * prior['gain']
    determinant = loss_square_sum * heating_square_sum - cross_sum * cross_sum
    if model['heated_hours'] >= 12 and model['idle_hours'] >= 12 and (determinant > 1):
        fitted_loss = (loss_rate_sum * heating_square_sum - heating_rate_sum * cross_sum) / determinant
        fitted_gain = (heating_rate_sum * loss_square_sum - loss_rate_sum * cross_sum) / determinant
        if 0.001 <= fitted_loss <= 0.05 and 0.03 <= fitted_gain <= 3:
            model['loss'] = 0.98 * model['loss'] + 0.02 * fitted_loss
            model['gain'] = 0.98 * model['gain'] + 0.02 * fitted_gain
            model['parameter_updates'] = model.get('parameter_updates', 0) + 1

    learn_air_response_lag(model, room, previous, current, elapsed_hours)
    wind = previous.get('wind') if current.get('wind') is not None else None
    learn_wind(
        model,
        room,
        temperature_gap,
        heating_input,
        observed_temperature_rate,
        wind,
        elapsed_hours
    )
    return prediction


def thermostat_timing(rows, settings, baseline, now):
    """Separate intended heat-delivery sessions from advance thermostat commands."""
    sessions = []
    for row in rows:
        if not row['heat']:
            continue
        if sessions and sessions[-1]['end'] == row['start']:
            sessions[-1]['end'] = row['end']
        else:
            sessions.append({'start':row['start'], 'end':row['end']})
    committed = settings.get('committed_session')
    if committed:
        start, end = (stamp(committed['start']), stamp(committed['end']))
        # Rows are clipped to now; retain the original start only while the
        # same run continues. A later boost must not bridge a newly planned pause.
        for session in sessions:
            if (stamp(session['start']) < end and stamp(session['end']) > start
                    and stamp(session['start']) <= max(now, start)):
                session['start'] = min(start, stamp(session['start'])).isoformat()
                break
    windows = []
    for session in sessions:
        start = stamp(session['start']) - timedelta(minutes=settings['start_offset_minutes'])
        end = stamp(session['end']) - timedelta(minutes=settings['stop_offset_minutes'])
        if end <= start:
            continue  # A clipped session may already be past its closing command.
        if windows and start <= stamp(windows[-1]['end']):
            windows[-1]['end'] = max(stamp(windows[-1]['end']), end).isoformat()
        else:
            windows.append({'start':start.isoformat(), 'end':end.isoformat()})
    boosted = min(settings['maximum'], baseline + settings['boost'])
    reduced = max(settings['minimum'], baseline + settings['setback'])
    explicit_modes = any(('mode' in row for row in rows))
    default_mode = 'normal' if explicit_modes else 'reduced'
    targets = {'boost': boosted, 'reduced': reduced, 'normal': baseline}
    events = {}
    for row in rows:
        if not row['heat']:
            events[stamp(row['start'])] = row.get('mode', 'reduced')
    for window in windows:
        end = stamp(window['end'])
        following = next((row for row in rows if not row['heat'] and stamp(row['start']) >= end), None)
        # Current plans return to baseline after boost. Legacy two-state plans
        # retain the following reduced mode when no explicit normal mode exists.
        if explicit_modes:
            events[end] = 'normal'
        elif following:
            events[end] = following.get('mode', 'reduced')
        else:
            events[end] = default_mode
        events[stamp(window['start'])] = 'boost'
    if explicit_modes and rows:
        events[stamp(rows[-1]['end'])] = 'normal'
    commands = []
    previous = default_mode
    for moment,mode in sorted(events.items()):
        if any((stamp(window['start']) <= moment < stamp(window['end']) for window in windows)):
            mode = 'boost'
        if mode == previous:
            continue
        commands.append({'time':moment.isoformat(),'setpoint':round(targets[mode],2),
                         'action':{'boost':'raise','reduced':'lower','normal':'restore'}[mode],'mode':mode})
        previous = mode
    timing = {'sessions':sessions,'thermostat_windows':windows,'commands':commands,
              'boosted_setpoint':boosted,'reduced_setpoint':reduced,'normal_setpoint':baseline,
              'default_mode':default_mode}
    return {**timing, **thermostat_state(timing, now)}


def thermostat_state(timing, now):
    active = any((stamp(window['start']) <= now < stamp(window['end']) for window in timing['thermostat_windows']))
    if 'default_mode' not in timing:
        return {'heat':active,'mode':'boost' if active else 'reduced',
                'setpoint':round(timing['boosted_setpoint'] if active else timing['reduced_setpoint'],2)}
    mode = timing['default_mode']
    for command in timing['commands']:
        if stamp(command['time']) <= now:
            mode = command['mode']
    target = {
        'boost': timing['boosted_setpoint'],
        'reduced': timing['reduced_setpoint'],
        'normal': timing['normal_setpoint']
    }[mode]
    return {'heat': mode == 'boost', 'mode': mode, 'setpoint': round(target, 2)}


def plan(
    room: dict[str, Any], model: dict[str, Any], temperature: float,
    outdoor: list[float], slots: list[Slot], now: datetime, baseline: float,
    water_factor: float = 1.0, fireplace: bool = False,
) -> dict[str, Any] | None:
    """Search a bounded set of schedules, preferring safety, comfort, then cost.

    Costs are normalized to one kW of heating input. The first interval uses only
    its remaining duration. A final coasting forecast discourages schedules that
    use all stored warmth just as the confirmed electricity prices run out.
    """
    room = {**DEFAULTS, **room}
    if not slots:
        return None

    committed = room.get('committed_session')
    committed_start = stamp(committed['start']) if committed else None
    published_end = stamp(committed['end']) if committed else None
    loss = model['loss']
    gain = model['gain']
    if fireplace:
        loss *= 1 + room['fireplace_reduction'] / 100

    minimum_run = room.get('minimum_run_minutes', 60) / 60
    # Protect the minimum run, not every hour of an earlier forecast. Locking
    # the whole session prevents new measurements/prices from shortening it;
    # adjacent future boosts can then keep extending that commitment on replans.
    committed_end = None
    if committed:
        committed_end = min(published_end, committed_start + timedelta(hours=minimum_run))
    minimum_pause = max(15, room.get('minimum_pause_minutes', 15))
    # The pause applies to thermostat targets, including advance valve commands.
    if minimum_pause:
        pause_hours = max(
            0,
            minimum_pause + room.get('start_offset_minutes', 0)
            - room.get('stop_offset_minutes', 0),
        ) / 60
    else:
        pause_hours = 0
    resume_after = stamp(room['boost_resume_after']) if room.get('boost_resume_after') else None
    previously_heating = room.get('previous_suggested_heat', False)
    run_hours = room.get('previous_run_hours', 0.0) if previously_heating else 0.0
    default_previous_mode = 'boost' if previously_heating else 'normal'
    previous_mode = room.get('previous_control_mode', default_previous_mode)
    initial_mode = {'normal': 0, 'reduced': 1, 'boost': 2}.get(previous_mode, 0)
    if resume_after is not None and now < resume_after:
        # The advance-closing command can end a boost before heat delivery ends.
        initial_mode = 0
        previously_heating = False
    if not previously_heating:
        previous_pause = max(0, room.get('previous_pause_hours', pause_hours))
        run_hours = -min(pause_hours, previous_pause)

    known_prices = sorted((slot.price for slot in slots))
    middle = len(known_prices) // 2
    high_price = (known_prices[(len(known_prices) - 1) // 2] + known_prices[middle]) / 2
    reduction_available = bool(room.get('reduction_available', previous_mode in ('boost', 'reduced')))
    # Candidate fields: limit violations, comfort deficit, cost, temperature,
    # residual heating response, mode, signed run duration, reduction credit, path.
    # A negative duration tracks the pause since the last boosted target.
    beam = [(0.0, 0.0, 0.0, temperature, model['response'], initial_mode,
             run_hours, reduction_available, [])]
    for slot_index, slot in enumerate(slots):
        hours = (slot.end - max(now, slot.start)).total_seconds() / 3600
        if hours <= 0:
            continue
        candidates = []
        wind = number(room.get('wind_speed'))
        if wind is not None:
            wind = 3 + (wind - 3) * math.exp(-(slot.start - now).total_seconds() / 10800)
        solar_values = room.get('solar_forecast', [])
        solar_signal_value = solar_values[slot_index] if slot_index < len(solar_values) else None
        slot_solar = .5 * solar_exposure_factor(room) * solar_gain(
            model, solar_signal_value, solar_enabled(room)
        )
        slot_loss = effective_loss(model, wind)
        if fireplace:
            slot_loss *= 1 + room['fireplace_reduction'] / 100

        for (violation, shortfall, cost, current_temperature, response,
             last_mode, run_duration, reduction_credit, path) in beam:
            for mode in (0, 1, 2):
                boosted = mode == 2
                if mode == 1 and (
                    not reduction_credit or last_mode == 2
                    or response <= .05 or slot.price <= high_price
                ):
                    # A reduced target spends stored warmth after an earlier boost.
                    continue
                committed_now = (
                    committed_start is not None
                    and slot.end > committed_start
                    and max(now, slot.start) < committed_end
                )
                if committed_now and (not boosted):
                    # Once valve opening begins, finish the protected minimum run.
                    continue
                opening = max(now, slot.start) - timedelta(
                    minutes=room.get('start_offset_minutes', 0)
                )
                pause_blocked = (
                    (last_mode != 2 and -run_duration < pause_hours - 1e-6)
                    or (resume_after is not None and opening < resume_after)
                )
                if boosted and pause_blocked and (not committed_now):
                    continue
                if not boosted and last_mode == 2 and (run_duration < minimum_run - 1e-06):
                    continue
                remaining_hours = (slots[-1].end - max(now, slot.start)).total_seconds() / 3600
                if (boosted and last_mode != 2 and current_temperature > room['minimum']
                        and remaining_hours < minimum_run):
                    continue
                if (not boosted and current_temperature <= room['minimum']
                        and not (mode == 0 and pause_blocked)):
                    # Baseline thermostat demand remains available during boost pauses.
                    continue

                if boosted:
                    requested_target = min(room['maximum'], baseline + room['boost'])
                elif mode == 1:
                    requested_target = max(room['minimum'], baseline + room['setback'])
                else:
                    requested_target = baseline
                # Boost mode is a target, not proof that a thermostat relay is on.
                # Garage cycling instead follows the explicit heat/no-heat choice.
                if room.get('is_garage'):
                    demand = boosted
                else:
                    demand = current_temperature < requested_target
                    if (boosted and not demand and not committed_now
                            and (last_mode != 2 or run_duration >= minimum_run - 1e-6)):
                        # Above the boosted target this mode adds no heat. Without
                        # this guard, avoiding a target-change penalty can keep an
                        # unnecessary boost displayed for the entire horizon.
                        continue
                within_air_limit = not room.get('air_control') or current_temperature < room['maximum']
                heating = 1.0 if demand and within_air_limit else 0.0
                next_response, average_response = response_step(
                    response, heating, hours, response_lag(room, model)
                )
                predicted = current_temperature + hours * (
                    slot_loss * (outdoor[slot_index] - current_temperature)
                    + gain * water_factor * average_response
                    + model.get('base_gain', 0) + slot_solar
                )
                if mode == 1 and predicted < baseline:
                    continue

                below_limit = max(0, room['minimum'] - predicted)
                above_limit = max(0, predicted - room['maximum'])
                next_violation = violation + hours * (below_limit + above_limit)
                next_shortfall = shortfall + hours * max(0, baseline - predicted)
                # Preserve score priority: limit violations and comfort shortfall
                # are separate tuple fields, ahead of this price/switching score.
                next_cost = (
                    cost + slot.price * heating * hours
                    + .3 * abs(boosted - (last_mode == 2))
                    + .02 * (mode != last_mode)
                    + .15 * hours * (predicted - baseline) ** 2
                    - (.03 * hours if mode == 1 else 0)
                )
                if room.get('air_control'):
                    scheduled_heat = bool(heating)
                else:
                    scheduled_heat = bool(boosted)
                next_reduction_credit = bool(
                    boosted or (reduction_credit and predicted >= baseline and next_response > .05)
                )
                row = {
                    'start': max(slot.start, now).isoformat(),
                    'end': slot.end.isoformat(),
                    'price': round(slot.price, 3),
                    'outdoor': round(outdoor[slot_index], 2),
                    'solar_gain': round(slot_solar, 4),
                    'heat': scheduled_heat,
                    'mode': ('normal', 'reduced', 'boost')[mode],
                    'reduction_available': next_reduction_credit,
                    'predicted_demand': bool(heating),
                    'temperature': round(predicted, 3),
                    'setpoint': round(requested_target, 2),
                }
                if boosted:
                    elapsed_run = run_duration if last_mode == 2 else 0
                    next_run_duration = min(minimum_run, elapsed_run + hours)
                else:
                    elapsed_pause = -run_duration if last_mode != 2 else 0
                    next_run_duration = -min(pause_hours, elapsed_pause + hours)
                candidates.append((
                    next_violation, next_shortfall, next_cost, predicted, next_response,
                    mode, next_run_duration, row['reduction_available'], path + [row],
                ))

        # Retain different thermal states, not just many near-identical cheap paths.
        unique = {}
        ordered_candidates = sorted(
            candidates, key=lambda candidate: (round(candidate[0], 6), round(candidate[1], 6), candidate[2])
        )
        for candidate in ordered_candidates:
            state_bucket = (
                round(candidate[3] * 20), round(candidate[4] * 20),
                candidate[5], round(candidate[6] * 4), candidate[7],
            )
            if state_bucket not in unique:
                unique[state_bucket] = candidate
        beam = list(unique.values())[:80]

    def terminal(candidate):
        """Score remaining warmth after coasting beyond confirmed prices."""
        (violation, shortfall, cost, final_temperature, response,
         last_mode, run_duration, reduction_credit, path) = candidate
        reserve = min(12, room.get('terminal_reserve_hours', 6))
        _, average_response = response_step(response, 0, max(0.1, reserve), response_lag(room, model))
        after_reserve = final_temperature + reserve * (
            loss * (outdoor[-1] - final_temperature)
            + gain * water_factor * average_response + model.get('base_gain', 0)
        )
        return (
            round(violation + max(0, room['minimum'] - after_reserve) * reserve, 6),
            round(shortfall + max(0, baseline - after_reserve) * reserve, 6),
            cost,
        )

    best = min(beam, key=terminal)
    rows = best[-1]
    if not rows:
        return None
    risk = best[0] > 0.01 or terminal(best)[0] > 0.01
    timing = thermostat_timing(rows, room, baseline, now)
    forecast_minimum = min((row['temperature'] for row in rows))
    forecast_maximum = max((row['temperature'] for row in rows))
    suggested_hours = sum(
        (stamp(row['end']) - stamp(row['start'])).total_seconds() / 3600
        for row in rows if row['heat']
    )
    demand_hours = sum(
        (stamp(row['end']) - stamp(row['start'])).total_seconds() / 3600
        for row in rows if row['predicted_demand']
    )
    if demand_hours:
        explanation = 'No boost planned: normal thermostat demand is sufficient to support the room target.'
    else:
        explanation = (
            f"No heating planned: lowest forecast {forecast_minimum:.1f}°C; "
            f"room target {baseline:.1f}°C; minimum limit {room['minimum']:.1f}°C."
        )
    if risk:
        reason = 'Temperature limit risk: review model assumptions and heating capacity.'
    elif rows[0]['heat']:
        reason = 'Heat storage or a bridging run ahead of predicted cooling.'
    elif suggested_hours:
        reason = 'Heating is planned later; no boost is suggested now.'
    else:
        reason = explanation
    return {
        'slots': rows,
        'scheduled_heat': rows[0]['heat'],
        'scheduled_mode': rows[0]['mode'],
        'reduction_available': rows[0]['reduction_available'],
        **timing,
        'forecast_minimum': forecast_minimum,
        'forecast_maximum': forecast_maximum,
        'comfort_floor': room['minimum'],
        'comfort_target': baseline,
        'target_shortfall_degree_hours': round(best[1], 3),
        'suggested_heating_hours': round(suggested_hours, 2),
        'predicted_demand_hours': round(demand_hours, 2),
        'reason': reason,
        'comfort_risk': risk,
        'violation_degree_hours': round(best[0], 3),
        'known_price_hours': round(
            sum((stamp(row['end']) - stamp(row['start'])).total_seconds() / 3600 for row in rows),
            2
        ),
        'curve_hours': round(curve_hours(room, min(outdoor)), 1),
    }


def collection_state(previous, outdoor, timestamp, config):
    """Collection follows the master switch and requires a valid outdoor reading."""
    state = dict(previous or {})
    state.pop('average', None)
    state.update(time=timestamp, active=bool(config['heating_enabled']),
                 collecting=bool(config['heating_enabled'] and outdoor is not None))
    return state


def fallback_season(
    previous,
    forecasts,
    forecast_type,
    outdoor,
    now,
    zone,
    threshold=6.0,
    latitude=None
):
    """Prefer local temperature evidence; hemisphere supplies only a warm-weather prior."""
    local = now.astimezone(zone)
    date = local.date().isoformat()
    days = {key:dict(value) for key,value in (previous or {}).get('days',{}).items()
            if abs((local.date()-date_type.fromisoformat(key)).days)<=3}
    for item in forecasts:
        moment = stamp(item.get('datetime'))
        value = number(item.get('templow') if forecast_type == 'daily' else item.get('templow', item.get('temperature')) if forecast_type == 'twice_daily' else item.get('temperature'))
        if moment is None or value is None:
            continue
        point = moment.astimezone(zone)
        key = point.date().isoformat()
        day = days.setdefault(key, {})
        day['low'] = min(day.get('low', value), value)
        hour = point.hour + point.minute / 60
        day['first_hour'] = min(day.get('first_hour', hour), hour)
        day['last_hour'] = max(day.get('last_hour', hour), hour)
        if forecast_type == 'daily':
            day['complete'] = True
        elif forecast_type == 'twice_daily':
            day['complete'] = day['first_hour'] <= 6 and day['last_hour'] >= 18
        else:
            points = day.setdefault('points', [])
            if moment.timestamp() not in points:
                points.append(moment.timestamp())
                points.sort()
            if day['first_hour'] <= 0 and day['last_hour'] >= 23 and all((b - a <= 5400 for a, b in zip(points, points[1:]))):
                day['complete'] = True
    today = days.setdefault(date, {})
    if outdoor is not None:
        today['low'] = min(today.get('low', outdoor), outdoor)
    latitude = number(latitude)
    if latitude is not None and (not -90 <= latitude <= 90):
        latitude = None
    # Calendar seasons are only a rough prior. In tropical locations, a
    # northern/southern summer calendar is especially unhelpful: require weather.
    calendar_summer=bool(latitude is not None and abs(latitude)>=23.44 and
                         (local.month in (6,7,8) if latitude>0 else local.month in (12,1,2)))
    low = today.get('low')
    if low is not None and low < threshold:
        summer = False
        basis = 'cold_temperature'
    elif today.get('complete') and low is not None:
        summer = True
        basis = 'daily_temperature'
    elif calendar_summer and outdoor is not None and (outdoor >= threshold):
        summer = True
        basis = 'location_estimate'
    else:
        summer = False
        basis = 'insufficient_evidence'
    return {'summer':summer,'date':date,'daily_minimum':low,
            'complete':bool(today.get('complete')),'days':days,'basis':basis}


def garage_cycle_plan(room, model, temperature, outdoors, slots, now, heating=False):
    """Temperature-only garage shadow forecast; no tariff decisions or valve offsets."""
    response = model['response']
    rows = []
    for slot,outdoor in zip(slots,outdoors):
        start = max(slot.start, now)
        hours = (slot.end - start).total_seconds() / 3600
        if hours <= 0:
            continue
        if outdoor > room['minimum'] or temperature >= room['maximum']:
            heating = False
        elif temperature < room['minimum']:
            heating = True
        response, average = response_step(response, float(heating), hours, response_lag(room, model))
        temperature += hours * (effective_loss(model, room.get('wind_speed')) * (outdoor - temperature) + model['gain'] * average + model.get('base_gain', 0))
        rows.append({
            'start':start.isoformat(),
            'end':slot.end.isoformat(),
            'price':slot.price,
            'outdoor':outdoor,
            'heat':heating,
            'mode':'boost' if heating else 'normal',
            'predicted_demand':heating,
            'temperature':round(temperature,3),
            'setpoint':room['garage_heat_target'] if heating else room['minimum']
        })
    if not rows:
        return None
    timing = thermostat_timing(
        rows,
        {**room, 'start_offset_minutes': 0, 'stop_offset_minutes': 0},
        room['minimum'],
        now
    )
    return {
        'slots': rows,
        'scheduled_heat': rows[0]['heat'],
        'scheduled_mode': rows[0]['mode'],
        'reduction_available': False,
        **timing,
        'forecast_minimum': min((r['temperature'] for r in rows)),
        'forecast_maximum': max((r['temperature'] for r in rows)),
        'comfort_floor': room['minimum'],
        'comfort_target': room['minimum'],
        'reason': 'Garage temperature cycle: heat below the lower limit; fan-only after the upper limit. Warm weather turns the pump off.',
        'comfort_risk': False,
        'predicted_demand_hours': sum(((stamp(r['end']) - stamp(r['start'])).total_seconds() / 3600 for r in rows if r['heat']))
    }
