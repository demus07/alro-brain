import { authorizeUrl, oauthConfigured, redirectUri } from "@/connectors/oauth";
import { providerOf } from "@/connectors/registry";
import { sign } from "@/lib/secrets";
import { getViewer } from "@/lib/viewer";
import { isAdmin } from "@/platform/roles";

/** Sends the signed-in member to Google or Microsoft to grant read access for one source. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const provider = providerOf(url.searchParams.get("provider") ?? "");
  if (!provider || provider.auth.kind !== "oauth") return Response.json({ error: "Unknown source" }, { status: 404 });
  if (!oauthConfigured(provider.auth.app)) return Response.json({ error: `${provider.auth.app} sign-in isn't set up on this server` }, { status: 400 });
  const viewer = await getViewer();
  if (provider.scope === "org" && !isAdmin(viewer)) {
    return Response.redirect(new URL(`/settings?error=${encodeURIComponent("Only an admin can connect a source for the whole team.")}`, url.origin), 302);
  }
  // The state proves the callback belongs to this person and this source, and expires quickly.
  const state = sign({ p: provider.id, o: viewer.orgId, u: viewer.personId }, 10 * 60 * 1000);
  return Response.redirect(authorizeUrl(provider.auth.app, provider.auth.scopes, state, redirectUri(url.origin)), 302);
}
