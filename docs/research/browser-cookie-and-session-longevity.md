# Browser cookies and long-lived campus sessions

Status: 2026-07-27

This note answers two questions:

1. Can a CLI continuously import browser cookies and keep Moodle and OnTrack authenticated?
2. Can a client modify a cookie or token so it remains reusable for a long time?

The answer is **yes for cookie import and limited renewal, no for client-side lifetime extension**. Moodle can normally be kept alive by activity because its stock session timeout is idle-based. OnTrack can repeatedly mint short access tokens while its refresh cookie remains valid, but the current upstream refresh token has a fixed server-side expiry. Okta can preserve or refresh an SSO session only within administrator policy. When an application session and the Okta session are both no longer valid, fresh SSO and possibly MFA are unavoidable.

The upstream analysis is pinned to:

- Moodle commit [`dd5063e`](https://github.com/moodle/moodle/tree/dd5063e52685f2b77e147619bbdbc75663b36097)
- Doubtfire/OnTrack API commit [`c91418e`](https://github.com/doubtfire-lms/doubtfire-api/tree/c91418e128e97df1fb61d0f774715475b757d8f4)

## Decision matrix

| Technique | Moodle | OnTrack | What it really does |
| --- | --- | --- | --- |
| Import cookies from a browser | Yes | Yes | Copies an existing application credential; it does not create or extend the server session. |
| Send periodic authenticated activity | Yes, through `core_session_touch` | No equivalent found in current upstream | Extends an idle timeout only while the server still accepts the credential. |
| Exchange an application refresh cookie | Not the Moodle session model used here | Yes, through `/api/auth/access-token` | Mints/reuses a short access token; it does not extend the refresh token. |
| Re-enter the application through valid Okta SSO | Yes | Yes | Creates a fresh application session without credentials/MFA only if Okta policy still permits it. |
| Refresh the Okta session | Policy-limited | Policy-limited | Can reset idle time, but cannot defeat the configured maximum lifetime or MFA policy. |
| Edit local expiry metadata or token text | No | No | Browser expiry controls sending; the servers separately validate their own session/token records. |
| Change server configuration/implementation | Possible for an administrator | Possible for an administrator | This is the only legitimate way to lengthen or rotate server-side credentials, with a security tradeoff. |

## 1. Cookie extraction is feasible, but it is not renewal

There are three practical extraction mechanisms.

### Browser-supported APIs

Chrome DevTools Protocol `Storage.getCookies` explicitly [returns all browser cookies](https://chromedevtools.github.io/devtools-protocol/tot/Storage/#method-getCookies), optionally for a browser context. Firefox's WebExtensions [`cookies.getAll`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/cookies/getAll) retrieves matching cookies from a cookie store, but requires both the `cookies` permission and relevant host permissions. These are cleaner than parsing browser databases because the browser handles decryption, profiles, and partitioned storage.

They are not silently available to an arbitrary CLI. A browser must expose a debugging connection or an installed extension must receive permission. Chrome also hardened this boundary: since Chrome 136, `--remote-debugging-port` and `--remote-debugging-pipe` are ignored for the default Chrome data directory unless a non-default `--user-data-dir` is used; the new directory has a different encryption key. Chrome recommends a custom profile or Chrome for Testing, not debugging the user's real profile. ([Chrome remote-debugging security change](https://developer.chrome.com/blog/remote-debugging-port))

For a user's normal browser profile, a browser extension with the `cookies` API and allowlisted host permissions is the supported route. It can push selected application cookies to a local helper through [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging). Native Messaging connections are initiated by the extension, so a practical design has the extension update a permission-restricted local cache and lets CLIs consume that cache. This is more installation work than a managed profile and grants sensitive permissions, but it avoids external cookie-database decryption.

### Direct profile-database import

The current `moodle-cli` already implements this route:

- Chromium-family profiles are read through `chrome-cookies-secure` in [`src/auth.ts`](../../../moodle-cli/src/auth.ts#L255-L280).
- Firefox `cookies.sqlite` is copied before querying `moz_cookies`, avoiding a live-database lock, in [`src/auth.ts`](../../../moodle-cli/src/auth.ts#L283-L315).

This works on the user's machine when operating-system decryption permits it, but it is not a stable browser API. Chromium's own encryption providers use the macOS Keychain, Windows DPAPI, and Linux Secret Service/KWallet, so portability requires platform-specific handling. ([Chromium macOS provider](https://github.com/chromium/chromium/blob/main/components/os_crypt/async/browser/keychain_key_provider.mm), [Windows DPAPI provider](https://github.com/chromium/chromium/blob/main/components/os_crypt/async/browser/dpapi_key_provider.cc), [Linux secret provider](https://github.com/chromium/chromium/blob/main/components/os_crypt/async/browser/freedesktop_secret_key_provider.cc))

### A tool-managed browser profile

This is the most reliable cross-platform design. `okta-auth` owns a separate browser profile, performs interactive login only when required, and exports cookies through a stable JSON contract. It avoids racing the user's browser and avoids Chrome 136's default-profile debugging restriction. The tradeoff is that its application sessions are separate from the user's normal browser sessions.

All three mechanisms merely retrieve a bearer credential. The `Expires`/`Max-Age` cookie attributes tell the browser when to retain/send a cookie; `HttpOnly` prevents page JavaScript from reading it, not a privileged browser API. The application can still reject a copied cookie based on server-side state. ([Set-Cookie semantics](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie))

## 2. Moodle can be kept active, subject to server and institutional policy

Moodle registers `core_session_touch` as a login-required AJAX method whose stated purpose is to keep the user's session alive. ([service declaration](https://github.com/moodle/moodle/blob/dd5063e52685f2b77e147619bbdbc75663b36097/public/lib/db/services.php#L936-L943)) Its implementation calls `core\session\manager::touch_session(session_id())`. ([external method](https://github.com/moodle/moodle/blob/dd5063e52685f2b77e147619bbdbc75663b36097/public/lib/classes/session/external.php#L42-L68)) The manager updates the server-side session's `timemodified` field to the current time. ([session manager](https://github.com/moodle/moodle/blob/dd5063e52685f2b77e147619bbdbc75663b36097/public/lib/classes/session/manager.php#L980-L990))

Stock Moodle evaluates expiry as `timemodified < now - $CFG->sessiontimeout`; its time-remaining calculation uses the same idle interval. ([session checks](https://github.com/moodle/moodle/blob/dd5063e52685f2b77e147619bbdbc75663b36097/public/lib/classes/session/manager.php#L927-L977)) No stock absolute maximum session age was found in this path. Therefore, a successful touch performed comfortably before `sessiontimeout` can keep the same Moodle session alive for a long time.

The TypeScript `moodle-cli` already implements the correct loop:

- it prefers a cached session, then browser cookies, then `okta cookies`, and only then interactive renewal ([auth source order](../../../moodle-cli/src/auth.ts#L93-L126));
- it calls `core_session_touch` and `core_session_time_remaining` ([keepalive request](../../../moodle-cli/src/keepalive.ts#L68-L120));
- if the server says the session expired, it attempts to authenticate from fresh browser/Okta cookies ([keepalive fallback](../../../moodle-cli/src/keepalive.ts#L123-L155)).

This is a sliding idle session, not a permanent token. It still ends when the server deletes sessions, an administrator invalidates them, the account changes, an authentication plugin enforces another constraint, the institution changes policy, or a request misses the timeout window. A locally saved `MoodleSession` value cannot resurrect a deleted server session.

## 3. Current OnTrack refresh is bounded to one week by default

OnTrack uses opaque, server-stored tokens rather than a self-contained client-editable token. `AuthToken.generate` creates a random Devise token, stores it against the user, and stores a server-side expiry. ([token model](https://github.com/doubtfire-lms/doubtfire-api/blob/c91418e128e97df1fb61d0f774715475b757d8f4/app/models/auth_token.rb#L1-L31)) Authentication looks up the supplied token text and separately checks `auth_token_expiry`; expired tokens are destroyed. ([authentication check](https://github.com/doubtfire-lms/doubtfire-api/blob/c91418e128e97df1fb61d0f774715475b757d8f4/app/helpers/authentication_helpers.rb#L20-L47))

Current upstream defaults are:

- access token: two hours;
- refresh token: one week.

Both are deployment-configurable through `DF_ACCESS_TOKEN_EXPIRY_SECONDS` and `DF_REFRESH_TOKEN_EXPIRY_SECONDS`. ([application configuration](https://github.com/doubtfire-lms/doubtfire-api/blob/c91418e128e97df1fb61d0f774715475b757d8f4/config/application.rb#L40-L41))

`POST /api/auth/access-token` authenticates the `refresh_token` and `username` cookies, then issues or reuses a general access token and returns its expiry. It does not rotate or extend the refresh token and does not send a new refresh cookie. ([access-token exchange](https://github.com/doubtfire-lms/doubtfire-api/blob/c91418e128e97df1fb61d0f774715475b757d8f4/app/api/authentication_api.rb#L501-L529)) The refresh cookie's expiry is copied from the server-side refresh-token record when the cookie is initially set. ([refresh cookie](https://github.com/doubtfire-lms/doubtfire-api/blob/c91418e128e97df1fb61d0f774715475b757d8f4/app/helpers/authentication_helpers.rb#L217-L248))

Consequences:

1. `ontrack-cli` can exchange the same valid refresh cookie roughly before each access-token expiry. Its current [`exchangeCookies`](../../src/auth.ts#L346-L419) already implements this safely.
2. Doing so does **not** push the refresh-token expiry forward. With upstream defaults, a fresh OnTrack application login is required at least weekly.
3. If a valid Okta browser session remains, visiting OnTrack's SSO entry can create that fresh application session without prompting. If Okta no longer accepts the session, the browser must perform fresh sign-in and possibly MFA.

## 4. EdStem remains a separate credential authority

The current TypeScript `edstem-cli` uses an Ed Personal API Token, supplied through `ED_API_TOKEN`, a mode-`0600` local token file, or an interactive prompt. It sends that value as a bearer token to the Ed API. ([token loading](../../../edstem-cli/src/auth.ts), [request authorization](../../../edstem-cli/src/ed/client.ts)) This token is issued and revoked by EdStem; it is not a Moodle, OnTrack, or Okta application cookie and cannot be derived by rewriting one of them.

The three CLIs can share a credential-provider interface, secure storage, redaction, renewal coordination, and diagnostics. They must still use separate platform adapters and separate stored credentials. A shared package therefore means one authentication runtime and user experience, not one bearer token accepted by every platform.

## 5. Okta SSO cannot be made permanently valid by a client

Okta states that its HTTP session cookie gives a browser access to the Okta organization and applications, and that its expiration is administrator-configurable. The session ends when the cookie expires, the user logs out, or the browser session ends. Okta also says a session token is a one-time bearer token and can only establish one session. ([Okta Sessions API overview](https://developer.okta.com/docs/api/openapi/okta-management/management/tag/Session/), [session-cookie guide](https://developer.okta.com/docs/guides/session-cookie/main/))

Identity Engine policy has two distinct limits:

- **maximum global session lifetime**, which may be a fixed duration or, only for low-risk policy, no time limit;
- **maximum global session idle time**, which expires the session regardless of maximum-lifetime choice.

The same policy can require MFA at every sign-in, for a new device cookie, or after an MFA lifetime. A client cannot safely infer or override those administrator decisions. ([Okta global session policy rule](https://help.okta.com/oie/en-us/content/topics/identity-engine/policies/add-okta-sign-on-policy-rule.htm), [Okta limited-session recommendation](https://help.okta.com/oie/en-us/content/topics/security/healthinsight/session-lifetime.htm))

Okta explicitly recommends using session cookies only in browsers because their behavior is subject to change. Therefore `okta-auth` should manage a browser context and export application cookies; it should not turn the Okta cookie itself into a promised long-term public API.

## 6. Why editing the token or cookie does not work

These are different operations and must not be conflated:

- **Cookie extraction:** copies the exact credential the server already issued.
- **Keepalive:** sends accepted authenticated activity so a server updates idle state.
- **Application reauthentication:** uses a still-valid Okta SSO session to obtain a new Moodle or OnTrack application session.
- **Fresh SSO/MFA:** proves identity again after policy requires it.
- **Token tampering:** changes a credential or its local expiry without server authorization.

Changing a local cookie's `Expires` only influences local retention. It does not update Moodle's session record, OnTrack's `auth_token_expiry`, or Okta policy. Changing an opaque Moodle or OnTrack token value makes lookup fail. If a token were signed, changing its claims without the issuer's signing key would invalidate its signature. Token tampering is therefore neither a renewal strategy nor an acceptable implementation path.

If administrators want longer OnTrack reuse, they can increase the two deployment expiry settings or implement refresh-token rotation. The safer server design is a sliding refresh window with rotation, reuse detection, and a separate absolute maximum—not an indefinitely valid bearer token. That requires a Doubtfire API change and Monash deployment approval; a local CLI cannot impose it.

## 7. Recommended shared TypeScript design

Build one small authentication runtime shared by `moodle-cli`, `ontrack-cli`, and future campus tools, while retaining platform-specific adapters:

```text
valid local application session
  -> application cookies from browser/provider
  -> application reauthentication through existing Okta SSO
  -> explicit interactive Okta login and MFA
```

The shared runtime should own:

- cookie-source ordering and host/path/expiry filtering;
- a tool-managed browser profile plus an optional explicit browser-import provider;
- encrypted/permission-restricted local cache;
- single-flight renewal and one retry after an authentication failure;
- scheduling, clock skew, cancellation, diagnostics, and secret redaction;
- distinct states: `valid`, `renewable`, `sso_required`, and `interactive_required`.

Adapters should own only server semantics:

- Moodle: `MoodleSession`, `sesskey`, `core_session_touch`, and login-page detection.
- OnTrack: `username`/`refresh_token` cookies, `/api/auth/access-token`, access-token expiry, and HTTP 419 handling.
- EdStem: Personal API Token validation and explicit replacement after revocation or expiry.
- Okta provider: browser navigation, the OnTrack **Sign in** launch click, SSO/MFA, and application-cookie export.

Recommended schedules are derived from observed server responses, not hard-coded promises: Moodle should touch well before its returned `timeremaining`; OnTrack should exchange before `auth_token_expiry`; both should stop looping and escalate to application SSO or interactive login when the relevant server rejects the credential.

## Final conclusion

A unified tool can make authentication **mostly invisible**, but it cannot produce one permanent cross-platform token. The realistic result is:

- Moodle stays logged in for long periods through its supported idle-session touch.
- OnTrack access tokens refresh automatically for the lifetime of its refresh cookie.
- EdStem keeps using its separately issued API token; it shares storage and orchestration code, not credential material.
- A managed browser silently re-enters either application while Okta SSO remains valid.
- When the application refresh credential and Okta policy are both exhausted, the tool opens one explicit login/MFA flow and resumes automation afterward.

That design reuses one identity experience while respecting three separate security authorities. It is more reliable than repeatedly scraping the user's default browser and much safer than weakening or tampering with bearer tokens.
