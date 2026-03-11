from click.testing import CliRunner

from ontrack_cli.cli import cli
from ontrack_cli.models import AuthConfig, ProjectDetail, ProjectSummary, Task, TaskDefinition, UnitDetail, UnitSummary


class FakeClient:
    def check_access(self):
        return {
            "base_url": "https://ontrack.infotech.monash.edu",
            "username": "alice",
            "auth_method": "saml",
            "projects": 1,
            "unit_roles": 0,
            "cached_user": None,
        }

    def get_projects(self, include_inactive=False):
        return [
            ProjectSummary(
                id=101,
                unit=UnitSummary(id=10, code="FIT1000", name="Algorithms", my_role="Student"),
                target_grade=2,
                portfolio_available=False,
            )
        ]

    def get_project(self, project_id):
        return ProjectDetail(
            id=project_id,
            unit=UnitSummary(id=10, code="FIT1000", name="Algorithms", my_role="Student"),
            target_grade=2,
            submitted_grade=None,
            compile_portfolio=False,
            portfolio_available=False,
            uses_draft_learning_summary=False,
            tasks=[
                Task(
                    id=201,
                    task_definition_id=301,
                    status="working_on_it",
                    due_date=None,
                    submission_date=None,
                    completion_date=None,
                    extensions=0,
                    times_assessed=0,
                    grade=None,
                    quality_pts=None,
                    include_in_portfolio=True,
                )
            ],
        )

    def get_unit(self, unit_id):
        return UnitDetail(
            summary=UnitSummary(id=unit_id, code="FIT1000", name="Algorithms", my_role="Student"),
            description="Unit description",
            task_definitions=[
                TaskDefinition(
                    id=301,
                    abbreviation="T1",
                    name="Task 1",
                    description="Intro task",
                    target_grade=0,
                    start_date="2026-03-01",
                    target_date="2026-03-15",
                    due_date="2026-03-22",
                    is_graded=False,
                    max_quality_pts=0,
                )
            ],
        )

    def get_unit_roles(self, active_only=True):
        return []


def _patch_runtime(monkeypatch):
    monkeypatch.setattr(
        "ontrack_cli.cli.load_auth_config",
        lambda: AuthConfig(
            base_url="https://ontrack.infotech.monash.edu",
            username="alice",
            auth_token="secret",
        ),
    )
    monkeypatch.setattr("ontrack_cli.cli.OnTrackClient", lambda auth: FakeClient())


def test_projects_json(monkeypatch):
    _patch_runtime(monkeypatch)
    runner = CliRunner()

    result = runner.invoke(cli, ["projects", "--json"])

    assert result.exit_code == 0
    assert '"code": "FIT1000"' in result.output
    assert '"target_grade": 2' in result.output


def test_user_json(monkeypatch):
    _patch_runtime(monkeypatch)
    runner = CliRunner()

    result = runner.invoke(cli, ["user", "--json"])

    assert result.exit_code == 0
    assert '"username": "alice"' in result.output
    assert '"auth_method": "saml"' in result.output


def test_project_json_merges_task_definition(monkeypatch):
    _patch_runtime(monkeypatch)
    runner = CliRunner()

    result = runner.invoke(cli, ["project", "101", "--json"])

    assert result.exit_code == 0
    assert '"abbreviation": "T1"' in result.output
    assert '"name": "Task 1"' in result.output
    assert '"status_label": "Working On It"' in result.output
