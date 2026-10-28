import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import type { Db } from "./client";
import * as schema from "./schema";

/** A fresh in-memory Postgres with every migration applied. For tests only. */
export async function createTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = await PGlite.create({ extensions: { vector, pg_trgm } });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return { db: db as unknown as Db, close: () => client.close() };
}
