"""Learning uses observed heat and stable windows, independent of who requested it."""
import unittest
from datetime import timedelta
from unittest.mock import patch

import test_manual_sessions as manual_fixtures
from test_coordinator import State, now
from thermal_pilot.const import DEFAULTS, ROOM_DEFAULTS
from thermal_pilot.config import room_settings
from thermal_pilot.model import initial_model, learn


class AirWarmupTests(unittest.TestCase):
    def test_fast_warmups_count_for_garages_and_air_to_air_rooms(self):
        cases = [
            ({'is_garage': True}, 'air_to_water'),
            ({'heat_control': 'air_to_air'}, 'air_to_water'),
            ({'heat_control': 'house'}, 'air_to_air'),
        ]
        for overrides, source in cases:
            with self.subTest(overrides=overrides, source=source):
                room = room_settings({**ROOM_DEFAULTS, **overrides},
                                     {**DEFAULTS, 'house_heat_source': source})
                self.assertTrue(room['air_control'])
                model = initial_model(room)
                previous = {'time': 0, 'temperature': 11, 'outdoor': 3, 'activity': 1}
                current = {**previous, 'time': 300, 'temperature': 11.7}
                learn(model, room, previous, current)
                self.assertAlmostEqual(model['heated_hours'], 5 / 60)
                self.assertEqual(model['samples'], 1)

    def test_slow_system_guard_and_air_sensor_spike_exclusions_are_retained(self):
        for air, rise in [(False, .7), (True, 3)]:
            with self.subTest(air=air):
                room = {**DEFAULTS, **ROOM_DEFAULTS, 'air_control': air}
                model = initial_model(room)
                previous = {'time': 0, 'temperature': 11, 'outdoor': 3, 'activity': 1}
                learn(model, room, previous, {**previous, 'time': 300, 'temperature': 11 + rise})
                self.assertEqual(model['heated_hours'], 0)
                self.assertEqual(model['samples'], 0)


class LearningWindowTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await manual_fixtures.ManualSessionTests.asyncSetUp(self)
        garage = next(room for room in self.coordinator.settings['rooms'] if room['id'] == 'garage')
        garage['garage_door_entities'] = ['binary_sensor.garage_door']
        self.hass.states['binary_sensor.garage_door'] = State('off')
        self.hass.states['climate.garage'].state = 'heat'
        self.hass.states['climate.garage'].attributes['hvac_action'] = 'heating'
        self.coordinator.previous.pop('garage', None)

    async def asyncTearDown(self):
        await manual_fixtures.ManualSessionTests.asyncTearDown(self)

    async def observe(self, minute, temperature):
        self.hass.states['sensor.garage'].state = str(temperature)
        with patch('thermal_pilot.coordinator.dt_util.utcnow', return_value=now + timedelta(minutes=minute)):
            self.coordinator.data = await self.coordinator._async_update_data()

    async def test_minute_refreshes_do_not_starve_manual_heating_collection(self):
        await self.observe(0, 11)
        await manual_fixtures.ManualSessionTests.start(self, minutes=120, target=18)
        for minute in range(1, 13):
            await self.observe(minute, 11 + minute * .1)
        model = self.coordinator.models['garage']
        self.assertAlmostEqual(model['heated_hours'], .2)
        self.assertEqual(model['samples'], 4)

    async def test_closing_a_door_starts_a_clean_learning_window(self):
        self.hass.states['binary_sensor.garage_door'].state = 'on'
        await self.observe(0, 11)
        await self.observe(1, 11.1)
        self.hass.states['binary_sensor.garage_door'].state = 'off'
        for minute in range(2, 6):
            await self.observe(minute, 11 + minute * .1)
        self.assertAlmostEqual(self.coordinator.models['garage']['heated_hours'], .05)

    async def test_heating_and_idle_transitions_do_not_mix_short_windows(self):
        pump = self.hass.states['climate.garage']
        pump.state = 'fan_only';pump.attributes['hvac_action'] = 'fan'
        await self.observe(0, 11)
        pump.state = 'heat';pump.attributes['hvac_action'] = 'heating'
        for minute in range(1, 5):
            await self.observe(minute, 11 + minute * .1)
        pump.state = 'fan_only';pump.attributes['hvac_action'] = 'fan'
        for minute in range(5, 9):
            await self.observe(minute, 11.4)
        model = self.coordinator.models['garage']
        self.assertAlmostEqual(model['heated_hours'], .05)
        self.assertAlmostEqual(model['idle_hours'], .05)
