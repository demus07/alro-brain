import { describe, expect, it } from "vitest";
import { ProviderError, type Api } from "./api";
import { adfToText, fetchJira, jira, type Adf } from "./jira";

/** A provider API answered from a table of paths; records every call. */
function fakeApi(routes: Record<string, (q: Record<string, unknown>, body?: unknown) => unknown>) {
  const calls: { path: string; query: Record<string, unknown> }[] = [];
  const api: Api = async (_method, path, opts = {}) => {
    const query = opts.query ?? {};
    calls.push({ path, query });
    const route = Object.keys(routes).find((r) => (r.endsWith("*") ? path.startsWith(r.slice(0, -1)) : path === r));
    if (!route) throw new ProviderError(`no route for ${path}`, 404);
    return routes[route](query, opts.body) as never;
  };
  return { api, calls };
}

const NOW = new Date("2026-11-02T12:00:00Z");
const SITE = "acme.atlassian.net";
const p = (text: string): Adf => ({ type: "paragraph", content: [{ type: "text", text }] });
const doc = (...content: Adf[]): Adf => ({ type: "doc", content });
const sumedh = { accountId: "a1", displayName: "Sumedh Kudav", emailAddress: "Sumedh@Example.com", accountType: "atlassian" };
const jash = { accountId: "a2", displayName: "Jash Doshi", accountType: "atlassian" };
const comment = (id: string, author: unknown, text: string, created: string, extra = {}) => ({ id, author, body: doc(p(text)), created, updated: created, ...extra });

const issue = (id: string, key: string, summary: string, extra: Record<string, unknown> = {}) => ({
  id,
  key,
  fields: {
    summary,
    description: doc(p("Login fails when SSO is on.")),
    status: { name: "In Progress" },
    issuetype: { name: "Bug" },
    assignee: jash,
    reporter: sumedh,
    priority: { name: "High" },
    labels: ["auth", "customer"],
    duedate: "2026-11-20",
    project: { id: "100", key: "ENG", name: "Engineering" },
    security: null,
    created: "2026-10-30T09:00:00.000+0000",
    updated: "2026-11-01T10:00:00.000+0000",
    comment: { comments: [], total: 0 },
    ...extra,
  },
});

const routes = {
  "rest/api/3/search/jql": () => ({
    issues: [
      issue("10001", "ENG-123", "Fix login", {
        comment: {
          total: 3,
          comments: [
            comment("201", jash, "Reproduced on staging.", "2026-10-31T08:00:00.000+0000"),
            comment("202", sumedh, "Admins only: customer is threatening to churn.", "2026-10-31T09:00:00.000+0000", { visibility: { type: "role", value: "Administrators" } }),
            comment("203", { accountId: "bot", displayName: "Automation", accountType: "app" }, "Linked to PR 88.", "2026-11-01T10:00:00.000+0000"),
          ],
        },
      }),
      issue("10002", "ENG-124", "Salary review", { security: { id: "7", name: "HR only" } }),
      issue("10003", "OPS-9", "Rotate keys", { project: { id: "200", key: "OPS", name: "Ops" } }),
    ],
    isLast: true,
  }),
  "rest/api/3/project/100": () => ({ id: "100", isPrivate: false }),
  "rest/api/3/project/200": () => ({ id: "200", isPrivate: true }),
};

