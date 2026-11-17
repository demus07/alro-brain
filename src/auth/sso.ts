import { createHash } from "node:crypto";
import { sign, verify } from "@/lib/secrets";

/**
 * Single sign-on with the company's identity provider. Three ways in:
 *  - google:    the Google app already registered for Gmail/Calendar (GOOGLE_CLIENT_ID/SECRET).
 *  - microsoft: the Microsoft app, only when MICROSOFT_TENANT_ID names one tenant. With "common" any
 *               Microsoft tenant could assert any email address, so it's refused.
 *  - oidc:      any OpenID Connect provider (Okta, Entra, Auth0, Keycloak): OIDC_ISSUER, OIDC_CLIENT_ID,
 *               OIDC_CLIENT_SECRET and optionally OIDC_NAME for the button.
 * The provider proves an email address; ALRO signs in the member who has it, or lets someone with a
 * live invitation join. Nobody else is created by SSO, except the first owner setting up the company
 * on a fresh install. Redirect URL to register: <ALRO_APP_URL>/api/auth/sso/callback.
 *
 * The provider is set once for the whole deployment, so it is only trusted when the deployment
 * serves one company (its own identity provider). Where anyone can sign up, one company's
 * provider could assert another company's addresses: SSO is off there until providers can be
 * bound to a company.
 */
export type SsoProvider = "google" | "microsoft" | "oidc";

interface Endpoints {
  authorize: string;
  token: string;
  userinfo: string;
}

interface Config {
  label: string;
  clientId: string;
  clientSecret: string;
  endpoints: () => Promise<Endpoints>;
}

const SHARED_TENANTS = new Set(["common", "organizations", "consumers"]);
const discovered = new Map<string, Promise<Endpoints>>();

/** Reads the provider's published endpoints once (/.well-known/openid-configuration). */
function discover(issuer: string): Promise<Endpoints> {
  const base = issuer.replace(/\/$/, "");
  if (!discovered.has(base)) {
    discovered.set(
      base,
      (async () => {
        if (!base.startsWith("https://")) throw new Error("OIDC_ISSUER must be an https URL");
        const res = await fetch(`${base}/.well-known/openid-configuration`);
        const doc = (await res.json()) as { authorization_endpoint?: string; token_endpoint?: string; userinfo_endpoint?: string };
        if (!res.ok || !doc.authorization_endpoint || !doc.token_endpoint || !doc.userinfo_endpoint) throw new Error("The identity provider's configuration couldn't be read");
        return { authorize: doc.authorization_endpoint, token: doc.token_endpoint, userinfo: doc.userinfo_endpoint };
      })().catch((e) => {
        discovered.delete(base);
        throw e;
      }),
    );
  }
  return discovered.get(base)!;
}

