"""Door reminders for non-air garage heating; no real notifications are sent."""
from copy import deepcopy
from datetime import timedelta
from unittest.mock import patch
import unittest

import test_garage_sources
from test_coordinator import State, now
from thermal_pilot.coordinator import PilotCoordinator


class GarageDoorWarningTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await test_garage_sources.GarageThermostatControlTests.asyncSetUp(self)
        self.c.settings.update(manual_notification_target='notify.mobile_app_my_phone', language='fi')
        self.room['garage_door_warning_minutes'] = 10
        self.hass.states['binary_sensor.door'].attributes['friendly_name'] = 'Nosto-ovi'
        self.c.data = await self.c._async_update_data()

    async def asyncTearDown(self):
        self.c.stop()
        self.temp.cleanup()

    def pushes(self):
        return [call for call in self.hass.services.async_call.await_args_list if call.args[0] == 'notify']

    async def test_warning_at_user_delay_keeps_heating_and_names_selected_device(self):
        self.assertFalse(self.pushes())
        self.assertIn(now.timestamp() + 600, self.c.garage_door_warning_deadlines)
        await self.c.update_command_state(now + timedelta(seconds=599))
        self.assertFalse(self.pushes())
        await self.c.update_command_state(now + timedelta(seconds=600))
        self.assertEqual(len(self.pushes()), 1)
        call = self.pushes()[0]
        self.assertEqual(call.args[:2], ('notify', 'mobile_app_my_phone'))
        self.assertEqual(call.args[2]['title'], 'Autotallin ovi jäänyt auki')
        self.assertIn('10 minuuttia', call.args[2]['message'])
        self.assertIn('Nosto-ovi', call.args[2]['message'])
        self.assertIn('Lämmitystä ei ole keskeytetty', call.args[2]['message'])
        self.assertEqual(self.c.data['rooms'][self.room['id']]['pump_suggestion']['mode'], 'heat')
        self.assertFalse(self.c.garage_door_warning_deadlines)

    async def test_restart_keeps_elapsed_time_and_does_not_repeat_delivered_warning(self):
        entry = deepcopy(self.c.entry)
        restarted = PilotCoordinator(self.hass, entry)
        restarted.store.saved = deepcopy(self.c.store.saved)
        await restarted.load()
        restarted.settings = deepcopy(self.c.settings)
        restarted.data = deepcopy(self.c.data)
        await restarted.update_command_state(now + timedelta(seconds=600))
        self.assertEqual(len(self.pushes()), 1)
        self.assertEqual(restarted.garage_door_warnings[self.room['id']]['since'], now.timestamp())
        again = PilotCoordinator(self.hass, entry)
        again.store.saved = deepcopy(restarted.store.saved)
        await again.load()
        again.settings = deepcopy(self.c.settings)
        again.data = deepcopy(self.c.data)
        await again.update_command_state(now + timedelta(seconds=1200))
        self.assertEqual(len(self.pushes()), 1)
        restarted.stop()
        again.stop()

    async def test_closed_and_unknown_intervals_reset_timer(self):
        await self.c.update_command_state(now + timedelta(seconds=600))
        self.assertEqual(len(self.pushes()), 1)
        for index, value in enumerate(('off', 'unavailable')):
            closed_at = 610 + index * 700
            reopened_at = closed_at + 10
            self.hass.states['binary_sensor.door'].state = value
            await self.c.update_command_state(now + timedelta(seconds=closed_at))
            self.assertFalse(self.c.garage_door_warnings)
            self.hass.states['binary_sensor.door'].state = 'on'
            await self.c.update_command_state(now + timedelta(seconds=reopened_at))
            await self.c.update_command_state(now + timedelta(seconds=reopened_at + 599))
            self.assertEqual(len(self.pushes()), 1)
        await self.c.update_command_state(now + timedelta(seconds=reopened_at + 600))
        self.assertEqual(len(self.pushes()), 2)

    async def test_custom_delay_observation_mode_and_notify_entity(self):
        self.room.update(garage_door_warning_minutes=3)
        self.c.settings['house_heat_source'] = 'oil_boiler'
        self.c.settings['manual_notification_target'] = 'notify.phone'
        await self.c.update_command_state(now + timedelta(seconds=180))
        self.assertEqual(len(self.pushes()), 1)
        self.assertEqual(self.pushes()[0].args[:2], ('notify', 'send_message'))
        self.assertEqual(self.pushes()[0].args[2]['entity_id'], 'notify.phone')
        self.assertIn('3 minuuttia', self.pushes()[0].args[2]['message'])

    async def test_no_recipient_disabled_integration_or_air_source_does_not_warn(self):
        for change in ({'manual_notification_target': ''}, {'heating_enabled': False}):
            saved = deepcopy(self.c.settings)
            self.c.settings.update(change)
            await self.c.update_command_state(now + timedelta(seconds=600))
            self.assertFalse(self.pushes())
            self.assertFalse(self.c.garage_door_warning_deadlines)
            self.c.settings = saved
        self.c.settings['rooms'][0]['garage_heat_source'] = 'air_to_air'
        self.assertFalse(await self.c.update_garage_door_warnings(now + timedelta(seconds=600)))
        self.assertFalse(self.pushes())

    async def test_failed_delivery_does_not_interrupt_heating_or_retry_every_poll(self):
        async def fail_notification(domain, *args, **kwargs):
            if domain == 'notify':
                raise RuntimeError('Phone unavailable')
        self.hass.services.async_call.side_effect = fail_notification
        with self.assertLogs('thermal_pilot.coordinator', level='WARNING'):
            await self.c.update_command_state(now + timedelta(seconds=600))
        self.assertEqual(self.c.data['rooms'][self.room['id']]['pump_suggestion']['mode'], 'heat')
        self.assertIn('Push notification could not be sent. Check the selected notification device.', self.c.data['control']['errors'])
        await self.c.update_command_state(now + timedelta(seconds=1200))
        self.assertEqual(len(self.pushes()), 1)


if __name__ == '__main__':
    unittest.main()
