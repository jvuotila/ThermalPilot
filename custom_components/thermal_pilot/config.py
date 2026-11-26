"""Shared settings metadata and server-side validation."""
from copy import deepcopy
from hashlib import sha256
import json
from uuid import UUID, uuid4
from .const import DEFAULTS, ROOM_DEFAULTS, ZONE_DEFAULTS, FIREPLACE_DEFAULTS, AIR_INITIAL_LAG_HOURS, WATER_REFERENCE
from .model import number, tariff_minutes
from .fireplaces import migrate_fireplaces
from .sources import PRICE_SOURCE_CHOICES
from .shared_air import room_connections, room_groups

# key, label, input type, bounds/domain; used by the dedicated settings panel.
SOURCE_FIELDS = [
 ('away_temperature','Away heating temperature (°C)','number',5,25,.5),
 ('away_cooling_temperature','Away cooling temperature (°C)','number',18,35,.5),
 ('away_automatic','Automatic away detection','bool'),
 ('away_zone','Home presence zone','zone'),
 ('away_delay_hours','Absence delay (hours)','number',0,168,.5),
 ('air_fan_cool','Cooling fan speed','text'),
 ('air_swing_cool','Cooling swing mode','text'),
 ('air_use_fan_only', 'Use Fan only between heating runs', 'bool'),
 ('air_minimum', 'Minimum allowed temperature (°C)', 'number', 5, 30, .1),
 ('air_maximum', 'Maximum allowed temperature (°C)', 'number', 5, 35, .1),
 ('air_boost', 'Heating setpoint boost (°C)', 'number', 0, 5, .1),
 ('air_setback', 'Peak-hour reduction (°C)', 'number', -5, 0, .1),
 ('air_heat_target','Heat pump heating setpoint (°C)','number',5,35,.5),
 ('air_fan_heat','Heating fan speed','text'),
 ('air_fan_idle','Standby fan speed','text'),
 ('air_swing','Heating swing mode','text'),
 ('air_swing_idle','Standby swing mode','text'),
 (
     'house_construction',
     'House construction',
     'select:unknown,wooden_detached,masonry_detached,concrete_apartment,heavy_masonry_apartment'
 ),
 (
     'house_heat_source',
     'Heat source',
     'select:air_to_water,ground_source,air_to_air,electric_resistance,oil_boiler,gas_boiler,wood_boiler,pellet_boiler,district_heating,other'
 ),
 (
     'house_distribution',
     'Heat distribution',
     'select:water_floor,water_radiators,electric_floor,electric_ceiling,electric_panels,warm_air,mixed,other'
 ),
 (
     'house_heated_floor',
     'Heated floor',
     'select:concrete_slab,thin_screed,lightweight,not_applicable,unknown'
 ),
 ('house_foundation','Foundation','select:slab_on_ground,crawl_space,basement,other,unknown'),
 ('price_entity','Price sensor','sensor',{'kind':'price'}),
 ('static_price','Static price (c/kWh)','number',-1000,10000,.01),
 ('nordpool_entry','Nord Pool integration','text'),
 ('nordpool_area','Price area','text'),
 ('nordpool_vat','VAT (%)','number',0,100,.1),
 ('nordpool_margin','Retailer margin including VAT (c/kWh)','number',-1000,10000,.01),
 ('tibber_price_entity','Tibber price sensor','sensor',{'kind':'tibber_price'}),
 ('price_forecast_entity','Price forecast (optional)','sensor',{'kind':'price_forecast'}),
 ('price_unit','Source price unit','select:c/kWh,€/kWh,€/MWh'),
 ('transfer_tariff','Transfer tariff','select:included,fixed,day_night'),
 ('transfer_fixed_price','Transfer price (c/kWh)','number',0,10000,.01),
 ('transfer_day_start','Day starts','time'),
 ('transfer_day_price','Day transfer price (c/kWh)','number',0,10000,.01),
 ('transfer_night_start','Night starts','time'),
 ('transfer_night_price','Night transfer price (c/kWh)','number',0,10000,.01),
 ('pricing_mode','Scheduling mode','select:hourly,quarterly,flexible'),
 ('minimum_run_minutes','Minimum flexible heating run (minutes)','number',15,360,15),
 ('price_flex_threshold', 'Expensive electricity threshold (c/kWh)', 'number', -1000, 10000, .01),
 ('price_flex_reduction', 'Allowed temperature flexibility (°C)', 'number', -5.0, -.1, .1),
 ('solar_power_entity','Solar production power sensor','sensor',{'kind':'power'}),
 ('solar_start_kw','Start solar heating above (kW)','number',0.1,1000,0.1),
 ('solar_stop_kw','Stop solar heating below (kW)','number',0,1000,0.1),
 ('solar_minimum_run_minutes','Minimum solar heating session (minutes)','number',15,360,15),
 ('weather_entity','Weather forecast source','weather'),
 ('outdoor_entity','Outdoor temperature','sensor',{'kind':'temperature'}),
 ('wind_entity','Wind speed (optional)','sensor',{'kind':'wind'}),
 ('water_entity','Heating water (optional)','sensor,climate',{'kind':'water'}),
 ('heat_pump_cop_entity', 'Heat pump COP sensor (optional)', 'sensor', {}),
 (
     'fireplace_entity',
     'Fireplace activity sensor (optional)',
     'sensor,binary_sensor',
     {'kind':'activity'}
 ),
 ('fireplace_active_state','Fireplace active when','text'),
 ('simulation_enabled','Enable simulation','bool'),
 (
     'language',
     'Language',
     'select:en,fi,sv,nb,da,de,pt,es,fr,et,lv,lt,pl,it,nl,is,ro,cs,sk,bg,sr,hr,el,sq,hu'
 ),
 ('summer_minimum_temperature','Summer temperature (°C)','number',-20,25,0.1),
 ('summer_setpoint','Shared summer thermostat setpoint (°C)','number',5,25),
 ('minimum','Minimum allowed temperature (°C)','number',5,30,0.1),
 ('maximum','Maximum allowed temperature (°C)','number',5,35,0.1),
 ('boost','Heating setpoint boost (°C)','number',0,5),
 ('setback','Peak-hour reduction (°C)','number',-5,0,0.1),
 ('start_offset_minutes','Raise thermostat before heating starts (minutes)','number',0,30),
 ('stop_offset_minutes','Lower thermostat before heating stops (minutes)','number',0,30),
 ('lag_hours','Estimated thermal response lag (hours)','number',.25,12),
 ('curve_warm_temp','Warm outdoor endpoint (°C)','number',-40,25),
 ('curve_cold_temp','Cold outdoor endpoint (°C)','number',-40,25),
 ('apply_season_setpoints','Apply season setpoints','bool'),
 ('heating_enabled','ThermalPilot active','bool'),
 ('sensor_warning_hours','Sensor warning delay (hours)','number',1,72,1),
 ('manual_notification_target','Push notification device (optional)','notification'),
]
ROOM_FIELDS = [
 ('name', 'Room name', 'text'),
 ('thermostat', 'Thermostat', 'climate'),
 ('temperature_entity', 'Room temperature sensor', 'sensor', {'kind': 'temperature'}),
 ('activity_entity', 'Thermostat relay (optional)', 'switch', {'kind': 'relay'}),
 ('heating_zone_id', 'Zone (optional)', 'text'),
 ('heat_control', 'Room heating control', 'select:house,air_to_air'),
 ('baseline', 'Target temperature (°C)', 'number', 5, 30, 0.1),
 ('allow_price_flex', 'Allow temperature flexibility during expensive hours', 'bool'),
 ('heating_priority', 'Heating priority', 'select:independent,heat_pump_preferred'),
 ('assist_below_target', 'Allow floor assistance below target by (°C)', 'number', 0.1, 3, 0.1),
 ('away_exempt', 'Keep normal temperature during absences', 'bool'),
 ('shared_air_rooms', 'Shared air space', 'room_links'),
 (
     'garage_construction',
     'Construction type',
     'select:unknown,timber_frame,masonry,lightweight_metal'
 ),
 ('garage_heat_source', 'Heat source', 'select:house,air_to_air'),
 ('garage_strategy', 'Heating strategy', 'select:temperature,tariff'),
 ('garage_minimum', 'Lower temperature limit (°C)', 'number', -5, 25, 0.1),
 ('garage_maximum', 'Upper temperature limit (°C)', 'number', -5, 30, 0.1),
 ('garage_use_fan_only', 'Use Fan only between heating runs', 'bool'),
 ('garage_heat_target', 'Heat pump heating setpoint (°C)', 'number', 5, 35, 0.5),
 ('garage_fan_heat', 'Heating fan speed', 'text'),
 ('garage_swing', 'Heating swing mode', 'text'),
 ('garage_fan_idle', 'Standby fan speed', 'text'),
 ('garage_swing_idle', 'Standby swing mode', 'text'),
 ('garage_fan_presence', 'Fan mode when occupied', 'text'),
 ('garage_door_delay', 'Pause heating after door opens (seconds)', 'number', 0, 600, 1),
 ('garage_door_entities', 'Door sensors (optional)', 'entities:binary_sensor'),
 ('garage_door_warning_minutes', 'Door-open warning delay (minutes)', 'number', 1, 1440, 1),
 ('garage_presence_entities', 'Presence sensors (optional)', 'entities:binary_sensor'),
 ('fireplace_reduction', 'Fireplace heating compensation', 'number', -100, 0, 1),
 (
     'solar_direction',
     'Window direction',
     'select:disabled,north,northeast,east,southeast,south,southwest,west,northwest'
 ),
 ('solar_exposure', 'Sun exposure', 'select:clear,partly_shaded,mostly_shaded'),
 ('is_garage', 'Garage', 'bool'),
]


