import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { ProviderError, type Api } from "./api";
import { onedrive, sharepoint } from "./microsoft-files";

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
const FIRST = `me/drive/root/delta?token=${encodeURIComponent("2026-08-04T12:00:00Z")}`;
const PAGE2 = "https://graph.microsoft.com/v1.0/me/drive/root/delta?$skiptoken=p2";
const DELTA = "https://graph.microsoft.com/v1.0/me/drive/root/delta?$deltatoken=d1";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const docx = (text: string) => zipSync({ "word/document.xml": strToU8(`<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`) });
const xlsx = zipSync({
  "xl/workbook.xml": strToU8(`<workbook><sheets><sheet name="Runway" r:id="rId1"/></sheets></workbook>`),
  "xl/_rels/workbook.xml.rels": strToU8(`<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`),
  "xl/worksheets/sheet1.xml": strToU8(`<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Months</t></is></c><c r="B1"><v>14</v></c></row></sheetData></worksheet>`),
});

const file = (id: string, name: string, at: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  size: 2048,
  lastModifiedDateTime: at,
  webUrl: `https://example-my.sharepoint.com/personal/sumedh/Documents/${name}`,
  file: { mimeType: name.endsWith(".docx") ? DOCX : "application/octet-stream" },
  parentReference: { driveId: "b!me" },
  lastModifiedBy: { user: { id: "u2", displayName: "Jash Doshi", email: "Jash@example.com" } },
  ...extra,
});
const content = (driveId: string, id: string) => `drives/${encodeURIComponent(driveId)}/items/${id}/content`;
const permissions = (driveId: string, id: string) => `drives/${encodeURIComponent(driveId)}/items/${id}/permissions`;

const oneDriveRoutes = {
  [FIRST]: () => ({
    value: [
      { id: "root", name: "root", root: {}, folder: { childCount: 4 }, lastModifiedDateTime: "2026-11-01T00:00:00Z" },
      file("f1", "Quote.docx", "2026-11-01T10:00:00Z"),
      file("f2", "notes.md", "2026-10-30T09:00:00Z", { file: { mimeType: "text/markdown" } }),
      file("f3", "scan.pdf", "2026-10-29T09:00:00Z", { file: { mimeType: "application/pdf" } }),
      file("f4", "huge.pptx", "2026-10-29T09:00:00Z", { size: 200 * 1024 * 1024 }),
      file("f5", "old.docx", "2026-05-01T09:00:00Z"),
      { id: "f6", name: "gone.docx", deleted: { state: "deleted" } },
    ],
    "@odata.nextLink": PAGE2,
  }),
  [PAGE2]: () => ({ value: [file("f7", "Runway.xlsx", "2026-10-31T08:00:00.5Z", { lastModifiedBy: { user: { displayName: "Sumedh Kudav" } } })], "@odata.deltaLink": DELTA }),
  [content("b!me", "f1")]: () => docx("Quote for Acme: ₹4,20,000"),
  [content("b!me", "f2")]: () => strToU8("﻿# Notes\r\nCall Priya on Monday\r\n"),
  [content("b!me", "f7")]: () => xlsx,
  [permissions("b!me", "f1")]: () => ({
    value: [
      { roles: ["owner"], grantedToV2: { user: { displayName: "Sumedh Kudav", email: "sumedh@example.com" }, siteUser: { displayName: "Sumedh Kudav", email: "sumedh@example.com", loginName: "i:0#.f|membership|sumedh@example.com" } } },
      { roles: ["write"], grantedToV2: { user: { displayName: "Jash Doshi", email: "Jash@example.com" } } },
      { roles: ["read"], link: { scope: "organization", type: "view" }, grantedToIdentitiesV2: [] },
      { roles: ["read"], link: { scope: "users", type: "view" }, grantedToIdentitiesV2: [{ user: { displayName: "Priya Nair", email: "priya@example.com" } }] },
      { roles: ["read"], invitation: { email: "cfo@client.com" }, expirationDateTime: "2026-01-01T00:00:00Z" },
      { roles: ["read"], invitation: { email: "Advisor@client.com" } },
    ],
  }),
  [permissions("b!me", "f2")]: () => {
    throw new ProviderError("GET graph.microsoft.com/…/permissions: 403 accessDenied", 403);
  },
  [permissions("b!me", "f7")]: () => ({ value: [{ roles: ["owner"], grantedToV2: { user: { displayName: "Sumedh Kudav" } } }] }),
};

