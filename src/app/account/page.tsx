import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { credentials, orgs } from "@/db/schema";
import { formatShort } from "@/lib/time";
import { getViewer } from "@/lib/viewer";
import { sessionsOf } from "@/platform/members";
import { ROLE_LABEL } from "@/platform/roles";
import { signOutOthers } from "./actions";
import { PasswordForm } from "./password-form";

export const metadata: Metadata = { title: "Your account · ALRO" };

export default function AccountPage() {
  return (
    <div className="settings">
      <h1>Your account</h1>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Account />
      </Suspense>
    </div>
  );
}

const METHOD: Record<string, string> = { password: "password", invite: "invitation" };

async function Account() {
  await connection();
  const viewer = await getViewer();
  const db = getDb();
  const [[org], [credential], sessions] = await Promise.all([
    db.select({ name: orgs.name, timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, viewer.orgId)),
    db.select({ at: credentials.updatedAt }).from(credentials).where(eq(credentials.personId, viewer.personId)),
    sessionsOf(db, viewer.personId),
  ]);
  return (
    <>
      <section className="settings-section">
        <div>
          <h2>You</h2>
          <p className="muted small">
            What ALRO knows about how you work is under{" "}
            <Link className="link" href="/settings">
              Settings → About you
            </Link>
            .
          </p>
        </div>
        <ul className="sources">
          <li className="source">
            <span className="source-text">
              <span className="source-name">{viewer.displayName}</span>
              <span className="muted small">{[viewer.email, ROLE_LABEL[viewer.role], viewer.department, org.name].filter(Boolean).join(" · ")}</span>
            </span>
          </li>
        </ul>
      </section>
      <section className="settings-section">
        <div>
          <h2>Password</h2>
          <p className="muted small">Changing it signs out your other browsers.</p>
        </div>
        <PasswordForm hasPassword={!!credential} />
      </section>
      <section className="settings-section">
        <div>
          <h2>Where you&apos;re signed in</h2>
          <p className="muted small">A sign-in lasts 30 days.</p>
        </div>
        <div className="settings-sources">
          {sessions.length === 0 && <p className="muted small">Development mode: acting as {viewer.email} without a sign-in.</p>}
          <ul className="sources">
            {sessions.map((s) => (
              <li key={s.id} className="source">
                <span className="source-text">
                  <span className="source-name">
                    {browserOf(s.userAgent)}
                    {s.id === viewer.sessionId && <span className="muted small"> (this browser)</span>}
                  </span>
                  <span className="muted small">
                    Signed in {formatShort(s.createdAt, org.timezone)} with {METHOD[s.method] ?? "single sign-on"} · last used {formatShort(s.lastSeenAt, org.timezone)}
                    {s.ip ? ` · ${s.ip}` : ""}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          {sessions.length > 1 && (
            <form action={signOutOthers}>
              <button className="ghost">Sign out everywhere else</button>
            </form>
          )}
        </div>
      </section>
    </>
  );
}

/** "Chrome on macOS" from a user-agent string, roughly. */
function browserOf(ua: string | null): string {
  if (!ua) return "A browser";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "A browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}
