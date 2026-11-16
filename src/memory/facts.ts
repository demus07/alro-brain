/**
 * How far to trust a fact, over time.
 *
 * A fact starts with a confidence from how it was said and who said it. A later statement
 * can restate it (confidence rises), replace it (the old one becomes history), or contradict
 * it without settling anything: then both stay current in one dispute group until a statement
 * with enough authority confirms one, or a person picks. Old facts nobody has repeated are
 * reported as possibly out of date, never hidden.
 *
 * The first half is pure rules; the second half applies them to `edges`.
 */
import { randomUUID } from "node:crypto";
import { aliasedTable, and, asc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { edges, entities, people } from "@/db/schema";
import { unionAcl, withScope, type Viewer } from "@/db/scope";
import { audit } from "@/lib/audit";
import { rowsOf } from "./search";

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** How a statement was made. A question asserts nothing, so it never becomes a fact. */
export const STANCES = ["firm", "confirmed", "tentative", "question"] as const;
export type Stance = (typeof STANCES)[number];

/**
 * Who is speaking, relative to the fact:
 *   party    one of the fact's two entities, or an outside contact (a client or vendor speaking for their own side)
 *   insider  a team member talking about someone or something else
 *   unknown  no single known speaker
 * A party's word outranks an insider's claim about them, which outranks an unattributed one.
 */
export type Speaker = "party" | "insider" | "unknown";
const RANK: Record<Speaker, number> = { party: 3, insider: 2, unknown: 1 };

export function speakerKind(person: { id: string; isMember: boolean } | null | undefined, endpointPersonIds: (string | null)[]): Speaker {
  if (!person) return "unknown";
  return endpointPersonIds.includes(person.id) || !person.isMember ? "party" : "insider";
}

/** What the extraction adds to each relation. `.catch` keeps the fields required for the model and optional when an answer leaves them out. */
export const trustFields = {
  stance: z.enum(STANCES).catch("firm").describe("How it was said"),
  conflictsWith: z.array(z.string()).catch([]).describe("F labels this contradicts without replacing"),
};
export const confirmsField = z
  .array(z.object({ fact: z.string().describe("F label"), evidence: z.string().describe("Message label, e.g. M3") }))
  .catch([])
  .describe("Current facts a message restates or confirms unchanged");
export interface TrustFields {
  stance: Stance;
  conflictsWith: string[];
}

/** Confidence a legacy fact with none recorded is treated as having. */
const DEFAULT_CONFIDENCE = 0.7;
/** Only a person's check reaches 1. */
const MAX_UNVERIFIED = 0.97;
const BASE: Record<Exclude<Stance, "question">, number> = { confirmed: 0.9, firm: 0.8, tentative: 0.45 };
const BY_SPEAKER: Record<Speaker, number> = { party: 0.05, insider: 0, unknown: -0.1 };

/** Where a new fact's confidence starts: how it was said, adjusted for who said it. */
export const startingConfidence = (stance: Exclude<Stance, "question">, speaker: Speaker) => Math.round((BASE[stance] + BY_SPEAKER[speaker]) * 100) / 100;

/** Confidence after a restatement. A second voice or an explicit confirmation counts for more than someone repeating themselves. */
export function reinforce(confidence: number | null, strong: boolean): number {
  const c = confidence ?? DEFAULT_CONFIDENCE;
  return c >= 1 ? 1 : Math.min(MAX_UNVERIFIED, c + (1 - c) * (strong ? 0.35 : 0.1));
}

export type ConfidenceWord = "confirmed" | "likely" | "uncertain";

/** Confidence in a word. A disputed fact is never better than uncertain; a person's check settles it. */
export function confidenceWord(confidence: number | null, opts: { disputed?: boolean; verified?: boolean } = {}): ConfidenceWord {
  if (opts.disputed) return "uncertain";
  if (opts.verified) return "confirmed";
  const c = confidence ?? DEFAULT_CONFIDENCE;
  return c >= 0.9 ? "confirmed" : c >= 0.6 ? "likely" : "uncertain";
}

export interface Claim {
  stance: Stance;
  speaker: Speaker;
  speakerId?: string | null;
  /** When it was said. */
  at?: Date | null;
}

export interface Standing {
  speaker: Speaker;
  speakerId?: string | null;
  at?: Date | null;
  verifiedAt?: Date | null;
}

/** How a new statement relates to a current fact: the model called it a change, a contradiction, or said nothing (same subject, relation and target). */
export type Link = "replaces" | "conflicts" | "same_slot";
export type Verdict = "replace" | "dispute" | "keep";

/**
 * What a new statement does to a current fact it differs from.
 *   keep     the current fact stands and the statement is dropped (a person checked it since, or later evidence already replaced this)
 *   replace  the current fact becomes history
 *   dispute  both stay current, unsettled
 * A firm statement replaces one of equal authority when it's a change, and one of lower authority
 * always; people may revise what they said themselves. A weaker voice, a guess, or a plain
 * contradiction between equals only disputes.
 */
export function weigh(claim: Claim, standing: Standing, link: Link): Verdict {
  const outranks = RANK[claim.speaker] - RANK[standing.speaker];
  if (standing.verifiedAt && (!claim.at || claim.at <= standing.verifiedAt)) return "keep";
  if (claim.at && standing.at && claim.at < standing.at) return outranks > 0 && claim.stance !== "tentative" ? "dispute" : "keep";
  if (claim.stance === "tentative") return "dispute";
  if (outranks > 0 || (!!claim.speakerId && claim.speakerId === standing.speakerId)) return "replace";
  if (outranks < 0) return "dispute";
  return link === "conflicts" ? "dispute" : "replace";
}

/**
 * Whether restating one side of a dispute settles it: a firm statement from someone who outranks
 * every other side, or a later second voice of at least their authority. Repeating your own claim
 * against an equal settles nothing.
 */
export function settles(confirmation: { stance: Stance; speaker: Speaker; own: boolean; later: boolean }, otherSides: Speaker[]): boolean {
  if (confirmation.stance !== "firm" && confirmation.stance !== "confirmed") return false;
  const top = Math.max(...otherSides.map((s) => RANK[s]));
  const rank = RANK[confirmation.speaker];
  return rank > top || (!confirmation.own && confirmation.later && rank >= top);
}

/** Relations whose value moves often: prices, status, stock, owners, dates. */
const VOLATILE = /(^|_)(pric\w*|costs?|budget\w*|quot\w*|rates?|status|stage|stock|inventory|balance|owes?|due|deadline|eta|assigned|responsible|owner)(_|$)/;
const DAY = 86_400_000;

/** Days without a restatement after which a current fact may be out of date. */
export const staleAfterDays = (relation: string) => (VOLATILE.test(relation) ? 30 : 90);

/** A current fact nobody has said, confirmed or checked for a long time. */
export function isStale(
  f: { relation: string; expiredAt?: Date | null; validFrom: Date | null; createdAt: Date; lastConfirmedAt: Date | null; verifiedAt: Date | null },
  now: Date,
): boolean {
  if (f.expiredAt) return false;
  const last = Math.max((f.validFrom ?? f.createdAt).getTime(), f.lastConfirmedAt?.getTime() ?? 0, f.verifiedAt?.getTime() ?? 0);
  return now.getTime() - last > staleAfterDays(f.relation) * DAY;
}

/** Words that carry no claim of their own; everything else (names, numbers, "not") must match. */
const FILLER = new Set("a an the of for to in on at by with and is are was were be been has have had will that this its their s per".split(" "));
const claimWords = (s: string) => [...new Set(s.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+(?:[.,]\d+)*/gu) ?? [])].filter((w) => !FILLER.has(w)).sort().join(" ");

