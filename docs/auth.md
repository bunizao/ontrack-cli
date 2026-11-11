# Signing in

The [README](../README.md#set-up) has the short version. This page covers every sign-in path, where the session is kept, how renewal works, and the diagnostics.

`auth login` offers three sign-in paths in a terminal. The recommended path opens Chrome, Edge, Brave, or Chromium with a private CLI profile. Complete your institution's sign-in in that window; the CLI captures and validates the OnTrack session automatically, without reading your normal browser's files or asking you to paste anything.

## Choose a path

```bash
ontrack auth login --browser
ontrack auth login --reuse-browser
ontrack auth login --paste
```

`--reuse-browser` tries your existing browser session with a bounded cookie-store read. If reuse is unavailable, it opens your SAML sign-in page and prints a one-time snippet to paste into the OnTrack tab's DevTools console. `--manual` goes straight to that snippet flow.

`--paste` reads credentials without echoing them. It accepts the Cookie header or cURL command for your site's `/api/auth/access-token` request, or its response JSON. A bare refresh cookie requires `--username USERNAME`. Multi-line pastes stay together. Scripts can pipe the credentials through stdin; keep them out of command arguments and shell history. Pasted access tokens are verified against a protected endpoint before saving.

## Sign in through Okta, no browser

If your site signs in through Okta (Monash does), `--okta` signs in with plain HTTP using the credentials [okta-auth](https://github.com/bunizao/okta-auth) holds, and renews by itself from then on:

It needs okta-auth-cli 0.3.0 or later (`npm install -g okta-auth-cli`, or `uv tool upgrade okta-auth-cli` for the Python one); 0.2.x has no `export`.

```bash
okta-auth setup            # once: username, password and TOTP secret, in the Keychain or 1Password
                           # (`okta setup` with the Python okta-auth-cli)
ontrack auth login --okta
```

The CLI runs `okta export --dangerously-print-password-and-totp-secret` (or `okta-auth export …` when only the npm package is installed) into a pipe, signs in at the Okta app OnTrack names, and exchanges the one-time token OnTrack hands back for a remembered session, so the seven-day refresh cookie is issued. Nothing from Okta is printed except host names and steps. The password and TOTP secret are never written to the session cache; Okta's device token and session are, encrypted. `--okta` refuses to replace a cached session for a different OnTrack account; run `auth logout` first.

Doubtfire never extends the refresh cookie, so after an Okta sign-in the CLI signs in through Okta again whenever a token needs renewing and the refresh cookie is gone or has under 48 hours left. It prints one line to stderr. A rejected password, a rejected one-time code, a second factor other than TOTP, or a different OnTrack account stops automatic sign-in at once, and five failures in a row (with backoff from one minute) stop it too: repeated attempts can lock the Okta account. While stopped, commands keep using the refresh cookie until it lapses, `auth status --local` shows `okta_blocked`, and the password store is not read. Fix the cause, then run `auth login --okta` again.

## Where the session is kept

The CLI encrypts the access token and renewal cookies in `~/.config/ontrack-cli/session.json` with AES-256-GCM and owner-only permissions. Existing plaintext caches migrate when authentication loads them. The key uses macOS Keychain, Windows DPAPI, or Linux Secret Service. Linux systems without Secret Service use a private key file under `~/.config/ontrack-cli/keys/`; that fallback relies on your filesystem permissions for protection.

The private browser profile is stored under `~/.config/ontrack-cli/browser/`, separately for each site. When an access token expires or a read request rejects it, the CLI first uses the encrypted renewal cookie, then tries the private profile in a background browser. Temporary network failures preserve renewal credentials. Automatic renewal must return the same account; an explicit `auth login` can switch accounts. If both the renewal cookie and institution SSO session have expired, run `auth login` again. A token with under two minutes left is renewed before use, and parallel commands take turns renewing, so they never fight over the browser profile. A background browser renewal prints one line to stderr and gives up after 15 seconds. `auth logout` ends the session on the OnTrack server when it can (`server_revoked` in the result), then removes the session cache and the CLI browser profiles; a failed server request never blocks the local logout.

OnTrack issues the renewal cookie only for remembered sign-ins, so tick "Remember me" on the sign-in page. Renewing does not extend that cookie. `auth status --local` and `doctor` report `renewal_expires_at` and warn when it is under 24 hours away. Ordinary commands print one stderr line (never stdout or JSON) once per renewal cookie, in its last 24 hours; sign in on the OnTrack website or run `auth login` to renew it. Explicit credentials and an unknown expiry never warn.

Renewing never extends that cookie, but signing in to OnTrack in your everyday browser issues a new one. When the stored cookie has under 48 hours left (or has lapsed) and a token needs renewing, the CLI looks in that browser, at most once every 6 hours, and adopts a different, later-expiring cookie for the same account. A failed lookup is silent and renewal carries on with the stored cookie. `auth status --local` shows `browser_checked_at`. Monash sign-in needs MFA, so without `--okta` (above) no unattended job can do this for you: sign in once a week, with `auth login` or just by using OnTrack in your browser.

## Inspect or renew authentication

```bash
ontrack auth status --local
ontrack auth renew
ontrack doctor
ontrack doctor --live --cookies
```

Local status makes no network requests. `auth renew` (also `auth keepalive`) renews and verifies once without an interactive sign-in. `doctor` checks cache protection, the renewal path, the installed browser, and site sign-in discovery; it prints the full report and exits with code 3 when the site is unreachable, the cache cannot be read, or the live check fails. `--live` verifies protected endpoints; `--cookies` also probes browser stores and can prompt for OS access. Diagnostics never print tokens or cookie values. Explicit environment or config credentials override the cache; remove an invalid override before using browser sign-in.
