import { and, eq, or, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { createHash } from "node:crypto";
import { connections, identities, messages, people, records, syncRuns, threadMembers, threads } from "@/db/schema";
import type { NormalizedBatch, NormalizedPerson, NormalizedRecord } from "./types";

export interface WriteResult {
  connectionId: string;
  people: number;
  threads: number;
  messages: { inserted: number; skipped: number };
  records?: { upserted: number; changed: number };
}

const UPLOADER_KEY = "alro:uploader";

/**
 * Saves a normalized batch for one org. Idempotent: re-running the same batch
 * inserts nothing new. Runs as the table owner, so every query filters by orgId.
 */
export async function writeBatch(
  db: Db,
  orgId: string,
  batch: NormalizedBatch,
  kind: "backfill" | "incremental" | "webhook" | "upload" = "upload",
  /**
   * Who uploaded it. For personal sources (their WhatsApp, their mailbox) they
   * become a member of every thread even if the source names them differently.
   * Org sources such as a Slack admin export can hold other people's DMs, so
   * there the source's own membership stands.
   */
  uploaderPersonId?: string,
): Promise<WriteResult> {
  return db.transaction(async (tx) => {
    const personIds = new Map<string, string>();
    for (const p of batch.people) personIds.set(p.key, await resolvePerson(tx as unknown as Db, orgId, p));
    if (uploaderPersonId && batch.connection.scope === "personal") {
      personIds.set(UPLOADER_KEY, uploaderPersonId);
      batch = {
        ...batch,
        connection: { ...batch.connection, ownerKey: batch.connection.ownerKey ?? UPLOADER_KEY },
        threads: batch.threads.map((t) => ({ ...t, memberKeys: [...t.memberKeys, UPLOADER_KEY] })),
      };
    }

    const connectionId = await upsertConnection(tx as unknown as Db, orgId, batch, personIds);
    const [run] = await tx.insert(syncRuns).values({ orgId, connectionId, kind }).returning({ id: syncRuns.id });

    const threadIds = new Map<string, string>();
    for (const t of batch.threads) {
      const [row] = await tx
        .insert(threads)
        .values({
          orgId,
          connectionId,
          kind: t.kind,
          externalId: t.externalId,
          title: t.title,
          url: t.url,
          visibility: t.visibility,
          metadata: t.metadata,
        })
        .onConflictDoUpdate({
          target: [threads.connectionId, threads.externalId],
          set: { title: t.title, visibility: t.visibility, metadata: t.metadata, updatedAt: new Date() },
        })
        .returning({ id: threads.id });
      threadIds.set(t.externalId, row.id);

      const members = t.memberKeys.map((k) => personIds.get(k)).filter((id): id is string => !!id);
      if (members.length) {
        await tx
          .insert(threadMembers)
          .values([...new Set(members)].map((personId) => ({ orgId, threadId: row.id, personId })))
          .onConflictDoNothing();
      }
    }

    let inserted = 0;
    const rows = batch.messages.map((m) => {
      const threadId = threadIds.get(m.threadExternalId);
      if (!threadId) throw new Error(`Message ${m.externalId} refers to unknown thread ${m.threadExternalId}`);
      return {
        orgId,
        threadId,
        connectionId,
        externalId: m.externalId,
        kind: m.kind,
        authorPersonId: m.authorKey ? personIds.get(m.authorKey) : undefined,
        recipientPersonIds: (m.recipientKeys ?? []).map((k) => personIds.get(k)).filter((id): id is string => !!id),
        sentAt: m.sentAt,
        replyToExternalId: m.replyToExternalId,
        subject: m.subject,
        text: m.text,
        attachments: m.attachments,
        url: m.url,
        raw: m.raw,
        editedAt: m.editedAt,
        deletedAt: m.deleted ? m.sentAt : undefined,
      };
    });
    for (let i = 0; i < rows.length; i += 500) {
      const result = await tx
        .insert(messages)
        .values(rows.slice(i, i + 500))
        .onConflictDoNothing({ target: [messages.connectionId, messages.externalId] })
        .returning({ id: messages.id });
      inserted += result.length;
    }

    const result: WriteResult = {
      connectionId,
      people: batch.people.length,
      threads: threadIds.size,
      messages: { inserted, skipped: rows.length - inserted },
    };
    if (batch.records?.length) {
      const ownerPersonId = batch.connection.ownerKey ? personIds.get(batch.connection.ownerKey) : undefined;
      result.records = await writeRecords(tx as unknown as Db, orgId, connectionId, batch, ownerPersonId, personIds);
    }
    await tx
      .update(syncRuns)
      .set({
        status: "ok",
        finishedAt: new Date(),
        counts: {
          people: result.people,
          threads: result.threads,
          inserted,
          skipped: result.messages.skipped,
          ...(result.records && { records: result.records.upserted, recordChanges: result.records.changed }),
        },
      })
      .where(eq(syncRuns.id, run.id));
    await tx.update(connections).set({ lastSyncedAt: new Date() }).where(eq(connections.id, connectionId));
    return result;
  });
}

/**
 * Upserts CRM records and logs what changed as record_change messages on each
 * record's timeline thread, so a stage moving to "Closed Won" is evidence like any message.
 * Org-scoped connections share records with the whole org; personal ones only with the owner.
 */
async function writeRecords(
  db: Db,
  orgId: string,
  connectionId: string,
  batch: NormalizedBatch,
  ownerPersonId: string | undefined,
  personIds: Map<string, string>,
): Promise<{ upserted: number; changed: number }> {
  const shared = batch.connection.scope === "org";
  if (!shared && !ownerPersonId) throw new Error("Personal record imports need an owner");
  const acl = shared ? ["org"] : [`p:${ownerPersonId}`];
  let changed = 0;

  for (const r of batch.records ?? []) {
    const [thread] = await db
      .insert(threads)
      .values({
        orgId,
        connectionId,
        kind: "crm_timeline",
        externalId: `record:${r.type}:${r.externalId}`,
        title: `${capitalize(r.type)}: ${r.title}`,
        url: r.url,
        visibility: shared ? "org" : "members",
      })
      .onConflictDoUpdate({
        target: [threads.connectionId, threads.externalId],
        set: { title: `${capitalize(r.type)}: ${r.title}`, updatedAt: new Date() },
      })
      .returning({ id: threads.id });
    if (!shared) {
      await db.insert(threadMembers).values({ orgId, threadId: thread.id, personId: ownerPersonId! }).onConflictDoNothing();
    }

    const [existing] = await db
      .select({ fields: records.fields })
      .from(records)
      .where(and(eq(records.connectionId, connectionId), eq(records.externalId, `${r.type}:${r.externalId}`)));
    const recordOwner = r.ownerKey ? personIds.get(r.ownerKey) : undefined;
    await db
      .insert(records)
      .values({
        orgId,
        connectionId,
        threadId: thread.id,
        type: r.type,
        externalId: `${r.type}:${r.externalId}`,
        title: r.title,
        fields: r.fields,
        ownerPersonId: recordOwner,
        url: r.url,
        acl,
        sourceUpdatedAt: r.sourceUpdatedAt,
      })
      .onConflictDoUpdate({
        target: [records.connectionId, records.externalId],
        set: { title: r.title, fields: r.fields, ownerPersonId: recordOwner, url: r.url, sourceUpdatedAt: r.sourceUpdatedAt, updatedAt: new Date() },
      });

    const text = describeChange(r, existing?.fields as Record<string, string> | undefined);
    if (!text) continue;
    // Keyed by the new values and modified time, so re-importing the same export logs nothing.
    const hash = createHash("sha1")
      .update(JSON.stringify([Object.entries(r.fields).sort(), r.sourceUpdatedAt?.toISOString()]))
      .digest("hex")
      .slice(0, 16);
    const inserted = await db
      .insert(messages)
      .values({
        orgId,
        threadId: thread.id,
        connectionId,
        externalId: `record:${r.type}:${r.externalId}:${hash}`,
        kind: "record_change",
        authorPersonId: recordOwner,
        sentAt: r.sourceUpdatedAt ?? new Date(),
        subject: r.title,
        text,
        url: r.url,
        raw: { fields: r.fields, previous: existing?.fields ?? null },
      })
      .onConflictDoNothing({ target: [messages.connectionId, messages.externalId] })
      .returning({ id: messages.id });
    changed += inserted.length;
  }
  return { upserted: batch.records?.length ?? 0, changed };
}

/** "Deal "Kirana Kart pilot" updated: Stage: Proposal → Closed Won", or undefined when nothing changed. */
export function describeChange(r: NormalizedRecord, previous: Record<string, string> | undefined): string | undefined {
  const label = `${capitalize(r.type)} "${r.title}"`;
  const show = (v: string | undefined) => (v === undefined || v === "" ? "(empty)" : v);
  if (!previous) {
    const fields = Object.entries(r.fields).filter(([, v]) => v !== "");
    return [`${label} created.`, ...fields.map(([k, v]) => `${k}: ${v}`)].join("\n");
  }
  const keys = [...new Set([...Object.keys(previous), ...Object.keys(r.fields)])];
  const diffs = keys.filter((k) => (previous[k] ?? "") !== (r.fields[k] ?? ""));
  if (!diffs.length) return undefined;
  return [`${label} updated.`, ...diffs.map((k) => `${k}: ${show(previous[k])} → ${show(r.fields[k])}`)].join("\n");
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

async function upsertConnection(
  db: Db,
  orgId: string,
  batch: NormalizedBatch,
  personIds: Map<string, string>,
): Promise<string> {
  const { provider, scope, externalAccountId, ownerKey } = batch.connection;
  const [existing] = await db
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        eq(connections.orgId, orgId),
        eq(connections.provider, provider),
        eq(connections.externalAccountId, externalAccountId),
      ),
    );
  if (existing) return existing.id;
  const [row] = await db
    .insert(connections)
    .values({
      orgId,
      provider,
      scope,
      externalAccountId,
      ownerPersonId: ownerKey ? personIds.get(ownerKey) : undefined,
    })
    .returning({ id: connections.id });
  return row.id;
}

