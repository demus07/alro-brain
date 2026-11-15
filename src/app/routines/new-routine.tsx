"use client";

import { useActionState, useState } from "react";
import { createRoutine, type RoutineState } from "./actions";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A new scheduled task: what to do and when. */
export function NewRoutine() {
  const [state, action, pending] = useActionState<RoutineState, FormData>(createRoutine, {});
  const [kind, setKind] = useState("weekdays");
  return (
    <form action={action} className="card">
      <h2>New scheduled task</h2>
      <label className="small">
        Name
        <input name="title" placeholder="Monday cash report" autoComplete="off" required />
      </label>
      <label className="small">
        What should ALRO do?
        <textarea name="instruction" rows={3} placeholder="List every overdue payment with who owes it, how late it is and the last thing they said about it. Put the biggest first." required />
      </label>
      <div className="row">
        <label className="small">
          When
          <select name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="weekdays">Every weekday</option>
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
            <option value="once">Once</option>
          </select>
        </label>
        {kind === "weekly" && (
          <label className="small">
            Day
            <select name="weekday" defaultValue="1">
              {DAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        )}
        {kind === "once" && (
          <label className="small">
            Date
            <input name="date" type="date" required />
          </label>
        )}
        <label className="small">
          Time
          <input name="time" type="time" defaultValue="07:00" required />
        </label>
      </div>
      {state.error && <p className="error small">{state.error}</p>}
      <div>
        <button disabled={pending}>{pending ? "Saving…" : "Schedule it"}</button>
      </div>
    </form>
  );
}
