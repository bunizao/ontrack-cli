"""Dataclasses for API responses and CLI rendering."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(slots=True)
class CachedUser:
    """A user object copied from browser localStorage."""

    id: int | None = None
    username: str | None = None
    authentication_token: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    email: str | None = None
    nickname: str | None = None

    @property
    def display_name(self) -> str:
        """Return the best available display name."""
        full_name = " ".join(part for part in [self.first_name, self.last_name] if part)
        return full_name or self.nickname or self.username or "Unknown user"

    def to_dict(self) -> dict:
        """Serialize for JSON or YAML output."""
        return {
            "id": self.id,
            "username": self.username,
            "authentication_token": self.authentication_token,
            "first_name": self.first_name,
            "last_name": self.last_name,
            "email": self.email,
            "nickname": self.nickname,
        }


@dataclass(slots=True)
class AuthConfig:
    """Resolved auth configuration for the CLI."""

    base_url: str
    username: str
    auth_token: str
    cached_user: CachedUser | None = None


@dataclass(slots=True)
class UnitSummary:
    """Minimal unit details returned by project and unit role endpoints."""

    id: int
    code: str
    name: str
    my_role: str | None = None
    start_date: str | None = None
    end_date: str | None = None
    active: bool | None = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "code": self.code,
            "name": self.name,
            "my_role": self.my_role,
            "start_date": self.start_date,
            "end_date": self.end_date,
            "active": self.active,
        }


@dataclass(slots=True)
class TaskDefinition:
    """Task definition details from the unit payload."""

    id: int
    abbreviation: str
    name: str
    description: str | None = None
    target_grade: int | None = None
    start_date: str | None = None
    target_date: str | None = None
    due_date: str | None = None
    is_graded: bool | None = None
    max_quality_pts: int | None = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "abbreviation": self.abbreviation,
            "name": self.name,
            "description": self.description,
            "target_grade": self.target_grade,
            "start_date": self.start_date,
            "target_date": self.target_date,
            "due_date": self.due_date,
            "is_graded": self.is_graded,
            "max_quality_pts": self.max_quality_pts,
        }


@dataclass(slots=True)
class Task:
    """Task status data from the project payload."""

    id: int
    task_definition_id: int
    status: str
    due_date: str | None = None
    submission_date: str | None = None
    completion_date: str | None = None
    extensions: int | None = None
    times_assessed: int | None = None
    grade: int | None = None
    quality_pts: int | None = None
    include_in_portfolio: bool | None = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "task_definition_id": self.task_definition_id,
            "status": self.status,
            "due_date": self.due_date,
            "submission_date": self.submission_date,
            "completion_date": self.completion_date,
            "extensions": self.extensions,
            "times_assessed": self.times_assessed,
            "grade": self.grade,
            "quality_pts": self.quality_pts,
            "include_in_portfolio": self.include_in_portfolio,
        }


@dataclass(slots=True)
class ProjectSummary:
    """Project summary returned by GET /api/projects."""

    id: int
    unit: UnitSummary
    target_grade: int | None = None
    portfolio_available: bool | None = None
    user_id: int | None = None
    unit_id: int | None = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "unit": self.unit.to_dict(),
            "target_grade": self.target_grade,
            "portfolio_available": self.portfolio_available,
            "user_id": self.user_id,
            "unit_id": self.unit_id,
        }


@dataclass(slots=True)
class ProjectDetail:
    """Detailed project view returned by GET /api/projects/:id."""

    id: int
    unit: UnitSummary
    target_grade: int | None = None
    submitted_grade: int | None = None
    compile_portfolio: bool | None = None
    portfolio_available: bool | None = None
    uses_draft_learning_summary: bool | None = None
    tasks: list[Task] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "unit": self.unit.to_dict(),
            "target_grade": self.target_grade,
            "submitted_grade": self.submitted_grade,
            "compile_portfolio": self.compile_portfolio,
            "portfolio_available": self.portfolio_available,
            "uses_draft_learning_summary": self.uses_draft_learning_summary,
            "tasks": [task.to_dict() for task in self.tasks],
        }


@dataclass(slots=True)
class UnitDetail:
    """Detailed unit view used to resolve task definition metadata."""

    summary: UnitSummary
    description: str | None = None
    task_definitions: list[TaskDefinition] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "summary": self.summary.to_dict(),
            "description": self.description,
            "task_definitions": [task_def.to_dict() for task_def in self.task_definitions],
        }


@dataclass(slots=True)
class UnitRole:
    """Teaching role summary."""

    id: int
    role: str
    unit: UnitSummary
    user: CachedUser | None = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "role": self.role,
            "unit": self.unit.to_dict(),
            "user": self.user.to_dict() if self.user else None,
        }
