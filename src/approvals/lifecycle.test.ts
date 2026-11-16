import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { StoredCredential } from "@/connectors/sync";
import type { Db } from "@/db/client";
import { approvals, auditLog, connections, orgs, people } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { saveSecret } from "@/lib/secrets";
import { ApprovalError, decide, decideFromReply, edit, markDone, pendingFor, proposalTools, recentFor, retry, RUNNING_MS, sendAgain, sweepApprovals } from "./approvals";

const NOW = new Date("2026-11-05T04:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const days = (n: number) => new Date(NOW.getTime() + n * DAY);

let db: Db;
let close: () => Promise<void>;
let orgId: string;
let sumedh: string;
let jash: string;
const viewer = () => ({ orgId, personId: sumedh });

beforeAll(async () => {
  process.env.ALRO_SECRET_KEY = Buffer.alloc(32, 3).toString("base64");
  ({ db, close } = await createTestDb());
  [{ id: orgId }] = await db.insert(orgs).values({ name: "Metals Co", timezone: "Asia/Kolkata" }).returning();
  [{ id: sumedh }, { id: jash }] = await db
    .insert(people)
    .values([
      { orgId, displayName: "Sumedh Kudav", isMember: true, primaryEmail: "sumedh@example.com" },
      { orgId, displayName: "Jash Doshi", isMember: true, primaryEmail: "jash@example.com" },
    ])
    .returning();
  const [gmail] = await db.insert(connections).values({ orgId, provider: "gmail", scope: "personal", ownerPersonId: sumedh, externalAccountId: "sumedh@example.com" }).returning();
  await saveSecret(db, orgId, "connection", gmail.id, { kind: "oauth", app: "google", accessToken: "tok", refreshToken: "r", expiresAt: Date.now() + 30 * DAY } satisfies StoredCredential);
  const [linear] = await db.insert(connections).values({ orgId, provider: "linear", scope: "org", ownerPersonId: jash, externalAccountId: "linear:org1" }).returning();
  await saveSecret(db, orgId, "connection", linear.id, { kind: "token", values: { token: "lin_api_test" } } satisfies StoredCredential);
}, 60_000);

afterAll(() => close());
afterEach(async () => {
  vi.unstubAllGlobals();
  await db.update(approvals).set({ status: "rejected" }).where(eq(approvals.status, "pending"));
});

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
function stubFetch(handler: Handler) {
  const seen: { url: URL; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    seen.push({ url, init });
    return handler(url, init);
  });
  return seen;
}
/** What fetch does when its timer runs out. */
const timedOut = () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
const sentBody = (init: RequestInit) => {
  const raw = Buffer.from(JSON.parse(String(init.body)).raw, "base64url").toString("utf8");
  return Buffer.from(raw.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString("utf8");
};

const exec = (t: unknown, input: unknown) => (t as { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute(input, { toolCallId: "t", messages: [] });
/** Proposes an email as the agent would and returns the waiting row. */
async function proposeEmail(subject: string, origin: "chat" | "messaging" = "chat") {
  const { tools } = await proposalTools(db, viewer(), { origin, now: NOW });
  const queued = await exec(tools.gmail_send_email, { to: ["priya@acme.com"], subject, body: "Hi Priya, 52,000 a tonne.", why_for_approver: "She asked" });
  const [row] = await db.select().from(approvals).where(eq(approvals.code, String(queued.code)));
  return row;
}
const reload = async (id: string) => (await db.select().from(approvals).where(eq(approvals.id, id)))[0];
const audited = async (id: string) => (await db.select().from(auditLog).where(eq(auditLog.target, id))).map((a) => a.action).sort();

describe("editing and approving", () => {
  it("refuses to approve a text that was edited somewhere else since it was opened", async () => {
    const seen = stubFetch(() => Response.json({ id: "sent1" }));
    const opened = await proposeEmail("Revised quote");
    expect(opened.revision).toBe(0);

    // Tab B saves an edit while tab A still shows the first text.
    const edited = await edit(db, viewer(), opened.id, "Hi Priya, 51,500 a tonne.", opened.revision, NOW);
    expect(edited).toMatchObject({ revision: 1, status: "pending", body: "Hi Priya, 51,500 a tonne." });

    // Tab A approves what it sees, and also tries to save its own edit: both refused, nothing sent.
    const refused = await decide(db, viewer(), opened.id, "approve", { revision: opened.revision, body: opened.body!, now: NOW }).catch((e) => e);
    expect(refused).toBeInstanceOf(ApprovalError);
    expect(refused).toMatchObject({ reason: "changed", message: expect.stringContaining("changed since you opened it") });
    await expect(edit(db, viewer(), opened.id, "Hi Priya, 60,000.", opened.revision, NOW)).rejects.toMatchObject({ reason: "changed" });
    expect(seen).toHaveLength(0);
    expect(await reload(opened.id)).toMatchObject({ status: "pending", revision: 1, body: "Hi Priya, 51,500 a tonne." });

    // Having read the new text, approving it works, and that text is what goes out.
    const done = await decide(db, viewer(), opened.id, "approve", { revision: 1, body: "Hi Priya, 51,500 a tonne.", now: NOW });
    expect(done.status).toBe("done");
    expect(seen).toHaveLength(1);
    expect(sentBody(seen[0].init)).toBe("Hi Priya, 51,500 a tonne.");
    expect(await audited(opened.id)).toEqual(["approval.approve"]);
  });

  it("counts an edit made while approving as a new revision", async () => {
    stubFetch(() => Response.json({ id: "sent2" }));
    const a = await proposeEmail("Edited on approve");
    const done = await decide(db, viewer(), a.id, "approve", { revision: 0, body: "Changed while approving.", now: NOW });
    expect(done).toMatchObject({ status: "done", revision: 1 });
    const b = await proposeEmail("Unchanged on approve");
    expect(await decide(db, viewer(), b.id, "approve", { revision: 0, body: b.body!, now: NOW })).toMatchObject({ status: "done", revision: 0 });
  });

  it("approves the current text from a messaging app, and only its owner can decide", async () => {
    const seen = stubFetch(() => Response.json({ id: "sent3" }));
    const a = await proposeEmail("From chat", "messaging");
    await edit(db, viewer(), a.id, "The edited text.", 0, NOW);
    await expect(decide(db, { orgId, personId: jash }, a.id, "approve", { now: NOW })).rejects.toMatchObject({ reason: "gone" });
    await expect(edit(db, { orgId, personId: jash }, a.id, "Jash's text", 1, NOW)).rejects.toMatchObject({ reason: "gone" });
    expect(await decideFromReply(db, viewer(), `yes ${a.code}`, NOW)).toMatch(/^Done: Email to priya@acme.com/);
    expect(sentBody(seen[0].init)).toBe("The edited text.");
  });
});

describe("expiry", () => {
  it("gives each proposal an expiry: a week, or what the company chose", async () => {
    expect((await proposeEmail("Default")).expiresAt).toEqual(days(7));
    await db.update(orgs).set({ settings: { approvalExpiryDays: 2 } }).where(eq(orgs.id, orgId));
    expect((await proposeEmail("Two days")).expiresAt).toEqual(days(2));
    await db.update(orgs).set({ settings: {} }).where(eq(orgs.id, orgId));
  });

  it("expires what nobody decided, and an expired proposal can't be approved", async () => {
    const seen = stubFetch(() => Response.json({ id: "never" }));
    const swept = await proposeEmail("Swept by the tick");
    const clicked = await proposeEmail("Clicked too late");

    expect(await sweepApprovals(db, orgId, days(6))).toEqual({ expired: 0, unknown: 0 });
    // Approved after it lapsed but before the tick got to it: refused, and expired on the spot.
    await expect(decide(db, viewer(), clicked.id, "approve", { now: days(8) })).rejects.toMatchObject({ reason: "expired" });
    expect(await reload(clicked.id)).toMatchObject({ status: "expired" });

    expect(await sweepApprovals(db, orgId, days(8))).toEqual({ expired: 1, unknown: 0 });
    expect(await reload(swept.id)).toMatchObject({ status: "expired", decidedAt: days(8) });
    expect((await pendingFor(db, viewer())).map((a) => a.id)).not.toContain(swept.id);
    expect((await recentFor(db, viewer())).filter((a) => a.status === "expired").map((a) => a.id).sort()).toEqual([swept.id, clicked.id].sort());
    // Not from a messaging app either, and it can't be brought back as a "retry".
    expect(await decideFromReply(db, viewer(), `yes ${swept.code}`, days(8))).toBe(`Nothing is waiting with the code ${swept.code}.`);
    await retry(db, viewer(), swept.id, days(8));
    expect((await reload(swept.id)).status).toBe("expired");
    expect(seen).toHaveLength(0);
    expect(await audited(swept.id)).toEqual(["approval.expire"]);
    expect(await audited(clicked.id)).toEqual(["approval.expire"]);
  });
});

describe("when the app doesn't answer", () => {
  it("marks the action unknown and never sends it again by itself", async () => {
    const seen = stubFetch(timedOut);
    const a = await proposeEmail("No answer");
    const row = await decide(db, viewer(), a.id, "approve", { now: NOW });
    expect(row).toMatchObject({ status: "unknown", error: expect.stringContaining("Gmail didn't answer, so this may or may not have gone through") });
    expect(seen).toHaveLength(1);

    // Nothing that runs by itself touches it: not the tick, not "retry" (which is for definite failures), not a second approve.
    expect(await sweepApprovals(db, orgId, days(1))).toEqual({ expired: 0, unknown: 0 });
    await retry(db, viewer(), a.id, NOW);
    await expect(decide(db, viewer(), a.id, "approve", { now: NOW })).rejects.toMatchObject({ reason: "gone" });
    expect(await decideFromReply(db, viewer(), `yes ${a.code}`, NOW)).toBe(`Nothing is waiting with the code ${a.code}.`);
    expect(await reload(a.id)).toMatchObject({ status: "unknown" });
    expect(seen).toHaveLength(1);

    // Only its owner can settle it. "Send again anyway" sends once more, now.
    await expect(sendAgain(db, { orgId, personId: jash }, a.id, NOW)).rejects.toMatchObject({ reason: "gone" });
    vi.unstubAllGlobals();
    const again = stubFetch(() => Response.json({ id: "sent-second-time" }));
    expect(await sendAgain(db, viewer(), a.id, NOW)).toMatchObject({ status: "done", error: null });
    expect(again).toHaveLength(1);
    expect(await audited(a.id)).toEqual(["approval.approve", "approval.retry"]);
  });

  it("lets the owner mark it as done after checking the app, without sending anything", async () => {
    const seen = stubFetch(timedOut);
    const a = await proposeEmail("Checked by hand");
    // Approved from a messaging app: the reply says to check before sending again.
    expect(await decideFromReply(db, viewer(), `yes ${a.code}`, NOW)).toContain("Check Gmail before sending it again");
    await markDone(db, viewer(), a.id, NOW);
    expect(await reload(a.id)).toMatchObject({ status: "done", error: null, result: { detail: expect.stringContaining("Marked as done") } });
    expect(seen).toHaveLength(1);
    await expect(markDone(db, viewer(), a.id, NOW)).rejects.toMatchObject({ reason: "gone" });
    expect(await audited(a.id)).toEqual(["approval.approve", "approval.mark_done"]);
  });

  it("treats a definite refusal as failed: it can be put back in the queue and approved again", async () => {
    stubFetch(() => new Response("backend down", { status: 500 }));
    const a = await proposeEmail("Refused");
    expect(await decide(db, viewer(), a.id, "approve", { now: NOW })).toMatchObject({ status: "failed", error: expect.stringContaining("500") });
    // "Send again anyway" is only for unknown outcomes.
    await expect(sendAgain(db, viewer(), a.id, NOW)).rejects.toMatchObject({ reason: "gone" });
    await retry(db, viewer(), a.id, days(1));
    // Back in the queue as a new revision with a fresh expiry, so an old tab can't approve it blind.
    expect(await reload(a.id)).toMatchObject({ status: "pending", error: null, revision: 1, expiresAt: days(8) });
    await expect(decide(db, viewer(), a.id, "approve", { revision: 0, now: days(1) })).rejects.toMatchObject({ reason: "changed" });
    expect(await audited(a.id)).toEqual(["approval.approve", "approval.retry"]);
  });

  it("turns a send interrupted by a restart into unknown, not stuck", async () => {
    const seen = stubFetch(() => Response.json({ id: "x" }));
    const [crashed, busy] = [await proposeEmail("Server stopped mid-send"), await proposeEmail("Still sending")];
    const now = new Date();
    await db.update(approvals).set({ status: "running", updatedAt: new Date(now.getTime() - RUNNING_MS - 60_000) }).where(eq(approvals.id, crashed.id));
    await db.update(approvals).set({ status: "running", updatedAt: now }).where(eq(approvals.id, busy.id));
    // Before the tick gets to it, the page already shows it as needing a check.
    expect((await recentFor(db, viewer())).find((a) => a.id === crashed.id)).toMatchObject({ status: "running", crashed: true });
    expect((await recentFor(db, viewer())).find((a) => a.id === busy.id)).toMatchObject({ crashed: false });
    await expect(sendAgain(db, viewer(), busy.id, now)).rejects.toMatchObject({ reason: "gone" });

    expect(await sweepApprovals(db, orgId, now)).toEqual({ expired: 0, unknown: 1 });
    expect(await reload(crashed.id)).toMatchObject({ status: "unknown", error: expect.stringContaining("may or may not have gone through") });
    expect((await reload(busy.id)).status).toBe("running");
    expect(seen).toHaveLength(0);
    await db.update(approvals).set({ status: "rejected" }).where(inArray(approvals.id, [crashed.id, busy.id]));
  });
});

describe("sending the same approved action twice", () => {
  it("passes the approval's id along, and Linear uses it so the issue is only filed once", async () => {
    const created: unknown[] = [];
    let mode: "timeout" | "duplicate" = "timeout";
    stubFetch((_url, init) => {
      const { query, variables } = JSON.parse(String(init.body)) as { query: string; variables: { input?: { id?: string }; id?: string } };
      if (query.includes("teams")) return Response.json({ data: { teams: { nodes: [{ id: "t1", key: "ENG", name: "Engineering" }] } } });
      if (query.includes("issueCreate")) {
        created.push(variables.input?.id);
        // The first create went through but its answer was lost; Linear refuses the same id a second time.
        return mode === "timeout" ? timedOut() : Response.json({ errors: [{ message: "Entity with this id already exists" }] });
      }
      return Response.json({ data: { issue: { identifier: "ENG-42", url: "https://linear.app/alro/issue/ENG-42" } } });
    });
    const { tools } = await proposalTools(db, viewer(), { origin: "chat", now: NOW });
    const queued = await exec(tools.linear_create_issue, { team: "ENG", title: "Fix the export", why_for_approver: "From the call" });
    const [a] = await db.select().from(approvals).where(and(eq(approvals.code, String(queued.code)), eq(approvals.orgId, orgId)));

    expect(await decide(db, viewer(), a.id, "approve", { now: NOW })).toMatchObject({ status: "unknown" });
    mode = "duplicate";
    const again = await sendAgain(db, viewer(), a.id, NOW);
    // Same key both times, so the second send found the first one's issue instead of filing another.
    expect(created).toEqual([a.id, a.id]);
    expect(again).toMatchObject({ status: "done", result: { url: "https://linear.app/alro/issue/ENG-42", detail: "Created ENG-42" } });
  });
});
