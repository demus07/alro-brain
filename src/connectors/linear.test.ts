import { describe, expect, it } from "vitest";
import { ProviderError, type Api } from "./api";
import { fetchLinear, linear } from "./linear";

/** A provider API answered from a table of paths; records every call. */
function fakeApi(routes: Record<string, (q: Record<string, unknown>, body?: unknown) => unknown>) {
  const calls: { path: string; query: Record<string, unknown>; body?: unknown }[] = [];
  const api: Api = async (_method, path, opts = {}) => {
    const query = opts.query ?? {};
    calls.push({ path, query, body: opts.body });
    const route = Object.keys(routes).find((r) => (r.endsWith("*") ? path.startsWith(r.slice(0, -1)) : path === r));
    if (!route) throw new ProviderError(`no route for ${path}`, 404);
    return routes[route](query, opts.body) as never;
  };
  return { api, calls };
}

type Gql = { query: string; variables: Record<string, unknown> };

/** Linear's one endpoint, answered per named query. */
function linearApi(answers: Record<string, (variables: Record<string, unknown>) => unknown>) {
  const { api, calls } = fakeApi({
    graphql: (_q, body) => {
      const { query, variables } = body as Gql;
      const name = query.match(/^query (\w+)/)![1];
      if (!answers[name]) throw new ProviderError(`no answer for ${name}`, 400);
      return { data: answers[name](variables) };
    },
  });
  const sent = (name: string) => calls.map((c) => c.body as Gql).filter((b) => b.query.startsWith(`query ${name}`)).map((b) => b.variables);
  return { api, sent };
}

const NOW = new Date("2026-11-02T12:00:00Z");
const sumedh = { id: "u1", name: "Sumedh Kudav", email: "Sumedh@example.com" };
const jash = { id: "u2", name: "Jash Doshi", email: "jash@example.com" };
const end = { hasNextPage: false, endCursor: null };

const issue = (over: Record<string, unknown>) => ({
  id: "i1",
  identifier: "ENG-123",
  title: "Fix login",
  description: "Login fails on Safari.",
  url: "https://linear.app/alro/issue/ENG-123",
  createdAt: "2026-10-20T09:00:00.000Z",
  updatedAt: "2026-11-01T10:00:00.000Z",
  dueDate: "2026-11-10",
  priorityLabel: "High",
  state: { name: "In Progress" },
  assignee: jash,
  creator: sumedh,
  team: { id: "t1", name: "Engineering" },
  project: { name: "Onboarding" },
  labels: { nodes: [{ name: "bug" }, { name: "auth" }] },
  comments: { nodes: [], pageInfo: end },
  ...over,
});

const answers = {
  Teams: () => ({ teams: { nodes: [{ id: "t1", private: false, parent: null }, { id: "t2", private: true, parent: null }, { id: "t3", private: false, parent: { id: "t2" } }], pageInfo: end } }),
  TeamMembers: (v: Record<string, unknown>) => ({ team: { members: { nodes: v.id === "t2" ? [{ ...sumedh, active: true }, { id: "u9", name: "Gone", active: false }] : [{ ...jash, active: true }], pageInfo: end } } }),
  Issues: () => ({
    issues: {
      nodes: [
        issue({
          comments: {
            // Linear returns the newest comment first.
            nodes: [
              { id: "c2", body: "Shipping the fix today", url: "https://linear.app/alro/issue/ENG-123#comment-c2", createdAt: "2026-11-01T10:00:00.000Z", user: jash, parent: { id: "c1" } },
              { id: "c1", body: "Reproduced on Safari 18", url: "https://linear.app/alro/issue/ENG-123#comment-c1", createdAt: "2026-10-31T08:00:00.000Z", user: sumedh, parent: null },
            ],
            pageInfo: end,
          },
        }),
        issue({ id: "i2", identifier: "HR-4", title: "Offer for Priya", description: null, team: { id: "t3", name: "Hiring" }, assignee: null, labels: { nodes: [] }, dueDate: null, project: null, priorityLabel: "No priority" }),
      ],
      pageInfo: end,
    },
  }),
};

