import OAuthProvider, {
  AuthorizationError,
  getOAuthApi,
  type OAuthHelpers,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import { CONSENT_HEADERS, consentPage, messagePage } from "@bunizao/cli-kit/consent";
import { siteIcon } from "@bunizao/cli-kit/site-icon";
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
import { consumePairing, openPairing, type PairingRecord, type PairingResult, type PairingStore } from "./pairing.js";
import { createOnTrackMcpServer } from "./tools.js";

// The remote MCP Worker. One owner, one OnTrack session:
// - SessionBroker, a Durable Object named "owner", holds the session and renews it
//   (src/session-keeper.ts), on demand and from its alarm;
// - /mcp serves the tools, behind OAuth for connectors or the OWNER_TOKEN bearer;
// - /authorize approves a connector with a one-time pairing code (src/worker/pairing.ts);
// - /pair opens a pairing window and /status reports the session's expiries, both for
//   `ontrack mcp` behind the OWNER_TOKEN bearer.

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
const PAIRING_KEY = "pairing";
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
  private readonly pairing: PairingStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const storage = ctx.storage;
    this.pairing = {
      get: () => storage.get<PairingRecord>(PAIRING_KEY),
      put: (record) => storage.put(PAIRING_KEY, record),
      delete: async () => { await storage.delete(PAIRING_KEY); },
    };
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

  // One object, so a code's attempts are counted without races.
  async openPairing(): Promise<{ code: string; expires_at: string }> {
    return openPairing(this.pairing);
  }

  async consumePairing(code: string): Promise<PairingResult> {
    return consumePairing(this.pairing, code);
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
  if (url.pathname === "/authorize") return handleAuthorize(request, env, helpers);
  if (url.pathname === "/pair" && request.method === "POST") {
    if (!bearerAuthorized(request.headers.get("authorization"), env.OWNER_TOKEN)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    return Response.json(await broker(env).openPairing());
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

const ACCESS = [
  "See your units, tasks, due dates and task sheets",
  "Read your tutors' comments, which marks them read, as the website does",
];
const LIMITS = ["Submit work, change a task's status or message your tutor"];
const PAIRING_HINT = "Each code works once, for 10 minutes. Get one on the computer you deployed from: `ontrack mcp pair`";

async function handleAuthorize(request: Request, env: Env, helpers: OAuthHelpers): Promise<Response> {
  if (request.method === "GET") return consent(request, env, helpers);
  if (request.method !== "POST") return new Response("Method not allowed.", { status: 405, headers: { allow: "GET, POST" } });
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return new Response("Invalid request origin.", { status: 403 });
  }
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  try {
    if (form.get("decision") !== "approve") {
      const denied = await helpers.denyConsent(request, handle);
      return redirect(denied.redirectTo, denied.headers);
    }
    // The handle is checked (and spent) first, so only a real consent form can use up pairing tries.
    const approved = await helpers.approveConsent(request, handle, { scope: [SCOPE] });
    const paired = await broker(env).consumePairing(String(form.get("pairing_code") ?? ""));
    if (!paired.ok) {
      // Show the page again for the same request, with a fresh consent handle.
      const again = new Request(new URL(`/authorize${String(form.get("request") ?? "")}`, request.url), { headers: request.headers });
      return consent(again, env, helpers, paired.attemptsLeft > 0
        ? `That code didn't match. ${paired.attemptsLeft} ${paired.attemptsLeft === 1 ? "try" : "tries"} left.`
        : "That code has expired or was used up. Get a new one: `ontrack mcp pair`");
    }
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
    if (error instanceof AuthorizationError) return html(messagePage("Cannot connect", error.message), 400);
    throw error;
  }
}

async function consent(request: Request, env: Env, helpers: OAuthHelpers, error?: string): Promise<Response> {
  let authRequest;
  try {
    authRequest = await helpers.parseAuthRequest(request);
  } catch (failure) {
    // Never redirect: the redirect_uri is not validated against a client yet.
    return html(messagePage("Cannot connect", failure instanceof Error ? failure.message : "Invalid authorization request."), 400);
  }
  const client = await helpers.lookupClient(authRequest.clientId);
  const { handle, headers } = await helpers.beginConsent(authRequest);
  const appIcon = await siteIcon(env.ONTRACK_ORIGIN);
  const page = consentPage({
    app: "OnTrack",
    ...(appIcon ? { appIcon } : {}),
    client: client?.clientName?.trim() || authRequest.clientId,
    redirectUri: authRequest.redirectUri,
    access: ACCESS,
    limits: LIMITS,
    action: "/authorize",
    fields: { handle, request: new URL(request.url).search },
    secret: { name: "pairing_code", label: "Pairing code", kind: "code", placeholder: "ABCD 2345", hint: PAIRING_HINT },
    ...(error ? { error } : {}),
  });
  return withHeaders(html(page, error ? 400 : 200), headers);
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: CONSENT_HEADERS });
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


function bearerAuthorized(header: string | null, token: string): boolean {
  return Boolean(token) && header?.startsWith("Bearer ") === true && constantTimeEqual(header.slice(7), token);
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
