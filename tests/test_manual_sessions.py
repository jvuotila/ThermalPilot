"""Timed manual control tests with HA service doubles, not physical devices."""
from copy import deepcopy
from datetime import timedelta
from pathlib import Path
import ast
import asyncio
import sqlite3
import tempfile
import types
import unittest
from unittest.mock import AsyncMock, Mock, patch

from test_coordinator import Hass, State, now
from thermal_pilot.coordinator import PilotCoordinator
from thermal_pilot.const import DEFAULTS, ROOM_DEFAULTS, ZONE_DEFAULTS
from thermal_pilot.air_control import AirHeatPumpControl
from thermal_pilot.backup_migrations import normalize_learning


class ManualSessionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.hass = Hass(self.directory.name)
        self.floor = {**ROOM_DEFAULTS, 'id': 'floor', 'name': 'Floor room',
                      'thermostat': 'climate.room', 'temperature_entity': 'sensor.room'}
        self.garage = {**ROOM_DEFAULTS, 'id': 'garage', 'name': 'Garage',
                       'thermostat': 'climate.garage', 'temperature_entity': 'sensor.garage',
                       'is_garage': True, 'garage_heat_source': 'air_to_air'}
        self.hass.states.update({
            'sensor.garage': State('7'),
            'climate.garage': State('fan_only', {
                'hvac_modes': ['heat', 'cool', 'fan_only', 'off'],
                'temperature': 18, 'min_temp': 16, 'max_temp': 30,
                'hvac_action': 'fan', 'fan_modes': [], 'swing_modes': [],
            }),
        })
        self.entry = types.SimpleNamespace(entry_id='manual', options={}, data={
            **DEFAULTS, 'price_entity': 'sensor.price', 'outdoor_entity': 'sensor.out',
            'water_entity': 'sensor.water', 'simulation_enabled': False,
            'live_control_confirmed': True, 'heating_enabled': True,
            'rooms': [self.floor, self.garage],
        })
        self.coordinator = PilotCoordinator(self.hass, self.entry)
        await self.coordinator.load()
        self.coordinator.data = await self.coordinator._async_update_data()
        self.hass.services.async_call.reset_mock()

    async def asyncTearDown(self):
        self.coordinator.stop()
        self.directory.cleanup()

    async def start(self, room='garage', mode='heat', minutes=120, target=18):
        async with self.coordinator.backup_lock:
            return await self.coordinator.set_manual_session(room, mode, minutes, target, now)

    async def test_floor_room_heat_and_early_stop_restore_automatic_target(self):
        controls = await self.start('floor', target=99)
        expected = min(self.coordinator.settings['maximum'], self.floor['baseline'] + self.coordinator.settings['boost'])
        self.assertEqual(controls['floor']['modes'], ['heat'])
        self.assertFalse(controls['floor']['target_required'])
        self.assertEqual(self.coordinator.control.results['floor'], expected)
        # Automatic planning may already have requested this same boost.
        # A manual session holds it without inventing another setpoint.
        self.assertEqual(self.coordinator.control.pending['climate.room']['target'], expected)
        await self.start('floor', mode='stop')
        self.assertNotIn('floor', self.coordinator.manual_sessions)
        self.assertEqual(self.coordinator.control.results['floor'],
                         self.coordinator.data['rooms']['floor']['plan']['setpoint'])

    async def test_zone_circulates_until_the_last_linked_fireplace_stops(self):
        coordinator = self.coordinator
        self.floor['heating_zone_id'] = 'downstairs'
        coordinator.settings.update(
            rooms=[self.floor, self.garage],
            air_use_fan_only=False,
            heating_zones=[{**ZONE_DEFAULTS, 'id': 'downstairs', 'name': 'Downstairs',
                           'thermostat': 'climate.zone', 'main_room_id': 'floor', 'heating_enabled': True,
                           'fireplace_ids': ['living', 'study'], 'fireplace_circulation': True,
                           'fireplace_fan': 'low', 'fireplace_swing': 'both'}],
            fireplaces=[
                {'id': name, 'name': name.title(), 'fireplace_entity': 'binary_sensor.' + name,
                 'fireplace_active_state': 'on', 'room_ids': ['floor']}
                for name in ('living', 'study')
            ],
        )
        self.hass.states.update({
            'sensor.room': State('21'),
            'climate.zone': State('heat', {'hvac_modes': ['heat', 'fan_only'], 'fan_modes': ['low'],
                                          'swing_modes': ['both'], 'min_temp': 16, 'max_temp': 30}),
            'binary_sensor.living': State('on'),
            'binary_sensor.study': State('on'),
        })
        coordinator.data['zones']['downstairs'] = {}
        await coordinator.apply_live_targets(coordinator.data, now)
        intent = coordinator.data['zones']['downstairs']['pump_suggestion']
        self.assertEqual((intent['mode'], intent['fan'], intent['swing']), ('fan_only', 'low', 'both'))
        self.assertEqual(intent['fireplaces'], ['Living', 'Study'])

        self.hass.states['binary_sensor.living'].state = 'unavailable'
        await coordinator.apply_live_targets(coordinator.data, now + timedelta(seconds=10))
        intent = coordinator.data['zones']['downstairs']['pump_suggestion']
        self.assertEqual(intent['fireplaces'], ['Study'])

        self.hass.states['binary_sensor.study'].state = 'off'
        await coordinator.apply_live_targets(coordinator.data, now + timedelta(seconds=20))
        intent = coordinator.data['zones']['downstairs']['pump_suggestion']
        self.assertEqual(intent['mode'], 'heat')
        self.assertNotIn('fireplaces', intent)

    async def test_garage_can_warm_above_maintenance_range_in_warm_weather(self):
        self.hass.states['sensor.garage'].state = '13'
        self.hass.states['sensor.out'].state = '10'
        await self.start()
        suggestion = self.coordinator.data['rooms']['garage']['pump_suggestion']
        self.assertEqual((suggestion['mode'], suggestion['target']), ('heat', 18))
        self.assertEqual(self.coordinator.manual_sessions['garage']['ends'],
                         (now + timedelta(hours=2)).timestamp())

    async def test_expiry_does_not_latch_garage_heat_between_limits(self):
        await self.start(minutes=1)
        self.hass.states['climate.garage'].state = 'heat'
        await self.coordinator.update_command_state(now + timedelta(minutes=1))
        self.assertNotIn('garage', self.coordinator.manual_sessions)
        self.assertEqual(self.coordinator.data['rooms']['garage']['pump_suggestion']['mode'], 'fan_only')
        self.assertNotIn('garage', self.coordinator.store.saved['manual_sessions'])

    async def test_restart_preserves_original_expiry_and_expired_sessions_end(self):
        await self.start(minutes=90)
        saved = deepcopy(self.coordinator.store.saved)
        replacement = PilotCoordinator(self.hass, self.entry)
        replacement.store.saved = saved
        await replacement.load()
        self.assertEqual(replacement.manual_sessions, self.coordinator.manual_sessions)
        replacement.data = await replacement._async_update_data()
        self.hass.states['climate.garage'].state = 'heat'
        await replacement.update_command_state(now + timedelta(minutes=91))
        self.assertFalse(replacement.manual_sessions)
        self.assertEqual(replacement.data['rooms']['garage']['pump_suggestion']['mode'], 'fan_only')
        replacement.stop()

    async def test_manual_cooling_uses_existing_reversal_interlock(self):
        self.hass.states['sensor.garage'].state = '27'
        self.hass.states['climate.garage'].state = 'heat'
        self.coordinator.air_control = AirHeatPumpControl(self.hass)
        await self.start(mode='cool', target=20)
        suggestion = self.coordinator.data['rooms']['garage']['pump_suggestion']
        self.assertEqual((suggestion['mode'], suggestion['target']), ('cool', 20))
        self.assertTrue(any(
            call.args[1] == 'set_hvac_mode' and call.args[2].get('hvac_mode') == 'fan_only'
            for call in self.hass.services.async_call.call_args_list
        ))
        self.assertFalse(any(call.args[1] == 'set_temperature' for call in
                             self.hass.services.async_call.call_args_list))

    async def test_pause_and_simulation_cancel_sessions_without_resurrection(self):
        for option in ('heating_enabled', 'simulation_enabled'):
            with self.subTest(option=option):
                self.coordinator.settings.update(heating_enabled=True, simulation_enabled=False)
                self.coordinator.data = await self.coordinator._async_update_data()
                await self.start()
                self.coordinator.settings[option] = option == 'simulation_enabled'
                await self.coordinator.update_command_state(now)
                self.assertFalse(self.coordinator.manual_sessions)
                self.assertFalse(self.coordinator.store.saved['manual_sessions'])

    async def test_invalid_requests_and_unsupported_cooling_never_create_sessions(self):
        for minutes, target in [(0, 18), (-1, 18), (1441, 18), (float('nan'), 18),
                                (120, 4), (120, 36), (120, float('inf'))]:
            with self.subTest(minutes=minutes, target=target), self.assertRaises(ValueError):
                await self.start(minutes=minutes, target=target)
        with self.assertRaises(ValueError):
            await self.start('floor', mode='cool', target=20)
        self.assertFalse(self.coordinator.manual_sessions)
        self.assertFalse(self.hass.services.async_call.called)
        self.coordinator.settings['simulation_enabled'] = True
        with self.assertRaises(ValueError):
            await self.start()

    async def test_expiry_is_armed_even_without_any_plan(self):
        await self.start(minutes=1)
        self.coordinator.air_control.deadlines = []
        with patch('thermal_pilot.coordinator.async_track_point_in_utc_time') as timer:
            self.coordinator.arm_command_timer({}, now)
        self.assertEqual(timer.call_args.args[2], now + timedelta(minutes=1))

    async def test_manual_expiry_survives_repeated_history_failures(self):
        coordinator = self.coordinator
        coordinator.data = {}
        with patch('thermal_pilot.coordinator.async_track_point_in_utc_time',
                   side_effect=lambda *args: Mock()) as tracker:
            await self.start('floor', minutes=1)
            _, expire, deadline = tracker.call_args.args
            cancel = coordinator._command_timer
            self.assertEqual(deadline, now + timedelta(minutes=1))
            self.hass.services.async_call.reset_mock()
            with patch.object(coordinator.history_db, 'append_zones',
                              side_effect=sqlite3.OperationalError('history unavailable')):
                for elapsed in (10, 40, 75):
                    with patch('thermal_pilot.coordinator.dt_util.utcnow',
                               return_value=now + timedelta(seconds=elapsed)):
                        with self.assertRaises(sqlite3.OperationalError):
                            await coordinator._async_update_data()
                cancel.assert_not_called()
                await expire(deadline)
        self.assertNotIn('floor', coordinator.manual_sessions)
        self.assertNotIn('floor', coordinator.store.saved['manual_sessions'])
        self.hass.services.async_call.assert_any_await(
            'climate', 'set_temperature', {'entity_id': 'climate.room', 'temperature': self.floor['baseline']},
            blocking=True,
        )

    async def test_queued_checkpoint_uses_time_after_waiting_for_lock(self):
        coordinator = self.coordinator
        coordinator.data = {}
        await self.start('floor', minutes=1)
        checkpoint = now + timedelta(seconds=30)
        with patch('thermal_pilot.coordinator.async_track_point_in_utc_time') as tracker:
            async with coordinator.backup_lock:
                coordinator.schedule_command_timer(checkpoint)
                wake = asyncio.create_task(tracker.call_args.args[1](checkpoint))
                await asyncio.sleep(0)
                self.assertFalse(wake.done())
                self.assertIn('floor', coordinator.manual_sessions)
            with patch('thermal_pilot.coordinator.dt_util.utcnow', return_value=now + timedelta(minutes=2)):
                await wake
        self.assertNotIn('floor', coordinator.manual_sessions)
        self.assertEqual(coordinator.control.results['floor'], self.floor['baseline'])

    async def test_expiry_applies_fallback_when_saving_fails(self):
        coordinator = self.coordinator
        coordinator.data = {}
        await self.start('floor', minutes=1)
        with patch.object(coordinator.store, 'async_save', new=AsyncMock(side_effect=OSError('disk unavailable'))):
            with patch.object(coordinator.store, 'async_delay_save') as retry:
                with self.assertLogs('thermal_pilot.coordinator', level='WARNING'):
                    await coordinator.update_command_state(now + timedelta(minutes=1))
                retry.assert_called_once()
                self.assertNotIn('floor', retry.call_args.args[0]()['manual_sessions'])
        self.assertNotIn('floor', coordinator.manual_sessions)
        self.assertEqual(coordinator.control.results['floor'], self.floor['baseline'])
        self.assertIn('Thermostat control: Could not save the end of a manual session; will retry.',
                      coordinator.data['warnings'])

    async def test_expiry_uses_new_fallback_after_settings_change(self):
        coordinator = self.coordinator
        await self.start('floor', minutes=1)
        coordinator.settings['rooms'][0]['baseline'] = 19
        self.hass.services.async_call.reset_mock()
        await coordinator.update_command_state(now + timedelta(minutes=1))
        self.assertFalse(coordinator.manual_sessions)
        self.assertEqual(coordinator.data['control']['mode'], 'waiting')
        self.hass.services.async_call.assert_awaited_once_with(
            'climate', 'set_temperature', {'entity_id': 'climate.room', 'temperature': 19}, blocking=True,
        )

    async def test_pausing_retires_override_even_if_reenabled_before_checkpoint(self):
        coordinator = self.coordinator
        coordinator.data = {}
        enabled = deepcopy(coordinator.settings)
        with patch('thermal_pilot.coordinator.async_track_point_in_utc_time') as tracker:
            await self.start('floor', minutes=15)
            _, old_checkpoint, old_deadline = tracker.call_args.args
            self.hass.services.async_call.reset_mock()
            async with coordinator.backup_lock:
                coordinator.update_settings({**enabled, 'heating_enabled': False})
                self.assertFalse(coordinator.manual_sessions)
                coordinator.update_settings(enabled)
            _, new_checkpoint, new_deadline = tracker.call_args.args
            await old_checkpoint(old_deadline)
            self.hass.services.async_call.assert_not_awaited()
            await new_checkpoint(new_deadline)
        self.assertFalse(coordinator.store.saved['manual_sessions'])
        self.assertEqual(coordinator.control.results['floor'], self.floor['baseline'])

    async def test_unavailable_thermostat_retries_manual_release_without_plan(self):
        coordinator = self.coordinator
        coordinator.data = {}
        await self.start('floor', minutes=1)
        thermostat = self.hass.states['climate.room']
        thermostat.state = 'unavailable'
        with patch('thermal_pilot.coordinator.async_track_point_in_utc_time') as tracker:
            await coordinator.update_command_state(now + timedelta(minutes=1))
            self.assertNotIn('floor', coordinator.manual_sessions)
            _, retry, deadline = tracker.call_args.args
            self.assertEqual(deadline, now + timedelta(minutes=2))
            thermostat.state = 'heat'
            await retry(deadline)
        self.assertEqual(coordinator.control.results['floor'], self.floor['baseline'])

    async def test_garage_automatic_cycle_survives_retries_after_manual_release(self):
        coordinator = self.coordinator
        await self.start(minutes=1)
        pump = self.hass.states['climate.garage']
        pump.state = 'unavailable'
        temperature = self.hass.states['sensor.garage']
        temperature.state = str(self.garage['garage_minimum'] - 1)
        await coordinator.update_command_state(now + timedelta(minutes=1))
        self.assertFalse(coordinator.manual_sessions)
        self.assertEqual(coordinator.data['rooms']['garage']['pump_suggestion']['mode'], 'heat')

        pump.state = 'fan_only'
        temperature.state = str(self.garage['garage_minimum'] + 1)
        await coordinator.update_command_state(now + timedelta(minutes=2))
        self.assertEqual(coordinator.data['rooms']['garage']['pump_suggestion']['mode'], 'heat')
        self.assertEqual(coordinator.data['rooms']['garage']['pump_suggestion']['reason'], 'Garage temperature cycle')

    async def test_shared_zone_has_one_controller_and_can_manually_cool_in_winter(self):
        self.coordinator.settings['rooms'][0]['heating_zone_id'] = 'zone'
        self.coordinator.settings['heating_zones'] = [{
            **ZONE_DEFAULTS, 'id': 'zone', 'name': 'Zone', 'main_room_id': 'floor',
            'thermostat': 'climate.zone', 'source_type': 'air_to_air', 'heating_enabled': True,
        }]
        self.hass.states['climate.zone'] = deepcopy(self.hass.states['climate.garage'])
        self.hass.states['sensor.room'].state = '27'
        self.coordinator.data = await self.coordinator._async_update_data()
        controls = await self.start('zone:zone', mode='cool', target=22)
        self.assertEqual(controls['zone:zone']['entity'], 'climate.zone')
        self.assertEqual(self.coordinator.data['zones']['zone']['pump_suggestion']['mode'], 'cool')

    def test_websocket_requires_admin_and_backup_does_not_restore_manual_commands(self):
        source = Path(__file__).resolve().parents[1] / 'custom_components/thermal_pilot/__init__.py'
        tree = ast.parse(source.read_text())
        handler = next(node for node in tree.body if isinstance(node, ast.AsyncFunctionDef)
                       and node.name == 'ws_manual')
        self.assertIn('websocket_api.require_admin', [ast.unparse(d) for d in handler.decorator_list])
        state = normalize_learning({'models': {}, 'manual_sessions': {'garage': {'ends': 9999999999}}},
                                   self.coordinator.settings)
        self.assertNotIn('manual_sessions', state)


    async def test_storage_failure_does_not_activate_an_unconfirmed_session(self):
        self.coordinator.store.async_save = AsyncMock(side_effect=OSError('disk unavailable'))
        with self.assertRaises(OSError):
            await self.start()
        self.assertFalse(self.coordinator.manual_sessions)
        self.assertFalse(self.hass.services.async_call.called)


    async def test_fan_only_zero_to_one_bounds_do_not_block_eighteen_degree_heat(self):
        pump = self.hass.states['climate.garage']
        pump.attributes.update(min_temp=0, max_temp=1, target_temp_step=1)
        control = self.coordinator.manual_controls()['garage']
        self.assertEqual(control['heat_target'], self.garage['garage_heat_target'])
        self.assertGreaterEqual(control['limits']['heat']['maximum'], 18)
        await self.start(target=18)
        self.assertTrue(any(call.args[1] == 'set_hvac_mode' and
                            call.args[2].get('hvac_mode') == 'heat'
                            for call in self.hass.services.async_call.call_args_list))
        pump.state = 'heat'
        pump.attributes.update(min_temp=16, max_temp=30, temperature=16)
        await self.coordinator.update_command_state(now + timedelta(seconds=10))
        self.assertTrue(any(call.args[1] == 'set_temperature' and
                            call.args[2].get('temperature') == 18
                            for call in self.hass.services.async_call.call_args_list))

    async def test_heat_and_cool_bounds_are_mode_specific_and_settling_is_respected(self):
        pump = self.hass.states['climate.garage']
        pump.state = 'heat'
        pump.attributes.update(min_temp=16, max_temp=30, target_temp_step=1)
        controls = self.coordinator.manual_controls()['garage']
        self.assertEqual(controls['limits']['heat'], {'minimum':16, 'maximum':30, 'step':1})
        self.assertEqual(controls['limits']['cool'], {'minimum':5, 'maximum':35, 'step':.5})
        with self.assertRaises(ValueError):
            await self.start(target=31)
        self.coordinator.air_control.ready['climate.garage'] = now.timestamp() + 10
        pump.attributes.update(min_temp=0, max_temp=1)
        self.assertEqual(self.coordinator.manual_controls()['garage']['limits']['heat']['maximum'], 35)

    async def test_water_session_follows_changed_configured_boost(self):
        await self.start('floor', target=99)
        self.coordinator.settings['boost'] = 2
        self.coordinator.data = await self.coordinator._async_update_data()
        self.assertEqual(self.coordinator.control.results['floor'], self.floor['baseline'] + 2)
