import { eq } from "drizzle-orm";
import { after } from "next/server";
import { defaultModels } from "@/ai/models";
import { callbackParams, exchangeCode, redirectUri } from "@/connectors/oauth";
import { registerPush } from "@/connectors/push";
import { providerOf } from "@/connectors/registry";
import { connectAccount, syncConnection } from "@/connectors/sync";
import { getDb } from "@/db/client";
import { connections } from "@/db/schema";
import { audit } from "@/lib/audit";
import { verify } from "@/lib/secrets";
import { sourceOf } from "@/lib/sources";
import { isAdmin } from "@/platform/roles";
import { assertWithin } from "@/platform/usage";
import { getViewer } from "@/lib/viewer";
import { processAndRepair } from "@/ops/repair";

/** The sign-in app sends the member back here with a code; trade it for tokens and connect the source. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const back = (params: Record<string, string>) => Response.redirect(new URL(`/settings?${new URLSearchParams(params)}`, url.origin), 302);
  const state = verify<{ p: string; o: string; u: string }>(url.searchParams.get("state"));
  const provider = state && providerOf(state.p);
  const code = url.searchParams.get("code");
  if (!state || !provider || provider.auth.kind !== "oauth") return back({ error: "That sign-in link expired. Try connecting again." });
  if (!code) return back({ error: url.searchParams.get("error_description") ?? url.searchParams.get("error") ?? "Sign-in was cancelled." });

  const viewer = await getViewer();
  if (viewer.personId !== state.u || viewer.orgId !== state.o) return back({ error: "That sign-in was started by someone else." });
  if (provider.scope === "org" && !isAdmin(viewer)) return back({ error: "Only an admin can connect a source for the whole team." });
  try {
    await assertWithin(getDb(), viewer.orgId, ["sources"]);
    const tokens = await exchangeCode(provider.auth.app, code, redirectUri(url.origin));
    const db = getDb();
    const kept = callbackParams(provider.auth.app).flatMap((k) => (url.searchParams.get(k) ? [[k, url.searchParams.get(k)!]] : []));
    const account = kept.length ? Object.fromEntries(kept) : undefined;
    const id = await connectAccount(db, viewer, provider, { kind: "oauth", app: provider.auth.app, ...tokens, account });
    await audit(db, { orgId: viewer.orgId, personId: viewer.personId, action: "source.connect", target: sourceOf(provider.id).label });
    after(async () => {
      const [c] = await db.select().from(connections).where(eq(connections.id, id));
      if (!c) return;
      await registerPush(db, c);
      if (!provider.sync) return;
      const r = await syncConnection(db, c);
      if (r.messages) await processAndRepair(db, viewer.orgId, defaultModels());
    });
    return back({ connected: provider.id });
  } catch (e) {
    return back({ error: e instanceof Error ? e.message : "Couldn't connect." });
  }
}
