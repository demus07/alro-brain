import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

/**
 * Prints a one-time link for someone to set a password and sign in.
 *   npm run auth:invite -- someone@company.com            (an existing member, or a new one in the only company)
 *   npm run auth:invite -- someone@company.com admin
 * For the first sign-in on a deployment whose data was loaded before sign-in existed.
 */
const { eq, sql } = await import("drizzle-orm");
const { getDb } = await import("../src/db/client");
const { orgs, people } = await import("../src/db/schema");
const { createInvitation } = await import("../src/auth/accounts");

const [email, role] = process.argv.slice(2);
if (!email) {
  console.error("Usage: npm run auth:invite -- someone@company.com [member|admin|owner]");
  process.exit(1);
}
const db = getDb();
const [known] = await db.select({ orgId: people.orgId, role: people.role }).from(people).where(sql`lower(${people.primaryEmail}) = ${email.toLowerCase()}`).limit(1);
const all = await db.select({ id: orgs.id, name: orgs.name }).from(orgs);
const orgId = known?.orgId ?? (all.length === 1 ? all[0].id : undefined);
if (!orgId) {
  console.error(all.length ? "Several companies exist and none knows that address. Invite them from the Admin page instead." : "No company exists yet. Open /sign-up to create one.");
  process.exit(1);
}
const [org] = await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, orgId));
const chosen = role === "owner" || role === "admin" || role === "member" ? role : known?.role === "owner" || known?.role === "admin" ? known.role : "member";
const { token } = await createInvitation(db, { orgId }, { email, role: chosen });
console.log(`${email} can join ${org.name} as ${chosen} here (works once, for 7 days):`);
console.log(`${(process.env.ALRO_APP_URL ?? "http://localhost:3000").replace(/\/$/, "")}/invite/${token}`);
process.exit(0);
