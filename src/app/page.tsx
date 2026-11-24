import { connection } from "next/server";
import { Suspense } from "react";
import { currentViewer } from "@/lib/viewer";
import { Chat } from "./chat";

export default function Home() {
  // The chat creates a random conversation id on first render, so it renders per request.
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <Agent />
    </Suspense>
  );
}

/** The chat, greeting the signed-in person by first name when there is one. */
async function Agent() {
  // Per request, before the lookup: its catch below must not swallow the prerender bail-out.
  await connection();
  const viewer = await currentViewer().catch(() => undefined);
  const firstName = viewer?.displayName.trim().split(/\s+/)[0] || undefined;
  return <Chat firstName={firstName} />;
}
