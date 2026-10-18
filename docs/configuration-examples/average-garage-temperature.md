# Average garage temperature

Optional example using Home Assistant’s built-in Min/Max helper with type **Mean**
to average two garage temperature sensors. It uses the available readings rather
than substituting heating targets when a sensor is missing. Both probes must use
°C and represent the garage air temperature.

## Create through Home Assistant

Open **Settings → Devices & services → Helpers → Create helper → Min/Max**.
Name it **Average Garage Temperature**, select your two garage temperature sensors,
choose type **Mean**, and set the precision to one decimal place.

Select the created entity as the garage’s **Room temperature** source in
ThermalPilot. No template sensor is needed.

## YAML alternative

Merge this list item into your existing `sensor:` configuration and replace the
source IDs with your garage probes. Do not create a second `sensor:` key.

```yaml
sensor:
  - platform: min_max
    unique_id: thermalpilot_average_garage_temperature
    name: "Average Garage Temperature"
    type: mean
    round_digits: 1
    entity_ids:
      - sensor.garage_temperature_front
      - sensor.garage_temperature_rear
```

Check the generated entity ID before selecting it in ThermalPilot. Unknown
readings are ignored; with one valid source the mean represents that source.
Without valid inputs there is no measured average. Numeric readings are not
automatically checked for staleness, and mixed temperature units cause an error.

When migrating from a template sensor, the new helper belongs to a different
integration: reusing a `unique_id` alone does not preserve the entity mapping.
Update ThermalPilot’s selection, or remove the old helper and assign its former
entity ID to the new one if you want to keep using that ID.

See [Home Assistant Min/Max](https://www.home-assistant.io/integrations/min_max/).
