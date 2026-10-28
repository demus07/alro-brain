/**
 * Loads the dummy two-founder dataset into the database in DATABASE_URL.
 *   npm run fixtures:load
 */
import { getDb } from "@/db/client";
import { loadFounderFixtures } from "@/ingest/fixtures";

const { orgId, results } = await loadFounderFixtures(getDb());
console.log(`org ${orgId}`);
for (const [source, r] of Object.entries(results)) {
  console.log(
    `${source.padEnd(15)} people ${r.people}  threads ${r.threads}  messages +${r.messages.inserted} (${r.messages.skipped} already there)`,
  );
}
process.exit(0);
