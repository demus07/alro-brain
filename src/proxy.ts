import { NextResponse, type NextRequest } from "next/server";
import { API_CALL_HEADER, SESSION_COOKIE } from "@/auth/sessions";

/**
 * Reached without a session: the sign-in pages, incoming webhooks (signed by their sender), cron (its own secret),
 * and addresses protected by an unguessable token in the link: a source's push address, a company's lead form,
 * and a quote or invoice shared with a customer.
 */
const PUBLIC = /^\/(sign-in(\/|$)|sign-up(\/|$)|invite\/|reset(\/|$)|api\/auth\/|api\/channels\/|api\/cron\/|api\/hooks\/|api\/leads\/|api\/docs\/)/;

/**
 * A first, cheap check before any page runs: no session cookie means sign in first. The real
 * check (is the session live, is the member still active) happens in getViewer on every read.
 */
export function proxy(request: NextRequest) {
  if (process.env.NODE_ENV !== "production" && process.env.ALRO_AUTH !== "on") return NextResponse.next();
  const { pathname, search } = request.nextUrl;
  if (PUBLIC.test(pathname)) return NextResponse.next();
  if (request.cookies.has(SESSION_COOKIE)) {
    // Tells getViewer this is an API call, so a session that turns out to be dead gets a 401 rather than the sign-in page.
    const headers = new Headers(request.headers);
    if (pathname.startsWith("/api/")) headers.set(API_CALL_HEADER, "1");
    else headers.delete(API_CALL_HEADER);
    return NextResponse.next({ request: { headers } });
  }
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const signIn = new URL("/sign-in", request.url);
  if (pathname !== "/") signIn.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(signIn);
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
