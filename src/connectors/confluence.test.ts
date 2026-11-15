import { describe, expect, it } from "vitest";
import { ProviderError, type Api } from "./api";
import { confluence, fetchConfluence, storageToText } from "./confluence";

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
const BASE = "https://acme.atlassian.net/wiki";

const page = (id: string, edited: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  status: "current",
  title,
  spaceId: "1",
  parentId: null,
  authorId: "a1",
  version: { createdAt: edited, authorId: "a2", number: 3 },
  body: { storage: { representation: "storage", value: `<h2>Plans</h2><p>${title} is &#8377;55k per site &amp; rising.</p>` } },
  _links: { webui: `/spaces/ENG/pages/${id}/${title}` },
  ...extra,
});

const routes = {
  "wiki/api/v2/pages": () => ({
    results: [
      page("p5", "2026-11-01T10:00:00.000Z", "Pricing", { parentId: "p0" }),
      page("p4", "2026-10-30T10:00:00.000Z", "Layoffs", { parentId: "secret" }),
      page("p3", "2026-10-29T10:00:00.000Z", "Board notes"),
      page("p2", "2026-10-28T10:00:00.000Z", "My drafts", { spaceId: "2" }),
      page("p1", "2026-10-27T10:00:00.000Z", "Empty", { body: { storage: { value: "<p> </p>" } } }),
    ],
    _links: { base: BASE },
  }),
  "wiki/api/v2/spaces": () => ({ results: [{ id: "1", key: "ENG", name: "Engineering", type: "global" }, { id: "2", key: "~a2", name: "Jash", type: "personal" }] }),
  "wiki/api/v2/users-bulk": (_q: Record<string, unknown>, body: unknown) => ({
    results: (body as { accountIds: string[] }).accountIds.includes("a2") ? [{ accountId: "a2", displayName: "Jash Doshi", email: "Jash@Example.com", accountType: "atlassian" }] : [],
  }),
  "wiki/api/v2/pages/p5/restriction-state": () => ({ state: "EDIT_RESTRICTED" }),
  "wiki/api/v2/pages/p4/restriction-state": () => ({ state: "OPEN" }),
  "wiki/api/v2/pages/p3/restriction-state": () => ({ state: "VIEW_RESTRICTED" }),
  "wiki/api/v2/pages/p0/restriction-state": () => ({ state: "OPEN" }),
  "wiki/api/v2/pages/secret/restriction-state": () => ({ state: "VIEW_RESTRICTED" }),
  "wiki/api/v2/folders/f1/restriction-state": () => ({ state: "OPEN" }),
  "wiki/api/v2/pages/p5/ancestors": () => ({ results: [{ id: "f1", type: "folder" }, { id: "p0", type: "page" }] }),
  "wiki/api/v2/pages/p4/ancestors": () => ({ results: [{ id: "secret", type: "page" }] }),
};

