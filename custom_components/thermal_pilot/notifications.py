"""Home Assistant notification delivery, independent of climate control."""
from datetime import datetime
from functools import lru_cache
import json
from pathlib import Path
from zoneinfo import ZoneInfo


@lru_cache(maxsize=25)
def notification_messages(language):
    """Reuse the panel's language catalog, loaded in HA's executor."""
    path = Path(__file__).parent / 'frontend' / 'languages' / f'{language}.json'
    return json.loads(path.read_text(encoding='utf-8'))['messages']


async def notify_away_reminder(hass, language, zone, period, notification_id):
    """Post one date-specific reminder in Home Assistant's notifications."""
    messages = await hass.async_add_executor_job(notification_messages, language)
    local_zone = ZoneInfo(zone)
    start = datetime.fromtimestamp(period['start'], local_zone).strftime('%Y-%m-%d %H:%M')
    end = datetime.fromtimestamp(period['end'], local_zone).strftime('%Y-%m-%d %H:%M')
    title = 'Upcoming ThermalPilot absence'
    await hass.services.async_call('persistent_notification', 'create', {
        'title': messages.get(title, title),
        'message': f'{start} – {end} ({zone})',
        'notification_id': notification_id,
    }, blocking=True)


async def notify_manual_door_pause(hass, target, language, room, doors, mode, tag):
    """Notify one explicitly selected device; never broadcast to notify.notify.

    Companion installations can expose a phone-specific action or a notify
    entity. Only the former supports the Companion-specific tag/link payload.
    """
    messages = await hass.async_add_executor_job(notification_messages, language)
    title_key = 'Manual heating paused' if mode == 'heat' else 'Manual cooling paused'
    body_key = ('{room}: the manual session cannot start because a garage door is open: {doors}. '
                'Close all configured doors to allow the active session to start.')
    title = messages[title_key]
    message = messages[body_key].format(room=room, doors=', '.join(doors))
    await send_companion_notification(hass, target, title, message, tag)


async def notify_garage_door_open(hass, target, language, room, doors, minutes, tag):
    """Warn about heat loss without changing the garage thermostat."""
    messages = await hass.async_add_executor_job(notification_messages, language)
    title = messages['Garage door left open']
    message = messages['{room}: a garage door has been open for at least {minutes} minutes: {doors}. Heating has not been paused.'].format(
        room=room, minutes=minutes, doors=', '.join(doors))
    await send_companion_notification(hass, target, title, message, tag)


async def send_companion_notification(hass, target, title, message, tag):
    """Deliver to the selected phone action or notify entity, never broadcast."""
    if target.startswith('notify.mobile_app_'):
        service = target.split('.', 1)[1]
        await hass.services.async_call('notify', service, {
            'title': title, 'message': message,
            'data': {'tag': tag, 'url': '/thermal_pilot', 'clickAction': '/thermal_pilot'},
        }, blocking=False)
    else:
        await hass.services.async_call('notify', 'send_message', {
            'entity_id': target, 'title': title, 'message': message,
        }, blocking=False)
