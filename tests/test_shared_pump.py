"""A linked room and its zone share one pump controller, not competing owners."""
from copy import deepcopy
import unittest
import test_coordinator
from test_coordinator import now, State
from thermal_pilot.config import validate, resolved_rooms, zone_rooms, air_room
from thermal_pilot.const import ROOM_DEFAULTS, ZONE_DEFAULTS


class SharedPumpTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await test_coordinator.CoordinatorTests.asyncSetUp(self)
        self.room=self.c.settings['rooms'][0]
        self.zone={**ZONE_DEFAULTS,'id':'22222222-2222-4222-8222-222222222222',
                   'name':'Upstairs','thermostat':'climate.room','main_room_id':self.room['id'],
                   'heating_strategy':'temperature','heating_enabled':True}
        self.room.update(heating_zone_id=self.zone['id'],heat_control='air_to_air')
        self.c.settings.update(heating_zones=[self.zone],simulation_enabled=False,live_control_confirmed=True)
        self.hass.states['climate.room'].attributes.update(hvac_modes=['heat','fan_only','off'],temperature=24)
        self.hass.states['sensor.room'].state='19.5'

    async def asyncTearDown(self):self.temp.cleanup()

    async def test_linked_room_can_select_same_pump_for_both_control_choices(self):
        for choice in ('house','air_to_air'):
            self.room['heat_control']=choice
            settings=validate(self.c.settings,self.hass)
            room=resolved_rooms(settings)[0]
            self.assertEqual(room['heat_control'],'zone_member')
            self.assertFalse(air_room(room,settings))
            self.assertNotIn('secondary_pump_entity',room)
            self.assertEqual(settings['rooms'][0]['heat_control'],choice,'retain stored configuration')

    async def test_multiple_linked_sensors_share_the_zone_owner(self):
        second={**self.room,'id':'33333333-3333-4333-8333-333333333333','name':'Hall','temperature_entity':'sensor.hall'}
        self.hass.states['sensor.hall']=State('20')
        self.c.settings['rooms'].append(second)
        settings=validate(self.c.settings,self.hass)
        self.assertTrue(all(room['heat_control']=='zone_member' for room in resolved_rooms(settings)))
        controllers=[room for room in zone_rooms(settings) if air_room(room,settings)]
        self.assertEqual(len(controllers),1)

    async def test_unlinked_controller_and_duplicate_zones_remain_rejected(self):
        self.room['heating_zone_id']='';self.zone['main_room_id']=''
        with self.assertRaisesRegex(ValueError,'Add the rooms using this heat pump'):validate(self.c.settings,self.hass)
        self.room['heating_zone_id']=self.zone['id'];self.zone['main_room_id']=self.room['id']
        self.c.settings['heating_zones'].append({**self.zone,'id':'44444444-4444-4444-8444-444444444444','main_room_id':''})
        with self.assertRaisesRegex(ValueError,'only one controller'):validate(self.c.settings,self.hass)

    async def test_zone_is_the_only_live_owner_and_disabled_zone_stays_inactive(self):
        self.c._plan_settings=deepcopy(self.c.settings)
        data={'rooms':{self.room['id']:{'plan':None}},'zones':{self.zone['id']:{'plan':None}},'warnings':[]}
        await self.c.apply_live_targets(data,now)
        self.assertNotIn(self.room['id'],self.c.manual_controls())
        self.assertIn('zone:'+self.zone['id'],self.c.manual_controls())
        self.assertFalse(self.c.control.results)
        self.assertEqual(data['zones'][self.zone['id']]['pump_suggestion']['mode'],'heat')
        self.zone['heating_enabled']=False
        self.c._plan_settings=deepcopy(self.c.settings);self.hass.services.async_call.reset_mock()
        await self.c.apply_live_targets(data,now)
        self.hass.services.async_call.assert_not_called()

    async def test_distinct_primary_floor_stays_independent(self):
        self.zone['thermostat']='climate.other'
        self.hass.states['climate.other']=State('fan_only',{'hvac_modes':['heat','fan_only'],'min_temp':5,'max_temp':35})
        self.room['heat_control']='house'
        settings=validate(self.c.settings,self.hass)
        room=resolved_rooms(settings)[0]
        self.assertEqual(room['heat_control'],'house')
        self.assertEqual(room['secondary_pump_entity'],'climate.other')