/**
 * Two sentences that state the same thing: the same words once case, punctuation and filler are
 * ignored. Deliberately strict: one different name or number is a different claim, and calling
 * that a restatement would confirm the wrong fact.
 */
export const sameStatement = (a: string, b: string) => claimWords(a) === claimWords(b);

// ---------------------------------------------------------------------------
// Writing facts (the pipeline)
// ---------------------------------------------------------------------------

export interface NewFact {
  orgId: string;
  sourceEntityId: string;
  targetEntityId: string;
  relation: string;
  fact: string;
  /** When it became true. */
  validFrom?: Date;
  /** When it was said, if one message shows it. */
  saidAt?: Date;
  /** Evidence: the one message that shows it, or every message of the chunk it was read from. */
  messageIds: string[];
  sourceChunkId?: string;
  acl: string[];
  stance: Stance;
  /** The author of the evidence message, when there is exactly one. */
  speakerId?: string | null;
  /** Current facts the model said this replaces, and ones it contradicts. */
  replaces: string[];
  conflicts: string[];
}

export type FactOutcome = { outcome: "added"; id: string; disputed: boolean } | { outcome: "confirmed"; id: string } | { outcome: "skipped" };

interface StandingFact extends Standing {
  id: string;
  fact: string;
  confidence: number | null;
  disputeGroup: string | null;
  lastConfirmedAt: Date | null;
  sourceMessageIds: string[];
  acl: string[];
  /** The people the fact's two entities stand for, when they are people. */
  endpoints: (string | null)[];
}

