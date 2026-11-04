"use client";

import { deleteSource } from "./actions";

/** Delete, after a confirmation that says what goes with it. */
export function DeleteSource({ id, label }: { id: string; label: string }) {
  return (
    <form
      action={deleteSource}
      className="actions"
      onSubmit={(e) => {
        if (!window.confirm(`Delete this ${label} source? Its messages, search index, promises and facts found only there are removed for good.`)) e.preventDefault();
      }}
    >
      <input type="hidden" name="id" value={id} />
      <button className="chip-button danger">Delete</button>
    </form>
  );
}
