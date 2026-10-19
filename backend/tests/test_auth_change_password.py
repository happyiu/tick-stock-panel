from __future__ import annotations

import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.auth import COOKIE_NAME, router
from app.services import auth


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(auth, "_path", lambda: tmp_path / "auth.json")
    monkeypatch.setattr(auth, "_sessions", {})
    monkeypatch.setattr(auth, "_configured_cache", None)
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_logged_in_user_changes_password_without_old_password(client, tmp_path):
    auth.set_password("before-password")
    current = auth.verify_and_create_session("before-password")
    other = auth.verify_and_create_session("before-password")
    client.cookies.set(COOKIE_NAME, current)

    response = client.post("/api/auth/change-password", json={"new_password": "after-password"})

    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert not auth.is_valid_session(current)
    assert not auth.is_valid_session(other)
    assert auth.verify_and_create_session("before-password") is None
    assert auth.verify_and_create_session("after-password") is not None
    assert "after-password" not in (tmp_path / "auth.json").read_text()


@pytest.mark.parametrize("token_state", ["missing", "invalid", "expired"])
def test_change_password_requires_valid_login(client, tmp_path, token_state):
    auth.set_password("before-password")
    if token_state == "invalid":
        client.cookies.set(COOKIE_NAME, "invalid")
    elif token_state == "expired":
        token = auth.verify_and_create_session("before-password")
        auth._sessions[token] = time.time() - 1
        client.cookies.set(COOKIE_NAME, token)
    response = client.post("/api/auth/change-password", json={"new_password": "after-password"})
    assert response.status_code == 401
    assert auth.verify_and_create_session("before-password") is not None
    assert auth.verify_and_create_session("after-password") is None


@pytest.mark.parametrize("password", ["short", "x" * 129])
def test_change_password_preserves_length_validation(client, password):
    auth.set_password("before-password")
    token = auth.verify_and_create_session("before-password")
    client.cookies.set(COOKIE_NAME, token)
    response = client.post("/api/auth/change-password", json={"new_password": password})
    assert response.status_code == 422
    assert auth.is_valid_session(token)
    assert auth.verify_and_create_session("before-password") is not None
