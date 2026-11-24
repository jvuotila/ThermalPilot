"""Staged mode control for air-to-air pumps and independent garage thermostats."""
from typing import Any
import asyncio
from .model import number
from .sources import temperature_celsius
from .config import resolved_rooms, zone_rooms, garage_sensor_lists, garage_thermostat, room_heat_source, pump_uses_setpoints, pump_temperature_settings


def binary(hass, entity):
    if not entity:
        return False
    state = hass.states.get(entity)
    return state.state == 'on' if state and state.state in ('on', 'off') else None


def zone_temperature_readings(hass, room, settings):
    """Read all linked members so one cold or missing sensor can protect the zone."""
    members = [room]
    for candidate in resolved_rooms(settings) + zone_rooms(settings):
        if (candidate.get('heat_control') == 'zone_member'
                and candidate['thermostat'] == room['thermostat']):
            members.append(candidate)
    values = []
    for member in members:
        state = hass.states.get(member['temperature_entity'])
        try:
            value = temperature_celsius(state.state, state.attributes.get('unit_of_measurement', '°C')) if state else None
        except ValueError:
            value = None
        if value is None:
            return []
        values.append(value)
    return values


def zone_temperature(
    hass: Any, room: dict[str, Any], settings: dict[str, Any],
) -> tuple[float | None, bool]:
    """Apply the zone policy only when every linked room can be read."""
    values = zone_temperature_readings(hass, room, settings)
    if not values:
        return (None, False)
    if room.get('is_garage'):
        upper_limit = room['garage_maximum']
        policy = 'main'
    else:
        upper_limit = pump_temperature_settings(settings)['maximum'] if pump_uses_setpoints(room, settings) else settings['maximum']
        policy = room.get('zone_policy', settings.get('air_zone_temperature', 'main'))
    too_warm = any((value >= upper_limit for value in values))
    if policy == 'coldest':
        temperature = min(values)
    elif policy == 'average':
        temperature = sum(values) / len(values)
    else:
        temperature = values[0]
    return (temperature, too_warm)


