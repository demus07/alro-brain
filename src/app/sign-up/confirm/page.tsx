import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { readSignUpToken } from "@/auth/accounts";
import { ConfirmSignUpForm } from "../../sign-in/forms";

export const metadata: Metadata = { title: "Finish setting up · ALRO" };

type Search = Promise<{ token?: string }>;

export default function ConfirmPage({ searchParams }: { searchParams: Search }) {
  return (
    <div className="auth">
      <h1>Choose a password</h1>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Confirm searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Confirm({ searchParams }: { searchParams: Search }) {
  await connection();
  const { token } = await searchParams;
  const details = readSignUpToken(token);
  if (!details || !token) {
    return (
      <p className="muted">
        That link has expired.{" "}
        <Link className="link" href="/sign-up">
          Start again
        </Link>
        .
      </p>
    );
  }
  return (
    <>
      <p className="muted small">
        {details.email} is confirmed. This finishes setting up {details.company}.
      </p>
      <ConfirmSignUpForm token={token} />
    </>
  );
}
