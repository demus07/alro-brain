"use client";

import { useActionState } from "react";
import type { Field } from "@/connectors/provider";
import { connectWithToken, type ConnectState } from "./actions";

/** A source's connect form: where to get the token, the fields, and what went wrong if the app refused it. */
export function ConnectForm({ provider, label, mark, fields, setup, docsUrl }: { provider: string; label: string; mark: string; fields: Field[]; setup: string; docsUrl?: string }) {
  const [state, action, pending] = useActionState<ConnectState, FormData>(connectWithToken, {});
  return (
    <details className="connect">
      <summary className="source">
        <span className="mark">{mark}</span>
        <span className="source-name">{label}</span>
        <span className="chip-button">Connect</span>
      </summary>
      <form action={action} className="connect-form">
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
          <label key={f.name} className="small">
            {f.label}
            {f.optional && <span className="muted"> (optional)</span>}
            <input name={f.name} type={f.secret ? "password" : "text"} placeholder={f.placeholder} autoComplete="off" required={!f.optional} />
          </label>
        ))}
        {state.error && <p className="error small">{state.error}</p>}
        <div>
          <button disabled={pending}>{pending ? "Checking…" : `Connect ${label}`}</button>
        </div>
      </form>
    </details>
  );
}
