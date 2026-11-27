"""ThermalPilot constants; scheduled control is opt-in; simulation is enabled by default."""
DOMAIN = 'thermal_pilot'
VERSION = '0.9.125'
PLATFORMS = ['sensor', 'binary_sensor', 'switch']
RESERVE_HOURS = 6.0
ARCHIVE_KEEP_DAYS = 7
HISTORY_DAYS = 30
WATER_REFERENCE = 32.0
AIR_INITIAL_LAG_HOURS = 10 / 60
MIN_LEARNING_INTERVAL_SECONDS = 180
AIR_MAX_TEMPERATURE_RATE_PER_HOUR = 12.0  # °C/hour; allow normal rapid air warmups.
DEFAULTS = {
    'price_entity': '', 'price_forecast_entity': '', 'price_unit': 'c/kWh',
    'static_price': 10.0,
    'nordpool_entry': '', 'nordpool_area': '', 'nordpool_vat': 0.0, 'nordpool_margin': 0.0,
    'tibber_price_entity': '',
    'transfer_tariff': 'included', 'transfer_fixed_price': 0.0,
    'transfer_day_price': 0.0, 'transfer_night_price': 0.0,
    'transfer_day_start': '07:00', 'transfer_night_start': '22:00',
    'pricing_mode': 'flexible', 'minimum_run_minutes': 60,
    'price_flex_threshold': 25.0, 'price_flex_reduction': -0.5,
    'solar_power_entity': '', 'solar_start_kw': 4.0, 'solar_stop_kw': 1.0,
    'solar_minimum_run_minutes': 30,
    'away_automatic': False, 'away_zone': '', 'away_delay_hours': 24.0, 'away_temperature': 16.0, 'away_cooling_temperature': 26.0,
    'weather_entity': '', 'outdoor_entity': '', 'wind_entity': '',
    'water_entity': '', 'heat_pump_cop_entity': '', 'fireplace_entity': '',
    'fireplace_active_state': 'on',
    'heating_enabled': True, 'simulation_enabled': True, 'language': 'en',
    'live_control_confirmed': False,
    'sensor_warning_hours': 8,
    'manual_notification_target': '',
    'summer_minimum_temperature': 6.0, 'summer_setpoint': 10.0, 'apply_season_setpoints': False,
    'boost': 1.5, 'setback': -1.0, 'minimum': 19.0, 'maximum': 23.0,
    'start_offset_minutes': 5, 'stop_offset_minutes': 10,
    'lag_hours': 3.0, 'curve_warm_temp': 0.0, 'curve_cold_temp': -18.0,
    'house_construction':'unknown', 'house_heat_source': 'air_to_water', 'house_distribution': 'water_floor',
    'house_heated_floor': 'concrete_slab', 'house_foundation': 'unknown',
    'air_minimum': None, 'air_maximum': None, 'air_boost': None, 'air_setback': None,
    'air_use_fan_only': True, 'air_fan_cool':'', 'air_swing_cool':'', 'air_heat_target': 24.0,
    'air_fan_heat': '', 'air_fan_idle': '', 'air_swing': '', 'air_swing_idle': '',
    'heating_zones': [], 'rooms': [], 'fireplaces': [],
}
ROOM_DEFAULTS = {
    'name': '', 'thermostat': '', 'temperature_entity': '',
    'activity_entity': '', 'shared_air_rooms': [], 'away_exempt': False, 'allow_price_flex': False,
    'baseline': 20.0, 'heating_priority': 'independent', 'assist_below_target': 0.5,
    'is_garage': False, 'heat_control': 'house', 'heating_zone_id': '',
    'garage_construction':'unknown', 'garage_minimum': 5.0, 'garage_maximum': 9.0,
    'garage_heat_source': 'house', 'garage_use_fan_only': True, 'garage_strategy': 'temperature', 'garage_heat_target': 16.0,
    'garage_fan_heat': '', 'garage_fan_idle': '', 'garage_fan_presence': '', 'garage_swing': '', 'garage_swing_idle': '',
    'garage_door_entities': [], 'garage_door_delay': 60, 'garage_door_warning_minutes': 10,
    'garage_presence_entities': [],
    'curve_min_hours': 4.0, 'curve_max_hours': 13.0,
    'fireplace_reduction': 0.0, 'solar_direction': 'disabled', 'solar_exposure': 'clear',
}

ZONE_DEFAULTS = {
    'heating_enabled': False,
    'climate_mode': 'heat',
    'heating_strategy': 'temperature',
    'cooling_target': 24.0,
    'source_type': 'air_to_air',
    'name': '',
    'thermostat': '',
    'main_room_id': '',
    'temperature_policy': 'main',
    'fireplace_ids': [],
    'fireplace_circulation': False,
    'fireplace_fan': '',
    'fireplace_swing': '',
    'fireplace_entity': '',
    'fireplace_active_state': 'on'
}

FIREPLACE_DEFAULTS = {
    'name': '', 'fireplace_entity': '', 'fireplace_active_state': 'on', 'room_ids': [],
    'surface_temperature_entity': '',
}

# Starting reference cooling time only; replaced by learned garage loss.
GARAGE_INITIAL_COOLING_HOURS = 4.0

# Approximate whole-building examples: +20°C to +10°C, outdoors -20°C.
# Kalema 2008, reproduced in Security Committee 2015, printed pp. 56–57.
HOUSE_COOLING_REFERENCES = {
    'wooden_detached':18.0,
    'masonry_detached':30.0,
    'concrete_apartment':36.0,
    'heavy_masonry_apartment':96.0,
}