const subject = aliasedTable(entities, "subject");
const object = aliasedTable(entities, "object");

/** Current facts matching `where`, each with who stands behind it. */
async function standingFacts(tx: Db, orgId: string, where: SQL | undefined): Promise<StandingFact[]> {
  const rows = await tx
    .select({
      id: edges.id,
      fact: edges.fact,
      confidence: edges.confidence,
      disputeGroup: edges.disputeGroup,
      at: edges.validFrom,
      verifiedAt: edges.verifiedAt,
      lastConfirmedAt: edges.lastConfirmedAt,
      sourceMessageIds: edges.sourceMessageIds,
      acl: edges.acl,
      speakerId: edges.assertedByPersonId,
      isMember: people.isMember,
      sourcePerson: subject.personId,
      targetPerson: object.personId,
    })
    .from(edges)
    .innerJoin(subject, eq(subject.id, edges.sourceEntityId))
    .innerJoin(object, eq(object.id, edges.targetEntityId))
    .leftJoin(people, eq(people.id, edges.assertedByPersonId))
    .where(and(eq(edges.orgId, orgId), isNull(edges.expiredAt), where))
    .orderBy(asc(edges.createdAt));
  return rows.map((r) => {
    const endpoints = [r.sourcePerson, r.targetPerson];
    return { ...r, endpoints, speaker: speakerKind(r.speakerId ? { id: r.speakerId, isMember: r.isMember ?? false } : null, endpoints) };
  });
}

async function speakerFor(tx: Db, personId: string | null | undefined, endpoints: (string | null)[]): Promise<Speaker> {
  const [person] = personId ? await tx.select({ id: people.id, isMember: people.isMember }).from(people).where(eq(people.id, personId)) : [];
  return speakerKind(person, endpoints);
}

/** Makes facts history: valid until `at`, replaced by `by` (null when a person simply said it was wrong). */
async function expire(tx: Db, orgId: string, ids: string[], by: string | null, at: Date) {
  if (!ids.length) return;
  await tx
    .update(edges)
    .set({ validTo: at, expiredAt: new Date(), invalidatedBy: by })
    .where(and(eq(edges.orgId, orgId), inArray(edges.id, ids), isNull(edges.expiredAt)));
}

/** A dispute with one current side left is no dispute. */
async function dissolveLoneDisputes(tx: Db, orgId: string) {
  await tx.execute(sql`
    update edges e set dispute_group = null
    where e.org_id = ${orgId} and e.expired_at is null and e.dispute_group is not null
      and not exists (select 1 from edges o where o.dispute_group = e.dispute_group and o.id <> e.id and o.expired_at is null)`);
}

/**
 * Records one extracted statement. Restating a current fact confirms it instead of adding a copy;
 * otherwise each current fact it touches (named by the model, or the same subject, relation and
 * target, plus everything already in dispute with those) is replaced, disputed or left standing
 * as `weigh` decides.
 */
