/**
 * A cheap, deterministic read of the specialists' reports, so the lead is told where to look
 * before it combines them: figures given without a source, and figures two specialists
 * report differently. No model call. It can be wrong in both directions, so it only ever
 * produces notes for the lead to check.
 */

/** One specialist's piece of a run: its report, or why it didn't finish. */
export interface Report {
  specialist: string;
  task: string;
  /** What it found; for a failed one, the one-line reason. */
  report: string;
  status: "ok" | "failed";
  tokens?: number;
}

interface Figure {
  /** What the figure is about: the nearest name on its line ("acme", "inv-101"). */
  subject: string;
  kind: "amount" | "percent";
  value: number;
  /** As written ("4.2L"). */
  text: string;
}

const REF = /\[S\d+\]/;
/** A number standing on its own: not part of an invoice number, a code, a date or a time. */
const NUMBER = /(?<![\w.:/-])(₹|\$|€|£|rs\.?\s?|inr\s?)?(\d{1,3}(?:,\d{2,3})+|\d+)(\.\d+)?\s?(%|k|m|bn|l|lakhs?|lacs?|cr|crores?)?(?![\w/-]|:\d|\.\d)/gi;
const SCALE: Record<string, number> = { k: 1e3, m: 1e6, bn: 1e9, l: 1e5, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, cr: 1e7, crore: 1e7, crores: 1e7 };
/** An invoice-style identifier, or a run of capitalised words. */
const NAME = /[A-Z]{2,}-?\d[\w-]*|[A-Z][\w&'-]*(?:\s+[A-Z][\w&'-]*)*/g;
/** Capitalised words that say nothing about what a figure belongs to. */
const VAGUE = new Set(["the", "a", "an", "total", "totals", "they", "we", "it", "this", "that", "there", "from", "in", "on", "for", "and", "but", "of", "no", "not", "paid", "due", "overdue", "about", "around", "only", "also", "note", "risk", "risks"]);

/** Amounts and percentages on one line. Small bare numbers (38 days, 2 accounts) and years are left out: too noisy to compare. */
function figuresOn(line: string): { index: number; kind: Figure["kind"]; value: number; text: string }[] {
  const found = [];
  for (const m of line.matchAll(NUMBER)) {
    const [text, currency, whole, decimals = "", suffix = ""] = m;
    const base = Number(whole.replace(/,/g, "") + decimals);
    const unit = suffix.toLowerCase();
    const year = !currency && !decimals && !unit && /^(19|20)\d\d$/.test(whole);
    if (unit === "%") found.push({ index: m.index, kind: "percent" as const, value: base, text: text.trim() });
    else if (!year && (currency || unit || whole.includes(",") || base >= 1000)) found.push({ index: m.index, kind: "amount" as const, value: base * (SCALE[unit] ?? 1), text: text.trim() });
  }
  return found;
}

const meaningful = (name: string) =>
  name
    .split(/\s+/)
    .filter((w) => !VAGUE.has(w.toLowerCase()))
    .join(" ")
    .toLowerCase();

/** Every amount and percentage in a report, with what it is about. Figures on a line that names nothing are skipped. */
export function figuresIn(report: string): Figure[] {
  return report.split("\n").flatMap((line) => {
    // Blank out [S3] refs first so they aren't read as names.
    const names = [...line.replace(/\[S\d+\]/g, (ref) => " ".repeat(ref.length)).matchAll(NAME)].map((m) => ({ index: m.index, name: meaningful(m[0]) })).filter((n) => n.name);
    return figuresOn(line).flatMap((f) => {
      const subject = names.findLast((n) => n.index < f.index) ?? names[0];
      return subject ? [{ subject: subject.name, kind: f.kind, value: f.value, text: f.text }] : [];
    });
  });
}

/**
 * Paragraphs of a report that give a figure with neither an [S#] ref nor a system named
 * (`systems`: "stripe", "xero", ... from the specialist's tools). At most three, quoted.
 */
export function uncitedFigures(report: string, systems: string[]): string[] {
  const named = systems.length ? new RegExp(`\\b(${systems.map((s) => s.replace(/[^\w-]/g, "")).filter(Boolean).join("|")})\\b`, "i") : undefined;
  return report
    .split(/\n\s*\n/)
    .filter((block) => !REF.test(block) && !named?.test(block))
    .flatMap((block) => block.split("\n").filter((line) => figuresOn(line).length).slice(0, 1))
    .slice(0, 3)
    .map((line) => line.trim().slice(0, 140));
}

/** Rounding ("4.2L" for 4,19,870) is not a disagreement. */
const same = (a: number, b: number) => Math.abs(a - b) <= 0.02 * Math.max(Math.abs(a), Math.abs(b));

/**
 * Where `report` and an earlier report by another specialist give different figures for the
 * same thing. They may be measuring different things (invoiced vs still owed): the lead decides.
 */
export function conflictingFigures(report: Report, earlier: Report[]): string[] {
  const mine = figuresIn(report.report);
  const notes = new Set<string>();
  for (const other of earlier) {
    if (other.status !== "ok" || other.specialist === report.specialist) continue;
    const theirs = figuresIn(other.report);
    for (const f of mine) {
      const about = (list: Figure[]) => list.filter((x) => x.subject === f.subject && x.kind === f.kind);
      const [a, b] = [about(mine), about(theirs)];
      if (b.length && !a.some((x) => b.some((y) => same(x.value, y.value)))) {
        const list = (figures: Figure[]) => [...new Set(figures.map((x) => x.text))].join(", ");
        notes.add(`${report.specialist} and ${other.specialist} give different figures for ${f.subject}: ${list(a)} vs ${list(b)}`);
      }
    }
  }
  return [...notes].slice(0, 4);
}

/** Notes for the lead on one finished report, or none when nothing stands out. */
export function reviewReport(report: Report, earlier: Report[], systems: string[]): string[] {
  if (report.status !== "ok") return [];
  return [
    ...conflictingFigures(report, earlier).map((c) => `Possible disagreement: ${c}.`),
    ...uncitedFigures(report.report, systems).map((line) => `No source ref or system named for: "${line}"`),
  ];
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** What earlier specialists in the same run found, short enough to hand to the next one. */
export function digestOf(reports: Report[], limit = 2400): string {
  const done = reports.filter((r) => r.status === "ok");
  if (!done.length) return "";
  const each = Math.max(200, Math.floor(limit / done.length) - 80);
  return clip(done.map((r) => `- ${r.specialist} (asked: ${clip(r.task, 70)}): ${clip(r.report.replace(/\s*\n\s*/g, " "), each)}`).join("\n"), limit);
}