describe("OneDrive", () => {
  it("reads the last 90 days of Word, Excel and text files as versioned documents shared with named people", async () => {
    const { api, calls } = fakeApi(oneDriveRoutes);
    const found = await onedrive.sync!(api, undefined, ctx);

    expect(found.threads).toEqual([
      {
        externalId: "f1",
        kind: "doc",
        title: "Quote.docx",
        url: "https://example-my.sharepoint.com/personal/sumedh/Documents/Quote.docx",
        visibility: "members",
        // The organisation-wide link does not open a OneDrive file to everyone in ALRO; the expired invitation is ignored.
        memberKeys: ["email:sumedh@example.com", "email:jash@example.com", "email:priya@example.com", "email:advisor@client.com"],
        metadata: { mimeType: DOCX },
      },
      { externalId: "f2", kind: "doc", title: "notes.md", url: "https://example-my.sharepoint.com/personal/sumedh/Documents/notes.md", visibility: "members", memberKeys: [], metadata: { mimeType: "text/markdown" } },
      { externalId: "f7", kind: "doc", title: "Runway.xlsx", url: "https://example-my.sharepoint.com/personal/sumedh/Documents/Runway.xlsx", visibility: "members", memberKeys: [], metadata: { mimeType: "application/octet-stream" } },
    ]);
    expect(found.messages!.map((m) => [m.threadExternalId, m.externalId, m.kind, m.authorKey, m.text, m.sentAt.toISOString()])).toEqual([
      ["f1", "f1@2026-11-01T10:00:00Z", "note", "email:jash@example.com", "Quote for Acme: ₹4,20,000", "2026-11-01T10:00:00.000Z"],
      ["f2", "f2@2026-10-30T09:00:00Z", "note", "email:jash@example.com", "# Notes\nCall Priya on Monday", "2026-10-30T09:00:00.000Z"],
      ["f7", "f7@2026-10-31T08:00:00.5Z", "note", undefined, "Runway\nMonths\t14", "2026-10-31T08:00:00.500Z"],
    ]);
    expect(found.versions).toEqual(new Map([["f1", "f1@2026-11-01T10:00:00Z"], ["f2", "f2@2026-10-30T09:00:00Z"], ["f7", "f7@2026-10-31T08:00:00.5Z"]]));
    expect(found.people).toEqual([
      { key: "email:sumedh@example.com", provider: "email", externalId: "sumedh@example.com", displayName: "Sumedh Kudav", email: "sumedh@example.com" },
      { key: "email:jash@example.com", provider: "email", externalId: "jash@example.com", displayName: "Jash Doshi", email: "jash@example.com" },
      { key: "email:priya@example.com", provider: "email", externalId: "priya@example.com", displayName: "Priya Nair", email: "priya@example.com" },
      { key: "email:advisor@client.com", provider: "email", externalId: "advisor@client.com", displayName: "advisor@client.com", email: "advisor@client.com" },
    ]);
    expect(found.cursor).toEqual({ link: DELTA, syncedAt: NOW.toISOString() });
    // Old, deleted, unreadable and oversized files are never downloaded.
    expect(calls.filter((c) => c.path.endsWith("/content")).map((c) => [c.path, c.as])).toEqual([
      [content("b!me", "f1"), "bytes"],
      [content("b!me", "f2"), "bytes"],
      [content("b!me", "f7"), "bytes"],
    ]);
  });

  it("follows the stored delta link on later syncs", async () => {
    const { api, calls } = fakeApi({ ...oneDriveRoutes, [DELTA]: () => ({ value: [file("f1", "Quote.docx", "2026-11-02T11:00:00Z")], "@odata.deltaLink": `${DELTA}2` }) });
    const found = await onedrive.sync!(api, { link: DELTA, syncedAt: "2026-11-02T11:45:00Z" }, ctx);
    expect(calls.map((c) => c.path)).toEqual([DELTA, content("b!me", "f1"), permissions("b!me", "f1")]);
    expect(found.messages!.map((m) => m.externalId)).toEqual(["f1@2026-11-02T11:00:00Z"]);
    expect(found.cursor).toEqual({ link: `${DELTA}2`, syncedAt: NOW.toISOString() });
  });

  it("keeps the next page's link when a sync runs out of budget mid-round", async () => {
    const many = Array.from({ length: 250 }, (_, i) => file(`m${i}`, `n${i}.txt`, "2026-11-01T10:00:00Z", { file: { mimeType: "text/plain" } }));
    const { api } = fakeApi({
      [FIRST]: () => ({ value: many, "@odata.nextLink": PAGE2 }),
      ...Object.fromEntries(many.map((f) => [content("b!me", f.id), () => strToU8("hello")])),
      ...Object.fromEntries(many.map((f) => [permissions("b!me", f.id), () => ({ value: [] })])),
    });
    const found = await onedrive.sync!(api, undefined, ctx);
    // A page is read whole, so nothing on it is lost; the next sync starts at the following page.
    expect(found.messages).toHaveLength(250);
    expect(found.cursor).toEqual({ link: PAGE2, floor: "2026-08-04T12:00:00Z" });
  });

  it("starts a new round when the delta link has expired", async () => {
    const restart = `me/drive/root/delta?token=${encodeURIComponent("2026-10-31T09:00:00Z")}`;
    const { api, calls } = fakeApi({
      ...oneDriveRoutes,
      [DELTA]: () => {
        throw new ProviderError("GET graph.microsoft.com/…/delta: 410 resyncRequired", 410);
      },
      [restart]: () => ({ value: [], "@odata.deltaLink": `${DELTA}3` }),
    });
    const found = await onedrive.sync!(api, { link: DELTA, syncedAt: "2026-11-01T09:00:00Z" }, ctx);
    expect(calls.map((c) => c.path)).toEqual([DELTA, restart]);
    expect(found.cursor).toEqual({ link: `${DELTA}3`, syncedAt: NOW.toISOString() });
  });

  it("identifies the account, and says so plainly when access is refused", async () => {
    const { api, calls } = fakeApi({ me: () => ({ mail: "Sumedh@example.com", userPrincipalName: "sumedh@example.onmicrosoft.com" }) });
    expect(await onedrive.identify(api, {})).toEqual({ accountId: "sumedh@example.com", label: "sumedh@example.com" });
    expect(calls[0].query).toEqual({ $select: "mail,userPrincipalName" });
    const refused = fakeApi({
      me: () => {
        throw new ProviderError("GET graph.microsoft.com/v1.0/me: 401 InvalidAuthenticationToken", 401);
      },
    });
    await expect(onedrive.identify(refused.api, {})).rejects.toThrow("Microsoft didn't allow access to OneDrive.");
  });
});

