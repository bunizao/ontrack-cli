"""Fail-closed requests replay adapter for the final Python oracle."""

from __future__ import annotations

import copy
import json
import os
import re
import socket
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import requests


class ReplayViolation(RuntimeError):
    """Raised before an unsafe or unrecorded request can reach the network."""


_CREDENTIAL_KEY = re.compile(
    r"(?:auth[-_]?token|access[-_]?token|refresh[-_]?token|authentication[-_]?token|"
    r"authorization|cookie|password|secret)",
    re.IGNORECASE,
)
_CREDENTIAL_VALUE = re.compile(
    r"(?:\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}|"
    r"\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|"
    r"\b[A-Za-z0-9_-]{48,}\b)",
    re.IGNORECASE,
)
_LIVE_HOST = "ontrack.infotech.monash.edu"


def _fail(message: str) -> None:
    raise ReplayViolation(message)


def _scan_safe(value: Any, location: str = "fixture") -> None:
    if isinstance(value, list):
        for index, item in enumerate(value):
            _scan_safe(item, f"{location}[{index}]")
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                _fail(f"{location} contains a non-string key")
            if _CREDENTIAL_KEY.search(key):
                _fail(f"{location}.{key} contains a credential-shaped key")
            _scan_safe(item, f"{location}.{key}")
        return
    if isinstance(value, str):
        lowered = value.lower()
        if _LIVE_HOST in lowered:
            _fail(f"{location} contains a live hostname")
        if "@" in value and not value.lower().endswith("@example.invalid"):
            _fail(f"{location} contains a non-sanitized email value")
        if _CREDENTIAL_VALUE.search(value):
            _fail(f"{location} contains a credential-shaped value")


def _canonical_params(params: Any) -> str:
    normalized = {} if params is None else params
    if not isinstance(normalized, dict):
        _fail("request params must be a JSON object")
    if not all(isinstance(key, str) for key in normalized):
        _fail("request params must use string keys")
    try:
        return json.dumps(
            normalized,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
    except (TypeError, ValueError) as exc:
        raise ReplayViolation("request params must be JSON values") from exc


def _fixture_key(method: str, path: str, params: Any) -> str:
    return f"{method} {path} {_canonical_params(params)}"


def _load_fixture() -> dict[str, dict[str, Any]]:
    fixture_path = os.environ.get("ONTRACK_REPLAY_FIXTURE")
    if not fixture_path:
        _fail("ONTRACK_REPLAY_FIXTURE is required")
    try:
        records = json.loads(Path(fixture_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ReplayViolation("replay fixture is not readable JSON") from exc
    if not isinstance(records, list) or not records:
        _fail("replay fixture must be a non-empty JSON array")
    _scan_safe(records)

    fixtures: dict[str, dict[str, Any]] = {}
    for index, record in enumerate(records):
        if not isinstance(record, dict) or set(record) != {"request", "response"}:
            _fail(f"replay fixture record {index} has unexpected fields")
        request = record["request"]
        response = record["response"]
        if not isinstance(request, dict) or set(request) != {"method", "path", "params"}:
            _fail(f"replay fixture request {index} has unexpected fields")
        if not isinstance(response, dict) or set(response) != {"status_code", "json"}:
            _fail(f"replay fixture response {index} has unexpected fields")
        method = request["method"]
        path = request["path"]
        if method != "GET" or not isinstance(path, str) or not path.startswith("/"):
            _fail(f"replay fixture request {index} is not a canonical GET")
        if "%" in path or "//" in path or "/./" in path or "/../" in path:
            _fail(f"replay fixture request {index} has a non-canonical path")
        status = response["status_code"]
        if not isinstance(status, int) or isinstance(status, bool) or not 100 <= status <= 599:
            _fail(f"replay fixture response {index} has an invalid status code")
        key = _fixture_key(method, path, request["params"])
        if key in fixtures:
            _fail(f"duplicate replay fixture key: {key}")
        fixtures[key] = response
    return fixtures


class _ReplayResponse:
    def __init__(self, status_code: int, payload: Any) -> None:
        self.status_code = status_code
        self._payload = copy.deepcopy(payload)
        self.content = json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        self.text = self.content.decode("utf-8")

    def json(self) -> Any:
        return copy.deepcopy(self._payload)


def _install() -> None:
    fixtures = _load_fixture()

    def replay_request(_session: Any, method: str, url: str, **kwargs: Any) -> _ReplayResponse:
        normalized_method = str(method).upper()
        if normalized_method != "GET":
            _fail(f"only GET requests are allowed during replay, got {normalized_method}")
        if not isinstance(url, str):
            _fail("request URL must be a string")
        parsed = urlsplit(url)
        hostname = (parsed.hostname or "").lower()
        if parsed.scheme != "https" or not hostname.endswith(".example.invalid"):
            _fail(f"live or non-sanitized hostname is forbidden during replay: {hostname or '<missing>'}")
        if parsed.username or parsed.password or parsed.port is not None:
            _fail("request URL must not contain credentials or a port")
        if parsed.query or parsed.fragment:
            _fail("request URL must not contain a query string or fragment")
        path = parsed.path
        if not path.startswith("/") or "%" in path or "//" in path or "/./" in path or "/../" in path:
            _fail(f"request path is not canonical: {path}")
        if kwargs.get("json") is not None or kwargs.get("data") is not None:
            _fail("GET replay requests must not contain a body")
        key = _fixture_key(normalized_method, path, kwargs.get("params"))
        response = fixtures.get(key)
        if response is None:
            _fail(f"no replay fixture for {normalized_method} {path} with params {_canonical_params(kwargs.get('params'))}")
        return _ReplayResponse(response["status_code"], response["json"])

    def module_request(method: str, url: str, **kwargs: Any) -> _ReplayResponse:
        return replay_request(None, method, url, **kwargs)

    requests.Session.request = replay_request
    requests.request = module_request

    def blocked_network(*_args: Any, **_kwargs: Any) -> Any:
        _fail("direct network access is forbidden during fixture replay")

    socket.create_connection = blocked_network
    socket.socket.connect = blocked_network
    socket.socket.connect_ex = blocked_network


try:
    _install()
except BaseException as exc:
    sys.stderr.write(f"python replay harness: {exc}\n")
    sys.stderr.flush()
    os._exit(91)
