import { describe, expect, it } from "vitest";
import { ProviderError, type Api } from "./api";
import { fireflies, speakerTurns } from "./fireflies";

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

const NOW = new Date("2026-11-02T12:00:00Z");
const ctx = { credentials: { apiKey: "k" }, accountId: "sumedh@example.com", now: NOW };
const START = Date.parse("2026-11-01T10:00:00Z");

const transcript = {
  id: "T1",
  title: "Pricing review",
  date: START,
  duration: 32,
  organizer_email: "Sumedh@example.com",
  participants: ["sumedh@example.com", "jash@example.com"],
  transcript_url: "https://app.fireflies.ai/view/T1",
  meeting_attendees: [{ displayName: "Sumedh Kudav", email: "sumedh@example.com" }, { displayName: null, name: "Jash Doshi", email: "jash@example.com" }],
  sentences: [
    { speaker_name: "Sumedh Kudav", text: "Let's settle pricing.", start_time: 1.5, end_time: 3 },
    { speaker_name: "Sumedh Kudav", text: "I'd go with 55k per site.", start_time: 3, end_time: 6 },
    { speaker_name: "Jash Doshi", text: "Works for me.", start_time: "65.2", end_time: "66" },
    { speaker_name: "Guest", text: "  ", start_time: 70, end_time: 71 },
    { speaker_name: "Guest", text: "Send me the deck.", start_time: 72, end_time: 74 },
  ],
};

const routes = (transcripts: unknown[]) => ({
  graphql: (_q: Record<string, unknown>, body?: unknown) =>
    String((body as { query: string }).query).includes("transcripts") ? { data: { transcripts } } : { data: { user: { user_id: "u1", email: "Sumedh@example.com", name: "Sumedh Kudav" } } },
});

describe("Fireflies", () => {
  it("turns each transcript into a meeting thread of speaker turns, visible to its participants", async () => {
    const { api, calls } = fakeApi(routes([transcript, { id: "T0", title: "Still processing", date: START - 3_600_000, sentences: [] }]));
    const found = await fireflies.sync!(api, undefined, ctx);

    expect(found.threads).toEqual([
      {
        externalId: "T1",
        kind: "meeting",
        title: "Pricing review",
        url: "https://app.fireflies.ai/view/T1",
        visibility: "members",
        memberKeys: ["email:sumedh@example.com", "email:jash@example.com", "name:guest"],
        metadata: { startedAt: "2026-11-01T10:00:00.000Z", durationMinutes: 32, participants: ["sumedh@example.com", "jash@example.com"], organizer: "sumedh@example.com" },
      },
    ]);
    expect(found.messages!.map((m) => [m.kind, m.authorKey, m.text, m.sentAt.toISOString()])).toEqual([
      ["transcript", "email:sumedh@example.com", "Let's settle pricing. I'd go with 55k per site.", "2026-11-01T10:00:01.500Z"],
      ["transcript", "email:jash@example.com", "Works for me.", "2026-11-01T10:01:05.200Z"],
      ["transcript", "name:guest", "Send me the deck.", "2026-11-01T10:01:12.000Z"],
    ]);
    expect(found.messages!.map((m) => m.externalId)).toEqual(["T1#1", "T1#2", "T1#3"]);
    expect(found.people).toEqual([
      { key: "email:sumedh@example.com", provider: "email", externalId: "sumedh@example.com", displayName: "Sumedh Kudav", email: "sumedh@example.com" },
      { key: "email:jash@example.com", provider: "email", externalId: "jash@example.com", displayName: "Jash Doshi", email: "jash@example.com" },
      { key: "name:guest", provider: "meeting", externalId: "guest", displayName: "Guest", email: undefined },
    ]);
    expect(found.cursor).toEqual({ since: "2026-11-01T10:00:00.000Z" });
    expect((calls[0].body as { variables: unknown }).variables).toEqual({ fromDate: "2026-08-04T12:00:00.000Z", limit: 25, skip: 0 });
  });

  it("asks only for meetings since the cursor, a day back for transcripts that finished late", async () => {
    const { api, calls } = fakeApi(routes([]));
    const found = await fireflies.sync!(api, { since: "2026-11-01T10:00:00.000Z" }, ctx);
    expect((calls[0].body as { variables: { fromDate: string } }).variables.fromDate).toBe("2026-10-31T10:00:00.000Z");
    expect(found.messages).toEqual([]);
    expect(found.cursor).toEqual({ since: "2026-11-01T10:00:00.000Z" });
  });

  it("pages until a short page", async () => {
    const page = Array.from({ length: 25 }, (_, i) => ({ ...transcript, id: `P${i}` }));
    const { api, calls } = fakeApi({
      graphql: (_q, body) => ({ data: { transcripts: (body as { variables: { skip: number } }).variables.skip === 0 ? page : [transcript] } }),
    });
    const found = await fireflies.sync!(api, undefined, ctx);
    expect(calls.map((c) => (c.body as { variables: { skip: number } }).variables.skip)).toEqual([0, 25]);
    expect(found.threads).toHaveLength(26);
  });

  it("splits a long turn at a sentence boundary", () => {
    const sentence = "x".repeat(499);
    const turns = speakerTurns(Array.from({ length: 5 }, (_, i) => ({ speaker_name: "A", text: sentence, start_time: i * 10, end_time: i * 10 + 9 })));
    expect(turns.map((t) => [t.text.length, t.startMs, t.endMs])).toEqual([
      [1499, 0, 29_000],
      [999, 30_000, 49_000],
    ]);
  });

  it("identifies the key's owner, and says so plainly when the key is refused", async () => {
    const { api } = fakeApi(routes([]));
    expect(await fireflies.identify(api, {})).toEqual({ accountId: "sumedh@example.com", label: "sumedh@example.com" });

    const refused = fakeApi({ graphql: () => ({ errors: [{ message: "Invalid API key", code: "auth_failed", extensions: { status: 401 } }] }) });
    await expect(fireflies.identify(refused.api, {})).rejects.toThrow("Fireflies didn't accept that API key.");
  });
});
