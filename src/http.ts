import { CliError } from "./errors.js";

export interface AccessCredentials {
  readonly username: string;
  readonly accessToken: string;
}

export interface HttpClientOptions {
  readonly baseUrl: string;
  readonly credentials: AccessCredentials;
  readonly refresh?: (signal: AbortSignal) => Promise<AccessCredentials | void>;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface HttpRequestOptions {
  readonly method?: string;
  readonly query?: Readonly<Record<string, string | number | boolean | null | undefined>>;
  readonly body?: BodyInit | null;
  readonly headers?: HeadersInit;
  readonly signal?: AbortSignal;
}

export class HttpClient {
  readonly #baseUrl: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #refresh: ((signal: AbortSignal) => Promise<AccessCredentials | void>) | undefined;
  readonly #timeoutMs: number;
  readonly #signal: AbortSignal | undefined;
  #credentials: AccessCredentials;

  constructor(options: HttpClientOptions) {
    this.#baseUrl = new URL(options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
    this.#credentials = options.credentials;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#refresh = options.refresh;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#signal = options.signal;
  }

  async request(path: string, options: HttpRequestOptions = {}): Promise<unknown> {
    const url = new URL(path.replace(/^\//, ""), this.#baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const method = (options.method ?? "GET").toUpperCase();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.#send(url, method, options);
      if (response.status === 419 && method === "GET" && attempt === 0 && this.#refresh) {
        const refreshed = await this.#refresh(options.signal ?? this.#signal ?? new AbortController().signal);
        if (refreshed) this.#credentials = refreshed;
        continue;
      }
      if (response.status === 401 || response.status === 419) {
        throw new CliError("auth", "OnTrack rejected the authenticated session", response.status);
      }
      if (!response.ok) throw new CliError("upstream_api", `OnTrack returned HTTP ${response.status}`, response.status);
      try {
        return JSON.parse(await response.text()) as unknown;
      } catch {
        throw new CliError("upstream_contract", "OnTrack returned invalid JSON");
      }
    }
    throw new CliError("auth", "OnTrack rejected the refreshed session", 419);
  }

  async #send(url: URL, method: string, options: HttpRequestOptions): Promise<Response> {
    const headers = new Headers(options.headers);
    headers.set("Accept", "application/json");
    headers.set("Username", this.#credentials.username);
    headers.set("Auth-Token", this.#credentials.accessToken);
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), this.#timeoutMs);
    const externalSignal = options.signal ?? this.#signal;
    const signal = externalSignal
      ? AbortSignal.any([externalSignal, timeoutController.signal])
      : timeoutController.signal;
    try {
      const init: RequestInit = { method, headers, signal };
      if (options.body !== undefined) init.body = options.body;
      return await this.#fetch(url, init);
    } catch (error) {
      if (externalSignal?.aborted) {
        throw new CliError("cancellation", "Request cancelled");
      }
      if (timeoutController.signal.aborted) {
        throw new CliError("network", `OnTrack request timed out after ${this.#timeoutMs}ms`);
      }
      throw new CliError("network", error instanceof Error ? error.message : "Network request failed");
    } finally {
      clearTimeout(timeout);
    }
  }
}