class AirHeatPumpControl:
    def __init__(self, hass):
        self.hass = hass
        self.cycles = {}
        self.doors = {}
        self.pending = {}
        self.ready = {}
        self.rejected_targets = {}
        self.zone_seasons = {}
        self.reversals = {}
        self.thermal_modes = {}
        self.results = {}
        self.reconciled = set()
        self.lock = asyncio.Lock()
        self.deadlines = []

    def intent(
        self, room: dict[str, Any], settings: dict[str, Any], now: float,
        planned: dict[str, Any] | None = None, enabled: bool = True,
        release: bool = False, summer: bool = False,
    ) -> dict[str, Any]:
        """Choose heating/standby from room limits, plan and garage interlocks.

        This produces an intent only. Device acknowledgement and staged service
        calls belong to apply(). The pump's internal setpoint is separate from
        the external room sensor used for hysteresis and safety limits.
        """
        room = garage_sensor_lists(room)
        if room.get('is_garage'):
            room['garage_heat_source'] = room_heat_source(room, settings)
        use_setpoints = pump_uses_setpoints(room, settings)
        manual = room.get('manual_session')
        if manual and manual['ends'] <= now:
            manual = None
        circulation = None
        if room.get('active_fireplaces') and enabled and not release and not manual:
            state = self.hass.states.get(room['thermostat'])
            temperatures = zone_temperature_readings(self.hass, room, settings)
            minimum = pump_temperature_settings(settings)['minimum'] if use_setpoints else settings['minimum']
            if (temperatures and min(temperatures) > minimum and state is not None
                    and state.state not in ('unknown', 'unavailable', 'cool')
                    and state.attributes.get('hvac_action') != 'cooling'
                    and 'fan_only' in state.attributes.get('hvac_modes', [])):
                circulation = {
                    'mode': 'fan_only', 'target': None, 'fan': room.get('fireplace_fan', ''),
                    'swing': room.get('fireplace_swing', ''), 'errors': [],
                    'reason': 'Fireplace air circulation', 'fireplaces': room['active_fireplaces'],
                }
        if room.get('heating_zone_id') and (not room.get('is_garage')) and not manual:
            season = self.zone_season(room['heating_zone_id'], summer, now)
            use = room.get('zone_climate_mode', 'heat')
            # Heating-only setpoint control keeps a maintenance target even in
            # summer. Explicit cooling and its changeover retain their safeguards.
            if use == 'cool' or (season and (not use_setpoints or (use == 'both' and enabled and not release))):
                cooling_enabled = enabled and (not release) and season and (use in ('cool', 'both'))
                cooling = self.cooling_intent(room, settings, now, cooling_enabled)
                if circulation and cooling['mode'] == 'fan_only' and not cooling['errors']:
                    return circulation
                return cooling
        if circulation:
            return circulation

        room_id = room['id']
        garage = room.get('is_garage', False)
        state = self.hass.states.get(room['thermostat'])
        temperature, too_warm = zone_temperature(self.hass, room, settings)
        outdoor_state = self.hass.states.get(settings['outdoor_entity'])
        outdoor = number(outdoor_state.state) if outdoor_state else None
        prefix = 'garage_' if garage else 'air_'
        values = room if garage else settings
        target = values[prefix + 'heat_target']
        thermostat = garage_thermostat(room)
        standby = 'off' if thermostat else 'fan_only'
        if thermostat:
            target = room['garage_maximum']
        mode = standby
        reason = 'Standby'
        errors = []
        lower_limit = room['garage_minimum'] if garage else settings['minimum']
        members = [room]
        for candidate in resolved_rooms(settings) + zone_rooms(settings):
            if (candidate.get('heat_control') == 'zone_member'
                    and candidate['thermostat'] == room['thermostat']):
                members.append(candidate)
        too_cold = False
        if temperature is not None:
            too_cold = any(
                number(self.hass.states.get(member['temperature_entity']).state) < lower_limit
                for member in members
            )
        signature = (
            room['thermostat'], room['temperature_entity'], garage, lower_limit,
            room.get('garage_maximum'), room.get('garage_strategy'), room.get('garage_heat_source', 'air_to_air'),
        )
        old_cycle = self.cycles.get(room_id, {})
        if old_cycle.get('signature') == signature:
            heating = old_cycle.get('heating', state is not None and state.state == 'heat')
        else:
            heating = bool(state and state.state == 'heat')
        if use_setpoints:
            # Heat is an operating mode, not proof the compressor is running.
            heating = bool(state and state.attributes.get('hvac_action') == 'heating')

        if room.get('manual_session_ended') or room.get('solar_session_ended'):
            heating = False
        door_entities = room.get('garage_door_entities', []) if garage and not thermostat else []
        door_states = {entity: binary(self.hass, entity) for entity in door_entities}
        door_open = any((value is True for value in door_states.values()))
        doors_valid = all((value is not None for value in door_states.values()))
        paused = False
        if door_open:
            observed_open_times = []
            for entity, value in door_states.items():
                if value is not True:
                    continue
                changed = getattr(self.hass.states.get(entity), 'last_changed', None)
                if hasattr(changed, 'timestamp'):
                    observed_open_times.append(min(now, changed.timestamp()))
                else:
                    observed_open_times.append(now)
            # One timer covers all doors. Opening another door must not restart it.
            opened_since = self.doors.setdefault(room_id, min(observed_open_times))
            deadline = opened_since + room['garage_door_delay']
            paused = now >= deadline
            if not paused:
                self.deadlines.append(deadline)
        elif doors_valid:
            self.doors.pop(room_id, None)

        if use_setpoints and not manual and doors_valid and not paused and (not door_open or heating):
            if garage:
                normal_target = minimum = room['garage_minimum']
                maximum = room['garage_maximum']
                reduced_target = normal_target
                boosted_target = maximum
            else:
                limits = pump_temperature_settings(settings)
                minimum = limits['minimum']
                maximum = limits['maximum']
                normal_target = max(minimum, min(maximum, room['baseline']))
                reduced_target = max(minimum, normal_target + limits['setback'])
                boosted_target = min(maximum, normal_target + limits['boost'])
            target = normal_target
            reason = 'Pump thermostat: normal target'
            if not enabled or release or not doors_valid or temperature is None or outdoor is None:
                reason = 'Pump thermostat: maintenance target'
            elif room.get('away_target') is not None and not garage:
                target = min(normal_target, room['away_target'])
                reason = 'Away temperature schedule'
            elif too_warm:
                target = reduced_target
                reason = 'Garage upper limit reached' if garage else 'Zone upper limit reached'
            elif room.get('solar_session') or room.get('preferred_heat_request'):
                target = boosted_target
                reason = 'Solar heating session' if room.get('solar_session') else 'Heat pump preferred'
            elif not garage and summer:
                target = min(normal_target, settings['summer_setpoint'])
                reason = 'Pump thermostat: maintenance target'
            elif planned and (not garage or room['garage_strategy'] == 'tariff'):
                target = max(minimum, min(maximum, planned.get('setpoint', normal_target)))
                reason = 'Pump thermostat: scheduled target'
            fan = values.get(prefix + 'fan_heat', '')
            if garage and any(binary(self.hass, entity) is True for entity in room.get('garage_presence_entities', [])):
                fan = room.get('garage_fan_presence') or fan
            return {'mode': 'heat', 'target': target, 'fan': fan,
                    'swing': values.get(prefix + 'swing', ''), 'reason': reason,
                    'errors': [], 'keep_heat': True, 'clamp_target': True}

        valid = temperature is not None and (manual or outdoor is not None) and doors_valid
        if not enabled or release:
            heating = False
            reason = 'Heating paused'
        elif not valid:
            heating = False
            reason = 'Required heat pump input unavailable'
            errors.append(
                f"{room['name']}: required temperature or configured control input unavailable; "
                + ('using off standby.' if thermostat else 'using fan-only standby.')
            )
        elif paused or (door_open and not (heating or (manual and state and state.state == 'cool'))):
            heating = False
            reason = 'Garage door open: heating paused'
        elif manual:
            heating = manual['mode'] == 'heat'
            mode = manual['mode']
            target = manual['target']
            reason = 'Manual heating' if heating else 'Manual cooling'
        elif room.get('away_target') is not None and not garage:
            away_target = room['away_target']
            if summer or too_warm:
                heating = False
            elif temperature <= away_target - .2:
                heating = True
            elif temperature >= away_target + .2:
                heating = False
            reason = 'Away temperature schedule'
        elif room.get('solar_session') and not too_warm:
            heating = True
            reason = 'Solar heating session'
        elif room.get('preferred_heat_request') and not garage:
            heating = not too_warm
            reason = 'Heat pump preferred' if heating else 'Zone upper limit reached'
        elif garage:
            if outdoor > lower_limit:
                heating = False
                reason = 'Warm weather'
            elif too_warm:
                heating = False
                reason = 'Garage upper limit reached'
            elif temperature < lower_limit:
                heating = True
                reason = 'Garage below lower limit'
            elif room['garage_strategy'] == 'tariff' and planned is not None:
                heating = bool(planned.get('heat'))
                reason = 'Tariff heating plan' if heating else 'Tariff standby'
            else:
                # Between the two limits, keep the previous cycle direction.
                reason = 'Garage temperature cycle' if heating else 'Standby'
        else:
            if too_warm:
                heating = False
                reason = 'Zone upper limit reached'
            elif too_cold:
                heating = True
                reason = 'Zone below lower limit'
            elif planned is None and not (
                room.get('heating_zone_id') and room.get('zone_heating_strategy') == 'temperature'
            ):
                # Missing prices preserve ordinary room comfort independently of tariffs.
                heating = temperature < room['baseline']
                reason = 'Room comfort fallback'
            elif room.get('heating_zone_id') and room.get('zone_heating_strategy') == 'temperature':
                if temperature <= room['baseline'] - 0.2:
                    heating = True
                elif temperature >= room['baseline'] + 0.2:
                    heating = False
                reason = 'Zone temperature control' if heating else 'Zone temperature standby'
            else:
                heating = bool(planned.get('heat')) or temperature < planned.get('setpoint', room['baseline'])
                reason = 'Room heating plan' if heating else 'Standby'
        if heating:
            mode = 'heat'
        elif not manual and garage and outdoor is not None and (outdoor > lower_limit) and (not paused) and valid:
            mode = 'off'
        self.cycles[room_id] = {'signature': signature, 'heating': heating}
        fan_key = 'fan_heat' if heating else 'fan_idle'
        fan = values.get(prefix + fan_key, '')
        if garage and mode != 'off':
            presence = [binary(self.hass, entity) for entity in room.get('garage_presence_entities', [])]
            if any((value is True for value in presence)):
                fan = room.get('garage_fan_presence') or fan
        swing_key = 'swing' if heating else 'swing_idle'
        swing = values.get(prefix + swing_key, '')
        if mode == 'cool':
            fan = settings.get('air_fan_cool', '')
            swing = settings.get('air_swing_cool', '')
        if thermostat:
            fan = ''
            swing = ''
        if mode == 'off':
            swing = ''
        return {
            'mode': mode, 'target': target if mode in ('heat', 'cool') else None,
            'fan': fan if mode != 'off' else '',
            'swing': swing,
            'reason': reason, 'errors': errors,
            **({'keep_heat': True} if use_setpoints and mode == 'heat' else {}),
        }

    def zone_season(self, zone, summer, now):
        """A changed automatic season must persist for 24 hours before adoption."""
        status = self.zone_seasons.setdefault(zone, {'summer': bool(summer), 'candidate': bool(summer), 'since': now})
        if status['candidate'] != bool(summer):
            status.update(candidate=bool(summer),since=now)
        if status['summer'] != status['candidate'] and now - status['since'] >= 86400:
            status['summer'] = status['candidate']
        return status['summer']

    def cooling_intent(
        self, room: dict[str, Any], settings: dict[str, Any], now: float, enabled: bool,
    ) -> dict[str, Any]:
        """Preserve cooling hysteresis while protecting the coldest linked room."""
        temperature, _ = zone_temperature(self.hass, room, settings)
        state = self.hass.states.get(room['thermostat'])
        target = room.get('zone_cooling_target', 24.0)
        if room.get('away_cooling_target') is not None:
            target = max(target, room['away_cooling_target'])
        signature = ('cool', room['thermostat'], target, room.get('zone_policy', 'main'))
        old_cycle = self.cycles.get(room['id'], {})
        if old_cycle.get('signature') == signature:
            cooling = old_cycle.get('cooling', False)
        else:
            cooling = bool(state and state.state == 'cool')
        members = [room]
        for candidate in resolved_rooms(settings) + zone_rooms(settings):
            if (candidate.get('heat_control') == 'zone_member'
                    and candidate['thermostat'] == room['thermostat']):
                members.append(candidate)
        valid = temperature is not None
        too_cold = valid and any(
            number(self.hass.states.get(member['temperature_entity']).state) <= target
            for member in members
        )
        if not enabled or not valid or too_cold:
            cooling = False
        elif temperature >= target + 0.5:
            cooling = True
        self.cycles[room['id']] = {'signature': signature, 'cooling': cooling, 'heating': False}
        standby = 'fan_only'
        if not enabled and state and (state.state == 'off'):
            standby = 'off'
        if cooling:
            reason = 'Zone cooling'
        elif enabled:
            reason = 'Cooling standby'
        else:
            reason = 'Seasonal standby'
        errors = []
        if not valid:
            errors.append(f"{room['name']}: zone temperature unavailable; using fan-only standby.")
        if room.get('away_cooling_target') is not None and reason in ('Zone cooling', 'Cooling standby'):
            reason = 'Away cooling temperature'
        return {
            'mode': 'cool' if cooling else standby, 'target': target if cooling else None,
            'fan': settings.get('air_fan_cool' if cooling else 'air_fan_idle', ''),
            'swing': settings.get('air_swing_cool' if cooling else 'air_swing_idle', ''),
            'reason': reason, 'errors': errors,
        }

    async def apply(self, rooms, intents, now, permitted):
        """One command per pump per pass; later stages require reported acknowledgement.

Poll at ten seconds, retry the unacknowledged stage at sixty seconds. A changed
mode countercommands pending work immediately. HA state is feedback, not proof
of physical compressor operation, especially with optimistic integrations.
"""
        errors = []
        self.results = {}
        async with self.lock:
            for room in rooms:
                if not permitted():
                    break
                intent = intents[room['id']]
                entity = room['thermostat']
                room_id = room['id']
                state = self.hass.states.get(entity)
                if not state or state.state in ('unknown', 'unavailable'):
                    errors.append(f"{room['name']}: heat pump unavailable.")
                    continue
                attributes = state.attributes
                mode = intent['mode']
                if mode not in attributes.get('hvac_modes', []):
                    errors.append(f"{room['name']}: heat pump does not support {mode}.")
                    continue
                if attributes.get('temperature_unit', '°C') not in ('°C', 'C'):
                    errors.append(f"{room['name']}: heat pump must use Celsius.")
                    continue
                # Pumps reverse through fan-only; ordinary garage thermostats
                # have no fan mode and must acknowledge Off instead.
                standby = 'off' if garage_thermostat(room) else 'fan_only'
                desired_mode = mode
                if state.state in ('heat', 'cool'):
                    self.thermal_modes[entity] = {'mode': state.state, 'time': now}
                last_thermal = self.thermal_modes.get(entity, {})
                pending_mode = self.pending.get((entity, 'hvac_mode'), {}).get('value')
                reversal = self.reversals.get(entity)
                if desired_mode in ('heat', 'cool'):
                    opposite = 'cool' if desired_mode == 'heat' else 'heat'
                    if state.state == opposite or pending_mode == opposite or (last_thermal.get('mode') == opposite and now - last_thermal.get('time', now) < 600):
                        if not reversal or reversal['mode'] != desired_mode:
                            reversal = {'mode': desired_mode, 'since': None}
                            self.reversals[entity] = reversal
                        elif state.state == opposite:
                            reversal['since'] = None
                    if reversal:
                        if reversal['mode'] != desired_mode:
                            reversal = {'mode': desired_mode, 'since': None}
                            self.reversals[entity] = reversal
                        if standby not in attributes.get('hvac_modes', []):
                            if 'off' in attributes.get('hvac_modes', []):
                                standby = 'off'
                            else:
                                errors.append(f"{room['name']}: no supported standby mode for heat pump changeover.")
                                continue
                        if state.state == standby and reversal['since'] is None:
                            reversal['since'] = now
                        if reversal['since'] is None or now - reversal['since'] < 600:
                            mode = standby
                            self.deadlines.append(now+10 if reversal['since'] is None else reversal['since']+600)
                        else:
                            self.reversals.pop(entity,None)
                else:
                    self.reversals.pop(entity,None)
                commands = []
                cancel_start = mode == 'off' and (entity, 'power') in self.pending
                # Home Assistant ClimateEntityFeature.TURN_ON is 256. For devices
                # without it, selecting Heat/Fan only is the supported startup action.
                if mode != 'off' and int(number(attributes.get('supported_features'), 0)) & 256:
                    commands.append(('turn_on','power',True,state.state!='off'))
                elif mode == 'off':
                    self.pending.pop((entity,'power'),None)
                commands.append(('set_hvac_mode','hvac_mode',mode,state.state))
                target = number(intent['target']) if mode in ('heat', 'cool') else None
                rejected = self.rejected_targets.get(entity)
                if rejected and (rejected['target'] != target or rejected.get('mode') != mode):
                    self.rejected_targets.pop(entity,None)
                    rejected = None
                # Bounds are mode-specific. Wait for Heat and its settling period
                # before reading them; never send a temperature in fan-only mode.
                checking_heat = mode in ('heat', 'cool') and state.state == mode and (now >= self.ready.get(entity, now))
                if checking_heat:
                    low = number(attributes.get('min_temp'), 5)
                    high = number(attributes.get('max_temp'), 35)
                    step = number(attributes.get('target_temp_step'), 0.5)
                    if intent.get('clamp_target') and target is not None and low <= high:
                        limited_target = max(low, min(high, target))
                        if limited_target != target:
                            errors.append(f"{room['name']}: requested {target:g} °C is outside pump limits. Using {limited_target:g} °C.")
                        target = limited_target
                    if target is None or not low <= target <= high or step <= 0:
                        rejected = {'target': target, 'low': low, 'high': high, 'mode': mode}
                        self.rejected_targets[entity] = rejected
                    else:
                        rejected = None
                        self.rejected_targets.pop(entity,None)
                        target = round(max(low, min(high, low + round((target - low) / step) * step)), 6)
                        commands.append(('set_temperature','temperature',target,number(attributes.get('temperature'))))
                if rejected and intent.get('keep_heat'):
                    errors.append(f"{room['name']}: temperature setpoint outside device limits ({rejected['low']:g}–{rejected['high']:g} °C).")
                    # Leave the device's last valid setpoint active instead of
                    # switching to Fan only after an invalid manual request.
                    continue
                if rejected:
                    standby = 'off' if garage_thermostat(room) else 'fan-only'
                    errors.append(f"{room['name']}: temperature setpoint outside device limits ({rejected['low']:g}–{rejected['high']:g} °C); using {standby} standby.")
                    # Keep the rejection while in standby, avoiding repeated starts
                    # with an invalid setpoint. A changed target permits a new check.
                    mode = 'off' if garage_thermostat(room) else 'fan_only'
                    commands = [('set_hvac_mode', 'hvac_mode', mode, state.state)]
                if intent['fan'] and (not rejected) and (mode == desired_mode):
                    if intent['fan'] not in attributes.get('fan_modes', []):
                        errors.append(f"{room['name']}: selected fan mode is unsupported.")
                        continue
                    commands.append(('set_fan_mode','fan_mode',intent['fan'],attributes.get('fan_mode')))
                if intent['swing'] and (not rejected) and (mode == desired_mode):
                    if intent['swing'] not in attributes.get('swing_modes', []):
                        errors.append(f"{room['name']}: selected swing mode is unsupported.")
                        continue
                    commands.append(('set_swing_mode','swing_mode',intent['swing'],attributes.get('swing_mode')))
                if mode not in ('heat', 'cool'):
                    self.ready.pop(entity,None)
                self.results[room_id] = {**intent, 'confirmed': False, 'stage': 'checking'}
                if checking_heat and intent.get('clamp_target') and not rejected:
                    self.results[room_id]['target'] = target
                for service,key,value,reported in commands:
                    if not permitted():
                        break
                    if key not in ('power', 'hvac_mode') and mode in ('heat', 'cool') and (now < self.ready.get(entity, now)):
                        self.results[room_id]['stage'] = key
                        self.deadlines.append(self.ready[entity])
                        break
                    pending = self.pending.get((entity, key))
                    opposing = pending is not None and pending['value'] != value or (key == 'hvac_mode' and cancel_start)
                    matches = reported is not None and abs(reported - value) < 0.001 if key == 'temperature' else reported == value
                    needs_initial = key in ('hvac_mode', 'temperature') and (entity, key) not in self.reconciled
                    if matches and (not opposing) and (not needs_initial or pending is not None):
                        self.pending.pop((entity,key),None)
                        self.reconciled.add((entity,key))
                        continue
                    self.results[room_id]['stage'] = key
                    if pending and pending['value'] == value:
                        elapsed = now - pending['time']
                        if pending.get('failed'):
                            errors.append(f"{room['name']}: {service} failed; waiting to retry.")
                        if elapsed < 60:
                            self.deadlines.append(min(now+10,pending['time']+60))
                            break
                        errors.append(f"{room['name']}: heat pump has not confirmed {key}; retrying this stage.")
                    if not permitted():
                        break
                    self.pending[entity, key] = {'value': value, 'time': now}
                    payload = {'entity_id': entity}
                    if key != 'power':
                        payload[key] = value
                    try:
                        await asyncio.wait_for(self.hass.services.async_call('climate',service,payload,blocking=True),15)
                        if key == 'hvac_mode' and value in ('heat', 'cool'):
                            self.ready[entity] = now + 10
                    except Exception:
                        self.pending[entity, key]['failed'] = True
                        errors.append(f"{room['name']}: {service} failed; will retry.")
                    self.deadlines.append(now+10)
                    break  # Wait for reported acknowledgement before the next stage.
                else:
                    if intent['mode'] in ('heat', 'cool') and (not checking_heat) and (not rejected):
                        self.results[room_id]['stage'] = 'temperature'
                        self.deadlines.append(max(now+10,self.ready.get(entity,now)))
                    elif not rejected:
                        self.results[room_id].update(confirmed=True,stage='confirmed')
        return errors
