import { describe, expect, it } from "vitest";
import { z } from "zod";
import { listOf } from "./tool-input";

describe("listOf", () => {
  const input = z.object({ status: listOf(["open", "overdue", "done"] as const).nullish() });

  it("accepts a list of allowed values", () => {
    expect(input.parse({ status: ["open", "overdue"] })).toEqual({ status: ["open", "overdue"] });
  });

  it("turns a single value into a list", () => {
    expect(input.parse({ status: "open" })).toEqual({ status: ["open"] });
  });

  it("drops values that aren't allowed, and falls back to the default when none are left", () => {
    expect(input.parse({ status: ["open", "late"] })).toEqual({ status: ["open"] });
    expect(input.parse({ status: "late" }).status).toBeUndefined();
  });

  it("leaves a missing or null field alone", () => {
    expect(input.parse({}).status).toBeUndefined();
    expect(input.parse({ status: null }).status).toBeNull();
  });
});
