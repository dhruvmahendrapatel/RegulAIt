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
 * flips. `runReleaseAiBomStep` returns `{ status: "inert" }` and builds,
 * signs and writes nothing; the CLI (`scripts/release-ai-bom.mjs`) and the
 * `security.yml` job read the same switch. The `released` override exists for
 * the test harness only; the CLI never passes it.
 *
 * Deterministic: the snapshot id is derived from the release commit, the
 * timestamp is the commit's own time, and no clock or randomness is read.
 */
import { createHash } from "node:crypto";
import { AI_BOM_INSTALL_SUBJECT_ID } from "./contract.js";
import { buildAiBom, type AiBomBuild } from "./ai-bom-builder.js";
import type { AiBomRecordSet } from "./ai-bom-records.js";
import { parseAiDevStackInventory } from "./ai-dev-stack.js";
import { releaseCommitSchema, verifiedReleaseSbomRecords, type ReleaseSbomVerificationMethod } from "./release-sbom-identity.js";
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
  /** the parsed release SBOM identity file, or null when none is available */
  sbomIdentity: unknown;
  /** the outcome of the cosign check of the identity file's signature; ignored when `sbomIdentity` is null */
  sbomIdentityVerification: { signatureVerified: boolean; method: ReleaseSbomVerificationMethod } | null;
}

/** the record set of our own release: install subject, dev-stack inventory, verified SBOM links */
export function releaseAiBomRecords(input: ReleaseAiBomInput): AiBomRecordSet {
  const inventory = parseAiDevStackInventory(input.inventory);
  let releaseSboms: AiBomRecordSet["releaseSboms"] = [];
  if (input.sbomIdentity !== null) {
    if (!input.sbomIdentityVerification) throw new ReleaseAiBomError("an SBOM identity was given without its signature check (R9)");
    releaseSboms = verifiedReleaseSbomRecords(input.sbomIdentity, input.sbomIdentityVerification);
    if (releaseSboms.some((r) => r.releaseCommit !== input.commit)) throw new ReleaseAiBomError("the SBOM identity names another release commit");
  }
  return {
    subject: { kind: "install", id: AI_BOM_INSTALL_SUBJECT_ID },
    install: { installId: null },
    useCases: [], agents: [], customProviders: [], modelCards: [], modelCardApprovals: [], modelCardEvidence: [], evalRuns: [],
    evalDatasets: [], trainingDatasets: [], trainingJobs: [], trainingArtifacts: [], modelArtifacts: [], artifactScans: [],
    engineRuns: [], engines: [], promptTags: [], configVersions: [], mcpServers: [], mcpTools: [], connectors: [], grants: [],
    builderAgents: [], builderSkills: [], memoryStores: [],
    releaseSboms,
    devStackTools: inventory.tools,
  };
}

/** build our release's install-scope AI BOM (pure; no switch check: callers go through `runReleaseAiBomStep`) */
export function buildReleaseAiBom(input: ReleaseAiBomInput): AiBomBuild {
  const ms = Date.parse(input.committedAt);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== input.committedAt) throw new ReleaseAiBomError("committedAt is not an ISO-8601 UTC time with milliseconds");
  const id = releaseAiBomSnapshotId(input.commit);
  return buildAiBom(
    releaseAiBomRecords(input),
    // R20: install subject, nil key. No dedicated trigger exists (adding one is a migration 0182 CHECK change), so a
    // release build is an on-demand snapshot; the commit is on the root as `regulait:release:commit` when linked.
    { id, subjectKind: "install", subjectId: AI_BOM_INSTALL_SUBJECT_ID, version: 1, supersedes: null, trigger: "on_demand", createdAt: input.committedAt },
    { cyclonedxVersions: ["1.7"] },
  );
}

export type ReleaseAiBomStepResult =
  | { status: "inert"; reason: "ai_bom_snapshots_not_released" }
  | { status: "built"; build: AiBomBuild; files: Array<{ name: string; bytes: string }> };

/**
 * THE RELEASE STEP (R28). While the R17 switch is off it returns `inert` and
 * builds nothing. `released` is for the test harness's negative control only.
 */
export function runReleaseAiBomStep(input: ReleaseAiBomInput, opts: { released?: boolean } = {}): ReleaseAiBomStepResult {
  const released = opts.released ?? AI_BOM_SNAPSHOTS_RELEASED;
  if (!released) return { status: "inert", reason: "ai_bom_snapshots_not_released" };
  const build = buildReleaseAiBom(input);
  const files = [
    { name: "ai-bom.native.json", bytes: build.bodyBytes },
    ...build.renderings.map((r) => ({ name: `ai-bom.${r.format}.json`, bytes: r.bytes })),
  ];
  return { status: "built", build, files };
}
