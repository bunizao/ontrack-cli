import OAuthProvider, {
  AuthorizationError,
  getOAuthApi,
  type OAuthHelpers,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { DurableObject } from "cloudflare:workers";

import packageJson from "../../package.json" with { type: "json" };
import { OnTrackService } from "../application-core.js";
import { CliError, errorCategories, type ErrorCategory } from "../errors.js";
import { HttpClient } from "../http.js";
import { oktaCredentialsFrom } from "../okta-renewal.js";
import { OnTrackClient } from "../ontrack.js";
import { SessionKeeper, type KeeperRecord, type KeeperStatus, type KeptCredentials } from "../session-keeper.js";
import { CivilDate, Instant, type Clock } from "../time.js";
import { safeUserView } from "../user.js";
import { createOnTrackMcpServer } from "./tools.js";

// The remote MCP Worker. One owner, one OnTrack session:
// - SessionBroker, a Durable Object named "owner", holds the session and renews it
//   (src/session-keeper.ts), on demand and from its alarm;
// - /mcp serves the tools, behind OAuth for connectors or the OWNER_TOKEN bearer;
// - /authorize asks for OWNER_TOKEN (Basic auth, user "ontrack") before approving a connector;
// - /status reports the session's expiries to `ontrack mcp status`, behind the OWNER_TOKEN bearer.

export interface Env {
  readonly SESSION_BROKER: DurableObjectNamespace<SessionBroker>;
  readonly OAUTH_KV: KVNamespace;
  readonly ONTRACK_ORIGIN: string;
  /** IANA zone for "today" in due dates, e.g. Australia/Melbourne. Workers run in UTC. */
  readonly TIME_ZONE: string;
  readonly OWNER_TOKEN: string;
  readonly OKTA_USERNAME?: string;
  readonly OKTA_PASSWORD?: string;
  readonly OKTA_TOTP_SECRET?: string;
}

const RECORD_KEY = "record";
const OWNER = "owner";
const MCP_PATH = "/mcp";
const SCOPE = "ontrack";
const MAX_REGISTERED_CLIENTS = 20;

/** CliError does not survive Durable Object RPC, so failures cross it as data. */
type BrokerResult =
  | { readonly ok: true; readonly credentials: KeptCredentials }
  | { readonly ok: false; readonly category: ErrorCategory; readonly message: string; readonly hint: string | null };

export class SessionBroker extends DurableObject<Env> {
  private readonly keeper: SessionKeeper;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const storage = ctx.storage;
    this.keeper = new SessionKeeper({
      baseUrl: env.ONTRACK_ORIGIN,
      okta: oktaCredentialsFrom(env as unknown as Record<string, string | undefined>),
      storage: {
        read: () => storage.get<KeeperRecord>(RECORD_KEY),
        write: (record) => storage.put(RECORD_KEY, record),
        setAlarm: (at) => (at === null ? storage.deleteAlarm() : storage.setAlarm(at)),
      },
    });
  }

  async credentials(rejected?: string): Promise<BrokerResult> {
    try {
      return { ok: true, credentials: await this.keeper.credentials(rejected) };
    } catch (error) {
      if (error instanceof CliError) {
        return { ok: false, category: error.category, message: error.message, hint: error.hint ?? null };
      }
      throw error;
    }
  }

  async status(): Promise<KeeperStatus> {
    return this.keeper.status();
  }

  override async alarm(): Promise<void> {
    await this.keeper.alarm();
  }
}

function broker(env: Env): DurableObjectStub<SessionBroker> {
  return env.SESSION_BROKER.get(env.SESSION_BROKER.idFromName(OWNER));
}

async function credentials(env: Env, rejected?: string): Promise<KeptCredentials> {
  // The RPC stub types `user`'s unknown values as unserializable; the value is plain JSON.
  const result = await broker(env).credentials(rejected) as unknown as BrokerResult;
  if (result.ok) return result.credentials;
  const category = errorCategories.includes(result.category) ? result.category : "auth";
  throw new CliError(category, result.message, undefined, result.hint ?? undefined);
}

function clock(timeZone: string): Clock {
  const now = new Date();
  // en-CA formats as YYYY-MM-DD.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return { now: Instant.parse(now.toISOString()), today: CivilDate.parse(today) };
}

async function service(env: Env): Promise<OnTrackService> {
  const kept = await credentials(env);
  const http = new HttpClient({
    baseUrl: env.ONTRACK_ORIGIN,
    credentials: kept,
    refresh: async (_signal, rejected) => credentials(env, rejected.accessToken),
  });
  const user = kept.user ? safeUserView(kept.user, kept.username) : undefined;
  return new OnTrackService({ current: { baseUrl: env.ONTRACK_ORIGIN, username: kept.username, user } }, new OnTrackClient(http), clock(env.TIME_ZONE));
}

