/**
 * Sign-in sources (Google, Microsoft, Xero, QuickBooks). Each needs an OAuth app you register
 * once: its client id and secret go in the environment, and its redirect URL is
 * <ALRO_APP_URL>/api/oauth/callback. ALRO then holds each person's tokens, encrypted.
 */
export type OAuthApp = "google" | "microsoft" | "xero" | "quickbooks";

interface AppConfig {
  label: string;
  /** Where the app is registered, for the "needs … app" hint. */
  console: string;
  env: string;
  authorize: () => string;
  token: () => string;
  clientId: () => string | undefined;
  clientSecret: () => string | undefined;
  /** Extra authorize parameters, e.g. to get a refresh token. */
  extra: Record<string, string>;
  extraScopes: string[];
  /** Some apps want the client id and secret as a Basic header on token requests rather than in the form. */
  basicAuth?: boolean;
  /** Query parameters the app adds to the callback that the connection needs later (QuickBooks' company id). */
  callbackParams?: string[];
}

const tenant = () => process.env.MICROSOFT_TENANT_ID ?? "common";

const APPS: Record<OAuthApp, AppConfig> = {
  google: {
    label: "Google",
    console: "Google Cloud",
    env: "GOOGLE",
    authorize: () => "https://accounts.google.com/o/oauth2/v2/auth",
    token: () => "https://oauth2.googleapis.com/token",
    clientId: () => process.env.GOOGLE_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
    // Without these Google returns no refresh token and the connection dies after an hour.
    extra: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    extraScopes: [],
  },
  microsoft: {
    label: "Microsoft",
    console: "Microsoft Entra",
    env: "MICROSOFT",
    authorize: () => `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/authorize`,
    token: () => `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/token`,
    clientId: () => process.env.MICROSOFT_CLIENT_ID,
    clientSecret: () => process.env.MICROSOFT_CLIENT_SECRET,
    extra: {},
    extraScopes: ["offline_access"],
  },
  xero: {
    label: "Xero",
    console: "the Xero developer portal",
    env: "XERO",
    authorize: () => "https://login.xero.com/identity/connect/authorize",
    token: () => "https://identity.xero.com/connect/token",
    clientId: () => process.env.XERO_CLIENT_ID,
    clientSecret: () => process.env.XERO_CLIENT_SECRET,
    extra: {},
    extraScopes: ["offline_access"],
    basicAuth: true,
  },
  quickbooks: {
    label: "QuickBooks",
    console: "the Intuit developer portal",
    env: "QUICKBOOKS",
    authorize: () => "https://appcenter.intuit.com/connect/oauth2",
    token: () => "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    clientId: () => process.env.QUICKBOOKS_CLIENT_ID,
    clientSecret: () => process.env.QUICKBOOKS_CLIENT_SECRET,
    extra: {},
    extraScopes: [],
    basicAuth: true,
    callbackParams: ["realmId"],
  },
};

export const oauthLabel = (app: OAuthApp) => APPS[app].label;
export const oauthConsole = (app: OAuthApp) => APPS[app].console;
/** Callback query parameters to keep with the connection's tokens. */
export const callbackParams = (app: OAuthApp) => APPS[app].callbackParams ?? [];

export const oauthConfigured = (app: OAuthApp) => !!APPS[app].clientId() && !!APPS[app].clientSecret();

export const oauthEnvNames = (app: OAuthApp) => `${APPS[app].env}_CLIENT_ID and ${APPS[app].env}_CLIENT_SECRET`;

export const redirectUri = (origin: string) => `${(process.env.ALRO_APP_URL ?? origin).replace(/\/$/, "")}/api/oauth/callback`;

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export function authorizeUrl(app: OAuthApp, scopes: string[], state: string, redirect: string): string {
  const cfg = APPS[app];
  const url = new URL(cfg.authorize());
  url.search = new URLSearchParams({
    client_id: cfg.clientId() ?? "",
    redirect_uri: redirect,
    response_type: "code",
    scope: [...scopes, ...cfg.extraScopes].join(" "),
    state,
    ...cfg.extra,
  }).toString();
  return url.toString();
}

async function tokenRequest(app: OAuthApp, params: Record<string, string>, now: number): Promise<OAuthTokens> {
  const cfg = APPS[app];
  const client = { id: cfg.clientId() ?? "", secret: cfg.clientSecret() ?? "" };
  const res = await fetch(cfg.token(), {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      ...(cfg.basicAuth ? { authorization: `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString("base64")}` } : {}),
    },
    body: new URLSearchParams({ ...(cfg.basicAuth ? {} : { client_id: client.id, client_secret: client.secret }), ...params }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) throw new Error(`${app} sign-in failed: ${body.error_description ?? body.error ?? res.status}`);
  return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: now + (body.expires_in ?? 3600) * 1000 };
}

export const exchangeCode = (app: OAuthApp, code: string, redirect: string, now = Date.now()) =>
  tokenRequest(app, { grant_type: "authorization_code", code, redirect_uri: redirect }, now);

export const refreshTokens = (app: OAuthApp, refreshToken: string, now = Date.now()) => tokenRequest(app, { grant_type: "refresh_token", refresh_token: refreshToken }, now);
