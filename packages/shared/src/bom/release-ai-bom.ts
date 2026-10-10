/**
 * ADR-0189 slice B7 — OUR OWN install-scope AI BOM, per release.
 *
 * What a release of RegulAIt is made of, as an AI BOM: the install subject
 * (R20's nil key, no operator install id: a release is not an install), no
 * use cases, agents or tools (a fresh install holds none; a running install
 * takes its own snapshots through the gateway), the reviewed inventory of AI
 * tools that built it (`security/ai-dev-stack.json`, as CycloneDX
 * `formulation`), and a CycloneDX BOM-Link to ADR-0184's workspace and image
 * SBOMs of the SAME release, cited only from a signature-verified SBOM
 * identity file (R9).
 *
 * Built by B3's pure builder (`buildAiBom`), so every B3 invariant holds
 * (allowlisted records, email scan, schema validation, never `complete`).
 * Renderings: whatever `buildAiBom` produces. Today that is CycloneDX 1.7;
 * B5's SPDX renderer lands inside `buildAiBom`, and this step then carries
 * it with no change here (the seam is `AiBomBuild.renderings`).
 *
 * R28: the step is INERT until the R17 switch (`AI_BOM_SNAPSHOTS_RELEASED`)
 * flips. `runReleaseAiBomStep` is the ONLY exported entry: it returns
 * `{ status: "inert" }` and builds nothing while the switch is off. There is
 * no override; tests mock `./release-switch.js`. The CLI
 * (`scripts/release-ai-bom.mjs`) and `.github/workflows/release-ai-bom.yml`
 * read the same switch.
 *
 * Deterministic: the snapshot id is derived from the release commit, the
 * timestamp is the commit's own time, and no clock or randomness is read.
 */
import { createHash } from "node:crypto";
import { AI_BOM_INSTALL_SUBJECT_ID } from "./contract.js";
import { buildAiBom, type AiBomBuild } from "./ai-bom-builder.js";
import type { AiBomRecordSet } from "./ai-bom-records.js";
import { parseAiDevStackInventory } from "./ai-dev-stack.js";
import { releaseBuildSbomRecords, releaseCommitSchema, type ReleaseSbomIdentity } from "./release-sbom-identity.js";
import { AI_BOM_SNAPSHOTS_RELEASED } from "./release-switch.js";

export class ReleaseAiBomError extends Error {
  constructor(message: string) {
    super(`release ai-bom refused: ${message}`);
    this.name = "ReleaseAiBomError";
  }
}

/** the snapshot id of a release's AI BOM: a v8 UUID of SHA-256(`regulait:release-ai-bom:<commit>`) */
export function releaseAiBomSnapshotId(commit: string): string {
  if (!releaseCommitSchema.safeParse(commit).success) throw new ReleaseAiBomError("not a 40-hex release commit");
  const h = createHash("sha256").update(`regulait:release-ai-bom:${commit}`, "utf8").digest();
  h[6] = (h[6]! & 0x0f) | 0x80;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

export interface ReleaseAiBomInput {
  /** the 40-hex commit the release was built from */
  commit: string;
  /** the commit's own time, ISO-8601 UTC with milliseconds (never the wall clock) */
  committedAt: string;
  /** the parsed JSON of `security/ai-dev-stack.json` */
  inventory: unknown;
  /** this release's ADR-0184 SBOM files (exact bytes) and the signed image digest, or null when none are available */
  sboms: { imageDigest: string; workspace: Uint8Array; image: Uint8Array } | null;
}

/** the record set of our own release: install subject, dev-stack inventory, SBOM links derived from the SBOM bytes */
function releaseAiBomRecords(input: ReleaseAiBomInput): { records: AiBomRecordSet; identity: ReleaseSbomIdentity | null } {
  const inventory = parseAiDevStackInventory(input.inventory);
  let releaseSboms: AiBomRecordSet["releaseSboms"] = [];
  let identity: ReleaseSbomIdentity | null = null;
  if (input.sboms !== null) {
    ({ identity, records: releaseSboms } = releaseBuildSbomRecords({ commit: input.commit, ...input.sboms }));
  }
  return {
    identity,
    records: {
      subject: { kind: "install", id: AI_BOM_INSTALL_SUBJECT_ID },
      install: { installId: null },
      useCases: [], agents: [], customProviders: [], modelCards: [], modelCardApprovals: [], modelCardEvidence: [], evalRuns: [],
      evalDatasets: [], trainingDatasets: [], trainingJobs: [], trainingArtifacts: [], modelArtifacts: [], artifactScans: [],
      engineRuns: [], engines: [], promptTags: [], configVersions: [], mcpServers: [], mcpTools: [], connectors: [], grants: [],
      builderAgents: [], builderSkills: [], memoryStores: [],
      releaseSboms,
      devStackTools: inventory.tools,
    },
  };
}

export type ReleaseAiBomStepResult =
  | { status: "inert"; reason: "ai_bom_snapshots_not_released" }
  | { status: "built"; build: AiBomBuild; identity: ReleaseSbomIdentity | null; files: Array<{ name: string; bytes: string }> };

/**
 * THE RELEASE STEP (R28), the only exported build path. While the R17 switch
 * is off it returns `inert` and parses, builds and writes nothing.
 */
export function runReleaseAiBomStep(input: ReleaseAiBomInput): ReleaseAiBomStepResult {
  if (!AI_BOM_SNAPSHOTS_RELEASED) return { status: "inert", reason: "ai_bom_snapshots_not_released" };
  const ms = Date.parse(input.committedAt);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== input.committedAt) throw new ReleaseAiBomError("committedAt is not an ISO-8601 UTC time with milliseconds");
  const id = releaseAiBomSnapshotId(input.commit);
  const { records, identity } = releaseAiBomRecords(input);
  const build = buildAiBom(
    records,
    // R20: install subject, nil key. No dedicated trigger exists (adding one is a migration 0182 CHECK change), so a
    // release build is an on-demand snapshot; the commit is on the root as `regulait:release:commit` when linked.
    { id, subjectKind: "install", subjectId: AI_BOM_INSTALL_SUBJECT_ID, version: 1, supersedes: null, trigger: "on_demand", createdAt: input.committedAt },
    { cyclonedxVersions: ["1.7"] },
  );
  const files = [
    ...(identity ? [{ name: "release-sbom-identity.json", bytes: `${JSON.stringify(identity, null, 2)}\n` }] : []),
    { name: "ai-bom.native.json", bytes: build.bodyBytes },
    ...build.renderings.map((r) => ({ name: `ai-bom.${r.format}.json`, bytes: r.bytes })),
  ];
  return { status: "built", build, identity, files };
}
