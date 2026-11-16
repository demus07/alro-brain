"use client";

import { useActionState } from "react";
import { changePasswordAction, type AccountState } from "./actions";

export function PasswordForm({ hasPassword }: { hasPassword: boolean }) {
  const [state, action, pending] = useActionState<AccountState, FormData>(changePasswordAction, {});
  return (
    <form action={action} className="connect-form" key={state.ok}>
      {hasPassword && (
        <label className="small">
          Current password
          <input name="current" type="password" autoComplete="current-password" required />
        </label>
      )}
      <label className="small">
        New password <span className="muted">(10 characters or more)</span>
        <input name="password" type="password" autoComplete="new-password" minLength={10} required />
      </label>
      {state.error && <p className="error small">{state.error}</p>}
      {state.ok && <p className="small">{state.ok}</p>}
      <div>
        <button disabled={pending}>{pending ? "Saving…" : hasPassword ? "Change password" : "Set a password"}</button>
      </div>
    </form>
  );
}
