"""Authentication helpers that mirror moodle-cli's browser-first flow."""

from __future__ import annotations

import glob
import logging
import os
import sys
from urllib.parse import urlparse

import requests

from ontrack_cli.constants import DEFAULT_TIMEOUT
from ontrack_cli.exceptions import AuthError
from ontrack_cli.models import CachedUser

log = logging.getLogger(__name__)


def _glob_paths(patterns: list[str]) -> list[str]:
    """Expand filesystem glob patterns in a stable order."""
    paths: list[str] = []
    for pattern in patterns:
        paths.extend(sorted(glob.glob(os.path.expanduser(pattern))))
    return paths


def _chromium_cookie_files(browser: str) -> list[str]:
    """Return candidate cookie DB files for Chromium-based browsers."""
    platform_patterns = {
        "darwin": {
            "Chrome": [
                "~/Library/Application Support/Google/Chrome/Default/Cookies",
                "~/Library/Application Support/Google/Chrome/Guest Profile/Cookies",
                "~/Library/Application Support/Google/Chrome/Profile */Cookies",
            ],
            "Brave": [
                "~/Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies",
                "~/Library/Application Support/BraveSoftware/Brave-Browser/Guest Profile/Cookies",
                "~/Library/Application Support/BraveSoftware/Brave-Browser/Profile */Cookies",
            ],
            "Edge": [
                "~/Library/Application Support/Microsoft Edge/Default/Cookies",
                "~/Library/Application Support/Microsoft Edge/Guest Profile/Cookies",
                "~/Library/Application Support/Microsoft Edge/Profile */Cookies",
            ],
        },
        "linux": {
            "Chrome": [
                "~/.config/google-chrome/Default/Cookies",
                "~/.config/google-chrome/Profile */Cookies",
                "~/.var/app/com.google.Chrome/config/google-chrome/Default/Cookies",
                "~/.var/app/com.google.Chrome/config/google-chrome/Profile */Cookies",
            ],
            "Brave": [
                "~/.config/BraveSoftware/Brave-Browser/Default/Cookies",
                "~/.config/BraveSoftware/Brave-Browser/Profile */Cookies",
                "~/.var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser/Default/Cookies",
                "~/.var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser/Profile */Cookies",
            ],
            "Edge": [
                "~/.config/microsoft-edge/Default/Cookies",
                "~/.config/microsoft-edge/Profile */Cookies",
            ],
        },
        "win32": {
            "Chrome": [
                "~/AppData/Local/Google/Chrome/User Data/Default/Cookies",
                "~/AppData/Local/Google/Chrome/User Data/Default/Network/Cookies",
                "~/AppData/Local/Google/Chrome/User Data/Profile */Cookies",
                "~/AppData/Local/Google/Chrome/User Data/Profile */Network/Cookies",
            ],
            "Brave": [
                "~/AppData/Local/BraveSoftware/Brave-Browser/User Data/Default/Cookies",
                "~/AppData/Local/BraveSoftware/Brave-Browser/User Data/Default/Network/Cookies",
                "~/AppData/Local/BraveSoftware/Brave-Browser/User Data/Profile */Cookies",
                "~/AppData/Local/BraveSoftware/Brave-Browser/User Data/Profile */Network/Cookies",
            ],
            "Edge": [
                "~/AppData/Local/Microsoft/Edge/User Data/Default/Cookies",
                "~/AppData/Local/Microsoft/Edge/User Data/Default/Network/Cookies",
                "~/AppData/Local/Microsoft/Edge/User Data/Profile */Cookies",
                "~/AppData/Local/Microsoft/Edge/User Data/Profile */Network/Cookies",
            ],
        },
    }
    return _glob_paths(platform_patterns.get(sys.platform, {}).get(browser, []))


def _iter_browser_cookie_sets(domain: str):
    """Yield supported browser cookie jars profile by profile."""
    try:
        import browser_cookie3
    except ImportError as exc:
        raise AuthError(
            "browser-cookie3 is not installed, so automatic browser auth is unavailable."
        ) from exc

    loaders = [
        ("Chrome", browser_cookie3.chrome, _chromium_cookie_files("Chrome")),
        ("Firefox", browser_cookie3.firefox, [None]),
        ("Brave", browser_cookie3.brave, _chromium_cookie_files("Brave")),
        ("Edge", browser_cookie3.edge, _chromium_cookie_files("Edge")),
    ]

    for name, loader, cookie_files in loaders:
        attempts = cookie_files or [None]
        for cookie_file in attempts:
            try:
                kwargs = {"domain_name": domain}
                if cookie_file is not None:
                    kwargs["cookie_file"] = cookie_file
                yield name, cookie_file or "default profile", loader(**kwargs)
            except Exception as exc:
                log.debug("Could not read cookies from %s (%s): %s", name, cookie_file or "default profile", exc)


def _cookie_value(cookie_jar, domain: str, name: str) -> str | None:
    """Read a named cookie from the jar."""
    for cookie in cookie_jar:
        if cookie.name != name or not cookie.value:
            continue
        if domain in (cookie.domain or ""):
            return cookie.value
    return None


def _cookie_record_value(cookies: list[dict[str, str]], domain: str, name: str) -> str | None:
    """Read a named cookie from okta-auth cookie records."""
    for cookie in cookies:
        if cookie.get("name") != name:
            continue
        value = cookie.get("value")
        cookie_domain = cookie.get("domain") or ""
        if isinstance(value, str) and value and domain in cookie_domain:
            return value
    return None


