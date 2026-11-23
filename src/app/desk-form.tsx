"use client";

import { useActionState, type ReactNode } from "react";
import type { DeskState } from "./desk-actions";

/** A form that runs a desk action and shows its refusal or note beside the button. */
export function ActionForm({ action, children, button, ghost, className }: { action: (prev: DeskState, data: FormData) => Promise<DeskState>; children?: ReactNode; button: string; ghost?: boolean; className?: string }) {
  const [state, run, pending] = useActionState(action, {});
  return (
    <form action={run} className={className}>
      {children}
      <button type="submit" className={ghost ? "ghost" : undefined} disabled={pending}>
        {pending ? "Working…" : button}
      </button>
      {state.error && (
        <p role="alert" className="error">
          {state.error}
        </p>
      )}
      {state.note && <p className="muted">{state.note}</p>}
    </form>
  );
}

/** One id-carrying button (a row's "Remind", "Done"). */
export function RowButton({ action, id, label, extra, ghost = true }: { action: (prev: DeskState, data: FormData) => Promise<DeskState>; id: string; label: string; extra?: Record<string, string>; ghost?: boolean }) {
  return (
    <ActionForm action={action} button={label} ghost={ghost} className="row-action">
      <input type="hidden" name="id" value={id} />
      {Object.entries(extra ?? {}).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
    </ActionForm>
  );
}
