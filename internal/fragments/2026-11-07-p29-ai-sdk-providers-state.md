<!-- fold: state-decisions -->
**ADR-0253 (builder, 2026-11-07, Accepted; owner backlog P29): the AI SDK provider packages under the model adapters.**
- **What:** `@ai-sdk/provider` 4.0.35 and `@ai-sdk/google` 4.0.109 (Apache-2.0, exact pins). `ai` and `@ai-sdk/gateway`
  are not installed, so no bare-string model id can reach Vercel's gateway. One bridge (`ai-sdk-bridge.ts`) maps the
  dispatch contract onto LanguageModelV4.
- **Google:** the hand-written raw-fetch adapter (about 410 lines) is replaced by `google-ai-sdk.ts`, after both paths
  ran the suite behind a switch. Usage, refusals, `modelVersion` and tool-call ids come from the raw response, so
  pillar 5/6 and audit see the same numbers.
- **Kept:** Anthropic, OpenAI, xAI and custom stay on their official vendor SDKs (not hand-written), with re-check
  triggers in the ADR. Shared runtime helpers moved to `src/core.ts` (no import cycle).
- **Guards:** `ai-sdk-guard.test.ts` fails on `ai` or `@ai-sdk/gateway`, a bare-string model id, a default provider
  instance, or a Vercel host. Its egress test proves the configured host is the only one reached, through the
  injected fetch, with no ambient-key fallback.
- **Open:** the Gemini thought and tool-use token counts for pillar 5 (P21, #453), and P21's `usageSource` field for
  the new Gemini adapter (whichever PR merges second).
