import { Suspense } from "react";
import { Chat } from "./chat";

export default function Home() {
  // The chat creates a random conversation id on first render, so it renders per request.
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <Chat />
    </Suspense>
  );
}
