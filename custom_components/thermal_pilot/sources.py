"""Normalize external source contracts before their values enter heating decisions.

Provider actions remain owned by their Home Assistant integrations. ThermalPilot
reads responses, never credentials or provider clients. Internal temperatures are
Celsius and confirmed electricity prices are euro cents per kWh.
"""
import asyncio
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from typing import Any

from .model import check_raw_price_count, number, price_slots, stamp

NATIVE_PRICE_SOURCES = ('nordpool', 'tibber')
PRICE_SOURCE_CHOICES = ('static', *NATIVE_PRICE_SOURCES)


def temperature_celsius(value: Any, unit: str = '°C') -> float | None:
    """Convert a boundary reading once; missing values remain missing."""
    value = number(value)
    if value is None:
        return None
    unit = str(unit).strip().lower()
    if unit in ('°c', 'c', 'celsius'):
        return value
    if unit in ('°f', 'f', 'fahrenheit'):
        return round((value - 32) * 5 / 9, 10)
    if unit in ('k', '°k', 'kelvin'):
        return round(value - 273.15, 10)
    raise ValueError('Unsupported temperature unit.')


def temperature_state_celsius(state: Any) -> float | None:
    """Read a sensor state in Celsius, treating unsupported units as unavailable."""
    if state is None:
        return None
    try:
        return temperature_celsius(state.state, state.attributes.get('unit_of_measurement', '°C'))
    except ValueError:
        return None


def normalize_weather(rows: Any, kind: str, unit: str, now: datetime) -> list[dict[str, Any]]:
    """Keep usable, recent forecasts in UTC/Celsius, without filling missing data."""
    if not isinstance(rows, list):
        return []
    maximum_age = {'hourly': 2, 'twice_daily': 12, 'daily': 24}[kind]
    result = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        moment = stamp(row.get('datetime'))
        if moment is None or not now - timedelta(hours=maximum_age) <= moment <= now + timedelta(days=8):
            continue
        temperature = temperature_celsius(row.get('temperature'), unit)
        low = temperature_celsius(row.get('templow'), unit)
        if temperature is None and (kind != 'daily' or low is None):
            continue
        normalized = {**row, 'datetime': moment.astimezone(timezone.utc).isoformat()}
        if temperature is not None:
            normalized['temperature'] = temperature
        if low is not None:
            normalized['templow'] = low
        result[moment] = normalized
    return [result[moment] for moment in sorted(result)]


def forecast_temperature(rows: list[dict[str, Any]], kind: str | None, moment: datetime,
                         tz: ZoneInfo, fallback: float | None) -> float | None:
    """Use forecasts only within their resolution; a gap uses the current reading."""
    candidates = []
    for row in rows:
        start = stamp(row['datetime'])
        if kind == 'daily':
            valid = start.astimezone(tz).date() == moment.astimezone(tz).date()
        else:
            hours = 2 if kind == 'hourly' else 12
            valid = start <= moment < start + timedelta(hours=hours)
        if valid:
            if kind == 'daily':
                value = number(row.get('templow', row.get('temperature')))
            else:
                value = number(row.get('temperature'))
            if value is not None:
                candidates.append((start, value))
    if not candidates:
        return fallback
    latest = max(candidates, key=lambda candidate: candidate[0])
    return latest[1]


def price_provider_options(hass: Any) -> dict[str, Any]:
    """Expose only entry labels/areas, never provider tokens or runtime objects."""
    entries = hass.config_entries.async_entries('nordpool')
    return {'nordpool_entries': [
        {'id': entry.entry_id, 'name': entry.title, 'areas': list(entry.data.get('areas', []))}
        for entry in entries
    ]}


def nordpool_rows(response: Any, area: str, vat: float, margin: float) -> list[dict[str, Any]]:
    """Official Nord Pool action: EUR/MWh spot → c/kWh with explicit additions."""
    rows = response.get(area) if isinstance(response, dict) else None
    if not isinstance(rows, list):
        raise ValueError('Unsupported price data format.')
    check_raw_price_count(len(rows))
    result = []
    for row in rows:
        if not isinstance(row, dict) or number(row.get('price')) is None:
            raise ValueError('Invalid price or timestamp in source list.')
        spot_cents = float(row['price']) / 10
        with_vat = spot_cents * (1 + vat / 100)
        total_cents = with_vat + margin
        result.append({'start': row.get('start'), 'end': row.get('end'), 'value': total_cents})
    return result


