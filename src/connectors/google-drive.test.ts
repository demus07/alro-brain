import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { ProviderError, type Api } from "./api";
import { googleDrive } from "./google-drive";

/** A provider API answered from a table of paths; records every call. */
function fakeApi(routes: Record<string, (q: Record<string, unknown>, body?: unknown) => unknown>) {
  const calls: { path: string; query: Record<string, unknown>; as?: string }[] = [];
  const api: Api = async (_method, path, opts = {}) => {
    const query = opts.query ?? {};
    calls.push({ path, query, as: opts.as });
    if (path === "drive/v3/drives" && !routes[path]) return { drives: [] } as never;
    const route = Object.keys(routes).find((r) => (r.endsWith("*") ? path.startsWith(r.slice(0, -1)) : path === r));
    if (!route) throw new ProviderError(`no route for ${path}`, 404);
    return routes[route](query, opts.body) as never;
  };
  return { api, calls };
}

const NOW = new Date("2026-11-02T12:00:00Z");
const ctx = { credentials: {}, accountId: "sumedh@example.com", now: NOW };
const DOC = "application/vnd.google-apps.document";
const SLIDES = "application/vnd.google-apps.presentation";
const WORD = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPT = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const docx = (text: string) => zipSync({ "word/document.xml": strToU8(`<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`) });

const file = (id: string, name: string, modifiedTime: string, mimeType = DOC, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  mimeType,
  modifiedTime,
  ...extra,
  webViewLink: `https://docs.google.com/document/d/${id}/edit`,
  lastModifyingUser: { displayName: "Jash Doshi", emailAddress: "Jash@example.com" },
});

const routes = {
  "drive/v3/about": () => ({ user: { emailAddress: "Sumedh@example.com" } }),
  "drive/v3/files": () => ({
    files: [
      file("d1", "Launch deck", "2026-10-20T09:00:00.000Z", SLIDES),
      file("d5", "Novel", "2026-10-28T10:00:00.000Z"),
      file("d3", "Huge", "2026-10-29T10:00:00.000Z"),
      file("d4", "Empty", "2026-10-30T10:00:00.000Z"),
      file("d2", "Pricing", "2026-11-01T10:00:00.000Z"),
    ],
  }),
  "drive/v3/files/d2/export": () => "﻿Pricing\r\n\r\n\r\n\r\n₹55k per site\r\n",
  "drive/v3/files/d4/export": () => "﻿\r\n",
  "drive/v3/files/d3/export": () => {
    throw new ProviderError('GET www.googleapis.com/drive/v3/files/d3/export: 403 {"error":{"code":403,"errors":[{"reason":"exportSizeLimitExceeded"}]}}', 403);
  },
  "drive/v3/files/d5/export": () => "x".repeat(1_000_001),
  "drive/v3/files/d1/export": () => "Launch plan\nPhase one",
};

