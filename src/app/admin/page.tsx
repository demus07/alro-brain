import { and, count, desc, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { SourceIcon } from "../source-icon";
import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { pendingInvitations } from "@/auth/accounts";
import { ssoProviders } from "@/auth/sso";
import { getDb } from "@/db/client";
import { auditLog, connections, messages, orgs, people, teamAgents, threads } from "@/db/schema";
import { sourceOf } from "@/lib/sources";
import { formatShort } from "@/lib/time";
import { getViewer, type SignedInViewer } from "@/lib/viewer";
import { departedMembers } from "@/memory/revoke";
import { emailConfigured } from "@/notify/email";
import { listMembers } from "@/platform/members";
import { isAdmin, ROLE_LABEL } from "@/platform/roles";
import { usageReport } from "@/platform/usage";
import { deleteCompanyAction, removeMember, restoreMember, revokeInvite, setConversation, setSourceDepartment, updateCompany, updateMember, updatePolicies } from "./actions";
import { InviteForm, ResetLink } from "./forms";

export const metadata: Metadata = { title: "Admin · ALRO" };

type Search = Promise<{ error?: string }>;

export default function AdminPage({ searchParams }: { searchParams: Search }) {
  return (
    <div className="settings">
      <h1>Admin</h1>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Admin searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Admin({ searchParams }: { searchParams: Search }) {
  await connection();
  const viewer = await getViewer();
  const { error } = await searchParams;
  if (!isAdmin(viewer)) return <p className="muted">Only your company&apos;s admins can open this page.</p>;
  const db = getDb();
  const [org] = await db.select().from(orgs).where(eq(orgs.id, viewer.orgId));
  const when = (d: Date) => formatShort(d, org.timezone);
  return (
    <>
      {error && <p className="notice error">{error}</p>}
      <section className="settings-section">
        <div>
          <h2>People</h2>
          <p className="muted small">
            Who can sign in. Admins manage people, team sources and the agent team. Everyone only ever sees what they can already see in the connected apps. Removing someone signs them out everywhere and stops their own sources and scheduled tasks.
          </p>
        </div>
        <People viewer={viewer} when={when} />
      </section>
      <section className="settings-section">
        <div>
          <h2>Departments</h2>
          <p className="muted small">Limit a team source to one department: what the whole company would see, only that department sees. Private channels and mailboxes stay private either way.</p>
        </div>
        <Departments viewer={viewer} />
      </section>
      <section className="settings-section">
        <div>
          <h2>What ALRO reads</h2>
          <p className="muted small">
            Every channel and shared space in your team sources. Exclude one (HR, the board) and ALRO deletes what it took from it and stops reading it. Direct messages and mailboxes aren&apos;t listed: only the people in them can see them.
          </p>
        </div>
        <Conversations orgId={viewer.orgId} />
      </section>
      <section className="settings-section">
        <div>
          <h2>Usage</h2>
          <p className="muted small">What your company has used against its plan. Daily limits reset at midnight UTC.</p>
        </div>
        <Usage orgId={viewer.orgId} />
      </section>
      <section className="settings-section">
        <div>
          <h2>Company</h2>
          <p className="muted small">The time zone decides when briefs go out and what &quot;by Friday&quot; means.</p>
        </div>
        <form action={updateCompany} className="connect-form">
          <div className="row">
            <label className="small">
              Name
              <input name="name" defaultValue={org.name} required />
            </label>
            <label className="small">
              Time zone
              <input name="timezone" defaultValue={org.timezone} placeholder="Asia/Kolkata" required />
            </label>
          </div>
          <div>
            <button>Save</button>
          </div>
        </form>
      </section>
      <section className="settings-section">
        <div>
          <h2>Data</h2>
          <p className="muted small">How long ALRO keeps things. Older messages are deleted with the promises, facts and summaries that came only from them.</p>
        </div>
        <div className="settings-sources">
          <form action={updatePolicies} className="connect-form">
            <div className="row">
              <label className="small">
                Delete messages older than (days)
                <input name="retentionDays" type="number" min={30} max={3650} defaultValue={org.settings.retentionDays ?? ""} placeholder="Keep everything" />
              </label>
              <label className="small">
                Drop proposals nobody decides after (days)
                <input name="approvalExpiryDays" type="number" min={1} max={90} defaultValue={org.settings.approvalExpiryDays ?? ""} placeholder="7" />
              </label>
            </div>
            <div>
              <button>Save</button>
            </div>
          </form>
          {viewer.role === "owner" && (
            <details>
              <summary className="small link">Delete this company</summary>
              <form action={deleteCompanyAction} className="connect-form">
                <p className="small">
                  Deletes everything ALRO holds for {org.name}: every source, message, promise, fact, member and setting. This can&apos;t be undone. Type <strong>{org.name}</strong> to confirm.
                </p>
                <input name="confirm" autoComplete="off" aria-label="Company name" required />
                <label className="small">
                  Your password
                  <input name="password" type="password" autoComplete="current-password" />
                </label>
                <div>
                  <button className="danger">Delete everything</button>
                </div>
              </form>
            </details>
          )}
        </div>
      </section>
      <section className="settings-section">
        <div>
          <h2>Sign-in</h2>
          <p className="muted small">How people prove who they are.</p>
        </div>
        <ul className="sources">
          <li className="source">
            <span className="source-name">Email and password</span>
            <span className="tag">on</span>
          </li>
          {ssoProviders().map((p) => (
            <li key={p.id} className="source">
              <span className="source-name">Single sign-on with {p.label}</span>
              <span className="tag">on</span>
            </li>
          ))}
          {ssoProviders().length === 0 && (
            <li className="source dim">
              <span className="source-text">
                <span className="source-name">Single sign-on</span>
                <span className="muted small">Set OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET (Okta, Entra, Google Workspace) on the server.</span>
              </span>
              <span className="tag">not set up</span>
            </li>
          )}
          {!emailConfigured() && (
            <li className="source dim">
              <span className="source-text">
                <span className="source-name">Email delivery</span>
                <span className="muted small">Without SMTP (SMTP_HOST, SMTP_USER, SMTP_PASSWORD) or RESEND_API_KEY, invitations and reset links are shown here for you to pass on, and emailed sign-in links can&apos;t be sent.</span>
              </span>
              <span className="tag">not set up</span>
            </li>
          )}
        </ul>
      </section>
      <section className="settings-section">
        <div>
          <h2>Activity</h2>
          <p className="muted small">Who did what: sign-ins, questions, approvals, sources and admin changes. Questions are logged, never the answers.</p>
        </div>
        <Activity orgId={viewer.orgId} when={when} />
      </section>
    </>
  );
}

async function People({ viewer, when }: { viewer: SignedInViewer; when: (d: Date) => string }) {
  const db = getDb();
  const [members, invites, departments, departed] = await Promise.all([listMembers(db, viewer.orgId), pendingInvitations(db, viewer.orgId), knownDepartments(viewer.orgId), departedMembers(db, viewer.orgId)]);
  return (
    <div className="settings-sources">
      {departed.length > 0 && (
        <div className="notice">
          <p className="small">
            <strong>May have left:</strong> these members&apos; accounts were closed in a connected app, but they can still sign in to ALRO. Remove them below if they&apos;ve left.
          </p>
          <ul className="plain-list small">
            {departed.map((d) => (
              <li key={d.personId}>
                {d.displayName} · closed in {d.sources.map((x) => sourceOf(x.provider).label).join(", ")} since {when(d.sources[0].since)}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="label">Members · {members.filter((m) => !m.deactivatedAt).length}</p>
      <ul className="sources">
        {members.map((m) => {
          const locked = m.role === "owner" && viewer.role !== "owner";
          return (
            <li key={m.id} className={m.deactivatedAt ? "dim" : undefined}>
              <details>
                <summary className="source">
                  <span className="mark">{m.name.slice(0, 2)}</span>
                  <span className="source-text">
                    <span className="source-name">
                      {m.name}
                      {m.id === viewer.personId && <span className="muted small"> (you)</span>}
                    </span>
                    <span className="muted small truncate">{[m.email, ROLE_LABEL[m.role as keyof typeof ROLE_LABEL] ?? m.role, m.department].filter(Boolean).join(" · ")}</span>
                  </span>
                  {m.deactivatedAt && <span className="tag">removed {when(m.deactivatedAt)}</span>}
                </summary>
                {m.deactivatedAt ? (
                  <form action={restoreMember} className="connect-form">
                    <input type="hidden" name="id" value={m.id} />
                    <p className="muted small">Let them back in, then send a new invitation so they can set a password.</p>
                    <div>
                      <button className="ghost">Restore</button>
                    </div>
                  </form>
                ) : locked ? (
                  <p className="muted small connect-form">Only an owner can change an owner.</p>
                ) : (
                  <div className="connect-form">
                    <form action={updateMember} className="row">
                      <input type="hidden" name="id" value={m.id} />
                      <label className="small">
                        Role
                        <select name="role" defaultValue={m.role}>
                          <option value="member">Member</option>
                          <option value="admin">Admin</option>
                          {viewer.role === "owner" && <option value="owner">Owner</option>}
                        </select>
                      </label>
                      <label className="small">
                        Department
                        <input name="department" defaultValue={m.department ?? ""} list="known-departments" placeholder="none" autoComplete="off" />
                      </label>
                      <button>Save</button>
                    </form>
                    <div className="row">
                      <ResetLink id={m.id} />
                      {m.id !== viewer.personId && (
                        <form action={removeMember} className="actions">
                          <input type="hidden" name="id" value={m.id} />
                          <button className="chip-button danger">Remove from company</button>
                        </form>
                      )}
                    </div>
                  </div>
                )}
              </details>
            </li>
          );
        })}
      </ul>
      {invites.length > 0 && (
        <>
          <p className="label">Invited · {invites.length}</p>
          <ul className="sources">
            {invites.map((i) => (
              <li key={i.id} className="source">
                <span className="source-text">
                  <span className="source-name">{i.email}</span>
                  <span className="muted small">{[ROLE_LABEL[i.role as keyof typeof ROLE_LABEL] ?? i.role, i.department, `expires ${when(i.expiresAt)}`].filter(Boolean).join(" · ")}</span>
                </span>
                <form action={revokeInvite} className="actions">
                  <input type="hidden" name="id" value={i.id} />
                  <button className="chip-button danger">Cancel</button>
                </form>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="label">Invite someone</p>
      <InviteForm departments={departments} />
    </div>
  );
}

/** Every department anyone or anything is in: members, limited sources, the agent team. */
async function knownDepartments(orgId: string): Promise<string[]> {
  const db = getDb();
  const [a, b, c] = await Promise.all([
    db.selectDistinct({ d: people.department }).from(people).where(and(eq(people.orgId, orgId), isNotNull(people.department))),
    db.selectDistinct({ d: connections.department }).from(connections).where(and(eq(connections.orgId, orgId), isNotNull(connections.department))),
    db.selectDistinct({ d: teamAgents.department }).from(teamAgents).where(eq(teamAgents.orgId, orgId)),
  ]);
  return [...new Set([...a, ...b, ...c].flatMap((r) => (r.d ? [r.d] : [])))].sort();
}

async function Departments({ viewer }: { viewer: SignedInViewer }) {
  const db = getDb();
  const [departments, members, sources] = await Promise.all([
    knownDepartments(viewer.orgId),
    listMembers(db, viewer.orgId),
    db
      .select({ id: connections.id, provider: connections.provider, label: connections.label, department: connections.department })
      .from(connections)
      .where(and(eq(connections.orgId, viewer.orgId), eq(connections.scope, "org"), ne(connections.status, "revoked")))
      .orderBy(connections.provider),
  ]);
  const active = members.filter((m) => !m.deactivatedAt);
  return (
    <div className="settings-sources">
      {departments.length === 0 && <p className="muted small">No departments yet. Give a member a department under People to create one.</p>}
      {departments.length > 0 && (
        <div className="chips">
          {departments.map((d) => (
            <span key={d} className="chip">
              {d} · {active.filter((m) => m.department === d).length}
            </span>
          ))}
        </div>
      )}
      {sources.length > 0 && <p className="label">Team sources</p>}
      <ul className="sources">
        {sources.map((s) => (
          <li key={s.id} className="source">
            <SourceIcon provider={s.provider} />
            <span className="source-text">
              <span className="source-name">{sourceOf(s.provider).label}</span>
              <span className="muted small truncate">{[s.label, s.department ? `only ${s.department}` : "whole company"].filter(Boolean).join(" · ")}</span>
            </span>
            <form action={setSourceDepartment} className="actions">
              <input type="hidden" name="id" value={s.id} />
              <select name="department" defaultValue={s.department ?? ""} aria-label={`Who sees ${sourceOf(s.provider).label}`}>
                <option value="">Whole company</option>
                {departments.map((d) => (
                  <option key={d} value={d}>
                    Only {d}
                  </option>
                ))}
              </select>
              <button className="chip-button">Set</button>
            </form>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Channels and shared spaces of team sources, busiest first, with a switch to stop reading each. */
async function Conversations({ orgId }: { orgId: string }) {
  const db = getDb();
  const rows = await db
    .select({ id: threads.id, title: threads.title, kind: threads.kind, visibility: threads.visibility, excludedAt: threads.excludedAt, provider: connections.provider })
    .from(threads)
    .innerJoin(connections, eq(connections.id, threads.connectionId))
    .where(and(eq(threads.orgId, orgId), eq(connections.scope, "org"), ne(connections.status, "revoked"), inArray(threads.kind, ["channel", "doc", "meeting"])));
  if (!rows.length) return <p className="muted small">Nothing yet. Channels appear here after a team source&apos;s first sync.</p>;
  const sizes = await db
    .select({ id: messages.threadId, n: count() })
    .from(messages)
    .where(and(eq(messages.orgId, orgId), isNull(messages.deletedAt)))
    .groupBy(messages.threadId);
  const size = new Map(sizes.map((r) => [r.id, r.n]));
  // Channels are what people mean by "what does it read"; documents and calls are listed only when excluded.
  const listed = rows.filter((r) => r.kind === "channel" || r.excludedAt).sort((a, b) => Number(!!b.excludedAt) - Number(!!a.excludedAt) || (size.get(b.id) ?? 0) - (size.get(a.id) ?? 0));
  const others = rows.length - listed.length;
  return (
    <div className="settings-sources">
      <ul className="sources">
        {listed.slice(0, 60).map((t) => (
          <li key={t.id} className={t.excludedAt ? "source dim" : "source"}>
            <SourceIcon provider={t.provider} />
            <span className="source-text">
              <span className="source-name">{t.title ?? "Untitled"}</span>
              <span className="muted small">
                {t.excludedAt ? "Not read" : `${(size.get(t.id) ?? 0).toLocaleString("en-US")} messages`} · {t.visibility === "org" ? "open to the company" : "private to its members"}
              </span>
            </span>
            <form action={setConversation} className="actions">
              <input type="hidden" name="id" value={t.id} />
              <button className={t.excludedAt ? "chip-button" : "chip-button danger"}>{t.excludedAt ? "Read again" : "Exclude and delete"}</button>
            </form>
          </li>
        ))}
      </ul>
      {(listed.length > 60 || others > 0) && (
        <p className="muted small">
          {listed.length > 60 ? `Showing the 60 busiest of ${listed.length} channels. ` : ""}
          {others > 0 ? `${others.toLocaleString("en-US")} documents, tickets and calls are also read from team sources.` : ""}
        </p>
      )}
    </div>
  );
}

async function Usage({ orgId }: { orgId: string }) {
  const report = await usageReport(getDb(), orgId);
  const n = (v: number) => v.toLocaleString("en-US");
  return (
    <div className="settings-sources">
      <p className="label">{report.planLabel} plan</p>
      {report.rows.map((r) => {
        const share = Math.min(1, r.used / Math.max(1, r.max));
        return (
          <div key={r.limit}>
            <div className="row small">
              <span>{r.label}</span>
              <span className={`mono${share >= 0.8 ? " error" : " muted"}`} style={{ textAlign: "right" }}>
                {n(r.used)} of {n(r.max)}
              </span>
            </div>
            <div className={`meter${share >= 0.8 ? " warn" : ""}`}>
              <span style={{ width: `${Math.round(share * 100)}%` }} />
            </div>
          </div>
        );
      })}
      <p className="muted small">
        This month: {n(report.month.questions ?? 0)} questions, {n(report.month.tokens ?? 0)} model tokens, {n(report.month.team_runs ?? 0)} team runs, {n(report.month.routine_runs ?? 0)} scheduled runs, {n(report.messagesThisMonth)} messages
        brought in ({n(report.messagesStored)} stored in all).
      </p>
    </div>
  );
}

const ACTION: Record<string, string> = {
  "auth.sign_in": "Signed in",
  "auth.sign_in_failed": "Failed sign-in",
  "auth.reset_requested": "Asked for a password reset",
  "auth.password_reset": "Reset their password",
  "auth.password_changed": "Changed their password",
  "auth.reset_link_created": "Created a reset link for",
  "auth.sessions_ended": "Signed out other browsers",
  "org.create": "Created the company",
  "org.update": "Changed company details",
  "org.policies": "Changed data policies",
  "member.invite": "Invited",
  "member.invite_revoked": "Cancelled the invitation for",
  "member.join": "Joined",
  "member.role": "Changed the role of",
  "member.department": "Changed the department of",
  "member.remove": "Removed",
  "member.restore": "Restored",
  "source.connect": "Connected",
  "source.delete": "Deleted the source",
  "source.department": "Changed who sees",
  "conversation.exclude": "Excluded and deleted",
  "conversation.include": "Let ALRO read again",
  ask: "Asked",
  "data.export": "Exported their data",
};

async function Activity({ orgId, when }: { orgId: string; when: (d: Date) => string }) {
  const rows = await getDb()
    .select({ id: auditLog.id, action: auditLog.action, target: auditLog.target, detail: auditLog.detail, at: auditLog.createdAt, who: people.displayName })
    .from(auditLog)
    .leftJoin(people, eq(people.id, auditLog.personId))
    .where(eq(auditLog.orgId, orgId))
    .orderBy(desc(auditLog.createdAt))
    .limit(80);
  if (!rows.length) return <p className="muted small">Nothing yet.</p>;
  return (
    <ul className="timeline">
      {rows.map((r) => (
        <li key={r.id}>
          <span className="small">{r.who ?? "ALRO"}</span>
          <span className="truncate" title={r.detail ? JSON.stringify(r.detail) : undefined}>
            {ACTION[r.action] ?? r.action} {r.target ?? ""}
          </span>
          <span className="muted small mono nowrap">{when(r.at)}</span>
        </li>
      ))}
    </ul>
  );
}