describe("Linear", () => {
  it("maps issues and comments into document threads, with private teams kept to their members", async () => {
    const { api, sent } = linearApi(answers);
    const { people, threads, messages, versions, cursor } = await fetchLinear(api, {}, NOW);

    expect(threads).toEqual([
      { externalId: "i1", kind: "doc", title: "ENG-123 Fix login", url: "https://linear.app/alro/issue/ENG-123", visibility: "org", memberKeys: [] },
      // t3 sits inside private t2: its own members plus t2's active ones.
      { externalId: "i2", kind: "doc", title: "HR-4 Offer for Priya", url: "https://linear.app/alro/issue/ENG-123", visibility: "members", memberKeys: ["linear:u2", "linear:u1"] },
    ]);
    expect(messages!.map((m) => [m.threadExternalId, m.externalId, m.kind, m.authorKey])).toEqual([
      ["i1", "i1@2026-11-01T10:00:00.000Z", "note", "linear:u1"],
      ["i1", "c1", "chat", "linear:u1"],
      ["i1", "c2", "chat", "linear:u2"],
      ["i2", "i2@2026-11-01T10:00:00.000Z", "note", "linear:u1"],
    ]);
    expect(messages![0].text).toBe(
      "ENG-123 Fix login\nStatus: In Progress\nAssignee: Jash Doshi\nPriority: High\nLabels: bug, auth\nDue: 2026-11-10\nProject: Onboarding\nTeam: Engineering\nCreated: 2026-10-20\n\nLogin fails on Safari.",
    );
    expect(messages![2]).toMatchObject({ text: "Shipping the fix today", replyToExternalId: "c1", sentAt: new Date("2026-11-01T10:00:00.000Z"), url: "https://linear.app/alro/issue/ENG-123#comment-c2" });
    expect(messages![3].text).toBe("HR-4 Offer for Priya\nStatus: In Progress\nTeam: Hiring\nCreated: 2026-10-20");
    expect(versions!.get("i1")).toBe("i1@2026-11-01T10:00:00.000Z");
    expect(people!.find((p) => p.key === "linear:u1")).toEqual({ key: "linear:u1", provider: "linear", externalId: "u1", displayName: "Sumedh Kudav", email: "sumedh@example.com" });
    expect(people!.some((p) => p.key === "linear:u9")).toBe(false);

    expect(sent("Issues")[0]).toEqual({ first: 25, after: undefined, filter: { updatedAt: { gt: "2026-08-04T12:00:00.000Z" } } });
    expect(cursor).toEqual({ since: "2026-11-02T11:50:00.000Z" });
  });

  it("asks only for issues updated since the cursor", async () => {
    const { api, sent } = linearApi(answers);
    await fetchLinear(api, { since: "2026-11-02T11:50:00.000Z" }, new Date("2026-11-02T12:15:00Z"));
    expect(sent("Issues")[0].filter).toEqual({ updatedAt: { gt: "2026-11-02T11:50:00.000Z" } });
  });

  it("stops at the cap and continues the same pass on the next sync", async () => {
    const capped = linearApi({ ...answers, Issues: (v) => ({ issues: { nodes: [issue({ id: `i-${v.after ?? "first"}` })], pageInfo: { hasNextPage: true, endCursor: `after-${v.after ?? "first"}` } } }) });
    const first = await fetchLinear(capped.api, {}, NOW);
    expect(first.threads).toHaveLength(20);
    expect(first.cursor).toMatchObject({ since: "2026-08-04T12:00:00.000Z", started: NOW.toISOString() });
    expect(String(first.cursor.after)).toMatch(/^after-/);

    const rest = linearApi(answers);
    const second = await fetchLinear(rest.api, first.cursor, new Date("2026-11-02T12:15:00Z"));
    expect(rest.sent("Issues")[0]).toMatchObject({ after: first.cursor.after, filter: { updatedAt: { gt: "2026-08-04T12:00:00.000Z" } } });
    // The next pass starts from when this one began, less the overlap.
    expect(second.cursor).toEqual({ since: "2026-11-02T11:50:00.000Z" });
  });

  it("reads further pages of a long comment list", async () => {
    const { api, sent } = linearApi({
      ...answers,
      Issues: () => ({ issues: { nodes: [issue({ comments: { nodes: [{ id: "c2", body: "second", createdAt: "2026-11-01T09:00:00.000Z", user: jash }], pageInfo: { hasNextPage: true, endCursor: "c2" } } })], pageInfo: end } }),
      IssueComments: () => ({ issue: { comments: { nodes: [{ id: "c1", body: "first", createdAt: "2026-11-01T08:00:00.000Z", user: sumedh }], pageInfo: end } } }),
    });
    const { messages } = await fetchLinear(api, {}, NOW);
    expect(messages!.slice(1).map((m) => m.text)).toEqual(["first", "second"]);
    expect(sent("IssueComments")).toEqual([{ id: "i1", after: "c2" }]);
  });

  it("names the workspace, and says so plainly when the key is refused", async () => {
    const ok = linearApi({ Account: () => ({ viewer: { id: "u1", name: "Sumedh Kudav" }, organization: { id: "org1", name: "ALRO", urlKey: "alro" } }) });
    expect(await linear.identify(ok.api, {})).toEqual({ accountId: "linear:org1", label: "ALRO" });

    const refused: Api = async () => {
      throw new ProviderError("POST api.linear.app/graphql: 401", 401);
    };
    await expect(linear.identify(refused, {})).rejects.toThrow("Linear didn't accept that API key");
  });
});
