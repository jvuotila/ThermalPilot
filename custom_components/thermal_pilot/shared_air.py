"""Learn air exchange and coordinate primary heating circuits in an open space.

A link does not imply equal floor area, water flow or heating power. Assistance
uses observed temperature transfer, never an assumed credit for a neighbor's relay.
"""
from copy import deepcopy
from datetime import datetime, timedelta
import math
from typing import Any


def room_groups(rooms: list[dict]) -> list[list[str]]:
    """Return reciprocal, transitive groups without changing room identifiers."""
    links = {room['id']: set() for room in rooms}
    for room in rooms:
        for peer in room.get('shared_air_rooms', []):
            if peer in links and peer != room['id']:
                links[room['id']].add(peer)
                links[peer].add(room['id'])
    groups = []
    visited = set()
    for room_id in links:
        if room_id in visited:
            continue
        pending = [room_id]
        members = set()
        while pending:
            member = pending.pop()
            if member in members:
                continue
            members.add(member)
            pending.extend(links[member] - members)
        visited.update(members)
        if len(members) > 1:
            groups.append(sorted(members))
    return groups


def heat_transfer(model: dict, temperature: float, neighbors: dict[str, float]) -> float:
    """Warmer neighbors supply heat; colder ones remove it (degrees per hour)."""
    state = model.get('shared_air', {})
    if state.get('members') != sorted(neighbors):
        return 0.0
    transfer = 0.0
    for peer, value in neighbors.items():
        transfer += state.get('couplings', {}).get(peer, 0) * (value - temperature)
    return transfer


def learn_shared_air(model: dict, room: dict, previous: dict, current: dict,
                     hours: float, heating_input: float, rate: float) -> None:
    """Separate own heating/loss from temperature exchange using accepted intervals.

    Background gain is removed by the caller. Wind is fitted in the same system
    so it cannot compete with a separate fit for the same loss/gain evidence.
    Fit all terms together; an independent fit would count exchanged heat twice.
    Bounded ridge regression avoids inventing negative heat transfer when sensors
    move together and cannot independently identify all contributions yet.
    """
    neighbors = previous.get('shared_air_temperatures', {})
    members = sorted(neighbors)
    if not members or set(current.get('shared_air_temperatures', {})) != set(members):
        return
    state = model.get('shared_air')
    signature = room['shared_air_signature']
    size = 3 + len(members)
    if not state or state.get('signature') != signature:
        state = {
            'members': members, 'signature': signature,
            'matrix': [[0.0] * size for _ in range(size)], 'vector': [0.0] * size,
            'hours': 0.0, 'heated_hours': 0.0, 'idle_hours': 0.0,
            'updates': 0, 'couplings': {},
            'prior': [model['loss'], model['gain'], model.get('wind_loss', 0)] + [0.0] * len(members),
            'wind_hours': 0.0, 'wind_sum': 0.0, 'wind_squared': 0.0,
        }
        model['shared_air'] = state
    temperature_gap = previous['outdoor'] - previous['temperature']
    wind = previous.get('wind') if current.get('wind') is not None else None
    wind_feature = 0.0
    if wind is not None and 0 <= wind <= 60:
        wind = min(wind, 20)
        wind_feature = temperature_gap * (wind - 3)
        state['wind_hours'] += hours
        state['wind_sum'] += wind * hours
        state['wind_squared'] += wind * wind * hours
    features = [temperature_gap, heating_input, wind_feature]
    features.extend(neighbors[peer] - previous['temperature'] for peer in members)
    for row in range(size):
        state['vector'][row] = .999 * state['vector'][row] + features[row] * rate * hours
        for column in range(size):
            contribution = features[row] * features[column] * hours
            state['matrix'][row][column] = .999 * state['matrix'][row][column] + contribution
    state['hours'] += hours
    state['heated_hours'] += hours * previous['activity']
    state['idle_hours'] += hours * (1 - previous['activity'])
    if state['heated_hours'] < 12 or state['idle_hours'] < 12:
        return

    matrix = deepcopy(state['matrix'])
    vector = state['vector'][:]
    for index, weight in enumerate([200.0, 20.0, 10000.0] + [10.0] * len(members)):
        matrix[index][index] += weight
        vector[index] += weight * state['prior'][index]
    fitted = [model['loss'], model['gain'], model.get('wind_loss', 0)]
    fitted.extend(state['couplings'].get(peer, 0.0) for peer in members)
    wind_variance = 0.0
    if state['wind_hours']:
        wind_variance = state['wind_squared'] / state['wind_hours'] - (state['wind_sum'] / state['wind_hours']) ** 2
    wind_ready = state['wind_hours'] >= 24 and wind_variance >= 1
    wind_bounds = (0.0, .05 / 6) if wind_ready else (fitted[2], fitted[2])
    bounds = [(.001, .05), (.03, 3.0), wind_bounds] + [(0.0, .5)] * len(members)
    # Each coordinate update minimizes the same convex quadratic with physical
    # bounds. The tiny system needs no numerical-library dependency.
    for _ in range(100):
        largest_change = 0.0
        for index, (lower, upper) in enumerate(bounds):
            if index == 2 and wind_ready:
                upper = min(upper, fitted[0] / 6)
            other_terms = sum(matrix[index][column] * fitted[column]
                              for column in range(size) if column != index)
            estimate = (vector[index] - other_terms) / matrix[index][index]
            estimate = max(lower, min(upper, estimate))
            largest_change = max(largest_change, abs(estimate - fitted[index]))
            fitted[index] = estimate
        if largest_change < 1e-8:
            break
    model['loss'] = .98 * model['loss'] + .02 * fitted[0]
    model['gain'] = .98 * model['gain'] + .02 * fitted[1]
    if wind_ready:
        model['wind_loss'] = .98 * model.get('wind_loss', 0) + .02 * fitted[2]
        model['wind_updates'] = model.get('wind_updates', 0) + 1
    for peer, coefficient in zip(members, fitted[3:]):
        state['couplings'][peer] = .98 * state['couplings'].get(peer, 0) + .02 * coefficient
    state['updates'] += 1
    model['parameter_updates'] = model.get('parameter_updates', 0) + 1


