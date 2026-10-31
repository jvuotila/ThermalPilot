# ThermalPilot

Shift electric heating toward cheaper electricity periods while keeping rooms
within their comfort limits. ThermalPilot learns each room’s heating and cooling
response and shows proposed schedules before you enable real control.

Version **0.9.64 — experimental simulation-first Home Assistant custom integration**.

![Total electricity prices and room heating timelines](docs/screenshots/electricity-and-heating.png)

## Why I built this

I’ve wanted to build an integration like this for some time. Home Assistant
automations can handle basic heating control well, but more complex decisions
become difficult to manage with fixed rules. Heating during the cheapest spot-price
periods usually works—until those periods are 24–36 hours apart. If rooms cool too
much in between, heating may be needed during the most expensive hours instead.

I wanted a system that learns how the house responds and plans ahead, rather than
following a static chain of rules. ThermalPilot is my attempt to meet that need,
with charts available both in its own panel and as dashboard cards.

Development is ongoing. I can test real-world behavior only with my own heating
system, so I can’t cover every installation or scenario myself. If you try
ThermalPilot, I’d welcome your feedback through
[GitHub issues](https://github.com/jvuotila/ThermalPilot/issues).

The integration starts in simulation mode and does not control your heating by
default. Give it an extended observation period to learn your system, then assess
its forecasts and plans before considering live control. Learning alone does not
guarantee reliability. You can also use ThermalPilot purely to monitor your
heating system, without ever letting it control anything.

## What it does

- Plans heating using electricity prices, room temperatures and weather.
- Shows room plans, recorded heating and saved temperature forecasts.
- Supports primary room thermostats, secondary air-to-air heat-pump zones and
  independent garage control.
- Includes sortable heat-retention estimates and two dashboard cards.
- Works on phones and supports 25 interface languages.

Tariff optimization is intended for heat pumps and electric resistance heating
with variable electricity prices. Gas, oil, wood and district heating support
observation and learning; their fuel costs and equipment control are not modeled.

## Install

### Install with HACS (recommended)

1. [Install HACS](https://hacs.xyz/docs/use/download/download/) in your Home Assistant
   instance if you do not already have it.
2. Click the button below to open ThermalPilot in HACS. Confirm adding the custom
   repository if prompted, then download the integration.

   [![Open ThermalPilot in HACS](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=jvuotila&repository=https%3A%2F%2Fgithub.com%2Fjvuotila%2FThermalPilot&category=integration)

3. Restart Home Assistant.
4. Open **Settings → Devices & services → Add integration**, search for
   **ThermalPilot**, and follow the setup steps.
5. Open **ThermalPilot** in the sidebar and follow [Get started](#get-started).

If the button does not work, open **HACS → Custom repositories**, add
`https://github.com/jvuotila/ThermalPilot` with category **Integration**, then
find and download **ThermalPilot** in HACS. Restart Home Assistant and continue
from step 4 above.

### Manual installation

1. Download the repository and copy its `custom_components/thermal_pilot` folder
   into your Home Assistant configuration's `custom_components` directory.
2. Restart Home Assistant.
3. Open **Settings → Devices & services → Add integration → ThermalPilot**,
   then follow [Get started](#get-started).

## Get started

1. In **Settings**, select your outdoor-temperature source and choose a price
   sensor or **Static price**. For a sensor, match its price unit; for a fixed
   tariff, enter the total price in c/kWh. Include the consumption-based charges
   you want scheduling to consider. See [electricity tariffs](#electricity-tariffs).
2. In **Rooms and zones**, choose the house heating system and add each room’s
   thermostat and temperature sensor. Follow the [sensor placement guidance](#temperature-sensor-placement)
   before starting learning, then set targets and comfort limits.
3. Keep **Enable simulation** on and **Apply season setpoints** off for a trial
   that does not change thermostats. Keep your existing heating controls running.
4. Work through [Before you start learning](#before-you-start-learning), then
   review **Plan** and **History** as observations accumulate. Use field info
   buttons for setting-specific help.

Zones are secondary sources: adding a heat-pump zone preserves each room’s
primary thermostat and heating plan. New zones are observation-only until their
own control switch is enabled.

## Temperature sensor placement

Place each sensor where it measures the room's representative air temperature,
away from local heat sources and cold drafts. ThermalPilot uses these readings to
learn how the room heats and cools; a sensor heated by sunlight or an appliance
can produce misleading forecasts and heat-retention estimates.

- Keep it out of direct sunlight throughout the day, including sunlight that
  reaches the location in other seasons.
- Keep it away from radiators, fireplaces, stoves and cooking appliances such as
  ovens and air fryers.
- Avoid the direct airflow from heat pumps, air conditioners and ventilation
  outlets, as well as drafts from doors or windows.
- Choose a location at normal occupied height with air circulating around it.
  Avoid the ceiling, floor, cold exterior surfaces, enclosed shelves and spots
  behind curtains or furniture. Follow the sensor manufacturer's mounting guidance.
- Keep the location consistent. After handling or moving the sensor, let its
  reading settle before judging room temperature or model behaviour.

The aim is to measure the temperature people experience in the room, rather than
an unusually warm or cold spot. ThermalPilot cannot reliably correct a poorly
placed sensor. Its filter for rapid temperature changes does not remove every
misleading reading, particularly the slower cooling after a local heat spike.

If a sensor has been learning in an unsuitable location, move it first and let it
settle. Consider resetting learning for that room using its circular-arrow button
under **Rooms and zones**. This clears the learned parameters while retaining
observation history; the room then needs fresh heating and idle observations.

## Electricity tariffs

In **Settings → Electricity price settings → Price sensor**, choose either:

- **A price sensor** supplying timestamped prices or today/tomorrow lists, with
  its matching source price unit. Use this for spot prices or any tariff whose
  total price varies by time.
- **Static price**, then enter **Static price (c/kWh)**. Include the fixed energy
  price and applicable per-kWh transfer charges, taxes and retailer margin.
  For example, 8 c/kWh for energy plus 4 c/kWh for transfer and taxes is
  **12 c/kWh**. Exclude fixed monthly fees. No price sensor or price forecast is
  needed in this mode.

A static price applies equally to every hour. ThermalPilot still uses room
measurements, comfort limits and weather to plan heating and learn the room's
response; a fixed tariff does not make the thermal predictions inherently more
accurate or remove the need to validate them.

If your energy price is fixed but the transfer tariff changes between day and
night, use a custom price sensor combining both into the total per-kWh price for
each period. Select that sensor instead of **Static price**. A sensor reporting
only the current value is insufficient: the planner needs a price list covering
future periods. See the [total electricity price example](docs/configuration-examples/total-electricity-price.md).

## Before you start learning

- **Check temperature readings.** Follow the [placement guidance](#temperature-sensor-placement)
  and check that the room and outdoor sensors report plausible values and update
  regularly. Let a sensor settle after handling it.
- **Check heating activity.** Use the room thermostat's reported heating activity
  or select its heating relay as the optional activity source. Verify that it
  changes when that room requests heating. A device being powered on or set to
  Heat mode is not enough. A relay indicates demand, not proof that heat reaches
  the room; water circulation and equipment delays still matter.
  See [sources and room setup](docs/GUIDE.md#sources-and-room-setup) and the
  [room thermostat example](docs/configuration-examples/room-thermostat.md).
- **Account for other heat sources.** Configure secondary heat pumps and observed
  fireplaces where applicable. Unreported heating from another appliance or
  heater can be mistaken for the primary system's output. Check the
  [secondary zone guidance](docs/GUIDE.md#secondary-zones).
- **Check electricity prices.** For a sensor, match the selected unit to the source;
  for **Static price**, use c/kWh. Include
  applicable variable charges, such as VAT, retailer margin and consumption-based
  grid charges or taxes. ThermalPilot does not add these costs. Check that the
  source supplies prices for the expected hours; see the
  [total electricity price example](docs/configuration-examples/total-electricity-price.md).
- **Keep existing heating working during simulation.** Leave **Enable simulation**
  on and **Apply season setpoints** off while observing. Before enabling live
  control, disable competing schedules or automations that change the same
  thermostat targets. Keep the thermostat's own temperature regulation and
  equipment safety controls in place.
- **Review learning after significant changes.** A relocated or replaced sensor,
  different heating equipment, or insulation changes may make earlier observations
  less representative. Settings changes do not automatically reset learning.
  Consider a reset for the affected room once its new readings have settled;
  routine target adjustments do not require starting over. See
  [learning resets and stored data](docs/GUIDE.md#sensor-warnings-and-stored-data).

## Understanding the estimates

- **100% initial collection is not an accuracy score.** It means at least 12
  accepted heating hours and 12 idle hours have accumulated. Learning continues,
  and reaching 100% never enables control automatically. Mild weather may provide
  little heating evidence, so there is no fixed number of days until accuracy.
- **Heat retention uses reference conditions.** The table models cooling from
  20°C indoors with −10°C outdoors, with heating and background gains excluded.
  Its six-hour loss and time per 1°C drop describe those conditions, rather than
  today's expected temperature change. The badges are not certified insulation
  ratings or safe durations for switching heating off.
- **A plan is different from actual heating.** The suggested heating track shows
  planned periods; the recorded track shows observed activity. Raising a
  thermostat target does not guarantee its relay stays on. On the Plan chart,
  red up and blue down arrows indicate the current planned target adjustment;
  hover over an arrow for the amount and target temperatures.
- **Check forecasts against measurements.** Compare saved forecasts with later
  room readings and the no-temperature-change benchmark, including periods where
  actual heating matched the plan. Stable room temperatures alone do not prove
  that heating capacity or timing is modeled correctly.
- **Treat unusual results as a reason to investigate.** Sunlight, cooking, open
  windows, sensor handling and unreported heat sources can distort estimates.
  Check sensor history and heating activity before interpreting a sudden change
  as a change in the room's insulation or cooling speed.

See [learning and interpreting charts](docs/GUIDE.md#learning-and-interpreting-charts)
for more detail.

## Before enabling control

Review forecast accuracy across heating, idle and cold-weather periods before
considering live control. Allow enough observation to understand how your own
system behaves; initial data collection alone does not establish reliability.

To enable scheduled control, turn off **Enable simulation**, save and confirm.
Disable other automations controlling the same thermostats first. **Apply season
setpoints** can also change real thermostats during simulation; leave it off for
observation only. See [control and fallback behavior](docs/GUIDE.md#control-and-fallback).

## Dashboard cards

Both cards load automatically with the integration. Add them from your dashboard’s
card picker:

- **ThermalPilot heat retention** — sortable table with selectable columns.
- **ThermalPilot heating plan** — electricity prices and heating timelines.

Both support an optional title and language override.
[Card configuration and YAML examples](docs/DASHBOARD-CARDS.md).

## Configuration examples and helpers

[Optional examples and helpers](docs/configuration-examples/README.md) to adapt to
your installation: room thermostats, total electricity prices, outdoor and garage
temperatures, and Panasonic Aquarea / HeishaMon heating-water filtering.

## More information

- [Settings and operating guide](docs/GUIDE.md)
- [Screenshot gallery](docs/GALLERY.md)
- [Updating and prototype migration](docs/UPGRADING.md)
- [Model assumptions](docs/MODEL.md)
- [Development and tests](docs/DEVELOPMENT.md) · [Translations](docs/TRANSLATING.md)

## License

[PolyForm Noncommercial 1.0.0](LICENSE). Commercial use is not licensed; versions
through v0.1.40 retain their original MIT terms.

ThermalPilot is experimental software, provided without warranty. Energy savings
are not guaranteed.
