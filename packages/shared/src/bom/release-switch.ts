/**
 * ADR-0189 R2/R17/R28: THE AI BOM SNAPSHOT SWITCH. Not released.
 *
 * A code constant, never a setting. One definition for every reader: the
 * gateway's snapshot routes and automatic triggers (`apps/gateway/src/ai-bom.ts`
 * re-exports it) and B7's release-time install-scope AI BOM step
 * (`release-ai-bom.ts`, `scripts/release-ai-bom.mjs`, `security.yml` job
 * `release-ai-bom`). The PR that merges second of B4 (export-bundle/3) and B5
 * (SPDX) sets it to true, with tests that download every format as a verified
 * bundle. While it is false the release step produces no snapshot, signs
 * nothing and publishes nothing (R28).
 */
export const AI_BOM_SNAPSHOTS_RELEASED = false as boolean;
