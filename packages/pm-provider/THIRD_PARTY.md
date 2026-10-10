# Third-party components — `@regulait/pm-provider`

Open-source components this package ships or uses in its tests (ADR-0176 admission rules: MIT, Apache-2.0, BSD or
ISC; maintained; pinned; works air-gapped). npm dependencies are pinned exactly through `pnpm-lock.yaml`.

| Component | Version | Licence | Used for, and why |
|---|---|---|---|
| `zod` (npm, github.com/colinhacks/zod, © Colin McDonnell) | `3.25.76` (exact) | MIT | Runtime schemas for `pmMappingSchema` and inbound PM-tool webhook payloads (`src/index.ts`, `src/inbound.ts`). |
| `@types/node` (npm, github.com/DefinitelyTyped/DefinitelyTyped) | `26.1.1` (exact devDependency) | MIT | Type definitions for the Node.js standard library used by the sources and tests; test/build-only, never in a shipped bundle. |
| `vitest` (npm, github.com/vitest-dev/vitest, © Anthony Fu and contributors) | `4.1.11` (exact devDependency) | MIT | Test runner for the `*.test.ts` files in `src/`; test-only, never in a shipped bundle. |
