type Level = "info" | "warn" | "error";

/** Field names that could hold a credential or someone's words: never printed. */
const PRIVATE = /token|secret|password|authorization|cookie|api[-_]?key|credential|body|payload|^text$|^input$/i;
const MAX_STRING = 500;

function safe(value: unknown): unknown {
  if (value instanceof Error) return value.message.slice(0, MAX_STRING);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value === "bigint") return String(value);
  return value;
}

/** One log line as JSON: when, how bad, what happened, and a few small fields. */
export function logLine(level: Level, event: string, fields: Record<string, unknown> = {}, now = new Date()): string {
  const out: Record<string, unknown> = { ts: now.toISOString(), level, event };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || key in out) continue;
    out[key] = PRIVATE.test(key) ? "[left out]" : safe(value);
  }
  try {
    return JSON.stringify(out);
  } catch {
    return JSON.stringify({ ts: out.ts, level, event, note: "fields could not be printed" });
  }
}

/**
 * Structured logs: one JSON line per event, so they can be searched and counted.
 * Pass ids, counts and error messages; never credentials or what someone wrote.
 */
export const log = {
  info: (event: string, fields?: Record<string, unknown>) => console.log(logLine("info", event, fields)),
  warn: (event: string, fields?: Record<string, unknown>) => console.warn(logLine("warn", event, fields)),
  error: (event: string, fields?: Record<string, unknown>) => console.error(logLine("error", event, fields)),
};

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
