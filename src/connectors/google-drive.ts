import type { NormalizedMessage, NormalizedPerson, NormalizedThread } from "@/ingest/types";
import { officeText } from "@/ingest/office";
import { ProviderError, type Api } from "./api";
import type { Provider } from "./provider";

const BACKFILL_DAYS = 90;
/** Drive's file search can trail an edit by a little; each sync re-reads this much before its cursor. */
const OVERLAP_MS = 5 * 60_000;
const MAX_FILES = 200;
const MAX_DRIVES = 100;
const MAX_TEXT_CHARS = 1_000_000;
/** Word and PowerPoint files are downloaded whole to be read; bigger ones are mostly images. */
const MAX_OFFICE_BYTES = 20 * 1024 * 1024;
/** Google Docs and Slides: the files Drive can export as plain text. */
const GOOGLE_TYPES = ["application/vnd.google-apps.document", "application/vnd.google-apps.presentation"];
/** Word and PowerPoint files stored in Drive: downloaded and read here (Drive only exports Google's own formats). */
const OFFICE_TYPES = ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.presentationml.presentation"];
const MIME_TYPES = [...GOOGLE_TYPES, ...OFFICE_TYPES];

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
  /** Bytes; set for uploaded files such as Word documents, not for Google Docs. */
  size?: string;
  /** Set when the file lives in a shared drive. */
  driveId?: string;
  lastModifyingUser?: { displayName?: string; emailAddress?: string };
}

/** Files of the wanted kinds edited after `after`, oldest first, in one corpus (My Drive and files shared with the person, or one shared drive). */
async function listFiles(api: Api, after: string, corpus: Record<string, string>): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const r = await api<{ files?: DriveFile[]; nextPageToken?: string }>("GET", "drive/v3/files", {
      query: {
        ...corpus,
        q: `(${MIME_TYPES.map((m) => `mimeType='${m}'`).join(" or ")}) and modifiedTime > '${after}' and trashed=false`,
        fields: "nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,size,driveId,lastModifyingUser(displayName,emailAddress))",
        orderBy: "modifiedTime",
        pageSize: 100,
        pageToken,
      },
    });
    files.push(...(r.files ?? []));
    pageToken = r.nextPageToken;
  } while (pageToken && files.length < MAX_FILES);
  return files.slice(0, MAX_FILES);
}

/** A file's plain text, or undefined when it can't be read or is too big to keep. */
async function fileText(api: Api, f: DriveFile): Promise<string | undefined> {
  if (OFFICE_TYPES.includes(f.mimeType) && Number(f.size ?? 0) > MAX_OFFICE_BYTES) return undefined;
  try {
    if (OFFICE_TYPES.includes(f.mimeType)) {
      const bytes = await api<Uint8Array>("GET", `drive/v3/files/${encodeURIComponent(f.id)}`, { query: { alt: "media", supportsAllDrives: "true" }, headers: { accept: "*/*" }, as: "bytes" });
      return officeText(bytes, f.mimeType);
    }
    return await api<string>("GET", `drive/v3/files/${encodeURIComponent(f.id)}/export`, { query: { mimeType: "text/plain" }, headers: { accept: "text/plain" }, as: "text" });
  } catch (e) {
    // Drive refuses to export more than 10 MB (over our own limit anyway), and owners can stop viewers downloading a file.
    if (e instanceof ProviderError && e.status === 403 && /exportSizeLimitExceeded|too large to be exported|cannotDownloadFile|cannotExportFile/i.test(e.message)) return undefined;
    throw e;
  }
}

/**
 * Google Docs, Slides, Word and PowerPoint files edited since the last sync, or in the last 90 days on
 * the first one: in My Drive, shared with the person, and in every shared drive they belong to.
 * Read oldest first, so a sync that stops at its cap continues where it stopped.
 * Each file is one document thread holding its text as a version (messages are never changed);
 * the caller retires older versions.
 */
export async function fetchGoogleDrive(
  api: Api,
  cursor: GoogleDriveCursor = {},
  now = new Date(),
): Promise<{ people: NormalizedPerson[]; threads: NormalizedThread[]; messages: NormalizedMessage[]; cursor: GoogleDriveCursor; versions: Map<string, string> }> {
  const after = new Date(cursor.since ? Date.parse(cursor.since) - OVERLAP_MS : now.getTime() - BACKFILL_DAYS * 86_400_000).toISOString();

  const drives: { id: string; name?: string }[] = [];
  let pageToken: string | undefined;
  do {
    const r = await api<{ drives?: { id: string; name?: string }[]; nextPageToken?: string }>("GET", "drive/v3/drives", { query: { pageSize: 100, fields: "nextPageToken,drives(id,name)", pageToken } });
    drives.push(...(r.drives ?? []));
    pageToken = r.nextPageToken;
  } while (pageToken && drives.length < MAX_DRIVES);
  const driveName = new Map(drives.map((d) => [d.id, d.name]));

  // Each corpus is read oldest first up to the cap, so the oldest files across all of them are exactly these.
  const found = new Map<string, DriveFile>();
  for (const corpus of [{ corpora: "user" }, ...drives.slice(0, MAX_DRIVES).map((d) => ({ corpora: "drive", driveId: d.id, includeItemsFromAllDrives: "true", supportsAllDrives: "true" }))]) {
    for (const f of await listFiles(api, after, corpus)) found.set(f.id, f);
  }
  const files = [...found.values()].sort((a, b) => Date.parse(a.modifiedTime) - Date.parse(b.modifiedTime)).slice(0, MAX_FILES);

  const people = new Map<string, NormalizedPerson>();
  const threads: NormalizedThread[] = [];
  const messages: NormalizedMessage[] = [];
  const versions = new Map<string, string>();
  for (const f of files) {
    let text = await fileText(api, f);
    text = text?.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!text || text.length > MAX_TEXT_CHARS) continue;

    const email = f.lastModifyingUser?.emailAddress?.toLowerCase();
    const authorKey = email ? `email:${email}` : undefined;
    if (email && authorKey) people.set(authorKey, { key: authorKey, provider: "email", externalId: email, displayName: f.lastModifyingUser?.displayName ?? email, email });

    const externalId = `${f.id}@${f.modifiedTime}`;
    versions.set(f.id, externalId);
    // Shared-drive files follow the same rule as the rest: only the person who connected Drive is known to have access.
    // The drive's other members aren't added; who belongs to it changes and isn't read here.
    const metadata: Record<string, unknown> = { mimeType: f.mimeType };
    if (f.driveId) Object.assign(metadata, { driveId: f.driveId, driveName: driveName.get(f.driveId) });
    threads.push({ externalId: f.id, kind: "doc", title: f.name, url: f.webViewLink, visibility: "members", memberKeys: [], metadata });
    messages.push({ threadExternalId: f.id, externalId, kind: "note", authorKey, sentAt: new Date(f.modifiedTime), subject: f.name, text, url: f.webViewLink });
  }

  const since = files.reduce((max, f) => (!max || Date.parse(f.modifiedTime) > Date.parse(max) ? f.modifiedTime : max), cursor.since);
  return { people: [...people.values()], threads, messages, cursor: { since }, versions };
}

/** The person's Google Docs, Slides, Word and PowerPoint files, shared drives included, as text. Each document is visible only to the person who connected it. */
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
