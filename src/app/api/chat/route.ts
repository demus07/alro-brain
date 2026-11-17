import { convertToModelMessages, createUIMessageStreamResponse, RetryError, streamText, toUIMessageStream, type UIMessage } from "ai";
import { openAgent } from "@/agent/answer";
import { defaultModels, recordRun } from "@/ai/models";
import { getDb } from "@/db/client";
import { audit } from "@/lib/audit";
import { getViewer } from "@/lib/viewer";
import { limitKey, rateLimit } from "@/platform/rate-limit";
import { LimitError } from "@/platform/usage";

// Long enough for a department of the agent team to finish (its own limit is 4 minutes).
export const maxDuration = 300;

export async function POST(request: Request) {
  const viewer = await getViewer();
  const { messages }: { messages: UIMessage[] } = await request.json();
  const db = getDb();
  const models = defaultModels();
  // A person asks a handful of questions a minute at most; more is a script or a stuck client.
  if (!(await rateLimit(db, limitKey("ask", viewer.personId), 30, 60)).ok) return new Response("You're asking faster than ALRO can answer. Wait a minute and try again.", { status: 429 });
  let opened;
  try {
    // What tools returned earlier in this conversation (replayed from the browser) is checked again for planted instructions.
    const earlierResults = messages.flatMap((m) => m.parts.flatMap((p) => (p.type.startsWith("tool-") && "output" in p ? [p.output] : [])));
    opened = await openAgent(db, viewer, models, { origin: new URL(request.url).origin, earlierResults });
  } catch (e) {
    if (e instanceof LimitError) return new Response(e.message, { status: 429 });
    throw e;
  }
  const { agent, close } = opened;
  const last = messages.at(-1);
  const question = last?.role === "user" ? last.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join(" ") : "";
  if (question) await audit(db, { orgId: viewer.orgId, personId: viewer.personId, action: "ask", target: question.slice(0, 200) });

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
        // After retries the provider's error is wrapped in a RetryError; show the one underneath.
        const cause = RetryError.isInstance(error) ? error.lastError : error;
        const providerError = cause instanceof Error && "statusCode" in cause;
        return providerError ? `The model provider refused the request: ${cause.message}` : "Something failed while answering. Check the server logs.";
      },
    }),
  });
}
