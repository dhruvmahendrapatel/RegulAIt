# Third-party components — `@regulait/model-provider`

Open-source components this package ships or uses in its tests (ADR-0176 admission rules: MIT, Apache-2.0, BSD or
ISC; maintained; pinned; works air-gapped). npm dependencies are pinned exactly through `pnpm-lock.yaml`.

| Component | Version | Licence | Used for, and why |
|---|---|---|---|
| `@anthropic-ai/sdk` (npm, github.com/anthropics/anthropic-sdk-typescript, © Anthropic) | `0.113.0` (exact) | MIT | Anthropic Messages API client behind the Claude adapter in `src/index.ts`; base URL is configurable so BYOC/air-gapped deployments can point it at a private gateway. |
| `openai` (npm, github.com/openai/openai-node, © OpenAI) | `6.49.0` (exact) | Apache-2.0 | OpenAI-compatible chat/completions client behind the GPT and OpenAI-compatible adapters in `src/index.ts`; base URL is configurable for self-hosted and open-weight endpoints. |
| `@hyperjump/json-pointer` (npm, github.com/hyperjump-io/json-pointer, © Jason Desrosiers) | `1.1.3` (exact; released 2026-10-03) | MIT | ADR-0241 (P21): RFC 6901 JSON Pointer parsing and resolution for the admin-defined usage mapping in `src/usage-extractor.ts`, so pointer syntax, `~0`/`~1` escapes and array indexing are not hand-written. It reads own properties only (`Object.hasOwn`), so a pointer cannot reach a prototype. No dependencies, no install script, no runtime network use. Chosen over `jsonpointer` and `json-pointer` (no release since 2022, failing the maintenance rule), `json-ptr` (no release since 2022) and a JSONPath library (filters and script expressions are more than a bounded mapping needs; `jsonpath-plus` is in the lockfile only through `@kubernetes/client-node`). Version 1.1.3 rather than 2.0.x or 1.1.4, which were released in the week of adoption. |
| `@types/node` (npm, github.com/DefinitelyTyped/DefinitelyTyped) | `26.6.6` (exact devDependency) | MIT | Type definitions for the Node.js standard library used by the sources and tests; test/build-only, never in a shipped bundle. |
| `vitest` (npm, github.com/vitest-dev/vitest, © Anthony Fu and contributors) | `4.1.11` (exact devDependency) | MIT | Test runner for the `*.test.ts` files in `src/`; test-only, never in a shipped bundle. |
