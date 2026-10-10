# Third-party components — `@regulait/engine-modelscan`

Open-source components this package ships or uses in its tests (ADR-0176 admission rules: MIT, Apache-2.0, BSD or
ISC; maintained; pinned; works air-gapped). npm dependencies are pinned exactly through `pnpm-lock.yaml`.

| Component | Version | Licence | Used for, and why |
|---|---|---|---|
| `zod` (npm, github.com/colinhacks/zod, © Colin McDonnell) | `3.25.76` (exact) | MIT | Strict runtime schemas for the ModelScan exchange and self-test payloads (`src/exchange.ts`, `src/selftest.ts`). |
| `@types/node` (npm, github.com/DefinitelyTyped/DefinitelyTyped) | `26.1.1` (exact devDependency) | MIT | Type definitions for the Node.js standard library used by the sources and tests; test/build-only, never in a shipped bundle. |
| `smol-toml` (npm, github.com/squirrelchat/smol-toml, © Cynthia Rey) | `1.9.0` (exact devDependency) | BSD-3-Clause | Parses the generated ModelScan settings TOML in `src/settings.test.ts` to check it round-trips against `MODELSCAN_SETTINGS`; test-only. |
| `vitest` (npm, github.com/vitest-dev/vitest, © Anthony Fu and contributors) | `4.1.11` (exact devDependency) | MIT | Test runner for the `*.test.ts` files in `src/`; test-only, never in a shipped bundle. |
