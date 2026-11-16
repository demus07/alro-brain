import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Workspace } from "../workspace";

export const metadata: Metadata = { title: "Team runs · ALRO" };

export default function TeamRunsPage() {
  return (
    <>
      <p className="crumbs small">
        <Link href="/team">Team</Link> /
      </p>
      <h1>What the team is doing</h1>
      <p className="muted">Every piece of work you gave a department: what each specialist reported, what it cost and the answer. Work in progress shows as it happens. Only you see your own runs.</p>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Workspace limit={40} />
      </Suspense>
    </>
  );
}
