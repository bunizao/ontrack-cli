import json
from pathlib import Path

import pytest

from ontrack_cli.config import load_auth_config, load_base_config
from ontrack_cli.exceptions import ConfigError


def test_load_auth_config_from_doubtfire_user_json(monkeypatch):
    payload = {
        "id": 7,
        "username": "alice",
        "authenticationToken": "secret-token",
        "firstName": "Alice",
        "lastName": "Ng",
    }
    monkeypatch.setenv("ONTRACK_DOUBTFIRE_USER_JSON", json.dumps(payload))
    monkeypatch.delenv("ONTRACK_USERNAME", raising=False)
    monkeypatch.delenv("ONTRACK_AUTH_TOKEN", raising=False)
    monkeypatch.setenv("ONTRACK_BASE_URL", "https://school.example.edu")
    monkeypatch.delenv("ONTRACK_CONFIG", raising=False)

    config = load_auth_config()

    assert config.base_url == "https://school.example.edu"
    assert config.username == "alice"
    assert config.auth_token == "secret-token"
    assert config.cached_user is not None
    assert config.cached_user.display_name == "Alice Ng"


def test_load_auth_config_requires_credentials(monkeypatch, tmp_path):
    monkeypatch.delenv("ONTRACK_DOUBTFIRE_USER_JSON", raising=False)
    monkeypatch.delenv("ONTRACK_USERNAME", raising=False)
    monkeypatch.delenv("ONTRACK_AUTH_TOKEN", raising=False)
    monkeypatch.setenv("ONTRACK_BASE_URL", "https://school.example.edu")
    monkeypatch.setenv("ONTRACK_CONFIG", str(tmp_path / "missing.yaml"))
    monkeypatch.setattr("ontrack_cli.config.get_okta_auth", lambda base_url: None)
    monkeypatch.setattr("ontrack_cli.config.get_browser_auth", lambda base_url: None)

    with pytest.raises(ConfigError) as exc:
        load_auth_config()

    assert "Missing OnTrack credentials" in str(exc.value)


def test_load_auth_config_falls_back_to_browser_auth(monkeypatch, tmp_path):
    monkeypatch.delenv("ONTRACK_DOUBTFIRE_USER_JSON", raising=False)
    monkeypatch.delenv("ONTRACK_USERNAME", raising=False)
    monkeypatch.delenv("ONTRACK_AUTH_TOKEN", raising=False)
    monkeypatch.setenv("ONTRACK_BASE_URL", "https://school.example.edu")
    monkeypatch.setenv("ONTRACK_CONFIG", str(tmp_path / "missing.yaml"))
    monkeypatch.setattr("ontrack_cli.config.get_okta_auth", lambda base_url: None)

    monkeypatch.setattr(
        "ontrack_cli.config.get_browser_auth",
        lambda base_url: (
            "alice",
            "token-from-browser",
            type(
                "User",
                (),
                {
                    "username": "alice",
                    "authentication_token": "token-from-browser",
                    "to_dict": lambda self: {
                        "username": "alice",
                        "authentication_token": "token-from-browser",
                    },
                },
            )(),
        ),
    )

    config = load_auth_config()

    assert config.username == "alice"
    assert config.auth_token == "token-from-browser"


def test_load_auth_config_falls_back_to_okta_auth(monkeypatch, tmp_path):
    monkeypatch.delenv("ONTRACK_DOUBTFIRE_USER_JSON", raising=False)
    monkeypatch.delenv("ONTRACK_USERNAME", raising=False)
    monkeypatch.delenv("ONTRACK_AUTH_TOKEN", raising=False)
    monkeypatch.setenv("ONTRACK_BASE_URL", "https://school.example.edu")
    monkeypatch.setenv("ONTRACK_CONFIG", str(tmp_path / "missing.yaml"))

    monkeypatch.setattr(
        "ontrack_cli.config.get_okta_auth",
        lambda base_url: (
            "alice",
            "token-from-okta",
            type(
                "User",
                (),
                {
                    "username": "alice",
                    "authentication_token": "token-from-okta",
                    "to_dict": lambda self: {
                        "username": "alice",
                        "authentication_token": "token-from-okta",
                    },
                },
            )(),
        ),
    )
    monkeypatch.setattr("ontrack_cli.config.get_browser_auth", lambda base_url: None)

    config = load_auth_config()

    assert config.username == "alice"
    assert config.auth_token == "token-from-okta"


def test_load_base_config_reads_file(monkeypatch, tmp_path):
    config_path = tmp_path / "config.yaml"
    config_path.write_text("base_url: https://school.example.edu\n", encoding="utf-8")
    monkeypatch.setenv("ONTRACK_CONFIG", str(config_path))
    monkeypatch.delenv("ONTRACK_BASE_URL", raising=False)

    config, found_path = load_base_config()

    assert config["base_url"] == "https://school.example.edu"
    assert found_path == Path(config_path)


def test_load_base_config_requires_explicit_url_in_non_tty(monkeypatch, tmp_path):
    monkeypatch.setenv("ONTRACK_CONFIG", str(tmp_path / "missing.yaml"))
    monkeypatch.delenv("ONTRACK_BASE_URL", raising=False)

    with pytest.raises(ConfigError) as exc:
        load_base_config()

    assert "No base_url configured." in str(exc.value)
