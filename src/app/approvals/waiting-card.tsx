"use client";

import { useActionState } from "react";
import { decideWaiting, type DecisionState } from "./actions";

export interface Waiting {
  id: string;
  revision: number;
  body: string | null;
  /** True for a live-tool call, whose text is its arguments as JSON. */
  json: boolean;
  approveLabel: string;
}

/** The text (editable) and buttons of one waiting proposal. Shows why a decision was refused. */
export function WaitingForm({ a }: { a: Waiting }) {
  const [state, action, pending] = useActionState<DecisionState, FormData>(decideWaiting, {});
  return (
    <form action={action} className="stack">
      <input type="hidden" name="id" value={a.id} />
      <input type="hidden" name="revision" value={a.revision} />
      {a.body !== null && (
        <textarea name="body" defaultValue={a.body} rows={Math.min(14, Math.max(4, a.body.split("\n").length + 1))} aria-label={a.json ? "What it will send to the app (JSON)" : "Text to send"} className={a.json ? "mono small" : undefined} />
      )}
      {state.error && <p className="error small">{state.error}</p>}
      {state.note && <p className="muted small">{state.note}</p>}
      <div className="row">
        <button name="intent" value="approve" disabled={pending}>
          {a.approveLabel}
        </button>
        {a.body !== null && (
          <button name="intent" value="save" className="ghost" disabled={pending}>
            Save changes
          </button>
        )}
        <button name="intent" value="reject" className="ghost" disabled={pending}>
          Drop it
        </button>
      </div>
    </form>
  );
}
