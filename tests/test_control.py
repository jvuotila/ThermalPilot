"""Thermostat reconciliation tests with service doubles."""
import asyncio
import unittest,types,sys
from pathlib import Path
from unittest.mock import AsyncMock
ROOT=Path(__file__).resolve().parents[1]/'custom_components/thermal_pilot'
pkg=types.ModuleType('thermal_pilot');pkg.__path__=[str(ROOT)];sys.modules.setdefault('thermal_pilot',pkg)
from thermal_pilot.control import ThermostatControl

class ControlTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.room={'id':'r','name':'Room','thermostat':'climate.r'}
        self.state=types.SimpleNamespace(state='heat',attributes={'temperature':20,'min_temp':5,'max_temp':30,'target_temp_step':0.5})
        self.hass=types.SimpleNamespace(states={'climate.r':self.state},services=types.SimpleNamespace(async_call=AsyncMock()))
        self.control=ThermostatControl(self.hass)

    async def test_write_rounding_acknowledgement_and_retry(self):
        await self.control.apply([self.room],{'r':21.2},0,lambda:True)
        self.assertEqual(self.hass.services.async_call.call_args.args[2]['temperature'],21)
        await self.control.apply([self.room],{'r':21.2},30,lambda:True)
        self.assertEqual(self.hass.services.async_call.await_count,1)
        await self.control.apply([self.room],{'r':21.2},60,lambda:True)
        self.assertEqual(self.hass.services.async_call.await_count,2)
        self.state.attributes['temperature']=21
        await self.control.apply([self.room],{'r':21.2},120,lambda:True)
        self.assertEqual(self.hass.services.async_call.await_count,2)

    async def test_cancel_pending_boost_even_when_state_still_matches_fallback(self):
        await self.control.apply([self.room],{'r':22},0,lambda:True)
        # Hardware has not acknowledged the boost: reported target is still 20.
        await self.control.apply([self.room],{'r':20},1,lambda:True)
        self.assertEqual(self.hass.services.async_call.await_count,2)
        self.assertEqual(self.hass.services.async_call.call_args.args[2]['temperature'],20)

    async def test_disabled_unavailable_bounds_and_failures(self):
        await self.control.apply([self.room],{'r':22},0,lambda:False)
        self.hass.services.async_call.assert_not_awaited()
        self.state.state='unavailable'
        self.assertTrue(await self.control.apply([self.room],{'r':22},0,lambda:True))
        self.state.state='heat'
        self.assertTrue(await self.control.apply([self.room],{'r':40},0,lambda:True))
        self.hass.services.async_call.side_effect=RuntimeError('offline')
        self.assertTrue(await self.control.apply([self.room],{'r':22},0,lambda:True))
        self.assertTrue(await self.control.apply([self.room],{'r':22},1,lambda:True))
        self.assertEqual(self.hass.services.async_call.await_count,2)

    async def test_device_step_rounding_cannot_lower_idle_target_below_minimum(self):
        room={**self.room,'control_minimum':19.2,'control_maximum':23.2}
        await self.control.apply([room],{'r':19.2},0,lambda:True)
        self.assertEqual(self.hass.services.async_call.call_args.args[2]['temperature'],19.5)
        await self.control.apply([room],{'r':23.2},1,lambda:True)
        self.assertEqual(self.hass.services.async_call.call_args.args[2]['temperature'],23)
        room.update(control_minimum=19.2,control_maximum=19.3)
        self.assertTrue(await self.control.apply([room],{'r':19.2},2,lambda:True))
        self.assertEqual(self.hass.services.async_call.await_count,2)

    async def test_service_cancellation_propagates_without_recording_a_write(self):
        self.hass.services.async_call.side_effect = asyncio.CancelledError

        with self.assertRaises(asyncio.CancelledError):
            await self.control.apply([self.room], {'r': 22}, 0, lambda: True)

        self.assertEqual(self.control.pending, {})
        self.assertEqual(self.control.results, {})
        self.assertEqual(self.control.reconciled, set())

    async def test_failed_room_does_not_prevent_other_rooms_from_receiving_targets(self):
        second_room = {**self.room, 'id': 'second', 'name': 'Second', 'thermostat': 'climate.second'}
        self.hass.states['climate.second'] = self.state
        self.hass.services.async_call.side_effect = [RuntimeError('offline'), None]

        errors = await self.control.apply(
            [self.room, second_room], {'r': 22, 'second': 21}, 0, lambda: True
        )

        self.assertEqual(len(errors), 1)
        self.assertIn('Room: setting thermostat temperature failed', errors[0])
        self.assertEqual(self.control.results, {'second': 21})
        self.assertNotIn('climate.r', self.control.pending)
        self.assertEqual(self.control.pending['climate.second']['target'], 21)


class ActivationTests(unittest.TestCase):
    def test_explicit_consent_and_legacy_preference(self):
        from thermal_pilot.config import confirm_control_settings
        with self.assertRaises(ValueError):
            confirm_control_settings({'simulation_enabled':False,'live_control_confirmed':True},{'simulation_enabled':False})
        accepted=confirm_control_settings({'simulation_enabled':False},{'simulation_enabled':True},True)
        self.assertTrue(accepted['live_control_confirmed'])
        self.assertTrue(confirm_control_settings({'simulation_enabled':False},accepted)['live_control_confirmed'])
        self.assertFalse(confirm_control_settings({'simulation_enabled':True},accepted)['live_control_confirmed'])