ZONE_FIELDS = [
 ('name', 'Zone name', 'text'),
 ('source_type', 'Zone source', 'select:air_to_air,fireplace'),
 ('thermostat', 'Zone heat pump', 'climate'),
 ('temperature_policy', 'Zone temperature', 'select:main,average,coldest'),
 (
     'fireplace_entity',
     'Zone fireplace sensor (optional)',
     'sensor,binary_sensor',
     {'kind': 'activity'}
 ),
 ('fireplace_active_state', 'Fireplace active when', 'text'),
 ('main_room_id', 'Main room', 'text'),
 ('heating_enabled', 'Control zone heat pump', 'bool'),
 ('climate_mode', 'Heat pump use', 'select:heat,cool,both'),
 ('heating_strategy','Zone heating strategy','select:temperature,tariff'),
 ('cooling_target', 'Cooling target temperature (°C)', 'number', 16, 30, 0.1),
]


FIREPLACE_FIELDS = [
    ('name', 'Fireplace name', 'text'),
    ('surface_temperature_entity', 'Fireplace surface temperature sensor', 'sensor', {'kind': 'temperature'}),
    ('fireplace_entity', 'Fireplace activity sensor', 'sensor,binary_sensor', {'kind': 'activity'}),
    ('fireplace_active_state', 'Fireplace active when', 'text'),
]


