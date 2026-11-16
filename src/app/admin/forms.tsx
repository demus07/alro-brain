"use client";

import { useActionState } from "react";
import { invite, resetLink, type AdminState } from "./actions";

function Result({ state }: { state: AdminState }) {
  if (state.error) return <p className="error small">{state.error}</p>;
  if (!state.ok) return null;
  return (
    <div className="small">
      <p>{state.ok}</p>
      {state.link && <input readOnly value={state.link} className="mono small" onFocus={(e) => e.currentTarget.select()} aria-label="One-time link" />}
    </div>
  );
}

export function InviteForm({ departments }: { departments: string[] }) {
  const [state, action, pending] = useActionState<AdminState, FormData>(invite, {});
  return (
    <form action={action} className="connect-form">
      <div className="row">
        <label className="small">
          Work email
          <input name="email" type="email" autoComplete="off" required />
        </label>
        <label className="small">
          Role
          <select name="role" defaultValue="member">
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <label className="small">
          Department <span className="muted">(optional)</span>
          <input name="department" list="known-departments" placeholder="finance" autoComplete="off" />
          <datalist id="known-departments">
            {departments.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
        </label>
      </div>
      <Result state={state} />
      <div>
        <button disabled={pending}>{pending ? "Inviting…" : "Invite"}</button>
      </div>
    </form>
  );
}

export function ResetLink({ id }: { id: string }) {
  const [state, action, pending] = useActionState<AdminState, FormData>(resetLink, {});
  return (
    <form action={action} className="actions">
      <input type="hidden" name="id" value={id} />
      <button className="chip-button" disabled={pending} title="A one-time link for them to choose a new password">
        Reset link
      </button>
      <Result state={state} />
    </form>
  );
}
