"""Timed manual control tests with HA service doubles, not physical devices."""
from copy import deepcopy
from datetime import timedelta
from pathlib import Path
import ast
import tempfile
import types
import unittest
from unittest.mock import patch

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
                       'is_garage': True}
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
        controls = await self.start('floor', target=22)
        self.assertEqual(controls['floor']['modes'], ['heat'])
        self.assertEqual(self.coordinator.control.results['floor'], 22)
        writes = self.hass.services.async_call.call_args_list
        self.assertTrue(any(call.args[1] == 'set_temperature' and
                            call.args[2].get('temperature') == 22 for call in writes))
        await self.start('floor', mode='stop')
        self.assertNotIn('floor', self.coordinator.manual_sessions)
        self.assertEqual(self.coordinator.control.results['floor'],
                         self.coordinator.data['rooms']['floor']['plan']['setpoint'])

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
                                (120, 15), (120, 31), (120, float('inf'))]:
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
        from unittest.mock import AsyncMock
        self.coordinator.store.async_save = AsyncMock(side_effect=OSError('disk unavailable'))
        with self.assertRaises(OSError):
            await self.start()
        self.assertFalse(self.coordinator.manual_sessions)
        self.assertFalse(self.hass.services.async_call.called)
