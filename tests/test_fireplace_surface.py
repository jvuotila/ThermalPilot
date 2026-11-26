"""Verify fireplace learning, forecast taper, and active-sensor compatibility."""

from datetime import timedelta
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import patch

import test_coordinator
from test_coordinator import State, now
from thermal_pilot.const import DEFAULTS, ROOM_DEFAULTS
from thermal_pilot.fireplace_surface import (
    sample_surface, surface_gain_rates, surface_heat_forecast,
)
from thermal_pilot.model import Slot, initial_model, learn, plan


class FireplaceSurfaceTests(TestCase):
    def test_learn_linked_room_response_only_from_multiple_distinct_fires(self):
        room = {**DEFAULTS, **ROOM_DEFAULTS, 'baseline': 20}
        model = initial_model(room)
        model.update(parameter_updates=1, loss=.01, base_gain=0)
        reading = {'entity': 'sensor.stove', 'cycle': 0, 'excess': 20}
        for cycle in (0, 200_000):
            reading = {**reading, 'cycle': cycle}
            for step in range(8):
                previous = {
                    'time': cycle + step * 900, 'temperature': 20, 'outdoor': 0,
                    'activity': 0, 'excluded': True, 'fireplace_fit_allowed': True,
                    'fireplace_surfaces': {'stove': reading},
                }
                current = {**previous, 'time': previous['time'] + 900, 'temperature': 20.05}
                learn(model, room, previous, current)
            if cycle == 0:
                self.assertEqual(surface_gain_rates(model, {'stove': reading}), {})

        self.assertAlmostEqual(surface_gain_rates(model, {'stove': reading})['stove'], .4)
        self.assertAlmostEqual(surface_gain_rates(
            model, {'stove': {**reading, 'excess': 10}},
        )['stove'], .2)
        self.assertEqual(surface_gain_rates(
            model, {'stove': {**reading, 'entity': 'sensor.replacement'}},
        ), {})
        self.assertEqual(model['samples'], 0)
        self.assertEqual(model['loss'], .01)

    def test_decay_uses_cooling_trend_without_inventing_more_heat(self):
        record = {}
        first = sample_surface(record, 0, 50, 20)
        for minute in range(5, 181, 5):
            reading = sample_surface(record, minute * 60, 20 + 30 * 2 ** (-minute / 120), 20)
        self.assertEqual(reading['cycle'], first['cycle'])
        self.assertAlmostEqual(reading['half_life'], 2, delta=.2)
        slots = [Slot(now + timedelta(hours=hour), now + timedelta(hours=hour + 1), 10)
                 for hour in (0, 4, 24)]
        fresh, later, next_day = surface_heat_forecast(
            {'stove': .8}, {'stove': reading}, slots, now,
        )
        self.assertEqual(fresh, .5)
        self.assertGreater(fresh, later)
        self.assertLess(next_day, .01)
        self.assertIsNone(sample_surface(record, 48 * 3600, 20, 20))
        self.assertEqual(sample_surface(record, 60 * 3600, 50, 20)['cycle'], 60 * 3600)

    def test_another_firing_starts_a_new_cycle_even_while_the_masonry_is_warm(self):
        record = {}
        first = sample_surface(record, 0, 50, 20, True)
        cooling = sample_surface(record, 3 * 3600, 44, 20, False)
        self.assertEqual(cooling['cycle'], first['cycle'])
        reheated = sample_surface(record, 24 * 3600, 55, 20, True)
        self.assertEqual(reheated['cycle'], 24 * 3600)


class FireplaceSurfaceCoordinatorTests(IsolatedAsyncioTestCase):
    asyncSetUp = test_coordinator.CoordinatorTests.asyncSetUp
    asyncTearDown = test_coordinator.CoordinatorTests.asyncTearDown

    async def test_residual_heat_reaches_linked_room_plan_after_damper_closes(self):
        room = self.c.settings['rooms'][0]
        room['fireplace_reduction'] = -40
        entity = 'sensor.stove_surface'
        self.c.settings['fireplaces'] = [{
            'id': 'stove', 'fireplace_entity': 'binary_sensor.damper',
            'fireplace_active_state': 'on', 'room_ids': [room['id']],
            'surface_temperature_entity': entity,
        }]
        self.hass.states[entity] = State('104', {'unit_of_measurement': '°F'})
        self.hass.states['binary_sensor.damper'] = State('off')
        model = self.c.models.setdefault(room['id'], initial_model(room))
        model['fireplace_surface_gains'] = {'stove': {
            'entity': entity, 'cycles': [
                {'start': cycle, 'hours': 2, 'xx': 800, 'xy': 12}
                for cycle in (1, 2)
            ],
        }}
        with patch('thermal_pilot.coordinator.plan', wraps=plan) as planner:
            await self.c._async_update_data()
        settings, *_, legacy_compensation = planner.call_args.args
        self.assertFalse(legacy_compensation)
        gains = settings['fireplace_heat_forecast']
        self.assertGreater(gains[0], gains[-1])
        observed = next(row for row in self.c.history_db.read(0) if row.get('zone_id') == 'stove')
        self.assertEqual(observed['surface_temperature'], 40)
        self.assertIsNone(observed['zone_mode'])

        # Reload from the persisted checkpoint, as after a Home Assistant restart.
        self.c.fireplace_surfaces.clear()
        await self.c.load()
        self.assertEqual(self.c.fireplace_surfaces['stove']['cycle'], now.timestamp())
        self.assertIn('stove', self.c.models[room['id']]['fireplace_surface_gains'])

        self.hass.states[entity].last_reported = now - timedelta(hours=4)
        self.hass.states['binary_sensor.damper'].state = 'on'
        with patch('thermal_pilot.coordinator.plan', wraps=plan) as planner:
            await self.c._async_update_data()
        settings, *_, legacy_compensation = planner.call_args.args
        self.assertTrue(legacy_compensation)
        self.assertNotIn('fireplace_heat_forecast', settings)
