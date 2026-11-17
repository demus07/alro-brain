import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { signUpAllowed, signUpNeedsEmailProof } from "@/auth/accounts";
import { ssoProviders } from "@/auth/sso";
import { getDb } from "@/db/client";
import { SignUpForm } from "../sign-in/forms";

export const metadata: Metadata = { title: "Set up your company · ALRO" };

export default function SignUpPage({ searchParams }: PageProps<"/sign-up">) {
  return (
    <div className="auth">
      <h1>Set up your company</h1>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <SignUp searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function SignUp({ searchParams }: { searchParams: PageProps<"/sign-up">["searchParams"] }) {
  await connection();
  const query = await searchParams;
  // From a "Continue with Google / Microsoft" round trip that didn't work out.
  const error = typeof query.error === "string" ? query.error : undefined;
  if (!(await signUpAllowed(getDb()))) {
    return (
      <p>
        New companies can&apos;t be created here. Ask your admin for an invitation, or{" "}
        <Link className="link" href="/sign-in">
          sign in
        </Link>
        .
      </p>
    );
  }
  return (
    <>
      <p className="muted small">You&apos;ll be its owner. Next you&apos;ll invite your team and connect the apps you work in.</p>
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
      <SignUpForm confirmByEmail={signUpNeedsEmailProof()} providers={ssoProviders()} />
      <p className="small muted">
        Already set up?{" "}
        <Link className="link" href="/sign-in">
          Sign in
        </Link>
      </p>
    </>
  );
}