def entity_matches(state, rule, settings=None):
    """Filter choices by semantic metadata, including unit-only template sensors."""
    attrs = state.attributes
    domain = state.entity_id.split('.')[0]
    kind = rule.get('kind')
    device_class = attrs.get('device_class')
    unit = str(attrs.get('unit_of_measurement') or '').strip().lower()
    temperature = device_class == 'temperature' or (not device_class and unit in ('°c', '°f', 'c', 'f', 'k', '°k'))
    if kind == 'relay':
        return domain == 'switch'
    if kind == 'water':
        return domain == 'climate' and 'current_temperature' in attrs or (domain == 'sensor' and temperature)
    if kind == 'temperature':
        return temperature
    if kind == 'wind':
        return domain == 'sensor' and unit in ('m/s', 'km/h', 'mph', 'kn', 'knots')
    if kind == 'power':
        return device_class == 'power' or (not device_class and unit in ('w', 'kw'))
    if kind == 'price_forecast':
        return domain == 'sensor' and isinstance(attrs.get('forecast'), (list, tuple))
    if kind == 'tibber_price':
        return isinstance(attrs.get('app_nickname'), str) and str(attrs.get('unit_of_measurement', '')).lower() in ('eur/kwh', '€/kwh')
    if kind == 'price':
        return any((isinstance(attrs.get(key), (list, tuple)) for key in ('today', 'tomorrow', 'raw_today', 'raw_tomorrow')))
    if kind == 'target':
        return temperature or (domain in ('number', 'input_number') and (not device_class) and (not unit))
    if kind == 'activity':
        if domain in ('binary_sensor', 'switch'):
            return True
        if domain != 'sensor':
            return False
        attribute = (settings or {}).get('activity_attribute')
        if attribute and attribute in attrs:
            return True
        if device_class not in (None, '', 'enum') or unit:
            return False
        # Unitless discrete states are suitable for configurable active-value matching.
        value = str(state.state).strip().lower()
        return device_class == 'enum' or value in ('0', '1') or (number(value) is None and value not in ('unknown', 'unavailable', '')) or ('hvac_action' in attrs)
    return True


def setup_selector_config(hass, key):
    """Use the same source rules in Home Assistant's native initial setup form."""
    field = next((field for field in SOURCE_FIELDS if field[0] == key))
    rule = field[3]
    domains = field[2].split(',')
    return {'filter': {'domain': domains[0] if len(domains)==1 else domains}, 'exclude_entities': [
        state.entity_id for domain in domains for state in hass.states.async_all(domain)
        if not entity_matches(state, rule)]}


def room_heat_source(room, settings):
    """A garage has its own source; existing garages retain their heat pump."""
    if room.get('is_garage'):
        source = room.get('garage_heat_source', 'air_to_air')
        if source != 'house':
            return source
        return settings.get('house_heat_source', 'air_to_water')
    if room.get('heat_control') == 'air_to_air':
        return 'air_to_air'
    return settings.get('house_heat_source', 'air_to_water')


def electric_heating(settings):
    electric_sources = ('air_to_water', 'ground_source', 'air_to_air', 'electric_resistance')
    if settings.get('house_heat_source', 'air_to_water') in electric_sources:
        return True
    zones = settings.get('heating_zones')
    if not isinstance(zones, list):
        zones = []
    rooms = settings.get('rooms')
    if not isinstance(rooms, list):
        rooms = []
    if any(zone.get('source_type', 'air_to_air') == 'air_to_air'
           for zone in zones if isinstance(zone, dict)):
        return True
    return any(room_electric(room, settings) for room in rooms if isinstance(room, dict))


def room_electric(room, settings):
    return room.get('heat_control') == 'zone_member' or room_heat_source(room, settings) in (
        'air_to_water', 'ground_source', 'air_to_air', 'electric_resistance')


def garage_thermostat(room):
    return room.get('is_garage', False) and room.get('garage_heat_source', 'air_to_air') != 'air_to_air'


def room_water_distribution(room, settings):
    return (not air_room(room, settings) and room.get('heat_control') != 'zone_member'
            and water_distribution(settings))


def price_required(settings):
    for room in resolved_rooms(settings) + zone_rooms(settings):
        # Capacity-based floor assistance needs temperature evidence, not a
        # tariff. Its pump zone may still require prices for its own scheduling.
        if preferred_zone(room, settings):
            continue
        if not room_electric(room, settings) or room.get('heat_control') == 'zone_member':
            continue
        if room.get('zone_climate_mode') == 'cool':
            continue
        if room.get('zone_heating_strategy', 'tariff') != 'tariff':
            continue
        if room.get('is_garage') and room.get('garage_strategy', 'temperature') != 'tariff':
            continue
        return True
    return not settings.get('rooms') and settings.get('house_heat_source', 'air_to_water') in (
        'air_to_water', 'ground_source', 'air_to_air', 'electric_resistance')


def garage_sensor_lists(room):
    """Migrate the original single/two-sensor fields without losing selections."""
    result = deepcopy(room)
    # Older garages had only air-to-air control. New forms explicitly send
    # 'house'; a missing choice must never silently change an existing device.
    if result.get('is_garage'):
        result.setdefault('garage_heat_source', 'air_to_air')
    for plural,legacy in [
        ('garage_door_entities',('garage_door_entity','garage_door_entity_2')),
        ('garage_presence_entities',('garage_presence_entity','garage_presence_entity_2'))
    ]:
        values = result.get(plural, [])
        if isinstance(values, list):
            values = list(values)
            for key in legacy:
                value = result.pop(key, None)
                if value and value not in values:
                    values.append(value)
            result[plural] = values
    result.pop('garage_guard_entity',None)
    result.pop('garage_manual_entity',None)
    result.pop('garage_manual_target_entity',None)
    return result