export async function writeFact(tx: Db, f: NewFact): Promise<FactOutcome> {
  if (f.stance === "question") return { outcome: "skipped" };
  const slot = and(eq(edges.sourceEntityId, f.sourceEntityId), eq(edges.targetEntityId, f.targetEntityId), eq(edges.relation, f.relation));
  const inSlot = await standingFacts(tx, f.orgId, slot);
  const single = f.messageIds.length === 1 ? f.messageIds[0] : undefined;

  const restated = inSlot.find((e) => sameStatement(e.fact, f.fact));
  if (restated) {
    // Whoever read this message read the whole statement, so the fact becomes visible to them too.
    return single ? confirmFact(tx, f.orgId, restated.id, { messageId: single, at: f.saidAt, stance: f.stance, speakerId: f.speakerId, acl: f.acl }) : { outcome: "skipped" };
  }
  // The same message read again (a rebuilt chunk, or the other extraction stage) in other words: nothing new.
  if (single && inSlot.some((e) => e.sourceMessageIds.includes(single))) return { outcome: "skipped" };
  // A person already said this exact thing was wrong.
  const rejected = await tx.select({ fact: edges.fact }).from(edges).where(and(eq(edges.orgId, f.orgId), slot, isNotNull(edges.expiredAt), isNotNull(edges.verifiedBy), eq(edges.confidence, 0)));
  if (rejected.some((r) => sameStatement(r.fact, f.fact))) return { outcome: "skipped" };

  const links = new Map<string, Link>();
  for (const id of f.replaces) links.set(id, "replaces");
  for (const id of f.conflicts) if (!links.has(id)) links.set(id, "conflicts");
  const named = [...links.keys()].filter((id) => !inSlot.some((e) => e.id === id));
  const touched = [...inSlot, ...(named.length ? await standingFacts(tx, f.orgId, inArray(edges.id, named)) : [])];
  for (const e of inSlot) if (!links.has(e.id)) links.set(e.id, "same_slot");
  // Everything already in dispute with those is part of the same question.
  const groups = [...new Set(touched.flatMap((e) => (e.disputeGroup ? [e.disputeGroup] : [])))];
  for (const e of groups.length ? await standingFacts(tx, f.orgId, inArray(edges.disputeGroup, groups)) : []) {
    if (links.has(e.id)) continue;
    links.set(e.id, links.get(touched.find((t) => t.disputeGroup === e.disputeGroup)!.id)!);
    touched.push(e);
  }

  const ends = await tx.select({ personId: entities.personId }).from(entities).where(inArray(entities.id, [f.sourceEntityId, f.targetEntityId]));
  const claim: Claim = { stance: f.stance, speaker: await speakerFor(tx, f.speakerId, ends.map((e) => e.personId)), speakerId: f.speakerId, at: f.saidAt ?? f.validFrom };
  const verdicts = touched.map((e) => ({ e, verdict: weigh(claim, e, links.get(e.id)!) }));
  if (verdicts.some((v) => v.verdict === "keep")) return { outcome: "skipped" };

  const validFrom = f.validFrom ?? f.saidAt;
  const [edge] = await tx
    .insert(edges)
    .values({
      orgId: f.orgId,
      sourceEntityId: f.sourceEntityId,
      targetEntityId: f.targetEntityId,
      relation: f.relation,
      fact: f.fact,
      validFrom,
      sourceMessageIds: f.messageIds,
      sourceChunkId: f.sourceChunkId,
      acl: f.acl,
      confidence: startingConfidence(f.stance, claim.speaker),
      assertedByPersonId: f.speakerId ?? null,
    })
    .returning({ id: edges.id });

  await expire(tx, f.orgId, verdicts.filter((v) => v.verdict === "replace").map((v) => v.e.id), edge.id, validFrom ?? new Date());
  const disputed = verdicts.filter((v) => v.verdict === "dispute").map((v) => v.e);
  if (disputed.length) {
    const group = disputed.find((e) => e.disputeGroup)?.disputeGroup ?? randomUUID();
    await tx.update(edges).set({ disputeGroup: group }).where(and(eq(edges.orgId, f.orgId), inArray(edges.id, [edge.id, ...disputed.map((e) => e.id)])));
  }
  return { outcome: "added", id: edge.id, disputed: disputed.length > 0 };
}

export interface Confirmation {
  /** The message that restates the fact; one already counted as its evidence changes nothing. */
  messageId: string;
  at?: Date;
  stance: Stance;
  speakerId?: string | null;
  /** The message's ACL, when the message states the whole fact (so its readers may see the fact). */
  acl?: string[];
}

/**
 * A message restated a current fact: it's remembered as confirmed then, with a little more
 * confidence, and the message joins its evidence. If the fact was in dispute and the speaker
 * has the authority (see `settles`), the other sides become history.
 */
