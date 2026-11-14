"""Shared-space configuration, observed transfer and coordinated circuit plans."""
from copy import deepcopy
from datetime import datetime, timedelta
import math
import unittest
from unittest.mock import patch

import test_model  # Dependency-free package bootstrap.
from test_model import NOW
from thermal_pilot.const import DEFAULTS, ROOM_DEFAULTS
from thermal_pilot.config import validate, resolved_rooms, room_settings, learning_fingerprint
from thermal_pilot.model import initial_model, learn, plan, Slot, response_step
from thermal_pilot.shared_air import room_groups, heat_transfer, coordinate_plans, simulate_group

IDS = [f'{index:08}-1111-4111-8111-111111111111' for index in range(1, 4)]


def settings_fixture():
    rooms = [{**deepcopy(ROOM_DEFAULTS), 'id': key, 'name': f'Circuit {index}',
              'thermostat': f'climate.circuit_{index}', 'temperature_entity': f'sensor.circuit_{index}',
              'activity_entity': f'switch.circuit_{index}'} for index, key in enumerate(IDS)]
    return {**deepcopy(DEFAULTS), 'outdoor_entity': 'sensor.outdoor', 'rooms': rooms}


class SharedConfigurationTests(unittest.TestCase):
    def test_old_configuration_keeps_independent_circuits_and_identifiers(self):
        settings = settings_fixture()
        for room in settings['rooms']:
            room.pop('shared_air_rooms')
        saved = validate(settings)
        self.assertEqual([room['id'] for room in saved['rooms']], IDS)
        self.assertEqual(room_groups(saved['rooms']), [])

    def test_direct_links_are_reciprocal_without_losing_individual_settings(self):
        settings = settings_fixture()
        settings['rooms'][0]['shared_air_rooms'] = [IDS[1]]
        settings['rooms'][1]['shared_air_rooms'] = [IDS[2]]
        settings['rooms'][0]['baseline'] = 19.5
        settings['rooms'][1]['baseline'] = 21
        saved = validate(settings)
        self.assertEqual(room_groups(saved['rooms']), [IDS])
        expected = [[IDS[1]], [IDS[0], IDS[2]], [IDS[1]]]
        self.assertEqual([room['shared_air_rooms'] for room in saved['rooms']], expected)
        self.assertEqual([room['shared_air_rooms'] for room in resolved_rooms(saved)], expected)
        self.assertEqual([room['baseline'] for room in saved['rooms']], [19.5, 21, 20])

    def test_changing_one_edge_changes_fit_context_even_when_network_stays_connected(self):
        settings = settings_fixture()
        for room in settings['rooms']:
            room['shared_air_rooms'] = [peer for peer in IDS if peer != room['id']]
        before = learning_fingerprint(resolved_rooms(settings)[1], settings)
        settings['rooms'][0]['shared_air_rooms'].remove(IDS[2])
        settings['rooms'][2]['shared_air_rooms'].remove(IDS[0])
        rooms = resolved_rooms(settings)
        self.assertEqual(room_groups(rooms), [IDS])
        self.assertNotEqual(before, learning_fingerprint(rooms[1], settings))
        self.assertEqual(rooms[0]['shared_air_rooms'], [IDS[1]])
        self.assertEqual(rooms[2]['shared_air_rooms'], [IDS[1]])

    def test_invalid_links_are_rejected(self):
        for links, overrides in [([IDS[0]], {}), (['missing'], {}), ([IDS[1], IDS[1]], {}),
                                  ([IDS[1]], {'is_garage': True}), ([IDS[1]], {'heat_control': 'air_to_air'})]:
            with self.subTest(links=links, overrides=overrides):
                settings = settings_fixture()
                settings['rooms'][0].update(shared_air_rooms=links, **overrides)
                with self.assertRaisesRegex(ValueError, 'Shared air space'):
                    validate(settings)

    def test_peer_sensor_change_breaks_continuity_without_changing_ids(self):
        settings = settings_fixture()
        settings['rooms'][0]['shared_air_rooms'] = [IDS[1]]
        first = resolved_rooms(settings)[0]
        before = learning_fingerprint(first, settings)
        settings['rooms'][1]['temperature_entity'] = 'sensor.relocated'
        after = learning_fingerprint(resolved_rooms(settings)[0], settings)
        self.assertNotEqual(before, after)
        self.assertEqual(first['id'], IDS[0])


