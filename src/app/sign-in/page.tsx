import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { isFirstRun, signUpAllowed } from "@/auth/accounts";
import { safeNext, ssoProviders } from "@/auth/sso";
import { getDb } from "@/db/client";
import { currentViewer } from "@/lib/viewer";
import { SignInForm, SignInLinkForm } from "./forms";

export const metadata: Metadata = { title: "Sign in · ALRO" };

export default function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  return (
    <div className="auth">
      <h1>Sign in</h1>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <SignIn searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function SignIn({ searchParams }: { searchParams: PageProps<"/sign-in">["searchParams"] }) {
  await connection();
  const query = await searchParams;
  const next = safeNext(typeof query.next === "string" ? query.next : undefined);
  if (await currentViewer().catch(() => undefined)) redirect(next);
  // A fresh install has no one to sign in as: go straight to setting up the company.
  if (process.env.ALRO_SIGNUP !== "closed" && (await isFirstRun(getDb()))) redirect("/sign-up");
  const error = typeof query.error === "string" ? query.error : undefined;
  const providers = ssoProviders();
  const canSignUp = await signUpAllowed(getDb());
  return (
    <>
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
      {providers.map((p) => (
        <a key={p.id} className="button-link" href={`/api/auth/sso/start?provider=${p.id}&next=${encodeURIComponent(next)}`}>
          Continue with {p.label}
        </a>
      ))}
      {providers.length > 0 && <p className="muted small center">or with a password</p>}
      <SignInForm next={next} />
      <p className="muted small center">or without a password</p>
      <SignInLinkForm next={next} />
      {canSignUp && (
        <p className="small muted">
          New here?{" "}
          <Link className="link" href="/sign-up">
            Set up your company
          </Link>
        </p>
      )}
    </>
  );
}
