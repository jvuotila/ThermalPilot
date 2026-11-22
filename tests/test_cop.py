"""COP samples belong to the selected sensor pair and only support local forecasts."""

from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from test_coordinator import Hass, PilotCoordinator, State, now
from thermal_pilot.const import DEFAULTS, ROOM_DEFAULTS
from thermal_pilot.cop import cop_priced_slots, filter_cop_readings, forecast_cop, read_cop
from thermal_pilot.history import HistoryDatabase
from thermal_pilot.model import Slot, initial_model, plan


NOW = 1800000000
SOURCES = ('sensor.heating_cop', 'sensor.outdoor')


def weather(hours, degrees):
    date = datetime.fromtimestamp(NOW + hours * 3600, timezone.utc)
    return {'datetime': date.isoformat(), 'temperature': degrees}


class CopTests(unittest.TestCase):
    def test_cost_tradeoff_depends_on_learned_cop_spread(self):
        start = datetime.fromtimestamp(NOW, timezone.utc)
        midday = start + timedelta(hours=1)
        end = midday + timedelta(hours=1)
        slots = [Slot(start, midday, 10), Slot(midday, end, 14)]
        forecast = [
            {'time': NOW, 'cop': 2},
            {'time': NOW + 3600, 'cop': 3},
        ]
        precise = cop_priced_slots(slots, forecast, start)
        self.assertLess(precise[1].planning_rate, precise[0].planning_rate)
        self.assertEqual([slot.price for slot in precise], [10, 14])
        almost_tied = [slots[0], Slot(midday, end, 14.9)]
        close = cop_priced_slots(almost_tied, forecast, start)
        self.assertLess(14.9 / 3, 10 / 2)
        self.assertLess(close[0].planning_rate, close[1].planning_rate)
        forecast[0].update(lower_cop=1.9, upper_cop=2.1)
        forecast[1].update(lower_cop=2.8, upper_cop=3.2)
        less_certain = cop_priced_slots(slots, forecast, start)
        self.assertGreater(less_certain[1].planning_rate, less_certain[0].planning_rate)

    def test_forecast_gaps_use_tariff_and_partial_slots_use_elapsed_overlap(self):
        start = datetime.fromtimestamp(NOW, timezone.utc)
        slots = [
            Slot(start, start + timedelta(hours=1), 8),
            Slot(start + timedelta(hours=1), start + timedelta(hours=3), 8),
            Slot(start + timedelta(hours=3), start + timedelta(hours=4), 12),
        ]
        first = {'time': NOW, 'cop': 2}
        last = {'time': NOW + 2.5 * 3600, 'cop': 4}
        adjusted = cop_priced_slots(slots, [first, last], start + timedelta(minutes=15))
        self.assertAlmostEqual(adjusted[0].planning_rate, 11.6)
        self.assertAlmostEqual(adjusted[1].planning_rate, 7.55)
        self.assertAlmostEqual(adjusted[2].planning_rate, 10.65)
        self.assertEqual(cop_priced_slots(slots, [], start), slots)
        self.assertEqual(cop_priced_slots(slots, [{'time': NOW + 5 * 3600, 'cop': 4}], start), slots)

    def test_plan_can_shift_to_higher_tariff_and_lower_heat_cost(self):
        start = datetime.fromtimestamp(NOW, timezone.utc)
        room = {
            **DEFAULTS, **ROOM_DEFAULTS, 'minimum': 18, 'maximum': 24, 'boost': 2,
            'setback': -1, 'lag_hours': 4, 'minimum_run_minutes': 60, 'terminal_reserve_hours': 0,
        }
        model = {**initial_model(room), 'loss': .014, 'gain': .5, 'base_gain': .08, 'response': 0}
        slots = []
        for index in range(32):
            begin = start + timedelta(minutes=15 * index)
            slots.append(Slot(begin, begin + timedelta(minutes=15), 8 if index < 16 else 12))
        cops = [2] * 4 + [5] * 4
        forecast = [{'time': NOW + hour * 3600, 'cop': cop} for hour, cop in enumerate(cops)]
        tariff_plan = plan(room, model, 20.3, [0] * 32, slots, start, 20)
        adjusted = cop_priced_slots(slots, forecast, start)
        cop_plan = plan(room, model, 20.3, [0] * 32, adjusted, start, 20)

        def estimated_cost(result):
            return sum(
                slot.price / cops[index // 4] / 4
                for index, (slot, row) in enumerate(zip(slots, result['slots']))
                if row['predicted_demand']
            )

        self.assertLess(estimated_cost(cop_plan), estimated_cost(tariff_plan))
        self.assertFalse(any(row['predicted_demand'] for row in tariff_plan['slots'][16:]))
        self.assertTrue(any(row['predicted_demand'] for row in cop_plan['slots'][16:]))
        self.assertEqual([row['price'] for row in cop_plan['slots']], [slot.price for slot in slots])
        self.assertGreaterEqual(cop_plan['forecast_minimum'], 20)
        self.assertLessEqual(cop_plan['forecast_maximum'], room['maximum'])

    def test_read_cop_accepts_measurement_and_power_factor_percentage(self):
        attributes = {'device_class': 'power_factor', 'state_class': 'measurement', 'unit_of_measurement': 'x'}
        state = SimpleNamespace(state='3.2', attributes=attributes)
        self.assertEqual(read_cop(state, NOW), 3.2)
        state.attributes.pop('unit_of_measurement')
        self.assertEqual(read_cop(state, NOW), 3.2)
        state.state = '340'
        state.attributes['unit_of_measurement'] = '%'
        self.assertEqual(read_cop(state, NOW), 3.4)
        state.last_reported = datetime.fromtimestamp(NOW - 1801, timezone.utc)
        self.assertIsNone(read_cop(state, NOW))
        state.last_reported = datetime.fromtimestamp(NOW, timezone.utc)
        for idle in ('0', '-1', 'unknown', 'unavailable', 'nan'):
            state.state = idle
            self.assertIsNone(read_cop(state, NOW))
        state.state = '3700'
        self.assertIsNone(read_cop(state, NOW), 'Check the COP ceiling after percentage conversion')

    def test_filter_rejects_isolated_and_extreme_spikes_but_keeps_supported_high_cop(self):
        values = [3.9, 8.4, 4.1, 29, 4.9, 5.3, 5.5]
        readings = [{'time': NOW + index * 900, 'cop': value, 'reported': NOW + index * 900}
                    for index, value in enumerate(values)]
        self.assertEqual([row['cop'] for row in filter_cop_readings(readings)], [3.9, 4.1, 4.9, 5.3, 5.5])

    def test_high_cop_requires_distinct_reports_without_a_sampling_gap(self):
        first = {'time': NOW, 'cop': 6.1, 'reported': NOW}
        repeated = {**first, 'time': NOW + 900}
        later = {'time': NOW + 2700, 'cop': 6.2, 'reported': NOW + 2700}
        self.assertEqual(filter_cop_readings([first, repeated, later]), [])

    def test_forecast_uses_local_medians_and_leaves_unsupported_temperatures_empty(self):
        readings = [
            {'time': NOW - (index + 1) * 3600, 'outdoor': outdoor, 'cop': cop}
            for index, (outdoor, cop) in enumerate([(-2.8, 2), (-3, 2.1), (-3.2, 10),
                                                    (0.8, 4), (1, 4.1), (1.2, 4.2)])
        ]
        historical = {**readings[1], 'time': NOW - 8 * 86400}
        readings.append(historical)
        future = [weather(-1, -3), weather(0, -3), weather(1, -1), weather(2, 1), weather(3, 12)]
        forecast = forecast_cop(readings, future, NOW)
        self.assertEqual([point['cop'] for point in forecast], [2.1, 3.1, 4.1, 3.5])
        self.assertEqual([point['basis'] for point in forecast], ['learned', 'learned', 'learned', 'initial'])
        isolated = readings[:3] + [{**row, 'outdoor': 15} for row in readings[3:]]
        fallback = forecast_cop(isolated, [weather(2, 5)], NOW)
        self.assertEqual(fallback[0]['basis'], 'initial')

    def test_initial_forecast_interpolates_between_points_and_holds_endpoints(self):
        temperatures = [4, 0, -7.5, -15, -17.5, -20, -25]
        future = [weather(index, outdoor) for index, outdoor in enumerate(temperatures)]
        forecast = forecast_cop([], future, NOW)
        self.assertEqual([point['cop'] for point in forecast], [3.5, 3.5, 2.5, 1.5, 1.25, 1.0, 1.0])
        self.assertTrue(all(point['basis'] == 'initial' for point in forecast))
        self.assertEqual(forecast_cop([], [], NOW), [])

    def test_initial_curve_is_used_until_a_week_of_history(self):
        observations = [
            {'time': NOW - offset * 3600, 'outdoor': 5, 'cop': 6.2}
            for offset in (1, 2, 3)
        ]
        future = [weather(1, 5), weather(2, -5)]
        initial = forecast_cop(observations, future, NOW)
        self.assertEqual([point['cop'] for point in initial], [3.5, 2.83])
        self.assertTrue(all(point['basis'] == 'initial' for point in initial))
        week_earlier = {**observations[0], 'time': observations[0]['time'] - 7 * 86400}
        learned = forecast_cop([week_earlier, *observations], future, NOW)
        self.assertEqual([point['cop'] for point in learned], [6.2, 2.83])
        self.assertEqual([point['basis'] for point in learned], ['learned', 'initial'])

    def test_storage_survives_restart_deduplicates_and_expires(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / 'history.sqlite3'
            database = HistoryDatabase(path)
            database.initialize()
            database.record_heat_pump_cop(SOURCES, NOW, 3, -2)
            database.record_heat_pump_cop(SOURCES, NOW + 120, 4, -1)
            restarted = HistoryDatabase(path)
            self.assertEqual(restarted.record_heat_pump_cop(SOURCES, NOW + 1800, None, -1),
                             [{'time': NOW, 'cop': 3, 'outdoor': -2}])
            self.assertEqual(restarted.record_heat_pump_cop(SOURCES, NOW + 30 * 86400, None, -1), [])
            restarted.record_heat_pump_cop(SOURCES, NOW + 30 * 86400, 3, -2)
            self.assertEqual(restarted.record_heat_pump_cop((SOURCES[0], 'sensor.new_outdoor'),
                                                           NOW + 30 * 86400, None, -1), [])

    def test_quarter_hour_summary_pairs_cop_with_outdoor_temperature_without_spikes(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / 'history.sqlite3'
            database = HistoryDatabase(path)
            database.initialize()
            database.record_heat_pump_cop(SOURCES, NOW, 3.6, -2, NOW)
            database.record_heat_pump_cop(SOURCES, NOW + 300, 8.4, 10, NOW + 300)
            restarted = HistoryDatabase(path)
            readings = restarted.record_heat_pump_cop(SOURCES, NOW + 600, 4.2, 0, NOW + 600)
            self.assertEqual(readings, [{'time': NOW, 'cop': 3.9, 'outdoor': -1,
                                         'reported': NOW + 600}])
            # A refresh crossing the quarter-hour cannot duplicate an old report.
            self.assertEqual(restarted.record_heat_pump_cop(SOURCES, NOW + 900, 4.2, 0, NOW + 600), readings)

    def test_quarter_hour_median_handles_three_valid_readings(self):
        with TemporaryDirectory() as directory:
            database = HistoryDatabase(Path(directory) / 'history.sqlite3')
            database.initialize()
            database.record_heat_pump_cop(SOURCES, NOW, 4.0, 0)
            database.record_heat_pump_cop(SOURCES, NOW + 300, 4.8, 1)
            readings = database.record_heat_pump_cop(SOURCES, NOW + 600, 4.1, 2)
            self.assertEqual(readings, [{'time': NOW, 'cop': 4.1, 'outdoor': 1}])


class CopCoordinatorTests(unittest.IsolatedAsyncioTestCase):
    async def test_only_house_pump_rooms_use_cop_costs_and_chart_keeps_tariff(self):
        with TemporaryDirectory() as directory:
            hass = Hass(directory)
            hass.states['sensor.air'] = State('20')
            hass.states['climate.air'] = State('heat', {'temperature': 20})
            rooms = [
                {**ROOM_DEFAULTS, 'id': 'floor', 'thermostat': 'climate.room', 'temperature_entity': 'sensor.room'},
                {**ROOM_DEFAULTS, 'id': 'air', 'thermostat': 'climate.air', 'temperature_entity': 'sensor.air',
                 'heat_control': 'air_to_air'},
            ]
            entry = SimpleNamespace(entry_id='cop', data={
                'house_heat_source': 'air_to_water', 'outdoor_entity': 'sensor.out',
                'price_entity': 'static', 'static_price': 10, 'rooms': rooms,
            }, options={})
            coordinator = PilotCoordinator(hass, entry)
            await coordinator.load()
            forecast = [{'time': now.timestamp(), 'cop': 2}, {'time': now.timestamp() + 3600, 'cop': 4}]
            for source in ('air_to_water', 'ground_source'):
                coordinator.settings['house_heat_source'] = source
                with patch.object(coordinator, 'heat_pump_cop_chart', AsyncMock(return_value={'forecast': forecast})):
                    with patch('thermal_pilot.coordinator.plan', return_value=None) as planner:
                        data = await coordinator._async_update_data()
                room_slots = {call.args[0]['id']: call.args[4] for call in planner.call_args_list}
                self.assertEqual(set(room_slots), {'floor', 'air'})
                self.assertEqual(room_slots['floor'][0].heating_cost_rate is not None, source == 'air_to_water')
                self.assertTrue(all(slot.heating_cost_rate is None for slot in room_slots['air']))
                self.assertEqual({row['price'] for row in data['price_chart']}, {10})

    async def test_plan_and_forecast_both_ignore_defrost_like_spikes(self):
        with TemporaryDirectory() as directory:
            hass = Hass(directory)
            entry = SimpleNamespace(entry_id='cop', data={
                'outdoor_entity': SOURCES[1], 'heat_pump_cop_entity': SOURCES[0],
            }, options={})
            coordinator = PilotCoordinator(hass, entry)
            database = coordinator.history_db
            database.initialize()
            database.record_heat_pump_cop(SOURCES, NOW - 8 * 86400, 3.6, 0)
            for offset, cop in ((4, 3.4), (3, 8), (2, 3.6), (1, 37)):
                database.record_heat_pump_cop(SOURCES, NOW - offset * 3600, cop, 0)
            hass.states[SOURCES[0]] = SimpleNamespace(state='3.8', attributes={})
            chart = await coordinator.heat_pump_cop_chart(NOW, 0, [weather(1, 0)])
            self.assertEqual([row['cop'] for row in chart['observed']], [3.4, 3.6, 3.8])
            self.assertEqual([row['cop'] for row in chart['forecast']], [3.6])

    async def test_cop_uses_configured_house_sensor_and_respects_pause(self):
        with TemporaryDirectory() as directory:
            hass = Hass(directory)
            hass.states[SOURCES[0]] = SimpleNamespace(state='3', attributes={'device_class': 'power_factor'})
            entry = SimpleNamespace(entry_id='cop', data={'outdoor_entity': SOURCES[1]}, options={})
            coordinator = PilotCoordinator(hass, entry)
            coordinator.history_db.initialize()
            self.assertIsNone(await coordinator.heat_pump_cop_chart(NOW, 0, []))
            coordinator.settings['heat_pump_cop_entity'] = SOURCES[0]
            chart = await coordinator.heat_pump_cop_chart(NOW, 0, [])
            self.assertEqual(chart, {'observed': [{'time': NOW, 'cop': 3, 'outdoor': 0}], 'forecast': []})
            coordinator.settings['heating_enabled'] = False
            self.assertEqual(await coordinator.heat_pump_cop_chart(NOW + 900, 1, []), chart)
            coordinator.settings['house_heat_source'] = 'ground_source'
            self.assertIsNone(await coordinator.heat_pump_cop_chart(NOW + 1800, 0, []))
