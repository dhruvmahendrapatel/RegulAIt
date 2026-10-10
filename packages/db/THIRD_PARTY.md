# Third-party components — `@regulait/db`

Open-source components this package ships or uses in its tests (ADR-0176 admission rules: MIT, Apache-2.0, BSD or
ISC; maintained; pinned; works air-gapped). npm dependencies are pinned exactly through `pnpm-lock.yaml`.

| Component | Version | Licence | Used for, and why |
|---|---|---|---|
| `drizzle-orm` (npm, github.com/drizzle-team/drizzle-orm, © Drizzle Team) | `0.45.3` (exact) | Apache-2.0 | Type-safe SQL query builder and schema layer over `pg` (`src/index.ts`, `src/schema.ts`, audit-chain and BOM-lock queries); runs in process with no network of its own. |
| `pg` (npm, github.com/brianc/node-postgres, © Brian Carlson) | `8.23.1` (exact) | MIT | PostgreSQL client pool that `drizzle-orm/node-postgres` drives in `src/index.ts`; the only connection to the database. |
| `@types/node` (npm, github.com/DefinitelyTyped/DefinitelyTyped) | `26.1.1` (exact devDependency) | MIT | Type definitions for the Node.js standard library used by the sources and tests; test/build-only, never in a shipped bundle. |
| `@types/pg` (npm, github.com/DefinitelyTyped/DefinitelyTyped) | `8.23.1` (exact devDependency) | MIT | Type definitions for `pg`; build-only. |
| `drizzle-kit` (npm, github.com/drizzle-team/drizzle-orm, © Drizzle Team) | `0.31.11` (exact devDependency) | MIT | Developer tooling configured in `drizzle.config.ts` (schema introspection, `drizzle-kit check`); migrations in `migrations/` are hand-written and `drizzle-kit generate` is never run (CLAUDE.md, CONTRIBUTING_PARALLEL_SESSIONS.md §4). Never shipped or run at runtime. |