/**
 * Finds the person behind an identity, linking accounts across tools:
 * same provider id, then same email, then same phone, then an exact name match
 * with an existing person. Creates a new person only when nothing matches.
 */
async function resolvePerson(db: Db, orgId: string, p: NormalizedPerson): Promise<string> {
  const email = p.email?.trim().toLowerCase();
  const [known] = await db
    .select({ personId: identities.personId })
    .from(identities)
    .where(
      and(eq(identities.orgId, orgId), eq(identities.provider, p.provider), eq(identities.externalId, p.externalId)),
    );
  if (known?.personId) return known.personId;

  let personId: string | undefined;
  if (email || p.phone) {
    const [match] = await db
      .select({ personId: identities.personId })
      .from(identities)
      .where(
        and(
          eq(identities.orgId, orgId),
          sql`${identities.personId} is not null`,
          or(email ? eq(identities.email, email) : undefined, p.phone ? eq(identities.phone, p.phone) : undefined),
        ),
      )
      .limit(1);
    personId = match?.personId ?? undefined;
  }
  if (!personId && email) {
    const [match] = await db
      .select({ id: people.id })
      .from(people)
      .where(and(eq(people.orgId, orgId), eq(people.primaryEmail, email)));
    personId = match?.id;
  }
  if (!personId) {
    const matches = await db
      .select({ id: people.id })
      .from(people)
      .where(and(eq(people.orgId, orgId), sql`lower(${people.displayName}) = lower(${p.displayName})`));
    if (matches.length === 1) personId = matches[0].id;
  }
  if (!personId) {
    const [created] = await db
      .insert(people)
      .values({ orgId, displayName: p.displayName, primaryEmail: email })
      .returning({ id: people.id });
    personId = created.id;
  }

  await db
    .insert(identities)
    .values({
      orgId,
      personId,
      provider: p.provider,
      externalId: p.externalId,
      displayName: p.displayName,
      email,
      phone: p.phone,
    })
    .onConflictDoUpdate({
      target: [identities.orgId, identities.provider, identities.externalId],
      set: { personId, displayName: p.displayName },
    });
  return personId;
}
