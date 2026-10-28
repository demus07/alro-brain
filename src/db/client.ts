import { attachDatabasePool } from "@vercel/functions";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

/** Any Drizzle Postgres database over our schema: Neon in production, PGlite in tests. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

let db: Db | undefined;

/** Connects as the table owner. Background jobs use this directly; user requests go through withScope(). */
export function getDb(): Db {
  if (!db) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    const pool = new Pool({ connectionString });
    // Lets Vercel Fluid compute close idle connections before a function is suspended.
    attachDatabasePool(pool);
    db = drizzle(pool, { schema });
  }
  return db;
}
