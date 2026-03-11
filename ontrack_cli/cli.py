"""CLI entry point."""

from __future__ import annotations

import sys

import click
from rich.console import Console

from ontrack_cli import __version__
from ontrack_cli.client import OnTrackClient
from ontrack_cli.config import load_auth_config
from ontrack_cli.exceptions import AuthError, ConfigError, OnTrackAPIError, OnTrackCLIError
from ontrack_cli.formatter import build_task_rows, print_project_detail, print_projects, print_roles, print_task_rows
from ontrack_cli.output import output_json, output_yaml

stdout_console = Console()
stderr_console = Console(stderr=True)


def _emit(data: object, *, as_json: bool, as_yaml: bool, printer) -> None:
    """Emit structured output or rich tables."""
    if as_json:
        output_json(data)
    elif as_yaml:
        output_yaml(data)
    else:
        printer()


@click.group()
@click.version_option(version=__version__)
@click.pass_context
def cli(ctx: click.Context) -> None:
    """Terminal-first CLI for OnTrack."""
    ctx.ensure_object(dict)
    ctx.obj["_auth"] = None
    ctx.obj["_client"] = None

    def get_auth():
        if ctx.obj["_auth"] is None:
            ctx.obj["_auth"] = load_auth_config()
        return ctx.obj["_auth"]

    def get_client() -> OnTrackClient:
        if ctx.obj["_client"] is None:
            ctx.obj["_client"] = OnTrackClient(get_auth())
        return ctx.obj["_client"]

    ctx.obj["get_auth"] = get_auth
    ctx.obj["get_client"] = get_client


@cli.group()
def auth() -> None:
    """Authentication helpers."""


@auth.command("check")
@click.option("--json", "as_json", is_flag=True, help="Output as JSON.")
@click.option("--yaml", "as_yaml", is_flag=True, help="Output as YAML.")
@click.pass_context
def auth_check(ctx: click.Context, as_json: bool, as_yaml: bool) -> None:
    """Validate current credentials."""
    client = ctx.obj["get_client"]()
    info = client.check_access()

    _emit(
        info,
        as_json=as_json,
        as_yaml=as_yaml,
        printer=lambda: stdout_console.print(
            "\n".join(
                [
                    f"Base URL: {info['base_url']}",
                    f"Username: {info['username']}",
                    f"Auth method: {info['auth_method'] or 'unknown'}",
                    f"Projects: {info['projects']}",
                    f"Unit roles: {info['unit_roles']}",
                ]
            )
        ),
    )


@cli.command()
@click.option("--json", "as_json", is_flag=True, help="Output as JSON.")
@click.option("--yaml", "as_yaml", is_flag=True, help="Output as YAML.")
@click.pass_context
def user(ctx: click.Context, as_json: bool, as_yaml: bool) -> None:
    """Show the resolved signed-in user."""
    auth = ctx.obj["get_auth"]()
    client = ctx.obj["get_client"]()
    info = client.check_access()
    payload = (
        {
            "id": auth.cached_user.id,
            "username": auth.cached_user.username,
            "first_name": auth.cached_user.first_name,
            "last_name": auth.cached_user.last_name,
            "email": auth.cached_user.email,
            "nickname": auth.cached_user.nickname,
        }
        if auth.cached_user
        else {"username": auth.username}
    )
    payload["base_url"] = auth.base_url
    payload["auth_method"] = info.get("auth_method")

    _emit(
        payload,
        as_json=as_json,
        as_yaml=as_yaml,
        printer=lambda: stdout_console.print(
            "\n".join(
                [
                    f"User: {payload.get('username')}",
                    f"Name: {' '.join(part for part in [payload.get('first_name'), payload.get('last_name')] if part) or payload.get('nickname') or '-'}",
                    f"Email: {payload.get('email') or '-'}",
                    f"Base URL: {payload['base_url']}",
                    f"Auth method: {payload.get('auth_method') or 'unknown'}",
                ]
            )
        ),
    )