def simulate_group(contexts: dict[str, dict], plans: dict[str, dict], now: datetime) -> tuple:
    """Score simultaneous forecasts, including advance commands and coasting reserve.

    Each circuit retains its own target and heating response. Five-minute substeps
    let warmer air help colder sensors without crediting the same heat twice.
    Cost uses the existing normalized per-controller basis, not measured kWh.
    """
    from .model import stamp, response_step, response_lag, effective_loss, thermostat_state
    temperatures = {key: context['temperature'] for key, context in contexts.items()}
    responses = {key: context['model']['response'] for key, context in contexts.items()}
    output = deepcopy(plans)
    violations = {key: 0.0 for key in contexts}
    shortfalls = {key: 0.0 for key in contexts}
    demand_hours = {key: 0.0 for key in contexts}
    ranges = {key: [context['temperature'], context['temperature']] for key, context in contexts.items()}
    cost = 0.0
    rows = next(iter(plans.values()))['slots']
    reserve = min(12, next(iter(contexts.values()))['room'].get('terminal_reserve_hours', 6))
    maximum_exchange = max(sum(context['model']['shared_air']['couplings'].values())
                           for context in contexts.values())
    for index in range(len(rows) + 1):
        coasting = index == len(rows)
        start = stamp(rows[-1]['end']) if coasting else max(now, stamp(rows[index]['start']))
        end = start + timedelta(hours=reserve) if coasting else stamp(rows[index]['end'])
        hours = (end - start).total_seconds() / 3600
        if hours <= 0:
            continue
        steps = max(1, math.ceil(hours * max(12, 2 * maximum_exchange)))
        step = hours / steps
        if not coasting:
            for key, context in contexts.items():
                row = output[key]['slots'][index]
                previous_mode = context['room'].get('previous_control_mode', 'normal')
                if index:
                    previous_mode = output[key]['slots'][index - 1]['mode']
                cost += .3 * abs((row['mode'] == 'boost') - (previous_mode == 'boost'))
                cost += .02 * (row['mode'] != previous_mode)
                if row['mode'] == 'reduced':
                    cost -= .03 * hours
        demanded = {key: False for key in contexts}
        for substep in range(steps):
            moment = start + timedelta(hours=substep * step)
            updated = {}
            for key, context in contexts.items():
                room, model = context['room'], context['model']
                row = output[key]['slots'][-1 if coasting else index]
                target = thermostat_state(output[key], moment)['setpoint']
                heating = not coasting and temperatures[key] < target
                demanded[key] |= heating
                responses[key], average = response_step(
                    responses[key], float(heating), step, response_lag(room, model)
                )
                neighbors = {peer: value for peer, value in temperatures.items() if peer != key}
                wind = room.get('wind_speed')
                if wind is not None:
                    wind = 3 + (wind - 3) * math.exp(-(moment - now).total_seconds() / 10800)
                change = (
                    effective_loss(model, wind) * (row['outdoor'] - temperatures[key])
                    + model['gain'] * context['water_factor'] * average
                    + model.get('base_gain', 0) + (0 if coasting else row.get('solar_gain', 0))
                    + heat_transfer(model, temperatures[key], neighbors)
                )
                updated[key] = temperatures[key] + step * change
                violations[key] += step * (max(0, room['minimum'] - updated[key])
                                           + max(0, updated[key] - room['maximum']))
                shortfalls[key] += step * max(0, context['baseline'] - updated[key])
                if not coasting:
                    ranges[key][0] = min(ranges[key][0], updated[key])
                    ranges[key][1] = max(ranges[key][1], updated[key])
                    demand_hours[key] += step * heating
                    cost += step * (row['price'] * heating
                                    + .15 * (updated[key] - context['baseline']) ** 2)
            temperatures = updated
        if not coasting:
            for key in contexts:
                output[key]['slots'][index]['temperature'] = round(temperatures[key], 3)
                output[key]['slots'][index]['predicted_demand'] = demanded[key]
    for key, result in output.items():
        result.update(
            forecast_minimum=round(ranges[key][0], 3), forecast_maximum=round(ranges[key][1], 3),
            violation_degree_hours=round(violations[key], 3),
            target_shortfall_degree_hours=round(shortfalls[key], 3),
            predicted_demand_hours=round(demand_hours[key], 2),
            comfort_risk=violations[key] > .01, shared_air_coordinated=True,
        )
        if result['comfort_risk']:
            result['reason'] = 'Temperature limit risk: review model assumptions and heating capacity.'
        elif result['reason'].startswith('Temperature limit risk:'):
            result['reason'] = 'Heating is planned later; no boost is suggested now.'
    score = (round(sum(violations.values()), 6), round(sum(shortfalls.values()), 6), cost)
    return score, violations, output


