import { randomUUID } from "node:crypto";
import type { Db } from "@/db/client";
import type { Viewer } from "@/db/scope";
import { UPLOADER_KEY, writeBatch } from "@/ingest/writer";

/**
 * Saves something a member told ALRO (typed, or dictated as a voice note) into their own
 * private notes. It goes through the same pipeline as any message, so decisions and
 * promises in it are found and it can be cited later. Only they can see it.
 */
export async function saveNote(db: Db, viewer: Viewer, text: string, opts: { title?: string; now?: Date } = {}): Promise<{ messageId: string }> {
  const thread = `notes:${viewer.personId}`;
  const externalId = `note:${randomUUID()}`;
  await writeBatch(
    db,
    viewer.orgId,
    {
      connection: { provider: "notes", scope: "personal", externalAccountId: thread },
      people: [],
      threads: [{ externalId: thread, kind: "doc", title: "My notes", visibility: "members", memberKeys: [] }],
      messages: [{ threadExternalId: thread, externalId, kind: "note", authorKey: UPLOADER_KEY, sentAt: opts.now ?? new Date(), subject: opts.title, text }],
    },
    "upload",
    viewer.personId,
  );
  return { messageId: externalId };
}
