"""Learn an air-to-water heat pump's COP from local observations."""

from bisect import bisect_left
from collections import defaultdict
from dataclasses import dataclass, replace
from datetime import datetime
from math import floor
from statistics import mean, median, quantiles
from typing import Any

from .model import Slot, number, stamp

COP_SAMPLE_SECONDS = 900
COP_READING_SECONDS = 300
COP_HISTORY_DAYS = 30
COP_BAND_WIDTH = 2
COP_MIN_SAMPLE_HOURS = 3
COP_MAX_MODEL_GAP = 6
COP_CONFIRMATION_THRESHOLD = 5.0
COP_MAX_READING = 10.0
COP_NEIGHBOR_RATIO = 0.8
COP_INITIAL_HISTORY_SECONDS = 7 * 86400
COP_INITIAL_CURVE = ((-20, 1.0), (-15, 1.5), (0, 3.5))
COP_FORECAST_INTERVAL_SECONDS = 3600
TARIFF_PREFERENCE = 0.10
COP_UNITS = {'', '1', 'cop', 'x', '×', 'w/w', 'kw/kw'}


@dataclass(frozen=True)
class CopBand:
    temperature: float
    minimum_temperature: float
    maximum_temperature: float
    cop: float
    lower_cop: float
    upper_cop: float


def cop_report_time(state: Any) -> float | None:
    """Identify the source report even when ThermalPilot samples it twice."""
    reported = getattr(state, 'last_reported', None) or getattr(state, 'last_updated', None)
    return reported.timestamp() if reported is not None else None


def read_cop(state: Any, now: float) -> float | None:
    """Read a recent, positive, dimensionless COP while the pump is operating."""
    if state is None:
        return None
    value = number(state.state)
    unit = str(state.attributes.get('unit_of_measurement') or '').strip().lower()
    percent = unit == '%' and state.attributes.get('device_class') == 'power_factor'
    if value is None or value <= 0 or (unit not in COP_UNITS and not percent):
        return None
    cop = value / 100 if percent else value
    reported = cop_report_time(state)
    if reported is not None and not 0 <= now - reported <= 2 * COP_SAMPLE_SECONDS:
        return None
    return cop if 0 < cop <= COP_MAX_READING else None


def similar_cop(first: float, second: float) -> bool:
    return min(first, second) >= COP_NEIGHBOR_RATIO * max(first, second)


def summarize_cop_interval(bucket: int, samples: list[dict]) -> dict:
    """Pair a robust COP estimate with the outdoor temperature of its inputs."""
    ordered = sorted(samples, key=lambda sample: sample['cop'])
    if len(ordered) > 1:
        highest = ordered[-1]['cop']
        # A median of two points would still include half of a spike. Remove
        # an isolated high reading before averaging its outdoor temperature.
        if highest > COP_CONFIRMATION_THRESHOLD and not similar_cop(highest, ordered[-2]['cop']):
            ordered.pop()

    summary = {
        'time': bucket, 'cop': round(median(sample['cop'] for sample in ordered), 2),
        'outdoor': round(mean(sample['outdoor'] for sample in ordered), 2),
    }
    reports = [sample['reported'] for sample in ordered if 'reported' in sample]
    if reports:
        summary['reported'] = max(reports)
    return summary


def filter_cop_readings(readings: list[dict]) -> list[dict]:
    """Use high readings only when an adjacent sample supports them."""
    accepted = []
    for index, reading in enumerate(readings):
        cop = reading['cop']
        if not 0 < cop <= COP_MAX_READING:
            continue
        if cop <= COP_CONFIRMATION_THRESHOLD:
            accepted.append(reading)
            continue

        # A brief spike can land on a sampling boundary. A similar reading
        # from a separate report in the next or previous interval supports it.
        neighbors = readings[max(0, index - 1):index] + readings[index + 1:index + 2]
        reported = reading.get('reported')
        for neighbor in neighbors:
            if abs(reading['time'] - neighbor['time']) != COP_SAMPLE_SECONDS:
                continue
            if reported is not None and reported == neighbor.get('reported'):
                continue
            other_cop = neighbor['cop']
            if 0 < other_cop <= COP_MAX_READING and similar_cop(cop, other_cop):
                accepted.append(reading)
                break
    return accepted


def initial_cop(outdoor: float) -> float:
    """Interpolate between the starting points and hold the outer values."""
    coldest, coldest_cop = COP_INITIAL_CURVE[0]
    if outdoor <= coldest:
        return coldest_cop
    for (low, low_cop), (high, high_cop) in zip(COP_INITIAL_CURVE, COP_INITIAL_CURVE[1:]):
        if outdoor <= high:
            fraction = (outdoor - low) / (high - low)
            return low_cop + fraction * (high_cop - low_cop)
    return COP_INITIAL_CURVE[-1][1]