class SharedLearningTests(unittest.TestCase):
    def room(self):
        settings = settings_fixture()
        settings['rooms'][0]['shared_air_rooms'] = [IDS[1]]
        return room_settings(resolved_rooms(settings)[0], settings)

    def test_transfer_direction_and_missing_peer(self):
        model = {'shared_air': {'members': ['b'], 'couplings': {'b': .2}}}
        self.assertAlmostEqual(heat_transfer(model, 20, {'b': 22}), .4)
        self.assertAlmostEqual(heat_transfer(model, 22, {'b': 20}), -.4)
        self.assertEqual(heat_transfer(model, 20, {}), 0)
        self.assertEqual(heat_transfer({}, 20, {'b': 22}), 0)

    def test_fit_requires_fresh_linked_heat_and_idle_evidence(self):
        room = self.room()
        model = initial_model(room)
        model.update(heated_hours=500, idle_hours=500)
        previous = {'time': 0, 'temperature': 20, 'outdoor': 0, 'activity': 1,
                    'shared_air_temperatures': {IDS[1]: 21}}
        current = {**previous, 'time': 300, 'temperature': 20.02}
        before = (model['loss'], model['gain'])
        learn(model, room, previous, current)
        self.assertEqual(model['shared_air']['updates'], 0)
        self.assertEqual(before, (model['loss'], model['gain']))
        self.assertAlmostEqual(model['shared_air']['heated_hours'], 5 / 60)
        excluded_model = initial_model(room)
        learn(excluded_model, room, previous, {**current, 'excluded': True})
        self.assertNotIn('shared_air', excluded_model)
        missing_model = initial_model(room)
        learn(missing_model, room, previous, {**current, 'shared_air_temperatures': {}})
        self.assertNotIn('shared_air', missing_model)

    def test_observed_neighbor_warmth_is_fitted_separately_from_own_heating(self):
        room = self.room()
        model = initial_model(room)
        model.update(loss=.015, gain=.65, base_gain=.1)
        temperature = 20.0
        response = 0.0
        for index in range(1440):
            hours = 5 / 60
            activity = float((index // 36) % 2 == 0)
            outdoor = 3 + 5 * math.sin(index / 141)
            neighbor = 20 + 2.5 * math.sin(index / 51)
            response, average = response_step(response, activity, hours, room['lag_hours'])
            rate = .015 * (outdoor - temperature) + .65 * average + .1 + .2 * (neighbor - temperature)
            previous = {'time': index * 300, 'temperature': temperature, 'outdoor': outdoor,
                        'activity': activity, 'shared_air_temperatures': {IDS[1]: neighbor}}
            temperature += hours * rate
            current = {**previous, 'time': (index + 1) * 300, 'temperature': temperature}
            learn(model, room, previous, current)
        state = model['shared_air']
        self.assertGreater(state['updates'], 0)
        self.assertAlmostEqual(state['couplings'][IDS[1]], .2, delta=.04)
        self.assertAlmostEqual(model['gain'], .65, delta=.06)
        self.assertAlmostEqual(model['loss'], .015, delta=.005)
        # Shared observations do not also enter the old independent regression.
        self.assertEqual(model['xx'], 0)


    def test_wind_and_neighbor_exchange_are_learned_in_one_fit(self):
        room = self.room()
        model = initial_model(room)
        model.update(loss=.015, gain=.65, base_gain=.1)
        temperature, response = 20.0, 0.0
        for index in range(1440):
            hours = 5 / 60
            activity = float((index // 36) % 2 == 0)
            outdoor = 3 + 5 * math.sin(index / 141)
            neighbor = 20 + 2.5 * math.sin(index / 51)
            wind = 3 + 2 * math.sin(index / 37)
            response, average = response_step(response, activity, hours, room['lag_hours'])
            rate = (.015 + .001 * (wind - 3)) * (outdoor - temperature)
            rate += .65 * average + .1 + .2 * (neighbor - temperature)
            previous = {'time': index * 300, 'temperature': temperature, 'outdoor': outdoor,
                        'activity': activity, 'wind': wind, 'shared_air_temperatures': {IDS[1]: neighbor}}
            temperature += hours * rate
            current = {**previous, 'time': (index + 1) * 300, 'temperature': temperature}
            learn(model, room, previous, current)
        self.assertGreater(model['wind_updates'], 0)
        self.assertAlmostEqual(model['wind_loss'], .001, delta=.0005)
        self.assertAlmostEqual(model['shared_air']['couplings'][IDS[1]], .2, delta=.04)
        self.assertAlmostEqual(model['gain'], .65, delta=.06)


def contexts_fixture():
    settings = settings_fixture()
    settings['rooms'] = settings['rooms'][:2]
    settings['rooms'][0]['shared_air_rooms'] = [IDS[1]]
    contexts = {}
    slots = [Slot(NOW + timedelta(minutes=15 * i), NOW + timedelta(minutes=15 * (i + 1)), 5 if i < 12 else 25)
             for i in range(32)]
    for index, configured in enumerate(resolved_rooms(settings)):
        room = {**room_settings(configured, settings), 'terminal_reserve_hours': 1,
                'start_offset_minutes': 5, 'stop_offset_minutes': 10, 'minimum_run_minutes': 60}
        model = initial_model(room)
        model.update(loss=.025, gain=.28 if index == 0 else 1.4, base_gain=.05, response=0)
        peer = IDS[1-index]
        model['shared_air'] = {'members': [peer], 'signature': room['shared_air_signature'],
                               'couplings': {peer: .2}, 'updates': 50}
        temperature = 19.5 if index == 0 else 20.3
        result = plan(room, model, temperature, [0] * len(slots), slots, NOW, room['baseline'])
        contexts[configured['id']] = {'room': room, 'model': model, 'temperature': temperature,
            'baseline': room['baseline'], 'water_factor': 1.0, 'outdoor': [0] * len(slots),
            'slots': slots, 'plan': result}
    return contexts


def network_contexts_fixture():
    settings = settings_fixture()
    settings['rooms'][0]['shared_air_rooms'] = [IDS[1]]
    settings['rooms'][1]['shared_air_rooms'] = [IDS[2]]
    slots = [Slot(NOW + timedelta(minutes=15 * index), NOW + timedelta(minutes=15 * (index + 1)), 5)
             for index in range(16)]
    contexts = {}
    for room in resolved_rooms(settings):
        room = {**room_settings(room, settings), 'terminal_reserve_hours': 0}
        model = initial_model(room)
        model.update(loss=.012, gain=1, base_gain=.05)
        model['shared_air'] = {'members': room['shared_air_rooms'], 'signature': room['shared_air_signature'],
                               'couplings': {peer: .2 for peer in room['shared_air_rooms']}, 'updates': 50}
        result = plan(room, model, 20.1, [0] * len(slots), slots, NOW, room['baseline'])
        contexts[room['id']] = {'room': room, 'model': model, 'temperature': 20.1,
                               'baseline': room['baseline'], 'water_factor': 1,
                               'outdoor': [0] * len(slots), 'slots': slots, 'plan': result}
    return contexts


class SharedPlanningTests(unittest.TestCase):
    def test_connected_network_plans_use_only_each_circuits_direct_neighbors(self):
        contexts = network_contexts_fixture()
        with patch('thermal_pilot.model.plan', wraps=plan) as planner:
            result = coordinate_plans(contexts, NOW)
        self.assertEqual(set(result), set(IDS))
        self.assertTrue(planner.call_count)
        for call in planner.call_args_list:
            room = call.args[0]
            self.assertEqual(set(room['shared_air_forecast']), set(room['shared_air_rooms']))
        self.assertEqual(contexts[IDS[0]]['model']['shared_air']['members'], [IDS[1]])

    def test_indirect_warmth_passes_through_middle_room_without_a_direct_edge(self):
        contexts = network_contexts_fixture()
        from thermal_pilot.model import thermostat_timing
        for index, context in enumerate(contexts.values()):
            context['temperature'] = 24.0 if index == 2 else 20.0
            context['model'].update(loss=0, gain=0, base_gain=0, response=0)
            row = {'start': NOW.isoformat(), 'end': (NOW + timedelta(minutes=15)).isoformat(),
                   'price': 5, 'outdoor': 0, 'heat': False, 'mode': 'normal',
                   'setpoint': 20, 'temperature': context['temperature']}
            context['plan'] = {**context['plan'], 'slots': [row],
                               **thermostat_timing([row], context['room'], 20, NOW)}
        plans = {key: context['plan'] for key, context in contexts.items()}
        _, _, direct = simulate_group(contexts, plans, NOW)
        self.assertGreater(direct[IDS[0]]['slots'][0]['temperature'], 20)
        self.assertLess(direct[IDS[0]]['slots'][0]['temperature'], 20.02)
        # A direct outer-room connection would produce much faster transfer.
        for key, peer in [(IDS[0], IDS[2]), (IDS[2], IDS[0])]:
            contexts[key]['room']['shared_air_rooms'].append(peer)
            contexts[key]['model']['shared_air']['members'] = sorted(contexts[key]['room']['shared_air_rooms'])
            contexts[key]['model']['shared_air']['couplings'][peer] = .2
        _, _, fully_connected = simulate_group(contexts, plans, NOW)
        self.assertGreater(fully_connected[IDS[0]]['slots'][0]['temperature'], 20.15)

    def test_uncalibrated_or_incomplete_groups_keep_independent_plans(self):
        contexts = contexts_fixture()
        contexts[IDS[1]]['model']['shared_air']['updates'] = 0
        self.assertEqual(coordinate_plans(contexts, NOW), {})
        contexts = contexts_fixture()
        contexts[IDS[1]]['plan']['slots'][0]['end'] = (NOW + timedelta(minutes=5)).isoformat()
        self.assertEqual(coordinate_plans(contexts, NOW), {})
        self.assertEqual(coordinate_plans({IDS[0]: contexts[IDS[0]]}, NOW), {})

    def test_assistance_improves_cold_circuit_without_sacrificing_helper_limits(self):
        contexts = contexts_fixture()
        independent = {key: context['plan'] for key, context in contexts.items()}
        before, before_limits, evaluated = simulate_group(contexts, independent, NOW)
        result = coordinate_plans(contexts, NOW)
        after, after_limits, evaluated = simulate_group(contexts, result, NOW)
        self.assertLess(after, before)
        for key in contexts:
            self.assertLessEqual(after_limits[key], before_limits[key] + 1e-6)
            self.assertTrue(result[key]['shared_air_coordinated'])
            self.assertEqual(result[key]['normal_setpoint'], contexts[key]['baseline'])
            for session in result[key]['sessions']:
                duration = datetime.fromisoformat(session['end']) - datetime.fromisoformat(session['start'])
                self.assertGreaterEqual(duration.total_seconds(), 3600)
        self.assertGreater(result[IDS[1]]['suggested_heating_hours'], independent[IDS[1]]['suggested_heating_hours'])
        self.assertLessEqual(result[IDS[1]]['forecast_maximum'], contexts[IDS[1]]['room']['maximum'])

    def test_helper_can_replace_costlier_recipient_work(self):
        contexts = contexts_fixture()
        for index, context in enumerate(contexts.values()):
            context['model'].update(loss=.012, gain=.4 if index == 0 else 1.4, response=.1)
            context['temperature'] = 20.05 if index == 0 else 20.3
            context['room']['terminal_reserve_hours'] = 0
            context['plan'] = plan(context['room'], context['model'], context['temperature'],
                                   context['outdoor'], context['slots'], NOW, context['baseline'])
        independent = {key: context['plan'] for key, context in contexts.items()}
        before, before_limits, _ = simulate_group(contexts, independent, NOW)
        coordinated = coordinate_plans(contexts, NOW)
        after, after_limits, _ = simulate_group(contexts, coordinated, NOW)
        self.assertLess(after[2], before[2])
        self.assertLessEqual(after[1], before[1])
        self.assertLess(coordinated[IDS[0]]['suggested_heating_hours'], independent[IDS[0]]['suggested_heating_hours'])
        self.assertGreater(coordinated[IDS[1]]['suggested_heating_hours'], independent[IDS[1]]['suggested_heating_hours'])
        for key in contexts:
            self.assertLessEqual(after_limits[key], before_limits[key])

    def test_links_without_measurable_transfer_do_not_invent_assistance(self):
        contexts = contexts_fixture()
        for context in contexts.values():
            context['model']['shared_air']['couplings'] = {peer: 0 for peer in context['model']['shared_air']['members']}
        self.assertEqual(coordinate_plans(contexts, NOW), {})

    def test_committed_run_and_replanning_budget_are_preserved(self):
        contexts = contexts_fixture()
        context = contexts[IDS[0]]
        context['room']['committed_session'] = {'start': NOW.isoformat(), 'end': (NOW + timedelta(hours=2)).isoformat()}
        context['plan'] = plan(context['room'], context['model'], context['temperature'], context['outdoor'],
                               context['slots'], NOW, context['baseline'])
        with patch('thermal_pilot.model.plan', wraps=plan) as planner:
            result = coordinate_plans(contexts, NOW)
        self.assertLessEqual(planner.call_count, 12)
        self.assertTrue(all(row['heat'] for row in result[IDS[0]]['slots'][:4]))


class SharedCoordinatorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from test_coordinator import CoordinatorTests, State
        await CoordinatorTests.asyncSetUp(self)
        first = self.c.settings['rooms'][0]
        second = {**deepcopy(first), 'id': IDS[1], 'name': 'Helper',
                  'thermostat': 'climate.helper', 'temperature_entity': 'sensor.helper'}
        first['shared_air_rooms'] = [second['id']]
        self.c.settings['rooms'].append(second)
        self.hass.states['climate.helper'] = State('heat', {'temperature': 20, 'hvac_action': 'idle'})
        self.hass.states['sensor.helper'] = State('20.5')
        for index, room in enumerate(resolved_rooms(self.c.settings)):
            model = initial_model(room_settings(room, self.c.settings))
            model.update(heated_hours=50, idle_hours=50, samples=100)
            model['shared_air'] = {
                'members': room['shared_air_rooms'], 'signature': room['shared_air_signature'],
                'couplings': {peer: .2 for peer in room['shared_air_rooms']},
                'updates': 40, 'hours': 100.0, 'heated_hours': 50.0, 'idle_hours': 50.0,
                'matrix': [[0.0] * 4 for _ in range(4)], 'vector': [0.0] * 4,
                'prior': [model['loss'], model['gain'], 0.0, 0.0],
                'wind_hours': 0.0, 'wind_sum': 0.0, 'wind_squared': 0.0,
            }
            self.c.models[room['id']] = model

    async def asyncTearDown(self):
        self.temp.cleanup()

    async def test_final_suggestions_are_used_in_history_run_state_and_persistence(self):
        data = await self.c._async_update_data()
        for key, result in data['rooms'].items():
            self.assertTrue(result['plan']['shared_air_coordinated'])
            self.assertEqual(self.c.suggested_runs[key]['heat'], result['plan']['scheduled_heat'])
            reading = next(row for row in self.c.history_db.read(0) if row['room_id'] == key)
            self.assertEqual(reading['suggested_heat'], result['plan']['heat'])
            self.assertEqual(reading['suggested_setpoint'], result['plan']['setpoint'])
            self.assertEqual(self.c.store.saved['models'][key]['shared_air'], self.c.models[key]['shared_air'])
        self.hass.services.async_call.assert_not_awaited()

    async def test_unavailable_neighbor_prevents_group_fit_and_coordination(self):
        self.hass.states['sensor.helper'].state = 'unavailable'
        data = await self.c._async_update_data()
        first = self.c.settings['rooms'][0]['id']
        self.assertNotIn('shared_air_coordinated', data['rooms'][first]['plan'])
        self.assertTrue(self.c.previous[first]['excluded'])
        self.assertEqual(self.c.models[first]['samples'], 100)

    async def test_manual_session_preserves_independent_planning_for_whole_group(self):
        from test_coordinator import now
        key = self.c.settings['rooms'][0]['id']
        self.c.manual_sessions[key] = {'ends': now.timestamp() + 3600, 'started': now.timestamp(),
                                      'mode': 'heat', 'target': 21.5, 'entity': 'climate.room'}
        with patch('thermal_pilot.coordinator.coordinate_plans', wraps=coordinate_plans) as coordinate:
            data = await self.c._async_update_data()
        coordinate.assert_not_called()
        self.assertTrue(all('shared_air_coordinated' not in result['plan'] for result in data['rooms'].values()))

    async def test_removing_link_keeps_room_history_parameters_and_hours(self):
        for room in self.c.settings['rooms']:
            room['shared_air_rooms'] = []
        before = deepcopy(self.c.models)
        await self.c._async_update_data()
        for key, model in self.c.models.items():
            self.assertNotIn('shared_air', model)
            for field in ('heated_hours', 'idle_hours', 'samples', 'loss', 'gain'):
                self.assertEqual(model[field], before[key][field])

    async def test_link_changes_do_not_invalidate_running_session_checkpoint(self):
        room = resolved_rooms(self.c.settings)[0]
        before = self.c.session_fingerprint(room)
        self.c.settings['rooms'][0]['shared_air_rooms'] = []
        self.c.settings['rooms'][1]['shared_air_rooms'] = []
        after = self.c.session_fingerprint(resolved_rooms(self.c.settings)[0])
        self.assertEqual(before, after)

    async def test_shared_fit_uses_private_executor_copy_and_publishes_completed_state(self):
        from test_coordinator import now
        await self.c._async_update_data()
        models_seen = []
        def observe_fit(model, *args):
            models_seen.append(model)
            return learn(model, *args)
        with patch('thermal_pilot.coordinator.dt_util.utcnow', return_value=now + timedelta(minutes=3)):
            with patch('thermal_pilot.coordinator.learn', side_effect=observe_fit):
                await self.c._async_update_data()
        self.assertEqual(len(models_seen), 2)
        for model in models_seen:
            self.assertTrue(all(model is not public for public in self.c.models.values()))
        for key, model in self.c.models.items():
            self.assertEqual(model['samples'], 101)
            self.assertEqual(model['shared_air']['updates'], 41)
            self.assertEqual(self.c.store.saved['models'][key]['shared_air'], model['shared_air'])

    async def test_backup_round_trip_preserves_links_and_transfer_statistics(self):
        from pathlib import Path
        from thermal_pilot.backup import create_backup, prepare_backup
        content = create_backup(self.c.settings, self.c.storage_data(), self.c.history_db.path)
        restored = prepare_backup(content, Path(self.temp.name) / 'restored.sqlite3')
        self.assertEqual(restored['state']['models'], self.c.models)
        self.assertEqual(room_groups(restored['settings']['rooms']), room_groups(self.c.settings['rooms']))
