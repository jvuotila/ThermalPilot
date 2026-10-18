# Optional integration-provided sources

These entities come from other integrations; they do not need replacement
ThermalPilot templates. Entity IDs depend on your installation.

## Netatmo wind

Select the wind sensor supplied by the
[Netatmo integration](https://www.home-assistant.io/integrations/netatmo/) as
ThermalPilot’s optional wind source. A Netatmo gust-speed sensor is an
integration-provided entity, not a custom template. Check the actual entity’s
unit and whether it measures gusts or sustained wind. Rename it through Home Assistant if you prefer an English
name; no unit-conversion helper is needed when its unit is already supported.

## Nordpool Predict FI

[Nordpool Predict FI](https://github.com/vividfog/nordpool-predict-fi-hacs/)
provides the optional `sensor.nordpool_predict_fi_price` forecast source for
Finland. Its published prices use c/kWh and already include VAT.

Select it as **Price forecast (optional)**. Keep the confirmed total-price source
selected separately as **Electricity prices**: ThermalPilot uses the forecast for
its bounded next-day reserve signal, not as confirmed prices to pay. No additional
forecast template is needed for this integration.
