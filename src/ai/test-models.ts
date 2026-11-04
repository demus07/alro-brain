import { createHash } from "node:crypto";
import { MockEmbeddingModelV4, MockLanguageModelV4 } from "ai/test";
import { EMBEDDING_DIMS } from "@/db/schema";
import type { Models } from "./models";

/**
 * Deterministic bag-of-words embedding for tests: each word lights up one
 * dimension, so texts sharing words are close. No network, no keys.
 */
export function wordVector(text: string): number[] {
  const v = new Array<number>(EMBEDDING_DIMS).fill(0);
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []) {
    v[createHash("md5").update(word).digest().readUInt32BE(0) % EMBEDDING_DIMS] += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

export const mockEmbeddingModel = () =>
  new MockEmbeddingModelV4({
    maxEmbeddingsPerCall: 100,
    doEmbed: async ({ values }) => ({
      embeddings: values.map((v) => wordVector(String(v))),
      usage: { tokens: values.length },
      warnings: [],
    }),
  });

type Prompt = Parameters<MockLanguageModelV4["doGenerate"]>[0]["prompt"];

/** The text of a mock call's prompt, for assertions and for scripted replies. */
export const promptText = (prompt: Prompt) =>
  prompt
    .flatMap((m) => (typeof m.content === "string" ? [m.content] : m.content.map((p) => ("text" in p ? p.text : ""))))
    .join("\n");

/** A language model that answers each call with `reply(promptText)`, as JSON when given an object. */
export function scriptedModel(reply: (prompt: string) => unknown) {
  return new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      const out = reply(promptText(prompt));
      return {
        content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out) }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 20, text: 20, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
}

export function testModels(overrides: Partial<Models> = {}): Models {
  const unused = scriptedModel(() => {
    throw new Error("This test didn't expect a language model call");
  });
  return {
    screen: unused,
    extract: unused,
    graph: unused,
    answer: unused,
    embed: mockEmbeddingModel(),
    embedDimensions: EMBEDDING_DIMS,
    ...overrides,
  };
}
