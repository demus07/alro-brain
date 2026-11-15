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
    // The local PGlite server is a single session shared by every connection, so one request's
    // `set local role` would leak into another's queries; DATABASE_POOL_MAX=1 serialises them.
    const max = Number(process.env.DATABASE_POOL_MAX) || undefined;
    const pool = new Pool({ connectionString, max });
    // Lets Vercel Fluid compute close idle connections before a function is suspended.
    attachDatabasePool(pool);
    db = drizzle(pool, { schema });
  }
  return db;
}
