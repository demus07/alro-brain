"use client";

import { useActionState } from "react";
import { addSpecialist, removeSpecialist, toggleSpecialist, updateSpecialist, type TeamState } from "./actions";

/** A specialist of your own, in an existing department or a new one. */
export function NewSpecialist({ departments }: { departments: string[] }) {
  const [state, action, pending] = useActionState<TeamState, FormData>(addSpecialist, {});
  return (
    <form action={action} className="card">
      <h2>New specialist</h2>
      <label className="small">
        Department
        <input name="department" list="departments" placeholder="finance" required />
        <datalist id="departments">
          {departments.map((d) => (
            <option key={d} value={d} />
          ))}
        </datalist>
      </label>
      <label className="small">
        Name
        <input name="name" placeholder="Payment matcher" required />
      </label>
      <label className="small">
        Job
        <textarea name="job" rows={4} placeholder="Match each payment received this week to its invoice and list what doesn't match." required />
      </label>
      <label className="small">
        Tools (optional)
        <input name="tools" placeholder="xero_, searchMemory" className="mono" />
      </label>
      {state.error && <p className="error small">{state.error}</p>}
      <button disabled={pending}>{pending ? "Adding…" : "Add specialist"}</button>
    </form>
  );
}

/** Edit, switch off or remove one specialist. Shown only to whoever added it and to admins. */
export function EditSpecialist({ specialist }: { specialist: { id: string; name: string; job: string; tools: string[]; enabled: boolean } }) {
  const [state, action, pending] = useActionState<TeamState, FormData>(updateSpecialist, {});
  return (
    <form action={action} className="connect-form">
      <input type="hidden" name="id" value={specialist.id} />
      <label className="small">
        Name
        <input name="name" defaultValue={specialist.name} required />
      </label>
      <label className="small">
        Job
        <textarea name="job" defaultValue={specialist.job} rows={5} required />
      </label>
      <label className="small">
        Tools it may use (names or prefixes like stripe_; empty means company memory only)
        <input name="tools" defaultValue={specialist.tools.join(", ")} className="mono" />
      </label>
      {state.error && <p className="error small">{state.error}</p>}
      <div className="row">
        <button disabled={pending}>{pending ? "Saving…" : "Save"}</button>
        <button formAction={toggleSpecialist} className="ghost">
          {specialist.enabled ? "Switch off" : "Switch on"}
        </button>
        <button formAction={removeSpecialist} className="ghost">
          Remove
        </button>
      </div>
    </form>
  );
}
