import { convertToModelMessages, createUIMessageStreamResponse, isStepCount, streamText, toUIMessageStream, type UIMessage } from "ai";
import { eq } from "drizzle-orm";
import { agentInstructions } from "@/agent/agent";
import { agentTools } from "@/agent/tools";
import { defaultModels, recordRun } from "@/ai/models";
import { getDb } from "@/db/client";
import { orgs } from "@/db/schema";
import { getViewer } from "@/lib/viewer";

export const maxDuration = 60;

export async function POST(request: Request) {
  const viewer = await getViewer();
  const { messages }: { messages: UIMessage[] } = await request.json();
  const db = getDb();
  const models = defaultModels();
  const [org] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, viewer.orgId));
  const tools = agentTools(db, viewer, models, org.timezone);

  const result = streamText({
    model: models.answer,
    instructions: agentInstructions({ askerName: viewer.displayName, now: new Date(), timeZone: org.timezone }),
    messages: await convertToModelMessages(messages),
    tools,
    stopWhen: isStepCount(8),
    onEnd: async ({ totalUsage }) => {
      await recordRun(db, {
        orgId: viewer.orgId,
        stage: "answer",
        model: models.answer,
        inputTokens: totalUsage.inputTokens,
        outputTokens: totalUsage.outputTokens,
      });
    },
  });

  return createUIMessageStreamResponse({ stream: toUIMessageStream({ stream: result.stream, tools }) });
}
