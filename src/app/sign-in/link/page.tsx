import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { findInvitation } from "@/auth/accounts";
import { safeNext } from "@/auth/sso";
import { getDb } from "@/db/client";
import { RedeemSignInLinkForm } from "../forms";

export const metadata: Metadata = { title: "Sign in · ALRO" };

/**
 * Where an emailed sign-in link lands. Opening it changes nothing (mail scanners open links to
 * check them); the button uses the link.
 */
export default function SignInLinkPage({ searchParams }: PageProps<"/sign-in/link">) {
  return (
    <div className="auth">
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <SignInLink searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function SignInLink({ searchParams }: { searchParams: PageProps<"/sign-in/link">["searchParams"] }) {
  await connection();
  const query = await searchParams;
  const token = typeof query.token === "string" ? query.token : "";
  const link = token ? await findInvitation(getDb(), token) : undefined;
  if (!link || link.kind !== "signin") {
    return (
      <>
        <h1>This sign-in link isn&apos;t valid any more</h1>
        <p className="muted">
          It expired or was already used.{" "}
          <Link className="link" href="/sign-in">
            Ask for a new one
          </Link>
          .
        </p>
      </>
    );
  }
  return (
    <>
      <h1>Sign in to {link.company}</h1>
      <p className="muted small">As {link.email}.</p>
      <RedeemSignInLinkForm token={token} next={safeNext(typeof query.next === "string" ? query.next : undefined)} />
    </>
  );
}
