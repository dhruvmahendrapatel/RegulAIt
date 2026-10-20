/**
 * The Shadow AI import example (the evidence box's prefilled dry run). It names the demo's fictional provider (owner
 * decision on #453), never a real vendor; the demo seeder catalogues its host so the dry run still shows a match.
 *
 * The SPA does not depend on `@regulait/shared` at runtime, so the provider and host MIRROR
 * `DEMO_SHADOW_DISCOVERY.importExample` (packages/shared/src/demo-intake/shadow-discovery.ts).
 * `shadowAiExample.test.ts` imports the shared source and fails when they drift.
 */
export const IMPORT_EXAMPLE_PROVIDER = "Acme LLM";
export const IMPORT_EXAMPLE_HOST = "api.acme-llm.example";

export const IMPORT_EXAMPLE = {
  kind: "egress_log",
  mode: "dry_run",
  source: "acme forward proxy, week 31",
  rows: [{ observedAt: "2026-07-28T09:00:00Z", destinationHost: IMPORT_EXAMPLE_HOST, sourceIdentity: "build-runner-01", requestCount: 412 }],
};
