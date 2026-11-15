import { beforeAll, describe, expect, it } from "vitest";
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
