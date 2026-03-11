"""Config loading and validation."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import click
import requests
import yaml

from ontrack_cli.auth import get_browser_auth
from ontrack_cli.constants import (
    CONFIG_DIR,
    CONFIG_FILENAME,
    ENV_ONTRACK_AUTH_TOKEN,
    ENV_ONTRACK_BASE_URL,
    ENV_ONTRACK_CONFIG,
    ENV_ONTRACK_USER_JSON,
    ENV_ONTRACK_USERNAME,
)
from ontrack_cli.exceptions import ConfigError
from ontrack_cli.models import AuthConfig, CachedUser


def _candidate_config_paths() -> list[Path]:
    """Return config paths in resolution order."""
    if os.getenv(ENV_ONTRACK_CONFIG):
        return [Path(os.environ[ENV_ONTRACK_CONFIG]).expanduser()]

    return [
        Path.cwd() / CONFIG_FILENAME,
        Path(CONFIG_DIR).expanduser() / CONFIG_FILENAME,
    ]


def _find_config_file() -> Path | None:
    """Search for config.yaml in CWD, then ~/.config/ontrack-cli/."""
    for path in _candidate_config_paths():
        if path.is_file():
            return path
    return None


def _default_config_path() -> Path:
    """Pick the default location for a new config file."""
    cwd_config = Path.cwd() / CONFIG_FILENAME
    if cwd_config.exists():
        return cwd_config
    return Path(CONFIG_DIR).expanduser() / CONFIG_FILENAME


def _read_config_file(path: Path) -> dict[str, Any]:
    """Read a YAML config file."""
    with path.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle) or {}
    if not isinstance(data, dict):
        raise ConfigError(f"Config file {path} must contain a YAML mapping.")
    return data


def _save_config(path: Path, config: dict[str, Any]) -> None:
    """Persist config to disk."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        yaml.safe_dump(config, handle, sort_keys=True)


def _load_existing_config() -> tuple[dict[str, Any], Path | None]:
    """Load config if present."""
    config_file = _find_config_file()
    config = _read_config_file(config_file) if config_file else {}
    return config, config_file


def _validate_base_url(value: str) -> str:
    """Validate that the configured URL is a site root."""
    raw = value.strip()
    if not raw:
        raise ConfigError("Base URL cannot be empty.")
    if "://" not in raw:
        raise ConfigError("Base URL must include the scheme, for example https://school.example.edu")

    parsed = urlparse(raw)
    if parsed.scheme not in {"http", "https"}:
        raise ConfigError("Base URL must start with http:// or https://")
    if not parsed.hostname:
        raise ConfigError("Base URL must include a hostname")
    if parsed.query or parsed.fragment:
        raise ConfigError("Base URL must not include query parameters or fragments")
    if parsed.path not in {"", "/"}:
        raise ConfigError("Base URL must be the site root, for example https://school.example.edu")

    return f"{parsed.scheme}://{parsed.netloc}".rstrip("/")


def _missing_base_url_message(config_file: Path | None) -> str:
    """Build an actionable error for missing base_url."""
    target_path = config_file or _default_config_path()
    return "\n".join(
        [
            "No base_url configured.",
            f"Add base_url to {target_path} or set {ENV_ONTRACK_BASE_URL}.",
            "Required format:",
            "  base_url: https://school.example.edu",
            "Use the site root only. Do not include paths, query strings, or fragments.",
        ]
    )


def _probe_base_url(base_url: str) -> tuple[bool, str]:
    """Check whether the configured URL exposes the expected auth endpoint."""
    try:
        response = requests.get(
            f"{base_url}/api/auth/method",
            timeout=10,
            allow_redirects=True,
            headers={"Accept": "application/json"},
        )
    except requests.RequestException as exc:
        return False, f"Could not reach {base_url}: {exc}"

    if response.status_code >= 400:
        return False, f"{base_url} returned HTTP {response.status_code}"

    try:
        payload = response.json()
    except ValueError:
        return False, f"{base_url} did not return JSON from /api/auth/method"

    if isinstance(payload, dict) and payload.get("method"):
        return True, ""
    return False, f"{base_url} does not expose the expected OnTrack auth endpoint"


