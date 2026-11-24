"""Fireplace configuration migration and activity shared by planning and control."""

from uuid import NAMESPACE_URL, uuid5


def migrate_fireplaces(settings):
    """Move old sensors into named sources, preserving local overrides and history IDs."""
    zones = settings['heating_zones']
    legacy_zones = [zone for zone in zones if zone.get('fireplace_entity') or zone.get('source_type') == 'fireplace']
    if not legacy_zones and not settings.get('fireplace_entity'):
        return settings

    fireplaces = list(settings['fireplaces'])
    rooms = settings['rooms']
    local_zone_ids = set()
    for zone in legacy_zones:
        entity = zone.get('fireplace_entity')
        if not entity:
            continue
        zone_id = zone['id']
        local_zone_ids.add(zone_id)
        room_ids = [room['id'] for room in rooms
                    if not room.get('is_garage') and room.get('heating_zone_id') == zone_id]
        fireplace_only = zone.get('source_type') == 'fireplace'
        fireplace_id = zone_id if fireplace_only else str(uuid5(NAMESPACE_URL, f'thermal-pilot/fireplace/{zone_id}'))
        fireplaces.append({
            'id': fireplace_id, 'name': zone['name'],
            'fireplace_entity': entity, 'fireplace_active_state': zone.get('fireplace_active_state', 'on'),
            'room_ids': room_ids,
        })

    entity = settings.get('fireplace_entity')
    if entity:
        fireplaces.append({
            'id': str(uuid5(NAMESPACE_URL, f'thermal-pilot/fireplace/{entity}')),
            'name': 'Fireplace', 'fireplace_entity': entity,
            'fireplace_active_state': settings.get('fireplace_active_state', 'on'),
            'room_ids': [room['id'] for room in rooms if not room.get('is_garage')
                         and room.get('heating_zone_id') not in local_zone_ids],
        })

    fireplace_zone_ids = {zone['id'] for zone in zones if zone.get('source_type') == 'fireplace'}
    settings['fireplaces'] = fireplaces
    settings['heating_zones'] = [
        {**zone, 'fireplace_entity': '', 'fireplace_active_state': 'on'}
        for zone in zones if zone['id'] not in fireplace_zone_ids
    ]
    settings['rooms'] = [
        {**room, 'heating_zone_id': ''} if room.get('heating_zone_id') in fireplace_zone_ids else room
        for room in rooms
    ]
    settings['fireplace_entity'] = ''
    settings['fireplace_active_state'] = 'on'
    return settings


def active_fireplaces(hass, settings):
    """Only confirmed active readings contribute heat or override a pump."""
    active = []
    for fireplace in settings.get('fireplaces', []):
        state = hass.states.get(fireplace['fireplace_entity'])
        if (state is not None and state.state not in ('unknown', 'unavailable')
                and state.state == fireplace['fireplace_active_state']):
            active.append(fireplace)
    return active
