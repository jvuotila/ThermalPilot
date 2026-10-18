# Lowest outdoor temperature

Optional helper example for outdoor probes on different sides of a building.
When at least one probe stays shaded, selecting the lowest reading helps avoid
sun-warmed probes making the outdoor temperature appear too high. This example
uses the same minimum-of-three approach as the original configuration.

Add to `configuration.yaml`, or merge the list item into your existing `sensor:`
configuration. Replace the three source entity IDs with your outdoor probes.
All sources must use the same temperature unit; use °C for ThermalPilot.

```yaml
sensor:
  - platform: min_max
    unique_id: thermalpilot_lowest_outdoor_temperature
    name: "Lowest Outdoor Temperature"
    type: min
    round_digits: 1
    entity_ids:
      - sensor.outdoor_temperature_north
      - sensor.outdoor_temperature_garden
      - sensor.outdoor_temperature_west
```

Select the created sensor as ThermalPilot’s **Outdoor temperature** source.
Check its generated entity ID in Home Assistant; a new installation will normally
use `sensor.lowest_outdoor_temperature`. Keep an existing sensor’s `unique_id`
when adapting its definition rather than creating a replacement entity.

The [Home Assistant Min/Max helper](https://www.home-assistant.io/integrations/min_max/)
ignores unknown source states. It does not validate whether a numeric reading is
fresh or plausible: one faulty low reading can dominate the result. The minimum
is a useful shade-selection estimate, not a measured average around the house.
