from __future__ import annotations

import hashlib
import hmac
import json
import logging

import pytest

from app.services import email_adapter, webhook_adapter


def test_custom_webhook_posts_stable_signed_json(monkeypatch):
    captured = {}

    class Response:
        status_code = 204
        text = ""

    def fake_post(url, *, content, headers, timeout):
        captured.update(url=url, content=content, headers=headers, timeout=timeout)
        return Response()

    monkeypatch.setattr("httpx.post", fake_post)
    monkeypatch.setattr(webhook_adapter.time, "time", lambda: 1_700_000_000)

    assert webhook_adapter.send_custom(
        "https://example.com/tickflow",
        "价格预警",
        "600000.SH 触发",
        "monitor_alert",
        {"symbol": "600000.SH"},
        "shared-secret",
    )
    payload = json.loads(captured["content"])
    assert payload == {
        "event": "monitor_alert",
        "timestamp": 1_700_000_000,
        "title": "价格预警",
        "body": "600000.SH 触发",
        "data": {"symbol": "600000.SH"},
    }
    expected = hmac.new(b"shared-secret", captured["content"], hashlib.sha256).hexdigest()
    assert captured["headers"]["X-TickFlow-Signature"] == f"sha256={expected}"
    assert captured["headers"]["X-TickFlow-Timestamp"] == "1700000000"


def test_custom_webhook_rejects_non_http_urls(monkeypatch):
    monkeypatch.setattr("httpx.post", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError))
    assert not webhook_adapter.send_custom("file:///tmp/hook", "title", "body", "test")


def test_email_adapter_uses_starttls_login_and_multiple_recipients(monkeypatch):
    instances = []

    class FakeSmtp:
        def __init__(self, host, port, timeout):
            self.host = host
            self.port = port
            self.timeout = timeout
            self.calls = []
            instances.append(self)

        def ehlo(self):
            self.calls.append(("ehlo",))

        def starttls(self):
            self.calls.append(("starttls",))

        def login(self, username, password):
            self.calls.append(("login", username, password))

        def send_message(self, message):
            self.calls.append(("send", message))

        def quit(self):
            self.calls.append(("quit",))

        def close(self):
            self.calls.append(("close",))

    monkeypatch.setattr(email_adapter.smtplib, "SMTP", FakeSmtp)
    config = {
        "host": "smtp.example.com",
        "port": 587,
        "security": "starttls",
        "username": "bot@example.com",
        "from_address": "bot@example.com",
        "to_addresses": ["one@example.com", "two@example.com"],
    }

    assert email_adapter.send_email(config, "smtp-password", "监控告警", "正文")
    smtp = instances[0]
    assert smtp.calls[:4] == [
        ("ehlo",),
        ("starttls",),
        ("ehlo",),
        ("login", "bot@example.com", "smtp-password"),
    ]
    message = next(call[1] for call in smtp.calls if call[0] == "send")
    assert message["To"] == "one@example.com, two@example.com"
    assert message["Subject"] == "监控告警"
    assert smtp.calls[-1] == ("quit",)


def _unreachable(*_args, **_kwargs):
    raise ConnectionError("unreachable")


def test_feishu_single_attempt_returns_without_backoff_and_logs_the_real_count(monkeypatch, caplog):
    # 设置页「发送测试消息」传 max_attempts=1: 失败即返回, 不等退避, 日志计数如实。
    sleeps: list[float] = []
    monkeypatch.setattr(webhook_adapter.time, "sleep", lambda seconds: sleeps.append(seconds))
    monkeypatch.setattr("httpx.post", _unreachable)
    with caplog.at_level(logging.WARNING, logger=webhook_adapter.__name__):
        ok = webhook_adapter.send_feishu(
            "https://open.feishu.cn/open-apis/bot/v2/hook/abc", "标题", "正文", max_attempts=1
        )
    assert ok is False
    assert sleeps == []
    assert "已重试 1 次" in caplog.text


def test_feishu_production_retries_keep_backoff(monkeypatch, caplog):
    # 生产路径 (默认 3 次) 的退避与日志不变: 1s、2s 两次退避, 日志写 3 次。
    sleeps: list[float] = []
    calls = {"n": 0}

    def unreachable(*_args, **_kwargs):
        calls["n"] += 1
        raise ConnectionError("unreachable")

    monkeypatch.setattr(webhook_adapter.time, "sleep", lambda seconds: sleeps.append(seconds))
    monkeypatch.setattr("httpx.post", unreachable)
    with caplog.at_level(logging.WARNING, logger=webhook_adapter.__name__):
        ok = webhook_adapter.send_feishu(
            "https://open.feishu.cn/open-apis/bot/v2/hook/abc", "标题", "正文"
        )
    assert ok is False
    assert calls["n"] == 3
    assert sleeps == [1, 2]
    assert "已重试 3 次" in caplog.text


