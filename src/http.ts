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

interface HttpResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly bytes: Uint8Array;
}

const maxDownloadBytes = 512 * 1024 * 1024;

async function responseBytes(response: Response, limit?: number): Promise<Uint8Array> {
  if (limit === undefined) return new Uint8Array(await response.arrayBuffer());
  const lengthHeader = response.headers.get("Content-Length");
  const contentLength = lengthHeader && /^\d+$/u.test(lengthHeader) ? Number(lengthHeader) : undefined;
  if (contentLength !== undefined && contentLength > limit) {
    throw new CliError("upstream_api", "OnTrack resource archive exceeds the 512 MiB download limit");
  }
  if (contentLength !== undefined) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > limit) throw new CliError("upstream_api", "OnTrack resource archive exceeds the 512 MiB download limit");
    return bytes;
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new CliError("upstream_api", "OnTrack resource archive exceeds the 512 MiB download limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export class HttpClient {
  readonly #baseUrl: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #refresh: ((signal: AbortSignal) => Promise<AccessCredentials | void>) | undefined;
  readonly #timeoutMs: number;
  readonly #signal: AbortSignal | undefined;
  #credentials: AccessCredentials;
  #refreshing: Promise<void> | undefined;
  #sessionVersion = 0;

  constructor(options: HttpClientOptions) {
    this.#baseUrl = new URL(options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
    this.#credentials = options.credentials;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#refresh = options.refresh;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#signal = options.signal;
  }

  async request(path: string, options: HttpRequestOptions = {}): Promise<unknown> {
    const response = await this.#response(path, options);
    try {
      return JSON.parse(new TextDecoder().decode(response.bytes)) as unknown;
    } catch {
      throw new CliError("upstream_contract", "OnTrack returned invalid JSON");
    }
  }

  async download(path: string, options: HttpRequestOptions = {}): Promise<Uint8Array> {
    const headers = new Headers(options.headers);
    if (!headers.has("Accept")) headers.set("Accept", "application/octet-stream");
    const response = await this.#response(path, { ...options, headers }, maxDownloadBytes);
    return response.bytes;
  }

  async #response(path: string, options: HttpRequestOptions, responseLimit?: number): Promise<HttpResponse> {
    const url = new URL(path.replace(/^\//, ""), this.#baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const method = (options.method ?? "GET").toUpperCase();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const sessionVersion = this.#sessionVersion;
      const response = await this.#send(url, method, options, responseLimit);
      if (response.status === 419 && method === "GET" && attempt === 0 && this.#refresh) {
        if (sessionVersion === this.#sessionVersion) {
          await this.#refreshOnce(options.signal ?? this.#signal ?? new AbortController().signal);
        }
        continue;
      }
      if (response.status === 401 || response.status === 419) {
        throw new CliError("auth", "OnTrack rejected the authenticated session", response.status);
      }
      if (!response.ok) throw new CliError("upstream_api", `OnTrack returned HTTP ${response.status}`, response.status);
      return response;
    }
    throw new CliError("auth", "OnTrack rejected the refreshed session", 419);
  }

  async #refreshOnce(signal: AbortSignal): Promise<void> {
    this.#refreshing ??= (async () => {
      const refreshed = await this.#refresh?.(signal);
      if (refreshed) this.#credentials = refreshed;
      this.#sessionVersion += 1;
    })().finally(() => {
      this.#refreshing = undefined;
    });
    await this.#refreshing;
  }

  async #send(url: URL, method: string, options: HttpRequestOptions, responseLimit?: number): Promise<HttpResponse> {
    const headers = new Headers(options.headers);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
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
      const response = await this.#fetch(url, init);
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { status: response.status, ok: false, bytes: new Uint8Array() };
      }
      return {
        status: response.status,
        ok: response.ok,
        bytes: await responseBytes(response, responseLimit),
      };
    } catch (error) {
      if (error instanceof CliError) throw error;
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