async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { allow: "POST" } });
  }
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true }) // stateless: no session ID;
  const server = createOnTrackMcpServer({
    version: packageJson.version,
    service: () => service(env),
    status: () => broker(env).status(),
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}

async function handleOther(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const helpers = (env as unknown as { OAUTH_PROVIDER: OAuthHelpers }).OAUTH_PROVIDER;
  if (url.pathname === "/authorize") {
    if (!basicAuthorized(request.headers.get("authorization"), env.OWNER_TOKEN)) {
      return new Response("Enter the owner token as the password; the user name is ontrack.", {
        status: 401,
        headers: { "www-authenticate": 'Basic realm="ontrack MCP", charset="UTF-8"' },
      });
    }
    return handleAuthorize(request, helpers);
  }
  if (url.pathname === "/status" && request.method === "GET") {
    if (!bearerAuthorized(request.headers.get("authorization"), env.OWNER_TOKEN)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    return Response.json({ version: packageJson.version, session: await broker(env).status() });
  }
  if (url.pathname === "/" && request.method === "GET") {
    return new Response(`ontrack MCP ${packageJson.version}. Add ${url.origin}${MCP_PATH} as a connector.\n`);
  }
  return Response.json({ error: "not_found" }, { status: 404 });
}

function oauthProvider(env: Env, origin: string): OAuthProvider<Env> {
  const resource = new URL(MCP_PATH, origin).toString();
  const options: OAuthProviderOptions<Env> = {
    apiRoute: resource,
    apiHandler: { fetch: handleMcp },
    defaultHandler: { fetch: handleOther },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/register",
    scopesSupported: [SCOPE],
    accessTokenTTL: 60 * 60,
    refreshTokenTTL: 30 * 24 * 60 * 60,
    // An https client_id resolves to its metadata document; the
    // global_fetch_strictly_public flag keeps that fetch off private addresses.
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: { resource, resource_name: "ontrack", scopes_supported: [SCOPE] },
    // Claude Code and scripts use OWNER_TOKEN as a static bearer.
    resolveExternalToken: async ({ token, env: requestEnv }) => {
      if (!requestEnv.OWNER_TOKEN || !constantTimeEqual(token, requestEnv.OWNER_TOKEN)) return null;
      return { props: { subject: OWNER }, audience: resource };
    },
  };
  // Registration is open by design (RFC 7591), so cap what an anonymous caller can fill KV with.
  options.clientRegistrationCallback = async () => {
    const clients = await getOAuthApi(options, env).listClients({ limit: MAX_REGISTERED_CLIENTS });
    if (clients.items.length < MAX_REGISTERED_CLIENTS) return;
    return { code: "invalid_client_metadata", description: `At most ${MAX_REGISTERED_CLIENTS} OAuth clients may register.`, status: 400 };
  };
  return new OAuthProvider(options);
}

async function handleAuthorize(request: Request, helpers: OAuthHelpers): Promise<Response> {
  if (request.method === "GET") {
    let authRequest;
    try {
      authRequest = await helpers.parseAuthRequest(request);
    } catch (error) {
      // Never redirect: the redirect_uri is not validated against a client yet.
      return page("Cannot connect", `<p>${escapeHtml(error instanceof Error ? error.message : "Invalid authorization request.")}</p>`, 400);
    }
    const client = await helpers.lookupClient(authRequest.clientId);
    const name = client?.clientName?.trim() || authRequest.clientId;
    let redirectHost = authRequest.redirectUri;
    try {
      redirectHost = new URL(authRequest.redirectUri).host || redirectHost;
    } catch {
      // A native app's private-use URI has no host; show it whole.
    }
    const { handle, headers } = await helpers.beginConsent(authRequest);
    const body = `<p><strong>${escapeHtml(name)}</strong> wants to read your OnTrack units, tasks and comments.
Tokens go to <code>${escapeHtml(redirectHost)}</code>.</p>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<button name="action" value="deny">Deny</button> <button name="action" value="approve">Approve</button>
</form>`;
    return withHeaders(page("Connect to ontrack", body), headers);
  }
  if (request.method === "POST") {
    if (request.headers.get("origin") !== new URL(request.url).origin) {
      return new Response("Invalid request origin.", { status: 403 });
    }
    const form = await request.formData();
    const handle = String(form.get("handle") ?? "");
    try {
      if (form.get("action") === "deny") {
        const denied = await helpers.denyConsent(request, handle);
        return redirect(denied.redirectTo, denied.headers);
      }
      const approved = await helpers.approveConsent(request, handle, { scope: [SCOPE] });
      const client = await helpers.lookupClient(approved.request.clientId);
      const { redirectTo } = await helpers.completeAuthorization({
        request: approved.request,
        userId: OWNER,
        metadata: { clientName: client?.clientName?.trim() || approved.request.clientId },
        scope: approved.request.scope,
        props: { subject: OWNER },
      });
      return redirect(redirectTo, approved.headers);
    } catch (error) {
      if (error instanceof AuthorizationError) return page("Cannot connect", `<p>${escapeHtml(error.message)}</p>`, 400);
      throw error;
    }
  }
  return new Response("Method not allowed.", { status: 405, headers: { allow: "GET, POST" } });
}

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escapeHtml(title)}</title>
<style>body{font:16px system-ui;max-width:36rem;margin:3rem auto;padding:0 1rem}button{font:inherit;padding:.4rem 1rem}</style>
<h1>${escapeHtml(title)}</h1>${body}`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

/** Adds the library's consent cookie and clickjacking headers. */
function withHeaders(response: Response, extra: Headers): Response {
  const headers = new Headers(response.headers);
  for (const cookie of extra.getSetCookie()) headers.append("set-cookie", cookie);
  const frameOptions = extra.get("x-frame-options");
  if (frameOptions) headers.set("x-frame-options", frameOptions);
  return new Response(response.body, { status: response.status, headers });
}

function redirect(location: string, extra: Headers): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const cookie of extra.getSetCookie()) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => `&#${character.charCodeAt(0)};`);
}

function bearerAuthorized(header: string | null, token: string): boolean {
  return Boolean(token) && header?.startsWith("Bearer ") === true && constantTimeEqual(header.slice(7), token);
}

function basicAuthorized(header: string | null, token: string): boolean {
  if (!token || !header?.startsWith("Basic ")) return false;
  try {
    const decoded = atob(header.slice(6));
    const separator = decoded.indexOf(":");
    return separator !== -1 && decoded.slice(0, separator) === "ontrack" && constantTimeEqual(decoded.slice(separator + 1), token);
  } catch {
    return false;
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export default {
  fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    return oauthProvider(env, new URL(request.url).origin).fetch(request, env, context);
  },
} satisfies ExportedHandler<Env>;
