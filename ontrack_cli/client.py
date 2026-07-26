"""Minimal client for the Doubtfire API used by OnTrack."""

from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path
from typing import Any

import requests

from ontrack_cli.constants import DEFAULT_TIMEOUT
from ontrack_cli.exceptions import AuthError, OnTrackAPIError
from ontrack_cli.models import (
    AuthConfig,
    CachedUser,
    ProjectDetail,
    ProjectSummary,
    Task,
    TaskDefinition,
    UnitDetail,
    UnitRole,
    UnitSummary,
)

log = logging.getLogger(__name__)

_RECORDABLE_PATHS = (
    re.compile(r"^/api/auth/method$"),
    re.compile(r"^/api/projects$"),
    re.compile(r"^/api/projects/\d+$"),
    re.compile(r"^/api/units/\d+$"),
)

_RECORD_FIELDS = {
    "abbreviation",
    "active",
    "assess_in_portfolio",
    "code",
    "compile_portfolio",
    "completion_date",
    "description",
    "discuss_timeout_expiry_at",
    "due_date",
    "end_date",
    "error",
    "extensions",
    "grade",
    "grade_definitions",
    "id",
    "include_in_portfolio",
    "is_graded",
    "max_quality_pts",
    "message",
    "method",
    "moved_to_discuss_at",
    "my_role",
    "name",
    "portfolio_available",
    "project_id",
    "quality_pts",
    "role",
    "start_date",
    "status",
    "submission_date",
    "submitted_grade",
    "target_date",
    "target_due_date",
    "target_grade",
    "target_start_date",
    "task_definition_id",
    "task_definitions",
    "tasks",
    "times_assessed",
    "unit",
    "unit_id",
    "user_id",
    "uses_draft_learning_summary",
}

_ID_FIELDS = {"id", "project_id", "task_definition_id", "unit_id", "user_id"}
_DATE_FIELDS = {
    "completion_date",
    "due_date",
    "end_date",
    "start_date",
    "submission_date",
    "target_date",
    "target_due_date",
    "target_start_date",
}
_INSTANT_FIELDS = {"discuss_timeout_expiry_at", "moved_to_discuss_at"}
_BOOLEAN_FIELDS = {
    "active",
    "assess_in_portfolio",
    "compile_portfolio",
    "include_in_portfolio",
    "is_graded",
    "portfolio_available",
    "uses_draft_learning_summary",
}
_NUMBER_FIELDS = {
    "extensions",
    "grade",
    "max_quality_pts",
    "quality_pts",
    "submitted_grade",
    "target_grade",
    "times_assessed",
}
_ENUM_FIELDS = {"method", "my_role", "role", "status"}
_TEXT_SUBSTITUTIONS = {
    "abbreviation": "TASK",
    "code": "UNIT",
    "description": "Description",
    "error": "API error",
    "message": "API message",
    "name": "Unit",
}


def _sanitize_record_value(value: Any, field: str | None = None) -> Any:
    """Rebuild a recorded value from known fields with substituted identifiers."""
    if isinstance(value, list):
        return [_sanitize_record_value(item, field) for item in value]
    if isinstance(value, dict):
        return {
            key: _sanitize_record_value(item, key)
            for key, item in value.items()
            if key in _RECORD_FIELDS
        }
    if field in _ID_FIELDS:
        return 1 if isinstance(value, int) and not isinstance(value, bool) else None
    if field in _DATE_FIELDS:
        return "2000-01-01" if isinstance(value, str) else None
    if field in _INSTANT_FIELDS:
        return "2000-01-01T00:00:00Z" if isinstance(value, str) else None
    if field in _BOOLEAN_FIELDS:
        return value if isinstance(value, bool) else None
    if field in _NUMBER_FIELDS:
        return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None
    if field in _ENUM_FIELDS:
        return value if isinstance(value, str) else None
    if field in _TEXT_SUBSTITUTIONS:
        return _TEXT_SUBSTITUTIONS[field] if isinstance(value, str) else None
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return None


