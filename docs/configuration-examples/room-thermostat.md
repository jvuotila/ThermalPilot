# Room thermostat with a heating relay

Optional example for a room that has a temperature sensor and a relay controlling
its heating valve or heater. Home Assistant’s Generic Thermostat switches the
relay to maintain a target. ThermalPilot observes the room and, when live control
is enabled, adjusts the thermostat target; it does not directly operate this relay.

If your room already has a working `climate` thermostat entity, select that in
ThermalPilot instead of creating another controller for the same relay.

## Configure Home Assistant

For a separate `climate.yaml`, add this once in `configuration.yaml`:

```yaml
climate: !include climate.yaml
```

Then add one list item per room to `climate.yaml`. Replace the source entities,
name and unique ID for each thermostat:

```yaml
- platform: generic_thermostat
  unique_id: thermalpilot_living_room_thermostat
  name: "Living Room Thermostat"
  heater: switch.living_room_heating_valve
  target_sensor: sensor.living_room_temperature
  min_temp: 10
  max_temp: 30
  ac_mode: false
  cold_tolerance: 0.2
  hot_tolerance: 0.2
  min_cycle_duration:
    minutes: 5
  initial_hvac_mode: "heat"
  away_temp: 16
  comfort_temp: 20
  precision: 0.1
  target_temp_step: 0.5
```

If you keep thermostats directly in `configuration.yaml`, put the same list item
under its existing `climate:` key instead. Do not duplicate controllers for a
relay or create a second `climate:` key. Keep the original `unique_id` when editing
an existing Generic Thermostat. Check the actual entity ID after loading it; a
new example entity will normally be `climate.living_room_thermostat`.

## Connect the room to ThermalPilot

In **Rooms and zones**, add a room and select:

| ThermalPilot field | Example selection |
|---|---|
| Thermostat | `climate.living_room_thermostat` |
| Room temperature | `sensor.living_room_temperature` |
| Actual heating activity (optional) | `switch.living_room_heating_valve` |
| Room target temperature | Your normal comfort target, for example 20°C |

Use the same temperature source in the thermostat and ThermalPilot, including the
same averaging or calibration helper if you use one. Leaving the activity source
empty lets ThermalPilot use the thermostat’s reported `hvac_action`. Selecting
the relay explicitly records the room’s on/off heating request. This is demand,
not proof that hot water or heat actually reached the room.

Choose a relay that represents this room’s heating request, not merely the power
supply to the whole heat pump. For hydronic floor heating, also select the actual
house heat source and **Water floor heating** distribution in ThermalPilot.

## Adapt the settings

- `heater` is the room’s heating relay; `target_sensor` is its measured air
  temperature. Both temperature readings and thermostat units should be °C.
- The example tolerances switch heating on below target minus 0.2°C and off at
  target plus 0.2°C. Adapt them to the room and sensor resolution.
- `min_cycle_duration` is the thermostat relay’s minimum on-time, not ThermalPilot’s
  suggested session length. The five-minute value is an example for a room
  heating relay; use timing appropriate to the connected equipment. Generic
  Thermostat also offers `cycle_cooldown` when a minimum off-time is needed.
- `precision` controls temperature precision; `target_temp_step: 0.5` exposes
  half-degree target increments. ThermalPilot respects the reported device step.
- `away_temp` and `comfort_temp` define optional Home Assistant presets. They do
  not select those presets or set ThermalPilot’s room target.
- `initial_hvac_mode: "heat"` enables the thermostat after startup. This thermostat
  can operate the relay even while ThermalPilot is simulating. Use `"off"` if you
  want to enable it manually after setup.
- `target_temp` is deliberately omitted so Home Assistant can restore the previous
  target when available. On first setup, check and set a valid target in Home
  Assistant before expecting temperature control.
- `keep_alive` is optional and omitted here. If your device needs repeated commands,
  it can resend the current relay state; it does not define a heating schedule.

Keep ThermalPilot’s **Enable simulation** on and **Apply season setpoints** off
while observing. The Generic Thermostat continues its ordinary temperature
control; simulated boost/reduction targets are not applied. Before enabling
ThermalPilot live control, disable other automations writing targets to the same
thermostat. Keep the Generic Thermostat itself: it remains the relay controller.

For all device options and setup details, see
[Home Assistant Generic Thermostat](https://www.home-assistant.io/integrations/generic_thermostat/).
