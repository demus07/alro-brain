import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

/**
 * Re-encrypts stored connector tokens and sign-ins with a new ALRO_SECRET_KEY.
 * Before running: move the old key to ALRO_SECRET_KEY_PREVIOUS and set the new ALRO_SECRET_KEY.
 * Afterwards remove ALRO_SECRET_KEY_PREVIOUS.
 */
const { getDb } = await import("../src/db/client");
const { rotateSecrets } = await import("../src/lib/secrets");

if (!process.env.ALRO_SECRET_KEY_PREVIOUS) {
  console.error("Set ALRO_SECRET_KEY_PREVIOUS to the old key and ALRO_SECRET_KEY to the new one first.");
  process.exit(1);
}
const { total, resealed } = await rotateSecrets(getDb());
console.log(`${resealed} of ${total} secrets re-encrypted with the new key. You can now remove ALRO_SECRET_KEY_PREVIOUS.`);
process.exit(0);
