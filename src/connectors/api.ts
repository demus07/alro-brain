import { isPrivateHost, mustBePublic } from "@/lib/net";

/** One provider call, as the connected account. Returns parsed JSON, or the body as text with `as: "text"`. */
export type Api = <T = Record<string, unknown>>(
  method: "GET" | "POST",
  path: string,
  opts?: { query?: Record<string, string | number | undefined>; body?: unknown; headers?: Record<string, string>; as?: "json" | "text" },
) => Promise<T>;

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface HttpApiOptions {
  /** Where relative paths resolve, e.g. "https://slack.com/api/". */
  baseUrl: string;
  /** Sent with every call; may refresh a token first. */
  headers: () => Record<string, string> | Promise<Record<string, string>>;
  /** Other hosts this account's token may be sent to (a provider's second API host, a "next page" URL). */
  hosts?: string[];
}

/**
 * Calls a provider's HTTP API directly with the account's own credential.
 * A path may be a full URL (pagination links), but only on the provider's own
 * hosts, so a token can never be sent somewhere else.
 */
export function httpApi({ baseUrl, headers, hosts = [] }: HttpApiOptions): Api {
  const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const allowed = new Set([base.host, ...hosts]);
  return async (method, path, opts = {}) => {
    const url = /^https?:\/\//i.test(path) ? new URL(path) : new URL(path.replace(/^\//, ""), base);
    if (url.protocol !== "https:" || !allowed.has(url.host)) throw new ProviderError(`Refusing to call ${url.host}: not one of this provider's hosts`, 400);
    if (mustBePublic() && isPrivateHost(url.hostname)) throw new ProviderError(`Refusing to call ${url.host}: not a public address`, 400);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const res = await fetch(url, {
      method,
      headers: { accept: "application/json", ...(opts.body === undefined ? {} : { "content-type": "application/json" }), ...(await headers()), ...opts.headers },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    if (!res.ok) throw new ProviderError(`${method} ${url.host}${url.pathname}: ${res.status} ${(await res.text()).slice(0, 300)}`, res.status);
    if (opts.as === "text") return (await res.text()) as never;
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as never;
  };
}

export const bearer = (token: string) => () => ({ authorization: `Bearer ${token}` });
export const basic = (user: string, password: string) => () => ({ authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` });

/** Network blips, rate limits and provider 5xx: worth another try. Auth and bad requests aren't. */
export const transient = (e: unknown) =>
  e instanceof ProviderError ? e.status === 429 || e.status >= 500 : /ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up/i.test(String(e));

/** Retries each provider call up to 3 times with growing waits (1s, 4s, 16s) on transient errors. */
export function withRetries(api: Api, waits = [1000, 4000, 16000]): Api {
  return async (method, path, opts) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await api(method, path, opts);
      } catch (e) {
        if (attempt >= waits.length || !transient(e)) throw e;
        await new Promise((r) => setTimeout(r, waits[attempt]));
      }
    }
  };
}
