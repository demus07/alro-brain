"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export interface PalettePage {
  href: string;
  label: string;
  icon: ReactNode;
}

interface Result {
  id: string;
  href: string;
  thread: string;
  kind: string;
  at: string;
  text: string;
}

interface Fact {
  id: string;
  text: string;
  href?: string;
}

type Item = { key: string; href: string } | { key: string; search: true };

/**
 * The ⌘K search, Spotlight-style: a pop-up over the current page. Typing suggests pages at once;
 * Enter on "Search conversations" asks the server (one embedding per search, so not on every key).
 * Arrow keys move, Enter opens, Escape or a click outside closes.
 */
export function CommandPalette({ open, onClose, pages }: { open: boolean; onClose: () => void; pages: PalettePage[] }) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState<string | undefined>(undefined);
  const [results, setResults] = useState<Result[]>([]);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      input.current?.focus();
      input.current?.select();
    } else if (!open && d.open) d.close();
  }, [open]);

  const q = query.trim();
  const matches = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return pages.filter((p) => words.every((w) => p.label.toLowerCase().includes(w))).slice(0, q ? 5 : 8);
  }, [pages, q]);
  const fresh = searched === q;

  // Everything the arrow keys move through, top to bottom.
  const items: Item[] = [
    ...matches.map((p) => ({ key: `page:${p.href}`, href: p.href })),
    ...(q && !fresh ? [{ key: "search", search: true as const }] : []),
    ...(fresh ? facts.filter((f) => f.href).map((f) => ({ key: `fact:${f.id}`, href: f.href! })) : []),
    ...(fresh ? results.map((r) => ({ key: `hit:${r.id}`, href: r.href })) : []),
    ...(q && fresh ? [{ key: "all", href: `/search?q=${encodeURIComponent(q)}` }] : []),
  ];
  const current = Math.min(active, Math.max(items.length - 1, 0));
  const isActive = (key: string) => items[current]?.key === key;

  const go = (href: string) => {
    onClose();
    router.push(href);
  };

  const search = async () => {
    if (!q || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = (await res.json()) as { results?: Result[]; facts?: Fact[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Search failed.");
      setResults(data.results ?? []);
      setFacts(data.facts ?? []);
      setSearched(q);
      setActive(matches.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed.");
    } finally {
      setBusy(false);
    }
  };

  const choose = (item: Item | undefined) => {
    if (!item) return;
    if ("search" in item) void search();
    else go(item.href);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = items.length || 1;
      setActive((current + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(items[current]);
    }
  };

  // Keep the highlighted row in view as the arrow keys move.
  useEffect(() => {
    dialog.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [current, results.length]);

  const row = (key: string, children: ReactNode, onClick: () => void) => (
    <li key={key}>
      <button type="button" className="palette-row" data-active={isActive(key)} onMouseMove={() => setActive(items.findIndex((i) => i.key === key))} onClick={onClick}>
        {children}
      </button>
    </li>
  );

  return (
    <dialog
      ref={dialog}
      className="palette"
      aria-label="Search"
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="palette-field">
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4" />
        </svg>
        <input
          ref={input}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setError(undefined);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search conversations, or jump to a page"
          aria-label="Search"
          autoComplete="off"
          spellCheck={false}
        />
        {busy ? <span className="palette-spinner" aria-label="Searching" /> : <kbd className="kbd">esc</kbd>}
      </div>

      <div className="palette-body">
        {matches.length > 0 && (
          <section>
            <p className="palette-heading">{q ? "Pages" : "Go to"}</p>
            <ul>
              {matches.map((p) =>
                row(
                  `page:${p.href}`,
                  <>
                    <span className="palette-icon">{p.icon}</span>
                    <span className="palette-title">{p.label}</span>
                  </>,
                  () => go(p.href),
                ),
              )}
            </ul>
          </section>
        )}

        {q && !fresh && (
          <section>
            <p className="palette-heading">Conversations</p>
            <ul>
              {row(
                "search",
                <>
                  <span className="palette-icon">
                    <svg viewBox="0 0 24 24" aria-hidden>
                      <path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4" />
                    </svg>
                  </span>
                  <span className="palette-title">
                    {busy ? "Searching" : "Search conversations for"} “{q}”
                  </span>
                  <kbd className="kbd">↵</kbd>
                </>,
                () => void search(),
              )}
            </ul>
          </section>
        )}

        {error && <p className="palette-empty error">{error}</p>}

        {fresh && facts.length > 0 && (
          <section>
            <p className="palette-heading">Known facts</p>
            <ul>
              {facts.map((f) =>
                f.href ? (
                  row(`fact:${f.id}`, <span className="palette-title wrap">{f.text}</span>, () => go(f.href!))
                ) : (
                  <li key={f.id} className="palette-row static">
                    <span className="palette-title wrap">{f.text}</span>
                  </li>
                ),
              )}
            </ul>
          </section>
        )}

        {fresh && (
          <section>
            <p className="palette-heading">Conversations</p>
            {results.length === 0 ? (
              <p className="palette-empty">Nothing found for “{q}”.</p>
            ) : (
              <ul>
                {results.map((r) =>
                  row(
                    `hit:${r.id}`,
                    <span className="palette-hit">
                      <span className="palette-hit-head">
                        <span className="palette-title">{r.thread}</span>
                        <span className="tag">{r.kind}</span>
                        <span className="palette-meta">{r.at}</span>
                      </span>
                      <span className="palette-excerpt">{r.text}</span>
                    </span>,
                    () => go(r.href),
                  ),
                )}
              </ul>
            )}
            <ul>
              {row(
                "all",
                <>
                  <span className="palette-title">See all results on the Search page</span>
                  <span className="palette-meta">→</span>
                </>,
                () => go(`/search?q=${encodeURIComponent(q)}`),
              )}
            </ul>
          </section>
        )}
      </div>

      <footer className="palette-foot">
        <span>
          <kbd className="kbd">↑</kbd>
          <kbd className="kbd">↓</kbd> move
        </span>
        <span>
          <kbd className="kbd">↵</kbd> open
        </span>
        <span>
          <kbd className="kbd">esc</kbd> close
        </span>
      </footer>
    </dialog>
  );
}
