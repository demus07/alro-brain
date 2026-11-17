"use client";

import { useState } from "react";

/**
 * Filters a list of source tiles as you type. Each <li> in the list carries `data-search`
 * (its name and what kind of app it is); a tile shows when it contains every word typed.
 */
export function SourceFilter({ list }: { list: string }) {
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState<number | undefined>(undefined);

  const filter = (value: string) => {
    setQuery(value);
    const words = value.toLowerCase().split(/\s+/).filter(Boolean);
    let count = 0;
    for (const li of document.querySelectorAll<HTMLLIElement>(`#${list} > li`)) {
      const match = words.every((w) => (li.dataset.search ?? "").includes(w));
      li.hidden = !match;
      if (match) count++;
    }
    setShown(words.length ? count : undefined);
  };

  return (
    <div className="source-filter">
      <label className="source-filter-field">
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4" />
        </svg>
        <input
          type="search"
          value={query}
          onChange={(e) => filter(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && filter("")}
          placeholder="Search sources"
          aria-label="Search sources"
          aria-controls={list}
          autoComplete="off"
        />
      </label>
      <span className="muted small" role="status" aria-live="polite">
        {shown === 0 ? `No source matches “${query.trim()}”` : shown !== undefined ? `${shown} ${shown === 1 ? "source" : "sources"}` : ""}
      </span>
    </div>
  );
}
