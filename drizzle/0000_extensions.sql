-- pgvector for embeddings (halfvec), pg_trgm for fuzzy entity-name matching.
-- Both are available on Neon.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
