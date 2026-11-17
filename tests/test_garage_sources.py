"""Garage source selection and control; Home Assistant services are test doubles."""
from copy import deepcopy
from datetime import timedelta
from unittest.mock import patch
import unittest

import test_air_control
import test_coordinator
from test_coordinator import now, State
from thermal_pilot.config import (
    SOURCE_FIELDS, air_room, electric_heating, room_electric, room_settings, resolved_rooms, stored_settings, validate,
)


class GarageSourceValidationTests(unittest.TestCase):
    def setUp(self):
        test_air_control.AirTests.setUp(self)
        self.settings['house_heat_source'] = 'gas_boiler'
        self.pump.state = 'off'
        self.pump.attributes = {'hvac_modes': ['heat', 'off'], 'min_temp': 5, 'max_temp': 35}

    def test_every_house_source_can_be_selected_for_a_garage(self):
        choices = next(field[2] for field in SOURCE_FIELDS if field[0] == 'house_heat_source')[7:].split(',')
        for source in choices:
            with self.subTest(source=source):
                self.room['garage_heat_source'] = 'house'
                self.settings['house_heat_source'] = source
                if source == 'air_to_air':
                    self.pump.attributes.update(hvac_modes=['heat', 'fan_only', 'off'],
                                                fan_modes=['low', 'medium', 'high'], swing_modes=['both'])
                else:
                    self.pump.attributes['hvac_modes'] = ['heat', 'off']
                saved = validate(self.settings, self.hass)
                room = saved['rooms'][0]
                self.assertEqual(room['garage_heat_source'], 'house')
                self.assertEqual(resolved_rooms(saved)[0]['garage_heat_source'], source)
                self.assertEqual(air_room(room, saved), source == 'air_to_air')
                self.assertEqual(room_electric(room, saved), source in (
                    'air_to_air', 'air_to_water', 'ground_source', 'electric_resistance'))
                self.assertEqual(electric_heating(saved), room_electric(room, saved))
                self.assertEqual(bool(room_settings(room, saved).get('air_control')), source == 'air_to_air')

    def test_existing_garages_keep_their_pump_without_migration(self):
        self.room.pop('garage_heat_source', None)
        self.pump.attributes.update(hvac_modes=['heat', 'fan_only', 'off'],
                                    fan_modes=['low', 'medium', 'high'], swing_modes=['both'])
        saved = validate(self.settings, self.hass)
        self.assertEqual(saved['rooms'][0]['garage_heat_source'], 'air_to_air')
        self.assertTrue(air_room(saved['rooms'][0], saved))

    def test_explicit_pump_stays_independent_and_legacy_migration_is_safe(self):
        from thermal_pilot.const import ROOM_DEFAULTS
        self.assertEqual(ROOM_DEFAULTS['garage_heat_source'], 'house')
        self.room['garage_heat_source'] = 'air_to_air'
        self.pump.attributes.update(hvac_modes=['heat', 'fan_only', 'off'],
                                    fan_modes=['low', 'medium', 'high'], swing_modes=['both'])
        saved = validate(self.settings, self.hass)
        self.assertTrue(room_electric(saved['rooms'][0], saved))
        self.room.pop('garage_heat_source')
        migrated = stored_settings(self.settings, {})
        self.assertEqual(migrated['rooms'][0]['garage_heat_source'], 'air_to_air')

    def test_regular_thermostat_does_not_need_fan_or_swing_modes(self):
        self.room['garage_heat_source'] = 'house'
        self.settings['house_heat_source'] = 'electric_resistance'
        self.settings.update(simulation_enabled=False, summer_setpoint=10)
        self.pump.attributes['max_temp'] = 9
        # The house summer target and stale hidden pump settings do not apply.
        validate(self.settings, self.hass)
        self.pump.attributes['hvac_modes'] = ['heat']
        with self.assertRaisesRegex(ValueError, 'heating and off'):
            validate(self.settings, self.hass)


class GarageThermostatControlTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await test_coordinator.CoordinatorTests.asyncSetUp(self)
        self.room = self.c.settings['rooms'][0]
        self.room.update(is_garage=True, garage_heat_source='house',
                         garage_door_entities=['binary_sensor.door'],
                         garage_fan_heat='high', garage_swing='both')
        self.c.settings.update(house_heat_source='electric_resistance', house_distribution='electric_floor',
                               price_entity='', simulation_enabled=False, live_control_confirmed=True)
        self.hass.states['climate.room'] = State('off', {
            'hvac_modes': ['heat', 'off'], 'hvac_action': 'off',
            'min_temp': 5, 'max_temp': 35, 'temperature': 20, 'target_temp_step': .5,
        })
        self.hass.states['sensor.room'].state = '4'
        self.hass.states['binary_sensor.door'] = State('on')

    async def asyncTearDown(self):
        self.temp.cleanup()

    async def test_temperature_cycle_uses_own_bounds_and_no_pump_commands(self):
        data = await self.c._async_update_data()
        intent = data['rooms'][self.room['id']]['pump_suggestion']
        self.assertEqual((intent['mode'], intent['target'], intent['fan'], intent['swing']), ('heat', 9, '', ''))
        self.assertFalse(data['rooms'][self.room['id']]['air_control'])
        self.assertEqual(data['rooms'][self.room['id']]['plan']['setpoint'], 9)
        self.assertFalse(data['control']['errors'])
        self.hass.services.async_call.assert_awaited_once_with(
            'climate', 'set_hvac_mode', {'entity_id': 'climate.room', 'hvac_mode': 'heat'}, blocking=True)

        self.hass.states['climate.room'].state = 'heat'
        self.hass.states['climate.room'].attributes['hvac_action'] = 'heating'
        later = now + timedelta(seconds=20)
        with patch('thermal_pilot.coordinator.dt_util.utcnow', return_value=later):
            await self.c._async_update_data()
        self.assertTrue(any(call.args[1] == 'set_temperature' and call.args[2]['temperature'] == 9
                            for call in self.hass.services.async_call.await_args_list))
        self.hass.states['sensor.room'].state = '9'
        with patch('thermal_pilot.coordinator.dt_util.utcnow', return_value=later + timedelta(seconds=20)):
            data = await self.c._async_update_data()
        self.assertEqual(data['rooms'][self.room['id']]['pump_suggestion']['mode'], 'off')
        self.assertTrue(all(call.args[1] not in ('set_fan_mode', 'set_swing_mode')
                            for call in self.hass.services.async_call.await_args_list))
        self.assertFalse(self.c.control.results, 'the ordinary room writer must not fight the garage controller')

    async def test_reversal_and_invalid_targets_use_off_without_fan_commands(self):
        room_id = self.room['id']
        thermostat = self.hass.states['climate.room']
        thermostat.state = 'cool'
        thermostat.attributes['hvac_modes'] = ['heat', 'cool', 'off']
        intent = self.c.air_control.intent(self.room, self.c.settings, now.timestamp())
        await self.c.air_control.apply([self.room], {room_id: intent}, now.timestamp(), lambda: True)
        self.assertEqual(self.hass.services.async_call.await_args.args[2]['hvac_mode'], 'off')
        self.c.air_control.reversals.clear()
        self.c.air_control.thermal_modes.clear()
        thermostat.state = 'heat'
        thermostat.attributes['max_temp'] = 8
        self.c.air_control.ready[self.room['thermostat']] = 0
        errors = await self.c.air_control.apply([self.room], {room_id: intent}, now.timestamp() + 20, lambda: True)
        self.assertTrue(errors)
        self.assertEqual(self.hass.services.async_call.await_args.args[2]['hvac_mode'], 'off')

    async def test_hydronic_manual_session_uses_garage_target_not_house_boost(self):
        self.c.settings.update(house_distribution='water_floor')
        self.c.settings['house_heat_source'] = 'air_to_water'
        self.hass.states['sensor.room'].state = '7'
        self.c.data = await self.c._async_update_data()
        control = self.c.manual_controls()[self.room['id']]
        self.assertFalse(control['target_required'])
        self.assertEqual(control['heat_target'], 9)
        self.assertEqual(control['modes'], ['heat'])
        await self.c.set_manual_session(self.room['id'], 'heat', 60, None, now)
        self.assertEqual(self.c.manual_sessions[self.room['id']]['target'], 9)
        self.assertEqual(self.c.data['rooms'][self.room['id']]['pump_suggestion']['target'], 9)

    async def test_non_electric_sources_do_not_generate_plans_or_control_commands(self):
        for source in ('oil_boiler', 'gas_boiler', 'wood_boiler', 'pellet_boiler', 'district_heating', 'other'):
            with self.subTest(source=source):
                self.c.settings['house_heat_source'] = source
                data = await self.c._async_update_data()
                self.assertIsNone(data['rooms'][self.room['id']]['plan'])
                self.assertNotIn(self.room['id'], self.c.manual_controls())
                self.hass.services.async_call.assert_not_awaited()


if __name__ == '__main__':
    unittest.main()
