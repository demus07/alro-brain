import { isPrivateHost, mustBePublic } from "@/lib/net";

/**
 * One provider call, as the connected account. Returns parsed JSON, the body as text with
 * `as: "text"`, or raw bytes (a Uint8Array) with `as: "bytes"` for files. A `form` is sent
 * url-encoded instead of a JSON `body`.
 */
export type Api = <T = Record<string, unknown>>(
  method: "GET" | "POST" | "PUT" | "PATCH",
  path: string,
  opts?: {
    query?: Record<string, string | number | undefined>;
    body?: unknown;
    form?: Record<string, string>;
    headers?: Record<string, string>;
    as?: "json" | "text" | "bytes";
    /** Give up after this long instead of the default 30 seconds (a big file download). */
    timeoutMs?: number;
  },
) => Promise<T>;

export class ProviderError extends Error {
  /** The app didn't answer in time: the call may or may not have gone through. */
  readonly timeout: boolean;
  /** How long the app asked us to wait before trying again (a Retry-After header). */
  readonly retryAfterMs?: number;
  /** The kind of call that failed; a GET never changes anything. */
  readonly method?: string;
  constructor(
    message: string,
    /** The HTTP status, or 0 when no answer arrived. */
    readonly status: number,
    extra: { timeout?: boolean; retryAfterMs?: number; method?: string } = {},
  ) {
    super(message);
    this.timeout = extra.timeout ?? false;
    this.retryAfterMs = extra.retryAfterMs;
    this.method = extra.method;
  }
}

/** How long a provider call may take before it's abandoned. */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** The longest a Retry-After header can make a sync wait. */
const MAX_RETRY_AFTER_MS = 60_000;

/** Retry-After as milliseconds: either seconds or an HTTP date. */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

export interface HttpApiOptions {
  /** Where relative paths resolve, e.g. "https://slack.com/api/". */
  baseUrl: string;
  /** Sent with every call; may refresh a token first. */
  headers: () => Record<string, string> | Promise<Record<string, string>>;
  /** Other hosts this account's token may be sent to (a provider's second API host, a "next page" URL). */
  hosts?: string[];
  /** How long each call may take, unless the call says otherwise. */
  timeoutMs?: number;
}

/**
 * Calls a provider's HTTP API directly with the account's own credential.
 * A path may be a full URL (pagination links), but only on the provider's own
 * hosts, so a token can never be sent somewhere else. A call that gets no answer
 * in time fails with a ProviderError whose `timeout` is true.
 */
export function httpApi({ baseUrl, headers, hosts = [], timeoutMs = DEFAULT_TIMEOUT_MS }: HttpApiOptions): Api {
  const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const allowed = new Set([base.host, ...hosts]);
  return async (method, path, opts = {}) => {
    const url = /^https?:\/\//i.test(path) ? new URL(path) : new URL(path.replace(/^\//, ""), base);
    if (url.protocol !== "https:" || !allowed.has(url.host)) throw new ProviderError(`Refusing to call ${url.host}: not one of this provider's hosts`, 400);
    if (mustBePublic() && isPrivateHost(url.hostname)) throw new ProviderError(`Refusing to call ${url.host}: not a public address`, 400);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const type = opts.form ? "application/x-www-form-urlencoded" : opts.body === undefined ? undefined : "application/json";
    // Files get longer: a large attachment is slow, not stuck.
    const limit = opts.timeoutMs ?? (opts.as === "bytes" ? timeoutMs * 4 : timeoutMs);
    const init = {
      method,
      headers: { accept: "application/json", ...(type ? { "content-type": type } : {}), ...(await headers()), ...opts.headers },
      body: opts.form ? new URLSearchParams(opts.form) : opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(limit),
    };
    try {
      const res = await fetch(url, init);
      if (!res.ok) {
        const wait = res.status === 429 || res.status === 503 ? retryAfterMs(res.headers.get("retry-after")) : undefined;
        throw new ProviderError(`${method} ${url.host}${url.pathname}: ${res.status} ${(await res.text()).slice(0, 300)}`, res.status, { retryAfterMs: wait, method });
      }
      if (opts.as === "text") return (await res.text()) as never;
      if (opts.as === "bytes") return new Uint8Array(await res.arrayBuffer()) as never;
      const text = await res.text();
      return (text ? JSON.parse(text) : {}) as never;
    } catch (e) {
      // The timer also covers reading the body, so a stalled download ends here too.
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
        throw new ProviderError(`${method} ${url.host}${url.pathname}: no answer after ${Math.round(limit / 1000)}s`, 0, { timeout: true, method });
      }
      throw e;
    }
  };
}