const SITE = "example.sharepoint.com,site-1,web-1";
const LIB = "b!lib1";
const LIB_DELTA = `drives/${encodeURIComponent(LIB)}/root/delta?token=${encodeURIComponent("2026-08-04T12:00:00Z")}`;
const LIB_NEXT = "https://graph.microsoft.com/v1.0/drives/b!lib1/root/delta?$deltatoken=s1";
const spFile = (id: string, name: string) => ({ ...file(id, name, "2026-11-01T10:00:00Z"), parentReference: { driveId: LIB }, webUrl: `https://example.sharepoint.com/sites/sales/Shared%20Documents/${name}` });

const sharePointRoutes = {
  sites: () => ({
    value: [
      { id: SITE, displayName: "Sales", webUrl: "https://example.sharepoint.com/sites/sales" },
      { id: "personal-site", displayName: "Jash Doshi", webUrl: "https://example-my.sharepoint.com/personal/jash_example_com" },
    ],
  }),
  [`sites/${encodeURIComponent(SITE)}/drives`]: () => ({
    value: [
      { id: LIB, name: "Documents", driveType: "documentLibrary" },
      { id: "b!other", name: "Jash's files", driveType: "business" },
    ],
  }),
  [LIB_DELTA]: () => ({
    value: [spFile("s1", "Pricing.docx"), spFile("s2", "Handbook.docx"), spFile("s3", "Board deck notes.docx"), spFile("s4", "Hiring plan.docx")],
    "@odata.deltaLink": LIB_NEXT,
  }),
  ...Object.fromEntries(["s1", "s2", "s3", "s4"].map((id) => [content(LIB, id), () => docx("Text")])),
  [permissions(LIB, "s1")]: () => ({ value: [{ roles: ["read"], link: { scope: "organization", type: "view" } }] }),
  [permissions(LIB, "s2")]: () => ({
    value: [{ roles: ["read"], grantedToV2: { siteUser: { id: "11", displayName: "Everyone except external users", loginName: "c:0-.f|rolemanager|spo-grid-all-users/tenant-id" } } }],
  }),
  [permissions(LIB, "s3")]: () => ({
    value: [
      { roles: ["write"], grantedToV2: { siteGroup: { id: "5", displayName: "Sales Members", loginName: "Sales Members" } } },
      { roles: ["owner"], grantedToV2: { siteGroup: { id: "3", displayName: "Sales Owners", loginName: "Sales Owners" } } },
      { roles: ["write"], grantedToV2: { user: { displayName: "Priya Nair", email: "priya@example.com" } } },
    ],
  }),
  [permissions(LIB, "s4")]: () => {
    throw new ProviderError("GET graph.microsoft.com/…/permissions: 403 accessDenied", 403);
  },
};

