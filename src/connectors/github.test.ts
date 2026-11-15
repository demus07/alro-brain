import { describe, expect, it } from "vitest";
import { ProviderError, type Api } from "./api";
import { fetchGithub, github } from "./github";

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
const sumedh = { id: 1, login: "sumedhk", type: "User" };
const jash = { id: 2, login: "jashd", type: "User" };
const ci = { id: 9, login: "vercel[bot]", type: "Bot" };

const issue = {
  id: 1001,
  number: 12,
  title: "Fix login",
  body: "Login fails on Safari.",
  html_url: "https://github.com/alro/brain/issues/12",
  state: "closed",
  state_reason: "completed",
  user: sumedh,
  assignees: [jash],
  labels: [{ name: "bug" }, "auth"],
  milestone: { title: "v1", due_on: "2026-11-10T08:00:00Z" },
  comments: 2,
  created_at: "2026-10-20T09:00:00Z",
  updated_at: "2026-11-01T10:00:00Z",
};
const pull = {
  id: 1002,
  number: 13,
  title: "Safari cookie fix",
  body: null,
  html_url: "https://github.com/alro/brain/pull/13",
  state: "closed",
  user: jash,
  assignees: [],
  labels: [],
  milestone: null,
  comments: 0,
  created_at: "2026-10-30T09:00:00Z",
  updated_at: "2026-11-01T11:00:00Z",
  pull_request: { merged_at: "2026-11-01T11:00:00Z" },
};
const secret = { ...issue, id: 2001, number: 3, title: "Rotate keys", html_url: "https://github.com/alro/infra/issues/3", comments: 0, assignees: [], labels: [], milestone: null, state: "open", state_reason: null };

const routes = {
  user: () => ({ id: 1, login: "sumedhk", name: "Sumedh Kudav" }),
  "user/repos": () => [
    { id: 10, name: "brain", full_name: "alro/brain", private: false, visibility: "public" },
    { id: 11, name: "infra", full_name: "alro/infra", private: true, visibility: "private" },
    { id: 12, name: "vault", full_name: "alro/vault", private: true, visibility: "private" },
  ],
  "repos/alro/brain/issues": () => [issue, pull],
  "repos/alro/brain/issues/12/comments": () => [
    { id: 501, body: "Reproduced on Safari 18", html_url: "https://github.com/alro/brain/issues/12#issuecomment-501", user: jash, created_at: "2026-10-31T08:00:00Z", updated_at: "2026-10-31T08:00:00Z" },
    { id: 502, body: "Preview deployed", html_url: "https://github.com/alro/brain/issues/12#issuecomment-502", user: ci, created_at: "2026-10-31T09:00:00Z", updated_at: "2026-10-31T09:00:00Z" },
    { id: 503, body: "Fixed in #13", html_url: "https://github.com/alro/brain/issues/12#issuecomment-503", user: sumedh, created_at: "2026-11-01T10:00:00Z", updated_at: "2026-11-01T10:05:00Z" },
  ],
  "repos/alro/infra/issues": () => [secret],
  "repos/alro/infra/collaborators": () => [sumedh, jash],
  "repos/alro/vault/issues": () => [{ ...secret, id: 3001, title: "Hidden" }],
  "repos/alro/vault/collaborators": () => {
    throw new ProviderError("GET api.github.com/repos/alro/vault/collaborators: 403 Must have push access to view repository collaborators.", 403);
  },
  "users/sumedhk": () => ({ login: "sumedhk", name: "Sumedh Kudav", email: "Sumedh@example.com" }),
  "users/jashd": () => ({ login: "jashd", name: null, email: null }),
};