def learned_cop_bands(observations: list[dict]) -> list[CopBand]:
    """Wait for a week of history before using well-sampled temperature bands."""
    if not observations:
        return []
    times = [row['time'] for row in observations]
    if max(times) - min(times) < COP_INITIAL_HISTORY_SECONDS:
        return []
    bands = defaultdict(list)
    for row in observations:
        band = floor(row['outdoor'] / COP_BAND_WIDTH)
        bands[band].append(row)

    anchors = []
    for band in sorted(bands):
        rows = bands[band]
        if len({row['time'] // 3600 for row in rows}) < COP_MIN_SAMPLE_HOURS:
            continue
        temperatures = [row['outdoor'] for row in rows]
        lower_cop, typical_cop, upper_cop = quantiles(
            [row['cop'] for row in rows], method='inclusive'
        )
        anchors.append(CopBand(
            median(temperatures), min(temperatures), max(temperatures),
            typical_cop, lower_cop, upper_cop,
        ))
    return anchors


def forecast_cop(
    observations: list[dict], weather: list[dict], now: float, current_outdoor: float | None = None,
) -> list[dict]:
    """Use the learned curve where supported and the starting curve elsewhere."""
    anchors = learned_cop_bands(observations)
    temperatures = [anchor.temperature for anchor in anchors]
    hourly = []
    for row in weather:
        when = stamp(row['datetime'])
        if when is None:
            continue
        start = when.timestamp()
        if start + COP_FORECAST_INTERVAL_SECONDS > now:
            hourly.append((start, row['temperature']))
    hourly.sort()
    # Some providers start at the next whole hour. Use the outdoor reading
    # for the short lead-in only, so a weather outage cannot create a forecast.
    if hourly and current_outdoor is not None and now < hourly[0][0] <= now + COP_FORECAST_INTERVAL_SECONDS:
        hourly.insert(0, (now, current_outdoor))

    forecast = []
    for index, (start, outdoor) in enumerate(hourly):
        end = start + COP_FORECAST_INTERVAL_SECONDS
        if index + 1 < len(hourly):
            end = min(end, hourly[index + 1][0])
        if end <= now or end <= start:
            continue
        next_index = bisect_left(temperatures, outdoor)
        left = anchors[next_index - 1] if next_index else None
        right = anchors[next_index] if next_index < len(anchors) else None

        basis = 'learned'
        if left and right and right.temperature - left.temperature <= COP_MAX_MODEL_GAP:
            fraction = (outdoor - left.temperature) / (right.temperature - left.temperature)
            cop = left.cop + fraction * (right.cop - left.cop)
            lower = left.lower_cop + fraction * (right.lower_cop - left.lower_cop)
            upper = left.upper_cop + fraction * (right.upper_cop - left.upper_cop)
        elif left and left.minimum_temperature <= outdoor <= left.maximum_temperature:
            cop, lower, upper = left.cop, left.lower_cop, left.upper_cop
        elif right and right.minimum_temperature <= outdoor <= right.maximum_temperature:
            cop, lower, upper = right.cop, right.lower_cop, right.upper_cop
        else:
            basis = 'initial'
            cop = lower = upper = initial_cop(outdoor)
        forecast.append({
            'time': start, 'end': end, 'cop': round(cop, 2), 'outdoor': outdoor,
            'lower_cop': round(lower, 2), 'upper_cop': round(upper, 2), 'basis': basis,
        })
    return forecast


def cop_priced_slots(slots: list[Slot], forecast: list[dict], now: datetime) -> list[Slot]:
    """Add COP-adjusted heating rates to the parts of slots covered by a forecast."""
    if not slots or not forecast:
        return slots

    horizon_start = max(now, slots[0].start).timestamp()
    horizon_end = slots[-1].end.timestamp()
    estimates = {}
    for point in forecast:
        start, cop = point['time'], point['cop']
        end = point.get('end', start + COP_FORECAST_INTERVAL_SECONDS)
        if cop > 0 and start < horizon_end and end > horizon_start:
            estimates[start] = point
    if not estimates:
        return slots

    # Preserve the planner's existing scale for comfort and switching penalties.
    # Uncovered time keeps the tariff rate, equivalent to using this reference.
    reference_cop = median(point['cop'] for point in estimates.values())
    starts = sorted(estimates)
    intervals = []
    for index, start in enumerate(starts):
        point = estimates[start]
        end = point.get('end', start + COP_FORECAST_INTERVAL_SECONDS)
        if index + 1 < len(starts):
            end = min(end, starts[index + 1])
        # Only the part of the efficiency difference supported by the observed
        # middle half of COP readings changes the tariff ranking.
        lower = point.get('lower_cop', point['cop'])
        upper = point.get('upper_cop', point['cop'])
        planning_cop = max(lower, min(upper, reference_cop))
        intervals.append((start, end, reference_cop / planning_cop - 1))
    adjusted = []
    first_interval = 0
    for slot in slots:
        start = max(now, slot.start).timestamp()
        end = slot.end.timestamp()
        while first_interval < len(intervals) and intervals[first_interval][1] <= start:
            first_interval += 1
        duration = end - start
        if duration <= 0:
            adjusted.append(slot)
            continue

        rate_adjustment = 0.0
        for index in range(first_interval, len(intervals)):
            forecast_start, forecast_end, cop_adjustment = intervals[index]
            if forecast_start >= end:
                break
            overlap = min(end, forecast_end) - max(start, forecast_start)
            # Blend the normalized heat cost with the tariff so near-ties
            # lean toward cheaper electricity without imposing a price cutoff.
            rate_adjustment += (1 - TARIFF_PREFERENCE) * slot.price * cop_adjustment * overlap / duration
        if rate_adjustment:
            slot = replace(slot, heating_cost_rate=slot.price + rate_adjustment)
        adjusted.append(slot)
    return adjusted
