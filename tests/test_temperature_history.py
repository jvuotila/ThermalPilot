"""Verify HA entity links and recorder-visible aggregate zone temperatures."""
import ast
from pathlib import Path
import types
import unittest

ROOT=Path(__file__).resolve().parents[1]/'custom_components/thermal_pilot'

class TemperatureHistoryTests(unittest.TestCase):
    def setUp(self):
        class CoordinatorEntity:
            available=True
            def __init__(self,c):self.coordinator=c
        self.namespace={'CoordinatorEntity':CoordinatorEntity,'SensorEntity':type('SensorEntity',(),{}),
                        'SensorDeviceClass':types.SimpleNamespace(TEMPERATURE='temperature'),
                        'SensorStateClass':types.SimpleNamespace(MEASUREMENT='measurement'),'DOMAIN':'thermal_pilot'}
        tree=ast.parse((ROOT/'sensor.py').read_text());sensor=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='ZoneTemperatureSensor')
        exec(compile(ast.Module(body=[sensor],type_ignores=[]),'sensor.py','exec'),self.namespace)
    def test_aggregate_sensor_uses_current_selected_zone_value_and_stable_identity(self):
        value={'zone':19.45}
        coordinator=types.SimpleNamespace(entry=types.SimpleNamespace(entry_id='entry'),chart_temperatures=lambda:{'zones':value})
        sensor=self.namespace['ZoneTemperatureSensor'](coordinator,{'id':'zone','name':'Upstairs'})
        self.assertEqual(sensor._attr_unique_id,'entry_zone_zone_current_temperature')
        self.assertEqual(sensor.native_value,19.45);self.assertTrue(sensor.available)
        value['zone']=18.2;self.assertEqual(sensor.native_value,18.2)
        value['zone']=None;self.assertFalse(sensor.available)
        self.assertEqual(sensor._attr_device_class,'temperature');self.assertEqual(sensor._attr_state_class,'measurement')
    def test_history_links_use_original_room_main_sensor_and_registered_aggregate_sensor(self):
        rooms=[{'id':'room','temperature_entity':'sensor.room','heating_zone_id':'main'}]
        zones=[{'id':'main','temperature_policy':'main','main_room_id':'room'},
               {'id':'avg','temperature_policy':'average'},{'id':'cold','temperature_policy':'coldest'},
               {'id':'fire','source_type':'fireplace'}]
        registry=types.SimpleNamespace(async_get_entity_id=lambda domain,integration,unique_id:'sensor.'+unique_id)
        ns={'DOMAIN':'thermal_pilot','er':types.SimpleNamespace(async_get=lambda hass:registry)}
        tree=ast.parse((ROOT/'__init__.py').read_text());fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='chart_history_entities')
        exec(compile(ast.Module(body=[fn],type_ignores=[]),'__init__.py','exec'),ns)
        coordinator=types.SimpleNamespace(settings={'rooms':rooms,'heating_zones':zones},entry=types.SimpleNamespace(entry_id='entry'))
        result=ns['chart_history_entities'](None,coordinator)
        self.assertEqual(result['rooms'],{'room':'sensor.room'})
        self.assertEqual(result['zones'],{'main':'sensor.room','avg':'sensor.entry_zone_avg_current_temperature','cold':'sensor.entry_zone_cold_current_temperature'})
        registry.async_get_entity_id=lambda *args:None
        self.assertEqual(ns['chart_history_entities'](None,coordinator)['zones'],{'main':'sensor.room'})

    def test_retention_sensors_record_both_reference_metrics_and_missing_values(self):
        self.namespace['SensorDeviceClass'].DURATION='duration'
        tree=ast.parse((ROOT/'sensor.py').read_text());sensor=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='RetentionSensor')
        exec(compile(ast.Module(body=[sensor],type_ignores=[]),'sensor.py','exec'),self.namespace)
        coordinator=types.SimpleNamespace(entry=types.SimpleNamespace(entry_id='entry'),data={'rooms':{'room':{'heat_retention':{'drop_6h':1.23,'hours_per_degree':4.8}}}})
        for metric,unit,value in [('drop_6h','°C',1.23),('hours_per_degree','h',4.8)]:
            entity=self.namespace['RetentionSensor'](coordinator,{'id':'room','name':'Kitchen'},metric)
            self.assertEqual(entity._attr_unique_id,'entry_room_retention_'+metric)
            self.assertEqual(entity._attr_native_unit_of_measurement,unit)
            self.assertEqual(entity.native_value,value);self.assertTrue(entity.available)
            self.assertTrue(entity.extra_state_attributes['model_estimate'])
            coordinator.data['rooms']['room']['heat_retention'][metric]=None
            self.assertIsNone(entity.native_value);self.assertFalse(entity.available)

    def test_retention_links_resolve_registered_ids_and_omit_missing_entities(self):
        registry=types.SimpleNamespace(async_get_entity_id=lambda domain,integration,unique_id:'sensor.renamed' if unique_id.endswith('drop_6h') else None)
        ns={'DOMAIN':'thermal_pilot','er':types.SimpleNamespace(async_get=lambda hass:registry)}
        tree=ast.parse((ROOT/'__init__.py').read_text());fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='retention_history_entities')
        exec(compile(ast.Module(body=[fn],type_ignores=[]),'__init__.py','exec'),ns)
        coordinator=types.SimpleNamespace(settings={'rooms':[{'id':'room'}]},entry=types.SimpleNamespace(entry_id='entry'))
        self.assertEqual(ns['retention_history_entities'](None,coordinator),{'room':{'drop_6h':'sensor.renamed'}})