def resolved_rooms(settings):
    """Keep separate primary heaters; a zone owns its shared physical pump."""
    zones = {z['id']: z for z in settings.get('heating_zones', []) if isinstance(z, dict) and 'id' in z}
    rooms = []
    for original in settings.get('rooms',[]):
        if not isinstance(original, dict):
            continue
        room = garage_sensor_lists(original)
        # Resolve inheritance on this runtime copy, retaining 'house' in storage.
        if room.get('is_garage'):
            room['garage_heat_source'] = room_heat_source(room, settings)
        zone = zones.get(room.get('heating_zone_id'))
        if zone:
            if zone.get('source_type', 'air_to_air') == 'air_to_air':
                if room['thermostat'] == zone.get('thermostat') and not room.get('is_garage'):
                    # This sensor belongs to the zone's pump, not another heater.
                    # Only the virtual zone controller may issue device commands.
                    room['heat_control'] = 'zone_member'
                else:
                    room['secondary_pump_entity'] = zone.get('thermostat', '')
        rooms.append(room)
    by_id = {room['id']: room for room in rooms}
    eligible = [room for room in rooms if not room.get('is_garage') and not air_room(room, settings) and room.get('heat_control') != 'zone_member']
    connections = room_connections(eligible)
    for room in eligible:
        room['shared_air_rooms'] = connections[room['id']]
    for group in room_groups(eligible):
        # Sensor/controller changes invalidate transfer fits and observation
        # continuity, while preserving each circuit's existing learned model.
        signature = [
            [settings.get(key) for key in ('lag_hours', 'outdoor_entity', 'water_entity',
                                          'wind_entity', 'house_distribution')],
            [[key, by_id[key]['thermostat'], by_id[key]['temperature_entity'],
              by_id[key].get('activity_entity', '')] for key in group],
        ]
        # Existing fully connected groups keep their valid fits. A network with
        # fewer direct edges must invalidate fits that assumed all-to-all transfer.
        if any(len(connections[key]) != len(group) - 1 for key in group):
            signature.append(['direct_links', [[key, connections[key]] for key in group]])
        # A compact stable signature avoids copying every linked sensor mapping
        # into every stored observation and saved temperature forecast.
        signature = sha256(json.dumps(signature, separators=(',', ':')).encode()).hexdigest()
        for room_id in group:
            by_id[room_id]['shared_air_signature'] = signature
    return rooms


def zone_rooms(settings):
    """Independent virtual controllers for secondary zone pumps and their sensors."""
    result = []
    for zone in settings.get('heating_zones',[]):
        if zone.get('source_type', 'air_to_air') != 'air_to_air':
            continue
        members = [r for r in settings.get('rooms', []) if r.get('heating_zone_id') == zone['id'] and (not r.get('is_garage'))]
        main = next((room for room in members if room['id'] == zone.get('main_room_id')), None)
        if main is None:
            continue
        for original in [main]+[r for r in members if r is not main]:
            room = garage_sensor_lists(original)
            room.update(id='zone:'+zone['id'] if original is main else 'zone:'+zone['id']+':'+original['id'],
                        source_room_id=original['id'],name=zone.get('name',''),thermostat=zone.get('thermostat',''),activity_entity='',
                        heat_control='air_to_air' if original is main else 'zone_member',secondary_zone=True,
                        zone_policy=zone.get('temperature_policy','main'),zone_control_enabled=zone.get('heating_enabled',True),
                        zone_climate_mode=zone.get('climate_mode','heat'),zone_cooling_target=zone.get('cooling_target',24),
                        zone_heating_strategy=zone.get('heating_strategy','tariff'),
                        fireplace_ids=zone.get('fireplace_ids', []),
                        fireplace_circulation=zone.get('fireplace_circulation', False),
                        fireplace_fan=zone.get('fireplace_fan', ''),
                        fireplace_swing=zone.get('fireplace_swing', ''))
            result.append(room)
    return result


def air_room(room, settings):
    return room.get('heat_control') != 'zone_member' and room_heat_source(room, settings) == 'air_to_air'


def pump_uses_setpoints(room, settings):
    if not air_room(room, settings):
        return False
    if room.get('is_garage'):
        return not room.get('garage_use_fan_only', True)
    return not settings.get('air_use_fan_only', True)



def pump_temperature_settings(settings):
    """Use house values until independent pump values are saved."""
    limits = {}
    for key in ('minimum', 'maximum', 'boost', 'setback'):
        value = settings.get('air_' + key)
        limits[key] = settings[key] if value is None else value
    return limits


def preferred_zone(room: dict, settings: dict) -> dict | None:
    """Return an enabled heating zone without replacing the floor controller.

    Retain inactive preferences when users unlink a zone or change systems.
    They must always fall back to independent floor control, not block saving.
    """
    if (room.get('heating_priority') != 'heat_pump_preferred' or room.get('is_garage')
            or room.get('secondary_zone') or room.get('heat_control', 'house') != 'house'
            or settings['house_heat_source'] != 'electric_resistance'
            or settings['house_distribution'] != 'electric_floor'):
        return None
    for zone in settings.get('heating_zones', []):
        if (zone['id'] == room.get('heating_zone_id') and zone.get('source_type', 'air_to_air') == 'air_to_air'
                and zone.get('heating_enabled', True) and zone.get('climate_mode', 'heat') in ('heat', 'both')):
            return zone
    return None


def room_settings(room, settings):
    effective = {
        **room,
        'house_construction': settings.get('house_construction', 'unknown'),
        **{key: settings[key] for key in (
            'lag_hours',
            'curve_warm_temp',
            'curve_cold_temp',
            'boost',
            'setback',
            'minimum',
            'maximum'
        )}
    }
    if air_room(room, settings) or room.get('heat_control') == 'zone_member':
        effective['lag_hours'] = AIR_INITIAL_LAG_HOURS
        effective['air_control'] = True
    if not room.get('is_garage') and pump_uses_setpoints(room, settings):
        effective.update(pump_temperature_settings(settings))
        effective['baseline'] = max(effective['minimum'], min(effective['maximum'], room['baseline']))
    if room.get('is_garage'):
        effective.update(
            minimum=room['garage_minimum'],
            maximum=room['garage_maximum'],
            baseline=room['garage_minimum'],
            boost=room['garage_maximum']-room['garage_minimum'],
            setback=0
        )
    if (room.get('allow_price_flex') and not room.get('is_garage') and not room.get('secondary_zone')
            and room.get('heat_control') != 'zone_member' and room_electric(room, settings)
            and not preferred_zone(room, settings)
            and settings.get('price_entity') not in (None, '', 'static')):
        effective['price_flex_enabled'] = True
        effective['price_flex_threshold'] = settings['price_flex_threshold']
        effective['price_flex_reduction'] = settings['price_flex_reduction']
    return effective



