import { and, count, eq, isNotNull, isNull, ne, notLike, or, sql } from "drizzle-orm";
import type { SignedInViewer } from "@/lib/viewer";
import type { Db } from "@/db/client";
import { channelLinks, commitments, connections, edges, invitations, messages, orgs, people, profileNotes, routines, teamAgents } from "@/db/schema";
import { isAdmin } from "./roles";

export interface SetupStep {
  id: string;
  title: string;
  /** Why it matters, and what happens when it's done. */
  detail: string;
  done: boolean;
  /** What's true right now: "3 members, 1 invited". */
  status?: string;
  href?: string;
  action?: string;
  /** Can be put off without breaking anything. */
  optional?: boolean;
}

/**
 * The setup checklist. Admins set the company up (people, team sources, departments, the agent
 * team); everyone connects their own accounts and tells ALRO how they work. Steps are ticked from
 * what actually exists, so the list is always true, whoever did the work.
 */
export async function setupSteps(db: Db, viewer: SignedInViewer): Promise<{ steps: SetupStep[]; finished: boolean }> {
  const { orgId, personId } = viewer;
  const n = async (q: Promise<{ n: number }[]>) => (await q)[0].n;
  const real = and(eq(connections.orgId, orgId), ne(connections.status, "revoked"), notLike(connections.provider, "upload:%"), ne(connections.provider, "notes"));
  const [[org], members, invited, teamSources, mySources, synced, uploads, goals, departments, specialists, stored, backlog, facts, promises, linked, scheduled] = await Promise.all([
    db.select({ settings: orgs.settings }).from(orgs).where(eq(orgs.id, orgId)),
    n(db.select({ n: count() }).from(people).where(and(eq(people.orgId, orgId), eq(people.isMember, true), isNull(people.deactivatedAt)))),
    n(db.select({ n: count() }).from(invitations).where(and(eq(invitations.orgId, orgId), eq(invitations.kind, "invite"), isNull(invitations.usedAt)))),
    n(db.select({ n: count() }).from(connections).where(and(real, eq(connections.scope, "org")))),
    n(db.select({ n: count() }).from(connections).where(and(real, eq(connections.scope, "personal"), eq(connections.ownerPersonId, personId)))),
    n(db.select({ n: count() }).from(connections).where(and(real, isNotNull(connections.lastSyncedAt)))),
    n(db.select({ n: count() }).from(connections).where(and(eq(connections.orgId, orgId), sql`${connections.provider} like 'upload:%'`))),
    n(db.select({ n: count() }).from(profileNotes).where(and(eq(profileNotes.personId, personId), eq(profileNotes.category, "goal")))),
    n(db.select({ n: sql<number>`count(distinct ${people.department})::int` }).from(people).where(and(eq(people.orgId, orgId), isNotNull(people.department)))),
    n(db.select({ n: count() }).from(teamAgents).where(eq(teamAgents.orgId, orgId))),
    n(db.select({ n: count() }).from(messages).where(eq(messages.orgId, orgId))),
    n(
      db
        .select({ n: count() })
        .from(messages)
        .where(and(eq(messages.orgId, orgId), isNull(messages.deletedAt), or(isNull(messages.screenResult), and(eq(messages.screenResult, "extract"), isNull(messages.extractedAt))))),
    ),
    n(db.select({ n: count() }).from(edges).where(and(eq(edges.orgId, orgId), isNull(edges.expiredAt)))),
    n(db.select({ n: count() }).from(commitments).where(eq(commitments.orgId, orgId))),
    n(db.select({ n: count() }).from(channelLinks).where(eq(channelLinks.personId, personId))),
    n(db.select({ n: count() }).from(routines).where(and(eq(routines.orgId, orgId), eq(routines.ownerPersonId, personId)))),
  ]);
  const skipped = new Set(org.settings.onboarding?.done ?? []);
  const admin = isAdmin(viewer);
  const plural = (k: number, one: string, many = `${one}s`) => `${k.toLocaleString("en-US")} ${k === 1 ? one : many}`;
  const sources = teamSources + mySources + uploads;

  const company: SetupStep[] = [
    {
      id: "people",
      title: "Invite your team",
      detail: "Each person signs in and only ever sees what they can already see in your apps. Give people a department if some sources should be limited to it.",
      done: members + invited > 1,
      status: `${plural(members, "member")}${invited ? `, ${invited} invited` : ""}`,
      href: "/admin",
      action: "Invite people",
      optional: true,
    },
    {
      id: "sources",
      title: "Connect the apps your company works in",
      detail: "Chat, email, calls, documents, your CRM and accounts. ALRO reads them with the access you give it: for chat, only the channels its app is invited to; for mail and calendars, each person connects their own. Or upload an export to start.",
      done: sources > 0,
      status: sources ? [teamSources && `${plural(teamSources, "team source")}`, mySources && `${mySources} of your own`, uploads && `${plural(uploads, "upload")}`].filter(Boolean).join(", ") : "Nothing connected yet",
      href: "/settings",
      action: "Connect sources",
    },
    {
      id: "departments",
      title: "Set up departments and the agent team",
      detail: "Finance, sales, operations and the rest: each gets a lead and specialists that do multi-part work (a cash report, chasing payments, what slipped), with only the tools their job needs.",
      done: specialists > 0,
      status: specialists ? `${plural(specialists, "specialist")}${departments ? ` · ${plural(departments, "department")} of people` : ""}` : "No agent team yet",
      href: "/team",
      action: "Add departments",
      optional: true,
    },
  ];
  const personal: SetupStep[] = [
    ...(admin
      ? []
      : [
          {
            id: "my-sources",
            title: "Connect your own mailbox and calendar",
            detail: "They stay yours: only you (and the people already in each conversation) can see them. They're what makes your morning brief and meeting prep useful.",
            done: mySources > 0,
            status: mySources ? plural(mySources, "source") : "Nothing connected yet",
            href: "/settings",
            action: "Connect yours",
          },
        ]),
    {
      id: "goals",
      title: admin ? "Say what the business is trying to get done" : "Say what you're trying to get done",
      detail: "Two or three goals for this quarter. ALRO uses them to decide what's worth your attention, and can interview you to learn how you work.",
      done: goals > 0,
      status: goals ? plural(goals, "goal") : undefined,
      optional: true,
    },
  ];
  const brain: SetupStep[] = [
    {
      id: "sync",
      title: "First sync",
      detail: "ALRO brings in the last 90 days from each source. This runs in the background and can take a while for busy workspaces.",
      done: stored > 0,
      status: stored ? `${plural(stored, "message")} in${synced ? ` from ${plural(synced, "source")}` : ""}` : sources ? "Waiting for the first sync" : "Connect a source first",
      href: "/connectors",
      action: "See sync health",
    },
    {
      id: "memory",
      title: "Build the company's memory",
      detail: "Every message is made searchable, and promises, decisions and facts are pulled out with the exact words they came from.",
      done: stored > 0 && backlog === 0,
      status: stored ? (backlog ? `${backlog.toLocaleString("en-US")} still to read` : `${plural(facts, "fact")} and ${plural(promises, "promise")} found`) : undefined,
      href: "/connectors",
      action: "See progress",
    },
    {
      id: "review",
      title: "Check what it found",
      detail: "Look over the promises and facts. Marking a wrong one teaches ALRO what counts here, and anything it's unsure about is listed for you to settle.",
      done: skipped.has("review"),
      status: promises || facts ? `${plural(promises, "promise")}, ${plural(facts, "fact")}` : "Nothing to check yet",
      href: "/commitments",
      action: "Review promises",
      optional: true,
    },
    {
      id: "daily",
      title: "Make it part of your day",
      detail: "Link WhatsApp, Telegram, Slack or Teams to ask by message or voice note, and schedule your first task: a morning brief, a Monday cash report, what slipped yesterday.",
      done: linked > 0 || scheduled > 0,
      status: [linked && `${plural(linked, "messaging app")} linked`, scheduled && `${plural(scheduled, "scheduled task")}`].filter(Boolean).join(", ") || undefined,
      href: "/routines",
      action: "Schedule a task",
      optional: true,
    },
  ];
  const steps = [...(admin ? company : []), ...personal, ...brain].map((s) => ({ ...s, done: s.done || skipped.has(s.id) }));
  return { steps, finished: !!org.settings.onboarding?.finishedAt };
}
