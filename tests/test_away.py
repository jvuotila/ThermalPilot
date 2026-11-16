"""Absence control and calendar tests with HA doubles, never live devices."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import unittest
from unittest.mock import patch

import test_coordinator
from test_coordinator import State, now
from thermal_pilot.away import room_exempt, person_count, parse_schedule, update, temperature_at, overlay_plan
from thermal_pilot.const import DEFAULTS, ROOM_DEFAULTS, ZONE_DEFAULTS
from thermal_pilot.config import validate
from thermal_pilot.coordinator import PilotCoordinator
from thermal_pilot.model import thermostat_state
from thermal_pilot.backup_migrations import normalize_learning


class AwayPolicyTests(unittest.TestCase):
    def setUp(self):
        self.settings={**DEFAULTS,'away_zone':'zone.home','away_automatic':True,'away_delay_hours':24}
        self.time=now.timestamp()

    def test_zone_count_never_coerces_unknown_to_empty(self):
        for value in ('unknown','unavailable','', '-1','1.5','nan','inf'):
            self.assertIsNone(person_count(State(value)))
        self.assertIsNone(person_count(None))
        self.assertEqual(person_count(State('0')),0)
        self.assertEqual(person_count(State('3')),3)

    def test_delay_short_trips_and_return(self):
        state,status=update({},self.settings,0,self.time)
        self.assertFalse(status['active'])
        self.assertIsNone(temperature_at(status,self.time+23*3600))
        self.assertEqual(temperature_at(status,self.time+24*3600),16)
        state,status=update(state,self.settings,0,self.time+24*3600)
        self.assertTrue(status['active'])
        self.assertEqual(status['source'],'automatic')
        state,status=update(state,self.settings,1,self.time+25*3600)
        self.assertFalse(status['active']);self.assertIsNone(state['empty_since'])
        state,status=update(state,self.settings,0,self.time+26*3600)
        self.assertFalse(status['active']);self.assertEqual(state['empty_since'],self.time+26*3600)

    def test_unknown_zone_resets_automatic_confirmation(self):
        state,_=update({},self.settings,0,self.time)
        state,status=update(state,self.settings,None,self.time+25*3600)
        self.assertFalse(status['active']);self.assertTrue(status['warning'])
        state,status=update(state,self.settings,0,self.time+26*3600)
        self.assertFalse(status['active'])
        self.assertEqual(status['automatic_start'],self.time+50*3600)

    def test_manual_calendar_ignores_presence_when_automatic_is_off(self):
        self.settings['away_automatic']=False
        state={'schedule':{'start':self.time,'end':self.time+7200}}
        state,status=update(state,self.settings,0,self.time)
        self.assertTrue(status['active'])
        state,status=update(state,self.settings,2,self.time+3600)
        self.assertTrue(status['active']);self.assertIn('schedule',state)
        self.assertEqual(temperature_at(status,self.time+4000),16)
        state,status=update(state,self.settings,2,self.time+7200)
        self.assertFalse(status['active']);self.assertNotIn('schedule',state)

    def test_automatic_return_cancels_booking_without_reactivation(self):
        state={'schedule':{'start':self.time,'end':self.time+7*86400}}
        state,status=update(state,self.settings,0,self.time)
        self.assertTrue(status['active']);self.assertEqual(status['source'],'calendar')
        state,status=update(state,self.settings,1,self.time+3600)
        self.assertFalse(status['active']);self.assertNotIn('schedule',state)
        state,status=update(state,self.settings,0,self.time+7200)
        self.assertFalse(status['active'],'the old calendar trip must not restart')

    def test_future_booking_survives_home_presence_until_departure(self):
        state={'schedule':{'start':self.time+3600,'end':self.time+7200}}
        state,status=update(state,self.settings,1,self.time)
        self.assertIn('schedule',state)
        state,status=update(state,self.settings,1,self.time+3600)
        self.assertFalse(status['active']);self.assertIn('schedule',state)
        state,status=update(state,self.settings,0,self.time+4000)
        self.assertTrue(status['active'])

    def test_turning_detection_off_keeps_calendar_booking(self):
        state={'schedule':{'start':self.time,'end':self.time+7200}}
        state,_=update(state,self.settings,0,self.time)
        self.settings['away_automatic']=False
        state,status=update(state,self.settings,1,self.time+3600)
        self.assertTrue(status['active']);self.assertEqual(status['source'],'calendar')
        self.assertIsNone(status['automatic_start'])

    def test_calendar_uses_home_assistant_zone_and_rejects_dst_ambiguity(self):
        period=parse_schedule('2026-11-16T18:00','2026-11-22T22:00','Europe/Helsinki',now)
        self.assertEqual(datetime.fromtimestamp(period['start'],timezone.utc).hour,16)
        for start,end in [('2026-03-29T03:30','2026-03-29T06:00'),('2026-10-25T03:30','2026-10-25T06:00')]:
            with self.assertRaisesRegex(ValueError,'daylight saving'):
                parse_schedule(start,end,'Europe/Helsinki',now)
        for start,end in [('wrong','wrong'),('2026-01-02T02:00','2026-01-02T01:00'),('2026-01-01T00:00','2026-01-01T01:00')]:
            with self.assertRaises(ValueError):parse_schedule(start,end,'UTC',now)


class AwayCoordinatorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await test_coordinator.CoordinatorTests.asyncSetUp(self)
        self.assertFalse(self.c.settings['away_automatic'],'existing installations must default to manual-only absence scheduling')
        self.room=self.c.settings['rooms'][0];self.rid=self.room['id']
        self.c.settings.update(away_automatic=True,away_zone='zone.home',away_delay_hours=1,
            simulation_enabled=False,live_control_confirmed=True)
        self.hass.states['zone.home']=State('0',{'friendly_name':'Home'})
        self.c._plan_settings=deepcopy(self.c.settings)
        self.c.data={'rooms':{self.rid:{'plan':None}},'warnings':[]}

    async def asyncTearDown(self):self.temp.cleanup()

    async def apply(self,hours):
        return await self.c.apply_live_targets(self.c.data,now+timedelta(hours=hours))

    def floor_target(self):
        calls=[call.args[2]['temperature'] for call in self.hass.services.async_call.call_args_list
            if call.args[:2]==('climate','set_temperature') and call.args[2]['entity_id']=='climate.room']
        return calls[-1]

    async def test_fixed_target_below_normal_minimum_and_return_restores_comfort(self):
        await self.apply(0);self.assertEqual(self.floor_target(),20)
        await self.apply(1);self.assertEqual(self.floor_target(),16)
        self.hass.states['zone.home'].state='1'
        await self.apply(2);self.assertEqual(self.floor_target(),20)
        self.assertFalse(self.c.data['away']['active'])

    async def test_restart_preserves_absence_delay(self):
        await self.apply(0)
        replacement=PilotCoordinator(self.hass,self.c.entry)
        replacement.settings=deepcopy(self.c.settings);replacement.store.saved=deepcopy(self.c.store.saved)
        await replacement.load();replacement._plan_settings=deepcopy(replacement.settings)
        replacement.data=deepcopy(self.c.data)
        await replacement.apply_live_targets(replacement.data,now+timedelta(hours=2))
        self.assertTrue(replacement.away_status['active'])
        self.assertEqual(replacement.away['empty_since'],now.timestamp())

    async def test_calendar_cancel_restores_immediately_without_enabling_automatic(self):
        self.c.settings['away_automatic']=False
        self.c._plan_settings=deepcopy(self.c.settings)
        with patch('thermal_pilot.coordinator.dt_util.utcnow',return_value=now):
            response=await self.c.set_away_schedule('set','2026-01-01T23:00','2026-01-03T22:00',now)
        self.assertTrue(response['away']['active']);self.assertEqual(self.floor_target(),16)
        self.hass.states['zone.home'].state='1'
        await self.apply(2);self.assertEqual(self.floor_target(),16)
        with patch('thermal_pilot.coordinator.dt_util.utcnow',return_value=now+timedelta(hours=2)):
            response=await self.c.set_away_schedule('cancel',None,None,now+timedelta(hours=2))
        self.assertFalse(response['away']['active']);self.assertGreaterEqual(self.floor_target(),19)
        self.assertNotIn('away',normalize_learning(self.c.store.saved,self.c.settings))

    async def test_calendar_boundaries_and_forecast_setpoints_are_exact(self):
        self.c.settings['away_automatic']=False
        self.c.settings['simulation_enabled']=True
        self.c.away={'schedule':{'start':now.timestamp()+420,'end':now.timestamp()+7200}}
        with patch('thermal_pilot.coordinator.dt_util.utcnow',return_value=now):
            data=await self.c._async_update_data()
        plan=data['rooms'][self.rid]['plan']
        self.assertTrue(plan['away_plan'])
        at=now+timedelta(minutes=7)
        self.assertEqual(thermostat_state(plan,at)['setpoint'],16)
        self.assertGreaterEqual(thermostat_state(plan,now+timedelta(hours=2))['setpoint'],20)
        self.assertNotEqual(thermostat_state(plan,now+timedelta(hours=2))['mode'],'away')
        self.hass.services.async_call.assert_not_called()
        self.c.arm_command_timer(data,now)
        self.assertIsNotNone(self.c._command_timer)

    async def test_solar_and_preferred_floor_do_not_override_away_temperature(self):
        self.c.settings.update(solar_power_entity='sensor.pv',house_heat_source='electric_resistance',house_distribution='electric_floor')
        self.hass.states['sensor.pv']=State('5000',{'unit_of_measurement':'W'})
        zone={**ZONE_DEFAULTS,'id':'22222222-2222-4222-8222-222222222222','name':'Pump',
            'main_room_id':self.rid,'thermostat':'climate.pump','heating_enabled':True}
        self.room.update(heating_priority='heat_pump_preferred',heating_zone_id=zone['id'])
        self.c.settings['heating_zones']=[zone]
        self.hass.states['climate.pump']=State('heat',{'temperature':24,'hvac_action':'heating',
            'hvac_modes':['heat','fan_only','off'],'min_temp':5,'max_temp':35})
        self.c.data['zones']={zone['id']:{'plan':None}}
        self.c._plan_settings=deepcopy(self.c.settings)
        await self.apply(0);await self.apply(1)
        self.assertEqual(self.floor_target(),16)
        self.assertFalse(self.c.solar_heating.get('sessions'))
        self.assertFalse(self.c.heating_assistance)
        self.assertEqual(self.c.data['zones'][zone['id']]['pump_suggestion']['mode'],'fan_only')
        self.hass.states['sensor.room'].state='15.5'
        await self.apply(1.1)
        self.assertEqual(self.c.data['zones'][zone['id']]['pump_suggestion']['mode'],'heat')

    async def test_garages_and_explicit_manual_heat_keep_existing_behavior(self):
        garage={**ROOM_DEFAULTS,'id':'garage','name':'Garage','is_garage':True,
            'thermostat':'climate.garage','temperature_entity':'sensor.garage'}
        self.assertIsNone(self.c.away_target(garage))
        await self.apply(0);await self.apply(1)
        self.c.manual_sessions[self.rid]={'entity':'climate.room','mode':'heat','target':21.5,
            'ends':now.timestamp()+4*3600}
        await self.apply(2);self.assertEqual(self.floor_target(),21.5)
        self.c.manual_sessions={};self.hass.states['sensor.room'].state='unavailable'
        await self.apply(3);self.assertGreaterEqual(self.floor_target(),19)

    async def test_unpriced_away_forecast_preserves_existing_sensor_interfaces(self):
        import ast
        import types
        from pathlib import Path
        self.c.settings.update(price_entity='',away_automatic=False)
        self.c.away={'schedule':{'start':now.timestamp(),'end':now.timestamp()+86400}}
        with patch('thermal_pilot.coordinator.dt_util.utcnow',return_value=now):
            self.c.data=await self.c._async_update_data()
        source=Path(__file__).resolve().parents[1]/'custom_components/thermal_pilot/sensor.py'
        sensor=next(node for node in ast.parse(source.read_text()).body if isinstance(node,ast.ClassDef) and node.name=='PilotSensor')
        getter=next(node for node in sensor.body if isinstance(node,ast.FunctionDef) and node.name=='native_value')
        getter.decorator_list=[];namespace={}
        exec(compile(ast.Module(body=[getter],type_ignores=[]),str(source),'exec'),namespace)
        for metric in ('hours','temperature','setpoint'):
            entity=types.SimpleNamespace(coordinator=self.c,room_id=self.rid,metric=metric)
            self.assertIsNotNone(namespace['native_value'](entity),metric)

    async def test_room_exemption_keeps_normal_floor_targets(self):
        self.room['away_exempt']=True
        self.c._plan_settings=deepcopy(self.c.settings)
        await self.apply(0);await self.apply(1)
        self.assertEqual(self.floor_target(),20)
        self.assertNotIn('away',self.c.data['rooms'][self.rid])
        self.assertTrue(self.c.away_status['active'])

    async def test_cooling_target_is_raised_and_an_exempt_zone_keeps_normal_cooling(self):
        zone={**ZONE_DEFAULTS,'id':'22222222-2222-4222-8222-222222222222','name':'Pump',
            'main_room_id':self.rid,'thermostat':'climate.pump','heating_enabled':True,
            'climate_mode':'both','cooling_target':24}
        self.room['heating_zone_id']=zone['id'];self.c.settings['heating_zones']=[zone]
        self.c._plan_settings=deepcopy(self.c.settings)
        self.c.fallback_state['summer']=True
        self.c.data['zones']={zone['id']:{'plan':None}}
        self.hass.states['climate.pump']=State('fan_only',{'hvac_modes':['heat','cool','fan_only','off'],
            'temperature':24,'hvac_action':'idle','min_temp':16,'max_temp':30})
        self.hass.states['sensor.room'].state='25'
        await self.apply(0);await self.apply(1)
        self.assertEqual(self.c.data['zones'][zone['id']]['pump_suggestion']['mode'],'fan_only')
        self.hass.states['sensor.room'].state='27'
        await self.apply(1.1)
        self.assertEqual(self.c.data['zones'][zone['id']]['pump_suggestion']['target'],26)
        self.assertEqual(self.c.data['zones'][zone['id']]['pump_suggestion']['reason'],'Away cooling temperature')
        self.room['away_exempt']=True
        self.c._plan_settings=deepcopy(self.c.settings)
        self.assertTrue(room_exempt({'heating_zone_id':zone['id']},self.c.settings))
        self.hass.states['sensor.room'].state='25'
        await self.apply(1.2)
        self.assertEqual(self.c.data['zones'][zone['id']]['pump_suggestion']['target'],24)
        self.assertNotIn('away',self.c.data['zones'][zone['id']])

    async def test_calendar_write_failure_and_admin_boundary(self):
        import ast
        from pathlib import Path
        from unittest.mock import AsyncMock
        self.c.store.async_save=AsyncMock(side_effect=OSError('disk unavailable'))
        with self.assertRaises(OSError):
            await self.c.set_away_schedule('set','2026-01-01T23:00','2026-01-03T22:00',now)
        self.assertFalse(self.c.away)
        self.hass.services.async_call.assert_not_called()
        source=Path(__file__).resolve().parents[1]/'custom_components/thermal_pilot/__init__.py'
        handler=next(node for node in ast.parse(source.read_text()).body
                     if isinstance(node,ast.AsyncFunctionDef) and node.name=='ws_away')
        self.assertIn('websocket_api.require_admin',[ast.unparse(item) for item in handler.decorator_list])

    async def test_automatic_configuration_requires_a_zone_but_manual_does_not(self):
        settings=deepcopy(self.c.settings);settings['away_zone']=''
        with self.assertRaisesRegex(ValueError,'presence zone'):validate(settings,self.hass)
        settings['away_automatic']=False
        result=validate(settings,self.hass)
        self.assertEqual(result['away_temperature'],16)
