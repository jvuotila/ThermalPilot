"""Read HA states, learn observed response, persist data, publish plans and reconcile opt-in thermostat control."""
from typing import Any
from datetime import datetime, timedelta
from copy import deepcopy
import logging
import asyncio
from zoneinfo import ZoneInfo
from homeassistant.core import callback
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator
from homeassistant.helpers.storage import Store
from homeassistant.helpers.event import async_track_point_in_utc_time, async_track_state_change_event
from homeassistant.util import dt as dt_util
from .const import DOMAIN, DEFAULTS, RESERVE_HOURS, ARCHIVE_KEEP_DAYS, WATER_REFERENCE, HISTORY_DAYS
from .history import HistoryDatabase
from .control import ThermostatControl
from .air_control import AirHeatPumpControl, zone_temperature, binary
from .config import stored_settings, water_distribution, electric_heating, air_room, room_settings, resolved_rooms, zone_rooms, room_electric, price_required, learning_fingerprint
from .model import Slot, garage_cycle_plan, number, stamp, initial_model, learn, learning_progress, price_slots, plan, collection_state, thermostat_state, fallback_season, price_forecast_reserve, heat_retention, solar_signal, solar_facing, solar_enabled

_LOGGER = logging.getLogger(__name__)


class PilotCoordinator(DataUpdateCoordinator):
    def __init__(self, hass, entry):
        super().__init__(hass, _LOGGER, name=DOMAIN, update_interval=timedelta(minutes=5))
        self.backup_lock = asyncio.Lock()
        self.entry = entry
        self.settings = stored_settings(entry.data, entry.options)
        self.store = Store(hass, 1, f'{DOMAIN}.{entry.entry_id}')
        self.models = {}
        self.history_db = HistoryDatabase(hass.config.path('.storage', f'{DOMAIN}.{entry.entry_id}.sqlite3'))
        self.previous = {}
        self.forecast = []
        self.forecast_updated = None
        self.forecast_entity = None
        self.forecast_type = None
        self.forecast_error = None
        self.config_fingerprint = {}
        self.suggested_runs = {}
        self.session_plans = {}
        self.season = {}
        self.applied_season_targets = {}
        self.sensor_health = {'rooms': {}, 'last_notification_day': None}
        self._command_timer = None
        # Restored HA attributes may not reflect the device after an outage.
        self.control = ThermostatControl(hass, require_initial_write=True)
        self.air_control = AirHeatPumpControl(hass)
        self._air_was_live = False
        self.managed_rooms = {}
        self.fallback_state = {}
        self._plan_settings = None
        self._source_timer = None
        self._source_unsubscribe = None
        self.wind_samples = []
        self.wind_source = None

    def stop(self):
        self.cancel_command_timer()
        if self._source_timer:
            self._source_timer()
            self._source_timer = None
        if self._source_unsubscribe:
            self._source_unsubscribe()
            self._source_unsubscribe = None

    def listen_sources(self) -> None:
        """Subscribe to configured inputs, including secondary-zone and garage sensors."""
        if self._source_unsubscribe:
            self._source_unsubscribe()
        source_keys = (
            'price_entity', 'price_forecast_entity', 'outdoor_entity',
            'water_entity', 'weather_entity', 'wind_entity', 'fireplace_entity',
        )
        entities = {self.settings[key] for key in source_keys if self.settings[key] and self.settings[key] != 'static'
                    and not (self.settings['price_entity'] == 'static' and key == 'price_forecast_entity')}
        rooms = resolved_rooms(self.settings) + zone_rooms(self.settings)
        for room in rooms:
            for key in ('temperature_entity', 'thermostat', 'activity_entity', 'zone_fireplace_entity'):
                if room.get(key):
                    entities.add(room[key])
        for room in resolved_rooms(self.settings):
            for key in ('garage_door_entities', 'garage_presence_entities'):
                entities.update(room.get(key, []))
        self._source_unsubscribe = async_track_state_change_event(
            self.hass, entities, self.source_changed
        )

    @callback
    def source_changed(self, event: Any) -> None:
        """Debounce input changes without replanning on our own target acknowledgements."""
        entity = event.data.get('entity_id')
        old_state = event.data.get('old_state')
        new_state = event.data.get('new_state')
        if entity == self.settings['weather_entity']:
            self.forecast_updated = None
        thermostats = {
            room['thermostat']
            for room in resolved_rooms(self.settings) + zone_rooms(self.settings)
        }
        if (entity in thermostats and old_state and new_state
                and old_state.state == new_state.state
                and old_state.attributes.get('hvac_action') == new_state.attributes.get('hvac_action')):
            return
        if self._source_timer:
            return

        # Availability and tariff changes need prompt recovery. Ordinary sensor
        # changes share a longer debounce to avoid repeated work from one update.
        urgent = (
            not old_state or not new_state
            or old_state.state in ('unknown', 'unavailable')
            or new_state.state in ('unknown', 'unavailable')
            or entity in (self.settings['price_entity'], self.settings['price_forecast_entity'])
        )

        async def refresh(_now):
            self._source_timer = None
            await self.async_request_refresh()

        delay_seconds = 5 if urgent else 30
        self._source_timer = async_track_point_in_utc_time(
            self.hass, refresh, dt_util.utcnow() + timedelta(seconds=delay_seconds)
        )

    def cancel_command_timer(self):
        if self._command_timer is not None:
            self._command_timer()
            self._command_timer = None

    def arm_command_timer(self, data: dict[str, Any], now: datetime) -> None:
        """Wake at the next target transition, horizon end, or pump acknowledgement."""
        self.cancel_command_timer()
        future = []
        rooms = [*data.get('rooms', {}).values(), *data.get('zones', {}).values()]
        for room in rooms:
            planned = room.get('plan') or {}
            for command in planned.get('commands', []):
                command_time = stamp(command['time'])
                if command_time > now:
                    future.append(command_time)
        for room in rooms:
            rows = (room.get('plan') or {}).get('slots', [])
            if rows and stamp(rows[-1]['end']) > now:
                future.append(stamp(rows[-1]['end']))
        for deadline in self.air_control.deadlines:
            if deadline > now.timestamp():
                future.append(datetime.fromtimestamp(deadline, now.tzinfo))
        if future:
            self._command_timer = async_track_point_in_utc_time(
                self.hass, self.update_command_state, min(future)
            )

    async def update_command_state(self, now):
        async with self.backup_lock:
            await self._update_command_state(now)

    async def _update_command_state(self, now: datetime) -> None:
        """Apply offset transitions between normal planning refreshes under the backup lock."""
        data = deepcopy(self.data or {})
        rooms = [*data.get('rooms', {}).values(), *data.get('zones', {}).values()]
        for room in rooms:
            if room.get('plan'):
                room['plan'].update(thermostat_state(room['plan'], now))
        data['updated'] = now.isoformat()
        data['control'] = await self.apply_live_targets(data, now)
        # Replace only the prior control errors; retain independent source warnings.
        warnings = [warning for warning in data.get('warnings', [])
                    if not warning.startswith('Thermostat control:')]
        warnings.extend(f'Thermostat control: {error}' for error in data['control']['errors'])
        data['warnings'] = warnings
        self.async_set_updated_data(data)
        self.arm_command_timer(data, now)

    async def load(self):
        saved = await self.store.async_load() or {}
        self.models = saved.get('models', {})
        for model in self.models.values():
            model['response'] = 0.0  # Thermal response cannot be trusted across downtime.
            bank = model.get('air_lag_learning', {})
            bank.pop('last_time',None)
            for profile in bank.get('profiles',{}).values():
                profile['response'] = 0.0
        self.season = saved.get('season', {})
        self.air_control.zone_seasons = saved.get('zone_seasons', {})
        self.air_control.thermal_modes = saved.get('pump_thermal_modes', {})
        self.air_control.reversals = saved.get('pump_reversals', {})
        self.applied_season_targets = saved.get('applied_season_targets', {})
        self.fallback_state = saved.get('fallback_state', {})
        self.managed_rooms = {room['thermostat']: room for room in saved.get('managed_rooms', {}).values()}
        self.sensor_health = saved.get('sensor_health', {'rooms': {}, 'last_notification_day': None})
        await self.hass.async_add_executor_job(self.history_db.initialize)
        self.config_fingerprint = saved.get('fingerprints', {})
        # Session checkpoints are local control continuity, not learned parameters.
        self.session_plans = {}
        self.suggested_runs = {}
        for room in resolved_rooms(self.settings) + zone_rooms(self.settings):
            checkpoint = saved.get('heating_sessions', {}).get(room['id'])
            if not checkpoint or checkpoint.get('fingerprint') != self.session_fingerprint(room):
                continue
            cutoff = dt_util.utcnow() - timedelta(minutes=15)
            windows = checkpoint.get('thermostat_windows', [])
            sessions = checkpoint.get('sessions', [])
            if any(stamp(item['end']) > cutoff for item in windows + sessions):
                self.session_plans[room['id']] = checkpoint
                self.suggested_runs[room['id']] = deepcopy(checkpoint.get('run', {}))

    def chart_temperatures(self) -> dict[str, Any]:
        """Read current values even in passive mode; zone policy matches live control."""
        rooms = {
            room['id']: self.value(room['temperature_entity'])
            for room in self.settings['rooms']
        }
        zones = {zone['id']: None for zone in self.settings.get('heating_zones', [])}
        for room in zone_rooms(self.settings):
            if room['id'] == 'zone:' + room['heating_zone_id']:
                zones[room['heating_zone_id']] = zone_temperature(self.hass, room, self.settings)[0]

        def target(entity):
            state = self.hass.states.get(entity) if entity else None
            if state and state.state not in ('unknown', 'unavailable'):
                return number(state.attributes.get('temperature'))
            return None

        targets = {
            'rooms': {room['id']: target(room.get('thermostat')) for room in self.settings['rooms']},
            'zones': {zone['id']: target(zone.get('thermostat'))
                      for zone in self.settings.get('heating_zones', [])},
        }
        return {'rooms': rooms, 'zones': zones, 'targets': targets}

    def collection_evidence(self):
        """Use the least-observed configured room for house-wide coverage."""
        models = [self.models.get(room['id'], {}) for room in resolved_rooms(self.settings)]
        return {'rooms':len(models),
                'heating_hours':min((m.get('heated_hours',0) for m in models),default=0),
                'idle_hours':min((m.get('idle_hours',0) for m in models),default=0)}

    def value(self, entity):
        state = self.hass.states.get(entity) if entity else None
        return number(state.state) if state else None

    def wind_reading(self, now):
        """Optional, bounded, smoothed input; frozen readings expire after two hours."""
        entity = self.settings['wind_entity']
        if entity != self.wind_source:
            self.wind_samples = []
            self.wind_source = entity
        status = {'enabled': bool(entity), 'available': False, 'speed': None}
        if not entity:
            return status
        state = self.hass.states.get(entity)
        value = number(state.state) if state else None
        factors = {'m/s': 1, 'km/h': 1 / 3.6, 'mph': 0.44704, 'kn': 0.514444, 'knots': 0.514444}
        unit = str(state.attributes.get('unit_of_measurement', '')).strip().lower() if state else ''
        times = [getattr(state, key, None) for key in ('last_updated', 'last_reported')] if state else []
        fresh = [t for t in times if hasattr(t, 'timestamp')]
        valid = state and state.state not in ('unknown', 'unavailable') and (value is not None) and (unit in factors) and fresh
        if valid:
            value *= factors[unit]
            valid = 0 <= value <= 60 and all((0 <= now.timestamp() - t.timestamp() <= 7200 for t in fresh))
        if not valid:
            self.wind_samples = []
            status['reason'] = 'Missing, stale or invalid wind reading; normal temperature-based planning continues.'
            return status
        bucket = int(now.timestamp()) // 300 * 300
        self.wind_samples = [
            (t, v) for t,
            v in self.wind_samples if t >= now.timestamp() - 1800 and t != bucket
        ]
        self.wind_samples.append((bucket,value))
        status.update(
            available=True,
            speed=sum(v for _,v in self.wind_samples)/len(self.wind_samples)
        )
        return status

    def activity(self, room):
        entity = room['activity_entity'] or room['thermostat']
        state = self.hass.states.get(entity)
        if state is None or state.state in ('unknown', 'unavailable'):
            return None
        if not room['activity_entity']:
            value = state.attributes.get('hvac_action')
            if value == 'heating':
                return 1.0
            if value in ('idle', 'off', 'fan') or ((air_room(room, self.settings) or room.get('heat_control') == 'zone_member') and state.state in ('fan_only', 'off')):
                return 0.0
            if value is None and (air_room(room, self.settings) or room.get('heat_control') == 'zone_member') and (state.state == 'heat'):
                return 1.0  # Observed operating mode proxy, not measured heat output.
            return None
        value = state.state
        if value is None or str(value) in ('unknown', 'unavailable'):
            return None
        return 1.0 if value == 'on' else 0.0 if value == 'off' else None

    def storage_data(self):
        return {'models':self.models,'season':self.season,'zone_seasons':self.air_control.zone_seasons,'pump_thermal_modes':self.air_control.thermal_modes,'pump_reversals':self.air_control.reversals,
                'applied_season_targets':self.applied_season_targets,
                'fingerprints':self.config_fingerprint,'sensor_health':self.sensor_health,'managed_rooms':self.managed_rooms,'fallback_state':self.fallback_state,
                'heating_sessions':self.session_plans}

    def zone_observations(self, now):
        rows = []
        for zone in self.settings.get('heating_zones',[]):
            fireplace = zone.get('source_type') == 'fireplace'
            entity = zone.get('fireplace_entity', '') if fireplace else zone.get('thermostat', '')
            state = self.hass.states.get(entity) if entity else None
            mode = None
            basis = 'activity'
            if state and state.state not in ('unknown', 'unavailable'):
                if fireplace:
                    mode = 'heat' if state.state == zone.get('fireplace_active_state', 'on') else None
                    basis = 'fireplace'
                else:
                    action = state.attributes.get('hvac_action')
                    if action in ('heating', 'cooling'):
                        mode = 'heat' if action == 'heating' else 'cool'
                    elif action is None:
                        mode = state.state if state.state in ('heat', 'cool') else None
                        basis = 'operating_mode'
            rows.append({'zone_id':zone['id'],'room_id':'zone:'+zone['id'],'time':now.timestamp(),
                         'zone_mode':mode,'zone_basis':basis,'zone_entity':entity})
        return rows

    def learning_changes(self, settings):
        # Kept for compatibility with callers from earlier versions. Settings
        # saves never request or perform a learned-data reset.
        return []

    def reset_learning(self, room_id):
        """Explicit user reset; a zone includes its member response profiles."""
        ids = {room_id}
        if room_id.startswith('zone:'):
            ids.update(key for key in self.models if key.startswith(room_id+':'))
        for key in ids:
            self.models.pop(key,None)
            self.previous.pop(key,None)

    async def check_temperature_sensors(self, now, active):
        """Warn once per local day after the configured interval of continuous suspect readings."""
        tracking = self.sensor_health.setdefault('rooms', {})
        if not active:
            tracking.clear()
            return
        timestamp = now.timestamp()
        warning_hours = self.settings['sensor_warning_hours']
        configured = {room['id'] for room in resolved_rooms(self.settings)}
        for rid in list(tracking):
            if rid not in configured:
                tracking.pop(rid)
        suspect = []
        for room in resolved_rooms(self.settings):
            rid, entity = (room['id'], room['temperature_entity'])
            value = self.value(entity)
            previous = tracking.get(rid, {})
            # Do not count time across a long outage or a changed sensor mapping.
            if (previous.get('entity') != entity or previous.get('value') != value or
                    timestamp-previous.get('last_seen',timestamp) > 1800 or
                    timestamp < previous.get('last_seen',timestamp)):
                previous = {'entity': entity, 'value': value, 'since': timestamp}
            previous['last_seen'] = timestamp
            previous.setdefault('since',timestamp)
            tracking[rid] = previous
            if timestamp - previous['since'] >= warning_hours * 3600:
                reason = 'unavailable' if value is None else f'unchanged at {value:g} °C'
                suspect.append(f"- {room['name']}: {reason} for at least {warning_hours:g} hours ({entity}).")
        day = now.astimezone(ZoneInfo(self.hass.config.time_zone)).date().isoformat()
        if not suspect or self.sensor_health.get('last_notification_day') == day:
            return
        message = ('These room temperature sensors may need checking:\n\n'+
                   '\n'.join(suspect)+
                   '\n\nAn unchanged reading can also mean the room temperature is stable. Check batteries, connectivity and sensor readings. ThermalPilot issues at most one sensor notification per day.')
        try:
            await self.hass.services.async_call('persistent_notification','create',{
                'title':'ThermalPilot: check room temperature sensors',
                'message':message,
                'notification_id':f'{DOMAIN}_{self.entry.entry_id}_temperature_sensors',
            },blocking=True)
        except Exception:
            _LOGGER.warning('Room sensor notification could not be created',exc_info=True)
            return
        self.sensor_health['last_notification_day'] = day
        # Persist the daily limit immediately so a restart does not repeat the alert.
        await self.store.async_save(self.storage_data())

    async def get_forecast(self, now):
        entity = self.settings['weather_entity']
        if not entity:
            self.forecast = []
            self.forecast_type = None
            self.forecast_error = 'No weather forecast source is selected.'
            return []
        if entity == self.forecast_entity and self.forecast_updated is not None and ((now - self.forecast_updated).total_seconds() < (3600 if self.forecast else 300)):
            return self.forecast
        def usable(rows, kind):
            if not isinstance(rows, list):
                return []
            return [row for row in rows if isinstance(row,dict) and stamp(row.get('datetime')) is not None and
                    number(row.get('templow',row.get('temperature')) if kind=='daily' else row.get('temperature')) is not None]
        self.forecast = []
        self.forecast_type = None
        errors = []
        previous_error = self.forecast_error
        for kind in ('hourly','twice_daily','daily'):
            try:
                result = await self.hass.services.async_call('weather', 'get_forecasts',
                    {'entity_id':entity, 'type':kind}, blocking=True, return_response=True)
                raw_rows = (result or {}).get(entity, {}).get('forecast', [])
                rows = usable(raw_rows, kind)
                if rows:
                    self.forecast, self.forecast_type = (rows, kind)
                    break
                errors.append(f'{kind}: no usable timestamped temperature rows returned')
            except Exception as error:
                errors.append(f'{kind}: {type(error).__name__}: {error}')
                _LOGGER.debug('Forecast type %s unavailable for %s',kind,entity,exc_info=True)
        if not self.forecast:
            state = self.hass.states.get(entity)
            rows = state.attributes.get('forecast', []) if state else []
            kind = 'daily' if isinstance(rows, list) and any((isinstance(row, dict) and 'templow' in row for row in rows)) else 'hourly'
            self.forecast = usable(rows, kind)
            self.forecast_type = kind if self.forecast else None
        self.forecast_error = None if self.forecast else f'{entity}: ' + '; '.join(errors)
        if self.forecast_error and self.forecast_error != previous_error:
            _LOGGER.warning('Weather forecast unavailable: %s', self.forecast_error)
        self.forecast_updated = now
        self.forecast_entity = entity
        return self.forecast

    def weather_chart_forecast(self, now):
        """Expose real hourly forecast rows for display, independently of planning."""
        if self.forecast_type != 'hourly':
            return []
        state = self.hass.states.get(self.settings.get('weather_entity'))
        unit = str(state.attributes.get('temperature_unit', '°C') if state else '°C').lower()
        if unit not in ('°c', 'c', 'celsius', '°f', 'f', 'fahrenheit', 'k', 'kelvin'):
            return []
        conditions = {'clear-night','cloudy','exceptional','fog','hail','lightning',
                      'lightning-rainy','partlycloudy','pouring','rainy','snowy',
                      'snowy-rainy','sunny','windy','windy-variant'}
        rows = {}
        for row in self.forecast:
            date = stamp(row.get('datetime'))
            temperature = number(row.get('temperature'))
            if date is None or temperature is None or (not now - timedelta(hours=1) < date <= now + timedelta(days=7)):
                continue
            if unit in ('°f', 'f', 'fahrenheit'):
                temperature = (temperature - 32) * 5 / 9
            elif unit in ('k', 'kelvin'):
                temperature -= 273.15
            condition = row.get('condition')
            rows[date] = {'datetime':date.isoformat(),'temperature':round(temperature,2),
                          'condition':condition if isinstance(condition,str) and condition in conditions else ''}
        return [rows[date] for date in sorted(rows)][:168]

    def session_fingerprint(self, room: dict[str, Any]) -> list:
        """Invalidate a checkpoint when device mapping or heating policy changes."""
        effective = room_settings(room, self.settings)
        price_policy = ['static', self.settings['static_price']] if self.settings['price_entity'] == 'static' else []
        return learning_fingerprint(room, self.settings) + [
            effective.get('heat_control'), effective.get('minimum'), effective.get('maximum'),
            effective.get('boost'), effective.get('setback'), room.get('garage_strategy'),
            room.get('zone_control_enabled'), room.get('zone_climate_mode'),
            room.get('zone_heating_strategy'), room.get('zone_policy'),
            sorted(item['id'] for item in self.settings['rooms']
                   if room.get('secondary_zone') and item.get('heating_zone_id') == room.get('heating_zone_id')),
            self.settings['house_heat_source'],
            self.settings['house_distribution'], self.settings['pricing_mode'],
            self.settings['minimum_run_minutes'], self.settings['start_offset_minutes'],
            self.settings['stop_offset_minutes'], self.settings['heating_enabled'],
            self.settings['simulation_enabled'],
        ] + price_policy

    def previous_session_plan(self, room_id: str) -> dict[str, Any]:
        """Use the persisted last plan when HA has not published data since startup."""
        checkpoint = self.session_plans.get(room_id)
        if checkpoint is not None:
            configured = next((room for room in resolved_rooms(self.settings) + zone_rooms(self.settings)
                               if room['id'] == room_id), None)
            if configured and checkpoint.get('fingerprint') == self.session_fingerprint(configured):
                return checkpoint
            self.suggested_runs.pop(room_id, None)
            return {}
        data = getattr(self, 'data', None) or {}
        if room_id.startswith('zone:'):
            previous_room = data.get('zones', {}).get(room_id[5:], {})
        else:
            previous_room = data.get('rooms', {}).get(room_id, {})
        return previous_room.get('plan') or {}

    async def save_heating_sessions(self, data: dict[str, Any], now: datetime) -> None:
        """Persist published timing before any associated device command is sent.

        Save future windows too: HA may be offline at their opening time. Keep a
        recently ended window for fifteen minutes so a restart cannot erase its
        minimum pause. Missing inputs may suspend control without losing a still
        valid commitment; the normal fallback checks continue to govern writes.
        """
        checkpoints = {}
        cutoff = now - timedelta(minutes=15)
        for room in resolved_rooms(self.settings) + zone_rooms(self.settings):
            room_id = room['id']
            if room.get('heat_control') == 'zone_member':
                continue
            if room.get('secondary_zone'):
                published = data.get('zones', {}).get(room['heating_zone_id'], {})
            else:
                published = data.get('rooms', {}).get(room_id, {})
            planned = published.get('plan')
            fingerprint = self.session_fingerprint(room)
            if not planned:
                previous = self.session_plans.get(room_id, {})
                if previous.get('fingerprint') != fingerprint:
                    continue
                planned = previous
            windows = [window for window in planned.get('thermostat_windows', [])
                       if stamp(window['end']) > cutoff]
            sessions = [session for session in planned.get('sessions', [])
                        if stamp(session['end']) > cutoff]
            # A newly normal plan no longer contains the window that just ended.
            # Retain that boundary until the restart-safe pause has elapsed.
            previous = self.session_plans.get(room_id, {})
            if previous.get('fingerprint') == fingerprint:
                for window in previous.get('thermostat_windows', []):
                    if cutoff < stamp(window['end']) <= now and window not in windows:
                        windows.append(deepcopy(window))
                    elif (planned.get('heat') is False
                          and stamp(window['start']) <= now < stamp(window['end'])):
                        # A replan can end a boost after its minimum run, before
                        # the old forecast's closing time. Save the actual new
                        # boundary so restarting cannot erase the ensuing pause.
                        closed_window = {**window, 'end': now.isoformat()}
                        if closed_window not in windows:
                            windows.append(closed_window)
            if not windows and not sessions:
                continue
            checkpoints[room_id] = {
                'fingerprint': fingerprint,
                'sessions': deepcopy(sessions),
                'thermostat_windows': deepcopy(windows),
                'run': deepcopy(self.suggested_runs.get(room_id, {})),
            }
        if checkpoints != self.session_plans:
            # The usual delayed model save is not enough here: an immediate
            # reload after a target change must still find the matching timing.
            saved = self.storage_data()
            saved['heating_sessions'] = checkpoints
            await self.store.async_save(saved)
            # Commit memory only after disk succeeds, so failures retry before writes.
            self.session_plans = checkpoints

    def committed_session(self, rid, now):
        """Return active session timing; the planner protects its minimum duration."""
        previous_plan = self.previous_session_plan(rid)
        for session in previous_plan.get('sessions',[]):
            start, end = (stamp(session['start']), stamp(session['end']))
            configured = next(
                (r for r in resolved_rooms(self.settings) + zone_rooms(self.settings) if r['id'] == rid),
                {}
            )
            opening = start - timedelta(minutes=self.settings['start_offset_minutes'] if water_distribution(self.settings) and (not air_room(configured, self.settings)) and (configured.get('heat_control') != 'zone_member') else 0)
            water = water_distribution(self.settings) and (not air_room(configured, self.settings)) and (configured.get('heat_control') != 'zone_member')
            closing = end - timedelta(minutes=self.settings['stop_offset_minutes'] if water else 0)
            if opening <= now < closing:
                return deepcopy(session)
        return None

    def boost_resume_after(self, rid, now):
        """Keep a known boost-closing boundary across successive replans."""
        previous_plan = self.previous_session_plan(rid)
        run = self.suggested_runs.setdefault(rid, {})
        ended = [stamp(window['end']).timestamp() for window in previous_plan.get('thermostat_windows', []) if stamp(window['end']) <= now]
        if ended:
            run['last_boost_end'] = max(run.get('last_boost_end', 0), max(ended))
        end = run.get('last_boost_end')
        return datetime.fromtimestamp(end + 15 * 60, now.tzinfo).isoformat() if end is not None and end <= now.timestamp() < end + 15 * 60 else None

    async def _async_update_data(self):
        async with self.backup_lock:
            return await self._update_data()

    async def _update_data(self):
        self.cancel_command_timer()
        now = dt_util.utcnow()
        plan_settings = deepcopy(self.settings)
        outdoor = self.value(self.settings['outdoor_entity'])
        source = self.hass.states.get(self.settings['price_entity'])
        heating_active = self.settings['heating_enabled']
        await self.hass.async_add_executor_job(
            self.history_db.append_zones,
            self.zone_observations(now),
            now.timestamp()-HISTORY_DAYS*86400
        )
        forecasts = await self.get_forecast(now)
        self.fallback_state = fallback_season(
            self.fallback_state,
            forecasts,
            self.forecast_type,
            outdoor,
            now,
            ZoneInfo(self.hass.config.time_zone),
            self.settings['summer_minimum_temperature'],
            getattr(self.hass.config, 'latitude', None)
        )
        await self.check_temperature_sensors(now,heating_active)
        setpoint_errors = await self.apply_season_targets(heating_active)
        previous_season = dict(self.season)
        self.season = collection_state(self.season, outdoor, now.timestamp(), self.settings)
        self.season['collecting'] = self.season['collecting'] and heating_active
        self.season['heating_active'] = heating_active
        local_now = now.astimezone(ZoneInfo(self.hass.config.time_zone))
        year = local_now.year if local_now.month >= 7 else local_now.year - 1
        season_id = self.season.get('season_id')
        if self.season['collecting'] and (not previous_season.get('collecting')):
            season_id = f'{year}-{year + 1}'
        self.season['season_id'] = season_id or f'{year}-{year + 1}'
        if previous_season.get('heating_active') and (not heating_active):
            keep_since = now.timestamp() - ARCHIVE_KEEP_DAYS * 86400
            await self.hass.async_add_executor_job(self.history_db.compact_season,
                previous_season.get('season_id',self.season['season_id']), deepcopy(self.models),deepcopy(self.config_fingerprint),keep_since)
            self.season['last_compaction'] = now.isoformat()
        if not heating_active:
            self.previous.clear()
            self.suggested_runs.clear()
            self.session_plans.clear()
            for model in self.models.values():
                model['response'] = 0.0
            cutoff = now.timestamp() - HISTORY_DAYS * 86400
            await self.hass.async_add_executor_job(self.history_db.append, [], cutoff, self.season['season_id'])
            await self.store.async_save(self.storage_data())
            data = {'updated':now.isoformat(),'simulation_only':not self.live_enabled() and not self.settings['apply_season_setpoints'],'heating_active':False,
                'collection':self.season,'zones':{},'collection_evidence':self.collection_evidence(),'warnings':['ThermalPilot is passive. Planning, collection and learning are stopped.']+setpoint_errors,
                'rooms':{},'outdoor':outdoor,'water':None,'weather_forecast':self.weather_chart_forecast(now),
                'season_summaries':await self.hass.async_add_executor_job(self.history_db.summaries),
                'history_info':await self.hass.async_add_executor_job(self.history_db.size)}
            self._plan_settings = plan_settings
            data['fallback_season'] = self.fallback_summary()
            data['control'] = await self.apply_live_targets(data, now)
            data['warnings'].extend(f'Thermostat control: {w}' for w in data['control']['errors'])
            return data
        scheduling = price_required(self.settings)
        warnings = list(setpoint_errors)
        if not electric_heating(self.settings):
            warnings.append('Observation only: this heat source does not use electricity-price scheduling or thermostat control.')
        if scheduling and (not self.settings['simulation_enabled']) and (not self.settings.get('live_control_confirmed')):
            warnings.append('Live control awaits confirmation. Enable simulation, save, then disable it and confirm to activate thermostat control.')
        if not self.season['collecting']:
            warnings.append('History collection and learning paused because outdoor temperature is unavailable. Existing model parameters are retained.')
        slots = []
        chart_prices = []
        if not scheduling:
            pass
        elif self.settings['price_entity'] == 'static':
            slots = price_slots({}, self.settings, now, ZoneInfo(self.hass.config.time_zone))
            midnight = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
            chart_prices = [{'start':slot.start.isoformat(), 'end':slot.end.isoformat(), 'price':slot.price}
                            for slot in price_slots({}, self.settings, midnight, ZoneInfo(self.hass.config.time_zone))]
        elif source is None or source.state in ('unknown', 'unavailable'):
            warnings.append('Price sensor is missing or unavailable.')
        else:
            try:
                slots = price_slots(source.attributes, self.settings, now, ZoneInfo(self.hass.config.time_zone))
                midnight = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
                chart_prices = [{'start':price_slot.start.isoformat(),'end':price_slot.end.isoformat(),'price':price_slot.price}
                    for price_slot in (price_slots(source.attributes,self.settings,midnight,ZoneInfo(self.hass.config.time_zone)) or slots)]
            except ValueError as error:
                warnings.append(str(error))
        if scheduling and (not slots):
            warnings.append('No continuous prices from now: no heating plan is available.')
        if not forecasts:
            warnings.append('No weather forecast: current outdoor temperature is held constant. '+(self.forecast_error or 'No usable forecast was returned.'))
        price_outlook = {
            'enabled': scheduling and self.settings['price_entity'] != 'static' and bool(self.settings['price_forecast_entity']),
            'reserve_hours': RESERVE_HOURS,
            'available': False
        }
        if price_outlook['enabled'] and slots:
            predicted_source = self.hass.states.get(self.settings['price_forecast_entity'])
            attributes = predicted_source.attributes if predicted_source and predicted_source.state not in ('unknown', 'unavailable') else {}
            price_outlook.update(price_forecast_reserve(attributes,slots[-1].end,RESERVE_HOURS))
            if not price_outlook['available']:
                warnings.append('Optional price forecast unavailable; planning uses confirmed prices and the normal heat reserve.')
        wind_status = self.wind_reading(now)
        if wind_status['enabled'] and (not wind_status['available']):
            warnings.append('Optional wind sensor unavailable or stale; heating and temperature-based planning continue.')
        latitude = getattr(self.hass.config, 'latitude', None)
        longitude = getattr(self.hass.config, 'longitude', None)
        weather_state = self.hass.states.get(self.settings['weather_entity']) if self.settings['weather_entity'] else None
        weather_values = None
        if weather_state and weather_state.state not in ('unknown', 'unavailable'):
            updated = getattr(weather_state, 'last_updated', None)
            if isinstance(updated, datetime) and 0 <= (now - updated).total_seconds() <= 7200:
                weather_values = {**weather_state.attributes, 'condition': weather_state.state}
        current_solar = solar_signal(now, latitude, longitude, weather_values)
        solar_forecast = []
        for slot in slots:
            midpoint = slot.start + (slot.end - slot.start) / 2
            matches = []
            for row in forecasts:
                date = stamp(row.get('datetime'))
                if not date:
                    continue
                if self.forecast_type == 'daily':
                    valid = date.astimezone(ZoneInfo(self.hass.config.time_zone)).date() == midpoint.astimezone(ZoneInfo(self.hass.config.time_zone)).date()
                else:
                    valid = 0 <= (midpoint - date).total_seconds() <= (7200 if self.forecast_type == 'hourly' else 43200)
                if valid:
                    matches.append((date,row))
            values = max(matches, key=lambda item: item[0])[1] if matches else None
            solar_forecast.append(solar_signal(midpoint,latitude,longitude,values))
        outdoors = []
        for slot in slots:
            points = []
            for forecast_row in forecasts:
                date = stamp(forecast_row.get('datetime'))
                temp = number(forecast_row.get('templow', forecast_row.get('temperature')) if self.forecast_type == 'daily' else forecast_row.get('temperature'))
                if date and temp is not None:
                    points.append((date, temp))
            earlier = [point for point in points if point[0] <= slot.start]
            outdoors.append(max(earlier, key=lambda point: point[0])[1] if earlier else outdoor)
        uses_water = water_distribution(self.settings) and any((not air_room(candidate_room, self.settings) and candidate_room.get('heat_control') != 'zone_member' for candidate_room in resolved_rooms(self.settings)))
        water_state = self.hass.states.get(self.settings['water_entity']) if uses_water and self.settings['water_entity'] else None
        water = None
        if water_state:
            if self.settings['water_entity'].startswith('climate.'):
                water = number(water_state.attributes.get('current_temperature'))
            else:
                water = number(water_state.state)
        if uses_water and water is None:
            warnings.append('Heating water temperature is not available; planning and learning use observed thermostat demand without water-temperature adjustment.')
        fireplace_state = self.hass.states.get(self.settings['fireplace_entity']) if self.settings['fireplace_entity'] else None
        fireplace = bool(fireplace_state and fireplace_state.state == self.settings['fireplace_active_state'])
        readings, room_data = ([], {})
        for configured_room in resolved_rooms(self.settings)+[candidate_room for candidate_room in zone_rooms(self.settings) if candidate_room['heat_control']!='zone_member']:
            room = {
                **room_settings(configured_room, self.settings),
                'water_reference': WATER_REFERENCE
            }
            room_water = uses_water and (not room.get('air_control'))
            zone_fire = self.hass.states.get(room.get('zone_fireplace_entity', '')) if room.get('zone_fireplace_entity') else None
            if room.get('is_garage'):
                room_fireplace = False
            elif room.get('zone_fireplace_entity'):
                room_fireplace = bool(zone_fire and zone_fire.state == room.get('zone_fireplace_active_state', 'on'))
            else:
                room_fireplace = fireplace
            room_id = room['id']
            temperature = zone_temperature(self.hass, room, self.settings)[0] if room.get('secondary_zone') else self.value(room['temperature_entity'])
            baseline = room['baseline']
            if baseline is not None:
                room['baseline'] = baseline
            model = self.models.setdefault(room_id, initial_model(room))
            # Fingerprints track observation continuity, never permission to
            # discard learning. Only the explicit reset action removes a model.
            fingerprint = learning_fingerprint(configured_room, self.settings)
            old_fingerprint = self.config_fingerprint.get(room_id)
            # Upgrade only the unchanged default garage prior; never replace a fit
            # or retained room loss, and keep its accepted observations intact.
            if room.get('is_garage') and (not model.get('parameter_updates', 0)) and (not model.get('retention_learned')) and (model.get('loss') == 0.007):
                model['loss'] = initial_model(room)['loss']
                model['parameter_updates'] = 0
            # Keep learned parameters but never fit an interval across a source
            # change (including saved fingerprints from earlier versions).
            if old_fingerprint is not None and old_fingerprint != fingerprint:
                self.previous.pop(room_id,None)
            self.config_fingerprint[room_id] = fingerprint
            if model.get('wind_source', '') != self.settings['wind_entity']:
                model['wind_source'] = self.settings['wind_entity']
                self.previous.pop(room_id,None)
            solar_context = [
                room.get('solar_direction', 'disabled'),
                room.get('solar_exposure', 'clear'),
                self.settings['weather_entity'],
                latitude,
                longitude
            ]
            old_solar_context = model.get('solar_context', solar_context)
            if old_solar_context != solar_context:
                self.previous.pop(room_id,None)
            model['solar_context'] = solar_context
            if not self.season['collecting']:
                model['response'] = 0.0
            activity = self.activity(room)
            thermostat_state = self.hass.states.get(room['thermostat'])
            pump_mode = None
            pump_basis = 'activity'
            if room.get('air_control') and thermostat_state and (thermostat_state.state not in ('unknown', 'unavailable')):
                action = thermostat_state.attributes.get('hvac_action')
                if action in ('heating', 'cooling'):
                    pump_mode = 'heat' if action == 'heating' else 'cool'
                elif action is None:
                    pump_mode = thermostat_state.state if thermostat_state.state in ('heat', 'cool') else None
                    pump_basis = 'operating_mode'
            actual_request = number(thermostat_state.attributes.get('temperature')) if thermostat_state else None
            result = {'name':room['name'], 'temperature':temperature, 'actual_activity':activity,
                      'actual_setpoint':actual_request, 'baseline':baseline, 'model':deepcopy(model), 'plan':None, 'forecast_context':fingerprint+[self.settings['wind_entity']]+solar_context}
            if temperature is None or outdoor is None or baseline is None :
                result['error'] = 'Room temperature, outdoor temperature or target temperature is unavailable.'
                self.previous.pop(room_id, None)
            elif not room['minimum'] <= baseline <= room['maximum']:
                result['error'] = 'Target temperature is outside the allowed temperature range.'
                self.previous.pop(room_id, None)
            else:
                water_factor = max(
                    0.25,
                    min(2, (water - temperature) / max(1, room['water_reference'] - temperature))
                ) if room_water and water is not None else 1.0
                # Separate modeled sun input from exclusion rules: a secondary
                # heater, cooling or an open garage door must not teach primary heat loss.
                room_solar = None
                if solar_enabled(room) and current_solar is not None:
                    room_solar = current_solar * solar_facing(
                        now, latitude, longitude, room.get('solar_direction', 'south')
                    )
                cooling = bool(thermostat_state and (
                    thermostat_state.state == 'cool'
                    or thermostat_state.attributes.get('hvac_action') == 'cooling'
                ))
                excluded = cooling or room_fireplace
                if not excluded and room.get('is_garage'):
                    excluded = any(binary(self.hass, entity) is not False
                                   for entity in room.get('garage_door_entities', []))
                current = {
                    'time': now.timestamp(), 'temperature': temperature, 'outdoor': outdoor,
                    'activity': activity, 'water': water if room_water else None,
                    'water_factor': water_factor, 'wind': wind_status['speed'],
                    'solar': room_solar, 'excluded': excluded,
                }
                if room.get('secondary_zone'):
                    members = [candidate_room for candidate_room in resolved_rooms(self.settings) if candidate_room.get('heating_zone_id') == room['heating_zone_id']]
                    current['excluded'] = current['excluded'] or any((self.activity(member) == 1 for member in members))
                else:
                    secondary = self.hass.states.get(room.get('secondary_pump_entity', ''))
                    current['excluded'] = current['excluded'] or bool(secondary and (secondary.state == 'cool' or secondary.attributes.get('hvac_action') in ('heating', 'cooling') or (secondary.attributes.get('hvac_action') is None and secondary.state in ('heat', 'cool'))))
                prediction = None
                if self.season['collecting'] and room_id in self.previous:
                    prediction = learn(model, room, self.previous[room_id], current)
                if self.season['collecting']:
                    self.previous[room_id] = current
                else:
                    self.previous.pop(room_id,None)
                can_plan = room_electric(room, self.settings) and room.get('heat_control') != 'zone_member'
                if can_plan and room.get('secondary_zone'):
                    # Temperature-only zones and cooling-season zones use their
                    # own controller rather than the electricity-tariff planner.
                    independent_zone = (
                        room.get('zone_heating_strategy') == 'temperature'
                        or room.get('zone_climate_mode') == 'cool'
                        or self.air_control.zone_season(
                            room['heating_zone_id'], self.fallback_state.get('summer', False), now.timestamp()
                        )
                    )
                    can_plan = not independent_zone
                if can_plan and slots and all((value is not None for value in outdoors)):
                    resume_after = self.boost_resume_after(room_id, now)
                    previous_run = self.suggested_runs.get(room_id, {})
                    room_solar_forecast = []
                    for solar_value, slot in zip(solar_forecast, slots):
                        if solar_value is None:
                            room_solar_forecast.append(None)
                        else:
                            midpoint = slot.start + (slot.end - slot.start) / 2
                            room_solar_forecast.append(solar_value * solar_facing(
                                midpoint, latitude, longitude, room.get('solar_direction', 'south')
                            ))
                    pricing_mode = self.settings['pricing_mode']
                    if pricing_mode == 'flexible':
                        minimum_run_minutes = self.settings['minimum_run_minutes']
                    elif pricing_mode == 'hourly':
                        minimum_run_minutes = 60
                    else:
                        minimum_run_minutes = 15
                    previous_pause_hours = 1
                    if previous_run and (not previous_run.get('heat')):
                        previous_pause_hours = max(
                            0, (now.timestamp() - previous_run.get('since', now.timestamp())) / 3600
                        )
                    settings = {
                        **room, 'terminal_reserve_hours': price_outlook['reserve_hours'],
                        'wind_speed': wind_status['speed'], 'solar_forecast': room_solar_forecast,
                        'start_offset_minutes': self.settings['start_offset_minutes'] if room_water else 0,
                        'stop_offset_minutes': self.settings['stop_offset_minutes'] if room_water else 0,
                        'boost': room['boost'], 'setback': room['setback'],
                        'minimum_run_minutes': minimum_run_minutes,
                        'minimum_pause_minutes': 15, 'boost_resume_after': resume_after,
                        'previous_pause_hours': previous_pause_hours,
                        'committed_session': self.committed_session(room_id, now),
                        'previous_suggested_heat': previous_run.get('heat', False),
                        'previous_control_mode': previous_run.get('mode', 'boost' if previous_run.get('heat') else 'normal'),
                        'reduction_available': previous_run.get('reduction_available', previous_run.get('heat', False)),
                        'previous_run_hours': max(0, (now.timestamp() - previous_run.get('since', now.timestamp())) / 3600),
                    }
                    if room.get('is_garage') and room['garage_strategy'] == 'temperature':
                        result['plan'] = garage_cycle_plan(
                            settings,
                            model,
                            temperature,
                            outdoors,
                            slots,
                            now,
                            self.air_control.cycles.get(room_id, {}).get('heating', bool(thermostat_state and thermostat_state.state == 'heat'))
                        )
                    else:
                        planning_temperature = temperature
                        if planning_temperature is not None:
                            result['plan'] = await self.hass.async_add_executor_job(plan, settings, deepcopy(model),
                                planning_temperature, outdoors, slots, now, baseline, water_factor, room_fireplace)
                if room.get('is_garage') and room['garage_strategy'] == 'temperature' and (not slots):
                    cycle_slots = [Slot(now + timedelta(minutes=15 * i), now + timedelta(minutes=15 * (i + 1)), 0) for i in range(96)]
                    result['plan'] = garage_cycle_plan(
                        room,
                        model,
                        temperature,
                        [outdoor] * 96,
                        cycle_slots,
                        now,
                        self.air_control.cycles.get(room_id, {}).get('heating', bool(thermostat_state and thermostat_state.state == 'heat'))
                    )
                    result['plan']['prices_used'] = False
                if result['plan'] and room.get('air_control'):
                    result['plan']['air_control'] = True
                    result['plan']['device_target'] = room['garage_heat_target'] if room.get('is_garage') else self.settings['air_heat_target']
                if result['plan']:
                    heat = result['plan']['scheduled_heat']
                    old = self.suggested_runs.get(room_id, {})
                    self.suggested_runs[room_id] = {
                        **old,
                        'heat': heat,
                        'mode': result['plan'].get('scheduled_mode', 'boost' if heat else 'normal'),
                        'reduction_available': result['plan'].get('reduction_available', heat),
                        'since': old.get('since', now.timestamp()) if old.get('heat') == heat else now.timestamp()
                    }
                result['model'] = deepcopy(model)
                result['one_step_prediction'] = prediction
                if self.season['collecting'] and (not room.get('secondary_zone')):
                    readings.append({'room_id':room_id, **current, **({'pump_mode':pump_mode,'pump_basis':pump_basis,'pump_entity':room['thermostat']} if room.get('air_control') else {}), 'forecast_context':fingerprint+[self.settings['wind_entity']]+solar_context, 'actual_setpoint':actual_request,
                                 'prediction':prediction, 'suggested_heat':result['plan']['heat'] if result['plan'] else None,
                                 'suggested_setpoint':result['plan']['setpoint'] if result['plan'] else None,
                                 'price':slots[0].price if slots else None})
            if not self.season['collecting']:
                result['learning_note'] = 'Learning paused while collection is inactive.'
            elif activity is None:
                result['learning_note'] = 'No observed heating activity: learning is waiting.'
            elif model['heated_hours'] < 12 or model['idle_hours'] < 12:
                result['learning_note'] = 'Initial model: needs at least 12 heating hours and 12 idle hours.'
            else:
                result['learning_note'] = 'Model adapting to observations; assess reliability from prediction error.'
            result['air_control'] = bool(room.get('air_control'))
            result['activity_basis'] = 'heat_mode' if room.get('air_control') and (not room['activity_entity']) and thermostat_state and (thermostat_state.attributes.get('hvac_action') is None) else 'demand'
            result['is_garage'] = room.get('is_garage', False)
            result['heating_zone_id'] = room.get('heating_zone_id', '')
            if room.get('heat_control') == 'zone_member':
                result['zone_monitor'] = True
            result['learning_progress'] = learning_progress(model, now)
            result['heat_retention'] = heat_retention(model, room)
            room_data[room_id] = result
        zone_data = {room_id[5:]: room_data.pop(room_id) for room_id in list(room_data) if room_id.startswith('zone:')}
        cutoff = now.timestamp() - HISTORY_DAYS * 86400
        await self.hass.async_add_executor_job(self.history_db.append, readings, cutoff, self.season['season_id'])
        await self.hass.async_add_executor_job(self.history_db.record_forecasts,room_data,now.timestamp(),cutoff)
        accuracy = await self.hass.async_add_executor_job(self.history_db.forecast_accuracy, now.timestamp() - 7 * 86400)
        for room_id, room in room_data.items():
            room['forecast_accuracy'] = accuracy.get(room_id, {})
        # Model parameters are small; sample history lives in SQLite.
        self.store.async_delay_save(self.storage_data,20)
        archives = await self.hass.async_add_executor_job(self.history_db.summaries)
        history_info = await self.hass.async_add_executor_job(self.history_db.size)
        data = {'season_summaries':archives,'history_info':history_info, 'updated':now.isoformat(), 'simulation_only':not self.live_enabled() and not self.settings['apply_season_setpoints'], 'warnings':warnings,
                'heating_active':True, 'collection':self.season, 'outdoor':outdoor, 'water':water, 
                'rooms':room_data,'price_chart':chart_prices,'weather_forecast':self.weather_chart_forecast(now),'price_outlook':price_outlook,'wind':wind_status,
                'zones':zone_data,'collection_evidence':self.collection_evidence(),
                'source_status':{
                    'prices':bool(slots),
                    'prices_required':scheduling,
                    'outdoor':outdoor is not None,
                    'water':water is not None or not uses_water,
                    'water_required':False
                },
                'fallback_season':self.fallback_summary()}
        await self.save_heating_sessions(data, now)
        self._plan_settings = plan_settings
        data['control'] = await self.apply_live_targets(data, now)
        data['warnings'].extend(f'Thermostat control: {w}' for w in data['control']['errors'])
        self.arm_command_timer(data,now)
        return data

    def fallback_summary(self):
        return {'season':'summer' if self.fallback_state.get('summer') else 'winter',
                'daily_minimum':self.fallback_state.get('daily_minimum'),
                'forecast_complete':self.fallback_state.get('complete',False),'threshold':self.settings['summer_minimum_temperature'],
                'basis':self.fallback_state.get('basis','insufficient_evidence')}

    def fallback_target(self, room):
        return self.settings['summer_setpoint'] if self.fallback_state.get('summer') else room['baseline']

    def live_enabled(self):
        return electric_heating(self.settings) and (not self.settings['simulation_enabled']) and self.settings.get('live_control_confirmed', False)

    async def release_managed_rooms(self, now, force=False):
        """Restore normal comfort targets on relinquishing thermostat ownership."""
        snapshot = deepcopy(self.settings)
        configured = {r['thermostat']: r for r in resolved_rooms(snapshot) + [r for r in zone_rooms(snapshot) if r['heat_control'] != 'zone_member'] if r.get('zone_control_enabled', True)}
        released = [{**old,'id':entity} for entity,old in self.managed_rooms.items()
                    if force or not self.live_enabled() or entity not in configured]
        air_released = [room for room in released if air_room(room, snapshot)]
        released = [room for room in released if room not in air_released]
        targets = {old['id']: self.fallback_target(configured.get(old['thermostat'], old)) for old in released}
        errors = await self.control.apply(released, targets, now.timestamp(), lambda: self.settings == snapshot)
        intents = {r['id']: self.air_control.intent(r, snapshot, now.timestamp(), release=True) for r in air_released}
        errors += await self.air_control.apply(air_released, intents, now.timestamp(), lambda: self.settings == snapshot)
        for room in released+air_released:
            if (self.air_control.results.get(room['id'], {}).get('confirmed', False) if room in air_released else room['id'] in self.control.results):
                self.managed_rooms.pop(room['thermostat'],None)
        if released or air_released:
            await self.store.async_save(self.storage_data())
        return errors

    async def apply_live_targets(self, data, now):
        """Reconcile current windows and restore comfort targets when inputs fail."""
        self.air_control.deadlines = []
        live = self.live_enabled()
        if live and (not self._air_was_live):
            self.air_control.cycles.clear()
        self._air_was_live = live
        release_errors = await self.release_managed_rooms(now)
        air_rooms = [r for r in resolved_rooms(self.settings) + zone_rooms(self.settings) if air_room(r, self.settings)]
        intents = {}
        for room in air_rooms:
            bucket = data.get('zones', {}) if room.get('secondary_zone') else data.get('rooms', {})
            key = room['heating_zone_id'] if room.get('secondary_zone') else room['id']
            planned = bucket.get(key, {}).get('plan')
            current = thermostat_state(planned, now) if planned and planned.get('slots') and (stamp(planned['slots'][0]['start']) <= now < stamp(planned['slots'][-1]['end'])) else None
            intent = self.air_control.intent(
                room,
                self.settings,
                now.timestamp(),
                current,
                enabled=self.settings['heating_enabled'] and room.get('zone_control_enabled', True),
                summer=self.fallback_state.get('summer', False)
            )
            intents[room['id']] = intent
            if key in bucket:
                bucket[key]['pump_suggestion'] = intent
        if not self.live_enabled():
            for room in air_rooms:
                status = self.air_control.results.get(room['id'])
                bucket = data.get('zones', {}) if room.get('secondary_zone') else data.get('rooms', {})
                key = room['heating_zone_id'] if room.get('secondary_zone') else room['id']
                if status and key in bucket:
                    bucket[key]['pump_control'] = status
            return {
                'mode': 'simulation' if electric_heating(self.settings) else 'observation',
                'errors': release_errors,
                'fallback_rooms': []
            }
        snapshot = deepcopy(self.settings)
        if self._plan_settings != snapshot:
            return {'mode': 'waiting', 'errors': [], 'fallback_rooms': []}
        targets, fallback = ({}, [])
        sources_ok = self.value(snapshot['outdoor_entity']) is not None
        uses_water = water_distribution(snapshot)
        water_state = self.hass.states.get(snapshot['water_entity']) if uses_water else None
        water = number(water_state.attributes.get('current_temperature') if snapshot['water_entity'].startswith('climate.') else water_state.state) if water_state else None
        price_state = self.hass.states.get(snapshot['price_entity'])
        try:
            if snapshot['price_entity'] == 'static':
                prices = price_slots({}, snapshot, now, ZoneInfo(self.hass.config.time_zone))
            else:
                prices = price_slots(price_state.attributes, snapshot, now, ZoneInfo(self.hass.config.time_zone)) if price_state and price_state.state not in ('unknown', 'unavailable') else []
        except ValueError:
            prices = []
        sources_ok = sources_ok and bool(prices)
        for room in resolved_rooms(snapshot):
            if not room_electric(room, snapshot) or air_room(room, snapshot) or room.get('heat_control') == 'zone_member':
                continue
            planned = data.get('rooms', {}).get(room['id'], {}).get('plan')
            rows = (planned or {}).get('slots', [])
            current_plan = rows and stamp(rows[0]['start']) <= now < stamp(rows[-1]['end'])
            if snapshot['heating_enabled'] and sources_ok and (self.value(room['temperature_entity']) is not None) and current_plan:
                target = thermostat_state(planned, now)['setpoint']
            else:
                target = self.fallback_target(room)
                fallback.append(room['name'])
            targets[room['id']] = target
        permitted = lambda: self.settings == snapshot and self.live_enabled()
        control_rooms=[{**room,'control_minimum':snapshot['minimum'] if targets[room['id']]>=snapshot['minimum'] else None,
                        'control_maximum':snapshot['maximum']} for room in resolved_rooms(snapshot) if room['id'] in targets]
        errors = release_errors + await self.control.apply(control_rooms, targets, now.timestamp(), permitted)
        errors += await self.air_control.apply(
            [r for r in air_rooms if r.get('zone_control_enabled', True)],
            intents,
            now.timestamp(),
            permitted
        )
        for rid,status in self.air_control.results.items():
            if rid.startswith('zone:') and rid[5:] in data.get('zones', {}):
                data['zones'][rid[5:]]['pump_control'] = status
            elif rid in data.get('rooms', {}):
                data['rooms'][rid]['pump_control'] = status
        errors.extend(error for intent in intents.values() for error in intent['errors'])
        for room in resolved_rooms(snapshot)+[r for r in zone_rooms(snapshot) if r['heat_control']!='zone_member']:
            if room['id'] in self.control.results or room['id'] in self.air_control.results:
                self.managed_rooms[room['thermostat']] = deepcopy(room)
        if fallback and snapshot['heating_enabled']:
            errors.append(f"{self.fallback_summary()['season'].capitalize()} fallback targets are being used because required data or a current heating plan is unavailable: "+', '.join(fallback)+'.')
        await self.store.async_save(self.storage_data())
        return {
            'mode': 'live' if snapshot['heating_enabled'] else 'paused',
            'errors': errors,
            'fallback_rooms': fallback,
            'targets': dict(self.control.results),
            'heat_pumps': dict(self.air_control.results)
        }

    async def apply_season_targets(self, heating_active):
        errors = []
        if not electric_heating(self.settings) or not self.settings['apply_season_setpoints'] or self.live_enabled():
            self.applied_season_targets.clear()
            return errors
        for room in resolved_rooms(self.settings):
            if not room_electric(room, self.settings) or air_room(room, self.settings) or room.get('heat_control') == 'zone_member':
                continue
            target = room['baseline'] if heating_active else self.fallback_target(room)
            state = self.hass.states.get(room['thermostat'])
            if target is None or state is None or state.state in ('unknown', 'unavailable'):
                errors.append(f"{room['name']}: season setpoint could not be applied; source or thermostat unavailable.")
                continue
            if not state.attributes.get('min_temp', 5) <= target <= state.attributes.get('max_temp', 35):
                errors.append(f"{room['name']}: season setpoint is outside thermostat limits.")
                continue
            signature = [heating_active, target, room['thermostat']]
            if self.applied_season_targets.get(room['id']) == signature:
                continue
            try:
                await self.hass.services.async_call('climate','set_temperature',
                    {'entity_id':room['thermostat'],'temperature':target},blocking=True)
                self.applied_season_targets[room['id']] = signature
            except Exception:
                errors.append(f"{room['name']}: applying the season setpoint failed; will retry.")
                _LOGGER.warning('Season setpoint failed for %s',room['thermostat'],exc_info=True)
        return errors
