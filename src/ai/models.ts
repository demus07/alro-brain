import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { EmbeddingModel, LanguageModel } from "ai";
import type { Db } from "@/db/client";
import { EMBEDDING_DIMS, llmRuns } from "@/db/schema";
import { bump } from "@/platform/usage";

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
  // Any OpenAI-compatible endpoint: a local Ollama (http://localhost:11434/v1), OpenRouter
  // (https://openrouter.ai/api/v1), etc. Set explicitly, so it wins over OPENAI_API_KEY.
  const baseURL = process.env.ALRO_LLM_BASE_URL;
  if (baseURL) {
    const fallbacks = (process.env.ALRO_LLM_FALLBACK_MODELS ?? "")
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
    const freeOnly = process.env.ALRO_FREE_MODELS_ONLY === "true";
    const checkFree = (id: string) => {
      // OpenRouter's free models all end in ":free"; anything else may be billed.
      if (freeOnly && !id.endsWith(":free")) throw new Error(`ALRO_FREE_MODELS_ONLY is on, and ${id} isn't a free model (free ids end in ":free").`);
    };
    fallbacks.forEach(checkFree);
    const provider = createOpenAICompatible({
      name: "openai-compatible",
      baseURL,
      apiKey: process.env.ALRO_LLM_API_KEY,
      supportsStructuredOutputs: true,
      includeUsage: true,
      // OpenRouter tries `models` in order (up to 3) when one is busy or down; free models are often rate-limited.
      fetch: fallbacks.length ? withFallbacks(fallbacks) : undefined,
    });
    // An indexing stage can run on its own endpoint (a local Ollama) while answers stay on the main one.
    // With free-only on, that endpoint must be on this machine, so nothing can be billed through it.
    const stageProvider = (stage: "SCREEN" | "EXTRACT" | "GRAPH") => {
      const url = process.env[`ALRO_${stage}_BASE_URL`];
      if (!url) return undefined;
      if (freeOnly && !isLocalUrl(url)) throw new Error(`ALRO_FREE_MODELS_ONLY is on, and ALRO_${stage}_BASE_URL (${new URL(url).host}) isn't on this machine.`);
      return createOpenAICompatible({ name: `local-${stage.toLowerCase()}`, baseURL: url, apiKey: process.env[`ALRO_${stage}_API_KEY`], supportsStructuredOutputs: true, includeUsage: true });
    };
    const chat = (id: string | undefined, stage?: "SCREEN" | "EXTRACT" | "GRAPH") => {
      if (!id) throw new Error("With ALRO_LLM_BASE_URL set, also set ALRO_SCREEN_MODEL (and optionally the other model ids).");
      const own = stage && stageProvider(stage);
      if (own) return own.chatModel(id);
      checkFree(id);
      return provider.chatModel(id);
    };
    const screen = process.env.ALRO_SCREEN_MODEL;
    return {
      screen: chat(screen, "SCREEN"),
      extract: chat(process.env.ALRO_EXTRACT_MODEL ?? screen, "EXTRACT"),
      graph: chat(process.env.ALRO_GRAPH_MODEL ?? process.env.ALRO_EXTRACT_MODEL ?? screen, "GRAPH"),
      answer: chat(process.env.ALRO_ANSWER_MODEL ?? screen),
      embed: provider.embeddingModel(process.env.ALRO_EMBEDDING_MODEL ?? "text-embedding-3-small"),
      embedDimensions: EMBEDDING_DIMS,
    };
  }
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

  return {
    screen: process.env.ALRO_SCREEN_MODEL ?? "anthropic/claude-haiku-5.5",
    extract: process.env.ALRO_EXTRACT_MODEL ?? "anthropic/claude-sonnet-5.5",
    graph: process.env.ALRO_GRAPH_MODEL ?? process.env.ALRO_EXTRACT_MODEL ?? "anthropic/claude-sonnet-5.5",
    answer: process.env.ALRO_ANSWER_MODEL ?? "anthropic/claude-sonnet-5.5",
    embed: process.env.ALRO_EMBEDDING_MODEL ?? "voyage/voyage-3.5",
    embedDimensions: EMBEDDING_DIMS,
  };
}

function isLocalUrl(url: string) {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Adds OpenRouter's `models` fallback list to each chat request, after the requested model. */
function withFallbacks(fallbacks: string[]): typeof fetch {
  return async (input, init) => {
    if (init?.body && typeof init.body === "string" && String(input).endsWith("/chat/completions")) {
      const body = JSON.parse(init.body) as { model?: string; models?: string[] };
      body.models = [body.model, ...fallbacks.filter((m) => m !== body.model)].filter((m): m is string => !!m).slice(0, 3);
      init = { ...init, body: JSON.stringify(body) };
    }
    return fetch(input, init);
  };
}

export const modelId = (model: LanguageModel | EmbeddingModel) => (typeof model === "string" ? model : model.modelId);

/** Logs one model call to llm_runs so cost per org and stage stays visible. */
export async function recordRun(
  db: Db,
  run: {
    orgId: string;
    stage: "screen" | "extract" | "graph" | "fulfil" | "embed" | "answer" | "rollup" | "notes" | "routine" | "profile" | "procedures" | "trackers" | "team" | "read";
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
  // The same numbers, added to today's usage for the company's plan limits.
  await bump(db, run.orgId, "tokens", (run.inputTokens ?? 0) + (run.outputTokens ?? 0));
  if (run.stage === "answer") await bump(db, run.orgId, "questions");
  if (run.stage === "team") await bump(db, run.orgId, "team_runs");
  if (run.stage === "routine") await bump(db, run.orgId, "routine_runs");
}
