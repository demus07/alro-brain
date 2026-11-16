import { and, asc, eq, isNotNull, isNull, lt, lte } from "drizzle-orm";
import type { Db } from "@/db/client";
import { deadLetters } from "@/db/schema";
import { alert, recovered } from "./alerts";
import { errorText, log } from "./log";

export type DeadLetter = typeof deadLetters.$inferSelect;

const MIN = 60_000;
/** The wait before each automatic retry: 5 minutes, 30 minutes, 2 hours, 12 hours. Then it's left for a person. */
export const BACKOFF_MS = [5 * MIN, 30 * MIN, 120 * MIN, 720 * MIN];
/** Kinds that get fewer automatic retries than the full schedule. */
const RETRIES: Record<string, number> = {
  // A scheduled task is re-run at most twice: each run costs model calls and can act.
  routine: 2,
  // A reminder that is hours late is worse than none.
  notify: 3,
};
/** While a retry is running its letter is pushed this far ahead, so an overlapping tick doesn't run it too. */
const LEASE_MS = 30 * MIN;
const KEEP_RESOLVED_MS = 14 * 24 * 60 * MIN;

export const retriesFor = (kind: string) => Math.min(RETRIES[kind] ?? BACKOFF_MS.length, BACKOFF_MS.length);

/** Thrown by a retry handler when trying again can't help or isn't safe: the letter is given up at once. */
export class GiveUp extends Error {}

export interface RetryContext {
  /** A person pressed "Retry now": they have looked, so safety checks meant for automatic retries can be skipped. */
  manual: boolean;
  /** If this attempt fails, nothing will try again automatically. */
  last: boolean;
  now: Date;
}

/** Does the failed work again. Returning means it worked; throwing means it didn't. */
export type RetryHandler = (letter: DeadLetter, ctx: RetryContext) => Promise<void>;
export type RetryHandlers = Record<string, RetryHandler>;

/** How each kind reads in an alert and on the Health page. */
export const LETTER_LABEL: Record<string, string> = { webhook: "A message to the ALRO bot", routine: "A scheduled task", notify: "A reminder" };

const alertKey = (l: Pick<DeadLetter, "kind" | "ref">) => `retry:${l.kind}:${l.ref}`;

/**
 * Records work that failed so it's tried again later. One row per (kind, ref): each new
 * failure adds to `attempts` and schedules the next try after a longer wait (5 min, 30 min,
 * 2 h, 12 h). Once the retries for its kind are used up, or with `retry: false`, it is given
 * up (`nextRetryAt` null): the admins are told once and only a person can retry it, from the
 * Health page. The payload must be small and free of secrets and message text.
 */
export async function deadLetter(
  db: Db,
  input: { orgId?: string | null; kind: string; ref: string; payload?: Record<string, unknown>; error: string; /** False when it must not be retried automatically. */ retry?: boolean; now?: Date },
): Promise<DeadLetter> {
  const now = input.now ?? new Date();
  const [existing] = await db.select().from(deadLetters).where(and(eq(deadLetters.kind, input.kind), eq(deadLetters.ref, input.ref)));
  const open = existing && !existing.resolvedAt;
  const attempts = open ? existing.attempts + 1 : 1;
  const nextRetryAt = input.retry !== false && attempts <= retriesFor(input.kind) ? new Date(now.getTime() + BACKOFF_MS[attempts - 1]) : null;
  const error = input.error.slice(0, 1000);
  const values = { orgId: input.orgId ?? existing?.orgId ?? null, payload: input.payload ?? existing?.payload ?? null, error, attempts, nextRetryAt, resolvedAt: null, updatedAt: now };
  const [row] = await db
    .insert(deadLetters)
    .values({ kind: input.kind, ref: input.ref, ...values, createdAt: now })
    .onConflictDoUpdate({ target: [deadLetters.kind, deadLetters.ref], set: open ? values : { ...values, createdAt: now } })
    .returning();
  log.warn("retry.recorded", { kind: row.kind, ref: row.ref, attempts, nextRetryAt: nextRetryAt ?? "given up", error });
  // Told once: when it stops being retried, not on every later manual attempt.
  const alreadyGivenUp = open && existing.nextRetryAt === null;
  if (!nextRetryAt && !alreadyGivenUp) {
    await alert(db, { orgId: row.orgId, key: alertKey(row), text: `${LETTER_LABEL[row.kind] ?? row.kind} failed ${attempts === 1 ? "and won't be retried automatically" : `${attempts} times and has been given up on`}: ${error.slice(0, 300)} Open Health in ALRO to retry it.` });
  }
  return row;
}

/** Marks a letter's work as done (it succeeded later, or no longer matters). */
export async function resolveLetter(db: Db, kind: string, ref: string, now = new Date()): Promise<void> {
  const [row] = await db
    .update(deadLetters)
    .set({ resolvedAt: now, nextRetryAt: null, updatedAt: now })
    .where(and(eq(deadLetters.kind, kind), eq(deadLetters.ref, ref), isNull(deadLetters.resolvedAt)))
    .returning();
  if (row) await recovered(db, { orgId: row.orgId, key: alertKey(row) });
}

