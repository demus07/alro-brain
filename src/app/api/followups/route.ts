import { generateText, Output } from "ai";
import { z } from "zod";
import { defaultModels, recordRun } from "@/ai/models";
import { getDb } from "@/db/client";
import { getViewer } from "@/lib/viewer";

const FOLLOWUPS = `Suggest up to 3 short follow-up questions the asker would likely want next, answerable from the same company memory (chats, email, meetings, CRM). Each under 70 characters, specific to names and topics in the answer. No questions the answer already covers.`;

/** Three follow-up questions for an answer, from the cheapest model. */
export async function POST(request: Request) {
  const viewer = await getViewer();
  const { question, answer }: { question?: string; answer?: string } = await request.json();
  if (!question || !answer) return Response.json({ questions: [] });
  const models = defaultModels();
  const { output, usage } = await generateText({
    model: models.screen,
    instructions: FOLLOWUPS,
    prompt: `QUESTION: ${question.slice(0, 500)}\n\nANSWER:\n${answer.slice(0, 4000)}`,
    output: Output.object({ schema: z.object({ questions: z.array(z.string()) }) }),
  });
  await recordRun(getDb(), { orgId: viewer.orgId, stage: "answer", model: models.screen, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
  return Response.json({ questions: output.questions.slice(0, 3) });
}
