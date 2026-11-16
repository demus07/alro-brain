import { beforeAll, describe, expect, it, vi } from "vitest";
import { seal, sign, unseal, verify } from "./secrets";

beforeAll(() => {
  process.env.ALRO_SECRET_KEY = Buffer.alloc(32, 7).toString("base64");
});

describe("secrets", () => {
  it("encrypts a value so the token isn't readable, and gives it back", () => {
    const sealed = seal({ token: "xoxb-very-secret" });
    expect(sealed).not.toContain("xoxb");
    expect(unseal(sealed)).toEqual({ token: "xoxb-very-secret" });
    expect(seal({ token: "xoxb-very-secret" })).not.toBe(sealed);
  });

  it("refuses a tampered value", () => {
    const [v, iv, tag, body] = seal({ a: 1 }).split(".");
    const flipped = Buffer.from(body, "base64url");
    flipped[0] ^= 1;
    expect(() => unseal([v, iv, tag, flipped.toString("base64url")].join("."))).toThrow();
  });

  it("signs state that expires and can't be edited", () => {
    const token = sign({ p: "gmail", u: "me" }, 1000, 0);
    expect(verify(token, 500)).toMatchObject({ p: "gmail", u: "me" });
    expect(verify(token, 1500)).toBeUndefined();
    const [body, mac] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ p: "gmail", u: "someone-else", exp: 9e15 })).toString("base64url");
    expect(verify(`${forged}.${mac}`, 500)).toBeUndefined();
    expect(verify(`${body}.AAAA`, 500)).toBeUndefined();
    expect(verify(undefined)).toBeUndefined();
  });
});

describe("rotating the key", () => {
  it("reads secrets sealed with the previous key until they're re-sealed", async () => {
    const { seal, unseal } = await import("./secrets");
    const oldKey = Buffer.alloc(32, 1).toString("base64");
    const newKey = Buffer.alloc(32, 2).toString("base64");
    vi.stubEnv("ALRO_SECRET_KEY", oldKey);
    const sealed = seal({ token: "abc" });
    vi.stubEnv("ALRO_SECRET_KEY", newKey);
    expect(() => unseal(sealed)).toThrow();
    vi.stubEnv("ALRO_SECRET_KEY_PREVIOUS", oldKey);
    expect(unseal(sealed)).toEqual({ token: "abc" });
    const resealed = seal(unseal(sealed));
    vi.stubEnv("ALRO_SECRET_KEY_PREVIOUS", "");
    expect(unseal(resealed)).toEqual({ token: "abc" });
    vi.unstubAllEnvs();
  });
});
