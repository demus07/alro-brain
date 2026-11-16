import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
export const MIN_PASSWORD_LENGTH = 10;

const derive = (password: string, salt: Buffer, n: number, r: number, p: number) =>
  new Promise<Buffer>((resolve, reject) => scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, { N: n, r, p }, (err, key) => (err ? reject(err) : resolve(key))));

/** "scrypt$<N>$<r>$<p>$<salt>$<hash>", so the cost can be raised later without breaking old hashes. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = (stored ?? "").split("$");
  if (scheme !== "scrypt" || !salt || !hash) {
    // Spend the same time as a real check, so a missing account can't be told from a wrong password.
    await derive(password, Buffer.alloc(16), N, R, P);
    return false;
  }
  const expected = Buffer.from(hash, "base64url");
  const given = await derive(password, Buffer.from(salt, "base64url"), Number(n), Number(r), Number(p));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Why a password is refused, or undefined when it's acceptable. */
export function passwordProblem(password: string): string | undefined {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > 200) return "That's too long.";
  if (/^(.)\1+$/.test(password) || /^(password|12345678|qwertyuiop)/i.test(password)) return "That's too easy to guess.";
  return undefined;
}