describe("Google Drive", () => {
  it("reads Docs and Slides from the last 90 days, oldest first, as versioned documents only the connecting person can see", async () => {
    const { api, calls } = fakeApi(routes);
    const found = await googleDrive.sync!(api, undefined, ctx);

    expect(found.threads).toEqual([
      { externalId: "d1", kind: "doc", title: "Launch deck", url: "https://docs.google.com/document/d/d1/edit", visibility: "members", memberKeys: [], metadata: { mimeType: SLIDES } },
      { externalId: "d2", kind: "doc", title: "Pricing", url: "https://docs.google.com/document/d/d2/edit", visibility: "members", memberKeys: [], metadata: { mimeType: DOC } },
    ]);
    expect(found.messages!.map((m) => [m.threadExternalId, m.externalId, m.kind, m.authorKey, m.subject, m.text, m.sentAt.toISOString()])).toEqual([
      ["d1", "d1@2026-10-20T09:00:00.000Z", "note", "email:jash@example.com", "Launch deck", "Launch plan\nPhase one", "2026-10-20T09:00:00.000Z"],
      ["d2", "d2@2026-11-01T10:00:00.000Z", "note", "email:jash@example.com", "Pricing", "Pricing\n\n₹55k per site", "2026-11-01T10:00:00.000Z"],
    ]);
    expect(found.people).toEqual([{ key: "email:jash@example.com", provider: "email", externalId: "jash@example.com", displayName: "Jash Doshi", email: "jash@example.com" }]);
    expect([...found.versions!]).toEqual([
      ["d1", "d1@2026-10-20T09:00:00.000Z"],
      ["d2", "d2@2026-11-01T10:00:00.000Z"],
    ]);
    expect(found.cursor).toEqual({ since: "2026-11-01T10:00:00.000Z" });

    const list = calls.find((c) => c.path === "drive/v3/files")!.query;
    expect(list.q).toBe(`(mimeType='${DOC}' or mimeType='${SLIDES}' or mimeType='${WORD}' or mimeType='${PPT}') and modifiedTime > '2026-08-04T12:00:00.000Z' and trashed=false`);
    expect(list).toMatchObject({ corpora: "user", orderBy: "modifiedTime" });
    expect(calls.find((c) => c.path === "drive/v3/files/d2/export")).toMatchObject({ query: { mimeType: "text/plain" }, as: "text" });
  });

  it("asks only for files edited since the cursor, and keeps the cursor when nothing changed", async () => {
    const { api, calls } = fakeApi({ "drive/v3/files": () => ({ files: [] }) });
    const found = await googleDrive.sync!(api, { since: "2026-11-01T10:00:00.000Z" }, ctx);
    expect(String(calls.find((c) => c.path === "drive/v3/files")!.query.q)).toContain("modifiedTime > '2026-11-01T09:55:00.000Z'");
    expect(found.messages).toEqual([]);
    expect(found.cursor).toEqual({ since: "2026-11-01T10:00:00.000Z" });
  });

  it("follows pages and stops at 200 files", async () => {
    const page = (n: number) => Array.from({ length: 100 }, (_, i) => file(`p${n}-${i}`, `Doc ${n}-${i}`, "2026-11-01T10:00:00.000Z"));
    const { api, calls } = fakeApi({
      "drive/v3/files": (q) => ({ files: page(Number(q.pageToken ?? 0)), nextPageToken: String(Number(q.pageToken ?? 0) + 1) }),
      "drive/v3/files/*": () => "text",
    });
    const found = await googleDrive.sync!(api, undefined, ctx);
    expect(calls.filter((c) => c.path === "drive/v3/files").map((c) => c.query.pageToken)).toEqual([undefined, "1"]);
    expect(found.messages).toHaveLength(200);
  });

  it("reads every shared drive the person belongs to, and Word and PowerPoint files, keeping each visible only to them", async () => {
    const { api, calls } = fakeApi({
      "drive/v3/drives": (q) => (q.pageToken ? { drives: [{ id: "SD2", name: "Finance" }] } : { drives: [{ id: "SD1", name: "Sales" }], nextPageToken: "n2" }),
      "drive/v3/files": (q) =>
        q.driveId === "SD1"
          ? {
              files: [
                file("w1", "Quote.docx", "2026-10-25T10:00:00.000Z", WORD, { driveId: "SD1", size: "20480" }),
                file("p1", "Pitch.pptx", "2026-10-26T10:00:00.000Z", PPT, { driveId: "SD1", size: String(30 * 1024 * 1024) }),
                file("w2", "Locked.docx", "2026-10-27T10:00:00.000Z", WORD, { driveId: "SD1", size: "1000" }),
              ],
            }
          : q.driveId === "SD2"
            ? { files: [file("s1", "Budget notes", "2026-10-24T10:00:00.000Z", DOC, { driveId: "SD2" })] }
            : // A shared-drive file shared directly with the person also shows up here; it is read once.
              { files: [file("w1", "Quote.docx", "2026-10-25T10:00:00.000Z", WORD, { driveId: "SD1", size: "20480" })] },
      "drive/v3/files/w1": () => docx("Quote for Acme: ₹4,20,000"),
      "drive/v3/files/w2": () => {
        throw new ProviderError('GET www.googleapis.com/drive/v3/files/w2: 403 {"error":{"errors":[{"reason":"cannotDownloadFile"}]}}', 403);
      },
      "drive/v3/files/s1/export": () => "Budget: ₹12L",
    });
    const found = await googleDrive.sync!(api, undefined, ctx);

    expect(found.threads).toEqual([
      { externalId: "s1", kind: "doc", title: "Budget notes", url: "https://docs.google.com/document/d/s1/edit", visibility: "members", memberKeys: [], metadata: { mimeType: DOC, driveId: "SD2", driveName: "Finance" } },
      { externalId: "w1", kind: "doc", title: "Quote.docx", url: "https://docs.google.com/document/d/w1/edit", visibility: "members", memberKeys: [], metadata: { mimeType: WORD, driveId: "SD1", driveName: "Sales" } },
    ]);
    expect(found.messages!.map((m) => [m.externalId, m.text])).toEqual([
      ["s1@2026-10-24T10:00:00.000Z", "Budget: ₹12L"],
      ["w1@2026-10-25T10:00:00.000Z", "Quote for Acme: ₹4,20,000"],
    ]);
    // Pitch.pptx is over 20 MB and was never downloaded; Locked.docx refused download and was skipped.
    expect(calls.some((c) => c.path === "drive/v3/files/p1")).toBe(false);
    expect(found.cursor).toEqual({ since: "2026-10-27T10:00:00.000Z" });

    expect(calls.filter((c) => c.path === "drive/v3/drives").map((c) => c.query.pageToken)).toEqual([undefined, "n2"]);
    const lists = calls.filter((c) => c.path === "drive/v3/files").map((c) => c.query);
    expect(lists.map((q) => [q.corpora, q.driveId, q.includeItemsFromAllDrives, q.supportsAllDrives])).toEqual([
      ["user", undefined, undefined, undefined],
      ["drive", "SD1", "true", "true"],
      ["drive", "SD2", "true", "true"],
    ]);
    expect(calls.filter((c) => c.path === "drive/v3/files/w1")).toEqual([{ path: "drive/v3/files/w1", query: { alt: "media", supportsAllDrives: "true" }, as: "bytes" }]);
  });

  it("across drives, reads the oldest 200 files and continues from the last one read", async () => {
    const many = (prefix: string, startHour: number) => Array.from({ length: 150 }, (_, i) => file(`${prefix}${i}`, `${prefix}${i}`, new Date(Date.parse("2026-10-01T00:00:00Z") + (startHour + 2 * i) * 3_600_000).toISOString()));
    const { api } = fakeApi({
      "drive/v3/drives": () => ({ drives: [{ id: "SD1", name: "Sales" }] }),
      "drive/v3/files": (q) => ({ files: q.driveId ? many("s", 1) : many("m", 0) }),
      "drive/v3/files/*": () => "text",
    });
    const found = await googleDrive.sync!(api, undefined, ctx);
    expect(found.messages).toHaveLength(200);
    // Alternating hours: m0 s0 m1 s1 … so the 200th oldest is s99, at hour 199.
    expect(found.messages!.at(-1)!.threadExternalId).toBe("s99");
    expect(found.cursor).toEqual({ since: "2026-10-09T07:00:00.000Z" });
  });

  it("identifies the Google account, and says so plainly when access is refused", async () => {
    const { api } = fakeApi(routes);
    expect(await googleDrive.identify(api, {})).toEqual({ accountId: "sumedh@example.com", label: "sumedh@example.com" });

    const refused = fakeApi({
      "drive/v3/about": () => {
        throw new ProviderError("GET www.googleapis.com/drive/v3/about: 403 insufficientPermissions", 403);
      },
    });
    await expect(googleDrive.identify(refused.api, {})).rejects.toThrow("Google didn't allow access to Drive.");
  });
});
