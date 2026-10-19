"""Apply thermostat targets; never operate relays or heat-pump modes directly."""

import asyncio
from collections.abc import Callable, Iterable, Mapping
import math
from typing import Any

from .model import number

TARGET_TOLERANCE = 0.001
STEP_ROUNDING_TOLERANCE = 1e-09
RETRY_INTERVAL_SECONDS = 60
SERVICE_TIMEOUT_SECONDS = 15


class ThermostatControl:
    def __init__(self, hass: Any, require_initial_write: bool=False) -> None:
        self.hass = hass
        self.pending = {}
        self.results = {}
        self.lock = asyncio.Lock()
        self.require_initial_write = require_initial_write
        self.reconciled = set()

    async def apply(
        self,
        rooms: Iterable[Mapping[str, Any]],
        targets: Mapping[str, float],
        now: float,
        permitted: Callable[[], bool],
    ) -> list[str]:
        """Reconcile targets, retry failures and avoid repeating unacknowledged writes."""
        errors = []
        async with self.lock:
            self.results = {}
            for room in rooms:
                if not permitted():
                    break

                entity = room['thermostat']
                requested = number(targets.get(room['id']))
                if requested is None:
                    continue

                state = self.hass.states.get(entity)
                if state is None or state.state in ('unknown', 'unavailable'):
                    errors.append(
                        f"{room['name']}: thermostat unavailable; target will be retried."
                    )
                    continue

                attributes = state.attributes
                if attributes.get('temperature_unit', '°C') != '°C':
                    errors.append(
                        f"{room['name']}: live control requires a thermostat using °C."
                    )
                    continue

                device_minimum = number(attributes.get('min_temp', 5))
                device_maximum = number(attributes.get('max_temp', 35))
                control_minimum = number(room.get('control_minimum'))
                control_maximum = number(room.get('control_maximum'))
                minimum = device_minimum
                maximum = device_maximum
                if minimum is not None and control_minimum is not None:
                    minimum = max(minimum, control_minimum)
                if maximum is not None and control_maximum is not None:
                    maximum = min(maximum, control_maximum)

                if minimum is None or maximum is None or (not minimum <= requested <= maximum):
                    errors.append(f"{room['name']}: target is outside thermostat limits.")
                    continue

                step = number(attributes.get('target_temp_step'))
                if step and step > 0:
                    # Round only to device-supported steps inside both sets of limits.
                    first_step = math.ceil(
                        (minimum - device_minimum) / step - STEP_ROUNDING_TOLERANCE
                    )
                    last_step = math.floor(
                        (maximum - device_minimum) / step + STEP_ROUNDING_TOLERANCE
                    )
                    if first_step > last_step:
                        errors.append(
                            f"{room['name']}: no supported thermostat target fits "
                            'the temperature limits.'
                        )
                        continue
                    requested_step = round((requested - device_minimum) / step)
                    target_step = min(last_step, max(first_step, requested_step))
                    target = round(device_minimum + target_step * step, 3)
                else:
                    target = round(requested, 3)

                previous = self.pending.get(entity)
                actual = number(attributes.get('temperature'))
                initial_write_complete = (
                    not self.require_initial_write or entity in self.reconciled
                )
                actual_matches = (
                    actual is not None and abs(actual - target) < TARGET_TOLERANCE
                )
                pending_target_changed = previous and previous['target'] != target
                if initial_write_complete and actual_matches and (not pending_target_changed):
                    self.pending.pop(entity, None)
                    self.results[room['id']] = target
                    continue

                awaiting_acknowledgement = (
                    previous
                    and previous['target'] == target
                    and now - previous['time'] < RETRY_INTERVAL_SECONDS
                )
                if awaiting_acknowledgement:
                    self.results[room['id']] = target
                    continue

                try:
                    await asyncio.wait_for(
                        self.hass.services.async_call(
                            'climate',
                            'set_temperature',
                            {'entity_id': entity, 'temperature': target},
                            blocking=True,
                        ),
                        timeout=SERVICE_TIMEOUT_SECONDS,
                    )
                except Exception:
                    # Third-party climate services can raise integration-specific errors.
                    # Keep this boundary narrow so one failed device does not stop others.
                    errors.append(
                        f"{room['name']}: setting thermostat temperature failed; will retry."
                    )
                    continue

                self.pending[entity] = {'target': target, 'time': now}
                self.reconciled.add(entity)
                self.results[room['id']] = target
        return errors
