"""Companion delivery tests use service doubles; no real pushes are sent."""
import ast
from copy import deepcopy
from datetime import timedelta
from pathlib import Path
import types
import unittest

import test_manual_sessions as manual_fixtures
from test_coordinator import State, now
from thermal_pilot.coordinator import PilotCoordinator
from thermal_pilot.config import validate
from thermal_pilot.const import DEFAULTS


class ManualPushTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await manual_fixtures.ManualSessionTests.asyncSetUp(self)
        self.coordinator.settings.update(manual_notification_target='notify.mobile_app_my_phone', language='fi')
        garage = next(room for room in self.coordinator.settings['rooms'] if room['id'] == 'garage')
        garage['garage_door_entities'] = ['binary_sensor.main_door', 'binary_sensor.side_door']
        self.hass.states.update({
            'binary_sensor.main_door': State('on', {'friendly_name': 'Nosto-ovi'}),
            'binary_sensor.side_door': State('off', {'friendly_name': 'Sivuovi'}),
        })
        self.coordinator.data = await self.coordinator._async_update_data()
        self.hass.services.async_call.reset_mock()

    async def asyncTearDown(self):
        await manual_fixtures.ManualSessionTests.asyncTearDown(self)

    async def start(self, mode='heat'):
        return await manual_fixtures.ManualSessionTests.start(self, mode=mode, target=20)

    def pushes(self):
        return [call for call in self.hass.services.async_call.call_args_list if call.args[0] == 'notify']

    async def test_localized_push_identifies_only_the_open_door_and_selected_phone(self):
        await self.start()
        self.assertEqual(len(self.pushes()), 1)
        call = self.pushes()[0]
        self.assertEqual(call.args[:2], ('notify', 'mobile_app_my_phone'))
        payload = call.args[2]
        self.assertEqual(payload['title'], 'Manuaalinen lämmitys keskeytetty')
        self.assertIn('Nosto-ovi', payload['message'])
        self.assertNotIn('Sivuovi', payload['message'])
        self.assertIn('Garage', payload['message'])
        self.assertIn('Sulje kaikki määritetyt ovet', payload['message'])
        self.assertEqual(payload['data']['url'], '/thermal_pilot')
        self.assertEqual(self.coordinator.data['rooms']['garage']['pump_suggestion']['mode'], 'fan_only')

    async def test_polling_and_restart_do_not_repeat_the_same_notification(self):
        await self.start()
        await self.coordinator.update_command_state(now + timedelta(seconds=10))
        self.assertEqual(len(self.pushes()), 1)
        replacement = PilotCoordinator(self.hass, self.entry)
        replacement.store.saved = deepcopy(self.coordinator.store.saved)
        await replacement.load()
        replacement.settings = deepcopy(self.coordinator.settings)
        replacement.data = await replacement._async_update_data()
        self.assertEqual(len(self.pushes()), 1)
        replacement.stop()
        # An explicit update is a fresh request and can notify again.
        await self.start()
        self.assertEqual(len(self.pushes()), 2)

    async def test_closed_doors_no_recipient_and_automatic_control_do_not_push(self):
        await self.coordinator.update_command_state(now)
        self.assertFalse(self.pushes())  # No manual session yet.
        self.coordinator.settings['manual_notification_target'] = ''
        self.coordinator.data = await self.coordinator._async_update_data()
        await self.start()
        self.assertFalse(self.pushes())
        self.assertNotIn('door_notification_attempted', self.coordinator.manual_sessions['garage'])
        self.coordinator.settings['manual_notification_target'] = 'notify.mobile_app_my_phone'
        self.hass.states['binary_sensor.main_door'].state = 'off'
        self.coordinator.data = await self.coordinator._async_update_data()
        self.assertFalse(self.pushes())
        self.assertEqual(self.coordinator.data['rooms']['garage']['pump_suggestion']['mode'], 'heat')

    async def test_cooling_and_notify_entity_are_supported(self):
        self.coordinator.settings['manual_notification_target'] = 'notify.my_phone'
        self.coordinator.data = await self.coordinator._async_update_data()
        await self.start(mode='cool')
        call = self.pushes()[0]
        self.assertEqual(call.args[:2], ('notify', 'send_message'))
        self.assertEqual(call.args[2]['entity_id'], 'notify.my_phone')
        self.assertEqual(call.args[2]['title'], 'Manuaalinen jäähdytys keskeytetty')
        self.assertNotIn('data', call.args[2])

    async def test_delivery_failure_does_not_interrupt_protection_or_repeat_on_polls(self):
        async def fail_notification(domain, *args, **kwargs):
            if domain == 'notify':
                raise RuntimeError('Phone unavailable')
        self.hass.services.async_call.side_effect = fail_notification
        await self.start()
        self.assertEqual(self.coordinator.data['rooms']['garage']['pump_suggestion']['mode'], 'fan_only')
        self.assertIn('Push notification could not be sent. Check the selected notification device.',
                      self.coordinator.data['control']['errors'])
        await self.coordinator.update_command_state(now + timedelta(seconds=10))
        self.assertEqual(len(self.pushes()), 1)


class NotificationTargetTests(unittest.TestCase):
    def test_only_companion_targets_are_listed_without_selecting_a_recipient(self):
        source = Path(__file__).resolve().parents[1] / 'custom_components/thermal_pilot/__init__.py'
        tree = ast.parse(source.read_text())
        helper = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                      and node.name == 'companion_notification_targets')
        entry = lambda entity, platform='mobile_app', disabled=False: types.SimpleNamespace(
            entity_id=entity, platform=platform, disabled_by=disabled)
        registry = types.SimpleNamespace(entities={
            'phone': entry('notify.phone'), 'disabled': entry('notify.disabled', disabled=True),
            'mail': entry('notify.email', platform='smtp'),
        })
        namespace = {'er': types.SimpleNamespace(async_get=lambda hass: registry)}
        exec(compile(ast.Module(body=[helper], type_ignores=[]), str(source), 'exec'), namespace)
        hass = types.SimpleNamespace(services=types.SimpleNamespace(async_services=lambda: {
            'notify': {'mobile_app_phone': object(), 'notify': object(), 'email': object()},
        }))
        self.assertEqual(namespace['companion_notification_targets'](hass),
                         ['notify.mobile_app_phone', 'notify.phone'])
        self.assertEqual(DEFAULTS['manual_notification_target'], '')

    def test_notification_target_validation_preserves_optional_unavailable_selection(self):
        settings = {**DEFAULTS, 'price_entity': 'static', 'outdoor_entity': 'sensor.out'}
        for target in ('', 'notify.mobile_app_my_phone', 'notify.my_phone'):
            self.assertEqual(validate({**settings, 'manual_notification_target': target})['manual_notification_target'], target)
        for target in ('climate.garage', 'notify.', 'notify.phone,notify.other', 'notify.phone/other'):
            with self.subTest(target=target), self.assertRaises(ValueError):
                validate({**settings, 'manual_notification_target': target})