def tibber_rows(response: Any, nickname: str, unit: str) -> list[dict[str, Any]]:
    """Official Tibber action: select one home and infer its established cadence.

    Infer 15/60-minute resolution separately per local date. Missing intervals
    stay gaps; never stretch a preceding price across a missing reading.
    """
    if str(unit).lower() not in ('eur/kwh', '€/kwh'):
        raise ValueError('Select an available Tibber price sensor using EUR/kWh.')
    homes = response.get('prices') if isinstance(response, dict) else None
    rows = homes.get(nickname) if isinstance(homes, dict) else None
    if not isinstance(rows, list):
        raise ValueError('Select an available Tibber price sensor using EUR/kWh.')
    check_raw_price_count(len(rows))
    days = {}
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError('Unsupported price data format.')
        start, price = stamp(row.get('start_time')), number(row.get('price'))
        if start is None or price is None:
            raise ValueError('Invalid price or timestamp in source list.')
        days.setdefault(start.date(), []).append((start.astimezone(timezone.utc), price))
    result = []
    for points in days.values():
        points.sort(key=lambda point: point[0])
        if len(points) < 2:
            # The action supplies no end timestamp. One point cannot establish
            # whether it represents an hour or a quarter-hour.
            continue
        cadence = min((second[0] - first[0]).total_seconds() for first, second in zip(points, points[1:]))
        if cadence not in (900, 3600):
            raise ValueError('Unsupported price data format.')
        for start, price in points:
            result.append({'start': start.isoformat(), 'end': (start + timedelta(seconds=cadence)).isoformat(),
                           'value': price * 100})
    return result


class PriceSourceReader:
    """Cache read-only native actions across refreshes and command checkpoints."""
    def __init__(self, hass: Any) -> None:
        self.hass = hass
        self.cache = None

    async def read(self, settings: dict[str, Any], now: datetime) -> tuple[dict[str, Any], dict[str, Any], datetime | None]:
        source = settings['price_entity']
        if source not in NATIVE_PRICE_SOURCES:
            state = self.hass.states.get(source)
            if source == 'static':
                return {}, settings, now
            if state is None or state.state in ('unknown', 'unavailable'):
                raise ValueError('Price sensor is missing or unavailable.')
            return state.attributes, settings, getattr(state, 'last_updated', None)
        sensor = None
        if source == 'tibber':
            sensor = self.hass.states.get(settings['tibber_price_entity'])
            if (sensor is None or sensor.state in ('unknown', 'unavailable')
                    or not sensor.attributes.get('app_nickname')
                    or str(sensor.attributes.get('unit_of_measurement', '')).lower() not in ('eur/kwh', '€/kwh')):
                raise ValueError('Select an available Tibber price sensor using EUR/kWh.')
        key = [source, now.astimezone(ZoneInfo(self.hass.config.time_zone)).date().isoformat(),
               settings['nordpool_entry'], settings['nordpool_area'], settings['nordpool_vat'],
               settings['nordpool_margin'], settings['tibber_price_entity']]
        if sensor is not None:
            key += [sensor.attributes['app_nickname'], sensor.attributes['unit_of_measurement']]
        normalized_settings = {**settings, 'price_unit': 'c/kWh', 'price_entity': 'sensor.native_prices'}
        if self.cache and self.cache['key'] == key and 0 <= (now - self.cache['fetched']).total_seconds() < 300:
            return self.cache['attributes'], normalized_settings, self.cache['fetched']
        service = 'get_prices_for_date' if source == 'nordpool' else 'get_prices'
        if not self.hass.services.has_service(source, service):
            raise ValueError('The selected provider action is unavailable.')
        tz = ZoneInfo(self.hass.config.time_zone)
        day = now.astimezone(tz).date()
        rows = []
        try:
            async with asyncio.timeout(15):
                if source == 'nordpool':
                    entries = price_provider_options(self.hass)['nordpool_entries']
                    entry = next((item for item in entries if item['id'] == settings['nordpool_entry']), None)
                    if entry is None and not settings['nordpool_entry'] and len(entries) == 1:
                        entry = entries[0]
                    area = settings['nordpool_area']
                    if entry and not area and len(entry['areas']) == 1:
                        area = entry['areas'][0]
                    if entry is None or not area or area not in entry['areas']:
                        raise ValueError('Choose a Nord Pool integration and price area.')
                    for offset in (0, 1):
                        try:
                            response = await self.hass.services.async_call('nordpool', 'get_prices_for_date', {
                                'config_entry': entry['id'], 'date': (day + timedelta(days=offset)).isoformat(),
                                'areas': [area], 'currency': 'EUR',
                            }, blocking=True, return_response=True)
                        except Exception:
                            # Tomorrow is commonly unpublished; retain a valid
                            # current day instead of turning it into an outage.
                            if offset == 1 and rows:
                                continue
                            raise
                        day_rows = nordpool_rows(response, area, settings['nordpool_vat'], settings['nordpool_margin'])
                        check_raw_price_count(len(rows) + len(day_rows))
                        rows.extend(day_rows)
                else:
                    response = await self.hass.services.async_call('tibber', 'get_prices', {
                        'start': datetime.combine(day, datetime.min.time(), tzinfo=tz).isoformat(),
                        'end': datetime.combine(day + timedelta(days=2), datetime.min.time(), tzinfo=tz).isoformat(),
                    }, blocking=True, return_response=True)
                    rows = tibber_rows(response, sensor.attributes['app_nickname'], sensor.attributes.get('unit_of_measurement'))
        except ValueError:
            raise
        except Exception as error:
            # Provider-specific HA exceptions stop at this read-only boundary.
            raise ValueError('Source request failed; check the provider integration.') from error
        attributes = {'raw_today': rows}
        self.cache = {'key': key, 'attributes': attributes, 'fetched': now}
        return attributes, normalized_settings, now

    async def check(self, settings: dict[str, Any], now: datetime) -> dict[str, Any]:
        """Return an identifier-free diagnostic summary; never save or run control."""
        try:
            attributes, normalized, updated = await self.read(settings, now)
            slots = price_slots(attributes, normalized, now, ZoneInfo(self.hass.config.time_zone))
            if not slots:
                raise ValueError('No continuous prices from now: no heating plan is available.')
            durations = sorted({round((row.end - row.start).total_seconds() / 60) for row in slots})
            return {'ok': True, 'source': settings['price_entity'] if settings['price_entity'] in PRICE_SOURCE_CHOICES else 'sensor',
                    'start': slots[0].start.isoformat(), 'end': slots[-1].end.isoformat(),
                    'hours': round((slots[-1].end - now).total_seconds() / 3600, 2),
                    'interval_minutes': durations, 'unit': 'c/kWh',
                    'updated': updated.isoformat() if isinstance(updated, datetime) else None}
        except ValueError as error:
            return {'ok': False, 'error': str(error)}


