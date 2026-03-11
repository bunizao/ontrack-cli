"""Rich output helpers."""

from __future__ import annotations

from datetime import date

from rich.console import Console
from rich.table import Table

from ontrack_cli.constants import FINAL_TASK_STATUSES, GRADE_ACRONYMS, GRADE_LABELS, TASK_STATUS_LABELS
from ontrack_cli.models import ProjectDetail, ProjectSummary, TaskDefinition, UnitDetail, UnitRole

console = Console()


def grade_label(grade: int | None) -> str:
    """Render a human-friendly grade label."""
    if grade is None:
        return "-"
    acronym = GRADE_ACRONYMS.get(grade)
    label = GRADE_LABELS.get(grade)
    if not acronym or not label:
        return str(grade)
    return f"{acronym} ({label})"


def build_task_rows(project: ProjectDetail, unit: UnitDetail) -> list[dict]:
    """Merge task status rows with task definition metadata."""
    task_definitions = {item.id: item for item in unit.task_definitions}
    rows: list[dict] = []
    today = date.today().isoformat()

    for task in project.tasks:
        task_def: TaskDefinition | None = task_definitions.get(task.task_definition_id)
        effective_due = task.due_date or (task_def.target_date if task_def else None)
        deadline = task_def.due_date if task_def else None
        is_overdue = bool(
            effective_due
            and effective_due < today
            and task.status not in FINAL_TASK_STATUSES
        )
        rows.append(
            {
                "id": task.id,
                "task_definition_id": task.task_definition_id,
                "abbreviation": task_def.abbreviation if task_def else f"TD-{task.task_definition_id}",
                "name": task_def.name if task_def else "Unknown task",
                "status": task.status,
                "status_label": TASK_STATUS_LABELS.get(task.status, task.status),
                "target_grade": task_def.target_grade if task_def else None,
                "target_grade_label": grade_label(task_def.target_grade if task_def else None),
                "start_date": task_def.start_date if task_def else None,
                "target_date": task_def.target_date if task_def else None,
                "due_date": effective_due,
                "deadline": deadline,
                "submission_date": task.submission_date,
                "completion_date": task.completion_date,
                "extensions": task.extensions,
                "grade": task.grade,
                "grade_label": grade_label(task.grade),
                "quality_pts": task.quality_pts,
                "include_in_portfolio": task.include_in_portfolio,
                "is_overdue": is_overdue,
            }
        )

    rows.sort(key=lambda item: (item["due_date"] or "9999-99-99", item["abbreviation"]))
    return rows


def print_projects(projects: list[ProjectSummary]) -> None:
    """Print project summary table."""
    table = Table(title="Projects")
    table.add_column("ID", justify="right")
    table.add_column("Unit")
    table.add_column("Role")
    table.add_column("Target")
    table.add_column("Portfolio")
    table.add_column("Dates")

    for project in projects:
        unit_label = f"{project.unit.code}  {project.unit.name}"
        date_label = " - ".join(
            value for value in [project.unit.start_date, project.unit.end_date] if value
        ) or "-"
        table.add_row(
            str(project.id),
            unit_label,
            project.unit.my_role or "-",
            grade_label(project.target_grade),
            "Ready" if project.portfolio_available else "-",
            date_label,
        )

    console.print(table)


def print_project_detail(project: ProjectDetail, unit: UnitDetail) -> None:
    """Print project overview and task table."""
    header = Table(show_header=False, box=None)
    header.add_column(style="bold")
    header.add_column()
    header.add_row("Project", str(project.id))
    header.add_row("Unit", f"{project.unit.code}  {project.unit.name}")
    header.add_row("Role", project.unit.my_role or "-")
    header.add_row("Target Grade", grade_label(project.target_grade))
    header.add_row("Submitted Grade", grade_label(project.submitted_grade))
    header.add_row("Portfolio", "Ready" if project.portfolio_available else "Not ready")
    console.print(header)
    print_task_rows(build_task_rows(project, unit))


def print_task_rows(rows: list[dict]) -> None:
    """Print merged task rows."""
    table = Table(title="Tasks")
    table.add_column("Task")
    table.add_column("Name")
    table.add_column("Status")
    table.add_column("Due")
    table.add_column("Deadline")
    table.add_column("Target")
    table.add_column("Grade")

    for row in rows:
        status = row["status_label"]
        if row["is_overdue"]:
            status = f"[red]{status}[/]"
        table.add_row(
            row["abbreviation"],
            row["name"],
            status,
            row["due_date"] or "-",
            row["deadline"] or "-",
            row["target_grade_label"],
            row["grade_label"],
        )

    console.print(table)


def print_roles(roles: list[UnitRole]) -> None:
    """Print teaching roles table."""
    table = Table(title="Unit Roles")
    table.add_column("Role")
    table.add_column("Unit")
    table.add_column("Dates")

    for role in roles:
        unit_label = f"{role.unit.code}  {role.unit.name}"
        date_label = " - ".join(value for value in [role.unit.start_date, role.unit.end_date] if value) or "-"
        table.add_row(role.role, unit_label, date_label)

    console.print(table)
