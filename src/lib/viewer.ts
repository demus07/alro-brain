import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { people } from "@/db/schema";
import type { Viewer } from "@/db/scope";

export interface SignedInViewer extends Viewer {
  displayName: string;
  email: string;
}

/**
 * The signed-in member. Authentication isn't built yet, so for local
 * development this acts as the member whose email is in ALRO_DEV_USER_EMAIL.
 * It refuses to run in production rather than serve data to anyone.
 */
export async function getViewer(): Promise<SignedInViewer> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Authentication is not configured. getViewer() only works in development.");
  }
  const email = process.env.ALRO_DEV_USER_EMAIL?.trim().toLowerCase();
  if (!email) throw new Error("Set ALRO_DEV_USER_EMAIL in .env.local to the member you want to act as.");
  const [person] = await getDb()
    .select({ orgId: people.orgId, personId: people.id, displayName: people.displayName, email: people.primaryEmail })
    .from(people)
    .where(and(eq(people.primaryEmail, email), eq(people.isMember, true)))
    .limit(1);
  if (!person) throw new Error(`No ALRO member with email ${email}. Run npm run fixtures:load or add one.`);
  return { ...person, email: person.email ?? email };
}
