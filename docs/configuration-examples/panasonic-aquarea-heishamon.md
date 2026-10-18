# Panasonic Aquarea / HeishaMon heating-water sensor

Optional helper example; adapt the entity IDs and settling time to your installation.

A heat pump that also heats domestic hot water can report tank-cycle temperatures
as its water temperature. This example uses the three-way valve’s `Room`/`Tank`
state to exclude those spikes. It holds the last accepted room-heating reading
during tank cycles and waits five minutes after returning to `Room` before
accepting new readings.

Add this under your Home Assistant `template:` configuration, replacing the entity
IDs with your own. If `template:` already exists, add the list item beneath it
rather than creating a second key. Select the resulting sensor as ThermalPilot’s
optional **Heating water** source.

```yaml
template:
  - triggers:
      - trigger: state
        entity_id:
          - climate.panasonic_heat_pump_main_z1_temp
          - sensor.panasonic_heat_pump_main_threeway_valve_state
      - trigger: time_pattern
        minutes: "/1"
      - trigger: homeassistant
        event: start

    variables:
      water_value: >
        {{ state_attr(
          'climate.panasonic_heat_pump_main_z1_temp',
          'current_temperature'
        ) }}
      room_ready: >
        {% if is_state(
          'sensor.panasonic_heat_pump_main_threeway_valve_state', 'Room'
        ) %}
          {{ (now() -
            states.sensor.panasonic_heat_pump_main_threeway_valve_state.last_changed
          ).total_seconds() >= 300 }}
        {% else %}
          {{ false }}
        {% endif %}

    sensor:
      - name: "Underfloor Heating Water Temperature"
        unique_id: thermalpilot_aquarea_underfloor_heating_water_temperature
        device_class: temperature
        state_class: measurement
        unit_of_measurement: "°C"
        availability: >
          {{ states(
            'sensor.panasonic_heat_pump_main_threeway_valve_state'
          ) in ['Room', 'Tank']
            and is_number(water_value)
            and (
              room_ready or
              is_number(this.attributes.get('last_room_temperature'))
            )
          }}
        state: >
          {% if room_ready and is_number(water_value) %}
            {{ water_value | float }}
          {% else %}
            {{ this.attributes.get('last_room_temperature') }}
          {% endif %}
        attributes:
          last_room_temperature: >
            {% if room_ready and is_number(water_value) %}
              {{ water_value | float }}
            {% else %}
              {{ this.attributes.get('last_room_temperature') }}
            {% endif %}
          sample_held: "{{ not room_ready }}"
```

The sensor remains unavailable until its first valid room-heating sample. `300`
is the settling time in seconds; adjust it to your system. During tank cycles,
the value is a held estimate, not a fresh measurement. It filters temperature
spikes but does not tell ThermalPilot that space-heating delivery has paused.
When replacing an existing sensor, retain its original `unique_id`.
