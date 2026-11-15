import { convertToModelMessages, createUIMessageStreamResponse, streamText, toUIMessageStream, type UIMessage } from "ai";
import { openAgent } from "@/agent/answer";
import { defaultModels, recordRun } from "@/ai/models";
import { getDb } from "@/db/client";
import { getViewer } from "@/lib/viewer";

export const maxDuration = 60;

export async function POST(request: Request) {
  const viewer = await getViewer();
  const { messages }: { messages: UIMessage[] } = await request.json();
  const db = getDb();
  const models = defaultModels();
  const { agent, close } = await openAgent(db, viewer, models, { origin: new URL(request.url).origin });

  const result = streamText({
    ...agent,
    messages: await convertToModelMessages(messages),
    onError: () => void close(),
    onEnd: async ({ totalUsage }) => {
      await close();
      await recordRun(db, {
        orgId: viewer.orgId,
        stage: "answer",
        model: models.answer,
        inputTokens: totalUsage.inputTokens,
        outputTokens: totalUsage.outputTokens,
      });
    },
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: result.stream,
      tools: agent.tools,
      // Model provider errors (no credit, bad key, rate limit) are safe and useful to show; anything else stays in the logs.
      onError: (error) => {
        console.error(error);
        const providerError = error instanceof Error && "statusCode" in error;
        return providerError ? `The model provider refused the request: ${error.message}` : "Something failed while answering. Check the server logs.";
      },
    }),
  });
}
