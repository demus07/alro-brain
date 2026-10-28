import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { EmbeddingModel, LanguageModel } from "ai";
import type { Db } from "@/db/client";
import { EMBEDDING_DIMS, llmRuns } from "@/db/schema";

/**
 * The models each pipeline stage uses. Strings are Vercel AI Gateway model ids
 * (AI_GATEWAY_API_KEY, or OIDC on Vercel); tests pass mock models instead.
 */
export interface Models {
  /** Cheap first pass over every message: could it hold or close a promise? */
  screen: LanguageModel;
  /** Reads thread windows and writes commitments, entities and facts. */
  extract: LanguageModel;
  /** Answers questions with the agent tools. */
  answer: LanguageModel;
  embed: EmbeddingModel;
  /** Must produce EMBEDDING_DIMS-long vectors. */
  embedDimensions: number;
}

export function defaultModels(): Models {
  // Any OpenAI-compatible endpoint instead of AI Gateway: a local Ollama
  // (http://localhost:11434/v1), OpenRouter (https://openrouter.ai/api/v1), etc.
  const baseURL = process.env.ALRO_LLM_BASE_URL;
  if (baseURL) {
    const provider = createOpenAICompatible({
      name: "openai-compatible",
      baseURL,
      apiKey: process.env.ALRO_LLM_API_KEY,
      supportsStructuredOutputs: true,
      includeUsage: true,
    });
    const chat = (id: string | undefined) => {
      if (!id) throw new Error("With ALRO_LLM_BASE_URL set, also set ALRO_SCREEN_MODEL (and optionally the other model ids).");
      return provider.chatModel(id);
    };
    const screen = process.env.ALRO_SCREEN_MODEL;
    return {
      screen: chat(screen),
      extract: chat(process.env.ALRO_EXTRACT_MODEL ?? screen),
      answer: chat(process.env.ALRO_ANSWER_MODEL ?? screen),
      embed: provider.embeddingModel(process.env.ALRO_EMBEDDING_MODEL ?? "text-embedding-3-small"),
      embedDimensions: EMBEDDING_DIMS,
    };
  }
  return {
    screen: process.env.ALRO_SCREEN_MODEL ?? "anthropic/claude-haiku-5.5",
    extract: process.env.ALRO_EXTRACT_MODEL ?? "anthropic/claude-sonnet-5.5",
    answer: process.env.ALRO_ANSWER_MODEL ?? "anthropic/claude-sonnet-5.5",
    embed: process.env.ALRO_EMBEDDING_MODEL ?? "voyage/voyage-3.5",
    embedDimensions: EMBEDDING_DIMS,
  };
}

export const modelId = (model: LanguageModel | EmbeddingModel) => (typeof model === "string" ? model : model.modelId);

/** Logs one model call to llm_runs so cost per org and stage stays visible. */
export async function recordRun(
  db: Db,
  run: {
    orgId: string;
    stage: "screen" | "extract" | "fulfil" | "embed" | "answer" | "rollup";
    model: LanguageModel | EmbeddingModel;
    inputTokens?: number;
    outputTokens?: number;
    messageIds?: string[];
  },
) {
  await db.insert(llmRuns).values({
    orgId: run.orgId,
    stage: run.stage,
    model: modelId(run.model),
    inputTokens: run.inputTokens ?? 0,
    outputTokens: run.outputTokens ?? 0,
    messageIds: run.messageIds,
  });
}
