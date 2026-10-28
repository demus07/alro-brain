import { Suspense } from "react";
import { Chat } from "./chat";

export default function Home() {
  return (
    <>
      <h1>Ask</h1>
      {/* The chat creates a random conversation id on first render, so it renders per request. */}
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Chat />
      </Suspense>
    </>
  );
}