def _exchange_refresh_token(base_url: str, cookie_jar, domain: str) -> tuple[str, CachedUser] | None:
    """Exchange browser refresh_token cookie for an auth token."""
    username = _cookie_value(cookie_jar, domain, "username")
    refresh_token = _cookie_value(cookie_jar, domain, "refresh_token")
    if not username or not refresh_token:
        return None

    session = requests.Session()
    for cookie in cookie_jar:
        if domain not in (cookie.domain or ""):
            continue
        session.cookies.set(cookie.name, cookie.value, domain=cookie.domain, path=cookie.path)

    response = session.post(
        f"{base_url}/api/auth/access-token",
        json={"delete_auth_token": False},
        timeout=DEFAULT_TIMEOUT,
    )
    if response.status_code >= 400:
        log.debug("Refresh-token exchange failed with %s", response.status_code)
        return None

    try:
        payload = response.json()
    except ValueError:
        return None

    if not isinstance(payload, dict):
        return None

    auth_token = payload.get("auth_token") or payload.get("access_token") or payload.get("token")
    user_data = payload.get("user") or {}
    if not auth_token or not isinstance(user_data, dict):
        return None

    user = CachedUser(
        id=user_data.get("id"),
        username=user_data.get("username") or username,
        authentication_token=auth_token,
        first_name=user_data.get("first_name") or user_data.get("firstName"),
        last_name=user_data.get("last_name") or user_data.get("lastName"),
        email=user_data.get("email"),
        nickname=user_data.get("nickname"),
    )
    return auth_token, user


def _exchange_refresh_token_from_records(
    base_url: str,
    cookies: list[dict[str, str]],
    domain: str,
) -> tuple[str, CachedUser] | None:
    """Exchange okta-auth cookie records for an auth token."""
    username = _cookie_record_value(cookies, domain, "username")
    refresh_token = _cookie_record_value(cookies, domain, "refresh_token")
    if not username or not refresh_token:
        return None

    session = requests.Session()
    for cookie in cookies:
        cookie_domain = cookie.get("domain") or ""
        if domain not in cookie_domain:
            continue
        value = cookie.get("value")
        name = cookie.get("name")
        if not isinstance(name, str) or not isinstance(value, str):
            continue
        session.cookies.set(name, value, domain=cookie_domain, path=cookie.get("path") or "/")

    response = session.post(
        f"{base_url}/api/auth/access-token",
        json={"delete_auth_token": False},
        timeout=DEFAULT_TIMEOUT,
    )
    if response.status_code >= 400:
        log.debug("okta-auth refresh-token exchange failed with %s", response.status_code)
        return None

    try:
        payload = response.json()
    except ValueError:
        return None

    if not isinstance(payload, dict):
        return None

    auth_token = payload.get("auth_token") or payload.get("access_token") or payload.get("token")
    user_data = payload.get("user") or {}
    if not auth_token or not isinstance(user_data, dict):
        return None

    user = CachedUser(
        id=user_data.get("id"),
        username=user_data.get("username") or username,
        authentication_token=auth_token,
        first_name=user_data.get("first_name") or user_data.get("firstName"),
        last_name=user_data.get("last_name") or user_data.get("lastName"),
        email=user_data.get("email"),
        nickname=user_data.get("nickname"),
    )
    return auth_token, user


def _is_valid_token(base_url: str, username: str, auth_token: str) -> bool:
    """Check whether the candidate token can access projects."""
    response = requests.get(
        f"{base_url}/api/projects",
        headers={"Username": username, "Auth-Token": auth_token, "Accept": "application/json"},
        params={"include_inactive": True},
        timeout=DEFAULT_TIMEOUT,
    )
    return response.status_code == 200


def get_browser_auth(base_url: str) -> tuple[str, str, CachedUser] | None:
    """Try to resolve OnTrack auth from supported browsers."""
    domain = urlparse(base_url).hostname or ""
    for browser_name, source, cookie_jar in _iter_browser_cookie_sets(domain):
        exchanged = _exchange_refresh_token(base_url, cookie_jar, domain)
        if exchanged is None:
            continue
        auth_token, user = exchanged
        username = user.username or _cookie_value(cookie_jar, domain, "username")
        if not username:
            continue
        if _is_valid_token(base_url, username, auth_token):
            log.debug("Using browser auth from %s (%s)", browser_name, source)
            return username, auth_token, user
    return None


def get_okta_auth(base_url: str) -> tuple[str, str, CachedUser] | None:
    """Try to resolve OnTrack auth through okta-auth's local session store."""
    try:
        from okta_auth.adapter import OktaAdapterError, ensure_login, get_cookies
    except ImportError:
        return None

    domain = urlparse(base_url).hostname or ""

    def resolve_from_okta_cookies() -> tuple[str, str, CachedUser] | None:
        cookies = get_cookies(base_url)
        exchanged = _exchange_refresh_token_from_records(base_url, cookies, domain)
        if exchanged is None:
            return None
        auth_token, user = exchanged
        username = user.username or _cookie_record_value(cookies, domain, "username")
        if not username:
            return None
        if _is_valid_token(base_url, username, auth_token):
            return username, auth_token, user
        return None

    try:
        existing = resolve_from_okta_cookies()
        if existing is not None:
            log.debug("Using OnTrack auth from okta-auth")
            return existing
        ensure_login(base_url)
        refreshed = resolve_from_okta_cookies()
        if refreshed is not None:
            log.debug("Using OnTrack auth from okta-auth after automatic login")
        return refreshed
    except OktaAdapterError as exc:
        log.debug("okta-auth could not establish an OnTrack session for %s: %s", base_url, exc)
        return None
