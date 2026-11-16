"""Coordinated heat requests tested with HA doubles, never physical devices."""
from copy import deepcopy
from datetime import timedelta
import unittest
from unittest.mock import patch

import test_coordinator
from test_coordinator import State, now
from thermal_pilot.const import DEFAULTS, ROOM_DEFAULTS, ZONE_DEFAULTS
from thermal_pilot.config import preferred_zone, validate, room_settings, price_required
from thermal_pilot.model import initial_model
from thermal_pilot.heating_assistance import decide, update_room, forecast, temperature_trend
from thermal_pilot.coordinator import PilotCoordinator
from thermal_pilot.backup_migrations import normalize_learning


class AssistancePolicyTests(unittest.TestCase):
    def setUp(self):
        self.settings={**DEFAULTS,'lag_hours':3,'minimum_run_minutes':90}
        self.room={**ROOM_DEFAULTS,'baseline':20,'assist_below_target':.5}
        self.model=initial_model(room_settings(self.room,self.settings))

    def choice(self,state,temperature,minutes,predicted=None,available=True,heating=True):
        return decide(state,self.room,self.settings,temperature,predicted,
                      now.timestamp()+minutes*60,available,heating)

    def test_pump_maintains_comfort_without_floor_boost(self):
        state={}
        report=self.choice(state,20,0)
        self.assertTrue(report['pump_requested']);self.assertEqual(report['floor_target'],19.5)
        self.assertFalse(report['assisting'])
        report=self.choice(state,20.3,5)
        self.assertFalse(report['pump_requested'])

    def test_assists_while_pump_continues_and_minimum_does_not_extend(self):
        state={}
        report=self.choice(state,19.4,0)
        self.assertTrue(report['assisting']);self.assertTrue(report['pump_requested'])
        self.assertEqual(report['floor_target'],20+self.settings['boost'])
        deadline=report['minimum_until']
        report=self.choice(state,20.3,60,predicted=20.2)
        self.assertTrue(report['assisting']);self.assertEqual(report['floor_target'],20+self.settings['boost'])
        self.assertEqual(report['minimum_until'],deadline)
        report=self.choice(state,20.3,90,predicted=20.2)
        self.assertFalse(report['assisting']);self.assertEqual(report['floor_target'],19.5)
        self.assertEqual(state['resume_after'],now.timestamp()+105*60)
        self.assertFalse(self.choice(state,19.4,95)['assisting'])
        self.assertTrue(self.choice(state,self.settings['minimum']-.1,96)['assisting'])

    def test_falling_trend_preheats_for_lag_after_pump_warmup(self):
        state={'pump_since':now.timestamp()}
        self.assertFalse(self.choice(state,19.9,20,predicted=19.2)['assisting'])
        self.assertTrue(self.choice(state,19.9,30,predicted=19.2)['assisting'])
        self.assertFalse(self.choice({},19.9,30,predicted=19.2)['assisting'])
        self.assertFalse(self.choice({'pump_since':now.timestamp()},19.9,30,predicted=20)['assisting'])

    def test_backup_and_upper_temperature_protection(self):
        report=self.choice({},19.8,0,available=False)
        self.assertEqual(report['floor_target'],20);self.assertEqual(report['reason'],'Floor heating backup')
        report=self.choice({},19.4,0,available=False)
        self.assertGreater(report['floor_target'],20);self.assertFalse(report['pump_requested'])
        self.assertEqual(report['reason'],'Floor heating backup')
        state={'assisting':True,'minimum_until':now.timestamp()+3600}
        report=self.choice(state,self.settings['maximum'],1)
        self.assertFalse(report['assisting']);self.assertFalse(report['pump_requested'])

    def test_trend_needs_elapsed_evidence_and_gaps_restart_it(self):
        base=now.timestamp()
        samples=[{'time':base+i*300,'temperature':20-i*.025} for i in range(7)]
        self.assertIsNone(temperature_trend(samples[:3]))
        self.assertAlmostEqual(temperature_trend(samples),-.3)
        state={};report=None
        for sample in samples:
            state,report=update_room(state,['same'],self.room,self.settings,self.model,
                sample['temperature'],0,[0]*12,sample['time'],True,True)
        self.assertTrue(report['assisting']);self.assertLess(report['predicted_temperature'],19.5)
        state,report=update_room(state,['same'],self.room,self.settings,self.model,
            20,0,[0]*12,base+4000,True,True)
        self.assertIsNone(report['trend'])
        self.assertEqual(state['pump_since'],base+4000)

    def test_forecast_requires_observed_capacity_and_preserves_source_model(self):
        model=deepcopy(self.model);state={}
        report=self.choice(state,19.8,0);report.update(trend=None,pump_available=True)
        slots=[{'start':now+timedelta(minutes=15*i),'end':now+timedelta(minutes=15*(i+1)),
                'outdoor':-10,'price':None} for i in range(96)]
        self.assertIsNone(forecast(self.room,self.settings,model,state,report,19.8,-10,slots,now))
        report['trend']=-.2;state['pump_since']=now.timestamp()-3600
        plan=forecast(self.room,self.settings,model,state,report,19.8,-10,slots,now)
        self.assertTrue(plan['assistance_plan']);self.assertTrue(plan['slots'])
        self.assertTrue(any(row['mode']=='boost' and row['pump_requested'] for row in plan['slots']))
        self.assertEqual(model,self.model)
        self.assertTrue(all(19<=row['setpoint']<=self.settings['maximum'] for row in plan['slots']))


class AssistanceCoordinatorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await test_coordinator.CoordinatorTests.asyncSetUp(self)
        self.room=self.c.settings['rooms'][0];self.rid=self.room['id']
        self.room.update(heating_priority='heat_pump_preferred',assist_below_target=.5,heating_zone_id='22222222-2222-4222-8222-222222222222')
        self.zone={**ZONE_DEFAULTS,'id':'22222222-2222-4222-8222-222222222222','name':'House pump','thermostat':'climate.pump',
                   'main_room_id':self.rid,'heating_enabled':True,'heating_strategy':'temperature'}
        self.c.settings.update(house_heat_source='electric_resistance',house_distribution='electric_floor',
            simulation_enabled=False,live_control_confirmed=True,price_entity='',lag_hours=3,
            heating_zones=[self.zone])
        self.hass.states['climate.pump']=State('heat',{'temperature':24,'hvac_action':'heating',
            'hvac_modes':['heat','cool','fan_only','off'],'fan_modes':['high','low'],'min_temp':16,'max_temp':30})
        self.c._plan_settings=deepcopy(self.c.settings)
        self.c.data={'rooms':{self.rid:{'plan':None}},'zones':{'22222222-2222-4222-8222-222222222222':{'plan':None}},'warnings':[]}

    async def asyncTearDown(self):self.temp.cleanup()

    async def apply(self,minutes=0):
        return await self.c.apply_live_targets(self.c.data,now+timedelta(minutes=minutes))

    def floor_target(self):
        calls=[call for call in self.hass.services.async_call.call_args_list
               if call.args[:2]==('climate','set_temperature') and call.args[2]['entity_id']=='climate.room']
        return calls[-1].args[2]['temperature']

    async def test_room_settings_and_opt_in_defaults(self):
        self.assertIsNotNone(preferred_zone(self.room,self.c.settings))
        result=validate(deepcopy(self.c.settings),self.hass)
        self.assertEqual(result['rooms'][0]['assist_below_target'],.5)
        self.room['heating_priority']='independent'
        self.assertIsNone(preferred_zone(self.room,self.c.settings))
        self.assertEqual(ROOM_DEFAULTS['heating_priority'],'independent')
        self.room['heating_priority']='heat_pump_preferred';self.zone['heating_enabled']=False
        self.assertIsNone(preferred_zone(self.room,self.c.settings))
        validate(deepcopy(self.c.settings),self.hass)

    async def test_capacity_assistance_needs_prices_only_for_a_tariff_controlled_zone(self):
        self.assertFalse(price_required(self.c.settings))
        self.zone['heating_strategy']='tariff'
        self.assertTrue(price_required(self.c.settings))
        self.zone['heating_strategy']='temperature'
        self.room['heating_priority']='independent'
        self.assertTrue(price_required(self.c.settings))

    async def test_pump_and_floor_are_requested_together_only_when_needed(self):
        await self.apply()
        self.assertEqual(self.floor_target(),19.5)
        self.assertEqual(self.c.data['zones']['22222222-2222-4222-8222-222222222222']['pump_suggestion']['mode'],'heat')
        self.hass.states['sensor.room'].state='19.4'
        await self.apply(5)
        self.assertEqual(self.floor_target(),21.5)
        self.assertEqual(self.c.data['zones']['22222222-2222-4222-8222-222222222222']['pump_suggestion']['mode'],'heat')
        self.assertTrue(self.c.data['rooms'][self.rid]['heating_assistance']['assisting'])

    async def test_standby_pump_starts_without_withdrawing_floor_assistance(self):
        self.hass.states['climate.pump'].state='fan_only'
        self.hass.states['climate.pump'].attributes['hvac_action']='idle'
        self.hass.states['sensor.room'].state='19.4'
        await self.apply()
        modes=[call.args[2] for call in self.hass.services.async_call.call_args_list
               if call.args[:2]==('climate','set_hvac_mode')]
        self.assertIn({'entity_id':'climate.pump','hvac_mode':'heat'},modes)
        self.assertEqual(self.floor_target(),21.5)
        self.hass.states['climate.pump'].state='heat'
        self.hass.states['climate.pump'].attributes['hvac_action']='heating'
        await self.apply(1)
        self.assertEqual(self.floor_target(),21.5)
        self.assertEqual(self.c.data['zones'][self.zone['id']]['pump_suggestion']['mode'],'heat')

    async def test_zone_manual_control_and_cooling_season_block_automatic_assistance(self):
        self.zone['climate_mode']='both'
        self.c._plan_settings=deepcopy(self.c.settings)
        self.c.air_control.zone_seasons[self.zone['id']]={'summer':True,'candidate':True,'since':now.timestamp()}
        await self.apply()
        self.assertEqual(self.floor_target(),self.c.settings['minimum'])
        self.c.air_control.zone_seasons.clear()
        self.c.manual_sessions['zone:'+self.zone['id']]={
            'entity':'climate.pump','mode':'heat','target':22,'ends':now.timestamp()+3600}
        await self.apply(5)
        self.assertEqual(self.floor_target(),self.c.settings['minimum'])
        self.assertFalse(self.c.data['heating_assistance'][self.rid]['pump_requested'])

    async def test_mixed_heat_and_floor_residual_do_not_teach_pump_gain(self):
        self.c.settings.update(simulation_enabled=True,live_control_confirmed=False)
        self.hass.states['climate.room'].attributes['hvac_action']='heating'
        with patch('thermal_pilot.coordinator.dt_util.utcnow',return_value=now):
            await self.c._async_update_data()
        gain=self.c.models['zone:'+self.zone['id']]['gain']
        self.hass.states['climate.room'].attributes['hvac_action']='idle'
        for minute in (5,10,15,20):
            self.hass.states['sensor.room'].state=str(20+minute*.01)
            with patch('thermal_pilot.coordinator.dt_util.utcnow',return_value=now+timedelta(minutes=minute)):
                await self.c._async_update_data()
        model=self.c.models['zone:'+self.zone['id']]
        self.assertEqual(model['gain'],gain)
        self.assertEqual(model['heated_hours'],0)
        self.assertEqual(self.c.models[self.rid]['heated_hours'],0)

    async def test_unavailable_pump_restores_floor_and_missing_readings_do_not_suppress_it(self):
        self.hass.states['climate.pump'].state='unavailable'
        await self.apply()
        self.assertEqual(self.floor_target(),20)
        self.assertFalse(self.c.data['heating_assistance'][self.rid]['pump_requested'])
        self.hass.states['sensor.room'].state='unavailable'
        await self.apply(5)
        self.assertNotIn('heating_assistance',self.c.data['rooms'][self.rid])
        self.assertFalse(self.c.heating_assistance)

    async def test_cooling_and_manual_requests_keep_priority(self):
        self.hass.states['climate.pump']=State('cool',{'temperature':20,'hvac_action':'cooling'})
        await self.apply()
        self.assertEqual(self.floor_target(),self.c.settings['minimum'])
        self.c.manual_sessions[self.rid]={'entity':'climate.room','mode':'heat','target':21.5,'ends':now.timestamp()+3600}
        await self.apply(5)
        self.assertEqual(self.floor_target(),21.5)
        self.assertFalse(self.c.data['heating_assistance'][self.rid]['pump_requested'])

    async def test_restarted_minimum_is_not_started_again_and_backup_import_clears_it(self):
        self.c.settings['minimum_run_minutes']=120
        self.c._plan_settings=deepcopy(self.c.settings)
        self.hass.states['sensor.room'].state='19.4'
        await self.apply()
        deadline=self.c.heating_assistance[self.rid]['minimum_until']
        replacement=PilotCoordinator(self.hass,self.c.entry)
        replacement.settings=deepcopy(self.c.settings);replacement.store.saved=deepcopy(self.c.store.saved)
        with patch('thermal_pilot.coordinator.dt_util.utcnow',return_value=now+timedelta(minutes=20)):
            await replacement.load()
        replacement._plan_settings=deepcopy(replacement.settings)
        replacement.data=deepcopy(self.c.data)
        await replacement.apply_live_targets(replacement.data,now+timedelta(minutes=20))
        self.assertEqual(replacement.heating_assistance[self.rid]['minimum_until'],deadline)
        normalized=normalize_learning(replacement.store.saved,replacement.settings)
        self.assertNotIn('heating_assistance',normalized)

    async def test_full_refresh_and_simulation_keep_actual_learning_separate(self):
        self.c.settings.update(simulation_enabled=True,live_control_confirmed=False)
        for minute in range(0,36,5):
            self.hass.states['sensor.room'].state=str(20-minute*.005)
            with patch('thermal_pilot.coordinator.dt_util.utcnow',return_value=now+timedelta(minutes=minute)):
                data=await self.c._async_update_data()
        self.assertTrue(data['rooms'][self.rid]['plan']['assistance_plan'])
        self.assertFalse(any('Choose a price sensor' in warning for warning in data['warnings']))
        self.assertEqual(self.c.models[self.rid].get('heating_hours',0),0)
        self.assertEqual(self.c.models[self.rid].get('idle_hours',0),0)
        self.hass.services.async_call.assert_not_called()
        self.assertTrue(data['rooms'][self.rid]['heating_assistance']['assisting'])

    async def test_removing_zone_preference_restores_independent_control(self):
        await self.apply()
        self.room['heating_zone_id']=''
        self.c._plan_settings=deepcopy(self.c.settings)
        await self.apply(5)
        self.assertEqual(self.floor_target(),20)
        self.assertFalse(self.c.heating_assistance)
        self.assertNotIn('heating_assistance',self.c.data['rooms'][self.rid])