describe("GitHub", () => {
  it("maps issues, pull requests and comments into document threads; private repos go to their collaborators", async () => {
    const { api, calls } = fakeApi(routes);
    const { people, threads, messages, versions, cursor } = await fetchGithub(api, {}, NOW);

    expect(threads).toEqual([
      { externalId: "1001", kind: "doc", title: "brain#12 Fix login", url: "https://github.com/alro/brain/issues/12", visibility: "org", memberKeys: [] },
      { externalId: "1002", kind: "doc", title: "brain#13 Safari cookie fix", url: "https://github.com/alro/brain/pull/13", visibility: "org", memberKeys: [] },
      // alro/vault is private and its collaborators can't be listed, so it is left out.
      { externalId: "2001", kind: "doc", title: "infra#3 Rotate keys", url: "https://github.com/alro/infra/issues/3", visibility: "members", memberKeys: ["github:1", "github:2"] },
    ]);
    expect(messages!.map((m) => [m.threadExternalId, m.externalId, m.kind, m.authorKey])).toEqual([
      ["1001", "1001@2026-11-01T10:00:00Z", "note", "github:1"],
      ["1001", "501", "chat", "github:2"],
      ["1001", "503", "chat", "github:1"],
      ["1002", "1002@2026-11-01T11:00:00Z", "note", "github:2"],
      ["2001", "2001@2026-11-01T10:00:00Z", "note", "github:1"],
    ]);
    expect(messages![0].text).toBe(
      "brain#12 Fix login\nRepo: alro/brain\nType: Issue\nStatus: closed (completed)\nAssignee: jashd\nLabels: bug, auth\nMilestone: v1\nDue: 2026-11-10\nCreated: 2026-10-20\n\nLogin fails on Safari.",
    );
    expect(messages![2]).toMatchObject({ text: "Fixed in #13", sentAt: new Date("2026-11-01T10:00:00Z"), editedAt: new Date("2026-11-01T10:05:00Z"), url: "https://github.com/alro/brain/issues/12#issuecomment-503" });
    expect(messages![3].text).toBe("brain#13 Safari cookie fix\nRepo: alro/brain\nType: Pull request\nStatus: merged\nCreated: 2026-10-30");
    expect(versions!.get("1001")).toBe("1001@2026-11-01T10:00:00Z");
    expect(people).toEqual([
      { key: "github:1", provider: "github", externalId: "1", displayName: "Sumedh Kudav", email: "sumedh@example.com" },
      { key: "github:2", provider: "github", externalId: "2", displayName: "jashd", email: undefined },
    ]);

    expect(calls.find((c) => c.path === "repos/alro/brain/issues")!.query).toMatchObject({ state: "all", since: "2026-08-04T12:00:00Z", sort: "updated", direction: "asc" });
    // Each repo resumes just after its last item; the skipped repo keeps no cursor and is tried again.
    expect(cursor).toEqual({ since: { "10": "2026-11-01T11:00:01Z", "11": "2026-11-01T10:00:01Z" } });
  });

  it("asks each repository only for what changed since its cursor", async () => {
    const { api, calls } = fakeApi({ ...routes, "repos/alro/brain/issues": () => [], "repos/alro/infra/issues": () => [{ ...secret, updated_at: "2026-11-02T12:14:30Z" }] });
    const { cursor } = await fetchGithub(api, { since: { "10": "2026-11-01T11:00:01Z", "11": "2026-11-01T10:00:01Z" } }, new Date("2026-11-02T12:15:00Z"));
    expect(calls.find((c) => c.path === "repos/alro/brain/issues")!.query.since).toBe("2026-11-01T11:00:01Z");
    expect(calls.find((c) => c.path === "repos/alro/infra/issues")!.query.since).toBe("2026-11-01T10:00:01Z");
    // Nothing new keeps the cursor; something changed seconds ago is re-read next time (2 minute overlap).
    expect(cursor).toEqual({ since: { "10": "2026-11-01T11:00:01Z", "11": "2026-11-02T12:13:00Z" } });
  });

  it("stops at 500 items and continues that repository from the last one read", async () => {
    const at = (i: number) => new Date(Date.parse("2026-10-01T00:00:00Z") + i * 60_000).toISOString().replace(".000Z", "Z");
    const many = Array.from({ length: 600 }, (_, i) => ({ ...secret, id: 5000 + i, number: i + 1, updated_at: at(i) }));
    const { api, calls } = fakeApi({
      ...routes,
      "user/repos": () => [{ id: 10, name: "brain", full_name: "alro/brain", private: false }, { id: 13, name: "site", full_name: "alro/site", private: false }],
      "repos/alro/brain/issues": (q) => many.slice((Number(q.page) - 1) * 100, Number(q.page) * 100),
    });
    const { threads, cursor } = await fetchGithub(api, {}, NOW);
    expect(threads).toHaveLength(500);
    // One second before the last item read, in case others share its timestamp.
    expect(at(499)).toBe("2026-10-01T08:19:00Z");
    expect(cursor).toEqual({ since: { "10": "2026-10-01T08:18:59Z" } });
    expect(calls.some((c) => c.path === "repos/alro/site/issues")).toBe(false);
  });

  it("fails loudly when the token can't read issues anywhere", async () => {
    const denied = () => {
      throw new ProviderError("GET api.github.com/repos/…/issues: 403 Resource not accessible by personal access token", 403);
    };
    const { api } = fakeApi({ ...routes, "repos/alro/brain/issues": denied, "repos/alro/infra/issues": denied, "repos/alro/vault/issues": denied });
    await expect(fetchGithub(api, {}, NOW)).rejects.toThrow("read access to Issues and Pull requests");
  });

  it("reports a rate limit as temporary, not as a refused token", async () => {
    const { api } = fakeApi({
      ...routes,
      "repos/alro/brain/issues": () => {
        throw new ProviderError("GET api.github.com/repos/alro/brain/issues: 403 API rate limit exceeded", 403);
      },
    });
    await expect(fetchGithub(api, {}, NOW)).rejects.toMatchObject({ status: 429 });
  });

  it("names the account, and says so plainly when the token is refused", async () => {
    const { api } = fakeApi(routes);
    expect(await github.identify(api, {})).toEqual({ accountId: "github:1", label: "Sumedh Kudav (sumedhk)" });

    const refused: Api = async () => {
      throw new ProviderError("GET api.github.com/user: 401 Bad credentials", 401);
    };
    await expect(github.identify(refused, {})).rejects.toThrow("GitHub didn't accept that token");
  });
});