def test_hstudio_payload_and_bearer_retry_id_are_stable(monkeypatch):
    calls = []

    def post(url, *, content, headers, timeout):
        calls.append((content, headers))
        return type('Response', (), {'status_code': 503 if len(calls) == 1 else 202, 'text': ''})()

    monkeypatch.setattr('httpx.post', post)
    monkeypatch.setattr(webhook_adapter.time, 'sleep', lambda _: None)
    assert webhook_adapter.send_custom(
        'http://localhost:3000/api/v1/webhooks/source/messages', '监控告警', '触发买入信号',
        'monitor_alert', {'symbol': '600000.SH'}, 'a' * 43, protocol='hstudio',
    )
    payload = json.loads(calls[0][0])
    assert set(payload) == {'eventId', 'title', 'content', 'data'}
    assert payload['title'] == '监控告警'
    assert payload['content'] == '触发买入信号'
    assert payload['data'] == {'symbol': '600000.SH'}
    assert payload['eventId']
    assert calls[0] == calls[1]
    assert calls[0][1]['Authorization'] == 'Bearer ' + 'a' * 43
    assert 'X-TickFlow-Signature' not in calls[0][1]


def test_hstudio_invalid_secret_does_not_send(monkeypatch):
    monkeypatch.setattr('httpx.post', lambda *a, **kw: (_ for _ in ()).throw(AssertionError))
    for secret in ['', 'bad\r\nheader', 'short']:
        assert not webhook_adapter.send_custom('http://localhost/hook', '标题', '正文', 'test', secret=secret, protocol='hstudio')
    assert not webhook_adapter.send_custom('http://localhost/hook', '标题', '正文', 'test', protocol='unknown')


@pytest.mark.parametrize("id_field", ["event_id", "id"])
def test_hstudio_reuses_persisted_event_id_and_truncates_to_receiver_limits(monkeypatch, id_field):
    calls = []

    def post(url, *, content, headers, timeout):
        calls.append(json.loads(content))
        return type('Response', (), {'status_code': 202, 'text': ''})()

    monkeypatch.setattr('httpx.post', post)
    for _ in range(2):
        assert webhook_adapter.send_custom('http://localhost/hook', '标' * 110, '文' * 17000,
                                           'monitor_alert', {id_field: 'persisted-event'}, 'a' * 43, protocol='hstudio')
    assert calls[0]['eventId'] == calls[1]['eventId']
    assert len(calls[0]['title']) == 100
    assert len(calls[0]['content']) == 16000


def test_hstudio_auth_rejection_is_not_retried(monkeypatch):
    calls = []

    def post(*args, **kwargs):
        calls.append(1)
        return type('Response', (), {'status_code': 401, 'text': 'Unauthorized'})()

    monkeypatch.setattr('httpx.post', post)
    monkeypatch.setattr(webhook_adapter.time, 'sleep', lambda _: (_ for _ in ()).throw(AssertionError))
    assert not webhook_adapter.send_custom('http://localhost/hook', '标题', '正文', 'test', secret='a' * 43, protocol='hstudio')
    assert len(calls) == 1


def test_indicator_notification_uses_saved_hstudio_protocol(monkeypatch):
    from app.services import notification_dispatch

    calls = []
    monkeypatch.setattr('app.services.preferences.get_custom_webhook_url', lambda: 'http://localhost/hook')
    monkeypatch.setattr('app.services.preferences.get_custom_webhook_protocol', lambda: 'hstudio')
    monkeypatch.setattr('app.secrets_store.get_custom_webhook_secret', lambda: 'a' * 43)
    monkeypatch.setattr(webhook_adapter, 'send_custom', lambda *args: calls.append(args) or True)
    event = {'id': 'event-001', 'symbol': '600000.SH', 'message': '买入信号', 'price': 10}
    assert notification_dispatch.send_indicator(event, 'custom')
    assert calls[0][4] == event
    assert calls[0][-1] == 'hstudio'


def test_hstudio_indicator_notifications_include_indicator_tag(monkeypatch):
    from app.services import notification_dispatch

    captured = {}

    def post(url, *, content, headers, timeout):
        captured.update(json.loads(content))
        return type('Response', (), {'status_code': 202, 'text': ''})()

    monkeypatch.setattr('httpx.post', post)
    monkeypatch.setattr('app.services.preferences.get_custom_webhook_url', lambda: 'http://localhost/hook')
    monkeypatch.setattr('app.services.preferences.get_custom_webhook_protocol', lambda: 'hstudio')
    monkeypatch.setattr('app.secrets_store.get_custom_webhook_secret', lambda: 'a' * 43)
    event = {
        'event_id': 'indicator-001', 'source': 'indicator', 'symbol': '159605.SZ',
        'symbol_name': '中概互联ETF广发',
        'indicator_name': '天使魔鬼', 'period': '30m', 'signal_name': '进攻',
        'message': '天使魔鬼 · 30分钟 · 进攻信号', 'price': 1.0, 'test': True,
    }
    assert notification_dispatch.send_indicator(event, 'custom')
    assert captured['tags'] == ['indicator']
    assert captured['data'] == event
    assert captured['data']['symbol_name'] == '中概互联ETF广发'
    assert captured['title'] == '指标监控'
    assert '进攻信号' in captured['content']


def test_generic_json_indicator_notifications_keep_original_envelope(monkeypatch):
    captured = {}

    def post(url, *, content, headers, timeout):
        captured.update(json.loads(content))
        return type('Response', (), {'status_code': 204, 'text': ''})()

    monkeypatch.setattr('httpx.post', post)
    assert webhook_adapter.send_custom('http://localhost/hook', '指标监控', '进攻', 'monitor_alert', {'source': 'indicator'})
    assert set(captured) == {'event', 'timestamp', 'title', 'body', 'data'}
