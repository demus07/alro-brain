import { isStepCount, type ToolSet } from "ai";
import { eq } from "drizzle-orm";
import { recordRun, type Models } from "@/ai/models";
import { proposalTools, type Origin } from "@/approvals/approvals";
import type { Db } from "@/db/client";
import { orgs } from "@/db/schema";
import type { Viewer } from "@/db/scope";
import { askTeamTool, loadTeam } from "@/team/team";
import { liveToolsFor } from "@/tools/live";
import { workTools } from "@/work/tools";
import { agentInstructions } from "./agent";
import { personalTools } from "./personal-tools";
import { loadProfile, profileInstructions } from "./profile";
import { agentTools } from "./tools";

/** Agent steps per answer: searches, reads and the final reply. */
export const MAX_STEPS = 8;

/**
 * Everything the answering agent needs for one asker, shared by the chat route
 * and the answer eval so they always test the same agent.
 */
export async function agentFor(db: Db, viewer: Viewer & { displayName: string }, models: Models, now = new Date()) {
  const [org] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, viewer.orgId));
  const tools = agentTools(db, viewer, models, org.timezone);
  return {
    model: models.answer,
    instructions: agentInstructions({ askerName: viewer.displayName, now, timeZone: org.timezone }),
    tools,
    stopWhen: isStepCount(MAX_STEPS),
  };
}

const PERSONAL = `

Working for the asker:
- When they tell you something about themselves (a goal, a preference, how they decide), save it with rememberAboutMe. When they tell or dictate something about the business (a decision, an update, a promise they're making), save it with saveNote. Say in a few words that it's saved.
- If they ask you to interview them or get to know them: ask one short question at a time about their role, the business (clients, pricing, suppliers), how they make decisions, what they want done this quarter, and how they like updates. Save each answer as you go. After about eight questions, sum up what you learned.`;

const SCHEDULING = `
- When they want something on a schedule or ready by a time ("every Monday", "by 5am"), use scheduleTask. Times are in their time zone.`;

const ACTIONS = `

Doing things in apps: tools like gmail_send_email, slack_post_message or hubspot_add_note don't act right away. They queue the action for the asker's approval and return a code. Use them when the asker wants something sent or done (not when they only want a draft to read), after looking up what's needed. Then say what is waiting and its code, e.g. "Waiting for your OK (K7QM)". Never claim something was sent unless the tool says it ran.`;

const TEAM = `

The agent team: askTeam hands bigger, multi-part work to a department (finance, sales, operations...) whose specialists work in parallel. Use it for reports, reviews and chasing (a cash report, overdue payments, the pipeline, what slipped). Answer simple questions yourself.`;

const WORK = `
- For how a recurring job is done here, use findProcedure. For running tables pulled from chats (sales log, receivables, stock, truck times), use readTracker.`;

/**
 * The full assistant for one member: company memory, their personal brain, their
 * scheduled tasks and whatever can be queried live. Call `close` when the answer is done.
 */
export async function openAgent(
  db: Db,
  viewer: Viewer & { displayName: string },
  models: Models,
  opts: {
    now?: Date;
    origin?: string;
    /** Replying in a messaging app: keep it short and plain. */
    channel?: string;
    /** A scheduled run can't schedule more runs. */
    scheduled?: boolean;
    /** Where proposals come from; proposals made while the person isn't watching are sent to them. */
    via?: Origin;
    /** The scheduled task this run is for; a trusted one runs its actions without asking. */
    routine?: { id: string; trusted: boolean };
  } = {},
) {
  const [org] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, viewer.orgId));
  const base = await agentFor(db, viewer, models, opts.now);
  const live = await liveToolsFor(db, viewer, opts.origin ?? process.env.ALRO_APP_URL ?? "http://localhost:3000");
  const via = opts.via ?? (opts.scheduled ? "routine" : opts.channel ? "messaging" : "chat");
  const proposals = await proposalTools(db, viewer, { origin: via, routine: opts.routine, notify: via === "routine" || via === "meeting", now: opts.now }, live.writes);
  const profile = await loadProfile(db, viewer);
  const liveSection = live.systems.length
    ? `\n\nLive tools: you can also query ${live.systems.join(", ")} directly, for what is true right now (numbers, records, statuses). Use them when the question is about current figures or records in those systems; use memory for what people said and decided. Say which system a figure came from; live results have no [S] refs.`
    : "";
  const channelSection = opts.channel ? `\n\nYou are replying in ${opts.channel}. Keep it short. Plain text only: no tables, no headings.` : "";
  const instructions = `${base.instructions}${PERSONAL}${WORK}${opts.scheduled ? "" : SCHEDULING}${liveSection}${proposals.names.length ? ACTIONS : ""}${profileInstructions(profile, viewer.displayName)}${channelSection}`;
  const tools: ToolSet = {
    ...base.tools,
    ...personalTools(db, viewer, org.timezone, { scheduling: !opts.scheduled, now: opts.now }),
    ...workTools(db, viewer, org.timezone),
    ...live.tools,
    ...proposals.tools,
  };
  const askTeam = askTeamTool(await loadTeam(db, viewer.orgId), {
    tools: () => tools,
    model: models.answer,
    instructions: `${base.instructions}${proposals.names.length ? ACTIONS : ""}`,
    onUsage: (u) => void recordRun(db, { orgId: viewer.orgId, stage: "team", model: models.answer, ...u }).catch(() => undefined),
  });
  return {
    agent: { ...base, instructions: `${instructions}${askTeam ? TEAM : ""}`, tools: askTeam ? { ...tools, askTeam } : tools },
    close: live.close,
  };
}
