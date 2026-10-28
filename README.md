# ALRO Brain

The company-brain app behind ALRO. See [docs/PLAN.md](docs/PLAN.md) for the architecture and roadmap.

## Develop

```sh
npm install
cp .env.example .env.local   # DATABASE_URL for a Neon database
npm test                     # schema + access-control tests on in-memory Postgres (PGlite)
npm run dev
```

## Database

- Schema: `src/db/schema.ts`. After changing it, run `npm run db:generate`.
- Hand-written migrations (extensions, row-level security, ACL triggers) live alongside the generated ones in `drizzle/`.
- Apply to Neon with `npm run db:migrate`.
- Background jobs use `getDb()` and must filter by `org_id`. Anything answering a user must use `withScope()` from `src/db/scope.ts`.
