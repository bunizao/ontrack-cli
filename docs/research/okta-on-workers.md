# Okta sign-in from a Cloudflare Worker

Spike run on 2026-11-19 with [`spikes/okta-on-workers`](../../spikes/okta-on-workers): a bare Worker
that calls `signInToOnTrack` (src/okta-sign-in.ts) with `OKTA_*` Worker secrets, against
monashuni.okta.com and ontrack.infotech.monash.edu. The Worker was deleted after the run.

## Results

| Question | Answer |
|---|---|
| Does Okta accept a sign-in from Cloudflare? | Yes. Username, password and TOTP from colo HKG, no extra challenge. 4.6 s to the SAML post, 6.6 s end to end. |
| Does the returned Okta session skip the password and code? | Yes. The second sign-in in the same invocation went straight from "Opening" to "already has a session" and took 2.0 s. |
| Is the access token usable? | Yes. `GET /api/projects` answered 200 for both sign-ins. |
| CPU time | 25 ms for one invocation with two sign-ins and two API calls (`wrangler tail`, outcome `ok`). About 12 ms per sign-in. |
| Does the Worker get its own refresh token? | No. Both sign-ins got the token the laptop CLI already held: same SHA-256 prefix, same expiry (2026-11-26T05:00:20Z). The CLI kept working afterwards. |

## What this means for a hosted MCP

- Okta in the Worker works, and the runtime-neutral `signInToOnTrack` runs unchanged.
- **One refresh token per user.** Doubtfire hands every remembered sign-in the user's latest refresh
  token and mints a new one only once that token is 12 hours past its expiry (see the header of
  src/okta-sign-in.ts). The spike confirms that a sign-in without a revoke gets the old token back.
  So the Worker's renewal at expiry minus 48 h must revoke the held token first, as the CLI does. That
  revoke also kills the laptop CLI's copy. The CLI recovers on its next use through its own Okta
  renewal, and a remembered sign-in then returns the Worker's new token, so the two converge on one
  token after one extra sign-in. A CLI signed in through a browser, without Okta, needs a person
  instead.
- The CLI's `auth login --okta` revokes in the same way, so it breaks the Worker's token once. The
  Worker's next request then runs its own Okta sign-in and gets the CLI's new token back.
- CPU: one sign-in sits around the Workers Free plan's 10 ms CPU limit and still finished (`ok`).
  Run the sign-in from a Durable Object alarm, and check the account's plan before relying on it.

## Not covered

- Colo: the request entered at HKG through the local proxy. An MCP client calls from wherever it
  runs, and a Durable Object's alarm runs where the object lives, so Okta's risk policy may see
  other locations. One success from HKG does not prove that every location passes.
- Repeated sign-ins over days: Okta's behaviour for a datacenter "device" that signs in every
  five days.
- A revoke from the Worker followed by CLI recovery: predicted from the code, not exercised.