describe("SharePoint", () => {
  it("finds the site libraries and only opens a file to everyone when Graph says the organisation can read it", async () => {
    const { api, calls } = fakeApi(sharePointRoutes);
    const found = await sharepoint.sync!(api, undefined, ctx);

    expect(found.threads!.map((t) => [t.externalId, t.title, t.visibility, t.memberKeys])).toEqual([
      [`${LIB}:s1`, "Pricing.docx", "org", []],
      [`${LIB}:s2`, "Handbook.docx", "org", []],
      // Site groups have no emails to expand: the connecting person and the named people only.
      [`${LIB}:s3`, "Board deck notes.docx", "members", ["email:sumedh@example.com", "email:priya@example.com"]],
      [`${LIB}:s4`, "Hiring plan.docx", "members", ["email:sumedh@example.com"]],
    ]);
    expect(found.threads![0].metadata).toEqual({ mimeType: DOCX, site: "Sales", library: "Documents" });
    expect(found.messages!.map((m) => m.externalId)).toEqual([`${LIB}:s1@2026-11-01T10:00:00Z`, `${LIB}:s2@2026-11-01T10:00:00Z`, `${LIB}:s3@2026-11-01T10:00:00Z`, `${LIB}:s4@2026-11-01T10:00:00Z`]);
    expect(found.versions!.get(`${LIB}:s1`)).toBe(`${LIB}:s1@2026-11-01T10:00:00Z`);
    expect(found.cursor).toEqual({ drives: { [LIB]: { link: LIB_NEXT, syncedAt: NOW.toISOString(), name: "Documents", site: "Sales" } }, discoveredAt: NOW.toISOString() });
    expect(calls[0]).toMatchObject({ path: "sites", query: { search: "*" } });
    // Personal OneDrive sites are left to the OneDrive source.
    expect(calls.some((c) => c.path.includes("personal-site"))).toBe(false);
  });

  it("follows each library's delta link and looks for new sites only once a day", async () => {
    const { api, calls } = fakeApi({ ...sharePointRoutes, [LIB_NEXT]: () => ({ value: [], "@odata.deltaLink": `${LIB_NEXT}2` }) });
    const cursor = { drives: { [LIB]: { link: LIB_NEXT, syncedAt: "2026-11-02T11:45:00Z", name: "Documents", site: "Sales" } }, discoveredAt: "2026-11-02T06:00:00Z" };
    const found = await sharepoint.sync!(api, cursor, ctx);
    expect(calls.map((c) => c.path)).toEqual([LIB_NEXT]);
    expect(found.cursor).toEqual({ drives: { [LIB]: { link: `${LIB_NEXT}2`, syncedAt: NOW.toISOString(), name: "Documents", site: "Sales" } }, discoveredAt: "2026-11-02T06:00:00Z" });

    const stale = fakeApi({ ...sharePointRoutes, [LIB_NEXT]: () => ({ value: [], "@odata.deltaLink": `${LIB_NEXT}2` }) });
    await sharepoint.sync!(stale.api, { ...cursor, discoveredAt: "2026-11-01T06:00:00Z" }, ctx);
    expect(stale.calls.map((c) => c.path)).toEqual(["sites", `sites/${encodeURIComponent(SITE)}/drives`, LIB_NEXT]);
  });

  it("identifies the account", async () => {
    const { api } = fakeApi({ me: () => ({ mail: null, userPrincipalName: "Sumedh@Example.onmicrosoft.com" }) });
    expect(await sharepoint.identify(api, {})).toEqual({ accountId: "sumedh@example.onmicrosoft.com", label: "sumedh@example.onmicrosoft.com" });
  });
});