class FallbackSeasonTests(unittest.TestCase):
    def test_cold_readings_override_calendar_and_warm_daily_evidence_works_year_round(self):
        from thermal_pilot.model import fallback_season
        from datetime import datetime,timezone
        from zoneinfo import ZoneInfo
        zone=ZoneInfo('Europe/Helsinki')
        for month,day in [(5,15),(7,1),(9,30)]:
            result=fallback_season({},[],None,-10,datetime(2026,month,day,12,tzinfo=zone),zone)
            self.assertFalse(result['summer'])
        for month,day in [(5,14),(10,1),(1,2)]:
            now=datetime(2026,month,day,12,tzinfo=zone)
            forecast=[{'datetime':now.isoformat(),'temperature':12,'templow':7}]
            self.assertTrue(fallback_season({},forecast,'daily',8,now,zone)['summer'])
            self.assertFalse(fallback_season({},forecast,'daily',8,now,zone,8)['summer'])
            forecast[0]['templow']=6
            self.assertTrue(fallback_season({},forecast,'daily',8,now,zone)['summer'])
            forecast[0]['templow']=7
            self.assertFalse(fallback_season({},forecast,'daily',5,now,zone)['summer'])
            self.assertFalse(fallback_season({},[],None,None,now,zone)['summer'])

    def test_location_prior_respects_hemisphere_and_needs_warm_current_reading(self):
        from thermal_pilot.model import fallback_season
        from datetime import datetime,timezone
        for latitude,summer_month,winter_month in [(60.9,7,1),(52.5,7,1),(-33.9,1,7)]:
            for month,expected in [(summer_month,True),(winter_month,False)]:
                now=datetime(2026,month,15,12,tzinfo=timezone.utc)
                result=fallback_season({},[],None,12,now,timezone.utc,latitude=latitude)
                self.assertEqual(result['summer'],expected,(latitude,month))
                self.assertEqual(result['basis'],'location_estimate' if expected else 'insufficient_evidence')
                self.assertFalse(fallback_season({},[],None,4,now,timezone.utc,latitude=latitude)['summer'])
                self.assertFalse(fallback_season({},[],None,None,now,timezone.utc,latitude=latitude)['summer'])
                cold=[{'datetime':now.isoformat(),'temperature':15,'templow':2}]
                self.assertFalse(fallback_season({},cold,'daily',12,now,timezone.utc,latitude=latitude)['summer'])

    def test_tropics_unknown_location_and_daily_high_without_low(self):
        from thermal_pilot.model import fallback_season
        from datetime import datetime,timezone
        now=datetime(2026,7,1,12,tzinfo=timezone.utc)
        for latitude in (None,0,1,-1,20,-20,91,float('nan')):
            self.assertFalse(fallback_season({},[],None,12,now,timezone.utc,latitude=latitude)['summer'])
            warm=[{'datetime':now.isoformat(),'temperature':20,'templow':10}]
            self.assertTrue(fallback_season({},warm,'daily',12,now,timezone.utc,latitude=latitude)['summer'])
        high_only=[{'datetime':now.isoformat(),'temperature':20}]
        self.assertFalse(fallback_season({},high_only,'daily',12,now,timezone.utc)['complete'])

    def test_warm_spring_and_cold_summer_follow_local_forecast_in_both_hemispheres(self):
        from thermal_pilot.model import fallback_season
        from datetime import datetime,timezone
        for latitude,month in ((60.9,4),(52.5,4),(-33.9,10)):
            now=datetime(2026,month,15,12,tzinfo=timezone.utc)
            warm=[{'datetime':now.isoformat(),'temperature':18,'templow':8}]
            result=fallback_season({},warm,'daily',12,now,timezone.utc,latitude=latitude)
            self.assertTrue(result['summer']);self.assertEqual(result['basis'],'daily_temperature')
        # A saved former calendar decision is recomputed from current evidence.
        july=datetime(2026,7,1,12,tzinfo=timezone.utc)
        self.assertFalse(fallback_season({'summer':True},[],None,2,july,timezone.utc,latitude=60.9)['summer'])

    def test_full_hourly_day_is_retained_but_partial_or_gapped_day_is_not_enough(self):
        from thermal_pilot.model import fallback_season
        from datetime import datetime,timedelta
        from zoneinfo import ZoneInfo
        zone=ZoneInfo('Europe/Helsinki');now=datetime(2026,10,11,12,tzinfo=zone)
        midnight=now.replace(hour=0)
        rows=[{'datetime':(midnight+timedelta(hours=h)).isoformat(),'temperature':8} for h in range(24)]
        self.assertFalse(fallback_season({},rows[12:],'hourly',8,now,zone)['summer'])
        self.assertFalse(fallback_season({},[rows[0],rows[-1]],'hourly',8,now,zone)['summer'])
        full=fallback_season({},rows,'hourly',8,now,zone)
        self.assertTrue(full['summer'])
        self.assertTrue(fallback_season(full,rows[12:],'hourly',8,now,zone)['summer'])
        self.assertFalse(fallback_season(full,rows[12:],'hourly',4,now,zone)['summer'])
