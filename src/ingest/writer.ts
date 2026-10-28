import { and, eq, or, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { connections, identities, messages, people, syncRuns, threadMembers, threads } from "@/db/schema";
import type { NormalizedBatch, NormalizedPerson } from "./types";

export interface WriteResult {
  connectionId: string;
  people: number;
  threads: number;
  messages: { inserted: number; skipped: number };
}

/**
 * Saves a normalized batch for one org. Idempotent: re-running the same batch
 * inserts nothing new. Runs as the table owner, so every query filters by orgId.
 */
export async function writeBatch(
  db: Db,
  orgId: string,
  batch: NormalizedBatch,
  kind: "backfill" | "incremental" | "webhook" | "upload" = "upload",
): Promise<WriteResult> {
  return db.transaction(async (tx) => {
    const personIds = new Map<string, string>();
    for (const p of batch.people) personIds.set(p.key, await resolvePerson(tx as unknown as Db, orgId, p));

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
      people: personIds.size,
      threads: threadIds.size,
      messages: { inserted, skipped: rows.length - inserted },
    };
    await tx
      .update(syncRuns)
      .set({
        status: "ok",
        finishedAt: new Date(),
        counts: { people: result.people, threads: result.threads, inserted, skipped: result.messages.skipped },
      })
      .where(eq(syncRuns.id, run.id));
    await tx.update(connections).set({ lastSyncedAt: new Date() }).where(eq(connections.id, connectionId));
    return result;
  });
}

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