def _record_http_pair(
    method: str,
    path: str,
    params: dict[str, Any] | None,
    response_status: int,
    response_payload: Any,
) -> None:
    """Append one sanitized, user-scoped request/response pair when enabled."""
    destination = os.getenv("ONTRACK_HTTP_RECORD")
    if not destination or method.upper() != "GET":
        return
    if not any(pattern.fullmatch(path) for pattern in _RECORDABLE_PATHS):
        return

    safe_params = {
        key: value
        for key, value in (params or {}).items()
        if key == "include_inactive" and isinstance(value, bool)
    }
    safe_path = re.sub(r"(?<=/)(\d+)(?=$|/)", "1", path)
    record = {
        "request": {
            "method": method.upper(),
            "path": safe_path,
            "params": safe_params,
        },
        "response": {
            "status_code": response_status,
            "json": _sanitize_record_value(response_payload),
        },
    }
    record_path = Path(destination).expanduser()
    try:
        record_path.parent.mkdir(parents=True, exist_ok=True)
        with record_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, sort_keys=True, separators=(",", ":")))
            handle.write("\n")
        record_path.chmod(0o600)
    except OSError as exc:
        log.warning("Could not write sanitized HTTP record to %s: %s", record_path, exc)


def _unit_from_payload(data: dict[str, Any]) -> UnitSummary:
    """Map a minimal unit payload."""
    return UnitSummary(
        id=data["id"],
        code=data["code"],
        name=data["name"],
        my_role=data.get("my_role"),
        start_date=data.get("start_date"),
        end_date=data.get("end_date"),
        active=data.get("active"),
    )


def _task_from_payload(data: dict[str, Any]) -> Task:
    """Map a task payload."""
    return Task(
        id=data["id"],
        task_definition_id=data["task_definition_id"],
        status=data["status"],
        due_date=data.get("due_date"),
        submission_date=data.get("submission_date"),
        completion_date=data.get("completion_date"),
        extensions=data.get("extensions"),
        times_assessed=data.get("times_assessed"),
        grade=data.get("grade"),
        quality_pts=data.get("quality_pts"),
        include_in_portfolio=data.get("include_in_portfolio"),
    )


def _task_definition_from_payload(data: dict[str, Any]) -> TaskDefinition:
    """Map a task definition payload."""
    return TaskDefinition(
        id=data["id"],
        abbreviation=data["abbreviation"],
        name=data["name"],
        description=data.get("description"),
        target_grade=data.get("target_grade"),
        start_date=data.get("start_date"),
        target_date=data.get("target_date"),
        due_date=data.get("due_date"),
        is_graded=data.get("is_graded"),
        max_quality_pts=data.get("max_quality_pts"),
    )