def coordinate_plans(contexts: dict[str, dict], now: datetime) -> dict[str, Any]:
    """Try normal and assisting schedules while preserving planner constraints.

    Replan against peers' temperatures, then evaluate the complete group. Accept
    assistance only when the group improves and no member's limit risk increases.
    At most twelve additional planner calls bound work per group on each update.
    """
    from .model import plan
    if len(contexts) < 2 or any(not context.get('plan') for context in contexts.values()):
        return {}
    members = set(contexts)
    for key, context in contexts.items():
        state = context['model'].get('shared_air', {})
        if (not state.get('updates') or set(state.get('members', [])) != members - {key}
                or state.get('signature') != context['room'].get('shared_air_signature')):
            return {}
    if not any(coefficient > .001 for context in contexts.values()
               for coefficient in context['model']['shared_air']['couplings'].values()):
        return {}
    plans = {key: context['plan'] for key, context in contexts.items()}
    grids = {tuple((row['start'], row['end']) for row in value['slots']) for value in plans.values()}
    if len(grids) != 1 or not next(iter(grids)):
        return {}
    score, violations, evaluated = simulate_group(contexts, plans, now)
    budget = 12
    for _ in range(2):
        changed = False
        # Coldest circuits go first so large groups do not always favor ID order.
        order = sorted(contexts, key=lambda key: contexts[key]['temperature'] - contexts[key]['baseline'])
        for key in order:
            context = contexts[key]
            for assist in (False, True):
                if budget == 0:
                    break
                budget -= 1
                room = deepcopy(context['room'])
                room['shared_air_forecast'] = {
                    peer: [contexts[peer]['temperature']] + [row['temperature'] for row in evaluated[peer]['slots'][:-1]]
                    for peer in contexts if peer != key
                }
                if assist:
                    room['planning_comfort_target'] = min(room['maximum'], context['baseline'] + room['boost'])
                candidate = plan(room, context['model'], context['temperature'], context['outdoor'],
                                 context['slots'], now, context['baseline'], context['water_factor'])
                if candidate is None:
                    continue
                proposed = {**plans, key: candidate}
                new_score, new_violations, new_evaluated = simulate_group(contexts, proposed, now)
                if assist and budget:
                    # Extra helper heat and reduced recipient work must be tested
                    # together. Rejecting the helper's extra cost in isolation
                    # would prevent a cheaper pair of schedules from ever forming.
                    recipients = [peer for peer in contexts if peer != key
                                  and contexts[peer]['model']['shared_air']['couplings'].get(key, 0) > .001]
                    if recipients:
                        recipient = max(recipients, key=lambda peer: (
                            evaluated[peer]['target_shortfall_degree_hours'],
                            evaluated[peer]['suggested_heating_hours'],
                        ))
                        peer_context = contexts[recipient]
                        peer_room = deepcopy(peer_context['room'])
                        peer_room['shared_air_forecast'] = {
                            peer: [contexts[peer]['temperature']] + [row['temperature'] for row in new_evaluated[peer]['slots'][:-1]]
                            for peer in contexts if peer != recipient
                        }
                        budget -= 1
                        peer_plan = plan(peer_room, peer_context['model'], peer_context['temperature'],
                                         peer_context['outdoor'], peer_context['slots'], now,
                                         peer_context['baseline'], peer_context['water_factor'])
                        if peer_plan:
                            paired = {**proposed, recipient: peer_plan}
                            pair_score, pair_violations, pair_evaluated = simulate_group(contexts, paired, now)
                            if pair_score < new_score:
                                proposed, new_score = paired, pair_score
                                new_violations, new_evaluated = pair_violations, pair_evaluated
                safe = all(new_violations[peer] <= violations[peer] + 1e-6 for peer in contexts)
                for peer, peer_context in contexts.items():
                    limits = peer_context['room']
                    hottest_allowed = max(limits['maximum'], evaluated[peer]['forecast_maximum'])
                    coldest_allowed = min(limits['minimum'], evaluated[peer]['forecast_minimum'])
                    safe = safe and new_evaluated[peer]['forecast_maximum'] <= hottest_allowed
                    safe = safe and new_evaluated[peer]['forecast_minimum'] >= coldest_allowed
                meaningful = new_score[:2] != score[:2] or new_score[2] < score[2] - .01
                if safe and new_score < score and meaningful:
                    plans, score, violations, evaluated = proposed, new_score, new_violations, new_evaluated
                    changed = True
        if not changed or budget == 0:
            break
    return evaluated
