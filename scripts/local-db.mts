/**
 * A local Postgres for development, with pgvector and pg_trgm, no install needed:
 * PGlite (Postgres compiled to WebAssembly) served over the Postgres protocol.
 *   npm run db:local     # then DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres
 * Data lives in .data/pg (gitignored). For production use Neon or any Postgres with pgvector.
 */
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { mkdirSync } from "node:fs";

const dataDir = process.env.ALRO_LOCAL_DB_DIR ?? ".data/pg";
const port = Number(process.env.ALRO_LOCAL_DB_PORT ?? 54329);
mkdirSync(dataDir, { recursive: true });

const db = await PGlite.create({ dataDir, extensions: { vector, pg_trgm } });
const server = new PGLiteSocketServer({ db, host: "127.0.0.1", port, maxConnections: 30 });
await server.start();
console.log(`Local Postgres ready: postgres://postgres@127.0.0.1:${port}/postgres (data in ${dataDir})`);

const stop = async () => {
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