export const bearer = (token: string) => () => ({ authorization: `Bearer ${token}` });
export const basic = (user: string, password: string) => () => ({ authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` });

/** Network blips, timeouts, rate limits and provider 5xx: worth another try. Auth and bad requests aren't. */
export const transient = (e: unknown) =>
  e instanceof ProviderError ? e.timeout || e.status === 429 || e.status >= 500 : /ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up/i.test(String(e));

/** Failures where the request never left: the name didn't resolve or the connection was refused. */
const NEVER_SENT = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|UND_ERR_CONNECT_TIMEOUT|CERT_|ERR_TLS/;
const NETWORK = /fetch failed|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|other side closed|UND_ERR|terminated|TimeoutError|AbortError/i;

/**
 * True when a call that changes something ended without an answer: it timed out, or the
 * connection dropped after the request was sent. It may have gone through, so it must never
 * be repeated without a person checking the app first.
 */
export function outcomeUnknown(e: unknown): boolean {
  if (e instanceof ProviderError) return e.timeout && e.method !== "GET";
  if (!(e instanceof Error)) return false;
  const cause = (e as { cause?: { code?: string; message?: string } }).cause;
  const text = `${e.name} ${e.message} ${cause?.code ?? ""} ${cause?.message ?? ""}`;
  return NETWORK.test(text) && !NEVER_SENT.test(text);
}

/**
 * Retries each provider call up to 3 times with growing waits (1s, 4s, 16s) on transient errors.
 * When the app says how long to wait (Retry-After on a 429 or 503), that is used instead, up to a minute.
 * For reading only: a call that changes something is never wrapped in this.
 */
export function withRetries(api: Api, waits = [1000, 4000, 16000], sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))): Api {
  return async (method, path, opts) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await api(method, path, opts);
      } catch (e) {
        if (attempt >= waits.length || !transient(e)) throw e;
        const asked = e instanceof ProviderError ? e.retryAfterMs : undefined;
        await sleep(asked === undefined ? waits[attempt] : Math.min(asked, MAX_RETRY_AFTER_MS));
      }
    }
  };
}

/**
 * Posts a form to an app's token endpoint and returns the JSON. For apps whose keys are traded
 * for short-lived access tokens (Zoom server-to-server, Salesforce client credentials, Zoho).
 */
export async function postForm(url: string, form: Record<string, string>, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new ProviderError(`Refusing to call ${u.host}: not https`, 400);
  if (mustBePublic() && isPrivateHost(u.hostname)) throw new ProviderError(`Refusing to call ${u.host}: not a public address`, 400);
  const res = await fetch(u, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...headers },
    body: new URLSearchParams(form),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // Some token endpoints answer errors in HTML.
  }
  if (!res.ok || body.error) {
    const why = String(body.error_description ?? body.error ?? body.reason ?? text.slice(0, 200) ?? res.status);
    throw new ProviderError(`${u.host} refused the credentials: ${why}`, res.ok ? 401 : res.status === 400 ? 401 : res.status);
  }
  return body;
}

/**
 * Headers for an app whose access tokens are minted from longer-lived keys. Asks for a token
 * the first time it's needed and reuses it until a minute before it expires.
 */
export function mintedBearer(mint: () => Promise<{ accessToken: string; expiresIn?: number }>): () => Promise<Record<string, string>> {
  let current: { accessToken: string; expiresAt: number } | undefined;
  let pending: Promise<{ accessToken: string; expiresAt: number }> | undefined;
  return async () => {
    if (!current || current.expiresAt - Date.now() < 60_000) {
      pending ??= mint().then((t) => ({ accessToken: t.accessToken, expiresAt: Date.now() + (t.expiresIn ?? 3600) * 1000 }));
      try {
        current = await pending;
      } finally {
        pending = undefined;
      }
    }
    return { authorization: `Bearer ${current.accessToken}` };
  };
}
