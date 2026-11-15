import { isStepCount } from "ai";
import { eq } from "drizzle-orm";
import type { Models } from "@/ai/models";
import type { Db } from "@/db/client";
import { orgs } from "@/db/schema";
import type { Viewer } from "@/db/scope";
import { liveToolsFor } from "@/tools/live";
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

/**
 * The full assistant for one member: company memory, their personal brain, their
 * scheduled tasks and whatever can be queried live. Call `close` when the answer is done.
 */
export async function openAgent(
  db: Db,
  viewer: Viewer & { displayName: string },
  models: Models,
  opts: { now?: Date; origin?: string; /** Replying in a messaging app: keep it short and plain. */ channel?: string; /** A scheduled run can't schedule more runs. */ scheduled?: boolean } = {},
) {
  const [org] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, viewer.orgId));
  const base = await agentFor(db, viewer, models, opts.now);
  const live = await liveToolsFor(db, viewer, opts.origin ?? process.env.ALRO_APP_URL ?? "http://localhost:3000");
  const profile = await loadProfile(db, viewer);
  const liveSection = live.systems.length
    ? `\n\nLive tools: you can also query ${live.systems.join(", ")} directly, for what is true right now (numbers, records, statuses). Use them when the question is about current figures or records in those systems; use memory for what people said and decided. Say which system a figure came from; live results have no [S] refs.`
    : "";
  const channelSection = opts.channel ? `\n\nYou are replying in ${opts.channel}. Keep it short. Plain text only: no tables, no headings.` : "";
  return {
    agent: {
      ...base,
      instructions: `${base.instructions}${PERSONAL}${opts.scheduled ? "" : SCHEDULING}${liveSection}${profileInstructions(profile, viewer.displayName)}${channelSection}`,
      tools: { ...base.tools, ...personalTools(db, viewer, org.timezone, { scheduling: !opts.scheduled, now: opts.now }), ...live.tools },
    },
    close: live.close,
  };
}