class OnTrackClient:
    """Small HTTP client for the OnTrack API."""

    def __init__(self, auth: AuthConfig) -> None:
        self.auth = auth
        self.session = requests.Session()
        self.session.headers.update(
            {
                "Accept": "application/json",
                "Username": auth.username,
                "Auth-Token": auth.auth_token,
            }
        )

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: dict[str, Any] | None = None,
    ) -> Any:
        """Perform a request and return parsed JSON."""
        url = f"{self.auth.base_url}{path}"
        response = self.session.request(
            method,
            url,
            params=params,
            json=json_body,
            timeout=DEFAULT_TIMEOUT,
        )

        try:
            record_payload = response.json()
        except ValueError:
            record_payload = None
        _record_http_pair(method, path, params, response.status_code, record_payload)

        if response.status_code in (401, 419):
            try:
                payload = response.json()
                message = payload.get("error") or payload.get("message") or response.text
            except ValueError:
                message = response.text or "Authentication failed."
            raise AuthError(message.strip() or "Authentication failed.")

        if response.status_code >= 400:
            try:
                payload = response.json()
                message = payload.get("error") or payload.get("message") or response.text
            except ValueError:
                message = response.text or f"HTTP {response.status_code}"
            raise OnTrackAPIError(message.strip() or f"HTTP {response.status_code}", response.status_code)

        if response.status_code == 204 or not response.content:
            return None

        try:
            return response.json()
        except ValueError as exc:
            raise OnTrackAPIError("The API returned invalid JSON.", response.status_code) from exc

    def get_auth_method(self) -> dict[str, Any]:
        """Read the public auth method configuration."""
        return self._request("GET", "/api/auth/method")

    def get_projects(self, include_inactive: bool = False) -> list[ProjectSummary]:
        """Fetch the current user's projects."""
        data = self._request("GET", "/api/projects", params={"include_inactive": include_inactive})
        if not isinstance(data, list):
            return []
        return [
            ProjectSummary(
                id=item["id"],
                unit=_unit_from_payload(item["unit"]),
                target_grade=item.get("target_grade"),
                portfolio_available=item.get("portfolio_available"),
                user_id=item.get("user_id"),
                unit_id=item.get("unit_id"),
            )
            for item in data
        ]

    def get_project(self, project_id: int) -> ProjectDetail:
        """Fetch a single project with task status data."""
        data = self._request("GET", f"/api/projects/{project_id}")
        if not isinstance(data, dict):
            raise OnTrackAPIError("Project response was not an object.")
        tasks = [_task_from_payload(item) for item in data.get("tasks", [])]
        return ProjectDetail(
            id=data["id"],
            unit=_unit_from_payload(data["unit"]),
            target_grade=data.get("target_grade"),
            submitted_grade=data.get("submitted_grade"),
            compile_portfolio=data.get("compile_portfolio"),
            portfolio_available=data.get("portfolio_available"),
            uses_draft_learning_summary=data.get("uses_draft_learning_summary"),
            tasks=tasks,
        )

    def get_unit(self, unit_id: int) -> UnitDetail:
        """Fetch a unit to resolve task definitions."""
        data = self._request("GET", f"/api/units/{unit_id}")
        if not isinstance(data, dict):
            raise OnTrackAPIError("Unit response was not an object.")
        summary = _unit_from_payload(data)
        task_definitions = [_task_definition_from_payload(item) for item in data.get("task_definitions", [])]
        return UnitDetail(
            summary=summary,
            description=data.get("description"),
            task_definitions=task_definitions,
        )

    def get_unit_roles(self, active_only: bool = True) -> list[UnitRole]:
        """Fetch teaching roles for the current user."""
        data = self._request("GET", "/api/unit_roles", params={"active_only": active_only})
        if not isinstance(data, list):
            return []
        roles: list[UnitRole] = []
        for item in data:
            user_data = item.get("user") or {}
            user = CachedUser(
                id=user_data.get("id"),
                username=user_data.get("username"),
                first_name=user_data.get("first_name"),
                last_name=user_data.get("last_name"),
                email=user_data.get("email"),
                nickname=user_data.get("nickname"),
            )
            roles.append(
                UnitRole(
                    id=item["id"],
                    role=item["role"],
                    unit=_unit_from_payload(item["unit"]),
                    user=user,
                )
            )
        return roles

    def check_access(self) -> dict[str, Any]:
        """Run a light auth check across the main student and staff entry points."""
        auth_method = self.get_auth_method()
        projects = self.get_projects(include_inactive=True)
        roles = self.get_unit_roles(active_only=False)
        return {
            "base_url": self.auth.base_url,
            "username": self.auth.username,
            "auth_method": auth_method.get("method"),
            "projects": len(projects),
            "unit_roles": len(roles),
            "cached_user": (
                {
                    "id": self.auth.cached_user.id,
                    "username": self.auth.cached_user.username,
                    "first_name": self.auth.cached_user.first_name,
                    "last_name": self.auth.cached_user.last_name,
                    "email": self.auth.cached_user.email,
                    "nickname": self.auth.cached_user.nickname,
                }
                if self.auth.cached_user
                else None
            ),
        }
