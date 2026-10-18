# Configuration examples and helpers

These optional examples and helper templates are starting points for your own
configuration. They are not required by ThermalPilot. Adapt the entity IDs and
settings to your installation and check their behavior before relying on them.
When editing a helper within the same integration, retain its `unique_id`.
Moving between integrations (for example, Template to Min/Max) can create a new
entity; check its ID and update the ThermalPilot selection.

- [Total electricity price](total-electricity-price.md) — adds day/night transfer fees and supplier margin to current and timestamped prices.
- [Lowest outdoor temperature](outdoor-temperature.md) — uses the coolest of three outdoor probes to reduce direct-sun bias.
- [Average garage temperature](average-garage-temperature.md) — uses Home Assistant’s Min/Max helper with type Mean to average measured temperatures.
- [Panasonic Aquarea / HeishaMon heating-water sensor](panasonic-aquarea-heishamon.md) — filters domestic hot-water temperature spikes using the three-way valve state.
- [Integration-provided sources](integration-sources.md) — Netatmo wind and Nordpool Predict FI; no replacement template is needed.

YAML examples show their top-level configuration keys for context. Merge list
items into existing `sensor:` or `template:` sections rather than duplicating
those keys. The example names and placeholder entity IDs are in English.
