"use client";

import { useActionState, useState } from "react";
import { createRoutine, type RoutineState } from "./actions";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Common first tasks, as in "start with what happens every day, takes time and follows the same rules". */
const TEMPLATES = [
  { title: "Get to know me", instruction: "Ask me one question I haven't answered yet about my role, our clients, pricing, suppliers, how I make decisions or what I want done this quarter. One short question only.", kind: "weekdays", time: "09:30", team: "" },
  { title: "Monday cash report", instruction: "Cash in the bank, money in and out last week, receivables and payables due in the next 14 days, the five biggest overdue payments and the three biggest risks.", kind: "weekly", time: "07:00", team: "finance" },
  { title: "Chase overdue payments", instruction: "Find invoices that are overdue, check what each customer last said about paying, and draft a polite chaser for each one that hasn't disputed it or promised a later date.", kind: "weekdays", time: "10:00", team: "finance" },
  {
    title: "Answer inquiries fast",
    instruction: "Look for new customer inquiries and price requests in email and chat. For each, check their past orders and what we last quoted them, draft the reply with a quote, and propose it for my approval.",
    kind: "every",
    time: "07:00",
    team: "sales",
  },
  { title: "What slipped", instruction: "What slipped yesterday: promises that went overdue, threads where someone has waited more than two days for us, and who owns each.", kind: "weekdays", time: "07:30", team: "operations" },
];

/** A new scheduled task: what to do and when, optionally given to a department of the agent team. */
export function NewRoutine({ departments }: { departments: { id: string; label: string }[] }) {
  const [state, action, pending] = useActionState<RoutineState, FormData>(createRoutine, {});
  const [kind, setKind] = useState("weekdays");
  const [values, setValues] = useState({ title: "", instruction: "", time: "07:00", team: "" });
  const use = (t: (typeof TEMPLATES)[number]) => {
    setKind(t.kind);
    setValues({ title: t.title, instruction: t.instruction, time: t.time, team: departments.some((d) => d.id === t.team) ? t.team : "" });
  };
  return (
    <form action={action} className="card" key={values.title}>
      <h2>New scheduled task</h2>
      <div className="chips">
        {TEMPLATES.map((t) => (
          <button key={t.title} type="button" className="ghost" onClick={() => use(t)}>
            {t.title}
          </button>
        ))}
      </div>
      <label className="small">
        Name
        <input name="title" placeholder="Monday cash report" autoComplete="off" defaultValue={values.title} required />
      </label>
      <label className="small">
        What should ALRO do?
        <textarea name="instruction" rows={3} defaultValue={values.instruction} placeholder="List every overdue payment with who owes it, how late it is and the last thing they said about it. Put the biggest first." required />
      </label>
      {departments.length > 0 && (
        <label className="small">
          Who does it
          <select name="team" defaultValue={values.team}>
            <option value="">ALRO itself</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                The {d.label.toLowerCase()} team
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="row">
        <label className="small">
          When
          <select name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="weekdays">Every weekday</option>
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
            <option value="every">Keep watching</option>
            <option value="once">Once</option>
          </select>
        </label>
        {kind === "every" && (
          <label className="small">
            Check every
            <select name="minutes" defaultValue="15">
              <option value="15">15 minutes</option>
              <option value="30">30 minutes</option>
              <option value="60">hour</option>
              <option value="120">2 hours</option>
              <option value="240">4 hours</option>
            </select>
          </label>
        )}
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
        {kind !== "every" && (
          <label className="small">
            Time
            <input name="time" type="time" defaultValue={values.time} required />
          </label>
        )}
      </div>
      {state.error && <p className="error small">{state.error}</p>}
      <div>
        <button disabled={pending}>{pending ? "Saving…" : "Schedule it"}</button>
      </div>
    </form>
  );
}
