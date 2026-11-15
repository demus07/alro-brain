import type { NormalizedMessage, NormalizedPerson, NormalizedThread } from "@/ingest/types";
import { ProviderError, type Api } from "./api";
import type { Provider } from "./provider";

const BACKFILL_DAYS = 90;
/** Drive's file search can trail an edit by a little; each sync re-reads this much before its cursor. */
const OVERLAP_MS = 5 * 60_000;
const MAX_FILES = 200;
const MAX_TEXT_CHARS = 1_000_000;
/** Google Docs and Slides: the files Drive can export as plain text. */
const MIME_TYPES = ["application/vnd.google-apps.document", "application/vnd.google-apps.presentation"];

export interface GoogleDriveCursor {
  /** modifiedTime of the most recently edited file read. */
  since?: string;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  webViewLink?: string;
  lastModifyingUser?: { displayName?: string; emailAddress?: string };
}

/**
 * Google Docs and Slides edited since the last sync, or in the last 90 days on the first one.
 * Each file is one document thread holding its text as a version (messages are never changed);
 * the caller retires older versions.
 */
export async function fetchGoogleDrive(
  api: Api,
  cursor: GoogleDriveCursor = {},
  now = new Date(),
): Promise<{ people: NormalizedPerson[]; threads: NormalizedThread[]; messages: NormalizedMessage[]; cursor: GoogleDriveCursor; versions: Map<string, string> }> {
  const after = new Date(cursor.since ? Date.parse(cursor.since) - OVERLAP_MS : now.getTime() - BACKFILL_DAYS * 86_400_000).toISOString();
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const r = await api<{ files?: DriveFile[]; nextPageToken?: string }>("GET", "drive/v3/files", {
      query: {
        q: `(${MIME_TYPES.map((m) => `mimeType='${m}'`).join(" or ")}) and modifiedTime > '${after}' and trashed=false`,
        fields: "nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,lastModifyingUser(displayName,emailAddress))",
        orderBy: "modifiedTime desc",
        pageSize: 100,
        pageToken,
      },
    });
    files.push(...(r.files ?? []));
    pageToken = r.nextPageToken;
  } while (pageToken && files.length < MAX_FILES);

  const people = new Map<string, NormalizedPerson>();
  const threads: NormalizedThread[] = [];
  const messages: NormalizedMessage[] = [];
  const versions = new Map<string, string>();
  for (const f of files.slice(0, MAX_FILES)) {
    let text: string;
    try {
      text = await api<string>("GET", `drive/v3/files/${encodeURIComponent(f.id)}/export`, { query: { mimeType: "text/plain" }, headers: { accept: "text/plain" }, as: "text" });
    } catch (e) {
      // Drive refuses to export more than 10 MB; such a file is over our own limit anyway.
      if (e instanceof ProviderError && e.status === 403 && /exportSizeLimitExceeded|too large to be exported/i.test(e.message)) continue;
      throw e;
    }
    text = text.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!text || text.length > MAX_TEXT_CHARS) continue;

    const email = f.lastModifyingUser?.emailAddress?.toLowerCase();
    const authorKey = email ? `email:${email}` : undefined;
    if (email && authorKey) people.set(authorKey, { key: authorKey, provider: "email", externalId: email, displayName: f.lastModifyingUser?.displayName ?? email, email });

    const externalId = `${f.id}@${f.modifiedTime}`;
    versions.set(f.id, externalId);
    threads.push({ externalId: f.id, kind: "doc", title: f.name, url: f.webViewLink, visibility: "members", memberKeys: [], metadata: { mimeType: f.mimeType } });
    messages.push({ threadExternalId: f.id, externalId, kind: "note", authorKey, sentAt: new Date(f.modifiedTime), subject: f.name, text, url: f.webViewLink });
  }

  const since = files.reduce((max, f) => (!max || Date.parse(f.modifiedTime) > Date.parse(max) ? f.modifiedTime : max), cursor.since);
  return { people: [...people.values()], threads, messages, cursor: { since }, versions };
}

/** The person's Google Docs and Slides, as text. Each document is visible only to the person who connected it. */
export const googleDrive: Provider = {
  id: "google-drive",
  scope: "personal",
  auth: { kind: "oauth", app: "google", scopes: ["https://www.googleapis.com/auth/drive.readonly"], baseUrl: "https://www.googleapis.com/" },
  async identify(api) {
    const about = await api<{ user: { emailAddress: string } }>("GET", "drive/v3/about", { query: { fields: "user(emailAddress)" } }).catch((e) => {
      if (e instanceof ProviderError && (e.status === 401 || e.status === 403)) throw new Error("Google didn't allow access to Drive. Sign in again and allow ALRO to see your files.");
      throw e;
    });
    return { accountId: about.user.emailAddress.toLowerCase(), label: about.user.emailAddress.toLowerCase() };
  },
  async sync(api, cursor, ctx) {
    const { cursor: next, ...found } = await fetchGoogleDrive(api, cursor as GoogleDriveCursor | undefined, ctx.now);
    return { ...found, cursor: next as Record<string, unknown> };
  },
};
