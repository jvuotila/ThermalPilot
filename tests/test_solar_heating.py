"""Solar trigger behavior with HA doubles; no physical heating devices are used."""
from copy import deepcopy
from datetime import timedelta
import unittest
from unittest.mock import patch

import test_coordinator
from test_coordinator import State, now
from thermal_pilot.const import DEFAULTS
from thermal_pilot.config import validate
from thermal_pilot.solar_heating import production_kw, update_sessions
from thermal_pilot.coordinator import PilotCoordinator
from thermal_pilot.backup_migrations import normalize_learning


class SolarStateTests(unittest.TestCase):
    def setUp(self):
        self.settings={**DEFAULTS,'solar_power_entity':'sensor.pv'}
        self.rooms={'room':{'entity':'climate.room','signature':['climate.room',21.5],
                            'target':21.5,'can_start':True}}

    def update(self,state,power,minute,rooms=None):
        return update_sessions(state,self.settings,power,self.rooms if rooms is None else rooms,
                               now.timestamp()+minute*60,True)

    def test_hysteresis_separate_minimum_and_no_clock_extension(self):
        state=self.update({},4,0)
        self.assertFalse(state['active'])
        state=self.update(state,4.1,1)
        state=self.update(state,4.1,5)
        self.assertFalse(state['sessions'])
        state=self.update(state,4.1,6)
        start=state['sessions']['room']['started']
        self.assertEqual(state['sessions']['room']['minimum_until'],start+30*60)
        state=self.update(state,2,10)
        self.assertTrue(state['active'])
        state=self.update(state,.5,12)
        state=self.update(state,.5,17)
        self.assertFalse(state['active']);self.assertIn('room',state['sessions'])
        state=self.update(state,.5,35)
        self.assertEqual(state['sessions']['room']['started'],start)
        state=self.update(state,.5,36)
        self.assertFalse(state['sessions'])
        state=self.update(state,3.9,40)
        self.assertFalse(state['sessions'])

    def test_brief_peaks_clock_jumps_and_safety_cancel_without_waiting(self):
        state=self.update({},5,0)
        state=self.update(state,3,2)
        self.assertIsNone(state['candidate'])
        state=self.update(state,5,3)
        state=self.update(state,5,8)
        self.assertIn('room',state['sessions'])
        state=self.update(state,5,9,{})
        self.assertFalse(state['sessions'])
        state=self.update(state,5,10)
        self.assertFalse(state['sessions'],'a warm/protected room does not restart in the same production cycle')
        self.assertEqual(self.update(state,None,11),{})
        state=self.update({},5,0)
        state=self.update(state,5,30)
        self.assertFalse(state['active'],'a long observation gap cannot confirm a threshold')
        state=self.update(state,5,29)
        self.assertFalse(state['active'],'clock reversal restarts confirmation')

    def test_normal_minimum_setting_does_not_replace_solar_minimum(self):
        self.settings.update(minimum_run_minutes=120,solar_minimum_run_minutes=15)
        state=self.update({},5,0);state=self.update(state,5,5)
        self.assertEqual(state['sessions']['room']['minimum_until']-state['sessions']['room']['started'],900)
        self.settings['solar_stop_kw']=4
        with self.assertRaisesRegex(ValueError,'stop threshold'):
            validate(self.settings,require_outdoor=False)

    def test_power_units_unavailable_and_freshness(self):
        self.assertEqual(production_kw(State('4500',{'unit_of_measurement':'W'}),now),4.5)
        self.assertEqual(production_kw(State('4.5',{'unit_of_measurement':'kW'}),now),4.5)
        for value,unit in [('4.5','kWh'),('NaN','W'),('-1','W'),('unavailable','kW'),('4','')]:
            self.assertIsNone(production_kw(State(value,{'unit_of_measurement':unit}),now))
        state=State('5',{'unit_of_measurement':'kW'});state.last_updated=now-timedelta(minutes=16)
        self.assertIsNone(production_kw(state,now))
        state.last_reported=now
        self.assertEqual(production_kw(state,now),5)


class SolarCoordinatorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await test_coordinator.CoordinatorTests.asyncSetUp(self)
        self.c.settings.update(solar_power_entity='sensor.pv',solar_start_kw=4,solar_stop_kw=1,
                               solar_minimum_run_minutes=30,simulation_enabled=False,live_control_confirmed=True,
                               price_entity='')
        self.hass.states['sensor.pv']=State('5000',{'unit_of_measurement':'W'})
        self.room=self.c.settings['rooms'][0];self.rid=self.room['id']
        self.c._plan_settings=deepcopy(self.c.settings)
        self.c.data={'rooms':{self.rid:{'plan':None}},'warnings':[]}

    async def asyncTearDown(self):
        self.temp.cleanup()

    async def checkpoint(self,minute):
        await self.c.update_command_state(now+timedelta(minutes=minute))
        return self.c.data

    async def start(self):
        await self.checkpoint(0)
        return await self.checkpoint(5)

    def last_target(self):
        calls=[call for call in self.hass.services.async_call.call_args_list
               if call.args[:2]==('climate','set_temperature')]
        return calls[-1].args[2]['temperature']

    async def test_solar_heat_without_prices_stops_at_own_minimum(self):
        data=await self.start()
        self.assertEqual(self.last_target(),21.5)
        self.assertIn(self.rid,data['solar_heating']['sessions'])
        self.assertIn(self.rid,self.c.store.saved['solar_heating']['sessions'])
        self.hass.states['sensor.pv'].state='500'
        await self.checkpoint(6);await self.checkpoint(11)
        self.assertIn(self.rid,self.c.solar_heating['sessions'])
        await self.checkpoint(34)
        self.assertEqual(self.last_target(),21.5)
        await self.checkpoint(35)
        self.assertEqual(self.last_target(),20)
        self.assertFalse(self.c.solar_heating['sessions'])

    async def test_restart_preserves_minimum_and_resets_threshold_confirmation(self):
        await self.start()
        replacement=PilotCoordinator(self.hass,self.c.entry)
        replacement.settings=deepcopy(self.c.settings);replacement.store.saved=deepcopy(self.c.store.saved)
        with patch('thermal_pilot.coordinator.dt_util.utcnow',return_value=now+timedelta(minutes=10)):
            await replacement.load()
        self.assertEqual(replacement.solar_heating['sessions'][self.rid]['minimum_until'],now.timestamp()+35*60)
        self.assertIsNone(replacement.solar_heating['candidate'])
        replacement._plan_settings=deepcopy(replacement.settings);replacement.data=deepcopy(self.c.data)
        self.hass.states['sensor.pv'].state='500'
        await replacement.update_command_state(now+timedelta(minutes=10))
        await replacement.update_command_state(now+timedelta(minutes=15))
        self.assertIn(self.rid,replacement.solar_heating['sessions'])
        await replacement.update_command_state(now+timedelta(minutes=35))
        self.assertFalse(replacement.solar_heating['sessions'])

    async def test_simulation_and_manual_priority_and_temperature_limit(self):
        self.c.settings.update(simulation_enabled=True,live_control_confirmed=False)
        self.c._plan_settings=deepcopy(self.c.settings)
        await self.start()
        self.hass.services.async_call.assert_not_awaited()
        self.assertIn(self.rid,self.c.data['solar_heating']['sessions'])
        self.hass.states[self.room['temperature_entity']].state='21.5'
        await self.checkpoint(6)
        self.assertFalse(self.c.solar_heating['sessions'])
        self.hass.states[self.room['temperature_entity']].state='20'
        self.c.manual_sessions[self.rid]={'entity':self.room['thermostat'],'ends':now.timestamp()+7200,'mode':'heat','target':22}
        await self.checkpoint(7)
        self.assertFalse(self.c.solar_heating['sessions'])

    async def test_missing_sensor_pause_summer_and_configuration_change_cancel(self):
        await self.start()
        self.hass.states['sensor.pv'].state='unavailable'
        data=await self.checkpoint(6)
        self.assertFalse(self.c.solar_heating)
        self.assertTrue(any('Solar production sensor' in value for value in data['warnings']))
        self.assertEqual(self.last_target(),20)
        self.hass.states['sensor.pv'].state='5000'
        await self.checkpoint(7);await self.checkpoint(12)
        self.assertTrue(self.c.solar_heating['sessions'])
        self.c.fallback_state['summer']=True
        await self.checkpoint(13)
        self.assertFalse(self.c.solar_heating)
        self.c.fallback_state['summer']=False
        await self.checkpoint(14);await self.checkpoint(19)
        self.c.settings['solar_power_entity']=''
        self.c._plan_settings=deepcopy(self.c.settings)
        await self.checkpoint(20)
        self.assertFalse(self.c.solar_heating)

    async def test_backup_restores_settings_but_never_solar_commands(self):
        await self.start()
        settings=validate({**self.c.settings,'simulation_enabled':True},require_outdoor=False)
        self.assertEqual(settings['solar_minimum_run_minutes'],30)
        state=normalize_learning({'models':{},'solar_heating':deepcopy(self.c.solar_heating)},settings)
        self.assertNotIn('solar_heating',state)

    async def test_garage_stops_solar_cycle_but_still_obeys_doors_and_upper_limit(self):
        from thermal_pilot.const import ROOM_DEFAULTS
        garage={**ROOM_DEFAULTS,'id':'garage','name':'Garage','thermostat':'climate.garage',
                'temperature_entity':'sensor.garage','is_garage':True,'garage_heat_source':'air_to_air','garage_minimum':6,'garage_maximum':10,
                'garage_heat_target':18,'garage_door_entities':['binary_sensor.door'],'garage_door_delay':60}
        self.c.settings['rooms']=[garage];self.c._plan_settings=deepcopy(self.c.settings)
        self.hass.states['sensor.garage']=State('7')
        self.hass.states['binary_sensor.door']=State('off')
        self.hass.states['climate.garage']=State('fan_only',{'hvac_modes':['heat','fan_only','off'],'temperature':18,'min_temp':16,'max_temp':30})
        self.c.data={'rooms':{'garage':{'plan':None}},'warnings':[]}
        await self.start()
        self.assertIn('garage',self.c.solar_heating['sessions'])
        self.assertEqual(self.c.data['rooms']['garage']['pump_suggestion']['mode'],'heat')
        self.hass.states['climate.garage'].state='heat'
        self.hass.states['sensor.pv'].state='500'
        await self.checkpoint(6);await self.checkpoint(11);await self.checkpoint(35)
        self.assertFalse(self.c.solar_heating['sessions'])
        self.assertEqual(self.c.data['rooms']['garage']['pump_suggestion']['mode'],'fan_only')
        self.hass.states['sensor.pv'].state='5000'
        self.hass.states['binary_sensor.door'].state='on'
        await self.checkpoint(36);await self.checkpoint(41)
        self.assertFalse(self.c.solar_heating['sessions'])
        self.hass.states['binary_sensor.door'].state='off'
        await self.checkpoint(42)
        self.assertIn('garage',self.c.solar_heating['sessions'])
        self.hass.states['sensor.garage'].state='10'
        await self.checkpoint(43)
        self.assertFalse(self.c.solar_heating['sessions'])
        self.assertEqual(self.c.data['rooms']['garage']['pump_suggestion']['mode'],'fan_only')

    async def test_normal_heating_plan_continues_after_solar_request_ends(self):
        from thermal_pilot.model import thermostat_timing
        self.c.settings['price_entity']='static';self.c._plan_settings=deepcopy(self.c.settings)
        rows=[{'start':now.isoformat(),'end':(now+timedelta(hours=2)).isoformat(),'heat':True,'mode':'boost'}]
        self.c.data['rooms'][self.rid]['plan']={**thermostat_timing(rows,self.c.settings,20,now),'slots':rows}
        await self.start();self.hass.states['sensor.pv'].state='500'
        await self.checkpoint(6);await self.checkpoint(11);await self.checkpoint(35)
        self.assertFalse(self.c.solar_heating['sessions'])
        self.assertEqual(self.last_target(),21.5)

    async def test_failed_persistence_cannot_issue_unrecorded_solar_commands(self):
        from unittest.mock import AsyncMock
        await self.checkpoint(0)
        before=deepcopy(self.c.solar_heating)
        self.hass.services.async_call.reset_mock()
        self.c.store.async_save=AsyncMock(side_effect=RuntimeError('Storage unavailable'))
        for _ in range(2):
            with self.assertRaisesRegex(RuntimeError,'Storage unavailable'):
                await self.checkpoint(5)
            self.assertEqual(self.c.solar_heating,before)
        self.hass.services.async_call.assert_not_awaited()

    async def test_full_refresh_exports_solar_request_and_keeps_actual_learning_separate(self):
        self.c.settings.update(simulation_enabled=True,live_control_confirmed=False,price_entity='static')
        self.c._plan_settings=deepcopy(self.c.settings)
        with patch('thermal_pilot.coordinator.dt_util.utcnow',return_value=now):
            await self.c._async_update_data()
        with patch('thermal_pilot.coordinator.dt_util.utcnow',return_value=now+timedelta(minutes=5)):
            data=await self.c._async_update_data()
        self.assertIn(self.rid,data['solar_heating']['sessions'])
        self.assertIsNotNone(data['rooms'][self.rid]['solar_heating'])
        self.assertNotEqual(data['rooms'][self.rid]['actual_activity'],1)
        self.hass.services.async_call.assert_not_awaited()

    async def test_zero_stop_threshold_ends_at_night_and_live_confirmation_restarts_clock(self):
        self.c.settings['solar_stop_kw']=0
        self.c._plan_settings=deepcopy(self.c.settings)
        await self.start()
        self.hass.states['sensor.pv'].state='0'
        await self.checkpoint(6);await self.checkpoint(11);await self.checkpoint(35)
        self.assertFalse(self.c.solar_heating['sessions'])
        self.hass.states['sensor.pv'].state='5000'
        self.c.settings['live_control_confirmed']=False
        self.c._plan_settings=deepcopy(self.c.settings)
        await self.checkpoint(36);await self.checkpoint(41)
        self.assertIn(self.rid,self.c.solar_heating['sessions'])
        self.c.settings['live_control_confirmed']=True
        self.c._plan_settings=deepcopy(self.c.settings)
        await self.checkpoint(42)
        self.assertFalse(self.c.solar_heating['sessions'])
        await self.checkpoint(47)
        self.assertEqual(self.c.solar_heating['sessions'][self.rid]['minimum_until'],now.timestamp()+77*60)

    async def test_non_electric_house_never_receives_solar_heating_commands(self):
        self.c.settings['house_heat_source']='wood'
        self.c._plan_settings=deepcopy(self.c.settings)
        await self.start()
        self.assertFalse(self.c.solar_heating)
        self.hass.services.async_call.assert_not_awaited()

    async def test_secondary_zone_cooling_and_manual_override_block_extra_floor_heat(self):
        from thermal_pilot.const import ZONE_DEFAULTS
        self.room['heating_zone_id']='zone1'
        self.c.settings['heating_zones']=[{**ZONE_DEFAULTS,'id':'zone1','name':'Secondary pump',
            'thermostat':'climate.secondary','main_room_id':self.rid,'heating_enabled':True}]
        self.hass.states['climate.secondary']=State('cool',{'hvac_modes':['heat','cool','fan_only'],'temperature':20,'hvac_action':'cooling'})
        for minute in (0,5):
            await self.c.update_solar_heating(self.c.data,now+timedelta(minutes=minute))
        self.assertNotIn(self.rid,self.c.solar_heating['sessions'])
        self.hass.states['climate.secondary'].state='fan_only'
        self.hass.states['climate.secondary'].attributes['hvac_action']='fan'
        self.c.manual_sessions['zone:zone1']={'entity':'climate.secondary','mode':'heat','target':23,'ends':now.timestamp()+7200}
        await self.c.update_solar_heating(self.c.data,now+timedelta(minutes=6))
        self.assertNotIn(self.rid,self.c.solar_heating['sessions'])