export async function confirmFact(tx: Db, orgId: string, edgeId: string, c: Confirmation): Promise<FactOutcome> {
  const [fact] = await standingFacts(tx, orgId, eq(edges.id, edgeId));
  if (!fact || c.stance === "question" || fact.sourceMessageIds.includes(c.messageId)) return { outcome: "skipped" };
  const speaker = await speakerFor(tx, c.speakerId, fact.endpoints);
  const own = !!c.speakerId && c.speakerId === fact.speakerId;
  const at = c.at ?? new Date();
  // A stronger voice than whoever first said it now stands behind the fact, and its message becomes the one to cite.
  const stronger = RANK[speaker] > RANK[fact.speaker];
  await tx
    .update(edges)
    .set({
      lastConfirmedAt: fact.lastConfirmedAt && fact.lastConfirmedAt > at ? fact.lastConfirmedAt : at,
      confidence: reinforce(fact.confidence, c.stance === "confirmed" || (c.stance === "firm" && !own)),
      sourceMessageIds: stronger ? [c.messageId, ...fact.sourceMessageIds] : [...fact.sourceMessageIds, c.messageId],
      assertedByPersonId: stronger ? c.speakerId : fact.speakerId,
      acl: c.acl ? unionAcl(fact.acl, c.acl) : fact.acl,
    })
    .where(eq(edges.id, fact.id));

  if (fact.disputeGroup) {
    const others = (await standingFacts(tx, orgId, eq(edges.disputeGroup, fact.disputeGroup))).filter((o) => o.id !== fact.id);
    const later = others.every((o) => !o.at || o.at < at);
    if (others.length && settles({ stance: c.stance, speaker, own, later }, others.map((o) => o.speaker))) {
      await expire(tx, orgId, others.map((o) => o.id), fact.id, at);
      await tx.update(edges).set({ disputeGroup: null }).where(eq(edges.id, fact.id));
    }
  }
  return { outcome: "confirmed", id: fact.id };
}

// ---------------------------------------------------------------------------
// People checking facts
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The fact, read as the viewer: missing when they can't see it. Writes happen on the owner connection after this. */
async function visibleCurrentFact(db: Db, viewer: Viewer, id: string) {
  if (!UUID.test(id)) throw new Error("Bad request");
  const [fact] = await withScope(db, viewer, (tx) => tx.select({ id: edges.id, disputeGroup: edges.disputeGroup, expiredAt: edges.expiredAt }).from(edges).where(eq(edges.id, id)));
  if (!fact) throw new Error("Not found");
  if (fact.expiredAt) throw new Error("That fact is already history.");
  return fact;
}

/**
 * A person says a fact is right: full confidence, and anything it was in dispute with becomes
 * history. Only for a fact they can see.
 */
export async function verifyFact(db: Db, viewer: Viewer, id: string, action: "fact.verify" | "fact.resolve_dispute" = "fact.verify") {
  const fact = await visibleCurrentFact(db, viewer, id);
  if (action === "fact.resolve_dispute" && !fact.disputeGroup) throw new Error("That's already settled.");
  const now = new Date();
  const settled = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx
      .update(edges)
      .set({ verifiedBy: viewer.personId, verifiedAt: now, lastConfirmedAt: now, confidence: 1, disputeGroup: null })
      .where(and(eq(edges.id, id), eq(edges.orgId, viewer.orgId)));
    if (!fact.disputeGroup) return 0;
    const others = await tx
      .select({ id: edges.id })
      .from(edges)
      .where(and(eq(edges.orgId, viewer.orgId), eq(edges.disputeGroup, fact.disputeGroup), isNull(edges.expiredAt)));
    await expire(tx, viewer.orgId, others.map((o) => o.id), id, now);
    return others.length;
  });
  await audit(db, { orgId: viewer.orgId, personId: viewer.personId, action, target: id, detail: { settled } });
}

/** Settles a dispute in favour of the side a person picked. */
export const resolveDispute = (db: Db, viewer: Viewer, id: string) => verifyFact(db, viewer, id, "fact.resolve_dispute");

/** A person says a fact is wrong: it becomes history and isn't written again from the same words. */
export async function markFactWrong(db: Db, viewer: Viewer, id: string) {
  await visibleCurrentFact(db, viewer, id);
  const now = new Date();
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await expire(tx, viewer.orgId, [id], null, now);
    await tx.update(edges).set({ verifiedBy: viewer.personId, verifiedAt: now, confidence: 0 }).where(and(eq(edges.id, id), eq(edges.orgId, viewer.orgId)));
    await dissolveLoneDisputes(tx, viewer.orgId);
  });
  await audit(db, { orgId: viewer.orgId, personId: viewer.personId, action: "fact.wrong", target: id });
}

// ---------------------------------------------------------------------------
// Reading facts with how far to trust them (inside withScope)
// ---------------------------------------------------------------------------

