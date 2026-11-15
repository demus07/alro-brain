"use client";

import { useActionState } from "react";
import { addLiveTools, addProfileNote, learnMyStyle, newLinkCode, type FormState } from "./more-actions";

const Feedback = ({ state }: { state: FormState }) => (state.error ? <p className="error small">{state.error}</p> : state.ok ? <p className="muted small">{state.ok}</p> : null);

/** Add a live-tool server by URL, with a token if it needs one. */
export function AddLiveTools() {
  const [state, action, pending] = useActionState<FormState, FormData>(addLiveTools, {});
  return (
    <details className="connect">
      <summary className="source">
        <span className="mark">+</span>
        <span className="source-name">Add a live-tool server</span>
        <span className="chip-button">Add</span>
      </summary>
      <form action={action} className="connect-form">
        <p className="muted small">
          Paste the address of an app&apos;s MCP server (its docs call it &quot;MCP server URL&quot;). If the app wants you to sign in, you&apos;ll be sent there. Tools that read are switched on; tools that change things can be switched on too, and then each use waits for your approval.
        </p>
        <label className="small">
          Name
          <input name="name" placeholder="e.g. HubSpot" autoComplete="off" />
        </label>
        <label className="small">
          Server URL
          <input name="url" type="url" placeholder="https://…/mcp" autoComplete="off" required />
        </label>
        <label className="small">
          Access token <span className="muted">(only if the app gave you one)</span>
          <input name="token" type="password" autoComplete="off" />
        </label>
        <label className="small">
          Who can use it
          <select name="scope" defaultValue="org">
            <option value="org">Whole team</option>
            <option value="personal">Only me</option>
          </select>
        </label>
        <Feedback state={state} />
        <div>
          <button disabled={pending}>{pending ? "Connecting…" : "Add server"}</button>
        </div>
      </form>
    </details>
  );
}

export function AddProfileNote() {
  const [state, action, pending] = useActionState<FormState, FormData>(addProfileNote, {});
  return (
    <form action={action} className="inline-form">
      <select name="category" defaultValue="goal" aria-label="Kind of note">
        <option value="goal">Goal</option>
        <option value="preference">Preference</option>
        <option value="decision">How I decide</option>
        <option value="about">About me</option>
      </select>
      <input name="text" placeholder="e.g. Close two enterprise pilots this quarter" autoComplete="off" />
      <button disabled={pending}>Add</button>
      <Feedback state={state} />
    </form>
  );
}

export function LearnStyle({ learned }: { learned: boolean }) {
  const [state, action, pending] = useActionState<FormState, FormData>(learnMyStyle, {});
  return (
    <form action={action} className="inline-form">
      <button className="chip-button" disabled={pending}>
        {pending ? "Reading your messages…" : learned ? "Learn it again" : "Learn how I write"}
      </button>
      <Feedback state={state} />
    </form>
  );
}

/** Shows a one-time code to send from the messaging app. */
export function LinkCode() {
  const [state, action, pending] = useActionState<FormState, FormData>(newLinkCode, {});
  return (
    <form action={action} className="inline-form">
      <button className="chip-button" disabled={pending}>
        {state.ok ? "New code" : "Get a link code"}
      </button>
      {state.ok && (
        <span className="small">
          Send <strong className="mono code">{state.ok}</strong> to the bot within 15 minutes.
        </span>
      )}
      {state.error && <span className="error small">{state.error}</span>}
    </form>
  );
}
