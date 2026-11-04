import { isStepCount } from "ai";
import { eq } from "drizzle-orm";
import type { Models } from "@/ai/models";
import type { Db } from "@/db/client";
import { orgs } from "@/db/schema";
import type { Viewer } from "@/db/scope";
import { agentInstructions } from "./agent";
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
