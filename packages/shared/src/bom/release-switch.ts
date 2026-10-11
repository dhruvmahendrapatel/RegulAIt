/**
 * ADR-0189 R2/R17/R28: THE AI BOM SNAPSHOT SWITCH. RELEASED.
 *
 * A code constant, never a setting. One definition for every reader: the
 * gateway's snapshot routes and automatic triggers (`apps/gateway/src/ai-bom.ts`
 * re-exports it) and B7's release-time install-scope AI BOM step
 * (`release-ai-bom.ts`, `scripts/release-ai-bom.mjs`, `security.yml` job
 * `release-ai-bom`). B5 (SPDX, #297) and B4 (export-bundle/3, #344) have both
 * merged, so it is true (the R17 release PR, the master's ruling on #344): every
 * v1 renderer exists and every download is a verified `export-bundle/3`
 * (`zz-adr0189-r17-release.test.ts` downloads every format and verifies it with
 * the shared verifier and `scripts/verify-bom.mjs`). Were it ever false again,
 * the release step would produce no snapshot, sign nothing and publish nothing
 * (R28).
 */
export const AI_BOM_SNAPSHOTS_RELEASED = true as boolean;
