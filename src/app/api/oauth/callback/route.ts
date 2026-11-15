import { eq } from "drizzle-orm";
import { after } from "next/server";
import { defaultModels } from "@/ai/models";
import { exchangeCode, redirectUri } from "@/connectors/oauth";
import { providerOf } from "@/connectors/registry";
import { connectAccount, syncConnection } from "@/connectors/sync";
import { getDb } from "@/db/client";
import { connections } from "@/db/schema";
import { verify } from "@/lib/secrets";
import { getViewer } from "@/lib/viewer";
import { runPipeline } from "@/pipeline/run";

/** Google or Microsoft sends the member back here with a code; trade it for tokens and connect the source. */
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
  try {
    const tokens = await exchangeCode(provider.auth.app, code, redirectUri(url.origin));
    const db = getDb();
    const id = await connectAccount(db, viewer, provider, { kind: "oauth", app: provider.auth.app, ...tokens });
    after(async () => {
      const [c] = await db.select().from(connections).where(eq(connections.id, id));
      if (!c || !provider.sync) return;
      const r = await syncConnection(db, c);
      if (r.messages) await runPipeline(db, viewer.orgId, defaultModels());
    });
    return back({ connected: provider.id });
  } catch (e) {
    return back({ error: e instanceof Error ? e.message : "Couldn't connect." });
  }
}
