import { describe, expect, it } from "vitest";
import { ProviderError, type Api } from "./api";
import { hubspot } from "./hubspot";
import { linear } from "./linear";
import { outlook } from "./outlook";
import { slack } from "./slack";

/** A fake app: answers by path, and records every call with its body. */
function fakeApi(routes: Record<string, (body: unknown, query: Record<string, unknown>) => unknown>) {
  const calls: { method: string; path: string; body?: unknown; query?: Record<string, unknown> }[] = [];
  const api: Api = async (method, path, opts = {}) => {
    calls.push({ method, path, body: opts.body, query: opts.query });
    const route = routes[path];
    if (!route) throw new ProviderError(`no route for ${path}`, 404);
    return route(opts.body, opts.query ?? {}) as never;
  };
  return { api, calls };
}

const ctx = { accountId: "acct", credentials: {} };

describe("Slack post", () => {
  const def = slack.actions!.slack_post_message;
  const routes = {
    "users.lookupByEmail": () => ({ ok: true, user: { id: "U2" } }),
    "conversations.open": () => ({ ok: true, channel: { id: "D9" } }),
    "conversations.list": () => ({ ok: true, channels: [{ id: "C1", name: "general" }, { id: "C7", name: "dispatch" }] }),
    "chat.postMessage": (body: unknown) => ({ ok: true, channel: (body as { channel: string }).channel, ts: "1.2" }),
    "chat.getPermalink": () => ({ ok: true, permalink: "https://alro.slack.com/archives/C7/p12" }),
  };

  it("posts in a channel by name", async () => {
    const { api, calls } = fakeApi(routes);
    const out = await def.run(api, { to: "#dispatch", text: "Truck MH12 is out" }, ctx);
    expect(calls.find((c) => c.path === "chat.postMessage")!.body).toEqual({ channel: "C7", text: "Truck MH12 is out" });
    expect(out.url).toBe("https://alro.slack.com/archives/C7/p12");
  });

  it("sends a direct message to a person by email", async () => {
    const { api, calls } = fakeApi(routes);
    await def.run(api, { to: "jash@example.com", text: "hi" }, ctx);
    expect(calls.map((c) => c.path)).toEqual(["users.lookupByEmail", "conversations.open", "chat.postMessage", "chat.getPermalink"]);
    expect(calls[2].body).toEqual({ channel: "D9", text: "hi" });
  });

  it("says plainly when Slack refuses", async () => {
    const { api } = fakeApi({ ...routes, "chat.postMessage": () => ({ ok: false, error: "not_in_channel" }) });
    await expect(def.run(api, { to: "#general", text: "x" }, ctx)).rejects.toThrow("not_in_channel");
    await expect(def.run(fakeApi(routes).api, { to: "#nope", text: "x" }, ctx)).rejects.toThrow("No public Slack channel called #nope");
  });

  it("only looks among public channels, never private ones", async () => {
    const { api, calls } = fakeApi(routes);
    await def.run(api, { to: "#general", text: "x" }, ctx);
    expect(calls.find((c) => c.path === "conversations.list")!.query).toMatchObject({ types: "public_channel" });
  });

  it("lets the approver edit the text", () => {
    expect(def.withBody!({ to: "#general", text: "draft" }, "final")).toEqual({ to: "#general", text: "final" });
    expect(def.summary({ to: "#general", text: "x" })).toBe("Slack message to #general");
  });
});

describe("Linear issue", () => {
  const def = linear.actions!.linear_create_issue;
  it("finds the team and the assignee, then files the issue", async () => {
    const bodies: { query: string; variables: Record<string, unknown> }[] = [];
    const { api } = fakeApi({
      graphql: (body) => {
        const b = body as { query: string; variables: Record<string, unknown> };
        bodies.push(b);
        if (b.query.includes("teams")) return { data: { teams: { nodes: [{ id: "t1", key: "ENG", name: "Engineering" }] } } };
        if (b.query.includes("users")) return { data: { users: { nodes: [{ id: "u9" }] } } };
        return { data: { issueCreate: { success: true, issue: { identifier: "ENG-42", url: "https://linear.app/alro/issue/ENG-42" } } } };
      },
    });
    const out = await def.run(api, { team: "eng", title: "Fix the export", description: "From the call", assigneeEmail: "jash@example.com", dueDate: "2026-11-20" }, ctx);
    expect(bodies[2].variables.input).toEqual({ teamId: "t1", title: "Fix the export", description: "From the call", assigneeId: "u9", dueDate: "2026-11-20" });
    expect(out).toEqual({ url: "https://linear.app/alro/issue/ENG-42", detail: "Created ENG-42" });
  });
});

describe("HubSpot note and task", () => {
  it("adds a note tied to the deal", async () => {
    const { api, calls } = fakeApi({ "crm/v3/objects/notes": () => ({ id: "n1" }) });
    await hubspot.actions!.hubspot_add_note.run(api, { object: "deals", recordId: "77", note: "Agreed 52,000 a tonne" }, ctx);
    const body = calls[0].body as { properties: Record<string, string>; associations: { to: { id: string }; types: { associationTypeId: number }[] }[] };
    expect(body.properties.hs_note_body).toBe("Agreed 52,000 a tonne");
    expect(body.associations[0]).toMatchObject({ to: { id: "77" }, types: [{ associationTypeId: 214 }] });
  });

  it("creates a task with a due date", async () => {
    const { api, calls } = fakeApi({ "crm/v3/objects/tasks": () => ({ id: "k1" }) });
    await hubspot.actions!.hubspot_create_task.run(api, { object: "contacts", recordId: "5", subject: "Send the mill certificate", dueDate: "2026-11-20" }, ctx);
    const body = calls[0].body as { properties: Record<string, string>; associations: { types: { associationTypeId: number }[] }[] };
    expect(body.properties).toMatchObject({ hs_task_subject: "Send the mill certificate", hs_timestamp: "2026-11-20T09:00:00.000Z" });
    expect(body.associations[0].types[0].associationTypeId).toBe(204);
  });
});

describe("Outlook send", () => {
  it("sends plain text to and cc recipients and keeps a copy in Sent", async () => {
    const { api, calls } = fakeApi({ "me/sendMail": () => ({}) });
    await outlook.actions!.outlook_send_email.run(api, { to: ["priya@acme.com"], cc: ["ops@acme.com"], subject: "Quote", body: "Hi" }, ctx);
    expect(calls[0]).toMatchObject({
      method: "POST",
      body: {
        message: { subject: "Quote", body: { contentType: "Text", content: "Hi" }, toRecipients: [{ emailAddress: { address: "priya@acme.com" } }], ccRecipients: [{ emailAddress: { address: "ops@acme.com" } }] },
        saveToSentItems: true,
      },
    });
  });
});