def _prompt_for_base_url() -> str:
    """Prompt for base_url interactively."""
    click.secho("\nConfiguration required", fg="yellow", bold=True)
    click.secho("OnTrack base URL is not configured yet.", fg="yellow")
    click.secho("Required format: https://school.example.edu", fg="cyan", bold=True)
    click.echo("Use the site root only. Do not include paths, query strings, or fragments.")
    click.echo()

    while True:
        try:
            base_url = _validate_base_url(
                click.prompt(
                    click.style("OnTrack base URL", fg="green", bold=True),
                    prompt_suffix=click.style(" > ", fg="green", bold=True),
                    type=str,
                )
            )
        except ConfigError as exc:
            click.secho(f"Invalid URL: {exc}", fg="red")
            continue

        looks_valid, message = _probe_base_url(base_url)
        if looks_valid:
            return base_url

        click.secho(f"Validation failed: {message}", fg="red")


def load_base_config() -> tuple[dict[str, Any], Path | None]:
    """Load config and require an explicit base_url."""
    config, config_file = _load_existing_config()

    if env_url := os.environ.get(ENV_ONTRACK_BASE_URL):
        config["base_url"] = _validate_base_url(env_url)
        return config, config_file

    if base_url := config.get("base_url"):
        config["base_url"] = _validate_base_url(str(base_url))
        return config, config_file

    if click.get_text_stream("stdin").isatty():
        config["base_url"] = _prompt_for_base_url()
        target_path = config_file or _default_config_path()
        _save_config(target_path, config)
        click.echo(f"Saved base_url to {target_path}")
        return config, target_path

    raise ConfigError(_missing_base_url_message(config_file))


def _parse_cached_user(value: Any) -> CachedUser | None:
    """Parse a cached Doubtfire user from JSON text or a mapping."""
    if value in (None, "", {}):
        return None

    if isinstance(value, str):
        try:
            payload = json.loads(value)
        except json.JSONDecodeError as exc:
            raise ConfigError(f"Invalid {ENV_ONTRACK_USER_JSON} payload.") from exc
    elif isinstance(value, dict):
        payload = value
    else:
        raise ConfigError("doubtfire_user data must be a JSON string or a mapping.")

    if not isinstance(payload, dict):
        raise ConfigError("doubtfire_user payload must decode to an object.")

    token = payload.get("authenticationToken") or payload.get("authentication_token")
    return CachedUser(
        id=payload.get("id"),
        username=payload.get("username"),
        authentication_token=token,
        first_name=payload.get("first_name") or payload.get("firstName"),
        last_name=payload.get("last_name") or payload.get("lastName"),
        email=payload.get("email"),
        nickname=payload.get("nickname"),
    )


def load_auth_config() -> AuthConfig:
    """Resolve auth config from env vars, config, and browser state."""
    config, _ = load_base_config()
    base_url = config["base_url"]

    cached_user = _parse_cached_user(
        os.getenv(ENV_ONTRACK_USER_JSON) or config.get("doubtfire_user_json") or config.get("doubtfire_user")
    )

    username = os.getenv(ENV_ONTRACK_USERNAME) or config.get("username") or (cached_user.username if cached_user else None)
    auth_token = (
        os.getenv(ENV_ONTRACK_AUTH_TOKEN)
        or config.get("auth_token")
        or (cached_user.authentication_token if cached_user else None)
    )

    if not username or not auth_token:
        browser_auth = get_browser_auth(base_url)
        if browser_auth is not None:
            username, auth_token, browser_user = browser_auth
            cached_user = browser_user

    if not username or not auth_token:
        raise ConfigError(
            "Missing OnTrack credentials. The CLI tried environment variables, config.yaml, "
            "cached doubfire_user JSON, and browser cookies. "
            "Either log in to OnTrack in Chrome/Firefox/Brave/Edge first, "
            f"or set {ENV_ONTRACK_USERNAME} and {ENV_ONTRACK_AUTH_TOKEN} explicitly."
        )

    return AuthConfig(
        base_url=base_url,
        username=username,
        auth_token=auth_token,
        cached_user=cached_user,
    )
