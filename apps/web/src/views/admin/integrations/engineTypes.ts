/**
 * ADR-0187 (batch 5) — the engine admin routes' response shapes, as the
 * gateway sends them (AgentCoordination §4.10; `publicEngine` in
 * apps/gateway/src/engines.ts). Kept in its own file rather than appended to
 * `api/adminTypes.ts` so the parallel Batch 5 UI slices (X27 run views, X28
 * model artifacts) do not collide on one append point; they may import from here.
 */

export type EngineId = "promptfoo" | "modelscan" | "garak" | (string & {});
export type EngineKind = "redteam" | "model_scan" | (string & {});

/** the runner's own egress probe, from inside its container (every field must be false to pass) */
export interface EngineEgressProbe {
  host: string;
  dnsResolved: boolean;
  connected: boolean;
  address: string | null;
  addressConnected: boolean;
}

/** the engine's recorded self-test verdict (POST /v1/engines/:id/self-test answers the same shape) */
export interface EngineSelfTest {
  passed: boolean;
  failures: string[];
  runnerId: string | null;
  imageDigest: string | null;
  version: string | null;
  egress: EngineEgressProbe | null;
  at: string;
}

export interface EngineRunner {
  id: string;
  name: string;
  reportedDigest: string;
  reportedVersion: string;
  selfTestPassed: boolean | null;
  selfTestFailures: string[] | null;
  /** the report's own time, which the lease judges freshness by; absent from an older gateway */
  selfTestReportedAt?: string | null;
  registeredAt: string;
  lastSeenAt: string | null;
}

export interface EngineReducedSetItem {
  key: string;
  reason: string;
}

export interface Engine {
  id: EngineId;
  kind: EngineKind;
  displayName: string;
  version: string;
  imageDigest: string | null;
  /** the image is signed and verified in the engine's own PR; `not_built` until an image exists */
  signature: "not_built" | "unverified" | (string & {});
  licence: string;
  /** null until counted (G19) */
  maintainerCount: number | null;
  usageDataPosture: {
    switches: Record<string, string>;
    unverified: string[];
    airGappedReducedSet: EngineReducedSetItem[];
  } | null;
  lastVerified: string | null;
  reCheckBy: string | null;
  enabled: boolean;
  timeoutSeconds: number;
  maxBudgetUsd: number;
  maxConcurrent: number;
  selfTest: EngineSelfTest | null;
  selfTestPassedAt: string | null;
  needsModelAccess: boolean;
  airGappedReducedSet: EngineReducedSetItem[];
  unverified: string[];
  runners: EngineRunner[];
  lastRun: { id: string; status: string; createdAt: string } | null;
}

export interface EnginesResponse {
  engines: Engine[];
  taxonomyVersion: number;
}

/** PATCH /v1/engines/:engineId */
export interface EnginePatch {
  enabled?: boolean;
  timeoutSeconds?: number;
  maxBudgetUsd?: number;
  maxConcurrent?: number;
  /** ADR-0187 decision 79: sent only after the person accepts the gateway's credential-isolation refusal */
  acceptCredentialIsolationRisk?: true;
  /** B5W-07: the build accepted, exactly as the gateway's refusal named it (required with the acceptance) */
  expectedVersion?: string;
  expectedDigest?: string;
}

/** POST /v1/engines/:engineId/enrollment-tokens → 201 (the token is shown once) */
export interface EnrollmentTokenMinted {
  id: string;
  engineId: string;
  token: string;
  expiresAt: string;
}

/** DELETE /v1/engine-runners/:runnerId */
export interface RunnerRevoked {
  id: string;
  revokedAt: string;
  endedRuns: number;
}

/** GET /v1/detection-content (ADR-0186 V; a 501 `not_built` stub until that slice lands) */
export interface DetectionContentPack {
  id: string;
  source: string;
  commit: string;
  sha256: string;
  licence: string;
  rules: number;
  notImported: number;
  enabled: boolean;
}
