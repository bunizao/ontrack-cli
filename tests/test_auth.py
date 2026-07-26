import json
import subprocess

import pytest

import ontrack_cli.auth as auth_module


class _Response:
    status_code = 200

    def json(self):
        return {
            "auth_token": "api-secret",
            "user": {"id": 7, "username": "alice", "first_name": "Alice"},
        }


def test_get_okta_auth_uses_stable_cookie_json_output(monkeypatch: pytest.MonkeyPatch) -> None:
    cookies = [
        {
            "name": "username",
            "value": "alice",
            "domain": ".school.example.edu",
            "path": "/",
        },
        {
            "name": "refresh_token",
            "value": "refresh-secret",
            "domain": ".school.example.edu",
            "path": "/",
        },
    ]
    calls: list[list[str]] = []

    def fake_run(command, **kwargs):
        calls.append(command)
        assert kwargs["capture_output"] is True
        assert kwargs["text"] is True
        assert kwargs["check"] is False
        return subprocess.CompletedProcess(
            command,
            0,
            stdout=json.dumps({"count": 2, "cookies": cookies, "url": command[-1]}),
            stderr="",
        )

    fake_session = type(
        "FakeSession",
        (),
        {
            "cookies": type("Cookies", (), {"set": lambda self, *args, **kwargs: None})(),
            "post": lambda self, *args, **kwargs: _Response(),
        },
    )()
    monkeypatch.setattr(auth_module.subprocess, "run", fake_run)
    monkeypatch.setattr(auth_module.requests, "Session", lambda: fake_session)
    monkeypatch.setattr(auth_module, "_is_valid_token", lambda *args: True)

    result = auth_module.get_okta_auth("https://school.example.edu")

    assert result is not None
    assert result[0] == "alice"
    assert result[1] == "api-secret"
    assert result[2].first_name == "Alice"
    assert calls == [["okta", "cookies", "--json", "https://school.example.edu"]]


@pytest.mark.parametrize(
    ("returncode", "stdout"),
    [
        (1, ""),
        (0, ""),
        (0, "not json"),
        (0, json.dumps({"cookies": "not-a-list"})),
    ],
)
def test_get_okta_auth_preserves_none_error_model(
    monkeypatch: pytest.MonkeyPatch,
    returncode: int,
    stdout: str,
) -> None:
    monkeypatch.setattr(
        auth_module.subprocess,
        "run",
        lambda command, **kwargs: subprocess.CompletedProcess(command, returncode, stdout, "failure"),
    )

    assert auth_module.get_okta_auth("https://school.example.edu") is None


def test_get_okta_auth_handles_missing_or_hanging_executable(monkeypatch: pytest.MonkeyPatch) -> None:
    for error in (FileNotFoundError(), subprocess.TimeoutExpired("okta", 30)):
        monkeypatch.setattr(
            auth_module.subprocess,
            "run",
            lambda command, **kwargs: (_ for _ in ()).throw(error),
        )
        assert auth_module.get_okta_auth("https://school.example.edu") is None
