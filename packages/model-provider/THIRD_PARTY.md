# Third-party components — `@regulait/model-provider`

Open-source components this package ships or uses in its tests (ADR-0176 admission rules: MIT, Apache-2.0, BSD or
ISC; maintained; pinned; works air-gapped). npm dependencies are pinned exactly through `pnpm-lock.yaml`.

| Component | Version | Licence | Used for, and why |
|---|---|---|---|
| `@anthropic-ai/sdk` (npm, github.com/anthropics/anthropic-sdk-typescript, © Anthropic) | `0.113.0` (exact) | MIT | Anthropic Messages API client behind the Claude adapter in `src/index.ts`; base URL is configurable so BYOC/air-gapped deployments can point it at a private gateway. |
| `openai` (npm, github.com/openai/openai-node, © OpenAI) | `6.49.0` (exact) | Apache-2.0 | OpenAI-compatible chat/completions client behind the GPT and OpenAI-compatible adapters in `src/index.ts`; base URL is configurable for self-hosted and open-weight endpoints. |
| `@ai-sdk/provider` (npm, github.com/vercel/ai, © Vercel) | `4.0.36` (exact) | Apache-2.0 | The AI SDK's vendor-neutral language-model specification (LanguageModelV4) that `src/ai-sdk-bridge.ts` maps our dispatch contract onto (ADR-0253). Types plus `APICallError`; no network code. |
| `@ai-sdk/google` (npm, github.com/vercel/ai, © Vercel) | `4.0.113` (exact) | Apache-2.0 | Gemini implementation of that spec behind the Google adapter in `src/google-ai-sdk.ts`, replacing our hand-written raw-fetch adapter (ADR-0176 rule 2, ADR-0253). Base URL, key and guarded fetch are always passed explicitly; no telemetry (that lives in the `ai` core, which we do not install). |
| `@ai-sdk/provider-utils` (npm, transitive via `@ai-sdk/google`, github.com/vercel/ai) | `5.0.75` (exact, lockfile) | Apache-2.0 | HTTP/JSON/SSE helpers the Google implementation calls; every request goes through the `fetch` we inject. Its `undici` download helper is only used for URL-referenced files, which our bridge never produces. |
| `undici` (npm, transitive via `@ai-sdk/provider-utils`, github.com/nodejs/undici) | `7.30.2` (exact, lockfile) | MIT | Loaded lazily by `@ai-sdk/provider-utils` for URL file downloads only; not on any path this package uses. |
| `@workflow/serde` (npm, transitive, github.com/vercel/workflow) | `4.1.0` (exact, lockfile) | Apache-2.0 | Serialization symbols the AI SDK classes declare; no I/O. |
| `eventsource-parser` (npm, transitive, github.com/rexxars/eventsource-parser) | `3.1.1` (exact, lockfile) | MIT | Parses Gemini's SSE stream for the streaming path. |
| `json-schema` (npm, transitive via `@ai-sdk/provider`) | `0.4.0` (exact, lockfile) | AFL-2.1 OR BSD-3-Clause (BSD-3-Clause elected) | Imported for its TypeScript types only; no runtime code reaches it. Unmaintained since 2021, accepted because it is type-only. |
| `zod` (npm, github.com/colinhacks/zod) | `4.6.7` (exact) | MIT | Peer dependency of `@ai-sdk/google` (response validation); the same version the rest of the repo pins. |
| `@types/node` (npm, github.com/DefinitelyTyped/DefinitelyTyped) | `26.6.6` (exact devDependency) | MIT | Type definitions for the Node.js standard library used by the sources and tests; test/build-only, never in a shipped bundle. |
| `vitest` (npm, github.com/vitest-dev/vitest, © Anthony Fu and contributors) | `4.1.11` (exact devDependency) | MIT | Test runner for the `*.test.ts` files in `src/`; test-only, never in a shipped bundle. |