export interface FactCard {
  id: string;
  fact: string;
  relation: string;
  source: string;
  target: string;
  current: boolean;
  validFrom: Date | null;
  validTo: Date | null;
  confidence: ConfidenceWord;
  verified: boolean;
  /** Current, but nobody has said or checked it for a long time. */
  mayBeOutdated: boolean;
  saidBy: string | null;
  lastConfirmedAt: Date | null;
  /** The first piece of evidence the viewer can see. */
  messageId: string | null;
  /** Other current facts it contradicts, as far as the viewer can see them. */
  disputedWith: FactCard[];
}

/**
 * Facts matching `where` with how far to trust each: confidence as a word, who said it, whether it
 * may be out of date and what it's in dispute with. Run inside withScope(): only the sides of a
 * dispute the viewer can see count, so nobody learns of a statement made where they can't read.
 */
export async function factCards(tx: Db, where: SQL | undefined, now: Date, limit = 200): Promise<FactCard[]> {
  const select = (cond: SQL | undefined) =>
    tx
      .select({
        id: edges.id,
        fact: edges.fact,
        relation: edges.relation,
        source: subject.name,
        target: object.name,
        validFrom: edges.validFrom,
        validTo: edges.validTo,
        createdAt: edges.createdAt,
        expiredAt: edges.expiredAt,
        score: edges.confidence,
        disputeGroup: edges.disputeGroup,
        verifiedAt: edges.verifiedAt,
        lastConfirmedAt: edges.lastConfirmedAt,
        saidBy: people.displayName,
        messageId: sql<string | null>`(select m.id from unnest(${edges.sourceMessageIds}) with ordinality as u(id, n) join messages m on m.id = u.id order by u.n limit 1)`,
      })
      .from(edges)
      .innerJoin(subject, eq(subject.id, edges.sourceEntityId))
      .innerJoin(object, eq(object.id, edges.targetEntityId))
      .leftJoin(people, eq(people.id, edges.assertedByPersonId))
      .where(cond)
      .orderBy(asc(edges.validFrom), asc(edges.createdAt))
      .limit(limit);
  const rows = await select(where);
  const groups = [...new Set(rows.flatMap((r) => (r.disputeGroup && !r.expiredAt ? [r.disputeGroup] : [])))];
  const sides = groups.length ? await select(and(inArray(edges.disputeGroup, groups), isNull(edges.expiredAt))) : [];

  type Row = (typeof rows)[number];
  const others = (r: Row) => (r.disputeGroup && !r.expiredAt ? sides.filter((s) => s.disputeGroup === r.disputeGroup && s.id !== r.id) : []);
  const card = (r: Row, withSides: boolean): FactCard => ({
    id: r.id,
    fact: r.fact,
    relation: r.relation,
    source: r.source,
    target: r.target,
    current: !r.expiredAt,
    validFrom: r.validFrom,
    validTo: r.validTo,
    confidence: confidenceWord(r.score, { disputed: others(r).length > 0, verified: !!r.verifiedAt && !r.expiredAt }),
    verified: !!r.verifiedAt && !r.expiredAt,
    mayBeOutdated: isStale(r, now),
    saidBy: r.saidBy,
    lastConfirmedAt: r.lastConfirmedAt,
    messageId: r.messageId,
    disputedWith: withSides ? others(r).map((o) => card(o, false)) : [],
  });
  return rows.map((r) => card(r, true));
}

/** Open disputes the viewer can see at least two sides of, oldest statement first within each. */
export async function openDisputes(tx: Db, now: Date): Promise<FactCard[][]> {
  const cards = await factCards(tx, and(isNotNull(edges.disputeGroup), isNull(edges.expiredAt)), now);
  const seen = new Set<string>();
  const groups: FactCard[][] = [];
  for (const c of cards) {
    if (seen.has(c.id) || !c.disputedWith.length) continue;
    const group = [c, ...c.disputedWith];
    for (const g of group) seen.add(g.id);
    groups.push(group);
  }
  return groups;
}