describe("Jira", () => {
  it("maps an issue and its comments on the first sync; leaves out restricted issues, projects and comments", async () => {
    const { api, calls } = fakeApi(routes);
    const r = await fetchJira(api, SITE, undefined, NOW);

    expect(r.threads).toEqual([{ externalId: "10001", kind: "doc", title: "ENG-123 Fix login", url: "https://acme.atlassian.net/browse/ENG-123", visibility: "org", memberKeys: [] }]);
    const [note, ...comments] = r.messages!;
    expect(note).toMatchObject({ threadExternalId: "10001", externalId: "10001@2026-11-01T10:00:00.000+0000", kind: "note", authorKey: "jira:a1", subject: "ENG-123 Fix login" });
    expect(note.sentAt.toISOString()).toBe("2026-11-01T10:00:00.000Z");
    expect(note.text).toBe(
      "ENG-123 Fix login\nStatus: In Progress\nType: Bug\nAssignee: Jash Doshi\nReporter: Sumedh Kudav\nPriority: High\nLabels: auth, customer\nDue: 2026-11-20\nProject: Engineering\nCreated: 2026-10-30\n\nLogin fails when SSO is on.",
    );
    expect(r.versions!.get("10001")).toBe(note.externalId);
    expect(comments.map((m) => [m.externalId, m.kind, m.authorKey, m.text])).toEqual([
      ["201", "chat", "jira:a2", "Reproduced on staging."],
      ["203", "chat", undefined, "Linked to PR 88."],
    ]);
    expect(comments[0].url).toBe("https://acme.atlassian.net/browse/ENG-123?focusedCommentId=201");
    expect(r.people).toEqual([
      { key: "jira:a2", provider: "jira", externalId: "a2", displayName: "Jash Doshi", email: undefined },
      { key: "jira:a1", provider: "jira", externalId: "a1", displayName: "Sumedh Kudav", email: "sumedh@example.com" },
    ]);

    const search = calls.find((c) => c.path === "rest/api/3/search/jql")!;
    expect(search.query.jql).toBe(`updated >= ${Date.parse("2026-08-04T12:00:00Z")} ORDER BY updated ASC`);
    expect(r.cursor).toEqual({ since: "2026-11-02T11:50:00.000Z" });
  });

  it("asks only for issues updated since the cursor", async () => {
    const { api, calls } = fakeApi({ "rest/api/3/search/jql": () => ({ issues: [], isLast: true }) });
    const r = await fetchJira(api, SITE, { since: "2026-11-01T00:00:00.000Z" }, NOW);
    expect(calls[0].query.jql).toBe(`updated >= ${Date.parse("2026-11-01T00:00:00.000Z")} ORDER BY updated ASC`);
    expect(calls[0].query.nextPageToken).toBeUndefined();
    expect(r.cursor).toEqual({ since: "2026-11-02T11:50:00.000Z" });
  });

  it("stops at the cap and continues the same pass from the saved page", async () => {
    const page = (from: number) => Array.from({ length: 100 }, (_, i) => issue(String(from + i), `ENG-${from + i}`, `Task ${from + i}`));
    const { api, calls } = fakeApi({
      "rest/api/3/search/jql": (q) => ({ issues: page(q.nextPageToken ? Number(q.nextPageToken) : 0), nextPageToken: String((q.nextPageToken ? Number(q.nextPageToken) : 0) + 100) }),
      "rest/api/3/project/100": () => ({ isPrivate: false }),
    });
    const first = await fetchJira(api, SITE, { since: "2026-10-01T00:00:00.000Z" }, NOW);
    expect(first.threads).toHaveLength(500);
    expect(first.cursor).toEqual({ since: "2026-10-01T00:00:00.000Z", started: NOW.toISOString(), next: "500" });
    expect(calls.filter((c) => c.path === "rest/api/3/project/100")).toHaveLength(1);

    const later = new Date("2026-11-02T13:00:00Z");
    const resumed = fakeApi({ "rest/api/3/search/jql": () => ({ issues: [], isLast: true }) });
    const second = await fetchJira(resumed.api, SITE, first.cursor, later);
    expect(resumed.calls[0].query).toMatchObject({ nextPageToken: "500", jql: `updated >= ${Date.parse("2026-10-01T00:00:00.000Z")} ORDER BY updated ASC` });
    expect(second.cursor).toEqual({ since: "2026-11-02T11:50:00.000Z" });
  });

  it("starts the pass again when the saved page token is refused", async () => {
    const { api, calls } = fakeApi({
      "rest/api/3/search/jql": (q) => {
        if (q.nextPageToken) throw new ProviderError("expired token", 400);
        return { issues: [], isLast: true };
      },
    });
    const later = new Date("2026-11-12T12:00:00Z");
    const r = await fetchJira(api, SITE, { since: "2026-10-01T00:00:00.000Z", started: NOW.toISOString(), next: "500" }, later);
    expect(calls.map((c) => c.query.nextPageToken)).toEqual(["500", undefined]);
    expect(r.cursor).toEqual({ since: "2026-11-12T11:50:00.000Z" });
  });

  it("reads all comments from the issue when the search result holds only some", async () => {
    const { api, calls } = fakeApi({
      "rest/api/3/search/jql": () => ({ issues: [issue("10001", "ENG-123", "Fix login", { comment: { total: 2, comments: [comment("202", jash, "Second", "2026-10-31T09:00:00.000+0000")] } })], isLast: true }),
      "rest/api/3/project/100": () => ({ isPrivate: false }),
      "rest/api/3/issue/10001/comment": () => ({ total: 2, comments: [comment("201", sumedh, "First", "2026-10-31T08:00:00.000+0000"), comment("202", jash, "Second", "2026-10-31T09:00:00.000+0000")] }),
    });
    const r = await fetchJira(api, SITE, undefined, NOW);
    expect(r.messages!.slice(1).map((m) => m.text)).toEqual(["First", "Second"]);
    expect(calls.find((c) => c.path === "rest/api/3/issue/10001/comment")!.query).toEqual({ startAt: 0, maxResults: 100, orderBy: "created" });
  });

  it("flattens Atlassian Document Format to plain text", () => {
    const text = adfToText(
      doc(
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Steps" }] },
        { type: "paragraph", content: [{ type: "text", text: "Ask " }, { type: "mention", attrs: { id: "a2", text: "@Jash Doshi" } }, { type: "hardBreak" }, { type: "text", text: "then see " }, { type: "inlineCard", attrs: { url: "https://example.com/pr/88" } }] },
        { type: "bulletList", content: [{ type: "listItem", content: [p("Open the app")] }, { type: "listItem", content: [p("Sign in")] }] },
        { type: "taskList", content: [{ type: "taskItem", attrs: { state: "DONE" }, content: [{ type: "text", text: "Ship" }] }] },
        { type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [p("Plan")] }, { type: "tableCell", content: [p("₹55k")] }] }] },
        { type: "codeBlock", content: [{ type: "text", text: "npm test" }] },
      ),
    );
    expect(text).toBe("## Steps\nAsk @Jash Doshi\nthen see https://example.com/pr/88\n- Open the app\n- Sign in\n- [x] Ship\nPlan | ₹55k\nnpm test");
    expect(adfToText(null)).toBe("");
  });

  it("identifies the site and explains a refused token", async () => {
    const credentials = { site: "https://Acme.atlassian.net/jira/", email: "s@example.com", token: "t" };
    const ok = fakeApi({ "rest/api/3/myself": () => ({ accountId: "a1", displayName: "Sumedh Kudav" }) });
    expect(await jira.identify(ok.api, credentials)).toEqual({ accountId: "jira:acme.atlassian.net", label: "acme.atlassian.net" });
    expect(ok.calls.map((c) => c.path)).toEqual(["rest/api/3/myself"]);

    const refused: Api = async () => {
      throw new ProviderError("401", 401);
    };
    await expect(jira.identify(refused, credentials)).rejects.toThrow("Jira didn't accept that email and API token.");
    expect(() => jira.auth.kind === "token" && jira.auth.api({ site: "not a site", email: "s@example.com", token: "t" })).toThrow("Enter your Atlassian site");
  });
});
