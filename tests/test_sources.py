"""Provider contracts and full-path unit handling, without provider credentials."""
import ast
from copy import deepcopy
from datetime import timedelta
import json
from pathlib import Path
import types
import unittest
from unittest.mock import AsyncMock, Mock, patch
from zoneinfo import ZoneInfo

import test_coordinator
from test_coordinator import State, now
from thermal_pilot.const import DEFAULTS
from thermal_pilot.config import validate
from thermal_pilot.model import price_slots, stamp
from thermal_pilot.sources import (PriceSourceReader, nordpool_rows, tibber_rows,
    normalize_weather, temperature_celsius, forecast_temperature, check_sources)

FIXTURE = json.loads((Path(__file__).parent/'fixtures/sources/contracts.json').read_text())


class ContractTests(unittest.TestCase):
    def test_community_nordpool_and_native_responses_normalize_to_same_prices(self):
        config = {**DEFAULTS, 'price_entity': 'sensor.nordpool'}
        community = price_slots(FIXTURE['community_nordpool'], config, now, ZoneInfo('UTC'))
        official = price_slots({'raw_today': nordpool_rows(FIXTURE['nordpool'], 'FI', 0, 0)}, config, now, ZoneInfo('UTC'))
        tibber = price_slots({'raw_today': tibber_rows(FIXTURE['tibber'], 'Example home', 'EUR/kWh')}, config, now, ZoneInfo('UTC'))
        self.assertEqual(community, official)
        self.assertEqual(community, tibber)
        self.assertEqual([row.price for row in community[:4]], [-2] * 4)

    def test_native_spot_vat_margin_and_existing_sensor_costs_are_not_confused(self):
        result = nordpool_rows(FIXTURE['nordpool'], 'FI', 25.5, .5)
        self.assertAlmostEqual(result[1]['value'], 12 * 1.255 + .5)
        config = {**DEFAULTS, 'price_entity': 'sensor.final', 'nordpool_vat': 99, 'nordpool_margin': 99}
        slots = price_slots(FIXTURE['community_nordpool'], config, now, ZoneInfo('UTC'))
        self.assertEqual(slots[-1].price, 12)
        slots = price_slots({'today': [100]*24}, {**config, 'price_unit': '€/MWh'}, now, ZoneInfo('UTC'))
        self.assertEqual(slots[0].price, 10)

    def test_tibber_keeps_gaps_and_handles_quarter_hours_and_dst_offsets(self):
        response = {'prices': {'Home': [
            {'start_time': '2026-10-25T02:00:00+02:00', 'price': .1},
            {'start_time': '2026-10-25T02:15:00+02:00', 'price': .2},
            {'start_time': '2026-10-25T02:45:00+02:00', 'price': .3},
            {'start_time': '2026-10-25T02:00:00+01:00', 'price': .4},
        ]}}
        rows = tibber_rows(response, 'Home', '€/kWh')
        self.assertEqual((stamp(rows[1]['end'])-stamp(rows[1]['start'])).total_seconds(), 900)
        self.assertLess(stamp(rows[1]['end']), stamp(rows[2]['start']))
        self.assertEqual(len({row['start'] for row in rows}), 4)
        for unit in ('SEK/kWh', 'NOK/kWh', ''):
            with self.assertRaisesRegex(ValueError, 'EUR/kWh'):
                tibber_rows(response, 'Home', unit)
        self.assertEqual(tibber_rows({'prices': {'Home': response['prices']['Home'][:1]}}, 'Home', '€/kWh'), [])

    def test_weather_units_produce_identical_celsius_rows_and_no_invented_gaps(self):
        reference = normalize_weather(FIXTURE['weather_c'], 'hourly', '°C', now)
        for key, unit in [('weather_f','°F'), ('weather_k','K')]:
            self.assertEqual(normalize_weather(FIXTURE[key], 'hourly', unit, now), reference)
        self.assertEqual(forecast_temperature(reference, 'hourly', now+timedelta(hours=5), ZoneInfo('UTC'), 7), 7)
        self.assertEqual(normalize_weather([{'datetime':(now-timedelta(days=3)).isoformat(),'temperature':10}], 'hourly', '°C', now), [])
        self.assertEqual(normalize_weather([{'datetime':'invalid','temperature':float('nan')}], 'daily', '°C', now), [])
        with self.assertRaisesRegex(ValueError, 'Unsupported temperature'):
            temperature_celsius(20, 'unknown')

    def test_provider_settings_are_backward_compatible_and_can_be_saved_in_stages(self):
        for source in ('sensor.nordpool','static','nordpool','tibber'):
            saved=validate({**DEFAULTS,'price_entity':source}, require_outdoor=False)
            self.assertEqual(saved['price_entity'], source)
        with self.assertRaises(ValueError):
            validate({**DEFAULTS,'price_entity':'nordpool','nordpool_vat':101}, require_outdoor=False)


class ProviderReadTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await test_coordinator.CoordinatorTests.asyncSetUp(self)
        self.hass.services.has_service=lambda domain,service:True
        self.hass.config_entries=types.SimpleNamespace(async_entries=lambda domain:[
            types.SimpleNamespace(entry_id='np-entry',title='Nord Pool',data={'areas':['FI']})] if domain=='nordpool' else [])
        self.reader=PriceSourceReader(self.hass)

    async def asyncTearDown(self):
        self.temp.cleanup()

    async def test_official_nordpool_partial_availability_cache_and_rollover(self):
        self.hass.services.async_call=AsyncMock(side_effect=[FIXTURE['nordpool'],RuntimeError('Unpublished')])
        config={**DEFAULTS,'price_entity':'nordpool'}
        attrs, normalized, fetched=await self.reader.read(config,now)
        self.assertEqual(normalized['price_unit'],'c/kWh')
        self.assertEqual(len(attrs['raw_today']),2)
        self.assertEqual(self.hass.services.async_call.call_args_list[0].args[2]['currency'],'EUR')
        await self.reader.read(config,now+timedelta(minutes=2))
        self.assertEqual(self.hass.services.async_call.await_count,2)
        self.hass.services.async_call=AsyncMock(return_value=FIXTURE['nordpool'])
        await self.reader.read(config,now+timedelta(days=1))
        self.assertEqual(self.hass.services.async_call.await_count,2)

    async def test_tibber_uses_selected_sensor_home_and_rejects_wrong_currency(self):
        self.hass.states['sensor.tibber']=State('.12',{'app_nickname':'Example home','unit_of_measurement':'EUR/kWh'})
        self.hass.services.async_call=AsyncMock(return_value=FIXTURE['tibber'])
        config={**DEFAULTS,'price_entity':'tibber','tibber_price_entity':'sensor.tibber'}
        attrs,_,_=await self.reader.read(config,now)
        self.assertEqual(attrs['raw_today'][1]['value'],12)
        self.hass.states['sensor.tibber'].attributes['unit_of_measurement']='SEK/kWh'
        # Unit changes must invalidate even a still-fresh native cache.
        with self.assertRaisesRegex(ValueError,'EUR/kWh'):
            await self.reader.read(config,now)

    async def test_unit_conversion_reaches_plans_and_season_logic_not_only_charts(self):
        self.c.settings['weather_entity']='weather.home'
        self.hass.states['weather.home']=State('cloudy',{'temperature_unit':'°F'})
        self.hass.states['sensor.out'].attributes['unit_of_measurement']='°F'
        self.hass.states['sensor.out'].state='32'
        self.hass.services.async_call=AsyncMock(return_value={'weather.home':{'forecast':FIXTURE['weather_f']}})
        data=await self.c._async_update_data()
        self.assertEqual(data['outdoor'],0)
        first=next(iter(data['rooms'].values()))['plan']['slots'][0]
        self.assertEqual(first['outdoor'],0)
        self.assertEqual(self.c.forecast[1]['temperature'],-10)
        self.assertEqual(data['weather_forecast'][1]['temperature'],-10)
        self.hass.services.async_call.assert_awaited_once()

    async def test_source_check_is_read_only_and_does_not_expose_identifiers(self):
        self.hass.services.async_call=AsyncMock(return_value={'weather.home':{'forecast':FIXTURE['weather_c']}})
        config={**self.c.settings,'price_entity':'static','weather_entity':'weather.home'}
        before=deepcopy(self.c.settings)
        report=await check_sources(self.hass,self.reader,config,now)
        self.assertTrue(report['prices']['ok']);self.assertTrue(report['weather']['ok'])
        self.assertEqual(self.c.settings,before)
        encoded=json.dumps(report)
        for private in ('sensor.room','weather.home','np-entry','Example home'):
            self.assertNotIn(private,encoded)
        self.assertTrue(all(call.args[:2]==('weather','get_forecasts') for call in self.hass.services.async_call.call_args_list))

    async def test_missing_actions_and_ambiguous_areas_report_clear_errors(self):
        self.hass.services.has_service=lambda *args:False
        report=await self.reader.check({**DEFAULTS,'price_entity':'nordpool'},now)
        self.assertFalse(report['ok']);self.assertIn('action',report['error'])
        self.hass.services.has_service=lambda *args:True
        self.hass.config_entries.async_entries=lambda domain:[types.SimpleNamespace(entry_id='np',title='Nord Pool',data={'areas':['FI','SE3']})]
        report=await self.reader.check({**DEFAULTS,'price_entity':'nordpool'},now)
        self.assertIn('price area',report['error'])
        self.hass.services.async_call.assert_not_awaited()

    async def test_native_prices_are_used_at_live_control_checkpoints(self):
        from thermal_pilot.model import thermostat_timing
        self.c.settings.update(price_entity='nordpool',simulation_enabled=False,live_control_confirmed=True)
        rows=[{'start':now.isoformat(),'end':(now+timedelta(hours=1)).isoformat(),'heat':True}]
        timing=thermostat_timing(rows,{**DEFAULTS,'maximum':23},20,now)
        timing['slots']=rows
        self.c._plan_settings=deepcopy(self.c.settings)
        room_id=self.c.settings['rooms'][0]['id']
        self.c.data={'rooms':{room_id:{'plan':timing}}}
        async def services(domain,action,data,**kwargs):
            if domain=='nordpool':
                return FIXTURE['nordpool'] if data['date']=='2026-01-02' else {'FI':[]}
        self.hass.services.async_call=AsyncMock(side_effect=services)
        await self.c.update_command_state(now+timedelta(minutes=5))
        commands=[call for call in self.hass.services.async_call.call_args_list if call.args[:2]==('climate','set_temperature')]
        self.assertEqual(commands[-1].args[2]['temperature'],21.5)
        self.assertNotIn('Study',self.c.data['control']['fallback_rooms'])
        await self.c.update_command_state(now+timedelta(minutes=6))
        self.assertEqual(sum(call.args[0]=='nordpool' for call in self.hass.services.async_call.call_args_list),2)

    async def test_draft_endpoint_requires_admin_and_never_saves_or_applies_control(self):
        from thermal_pilot.config import SOURCE_FIELDS
        source=Path(__file__).parents[1]/'custom_components/thermal_pilot/__init__.py'
        handler=next(item for item in ast.parse(source.read_text()).body if isinstance(item,ast.AsyncFunctionDef) and item.name=='ws_test_sources')
        self.assertTrue(any(isinstance(item,ast.Attribute) and item.attr=='require_admin' for item in handler.decorator_list))
        handler.decorator_list=[]
        self.c.backup_lock=__import__('asyncio').Lock()
        checker=AsyncMock(return_value={'prices':{'ok':True},'weather':{'ok':True}})
        namespace={'get_coordinator':lambda *args:self.c,'SOURCE_FIELDS':SOURCE_FIELDS,'validate':validate,
                   'check_sources':checker,'dt_util':types.SimpleNamespace(utcnow=lambda:now)}
        exec(compile(ast.Module(body=[handler],type_ignores=[]),str(source),'exec'),namespace)
        connection=types.SimpleNamespace(send_result=Mock(),send_error=Mock())
        before=deepcopy(self.c.settings)
        await namespace['ws_test_sources'](self.hass,connection,{'id':1,'settings':{'price_entity':'static','static_price':8,'rooms':[{'invalid':'draft'}]}})
        checked=checker.call_args.args[2]
        self.assertEqual(checked['price_entity'],'static');self.assertEqual(checked['rooms'],[])
        self.assertEqual(self.c.settings,before)
        self.hass.services.async_call.assert_not_awaited()
        connection.send_result.assert_called_once()


    async def test_shared_heat_pump_sensor_units_use_celsius_for_limits(self):
        from thermal_pilot.air_control import zone_temperature
        room={'id':'garage','thermostat':'climate.room','temperature_entity':'sensor.room','is_garage':True,'garage_maximum':21}
        self.hass.states['sensor.room']=State('68',{'unit_of_measurement':'°F'})
        self.assertEqual(zone_temperature(self.hass,room,{**DEFAULTS,'rooms':[]}), (20,False))
        self.hass.states['sensor.room'].state='72'
        temperature,too_warm=zone_temperature(self.hass,room,{**DEFAULTS,'rooms':[]})
        self.assertAlmostEqual(temperature,22.22222222)
        self.assertTrue(too_warm)

    async def test_unknown_weather_units_are_an_actionable_read_only_error(self):
        self.hass.states['weather.home']=State('cloudy',{'temperature_unit':'unknown'})
        report=await check_sources(self.hass,self.reader,{**self.c.settings,'price_entity':'static','weather_entity':'weather.home'},now)
        self.assertEqual(report['weather']['error'],'Unsupported temperature unit.')
        self.hass.services.async_call.assert_not_awaited()

    async def test_native_price_sources_still_validate_an_enabled_forecast_sensor(self):
        settings={**self.c.settings,'price_entity':'nordpool','price_forecast_entity':'sensor.missing'}
        with self.assertRaisesRegex(ValueError,'was not found'):
            validate(settings,self.hass)
        settings['price_entity']='static'
        self.assertEqual(validate(settings,self.hass)['price_forecast_entity'],'sensor.missing')