describe("Confluence", () => {
  it("reads pages as versioned documents on the first sync; leaves out restricted pages and personal spaces", async () => {
    const { api, calls } = fakeApi(routes);
    const r = await fetchConfluence(api, SITE, undefined, NOW);

    expect(r.threads).toEqual([
      { externalId: "p5", kind: "doc", title: "Pricing", url: `${BASE}/spaces/ENG/pages/p5/Pricing`, visibility: "org", memberKeys: [], metadata: { space: "Engineering" } },
    ]);
    expect(r.messages).toHaveLength(1);
    expect(r.messages![0]).toMatchObject({ threadExternalId: "p5", externalId: "p5@2026-11-01T10:00:00.000Z", kind: "note", authorKey: "confluence:a2", subject: "Pricing", text: "## Plans\nPricing is ₹55k per site & rising." });
    expect(r.messages![0].sentAt.toISOString()).toBe("2026-11-01T10:00:00.000Z");
    expect(r.versions!.get("p5")).toBe("p5@2026-11-01T10:00:00.000Z");
    expect(r.people).toEqual([{ key: "confluence:a2", provider: "confluence", externalId: "a2", displayName: "Jash Doshi", email: "jash@example.com" }]);
    expect(r.cursor).toEqual({ since: "2026-11-02T11:50:00.000Z" });

    expect(calls[0]).toEqual({ path: "wiki/api/v2/pages", query: { sort: "-modified-date", status: "current", "body-format": "storage", limit: 50, cursor: undefined } });
    expect(calls.find((c) => c.path === "wiki/api/v2/spaces")!.query.ids).toBe("1,2");
  });

  it("stops at pages edited before the cursor instead of reading on", async () => {
    const { api, calls } = fakeApi({ ...routes, "wiki/api/v2/pages": () => ({ ...routes["wiki/api/v2/pages"](), _links: { base: BASE, next: "/wiki/api/v2/pages?cursor=abc&limit=50" } }) });
    const r = await fetchConfluence(api, SITE, { since: "2026-10-31T00:00:00.000Z" }, NOW);
    expect(r.threads!.map((t) => t.externalId)).toEqual(["p5"]);
    expect(calls.filter((c) => c.path === "wiki/api/v2/pages")).toHaveLength(1);
    expect(calls.some((c) => c.path.startsWith("wiki/api/v2/pages/p4"))).toBe(false);
    expect(r.cursor).toEqual({ since: "2026-11-02T11:50:00.000Z" });
  });

  it("stops at the cap and continues the same pass from the saved marker", async () => {
    const batch = (from: number) => Array.from({ length: 50 }, (_, i) => page(`n${from + i}`, "2026-11-01T10:00:00.000Z", `Page ${from + i}`));
    const { api } = fakeApi({
      ...routes,
      "wiki/api/v2/pages": (q) => ({ results: batch(Number(q.cursor ?? 0)), _links: { base: BASE, next: `/wiki/api/v2/pages?cursor=${Number(q.cursor ?? 0) + 50}&limit=50` } }),
      "wiki/api/v2/pages/*": () => ({ state: "OPEN" }),
    });
    const first = await fetchConfluence(api, SITE, { since: "2026-10-01T00:00:00.000Z" }, NOW);
    expect(first.threads).toHaveLength(200);
    expect(first.cursor).toEqual({ since: "2026-10-01T00:00:00.000Z", started: NOW.toISOString(), after: "200" });

    const resumed = fakeApi({ "wiki/api/v2/pages": () => ({ results: [], _links: { base: BASE } }) });
    const second = await fetchConfluence(resumed.api, SITE, first.cursor, new Date("2026-11-02T13:00:00Z"));
    expect(resumed.calls[0].query.cursor).toBe("200");
    expect(second.cursor).toEqual({ since: "2026-11-02T11:50:00.000Z" });
  });

  it("reduces storage format to plain text", () => {
    const text = storageToText(
      [
        "<h1>Launch&nbsp;plan</h1>",
        '<p>Owner: <ac:link><ri:user ri:account-id="a1" /></ac:link> see <ac:link><ri:page ri:content-title="Pricing" /></ac:link> and <a href="https://example.com">the site</a>.</p>',
        "<ul><li><p>Ship <strong>v2</strong></p></li><li>Tell customers</li></ul>",
        "<ac:task-list><ac:task><ac:task-id>1</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body>Book venue</ac:task-body></ac:task></ac:task-list>",
        "<table><tbody><tr><th>Plan</th><th>Price</th></tr><tr><td>Pro</td><td>&#x20B9;55k</td></tr></tbody></table>",
        '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">ts</ac:parameter><ac:plain-text-body><![CDATA[if (a < b && c) run();]]></ac:plain-text-body></ac:structured-macro>',
      ].join(""),
    );
    expect(text).toBe("# Launch plan\nOwner: see Pricing and the site.\n- Ship v2\n- Tell customers\n- [x] Book venue\nPlan | Price\nPro | ₹55k\nif (a < b && c) run();");
  });

  it("identifies the site and explains a refused token", async () => {
    const credentials = { site: "acme", email: "s@example.com", token: "t" };
    const ok = fakeApi({ "wiki/rest/api/user/current": () => ({ accountId: "a1", type: "known", displayName: "Sumedh Kudav" }) });
    expect(await confluence.identify(ok.api, credentials)).toEqual({ accountId: "confluence:acme.atlassian.net", label: "acme.atlassian.net" });
    expect(ok.calls.map((c) => c.path)).toEqual(["wiki/rest/api/user/current"]);

    const anonymous = fakeApi({ "wiki/rest/api/user/current": () => ({ type: "anonymous" }) });
    await expect(confluence.identify(anonymous.api, credentials)).rejects.toThrow("Confluence didn't accept that email and API token.");
    const refused: Api = async () => {
      throw new ProviderError("401", 401);
    };
    await expect(confluence.identify(refused, credentials)).rejects.toThrow("Confluence didn't accept that email and API token.");
  });
});