def learning_fingerprint(room, settings):
    effective = room_settings(room, settings)
    effective['water_reference'] = WATER_REFERENCE
    room_water = room_water_distribution(room, settings)
    fingerprint = [effective[k] for k in (
        'thermostat',
        'temperature_entity',
        'activity_entity',
        'lag_hours',
        'curve_max_hours',
        'curve_min_hours',
        'curve_cold_temp',
        'curve_warm_temp',
        'baseline',
        'water_reference'
    )] + [settings['outdoor_entity'], settings['water_entity'] if room_water else '']
    if pump_uses_setpoints(room, settings):
        fingerprint.append('pump_setpoints')
    if effective.get('air_control'):
        fingerprint += [
            'air_to_air',
            room.get('heating_zone_id', '') if room.get('secondary_zone') else ''
        ]
    elif settings['house_distribution'] != 'water_floor':
        fingerprint += [settings['house_distribution']]
    if room.get('is_garage'):
        fingerprint += [room.get('garage_heat_source', 'air_to_air')]
    if effective.get('shared_air_signature'):
        fingerprint += ['shared_air', effective['shared_air_signature']]
    return fingerprint


def water_distribution(settings):
    return settings.get('house_distribution', 'water_floor') not in ('electric_floor', 'electric_ceiling', 'electric_panels', 'warm_air')


def stored_settings(data, options):
    """Convert legacy positive reductions when loading stored entries."""
    merged = {**DEFAULTS, **data, **options}
    settings = deepcopy({key: merged[key] for key in DEFAULTS})
    setback = number(settings['setback'])
    if setback is not None and setback > 0:
        settings['setback'] = -setback
    settings['rooms'] = [garage_sensor_lists(room) for room in settings['rooms']]
    for room in settings['rooms']:
        room.pop('garage_manual_entity',None)
        room.pop('garage_manual_target_entity',None)
        room['solar_direction'] = room.get('solar_direction', 'south' if room.get('solar_heating', False) else 'disabled') if room.get('solar_heating', True) else 'disabled'
        for key,value in ROOM_DEFAULTS.items():
            room.setdefault(key,deepcopy(value))
        room.pop('solar_heating',None)
        value = number(room.get('fireplace_reduction'))
        if value is not None and value > 0:
            room['fireplace_reduction'] = -min(100, value)
    # Preserve the control behavior of zones created before the opt-in switch.
    for zone in settings.get('heating_zones',[]):
        for key,value in ZONE_DEFAULTS.items():
            zone.setdefault(
                key,
                True if key=='heating_enabled' else 'tariff' if key=='heating_strategy' else deepcopy(value)
            )
    return migrate_fireplaces(settings)


