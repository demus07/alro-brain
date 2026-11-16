import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { signUpAllowed, signUpNeedsEmailProof } from "@/auth/accounts";
import { getDb } from "@/db/client";
import { SignUpForm } from "../sign-in/forms";

export const metadata: Metadata = { title: "Set up your company · ALRO" };

export default function SignUpPage() {
  return (
    <div className="auth">
      <h1>Set up your company</h1>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <SignUp />
      </Suspense>
    </div>
  );
}

async function SignUp() {
  await connection();
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
      <SignUpForm confirmByEmail={signUpNeedsEmailProof()} />
      <p className="small muted">
        Already set up?{" "}
        <Link className="link" href="/sign-in">
          Sign in
        </Link>
      </p>
    </>
  );
}
