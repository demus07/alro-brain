import { createOpenAI } from "@ai-sdk/openai";
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
  /** Reads every chunk and writes the knowledge graph (entities, descriptions, relations). */
  graph: LanguageModel;
  /** Answers questions with the agent tools. */
  answer: LanguageModel;
  embed: EmbeddingModel;
  /** Must produce EMBEDDING_DIMS-long vectors. */
  embedDimensions: number;
  /** Prepended to search queries (not documents), for embedding models trained with an instruction, e.g. Qwen3. */
  queryPrefix?: string;
}

/** Qwen3-Embedding's recommended query instruction; documents are embedded as they are. */
const QWEN3_QUERY_PREFIX = "Instruct: Given a question, retrieve conversation excerpts and facts that answer it\nQuery: ";

/**
 * A separate embedding endpoint, e.g. a local Ollama (ALRO_EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1,
 * ALRO_EMBEDDING_MODEL=qwen3-embedding:0.6b). Every stored vector must come from the same model, so
 * switching means re-embedding.
 */
function embeddingOverride(): Pick<Models, "embed" | "queryPrefix"> | undefined {
  const baseURL = process.env.ALRO_EMBEDDING_BASE_URL;
  const id = process.env.ALRO_EMBEDDING_MODEL;
  if (!baseURL || !id) return undefined;
  const provider = createOpenAICompatible({ name: "embeddings", baseURL, apiKey: process.env.ALRO_EMBEDDING_API_KEY });
  return { embed: provider.embeddingModel(id), queryPrefix: /qwen3-embedding/i.test(id) ? QWEN3_QUERY_PREFIX : undefined };
}

export function defaultModels(): Models {
  const models = chatModels();
  return { ...models, ...embeddingOverride() };
}

function chatModels(): Models {
  // OpenAI directly. Uses the Responses API, which current GPT models need for tool calling (the agent).
  if (process.env.OPENAI_API_KEY) {
    const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return {
      screen: openai(process.env.ALRO_SCREEN_MODEL ?? "gpt-6-luna"),
      // Cheapest that holds up (answer eval, Nov 2026): the luna-built index answers as well as a sol-built one.
      // ALRO_ANSWER_MODEL=gpt-6.1-terra scores ~9 points higher for ~20x the cost per answer.
      extract: openai(process.env.ALRO_EXTRACT_MODEL ?? "gpt-6-luna"),
      graph: openai(process.env.ALRO_GRAPH_MODEL ?? process.env.ALRO_EXTRACT_MODEL ?? "gpt-6-luna"),
      answer: openai(process.env.ALRO_ANSWER_MODEL ?? "gpt-6-luna"),
      embed: openai.embeddingModel(process.env.ALRO_EMBEDDING_MODEL ?? "text-embedding-3-small"),
      embedDimensions: EMBEDDING_DIMS,
    };
  }

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
      graph: chat(process.env.ALRO_GRAPH_MODEL ?? process.env.ALRO_EXTRACT_MODEL ?? screen),
      answer: chat(process.env.ALRO_ANSWER_MODEL ?? screen),
      embed: provider.embeddingModel(process.env.ALRO_EMBEDDING_MODEL ?? "text-embedding-3-small"),
      embedDimensions: EMBEDDING_DIMS,
    };
  }
  return {
    screen: process.env.ALRO_SCREEN_MODEL ?? "anthropic/claude-haiku-5.5",
    extract: process.env.ALRO_EXTRACT_MODEL ?? "anthropic/claude-sonnet-5.5",
    graph: process.env.ALRO_GRAPH_MODEL ?? process.env.ALRO_EXTRACT_MODEL ?? "anthropic/claude-sonnet-5.5",
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
    stage: "screen" | "extract" | "graph" | "fulfil" | "embed" | "answer" | "rollup" | "notes" | "routine" | "profile";
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
