import { describe, expect, it } from "vitest";
import { ProviderError, type Api } from "./api";
import { googleDrive } from "./google-drive";

/** A provider API answered from a table of paths; records every call. */
function fakeApi(routes: Record<string, (q: Record<string, unknown>, body?: unknown) => unknown>) {
  const calls: { path: string; query: Record<string, unknown>; as?: string }[] = [];
  const api: Api = async (_method, path, opts = {}) => {
    const query = opts.query ?? {};
    calls.push({ path, query, as: opts.as });
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

const file = (id: string, name: string, modifiedTime: string, mimeType = DOC) => ({
  id,
  name,
  mimeType,
  modifiedTime,
  webViewLink: `https://docs.google.com/document/d/${id}/edit`,
  lastModifyingUser: { displayName: "Jash Doshi", emailAddress: "Jash@example.com" },
});

const routes = {
  "drive/v3/about": () => ({ user: { emailAddress: "Sumedh@example.com" } }),
  "drive/v3/files": () => ({
    files: [
      file("d2", "Pricing", "2026-11-01T10:00:00.000Z"),
      file("d4", "Empty", "2026-10-30T10:00:00.000Z"),
      file("d3", "Huge", "2026-10-29T10:00:00.000Z"),
      file("d5", "Novel", "2026-10-28T10:00:00.000Z"),
      file("d1", "Launch deck", "2026-10-20T09:00:00.000Z", SLIDES),
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
  it("reads Docs and Slides from the last 90 days as versioned documents only the connecting person can see", async () => {
    const { api, calls } = fakeApi(routes);
    const found = await googleDrive.sync!(api, undefined, ctx);

    expect(found.threads).toEqual([
      { externalId: "d2", kind: "doc", title: "Pricing", url: "https://docs.google.com/document/d/d2/edit", visibility: "members", memberKeys: [], metadata: { mimeType: DOC } },
      { externalId: "d1", kind: "doc", title: "Launch deck", url: "https://docs.google.com/document/d/d1/edit", visibility: "members", memberKeys: [], metadata: { mimeType: SLIDES } },
    ]);
    expect(found.messages!.map((m) => [m.threadExternalId, m.externalId, m.kind, m.authorKey, m.subject, m.text, m.sentAt.toISOString()])).toEqual([
      ["d2", "d2@2026-11-01T10:00:00.000Z", "note", "email:jash@example.com", "Pricing", "Pricing\n\n₹55k per site", "2026-11-01T10:00:00.000Z"],
      ["d1", "d1@2026-10-20T09:00:00.000Z", "note", "email:jash@example.com", "Launch deck", "Launch plan\nPhase one", "2026-10-20T09:00:00.000Z"],
    ]);
    expect(found.people).toEqual([{ key: "email:jash@example.com", provider: "email", externalId: "jash@example.com", displayName: "Jash Doshi", email: "jash@example.com" }]);
    expect([...found.versions!]).toEqual([
      ["d2", "d2@2026-11-01T10:00:00.000Z"],
      ["d1", "d1@2026-10-20T09:00:00.000Z"],
    ]);
    expect(found.cursor).toEqual({ since: "2026-11-01T10:00:00.000Z" });

    const list = calls.find((c) => c.path === "drive/v3/files")!.query;
    expect(list.q).toBe(`(mimeType='${DOC}' or mimeType='${SLIDES}') and modifiedTime > '2026-08-04T12:00:00.000Z' and trashed=false`);
    expect(list.orderBy).toBe("modifiedTime desc");
    expect(calls.find((c) => c.path === "drive/v3/files/d2/export")).toMatchObject({ query: { mimeType: "text/plain" }, as: "text" });
  });

  it("asks only for files edited since the cursor, and keeps the cursor when nothing changed", async () => {
    const { api, calls } = fakeApi({ "drive/v3/files": () => ({ files: [] }) });
    const found = await googleDrive.sync!(api, { since: "2026-11-01T10:00:00.000Z" }, ctx);
    expect(String(calls[0].query.q)).toContain("modifiedTime > '2026-11-01T09:55:00.000Z'");
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
