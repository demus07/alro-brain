import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { findInvitation } from "@/auth/accounts";
import { ssoProviders } from "@/auth/sso";
import { getDb } from "@/db/client";
import { InviteForm } from "../../sign-in/forms";

export const metadata: Metadata = { title: "Join · ALRO" };

export default function InvitePage({ params }: PageProps<"/invite/[token]">) {
  return (
    <div className="auth">
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Invite params={params} />
      </Suspense>
    </div>
  );
}

async function Invite({ params }: { params: PageProps<"/invite/[token]">["params"] }) {
  await connection();
  const { token } = await params;
  const invite = await findInvitation(getDb(), token);
  if (!invite || invite.kind !== "invite") {
    return (
      <>
        <h1>This invitation isn&apos;t valid any more</h1>
        <p className="muted">It expired or was already used. Ask whoever invited you for a new one, or{" "}
          <Link className="link" href="/sign-in">
            sign in
          </Link>
          .
        </p>
      </>
    );
  }
  return (
    <>
      <h1>Join {invite.company}</h1>
      <p className="muted small">You&apos;ll only see what you can already see in the apps your company connects.</p>
      {/* Joining with a provider works for the invited address only: the callback matches it to this invitation. */}
      {ssoProviders().map((p) => (
        <a key={p.id} className="button-link" href={`/api/auth/sso/start?provider=${p.id}&next=/welcome`}>
          Continue with {p.label} as {invite.email}
        </a>
      ))}
      {ssoProviders().length > 0 && <p className="muted small center">or choose a password</p>}
      <InviteForm token={token} email={invite.email} />
    </>
  );
}
