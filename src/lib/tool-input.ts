import { z } from "zod";

/**
 * A tool input that takes a list of allowed values, forgiving the slips models make with it:
 * a single value instead of a list ("open" → ["open"]) and values that aren't allowed (dropped).
 * If nothing allowed is left, the field counts as not given, so the tool uses its default.
 * Models still see a plain list of the allowed values in the tool's schema.
 */
export function listOf<T extends readonly [string, ...string[]]>(values: T) {
  return z.preprocess((value) => {
    if (value == null) return value;
    const allowed = (Array.isArray(value) ? value : [value]).filter((v) => (values as readonly unknown[]).includes(v));
    return allowed.length ? allowed : undefined;
  }, z.array(z.enum(values)).optional());
}
