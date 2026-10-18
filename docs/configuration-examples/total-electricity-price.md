# Total electricity price with day/night transfer fees

Optional example adapted from a Nordpool helper. It adds the supplier’s variable
margin and a day/night transfer fee to both the current price and every confirmed
price interval used by ThermalPilot.

This is for a source exposing `raw_today` and `raw_tomorrow` lists with `start`,
`end` and `value` fields, such as the compatible Nordpool custom integration. It
is not a drop-in example for sources that expose prices only through actions.
Each timestamp must include its time-zone offset. Hourly and quarter-hourly
intervals use their actual local timestamps, including daylight-saving changes.

Before using it:

1. Replace `sensor.nordpool` with your confirmed price source.
2. Create three Number helpers (or replace their IDs with your existing helpers):

   | Entity | Name | Unit |
   |---|---|---|
   | `input_number.electricity_day_transfer_price` | Day Transfer Price | c/kWh |
   | `input_number.electricity_night_transfer_price` | Night Transfer Price | c/kWh |
   | `input_number.electricity_supplier_margin` | Electricity Supplier Margin | c/kWh |

   Enter your actual variable charges. Zero is valid when a charge does not apply.
   Do not add VAT, transfer taxes or margins a second time if already included in
   another component. Fixed monthly charges are not part of this helper.
3. Adjust the day-tariff hours if needed. This example uses 07:00–21:59 every day;
   it does not model weekend/holiday exceptions. Change both `now().hour` and
   `local_start.hour` tests if your tariff differs.

Merge the following list item into your existing `template:` configuration.
The source unit is explicitly converted to c/kWh; unsupported units or unavailable
required inputs make the sensor unavailable instead of inventing a zero price.

```yaml
template:
  - triggers:
      - trigger: state
        entity_id:
          - sensor.nordpool
          - input_number.electricity_day_transfer_price
          - input_number.electricity_night_transfer_price
          - input_number.electricity_supplier_margin
      - trigger: time_pattern
        minutes: "/1"
      - trigger: homeassistant
        event: start
    variables:
      price_source: sensor.nordpool
      price_factor: >
        {{ {
          'c/kwh': 1, 'ct/kwh': 1, 'cents/kwh': 1,
          '€/kwh': 100, 'eur/kwh': 100,
          '€/mwh': 0.1, 'eur/mwh': 0.1
        }.get((state_attr(price_source, 'unit_of_measurement') or '') | lower | trim) }}
      day_fee: "{{ states('input_number.electricity_day_transfer_price') | float(none) }}"
      night_fee: "{{ states('input_number.electricity_night_transfer_price') | float(none) }}"
      supplier_margin: "{{ states('input_number.electricity_supplier_margin') | float(none) }}"
    sensor:
      - name: "Total Electricity Price"
        default_entity_id: sensor.total_electricity_price
        unique_id: thermalpilot_total_electricity_price
        unit_of_measurement: "c/kWh"
        icon: mdi:flash
        availability: >
          {{ is_number(states(price_source)) and is_number(price_factor)
            and is_number(day_fee) and is_number(night_fee)
            and is_number(supplier_margin) }}
        state: >
          {% if is_number(states(price_source)) and is_number(price_factor)
                and is_number(day_fee) and is_number(night_fee)
                and is_number(supplier_margin) %}
            {% set fee = day_fee if 7 <= now().hour < 22 else night_fee %}
            {{ ((states(price_source) | float) * price_factor
                + supplier_margin + fee) | round(4) }}
          {% else %}
            {{ none }}
          {% endif %}
        attributes:
          raw_today: >
            {% set source = state_attr(price_source, 'raw_today') or [] %}
            {% set ns = namespace(rows=[], valid=true) %}
            {% if is_number(price_factor) and is_number(day_fee)
                  and is_number(night_fee) and is_number(supplier_margin) %}
              {% for row in source %}
                {% if row is mapping and is_number(row.get('value')) %}
                  {% set start = as_datetime(row.get('start'), none) %}
                  {% set end = as_datetime(row.get('end'), none) %}
                  {% if start is not none and end is not none
                        and start.tzinfo is not none and end.tzinfo is not none
                        and as_timestamp(end) > as_timestamp(start) %}
                    {% set local_start = as_local(start) %}
                    {% set fee = day_fee if 7 <= local_start.hour < 22 else night_fee %}
                    {% set ns.rows = ns.rows + [{
                      'start': local_start.isoformat(),
                      'end': as_local(end).isoformat(),
                      'value': ((row['value'] | float) * price_factor
                                + supplier_margin + fee) | round(4)
                    }] %}
                  {% else %}
                    {% set ns.valid = false %}
                  {% endif %}
                {% else %}
                  {% set ns.valid = false %}
                {% endif %}
              {% endfor %}
            {% else %}
              {% set ns.valid = false %}
            {% endif %}
            {{ ns.rows if ns.valid else [] }}
          raw_tomorrow: >
            {% set source = state_attr(price_source, 'raw_tomorrow') or [] %}
            {% set ns = namespace(rows=[], valid=true) %}
            {% if is_number(price_factor) and is_number(day_fee)
                  and is_number(night_fee) and is_number(supplier_margin) %}
              {% for row in source %}
                {% if row is mapping and is_number(row.get('value')) %}
                  {% set start = as_datetime(row.get('start'), none) %}
                  {% set end = as_datetime(row.get('end'), none) %}
                  {% if start is not none and end is not none
                        and start.tzinfo is not none and end.tzinfo is not none
                        and as_timestamp(end) > as_timestamp(start) %}
                    {% set local_start = as_local(start) %}
                    {% set fee = day_fee if 7 <= local_start.hour < 22 else night_fee %}
                    {% set ns.rows = ns.rows + [{
                      'start': local_start.isoformat(),
                      'end': as_local(end).isoformat(),
                      'value': ((row['value'] | float) * price_factor
                                + supplier_margin + fee) | round(4)
                    }] %}
                  {% else %}
                    {% set ns.valid = false %}
                  {% endif %}
                {% else %}
                  {% set ns.valid = false %}
                {% endif %}
              {% endfor %}
            {% else %}
              {% set ns.valid = false %}
            {% endif %}
            {{ ns.rows if ns.valid else [] }}
```

Select **Total Electricity Price** as ThermalPilot’s confirmed electricity-price
source and choose **c/kWh** as the price unit. This example exports the timestamped
`raw_today`/`raw_tomorrow` attributes ThermalPilot consumes; it does not recreate
all attributes of the source integration. Missing tomorrow prices produce an
empty list. Invalid entries invalidate that attribute’s list instead of becoming
zero-priced intervals.

Check a day interval and a night interval manually: for example, a source price of
0.08 €/kWh, a 0.5 c/kWh supplier margin and a 4 c/kWh transfer fee should produce
12.5 c/kWh in both the state and the matching interval. Negative source prices
remain valid. The Home Assistant time zone must match the transfer tariff.

See [Home Assistant trigger-based templates](https://www.home-assistant.io/integrations/template/#trigger-based-template-entities).
