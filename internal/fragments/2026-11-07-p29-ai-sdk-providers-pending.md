<!-- fold: pending -->

**P29 — AI SDK provider packages as the vendor-neutral model layer (owner, 2026-11-07; SDK and platform review).**
Built ([ADR-0253](../decisions/0253-ai-sdk-provider-packages.md), #723). `@ai-sdk/provider` and `@ai-sdk/google`,
never the `ai` core or Vercel's AI Gateway. The hand-written Gemini adapter is replaced through one bridge; Anthropic,
OpenAI, xAI and custom stay on their official vendor SDKs, with the reason and re-check triggers recorded. Guards and
an egress test enforce the no-gateway rule. Open: whether pillar 5 should count Gemini `thoughtsTokenCount` and
`toolUsePromptTokenCount`, which have never been counted (a P21 usage-extractor decision, #453). P30–P33 from the same
review are added by other builders.
