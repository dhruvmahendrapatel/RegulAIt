# Third-party components — `@regulait/engine-admission-scan`

Open-source components this package ships or uses in its tests (ADR-0176 admission rules: MIT, Apache-2.0, BSD or
ISC; maintained; pinned; works air-gapped). npm dependencies are pinned exactly through `pnpm-lock.yaml`.

| Component | Version | Licence | Used for, and why |
|---|---|---|---|
| `zod` (npm, github.com/colinhacks/zod, © Colin McDonnell) | `4.6.7` (exact; ADR-0192) | MIT | Strict runtime schemas for the task's done file and the worker self-test report (`src/exchange.ts`, `src/selftest.ts`). |
| `@types/node` (npm, github.com/DefinitelyTyped/DefinitelyTyped) | `26.6.6` (exact devDependency) | MIT | Type definitions for the Node.js standard library used by the sources and tests; test/build-only, never in a shipped bundle. |
| `vitest` (npm, github.com/vitest-dev/vitest, © Anthony Fu and contributors) | `4.1.11` (exact devDependency) | MIT | Test runner for the `*.test.ts` files in `src/`; test-only, never in a shipped bundle. |

The engines themselves (Cisco mcp-scanner 4.8.7 and skill-scanner 2.3.2, Apache-2.0) and their Python closures are
not npm dependencies of this package: they ship in the images and are listed in `engines/mcpscanner/THIRD_PARTY.md`
and `engines/skillscanner/THIRD_PARTY.md`. This package writes only the governance parts (ADR-0176: open source
first): the runner (on `@regulait/engine-runner`'s protocol client, run loop and task bridge), the exchange, the
worker self-test and the in-sandbox task that starts our driver (`engines/<id>/scan.py`) and returns its report.
No existing module covers the RegulAIt runner/executor wire contract (ADR-0187, ADR-0190 I5), so none is replaced.