function configOf(provider: SsoProvider): Config | undefined {
  const env = process.env;
  if (provider === "google" && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    return {
      label: "Google",
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      endpoints: async () => ({ authorize: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token", userinfo: "https://openidconnect.googleapis.com/v1/userinfo" }),
    };
  }
  const tenant = env.MICROSOFT_TENANT_ID;
  if (provider === "microsoft" && env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET && tenant && !SHARED_TENANTS.has(tenant)) {
    return {
      label: "Microsoft",
      clientId: env.MICROSOFT_CLIENT_ID,
      clientSecret: env.MICROSOFT_CLIENT_SECRET,
      endpoints: async () => ({
        authorize: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
        token: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
        userinfo: "https://graph.microsoft.com/oidc/userinfo",
      }),
    };
  }
  if (provider === "oidc" && env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET) {
    return { label: env.OIDC_NAME ?? "single sign-on", clientId: env.OIDC_CLIENT_ID, clientSecret: env.OIDC_CLIENT_SECRET, endpoints: () => discover(env.OIDC_ISSUER!) };
  }
  return undefined;
}

/** Off on deployments open to many companies (see above). */
export const ssoAllowed = () => process.env.ALRO_SIGNUP !== "open";

/** The providers set up on this deployment, for the sign-in page's buttons. */
export const ssoProviders = (): { id: SsoProvider; label: string }[] =>
  ssoAllowed()
    ? (["oidc", "google", "microsoft"] as const).flatMap((id) => {
        const cfg = configOf(id);
        return cfg ? [{ id, label: cfg.label }] : [];
      })
    : [];

export const ssoRedirectUri = (origin: string) => `${(process.env.ALRO_APP_URL ?? origin).replace(/\/$/, "")}/api/auth/sso/callback`;

const nonceHash = (nonce: string) => createHash("sha256").update(nonce).digest("base64url");

/** The company to create when the first owner signs up with a provider instead of a password. */
export interface SsoSignUp {
  company: string;
  name: string;
  timezone: string;
}

/** Where to send the browser. The state is signed and tied to a nonce kept in this browser's cookie. */
export async function ssoStart(provider: SsoProvider, origin: string, nonce: string, next: string, signUp?: SsoSignUp): Promise<string> {
  const cfg = ssoAllowed() ? configOf(provider) : undefined;
  if (!cfg) throw new Error("That sign-in method isn't set up on this server.");
  const { authorize } = await cfg.endpoints();
  const url = new URL(authorize);
  url.search = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: ssoRedirectUri(origin),
    response_type: "code",
    scope: "openid email profile",
    state: sign({ p: provider, n: nonceHash(nonce), to: next, ...(signUp ? { s: { c: signUp.company.slice(0, 120), n: signUp.name.slice(0, 120), z: signUp.timezone.slice(0, 64) } } : {}) }, 10 * 60 * 1000),
    prompt: "select_account",
  }).toString();
  return url.toString();
}

/**
 * Finishes the round trip: checks the state against this browser's nonce, trades the code for a
 * token and asks the provider whose it is. Returns the proven, lower-cased email.
 */
export async function ssoFinish(
  params: { state: string | null; code: string | null; nonce: string | undefined },
  origin: string,
): Promise<{ email: string; name: string; provider: SsoProvider; next: string; signUp?: SsoSignUp }> {
  const state = verify<{ p: SsoProvider; n: string; to: string; s?: { c: string; n: string; z: string } }>(params.state);
  if (!state || !params.nonce || state.n !== nonceHash(params.nonce)) throw new Error("That sign-in expired. Try again.");
  const cfg = ssoAllowed() ? configOf(state.p) : undefined;
  if (!cfg || !params.code) throw new Error("Sign-in was cancelled.");
  const endpoints = await cfg.endpoints();
  const tokenRes = await fetch(endpoints.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: params.code, redirect_uri: ssoRedirectUri(origin), client_id: cfg.clientId, client_secret: cfg.clientSecret }),
  });
  const token = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
  if (!tokenRes.ok || !token.access_token) throw new Error(`${cfg.label} sign-in failed${token.error_description ? `: ${token.error_description.slice(0, 120)}` : "."}`);
  const infoRes = await fetch(endpoints.userinfo, { headers: { authorization: `Bearer ${token.access_token}` } });
  const info = (await infoRes.json().catch(() => ({}))) as { email?: string; email_verified?: boolean | string; name?: string };
  if (!infoRes.ok || !info.email) throw new Error(`${cfg.label} didn't share an email address.`);
  // Google accounts can carry any address until it's verified, so Google must say it is. A company's own
  // provider (OIDC, a single Microsoft tenant) is trusted for its directory unless it says otherwise.
  const verified = info.email_verified === true || info.email_verified === "true";
  const denied = info.email_verified === false || info.email_verified === "false";
  if (denied || (state.p === "google" && !verified)) throw new Error("That email address hasn't been verified with the identity provider.");
  return {
    email: info.email.trim().toLowerCase(),
    name: typeof info.name === "string" ? info.name.trim().slice(0, 120) : "",
    provider: state.p,
    next: safeNext(state.to),
    signUp: state.s ? { company: state.s.c, name: state.s.n, timezone: state.s.z } : undefined,
  };
}

/** Only ever redirect to a path on this site. */
export const safeNext = (next: string | null | undefined) =>
  next && /^\/(?!\/)[\w\-./?=&%]*$/.test(next) && !next.includes("//") && !next.includes("..") && !next.startsWith("/api/") ? next : "/";
