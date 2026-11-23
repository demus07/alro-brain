import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultModels, modelId } from "./models";

describe("free models only", () => {
  afterEach(() => vi.unstubAllEnvs());
  const openRouter = (model: string, fallbacks = "") => {
    vi.stubEnv("ALRO_LLM_BASE_URL", "https://openrouter.ai/api/v1");
    vi.stubEnv("ALRO_FREE_MODELS_ONLY", "true");
    vi.stubEnv("ALRO_LLM_FALLBACK_MODELS", fallbacks);
    for (const k of ["ALRO_SCREEN_MODEL", "ALRO_EXTRACT_MODEL", "ALRO_GRAPH_MODEL", "ALRO_ANSWER_MODEL"]) vi.stubEnv(k, model);
  };

  it("uses free models", () => {
    openRouter("nvidia/nemotron-3.5-super-vl:free", "particle-ai/particle-1:free");
    expect(modelId(defaultModels().answer)).toBe("nvidia/nemotron-3.5-super-vl:free");
  });

  it("lets an indexing stage run on a local endpoint, and only a local one", () => {
    openRouter("nvidia/nemotron-3.5-super-vl:free");
    vi.stubEnv("ALRO_SCREEN_MODEL", "gemma2:2b");
    vi.stubEnv("ALRO_SCREEN_BASE_URL", "http://127.0.0.1:11434/v1");
    const models = defaultModels();
    expect(modelId(models.screen)).toBe("gemma2:2b");
    expect(modelId(models.answer)).toBe("nvidia/nemotron-3.5-super-vl:free");
    vi.stubEnv("ALRO_SCREEN_BASE_URL", "https://api.example.com/v1");
    expect(() => defaultModels()).toThrow("isn't on this machine");
    vi.stubEnv("ALRO_SCREEN_BASE_URL", "http://localhost.evil.com/v1");
    expect(() => defaultModels()).toThrow("isn't on this machine");
  });

  it("refuses to start with a model that could be billed, including a fallback", () => {
    openRouter("openai/gpt-6-luna");
    expect(() => defaultModels()).toThrow("isn't a free model");
    openRouter("nvidia/nemotron-3.5-super-vl:free", "anthropic/claude-sonnet-5.5");
    expect(() => defaultModels()).toThrow("isn't a free model");
  });
});
