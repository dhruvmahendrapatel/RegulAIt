# Third-party components — `@regulait/engine-fairlearn`

Open-source components this package ships or uses in its tests (ADR-0176 admission rules: MIT, Apache-2.0, BSD or
ISC; maintained; pinned; works air-gapped). npm dependencies are pinned exactly through `pnpm-lock.yaml`.

| Component | Version | Licence | Used for, and why |
|---|---|---|---|
| `zod` (npm, github.com/colinhacks/zod, © Colin McDonnell) | `4.6.7` (exact; ADR-0192) | MIT | Strict runtime schemas for the fairlearn job, the done file, the metric step's output and the worker's self-test (`src/exchange.ts`, `src/metrics.ts`, `src/selftest.ts`); the input and result schemas are the shared contract's. |
| `@types/node` (npm, github.com/DefinitelyTyped/DefinitelyTyped) | `26.6.6` (exact devDependency) | MIT | Type definitions for the Node.js standard library used by the sources and tests; test/build-only, never in a shipped bundle. |
| `vitest` (npm, github.com/vitest-dev/vitest, © Anthony Fu and contributors) | `4.1.12` (exact devDependency) | MIT | Test runner for the `*.test.ts` files in `src/`; test-only, never in a shipped bundle. |

The engine itself (fairlearn 0.15.0, MIT) and its Python closure are not npm dependencies of this package: they ship in
the image and are listed in `engines/fairlearn/THIRD_PARTY.md`. The metrics are fairlearn's own (`fairlearn.metrics`,
run by `engines/fairlearn/fairlearn_metrics.py`); the reply mapping and the small-group suppression are the shared
package's (`mapFairnessReply`, `suppressSmallGroups`, the gateway's own functions). This package writes only the
governance parts: the plan and job, the gateway-only calls, the runner/task exchange (on engine-runner's `JobExchange`),
the worker's self-test (on engine-runner's shared worker self-test) and the adapter (ADR-0176: open source first; the
HTTP client is Node's built-in `fetch`, the process runner engine-runner's `runProcessGroup`).
