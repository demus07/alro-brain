"use client";

import { useActionState } from "react";
import type { Field } from "@/connectors/provider";
import { connectWithToken, type ConnectState } from "./actions";

/**
 * A source's connect form, shown in its side panel: where to get the token, the fields, and what
 * went wrong if the app refused it. Once connected, the page refreshes and the source moves to Connected.
 */
export function ConnectForm({ provider, label, fields, setup, docsUrl }: { provider: string; label: string; fields: Field[]; setup: string; docsUrl?: string }) {
  const [state, action, pending] = useActionState<ConnectState, FormData>(connectWithToken, {});
  if (state.ok) return <p className="notice">Connected {label}. The first sync runs in the background.</p>;
  return (
    <form action={action} className="panel-form">
      <input type="hidden" name="provider" value={provider} />
      <p className="muted small">
        {setup}{" "}
        {docsUrl && (
          <a className="link" href={docsUrl} target="_blank" rel="noreferrer">
            Open {label} →
          </a>
        )}
      </p>
      {fields.map((f) => (
        <label key={f.name}>
          {f.label}
          {f.optional && <span className="muted"> (optional)</span>}
          <input name={f.name} type={f.secret ? "password" : "text"} placeholder={f.placeholder} autoComplete="off" required={!f.optional} />
        </label>
      ))}
      {state.error && <p className="error small">{state.error}</p>}
      <button disabled={pending}>{pending ? "Checking…" : `Connect ${label}`}</button>
    </form>
  );
}
