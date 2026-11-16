import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { findInvitation } from "@/auth/accounts";
import { getDb } from "@/db/client";
import { ResetForm } from "../../sign-in/forms";

export const metadata: Metadata = { title: "Choose a new password · ALRO" };

export default function NewPasswordPage({ params }: PageProps<"/reset/[token]">) {
  return (
    <div className="auth">
      <h1>Choose a new password</h1>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <NewPassword params={params} />
      </Suspense>
    </div>
  );
}

async function NewPassword({ params }: { params: PageProps<"/reset/[token]">["params"] }) {
  await connection();
  const { token } = await params;
  const reset = await findInvitation(getDb(), token);
  if (!reset || reset.kind !== "reset") {
    return (
      <p className="muted">
        That link expired or was already used.{" "}
        <Link className="link" href="/reset">
          Ask for a new one
        </Link>
        .
      </p>
    );
  }
  return <ResetForm token={token} />;
}
