import type { LanguageModelUsage } from "ai";

/**
 * USD per 1M tokens (input, cached input, output), from the providers' price pages.
 * Unknown models count as free, so a missing entry shows up as a cost of 0, not a crash.
 */
const PRICES: Record<string, { input: number; cached: number; output: number }> = {
  "gpt-6-luna": { input: 0.1, cached: 0.01, output: 0.5 },
  "gpt-6.1-terra": { input: 1, cached: 0.1, output: 5 },
  "gpt-6.1-sol": { input: 2, cached: 0.2, output: 10 },
};

export const priceKnown = (modelId: string) => modelId in PRICES;

/** What a call cost, in USD. */
export function costOf(modelId: string, usage: Pick<LanguageModelUsage, "inputTokens" | "outputTokens" | "inputTokenDetails">): number {
  const p = PRICES[modelId];
  if (!p) return 0;
  const cached = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const fresh = (usage.inputTokens ?? 0) - cached;
  return (fresh * p.input + cached * p.cached + (usage.outputTokens ?? 0) * p.output) / 1e6;
}
