import type { Metadata } from "next";
import Link from "next/link";
import { RequestResetForm } from "../sign-in/forms";

export const metadata: Metadata = { title: "Reset your password · ALRO" };

export default function ResetPage() {
  return (
    <div className="auth">
      <h1>Reset your password</h1>
      <RequestResetForm />
      <Link className="link small" href="/sign-in">
        Back to sign in
      </Link>
    </div>
  );
}
