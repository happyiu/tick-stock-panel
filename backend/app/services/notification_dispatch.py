"""Channel selection shared by quote alerts and indicator monitoring."""
import logging

from app import secrets_store
from app.services import email_adapter, notify_adapter, preferences, webhook_adapter

logger = logging.getLogger(__name__)


def format_notifications(events, registry=None):
    if registry is None or not registry.has_notification_formatters:
        return events
    from app.extensions.contracts import BACKEND_EXTENSION_API_VERSION, NotificationFormatContext
    result = []
    for event in events:
        formatted = dict(event)
        context = NotificationFormatContext(api_version=BACKEND_EXTENSION_API_VERSION)
        for registered in registry.notification_formatters():
            try:
                message = registered.implementation.format_message(dict(formatted), context)
                if not isinstance(message, str):
                    raise TypeError('notification formatter must return str')
                formatted['message'] = message
            except Exception as exc:
                logger.warning('notification formatter failed %s (%s)', registered.implementation_id, type(exc).__name__)
        result.append(formatted)
    return result


def notification_jobs(event, channels, title, body):
    jobs = []
    if 'system' in channels and preferences.get_system_notify_enabled():
        jobs.append(('system', notify_adapter.notify, (f'TickFlow · {title}', body)))
    if 'feishu' in channels and (url := preferences.get_feishu_webhook_url()):
        jobs.append(('feishu', webhook_adapter.send_feishu, (url, title, body, preferences.get_feishu_webhook_secret())))
    if 'wecom' in channels and (url := preferences.get_wecom_webhook_url()):
        jobs.append(('wecom', webhook_adapter.send_wecom, (url, title, body)))
    if 'custom' in channels and (url := preferences.get_custom_webhook_url()):
        jobs.append(('custom', webhook_adapter.send_custom, (
            url, title, body, 'monitor_alert', event, secrets_store.get_custom_webhook_secret())))
    config = preferences.get_email_smtp_config() if 'email' in channels else {}
    if 'email' in channels and email_adapter.is_configured(config):
        jobs.append(('email', email_adapter.send_email, (config, secrets_store.get_email_smtp_password(), title, body)))
    return jobs


def send_indicator(event, channel):
    body = f"{event['symbol']} {event['message']} · 信号价 {event.get('price')}"
    jobs = notification_jobs(event, [channel], '指标监控', body)
    return bool(jobs) and bool(jobs[0][1](*jobs[0][2]))
