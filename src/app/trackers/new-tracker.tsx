"use client";

import { useActionState } from "react";
import { createCustom, type TrackerState } from "./actions";

/** A tracker of your own: what counts as a row, and its columns. */
export function NewTracker() {
  const [state, action, pending] = useActionState<TrackerState, FormData>(createCustom, {});
  return (
    <form action={action} className="card">
      <h2>Your own tracker</h2>
      <label className="small">
        Name
        <input name="name" placeholder="Port arrivals" autoComplete="off" required />
      </label>
      <label className="small">
        What counts as a row?
        <textarea name="description" rows={2} placeholder="Each container or shipment reported as arrived at a port, with its contents." required />
      </label>
      <label className="small">
        Columns, one per line: name | text, number or date | note
        <textarea name="columns" rows={5} className="mono" defaultValue={"Shipment | text\nPort | text\nArrived | date\nTonnes | number\nGrade | text"} required />
      </label>
      {state.error && <p className="error small">{state.error}</p>}
      <button disabled={pending}>{pending ? "Creating…" : "Create and fill it"}</button>
    </form>
  );
}
