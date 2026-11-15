import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { events, identities, people, type EventAttendee } from "@/db/schema";
import type { NormalizedEvent } from "./provider";

/**
 * Saves calendar events for one person's calendar. Attendees are matched by email to
 * people ALRO already knows, so a meeting can be tied to past conversations and promises.
 */
export async function writeEvents(db: Db, orgId: string, connectionId: string, ownerPersonId: string, found: NormalizedEvent[]): Promise<number> {
  if (!found.length) return 0;
  const emails = [...new Set(found.flatMap((e) => e.attendees.flatMap((a) => (a.email ? [a.email.toLowerCase()] : []))))];
  const known = new Map<string, string>();
  if (emails.length) {
    const viaIdentity = await db
      .select({ email: identities.email, personId: identities.personId })
      .from(identities)
      .where(and(eq(identities.orgId, orgId), inArray(sql`lower(${identities.email})`, emails)));
    for (const r of viaIdentity) if (r.email && r.personId) known.set(r.email.toLowerCase(), r.personId);
    const direct = await db
      .select({ email: people.primaryEmail, personId: people.id })
      .from(people)
      .where(and(eq(people.orgId, orgId), inArray(sql`lower(${people.primaryEmail})`, emails)));
    for (const r of direct) if (r.email) known.set(r.email.toLowerCase(), r.personId);
  }

  for (const e of found) {
    const attendees: EventAttendee[] = e.attendees.map((a) => ({ ...a, email: a.email?.toLowerCase(), personId: a.email ? known.get(a.email.toLowerCase()) : undefined }));
    const row = {
      title: e.title || "(no title)",
      description: e.description,
      location: e.location,
      url: e.url,
      startsAt: e.startsAt,
      endsAt: e.endsAt,
      allDay: e.allDay ?? false,
      organizer: e.organizer,
      attendees,
      cancelled: e.cancelled ?? false,
    };
    await db
      .insert(events)
      .values({ orgId, connectionId, externalId: e.externalId, ownerPersonId, acl: [`p:${ownerPersonId}`], ...row })
      .onConflictDoUpdate({ target: [events.connectionId, events.externalId], set: { ...row, updatedAt: new Date() } });
  }
  return found.length;
}