async function attempt(db: Db, letter: DeadLetter, handlers: RetryHandlers, ctx: RetryContext): Promise<{ ok: boolean; error?: string }> {
  const handler = handlers[letter.kind];
  try {
    if (!handler) throw new GiveUp(`Nothing knows how to retry "${letter.kind}"`);
    await handler(letter, ctx);
    await resolveLetter(db, letter.kind, letter.ref, ctx.now);
    log.info("retry.ok", { kind: letter.kind, ref: letter.ref, attempts: letter.attempts, manual: ctx.manual });
    return { ok: true };
  } catch (e) {
    const error = errorText(e);
    if (ctx.manual) {
      // The person is looking at it: show the new error and leave its schedule as it was.
      await db.update(deadLetters).set({ error: error.slice(0, 1000), updatedAt: ctx.now }).where(eq(deadLetters.id, letter.id));
      log.warn("retry.manual_failed", { kind: letter.kind, ref: letter.ref, error });
    } else {
      await deadLetter(db, { kind: letter.kind, ref: letter.ref, error, retry: !(e instanceof GiveUp), now: ctx.now });
    }
    return { ok: false, error };
  }
}

/**
 * Runs every retry that has come due through the handler for its kind. Success resolves the
 * letter; failure schedules the next try or gives up. Each letter is claimed first by pushing
 * its time forward, so two overlapping ticks never run the same retry. A retry can take a
 * while (it may run the agent), so no new one is started once `budgetMs` has passed: the
 * rest stay due for the next tick.
 */
export async function retryDue(db: Db, handlers: RetryHandlers, now = new Date(), limit = 25, budgetMs = 150_000): Promise<{ retried: number; resolved: number; failed: number }> {
  const started = Date.now();
  const due = await db
    .select()
    .from(deadLetters)
    .where(and(isNull(deadLetters.resolvedAt), lte(deadLetters.nextRetryAt, now)))
    .orderBy(asc(deadLetters.nextRetryAt))
    .limit(limit);
  const stats = { retried: 0, resolved: 0, failed: 0 };
  for (const letter of due) {
    if (Date.now() - started > budgetMs) break;
    const [claimed] = await db
      .update(deadLetters)
      .set({ nextRetryAt: new Date(now.getTime() + LEASE_MS) })
      .where(and(eq(deadLetters.id, letter.id), eq(deadLetters.nextRetryAt, letter.nextRetryAt!), isNull(deadLetters.resolvedAt)))
      .returning({ id: deadLetters.id });
    if (!claimed) continue;
    stats.retried++;
    const { ok } = await attempt(db, letter, handlers, { manual: false, last: letter.attempts >= retriesFor(letter.kind), now });
    if (ok) stats.resolved++;
    else stats.failed++;
  }
  return stats;
}

/** One company's letter, still open: what "Retry now" and "Dismiss" act on. */
async function openLetter(db: Db, orgId: string, id: string): Promise<DeadLetter> {
  const [letter] = await db.select().from(deadLetters).where(and(eq(deadLetters.id, id), eq(deadLetters.orgId, orgId), isNull(deadLetters.resolvedAt)));
  if (!letter) throw new Error("That was already retried or cleared.");
  return letter;
}

/** A person retries one now, whether it was waiting or given up. The caller checks they're an admin. */
export async function retryNow(db: Db, orgId: string, id: string, handlers: RetryHandlers, now = new Date()): Promise<{ ok: boolean; error?: string }> {
  const letter = await openLetter(db, orgId, id);
  return attempt(db, letter, handlers, { manual: true, last: true, now });
}

/** A person decides it no longer matters. The caller checks they're an admin. */
export async function dismissLetter(db: Db, orgId: string, id: string, now = new Date()): Promise<void> {
  const letter = await openLetter(db, orgId, id);
  await resolveLetter(db, letter.kind, letter.ref, now);
}

/** Open letters for a company: waiting for their next try first, then the ones given up. */
export const openLetters = (db: Db, orgId: string) =>
  db
    .select()
    .from(deadLetters)
    .where(and(eq(deadLetters.orgId, orgId), isNull(deadLetters.resolvedAt)))
    .orderBy(asc(deadLetters.nextRetryAt), asc(deadLetters.createdAt));

/** Drops letters resolved more than two weeks ago. */
export async function pruneLetters(db: Db, now = new Date()): Promise<number> {
  const gone = await db
    .delete(deadLetters)
    .where(and(isNotNull(deadLetters.resolvedAt), lt(deadLetters.resolvedAt, new Date(now.getTime() - KEEP_RESOLVED_MS))))
    .returning({ id: deadLetters.id });
  return gone.length;
}