/** Current facts worth a person's look: said tentatively or second-hand, or not repeated for a long time. Shakiest first. */
export async function factsToCheck(tx: Db, now: Date, limit = 30): Promise<FactCard[]> {
  const soonestStale = new Date(now.getTime() - staleAfterDays("price") * DAY);
  const cards = await factCards(
    tx,
    and(
      isNull(edges.expiredAt),
      isNull(edges.verifiedAt),
      or(sql`coalesce(${edges.confidence}, ${DEFAULT_CONFIDENCE}) < 0.6`, sql`greatest(coalesce(${edges.validFrom}, ${edges.createdAt}), ${edges.lastConfirmedAt}) < ${soonestStale.toISOString()}::timestamptz`),
    ),
    now,
    limit * 4,
  );
  return cards
    .filter((c) => !c.disputedWith.length && (c.confidence === "uncertain" || c.mayBeOutdated))
    .sort((a, b) => Number(b.confidence === "uncertain") - Number(a.confidence === "uncertain"))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Duplicate entities
// ---------------------------------------------------------------------------

export interface DuplicateEntity {
  id: string;
  name: string;
  type: string;
  summary: string | null;
}

export interface DuplicatePair {
  /** The one with more behind it (mentions and facts); the other folds into it. */
  keep: DuplicateEntity;
  dupe: DuplicateEntity;
  reason: "shares a name" | "same email" | "similar description";
}

/** Entities newest-first that get compared by meaning; each is checked against every other of its type. */
const COMPARE_BY_MEANING = 300;
/** Cosine distance between "name (type): summary" embeddings below which two entities are probably one. */
const SAME_MEANING = 0.15;

/**
 * Pairs of entities that are probably the same thing: one's name or alias is the other's
 * (ignoring case, spaces and punctuation), two people with one email, or, a weaker sign,
 * nearly the same description. Run inside withScope(): both must be visible.
 */
export async function findDuplicates(tx: Db, limit = 20): Promise<DuplicatePair[]> {
  const squashed = (column: SQL) => sql`regexp_replace(lower(${column}), '[^[:alnum:]]+', '', 'g')`;
  const rows = rowsOf(
    await tx.execute(sql`
      with names as (
        select e.id, e.type, ${squashed(sql`e.name`)} as n from entities e
        union
        select e.id, e.type, ${squashed(sql`a.alias`)} from entity_aliases a join entities e on e.id = a.entity_id
      ),
      pairs as (
        select a.id as a, b.id as b, 1 as strength from names a join names b on a.n = b.n and a.type = b.type and a.id < b.id where length(a.n) >= 3
        union all
        select a.id, b.id, 2 from entities a
          join entities b on a.id < b.id and a.type = 'person' and b.type = 'person'
          join people pa on pa.id = a.person_id join people pb on pb.id = b.person_id
          where a.person_id = b.person_id or lower(pa.primary_email) = lower(pb.primary_email)
        union all
        select least(a.id, b.id), greatest(a.id, b.id), 3
          from (select id, type, name_embedding from entities where name_embedding is not null order by updated_at desc limit ${COMPARE_BY_MEANING}) a
          join entities b on b.id <> a.id and b.type = a.type and b.name_embedding is not null and (a.name_embedding <=> b.name_embedding) < ${SAME_MEANING}
      ),
      best as (select a, b, min(strength) as strength from pairs group by a, b),
      weight as (
        select e.id, (select count(*) from entity_mentions m where m.entity_id = e.id) + (select count(*) from edges g where g.source_entity_id = e.id or g.target_entity_id = e.id) as n
        from entities e
      )
      select p.strength, wa.n >= wb.n as "keepA",
             a.id as "aId", a.name as "aName", a.type as "aType", a.summary as "aSummary",
             b.id as "bId", b.name as "bName", b.type as "bType", b.summary as "bSummary"
      from best p
      join entities a on a.id = p.a join entities b on b.id = p.b
      join weight wa on wa.id = a.id join weight wb on wb.id = b.id
      order by p.strength, a.name
      limit ${limit}`),
  ) as (Record<"aId" | "aName" | "aType" | "bId" | "bName" | "bType", string> & { aSummary: string | null; bSummary: string | null; strength: number; keepA: boolean | string })[];
  const reasons = ["shares a name", "same email", "similar description"] as const;
  return rows.map((r) => {
    const a = { id: r.aId, name: r.aName, type: r.aType, summary: r.aSummary };
    const b = { id: r.bId, name: r.bName, type: r.bType, summary: r.bSummary };
    const keepA = r.keepA === true || r.keepA === "t";
    return { keep: keepA ? a : b, dupe: keepA ? b : a, reason: reasons[Number(r.strength) - 1] };
  });
}
