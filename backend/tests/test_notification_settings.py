from __future__ import annotations

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.api.settings import (
    CustomWebhookPrefsIn,
    EmailSmtpPrefsIn,
    update_custom_webhook,
    update_email_smtp,
)
from app.services import preferences


def test_custom_webhook_settings_validate_url_and_store_secret(monkeypatch):
    monkeypatch.setattr("app.services.preferences.get_custom_webhook_protocol", lambda: "json")
    saved = {}
    monkeypatch.setattr(
        "app.services.preferences.set_custom_webhook_url",
        lambda url: saved.update(url=url) or url,
    )
    monkeypatch.setattr(
        "app.secrets_store.set_custom_webhook_secret",
        lambda secret: saved.update(secret=secret) or secret,
    )
    monkeypatch.setattr(
        "app.secrets_store.get_custom_webhook_secret",
        lambda: saved.get("secret", ""),
    )

    result = update_custom_webhook(CustomWebhookPrefsIn(
        url="https://hooks.example.com/tickflow",
        secret="shared-secret",
    ))

    assert saved == {
        "url": "https://hooks.example.com/tickflow",
        "secret": "shared-secret",
    }
    assert result["custom_webhook_secret_set"] is True

    with pytest.raises(HTTPException, match=r"HTTP\(S\)"):
        update_custom_webhook(CustomWebhookPrefsIn(url="file:///tmp/hook"))


def test_email_settings_validate_and_store_password_separately(monkeypatch):
    saved = {}
    monkeypatch.setattr(
        "app.services.preferences.set_email_smtp_config",
        lambda config: saved.update(config=config) or config,
    )
    monkeypatch.setattr(
        "app.secrets_store.set_email_smtp_password",
        lambda password: saved.update(password=password) or password,
    )
    monkeypatch.setattr(
        "app.secrets_store.get_email_smtp_password",
        lambda: saved.get("password", ""),
    )

    result = update_email_smtp(EmailSmtpPrefsIn(
        host="smtp.example.com",
        port=587,
        security="starttls",
        username="bot@example.com",
        password="smtp-password",
        from_address="bot@example.com",
        to_addresses=["alerts@example.com", "alerts@example.com"],
    ))

    assert saved["password"] == "smtp-password"
    assert saved["config"]["to_addresses"] == ["alerts@example.com"]
    assert result["email_smtp_password_set"] is True

    with pytest.raises(HTTPException, match="收件人"):
        update_email_smtp(EmailSmtpPrefsIn(
            host="smtp.example.com",
            from_address="bot@example.com",
            to_addresses=["not-an-email"],
        ))

    saved.clear()
    with pytest.raises(HTTPException, match="密码或授权码"):
        update_email_smtp(EmailSmtpPrefsIn(
            host="smtp.example.com",
            username="bot@example.com",
            from_address="bot@example.com",
            to_addresses=["alerts@example.com"],
        ))


def test_hstudio_settings_require_secret_and_preserve_it_on_update(monkeypatch):
    saved = {}
    monkeypatch.setattr(preferences, "load", lambda: dict(saved))
    monkeypatch.setattr(preferences, "save", lambda values: saved.update(values))
    monkeypatch.setattr("app.secrets_store.get_custom_webhook_secret", lambda: saved.get("secret", ""))
    monkeypatch.setattr("app.secrets_store.set_custom_webhook_secret", lambda value: saved.update(secret=value))
    url = "http://localhost:3000/hook"
    with pytest.raises(HTTPException, match="Bearer"):
        update_custom_webhook(CustomWebhookPrefsIn(url=url, protocol="hstudio"))
    assert saved == {}
    result = update_custom_webhook(CustomWebhookPrefsIn(url=url, secret="a" * 43, protocol="hstudio"))
    assert result["custom_webhook_protocol"] == "hstudio"
    assert result["custom_webhook_secret_set"]
    assert "secret" not in result
    update_custom_webhook(CustomWebhookPrefsIn(url=url))
    assert saved["secret"] == "a" * 43
    assert preferences.get_custom_webhook_protocol() == "hstudio"
    update_custom_webhook(CustomWebhookPrefsIn(url=""))
    assert saved["secret"] == ""


def test_historical_webhook_protocol_defaults_and_rejects_unknown(monkeypatch):
    for raw in [{}, {"custom_webhook_protocol": "future"}]:
        monkeypatch.setattr(preferences, "load", lambda raw=raw: raw)
        assert preferences.get_custom_webhook_protocol() == "json"
    with pytest.raises(ValidationError):
        CustomWebhookPrefsIn(url="http://localhost/hook", protocol="future")


def test_custom_webhook_http_contract(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api.settings import router
    from app.config import settings

    monkeypatch.setattr(settings, "data_dir", tmp_path)
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as client:
        path = "/api/settings/preferences/custom-webhook"
        assert client.put(path, json={"url": "http://localhost/hook", "protocol": "hstudio"}).status_code == 400
        response = client.put(path, json={"url": "http://localhost/hook", "protocol": "hstudio", "secret": "a" * 43})
        assert response.status_code == 200
        assert response.json()["custom_webhook_protocol"] == "hstudio"
        assert "a" * 43 not in response.text
        assert client.put(path, json={"url": "http://localhost/hook", "protocol": "future"}).status_code == 422
