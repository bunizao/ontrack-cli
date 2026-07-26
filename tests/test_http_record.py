import json

import pytest

from ontrack_cli.client import OnTrackClient
from ontrack_cli.models import AuthConfig


class _Response:
    status_code = 200
    content = b"json"

    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


def test_http_record_writes_allowlisted_sanitized_pair(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    record_path = tmp_path / "ontrack.jsonl"
    monkeypatch.setenv("ONTRACK_HTTP_RECORD", str(record_path))
    auth = AuthConfig(
        base_url="https://private.school.example.edu",
        username="real-user",
        auth_token="real-auth-token",
    )
    client = OnTrackClient(auth)
    payload = [
        {
            "id": 9182,
            "user_id": 7272,
            "target_grade": 2,
            "portfolio_available": True,
            "unit": {
                "id": 88,
                "code": "FIT9999",
                "name": "Private unit name",
                "active": True,
                "authentication_token": "nested-secret",
            },
            "private_field": "must-not-be-recorded",
        }
    ]
    monkeypatch.setattr(client.session, "request", lambda *args, **kwargs: _Response(payload))

    client.get_projects(include_inactive=True)

    recorded_text = record_path.read_text(encoding="utf-8")
    assert "real-auth-token" not in recorded_text
    assert "real-user" not in recorded_text
    assert "private.school.example.edu" not in recorded_text
    assert "nested-secret" not in recorded_text
    assert "must-not-be-recorded" not in recorded_text

    record = json.loads(recorded_text)
    assert record["request"] == {
        "method": "GET",
        "path": "/api/projects",
        "params": {"include_inactive": True},
    }
    assert record["response"]["status_code"] == 200
    assert record["response"]["json"] == [
        {
            "id": 1,
            "user_id": 1,
            "target_grade": 2,
            "portfolio_available": True,
            "unit": {
                "id": 1,
                "code": "UNIT",
                "name": "Unit",
                "active": True,
            },
        }
    ]


def test_http_record_never_records_staff_surface(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    record_path = tmp_path / "ontrack.jsonl"
    monkeypatch.setenv("ONTRACK_HTTP_RECORD", str(record_path))
    client = OnTrackClient(AuthConfig("https://school.example.edu", "alice", "secret"))
    monkeypatch.setattr(client.session, "request", lambda *args, **kwargs: _Response([]))

    assert client.get_unit_roles(active_only=False) == []
    assert not record_path.exists()