def validate(payload, hass=None, *, require_outdoor=True):
    if not isinstance(payload, dict):
        raise ValueError('Settings must be an object.')
    result = deepcopy(DEFAULTS)
    result.update({k:v for k,v in payload.items() if k in DEFAULTS})
    def check(obj, fields):
        for field in fields:
            key, label, kind = field[:3]
            value = obj[key]
            if kind == 'room_links':
                if (not isinstance(value, list) or len(value) > 29
                        or any(not isinstance(peer, str) for peer in value)
                        or len(value) != len(set(value))):
                    raise ValueError('Shared air space: select each room only once.')
            elif kind.startswith('entities:'):
                if not isinstance(value, list) or len(value) > 100 or any((not isinstance(entity, str) for entity in value)):
                    raise ValueError(f'{label}: expected a list of sensor entities.')
                if len(value) != len(set(value)):
                    raise ValueError(f'{label}: a sensor is selected more than once.')
                for entity in value:
                    if entity.split('.')[0] not in kind[9:].split(',') or len(entity) > 200:
                        raise ValueError(f'{label}: incorrect entity domain.')
                    if hass is not None and hass.states.get(entity) is None:
                        raise ValueError(f'{label}: entity {entity} was not found.')
            elif kind == 'time':
                tariff_minutes(value)
            elif kind == 'number':
                n = number(value)
                if n is None or not field[3] <= n <= field[4]:
                    raise ValueError(f'{label}: value is outside the allowed range.')
                obj[key] = n
            elif kind == 'bool':
                if not isinstance(value, bool):
                    raise ValueError(f'{label}: expected a boolean value.')
            elif kind == 'notification':
                if not isinstance(value, str) or len(value) > 200:
                    raise ValueError(f'{label}: invalid notification target.')
                value = value.strip()
                if value and (not value.startswith('notify.') or not value[7:]
                              or not value[7:].replace('_', '').isalnum()):
                    raise ValueError(f'{label}: choose a notification device.')
                obj[key] = value
            elif kind.startswith('select:'):
                if value not in kind[7:].split(','):
                    raise ValueError(f'{label}: unknown option.')
            else:
                if not isinstance(value, str) or len(value) > 200:
                    raise ValueError(f'{label}: invalid text.')
                obj[key] = value.strip()
                if kind != 'text' and value:
                    if value.split('.')[0] not in kind.split(','):
                        raise ValueError(f'{label}: incorrect entity domain.')
                    if hass is not None and hass.states.get(value) is None:
                        raise ValueError(f'{label}: entity {value} was not found.')
    fields = []
    for field in SOURCE_FIELDS:
        key = field[0]
        if key in ('air_minimum', 'air_maximum', 'air_boost', 'air_setback') and result[key] is None:
            continue  # Existing installations inherit the shared values until edited.
        unused_water = key == 'water_entity' and not water_distribution(result)
        unused_cop = key == 'heat_pump_cop_entity' and result['house_heat_source'] != 'air_to_water'
        unused_price_sensor = (
            key in ('price_entity', 'price_forecast_entity') and not electric_heating(result)
            or key == 'price_entity' and result['price_entity'] in PRICE_SOURCE_CHOICES
            or key == 'price_forecast_entity' and result['price_entity'] == 'static'
        )
        # Built-in sources are not sensor entity IDs. An unused forecast choice
        # is retained so switching back from static prices stays reversible.
        if unused_water or unused_cop or unused_price_sensor or (key == 'away_zone' and not result['away_automatic']) or (key == 'tibber_price_entity' and result['price_entity'] != 'tibber'):
            fields.append((key, field[1], 'text'))
        else:
            fields.append(field)
    check(result,fields)
    if result['price_flex_reduction'] != round(result['price_flex_reduction'], 1):
        raise ValueError('Allowed temperature flexibility: use one decimal place.')
    if result['away_automatic'] and not result['away_zone']:
        raise ValueError('Select a home presence zone for automatic away detection.')
    if result['solar_stop_kw'] >= result['solar_start_kw']:
        raise ValueError('Solar heating: the stop threshold must be lower than the start threshold.')
    if result['transfer_tariff'] == 'day_night' and result['transfer_day_start'] == result['transfer_night_start']:
        raise ValueError('Day and night start times must differ.')
    if hass is not None and result['fireplace_entity']:
        state = hass.states.get(result['fireplace_entity'])
        if state is not None:
            options = state.attributes.get('options')
            allowed = ['on', 'off'] if result['fireplace_entity'].startswith('binary_sensor.') else options if isinstance(options, list) else None
            if allowed and result['fireplace_active_state'] not in allowed:
                raise ValueError('Fireplace active when: choose a valid state of the selected sensor.')
    if result['minimum'] > result['maximum']:
        raise ValueError('Minimum allowed temperature must not exceed maximum allowed temperature.')
    pump_limits = pump_temperature_settings(result)
    if pump_limits['minimum'] > pump_limits['maximum']:
        raise ValueError('Heat pump: minimum allowed temperature must not exceed maximum allowed temperature.')
    for key in (
        'minimum_run_minutes',
        'start_offset_minutes',
        'stop_offset_minutes',
        'sensor_warning_hours'
    ):
        if result[key] != int(result[key]):
            raise ValueError(f'{key}: use an integer.')
        result[key] = int(result[key])
    if result['curve_cold_temp'] >= result['curve_warm_temp']:
        raise ValueError('Cold curve temperature must be below warm curve temperature.')
    if result['minimum_run_minutes'] % 15:
        raise ValueError('Minimum heating run must be a multiple of 15 minutes.')
    if not isinstance(result['rooms'], list) or len(result['rooms']) > 30:
        raise ValueError('A maximum of 30 rooms is supported.')
    zones = []
    zone_ids = set()
    if not isinstance(result['heating_zones'], list) or len(result['heating_zones']) > 30:
        raise ValueError('A maximum of 30 zones is supported.')
    for raw in result['heating_zones']:
        if not isinstance(raw, dict):
            raise ValueError('Invalid zone.')
        zone = {
            **ZONE_DEFAULTS,
            **{k: v for k, v in raw.items() if k in ZONE_DEFAULTS},
            'id': raw.get('id') or str(uuid4())
        }
        try:
            UUID(zone['id'])
        except (ValueError,TypeError,AttributeError):
            raise ValueError('Invalid zone identifier.') from None
        check(zone,ZONE_FIELDS)
        check(zone, [
            ('fireplace_circulation', 'Circulate air while a fireplace is active', 'bool'),
            ('fireplace_fan', 'Fireplace fan speed', 'text'),
            ('fireplace_swing', 'Fireplace swing mode', 'text'),
        ])
        if not zone['name'] or (zone['source_type'] == 'air_to_air' and (not zone['thermostat'])) or (zone['source_type'] == 'fireplace' and (not zone['fireplace_entity'])) or (zone['id'] in zone_ids):
            raise ValueError('Each zone needs a unique identifier, name and selected heat source.')
        if hass is not None and zone['fireplace_entity']:
            state = hass.states.get(zone['fireplace_entity'])
            options = state.attributes.get('options') if state else None
            allowed = ['on', 'off'] if zone['fireplace_entity'].startswith('binary_sensor.') else options if isinstance(options, list) else None
            if allowed and zone['fireplace_active_state'] not in allowed:
                raise ValueError('Zone fireplace: choose a supported active state.')
        zone_ids.add(zone['id'])
        zones.append(zone)
    result['heating_zones'] = zones
    rooms, ids, thermostats = ([], set(), set())
    for raw in result['rooms']:
        if not isinstance(raw, dict):
            raise ValueError('Invalid room settings.')
        raw = garage_sensor_lists(raw)
        room = deepcopy(ROOM_DEFAULTS)
        if 'solar_heating' in raw:
            raw = {
                **raw,
                'solar_direction': raw.get('solar_direction', 'south') if raw['solar_heating'] else 'disabled'
            }
        room.update({
            k:v for k,
            v in raw.items() if k in ROOM_DEFAULTS and k not in ('curve_min_hours','curve_max_hours')
        })
        room['id'] = raw.get('id') or str(uuid4())
        try:
            UUID(room['id'])
        except (ValueError, TypeError, AttributeError):
            raise ValueError('Invalid room identifier.') from None
        check(room, ROOM_FIELDS)
        if not room['name'] or not room['thermostat'] or (not room['temperature_entity']):
            raise ValueError('Each room needs a name, thermostat and temperature sensor.')
        if room['id'] in ids:
            raise ValueError('Room identifier or thermostat is already in use.')
        ids.add(room['id'])
        if room['is_garage'] and room['heating_zone_id']:
            raise ValueError('A garage must have its own heating controller.')
        if room['garage_minimum'] >= room['garage_maximum']:
            raise ValueError('Garage lower limit must be below its upper limit.')
        if room['garage_door_warning_minutes'] != int(room['garage_door_warning_minutes']):
            raise ValueError('Door warning delay must be an integer.')
        if room['garage_door_delay'] != int(room['garage_door_delay']):
            raise ValueError('Door pause delay must be an integer.')
        if not room['is_garage'] and (not result['minimum'] <= room['baseline'] <= result['maximum']):
            raise ValueError(f"{room['name']}: normal temperature must be within the allowed temperature range.")
        if hass is not None and room['is_garage'] and not air_room(room, result) and room_electric(room, result):
            attrs = hass.states.get(room['thermostat']).attributes
            if not {'heat', 'off'}.issubset(attrs.get('hvac_modes', [])):
                raise ValueError('The garage thermostat must support heating and off modes.')
            if not attrs.get('min_temp', 5) <= room['garage_maximum'] <= attrs.get('max_temp', 35):
                raise ValueError('The garage upper temperature limit must be within thermostat limits.')
        if hass is not None and air_room(room, result):
            state = hass.states.get(room['thermostat'])
            attrs = state.attributes
            use_setpoints = pump_uses_setpoints(room, result)
            required = {'heat'}
            if not use_setpoints or (room['is_garage'] and room['garage_door_entities']):
                required.add('fan_only')
            if room['is_garage'] and not use_setpoints:
                required.add('off')
            if not required.issubset(attrs.get('hvac_modes', [])):
                if use_setpoints:
                    raise ValueError(f"{room['name']}: select a pump that supports Heat and, for garage door protection, Fan only.")
                raise ValueError(f"{room['name']}: select a heat pump supporting heat and fan-only (and off for a garage).")
            target = room['garage_heat_target'] if room['is_garage'] else result['air_heat_target']
            # Climate limits can describe the current mode (fan-only may report 0–1).
            if not use_setpoints and state.state == 'heat' and (not attrs.get('min_temp', 5) <= target <= attrs.get('max_temp', 35)):
                raise ValueError(f"{room['name']}: heat pump heating setpoint {target:g} °C is outside device limits ({attrs.get('min_temp', 5):g}–{attrs.get('max_temp', 35):g} °C).")
            prefix = 'garage_' if room['is_garage'] else 'air_'
            values = room if room['is_garage'] else result
            for suffix,attribute in [
                ('fan_heat','fan_modes'),
                ('fan_idle','fan_modes'),
                ('fan_presence','fan_modes'),
                ('swing','swing_modes'),
                ('swing_idle','swing_modes')
            ]:
                if use_setpoints and suffix in ('fan_idle', 'swing_idle') and not (
                    room['is_garage'] and room['garage_door_entities']
                ):
                    continue
                selected = values.get(prefix + suffix, '')
                if selected and selected not in attrs.get(attribute, []):
                    raise ValueError(f"{room['name']}: selected {suffix.replace('_', ' ')} is not supported by this heat pump.")
        rooms.append(room)
    # Validate physical owners after membership is known. Multiple linked room
    # sensors may name their zone pump; independent controllers must stay unique.
    for room in rooms:
        zone = next((item for item in zones if item['id'] == room['heating_zone_id']), None)
        zone_owns_pump = (zone and zone['source_type'] == 'air_to_air'
                          and room['thermostat'] == zone['thermostat'] and not room['is_garage'])
        if zone_owns_pump:
            continue
        if room['thermostat'] in thermostats:
            raise ValueError('Room identifier or thermostat is already in use.')
        thermostats.add(room['thermostat'])
    for zone in zones:
        if zone['source_type'] == 'fireplace':
            continue
        members = [r for r in rooms if r['heating_zone_id'] == zone['id']]
        if members and zone['main_room_id'] not in {r['id'] for r in members} or (not members and zone['main_room_id']):
            raise ValueError('Each zone needs linked rooms and a main room selected from them.')
        if zone['thermostat'] in thermostats:
            # A room using this pump must join its zone before control can be shared.
            unlinked_pump_rooms = [room for room in rooms
                                   if room['thermostat'] == zone['thermostat']
                                   and not room['is_garage']
                                   and not room['heating_zone_id']]
            if unlinked_pump_rooms:
                raise ValueError('Add the rooms using this heat pump to the zone’s Rooms list, then save settings again.')
            raise ValueError('A heat pump can have only one controller or zone.')
        thermostats.add(zone['thermostat'])
        if hass is not None and zone['heating_enabled']:
            state = hass.states.get(zone['thermostat'])
            attrs = state.attributes
            use_setpoints = not result['air_use_fan_only']
            required = ({'heat'} if zone['climate_mode'] == 'heat' else {'cool'} if zone['climate_mode'] == 'cool' else {'heat', 'cool'})
            if not use_setpoints or zone['climate_mode'] != 'heat':
                required.add('fan_only')
            if not required.issubset(attrs.get('hvac_modes', [])):
                raise ValueError('The zone heat pump must support the selected heating/cooling modes and fan-only.')
            if not use_setpoints and zone['climate_mode'] in ('heat', 'both') and state.state == 'heat' and (not attrs.get('min_temp', 5) <= result['air_heat_target'] <= attrs.get('max_temp', 35)):
                raise ValueError(f"{zone['name']}: heat pump heating setpoint {result['air_heat_target']:g} °C is outside device limits ({attrs.get('min_temp', 5):g}–{attrs.get('max_temp', 35):g} °C).")
            for key,attribute in [
                ('air_fan_heat','fan_modes'),
                ('air_fan_idle','fan_modes'),
                ('air_swing','swing_modes'),
                ('air_swing_idle','swing_modes'),
                ('air_fan_cool','fan_modes'),
                ('air_swing_cool','swing_modes')
            ]:
                if use_setpoints and zone['climate_mode'] == 'heat' and key in ('air_fan_idle', 'air_swing_idle', 'air_fan_cool', 'air_swing_cool'):
                    continue
                if result[key] and result[key] not in attrs.get(attribute, []):
                    raise ValueError('Shared air-to-air mode is not supported by every selected heat pump.')
    for room in rooms:
        if room['heating_zone_id'] and room['heating_zone_id'] not in zone_ids:
            raise ValueError('Selected zone was not found.')
        zone = next((z for z in zones if z['id'] == room['heating_zone_id']), None)
    by_id = {room['id']: room for room in rooms}
    for room in rooms:
        for peer_id in room['shared_air_rooms']:
            peer = by_id.get(peer_id)
            if peer is None or peer is room:
                raise ValueError('Shared air space: select another existing room.')
            if room.get('is_garage') or peer.get('is_garage') or air_room(room, result) or air_room(peer, result):
                raise ValueError('Shared air space: select primary heating circuits, not heat pumps or garages.')
    # Configuring either end adds the reverse edge, never an indirect edge.
    connections = room_connections(rooms)
    for room in rooms:
        room['shared_air_rooms'] = connections[room['id']]
    result['rooms'] = rooms
    # Price setup may be completed on a different tab. Missing prices prevent
    # tariff plans at runtime; they must not prevent saving the rest of setup.
    if require_outdoor and not result['outdoor_entity']:
        raise ValueError('Select an outdoor temperature source.')
    if hass is not None and (result['apply_season_setpoints'] or not result['simulation_enabled']):
        for room in resolved_rooms(result):
            if air_room(room, result) or garage_thermostat(room) or room['heat_control'] == 'zone_member' or not room_electric(room, result):
                continue
            state = hass.states.get(room['thermostat'])
            low, high = (state.attributes.get('min_temp', 5), state.attributes.get('max_temp', 35))
            if not low <= result['summer_setpoint'] <= high:
                raise ValueError(f"{room['name']}: summer setpoint is outside thermostat limits.")
    if not isinstance(result['fireplaces'], list):
        raise ValueError('Invalid fireplace settings.')
    result = migrate_fireplaces(result)
    if len(result['fireplaces']) > 60:
        raise ValueError('A maximum of 60 fireplaces is supported.')
    fireplaces, fireplace_ids = [], set()
    available_rooms = {room['id'] for room in rooms if not room['is_garage']}
    for raw in result['fireplaces']:
        if not isinstance(raw, dict):
            raise ValueError('Invalid fireplace settings.')
        fireplace = {**FIREPLACE_DEFAULTS, **{key: raw[key] for key in FIREPLACE_DEFAULTS if key in raw},
                     'id': raw.get('id') or str(uuid4())}
        try:
            UUID(fireplace['id'])
        except (ValueError, TypeError, AttributeError):
            raise ValueError('Invalid fireplace identifier.') from None
        check(fireplace, FIREPLACE_FIELDS)
        activity_entity = fireplace['fireplace_entity']
        surface_entity = fireplace['surface_temperature_entity']
        if (fireplace['id'] in fireplace_ids or any(zone['id'] == fireplace['id'] for zone in result['heating_zones'])
                or not fireplace['name']):
            raise ValueError('Each fireplace needs a unique identifier and a name.')
        if not activity_entity and not surface_entity:
            raise ValueError('Choose an activity sensor, a surface temperature sensor, or both.')
        if activity_entity:
            active_state = fireplace['fireplace_active_state']
            state = hass.states.get(activity_entity) if hass is not None else None
            options = state.attributes.get('options') if state else None
            allowed = ['on', 'off'] if activity_entity.startswith('binary_sensor.') else options
            if (active_state in ('', 'unknown', 'unavailable')
                    or isinstance(allowed, list) and active_state not in allowed):
                raise ValueError('Fireplace active when: choose a valid state of the selected sensor.')
        surface_state = hass.states.get(surface_entity) if hass is not None and surface_entity else None
        if surface_state is not None and not entity_matches(surface_state, {'kind': 'temperature'}):
            raise ValueError('Fireplace surface temperature sensor: select a temperature sensor.')
        room_ids = fireplace['room_ids']
        if (not isinstance(room_ids, list) or any(not isinstance(room_id, str) for room_id in room_ids)
                or len(room_ids) != len(set(room_ids)) or not set(room_ids) <= available_rooms):
            raise ValueError('Fireplace rooms: select each existing room only once.')
        fireplace_ids.add(fireplace['id'])
        fireplaces.append(fireplace)
    result['fireplaces'] = fireplaces
    circulation_sources = {fireplace['id'] for fireplace in fireplaces if fireplace['fireplace_entity']}
    for zone in result['heating_zones']:
        selected = zone['fireplace_ids']
        if (not isinstance(selected, list) or any(not isinstance(item, str) for item in selected)
                or len(selected) != len(set(selected)) or not set(selected) <= fireplace_ids):
            raise ValueError('Zone fireplaces: select each existing fireplace only once.')
        if (hass is None or not zone['heating_enabled'] or not zone['fireplace_circulation']
                or circulation_sources.isdisjoint(selected)):
            continue
        attrs = hass.states.get(zone['thermostat']).attributes
        if 'fan_only' not in attrs.get('hvac_modes', []):
            raise ValueError('The zone heat pump must support the selected heating/cooling modes and fan-only.')
        for key, attribute in (('fireplace_fan', 'fan_modes'), ('fireplace_swing', 'swing_modes')):
            if zone[key] and zone[key] not in attrs.get(attribute, []):
                raise ValueError('The zone heat pump does not support the selected fireplace fan or swing mode.')
    return result


def confirm_control_settings(settings, previous, confirmed=False):
    """A legacy simulation-off preference must never silently enable device writes."""
    settings['live_control_confirmed'] = False
    if not electric_heating(settings):
        settings['simulation_enabled'] = True
        return settings
    if not settings['simulation_enabled']:
        already_live = not previous.get('simulation_enabled', True) and previous.get('live_control_confirmed', False)
        if not already_live and confirmed is not True:
            raise ValueError('Confirm live control before turning simulation off. If another automation controls these thermostats, disable it first.')
        settings['live_control_confirmed'] = True
    return settings
