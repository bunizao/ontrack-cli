# ontrack-cli

Terminal-first CLI for OnTrack that reuses your authenticated browser session.

`ontrack-cli` targets Doubtfire / OnTrack deployments and is designed for quick terminal access to your projects, tasks, and teaching roles without building a separate login flow.

## Features

- No manual API token setup in the common case
- Reads browser auth state from Chrome, Firefox, Brave, or Edge when available
- Prompts for `base_url` on first run and saves it like `moodle-cli`
- Lists projects, merged task views, and teaching roles
- Supports terminal output plus `--json` and `--yaml`

## Requirements

- Python 3.10+
- `uv` or `pipx`
- An authenticated OnTrack browser session, or explicit credentials

## Install

```bash
# Recommended: uv tool
uv tool install ontrack-cli

# Alternative: pipx
pipx install ontrack-cli
```

Install from source:

```bash
git clone https://github.com/bunizao/ontrack-cli.git
cd ontrack-cli
uv sync
```

## Usage

```bash
ontrack --help
ontrack user
ontrack auth check
ontrack projects
ontrack project 12345
ontrack tasks 12345
ontrack roles
```

Structured output:

```bash
ontrack projects --json
ontrack project 12345 --yaml
```

To upgrade after a new release:

```bash
uv tool upgrade ontrack-cli
# or
pipx upgrade ontrack-cli
```

## Configuration

On first run, if no `base_url` is configured, the CLI prompts for it and writes it to `config.yaml` in the project directory or in `~/.config/ontrack-cli/`:

```yaml
base_url: https://school.example.edu
```

Required format:

- Use a full root URL such as `https://school.example.edu`
- Do not include paths, query strings, or fragments
- Do not use URLs like `/home`, `/#/projects`, or `/api/auth`
- The CLI validates the URL against `/api/auth/method` and asks again if it does not look like an OnTrack site

You can also set `ONTRACK_BASE_URL` instead of using the interactive prompt.
You can copy from [config.example.yaml](config.example.yaml).

Environment overrides:

- `ONTRACK_BASE_URL`
- `ONTRACK_USERNAME`
- `ONTRACK_AUTH_TOKEN`
- `ONTRACK_DOUBTFIRE_USER_JSON`

## Authentication

Default behavior:

1. Resolve `base_url`
2. Try browser cookies
3. Exchange OnTrack's browser `refresh_token` for an API auth token when supported
4. Fall back to explicit environment variables or config values

If browser auto-auth does not work, you can still provide credentials manually:

```bash
export ONTRACK_BASE_URL='https://school.example.edu'
export ONTRACK_USERNAME='your_username'
export ONTRACK_AUTH_TOKEN='your_auth_token'
```

You can also reuse the front-end cached user object:

1. Open an authenticated OnTrack page
2. Open DevTools Console
3. Run:

```js
copy(localStorage.getItem('doubtfire_user'))
```

4. Export it:

```bash
export ONTRACK_DOUBTFIRE_USER_JSON='{"id":123,"username":"your_username","authenticationToken":"..."}'
```

## Commands

- `ontrack user`: show the resolved signed-in user
- `ontrack auth check`: validate access and show a quick auth summary
- `ontrack projects`: list the current user's projects
- `ontrack project <project_id>`: show a project with merged task definition metadata
- `ontrack tasks <project_id>`: list task rows for a project
- `ontrack roles`: list teaching roles for the current user

## Development

```bash
uv run pytest -q
uv run python -m compileall ontrack_cli
uv build
```

## Notes

- The CLI is built around Doubtfire / OnTrack API behavior
- Browser-based auto-auth works best when you are already signed in to the target site
- Some deployments expose `POST /api/auth/access-token`, which allows clean browser-session reuse
