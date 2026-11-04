/**
 * Nango holds the OAuth apps and tokens (refreshing them); ALRO only ever calls
 * provider APIs through Nango's proxy, so no provider token is stored here.
 * Works with Nango Cloud (free: 10 connections) or a self-hosted Nango (NANGO_HOST).
 * https://nango.dev/docs/reference/backend/http-api/proxy/get
 */
const host = () => (process.env.NANGO_HOST ?? "https://api.nango.dev").replace(/\/$/, "");
const key = () => {
  const k = process.env.NANGO_SECRET_KEY;
  if (!k) throw new Error("Set NANGO_SECRET_KEY in .env.local to connect live sources.");
  return k;
};

export const nangoConfigured = () => !!process.env.NANGO_SECRET_KEY;

/** One provider call, as the connected account. */
export type Api = <T = Record<string, unknown>>(
  method: "GET" | "POST",
  path: string,
  opts?: { query?: Record<string, string | number | undefined>; body?: unknown; headers?: Record<string, string> },
) => Promise<T>;

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function nango<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${host()}${path}`, { ...init, headers: { authorization: `Bearer ${key()}`, "content-type": "application/json", ...init.headers } });
  if (!res.ok) throw new ProviderError(`Nango ${init.method ?? "GET"} ${path.split("?")[0]}: ${res.status} ${(await res.text()).slice(0, 300)}`, res.status);
  return (await res.json()) as T;
}

/** A short-lived link that opens Nango's connect screen for these integrations; the new connection is tagged with who made it. */
export async function createConnectLink(tags: { end_user_id: string; organization_id: string; end_user_email?: string }, integrations: string[]): Promise<string> {
  const { data } = await nango<{ data: { token: string; connect_link?: string } }>("/connect/sessions", {
    method: "POST",
    body: JSON.stringify({ tags, allowed_integrations: integrations }),
  });
  return data.connect_link ?? `https://connect.nango.dev?session_token=${encodeURIComponent(data.token)}`;
}

export interface NangoConnection {
  connection_id: string;
  provider: string;
  provider_config_key: string;
  tags?: Record<string, string>;
  errors?: { type: string }[];
}

/** Connections a person made, by their tags. */
export async function listConnections(tags: Record<string, string>): Promise<NangoConnection[]> {
  const q = new URLSearchParams(Object.entries(tags).map(([k, v]) => [`tags[${k}]`, v]));
  return (await nango<{ connections: NangoConnection[] }>(`/connections?${q}`)).connections;
}

/** Provider API calls through Nango's proxy, with retries on 429 and 5xx. */
export function proxyApi(connectionId: string, integration: string): Api {
  return async (method, path, opts = {}) => {
    const q = new URLSearchParams(Object.entries(opts.query ?? {}).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]])));
    return nango(`/proxy/${path.replace(/^\//, "")}${q.size ? `?${q}` : ""}`, {
      method,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      // Nango forwards headers to the provider only with this prefix.
      headers: { "Connection-Id": connectionId, "Provider-Config-Key": integration, Retries: "3", ...Object.fromEntries(Object.entries(opts.headers ?? {}).map(([k, v]) => [`nango-proxy-${k}`, v])) },
    });
  };
}
