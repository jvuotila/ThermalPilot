"""Fireplace configuration migration and activity shared by planning and control."""

from uuid import NAMESPACE_URL, uuid5

from .model import number

# Migration also runs during Home Assistant startup, so the default names are
# available without reading the frontend translation files on the event loop.
FIREPLACE_MIGRATION_NAMES = {
    'bg': 'Камина',
    'cs': 'Krb',
    'da': 'Pejs',
    'de': 'Kamin',
    'el': 'Τζάκι',
    'en': 'Fireplace',
    'es': 'Chimenea',
    'et': 'Kamin',
    'fi': 'Tulisija',
    'fr': 'Cheminée',
    'hr': 'Kamin',
    'hu': 'Kandalló',
    'is': 'Arinn',
    'it': 'Camino',
    'lt': 'Židinys',
    'lv': 'Kamīns',
    'nb': 'Ildsted',
    'nl': 'Haard',
    'pl': 'Kominek',
    'pt': 'Lareira',
    'ro': 'Șemineu',
    'sk': 'Krb',
    'sq': 'Oxhak',
    'sr': 'Камин',
    'sv': 'Eldstad',
}


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
        # The old house-wide sensor had no room list. A nonzero room
        # compensation is the explicit indication that the fireplace warms it.
        room_ids = [
            room['id'] for room in rooms
            if not room.get('is_garage')
            and room.get('heating_zone_id') not in local_zone_ids
            and number(room.get('fireplace_reduction'), 0) != 0
        ]
        fireplaces.append({
            'id': str(uuid5(NAMESPACE_URL, f'thermal-pilot/fireplace/{entity}')),
            'name': FIREPLACE_MIGRATION_NAMES.get(settings['language'], 'Fireplace'),
            'fireplace_entity': entity,
            'fireplace_active_state': settings.get('fireplace_active_state', 'on'),
            'room_ids': room_ids,
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


def fireplace_activity(hass, fireplace):
    """Return the confirmed activity state, or None without a usable reading."""
    entity = fireplace.get('fireplace_entity')
    state = hass.states.get(entity) if entity else None
    if state is None or state.state in ('unknown', 'unavailable'):
        return None
    return state.state == fireplace['fireplace_active_state']


def active_fireplaces(hass, settings):
    """Only confirmed activity can trigger the configured fan circulation."""
    return [fireplace for fireplace in settings.get('fireplaces', [])
            if fireplace_activity(hass, fireplace) is True]