@cli.command()
@click.option("--include-inactive", is_flag=True, help="Include inactive projects.")
@click.option("--json", "as_json", is_flag=True, help="Output as JSON.")
@click.option("--yaml", "as_yaml", is_flag=True, help="Output as YAML.")
@click.pass_context
def projects(ctx: click.Context, include_inactive: bool, as_json: bool, as_yaml: bool) -> None:
    """List the current user's projects."""
    client = ctx.obj["get_client"]()
    items = client.get_projects(include_inactive=include_inactive)
    payload = [item.to_dict() for item in items]

    _emit(payload, as_json=as_json, as_yaml=as_yaml, printer=lambda: print_projects(items))


@cli.command()
@click.argument("project_id", type=int)
@click.option("--json", "as_json", is_flag=True, help="Output as JSON.")
@click.option("--yaml", "as_yaml", is_flag=True, help="Output as YAML.")
@click.pass_context
def project(ctx: click.Context, project_id: int, as_json: bool, as_yaml: bool) -> None:
    """Show a project with merged task definitions."""
    client = ctx.obj["get_client"]()
    item = client.get_project(project_id)
    unit = client.get_unit(item.unit.id)
    task_rows = build_task_rows(item, unit)
    payload = {
        "project": item.to_dict(),
        "unit": unit.to_dict(),
        "tasks": task_rows,
    }

    _emit(payload, as_json=as_json, as_yaml=as_yaml, printer=lambda: print_project_detail(item, unit))


@cli.command()
@click.argument("project_id", type=int)
@click.option("--status", "statuses", multiple=True, help="Filter by raw status key.")
@click.option("--json", "as_json", is_flag=True, help="Output as JSON.")
@click.option("--yaml", "as_yaml", is_flag=True, help="Output as YAML.")
@click.pass_context
def tasks(
    ctx: click.Context,
    project_id: int,
    statuses: tuple[str, ...],
    as_json: bool,
    as_yaml: bool,
) -> None:
    """Show task rows for a project."""
    client = ctx.obj["get_client"]()
    item = client.get_project(project_id)
    unit = client.get_unit(item.unit.id)
    rows = build_task_rows(item, unit)

    if statuses:
        allowed = set(statuses)
        rows = [row for row in rows if row["status"] in allowed]

    _emit(rows, as_json=as_json, as_yaml=as_yaml, printer=lambda: print_task_rows(rows))


@cli.command()
@click.option("--all", "show_all", is_flag=True, help="Include inactive roles.")
@click.option("--json", "as_json", is_flag=True, help="Output as JSON.")
@click.option("--yaml", "as_yaml", is_flag=True, help="Output as YAML.")
@click.pass_context
def roles(ctx: click.Context, show_all: bool, as_json: bool, as_yaml: bool) -> None:
    """List unit roles for the current user."""
    client = ctx.obj["get_client"]()
    items = client.get_unit_roles(active_only=not show_all)
    payload = [item.to_dict() for item in items]

    _emit(payload, as_json=as_json, as_yaml=as_yaml, printer=lambda: print_roles(items))


def main() -> None:
    """CLI entry point with consistent error handling."""
    try:
        cli(standalone_mode=False)
    except click.exceptions.Abort:
        sys.exit(130)
    except click.exceptions.Exit as exc:
        sys.exit(exc.exit_code)
    except click.ClickException as exc:
        exc.show()
        sys.exit(exc.exit_code)
    except ConfigError as exc:
        stderr_console.print(f"[bold red]Config error:[/] {exc}")
        sys.exit(1)
    except AuthError as exc:
        stderr_console.print(f"[bold red]Auth error:[/] {exc}")
        sys.exit(1)
    except OnTrackAPIError as exc:
        stderr_console.print(f"[bold red]API error:[/] {exc}")
        sys.exit(1)
    except OnTrackCLIError as exc:
        stderr_console.print(f"[bold red]Error:[/] {exc}")
        sys.exit(1)


if __name__ == "__main__":
    main()
