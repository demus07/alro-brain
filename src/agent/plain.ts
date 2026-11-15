interface Cited {
  ref: string;
  thread: string;
  at: string;
  author?: string;
}

/** Finds every cited source ({ ref: "S3", thread, at, ... }) anywhere in the agent's tool results. */
export function sourcesIn(value: unknown, found = new Map<string, Cited>()): Map<string, Cited> {
  if (Array.isArray(value)) for (const v of value) sourcesIn(v, found);
  else if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (typeof o.ref === "string" && /^S\d+$/.test(o.ref) && typeof o.thread === "string") {
      found.set(o.ref, { ref: o.ref, thread: o.thread, at: String(o.at ?? ""), author: typeof o.author === "string" ? o.author : undefined });
    }
    for (const v of Object.values(o)) sourcesIn(v, found);
  }
  return found;
}

const MAX_SOURCES = 6;

/**
 * An answer as plain text for email and messaging apps: draft blocks become labelled
 * text, bold becomes *bold*, and the [S1] refs it used are listed underneath (the web
 * app shows those as links instead).
 */
export function plainAnswer(text: string, toolResults: unknown): string {
  const body = text
    .replace(/```draft\n([\s\S]*?)```/g, (_, draft: string) => `— Draft —\n${draft.trim()}\n— end —`)
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .trim();
  const sources = sourcesIn(toolResults);
  const used = [...new Set([...body.matchAll(/\[(S\d+)\]/g)].map((m) => m[1]))].flatMap((ref) => (sources.has(ref) ? [sources.get(ref)!] : []));
  if (!used.length) return body;
  const lines = used.slice(0, MAX_SOURCES).map((s) => `[${s.ref}] ${s.thread}, ${s.at}${s.author ? ` (${s.author})` : ""}`);
  return `${body}\n\nSources\n${lines.join("\n")}${used.length > MAX_SOURCES ? `\n+${used.length - MAX_SOURCES} more in ALRO` : ""}`;
}
