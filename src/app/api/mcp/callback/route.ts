import { getDb } from "@/db/client";
import { getViewer } from "@/lib/viewer";
import { finishSignIn } from "@/tools/mcp";

/** A live-tool server sends the member back here after they authorise ALRO. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const back = (params: Record<string, string>) => Response.redirect(new URL(`/settings?${new URLSearchParams(params)}`, url.origin), 302);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return back({ error: url.searchParams.get("error_description") ?? "Sign-in was cancelled." });
  try {
    await finishSignIn(getDb(), await getViewer(), state, code, url.origin);
    return back({ connected: "live tools" });
  } catch (e) {
    return back({ error: e instanceof Error ? e.message : "Couldn't finish the sign-in." });
  }
}