async def read_weather(hass: Any, entity: str, now: datetime) -> dict[str, Any]:
    """Use HA's common weather action, with the legacy attribute fallback."""
    if not entity:
        return {'rows': [], 'kind': None, 'error': 'No weather forecast source is selected.'}
    state = hass.states.get(entity)
    unit = state.attributes.get('temperature_unit', '°C') if state else '°C'
    try:
        temperature_celsius(0, unit)
    except ValueError:
        return {'rows': [], 'kind': None, 'unit': unit, 'error': 'Unsupported temperature unit.'}
    errors = []
    try:
        async with asyncio.timeout(15):
            for kind in ('hourly', 'twice_daily', 'daily'):
                try:
                    response = await hass.services.async_call('weather', 'get_forecasts',
                        {'entity_id': entity, 'type': kind}, blocking=True, return_response=True)
                    payload = response.get(entity) if isinstance(response, dict) else None
                    raw_rows = payload.get('forecast', []) if isinstance(payload, dict) else []
                    rows = normalize_weather(raw_rows, kind, unit, now)
                    if rows:
                        return {'rows': rows, 'kind': kind, 'unit': unit, 'error': None}
                    errors.append(f'{kind}: no usable timestamped temperature rows returned')
                except Exception as error:
                    errors.append(f'{kind}: {type(error).__name__}: {error}')
    except TimeoutError:
        errors.append('Forecast request timed out.')
    raw = state.attributes.get('forecast', []) if state else []
    kind = 'daily' if isinstance(raw, list) and any(isinstance(row, dict) and 'templow' in row for row in raw) else 'hourly'
    try:
        rows = normalize_weather(raw, kind, unit, now)
    except ValueError:
        rows = []
    return {'rows': rows, 'kind': kind if rows else None, 'unit': unit,
            'error': None if rows else f'{entity}: ' + '; '.join(errors)}


async def check_sources(hass: Any, reader: PriceSourceReader, settings: dict[str, Any], now: datetime) -> dict[str, Any]:
    """Check draft sources without saving settings, learning or issuing controls."""
    prices = await reader.check(settings, now)
    weather = await read_weather(hass, settings['weather_entity'], now)
    rows = weather['rows']
    report = {'ok': bool(rows), 'unit': '°C', 'kind': weather['kind']}
    if rows:
        duration = {'hourly': 1, 'twice_daily': 12, 'daily': 24}[weather['kind']]
        report.update(start=rows[0]['datetime'],
                      end=(stamp(rows[-1]['datetime']) + timedelta(hours=duration)).isoformat(),
                      samples=len(rows))
    else:
        # Do not export entity IDs, home names or provider exception text.
        if weather['error'] in ('No weather forecast source is selected.', 'Unsupported temperature unit.'):
            report['error'] = weather['error']
        else:
            report['error'] = 'No usable weather forecast was returned.'
    return {'checked': now.isoformat(), 'prices': prices, 'weather': report}
