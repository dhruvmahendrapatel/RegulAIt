/**
 * ADR-0187 (batch 5) — THE SIDECAR ENGINE CONTRACT, pure half.
 *
 * One contract for every external engine that runs as its own process (PF-23):
 * a runner container per engine leases work from the gateway over an
 * internal-only network, runs the tool, and posts one normalised result
 * envelope. This file holds what the gateway, the runner core and the web
 * share: the vocabularies (kept in lockstep with the DB CHECKs of migration
 * 0173), the runner route allow-list, the token prefixes, the request bodies
 * and the strict `regulait.engine-result.v1` envelope with its size caps. It
 * decides nothing at request time.
 *
 * NOT-CLEAN SEMANTICS (ADR-0187 "The contract"): an engine error is `unknown`
 * or `not_run`, never a pass. The envelope only REPORTS; the server recomputes
 * every verdict and aggregate (`normaliseEngineResult`, normalise.ts) and never
 * trusts the engine's own totals. The envelope carries no model text: the
 * gateway already holds every model call by its dispatch audit id.
 *
 * Does not import the package barrel (index.ts re-exports this file).
 */
import { z } from "zod";
import { RED_TEAM_SEVERITIES } from "../redteam.js";

// ---------------------------------------------------------------------------
// Vocabularies (each mirrors a CHECK in migration 0173)
// ---------------------------------------------------------------------------

/** the engines this build knows (`engines.id`); an admin cannot add one */
export const ENGINE_IDS = ["promptfoo", "modelscan", "garak"] as const;
export type EngineId = (typeof ENGINE_IDS)[number];

/** what an engine measures (`engines.kind`) */
export const ENGINE_KINDS = ["redteam", "eval", "model_scan"] as const;
export type EngineKind = (typeof ENGINE_KINDS)[number];

/**
 * An engine run's life (`engine_runs.status`). `awaiting_approval` and `queued`
 * hold no key; `leased` holds the run-scoped virtual key; every other value is
 * terminal and the key is revoked.
 */
export const ENGINE_RUN_STATUSES = [
  "awaiting_approval",
  "queued",
  "leased",
  "completed",
  "failed",
  "timeout",
  "cancelled",
  "not_run",
] as const;
export type EngineRunStatus = (typeof ENGINE_RUN_STATUSES)[number];
export const ENGINE_TERMINAL_RUN_STATUSES = ["completed", "failed", "timeout", "cancelled", "not_run"] as const;
export type EngineTerminalRunStatus = (typeof ENGINE_TERMINAL_RUN_STATUSES)[number];
export function isTerminalEngineRunStatus(s: string): s is EngineTerminalRunStatus {
  return (ENGINE_TERMINAL_RUN_STATUSES as readonly string[]).includes(s);
}

/** the status a runner reports in its envelope */
export const ENGINE_RESULT_STATUSES = ENGINE_TERMINAL_RUN_STATUSES;
export type EngineResultStatus = EngineTerminalRunStatus;

/** how a run was started (`engine_runs.trigger`); owner decision 4: all three */
export const ENGINE_RUN_TRIGGERS = ["manual", "workflow", "scheduled"] as const;
export type EngineRunTrigger = (typeof ENGINE_RUN_TRIGGERS)[number];

/** one item's verdict. Only `pass` is clean; `unknown` and `not_run` never are. */
export const ENGINE_ITEM_VERDICTS = ["pass", "fail", "unknown", "not_run"] as const;
export type EngineItemVerdict = (typeof ENGINE_ITEM_VERDICTS)[number];

/** why an item did not run */
export const ENGINE_NOT_RUN_REASONS = [
  "cloud_only",
  "excluded_licence",
  "egress_denied",
  "unsupported_format",
  "missing_preseed",
  "engine_error",
] as const;
export type EngineNotRunReason = (typeof ENGINE_NOT_RUN_REASONS)[number];

/**
 * a model-artifact scan's verdict (`artifact_scans.verdict`); only `clean` is clean. B5-M (migration
 * 0175; owner decision 2026-10-09, ADR-0187 decision 105): `no_known_unsafe` = an executable format in which
 * modelscan found no known-unsafe operator. It is never clean and never admissible.
 */
export const ARTIFACT_SCAN_VERDICTS = ["clean", "no_known_unsafe", "unsafe", "unknown", "not_run"] as const;
export type ArtifactScanVerdict = (typeof ARTIFACT_SCAN_VERDICTS)[number];

/** what a run targets (`engine_runs.target_kind`) */
export const ENGINE_TARGET_KINDS = ["agent", "artifact"] as const;
export type EngineTargetKind = (typeof ENGINE_TARGET_KINDS)[number];

/** a runner's heartbeat phase */
export const ENGINE_RUN_PHASES = ["starting", "running", "uploading"] as const;
export type EngineRunPhase = (typeof ENGINE_RUN_PHASES)[number];

/** the version tag of the result envelope */
export const ENGINE_RESULT_VERSION = "regulait.engine-result.v1";

/** the virtual-key purpose a run's model calls ride (`virtual_keys.purpose`) */
export const ENGINE_VIRTUAL_KEY_PURPOSE = "engine";

/** what every batch-5 route that is not built yet answers */
export const BATCH5_NOT_BUILT = { error: "not_built" } as const;

// ---------------------------------------------------------------------------
// Runner credentials and the route allow-list
// ---------------------------------------------------------------------------

/** the plaintext prefix of a runner token (only its sha256 is stored) */
export const ENGINE_RUNNER_TOKEN_PREFIX = "rge_";
/** the plaintext prefix of a one-time enrolment token (only its sha256 is stored) */
export const ENGINE_ENROLLMENT_TOKEN_PREFIX = "rgee_";

/**
 * THE RUNNER TOKEN'S ENTIRE WORLD (ADR-0187 "Runner API"). A runner token
 * reaches exactly these routes and nothing else; an enrolment token reaches only
 * the register route. Both are allow-lists: a route added tomorrow is
 * unreachable on either credential until it is named here. No other credential
 * reaches these routes (a human or an API key cannot lease work).
 */
export const ENGINE_RUNNER_ROUTES = [
  "POST /v1/engine-runner/lease",
  // PR #205 review [53]: a runner refreshes its own self-test report (the lease refuses a stale one)
  "POST /v1/engine-runner/self-test",
  "POST /v1/engine-runner/runs/:runId/heartbeat",
  "GET /v1/engine-runner/artifacts/:artifactId",
  "POST /v1/engine-runner/runs/:runId/result",
] as const;
export const ENGINE_ENROLLMENT_ROUTES = ["POST /v1/engine-runner/register"] as const;

/** how long a lease lives without a heartbeat (seconds) */
export const ENGINE_LEASE_TTL_SECONDS = 90;
/** how long a queued run waits for a runner before it ends `not_run` (seconds) */
export const ENGINE_QUEUE_TTL_SECONDS = 24 * 3600;
/** a runner self-test older than this does not admit enabling the engine (seconds) */
export const ENGINE_SELF_TEST_MAX_AGE_SECONDS = 24 * 3600;
/** an enrolment token's lifetime bounds (minutes) */
export const ENGINE_ENROLLMENT_TTL_MINUTES = { min: 1, max: 60, default: 15 } as const;

// ---------------------------------------------------------------------------
// Refusal codes (AgentCoordination §4.10), with the HTTP status of each
// ---------------------------------------------------------------------------

export const ENGINE_REFUSALS = {
  /** a runner or enrolment token used outside its route allow-list */
  engine_runner_scope: 403,
  /** a runner route reached with anything but a runner token */
  engine_runner_token_required: 401,
  /** an enrolment token unknown, used, expired, or for another engine */
  engine_enrollment_invalid: 401,
  /** a runner token revoked */
  engine_runner_revoked: 401,
  /** the engine is off: no lease, no run */
  engine_disabled: 409,
  /** enabling without a passing, fresh self-test; or a runner whose own report is stale or failing */
  engine_self_test_required: 409,
  /** PR #205 review round 9 [79]: enabling a build that does not isolate the runner credential, without accepting that risk */
  engine_credential_isolation_missing: 409,
  /** PR #205 review round 12 [91]: a registration of a build that is not the current manifest build */
  engine_runner_build_obsolete: 409,
  /** PR #205 review round 12 [91]: an admin self-test with no live runner of the current build */
  engine_no_current_build_runner: 409,
  /** PR #205 review round 13 [95]: this gateway replica's manifest is older than the installed engine row (transient: no `next`) */
  engine_manifest_outdated: 409,
  /** PR #205 review round 8 [77]: a registration whose token hash is already a runner's credential */
  engine_runner_already_registered: 409,
  /** PR #205 review round 5 [67]: a runner presenting a build other than the one it registered with */
  engine_runner_reenrol_required: 409,
  /** PR #205 review round 5 [70]: a target or judge agent with no provider model to dispatch to */
  agent_not_dispatchable: 422,
  /** PR #205 review round 6 [73]: an agent run of an engine whose manifest says `requiresJudge`, with no judge */
  judge_required: 422,
  /** a run, heartbeat or result for a run this runner does not hold */
  engine_run_not_leased: 409,
  /** a result for a run that already ended (late) */
  engine_run_finished: 409,
  /** a run budget above the engine's ceiling */
  engine_budget_exceeds_ceiling: 422,
  /** a target this engine cannot take (an artifact for a red-team engine, …) */
  engine_target_mismatch: 422,
  /** an over-threshold or sensitive run with nobody to approve it */
  engine_approver_required: 422,
  /** a result envelope that is not a valid regulait.engine-result.v1 */
  engine_result_invalid: 422,
  /** a virtual-key call whose project header is not the key's project */
  virtual_key_project_mismatch: 403,
  /** B5-M: an artifact upload over the org's size limit */
  artifact_too_large: 413,
  /** B5-M: an artifact upload that is not `application/octet-stream` */
  artifact_content_type: 415,
  /** B5-M: no artifact store is configured on this gateway (nothing is accepted) */
  artifact_store_unavailable: 503,
  /** B5-M: an artifact the caller did not upload (and is not an admin for) */
  artifact_not_accessible: 403,
  /** B5-M: a runner asking for an artifact its leased run does not target */
  engine_artifact_not_leased: 409,
} as const;
export type EngineRefusalCode = keyof typeof ENGINE_REFUSALS;

// ---------------------------------------------------------------------------
// The result envelope (regulait.engine-result.v1)
// ---------------------------------------------------------------------------

/** caps: the whole POST body, and every list and string inside it */
export const ENGINE_RESULT_LIMITS = {
  maxBodyBytes: 5 * 1024 * 1024,
  maxItems: 5000,
  maxNotRun: 5000,
  maxKeyChars: 200,
  maxSourceSystemChars: 64,
  maxSourceIdChars: 200,
  maxReasonChars: 1000,
  /** attempts per item: the governed trial limit (RED_TEAM_MAX_TRIALS), so no envelope can expand into millions of trials */
  maxAttempts: 25,
  maxDispatchIdsPerItem: 100,
  maxRawReportBytes: 3 * 1024 * 1024,
} as const;

const L = ENGINE_RESULT_LIMITS;
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** item keys and taxonomy ids: printable, no control characters */
const PRINTABLE = /^[\x20-\x7e]+$/;

export const engineResultItemSchema = z
  .object({
    key: z.string().min(1).max(L.maxKeyChars).regex(PRINTABLE),
    sourceTaxonomy: z
      .object({
        system: z.string().min(1).max(L.maxSourceSystemChars).regex(PRINTABLE),
        id: z.string().min(1).max(L.maxSourceIdChars).regex(PRINTABLE),
      })
      .strict(),
    /** the engine's own claim; the server re-derives it from the shared taxonomy table */
    mappedClass: z.string().min(1).max(64).regex(PRINTABLE).nullable(),
    severity: z.enum(RED_TEAM_SEVERITIES),
    attempts: z.number().int().min(0).max(L.maxAttempts),
    defeated: z.number().int().min(0).max(L.maxAttempts),
    verdict: z.enum(ENGINE_ITEM_VERDICTS),
    reason: z.string().max(L.maxReasonChars).nullable(),
    dispatchAuditIds: z.array(z.string().uuid()).max(L.maxDispatchIdsPerItem),
  })
  .strict();
export type EngineResultItem = z.infer<typeof engineResultItemSchema>;

export const engineNotRunEntrySchema = z
  .object({ key: z.string().min(1).max(L.maxKeyChars).regex(PRINTABLE), reason: z.enum(ENGINE_NOT_RUN_REASONS) })
  .strict();
export type EngineNotRunEntry = z.infer<typeof engineNotRunEntrySchema>;

export const engineRawReportSchema = z
  .object({
    sha256: z.string().regex(SHA256_HEX),
    bytes: z.number().int().min(0).max(L.maxRawReportBytes),
    /** optional: the raw report itself, stored encrypted for the retention window */
    contentBase64: z.string().max(Math.ceil(L.maxRawReportBytes / 3) * 4 + 4).optional(),
  })
  .strict();

export const engineResultEnvelopeSchema = z
  .object({
    version: z.literal(ENGINE_RESULT_VERSION),
    runId: z.string().uuid(),
    engineId: z.enum(ENGINE_IDS),
    engineVersion: z.string().min(1).max(64).regex(PRINTABLE),
    status: z.enum(ENGINE_RESULT_STATUSES),
    /** a machine code naming what went wrong, when status is not completed */
    errorCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).nullable().optional(),
    items: z.array(engineResultItemSchema).max(L.maxItems),
    notRun: z.array(engineNotRunEntrySchema).max(L.maxNotRun),
    rawReport: engineRawReportSchema.nullable(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.items.forEach((it, i) => {
      if (seen.has(it.key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["items", i, "key"], message: "duplicate item key" });
      seen.add(it.key);
      if (it.defeated > it.attempts) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["items", i, "defeated"], message: "defeated exceeds attempts" });
      }
    });
    const nr = new Set<string>();
    v.notRun.forEach((n, i) => {
      if (nr.has(n.key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["notRun", i, "key"], message: "duplicate not-run key" });
      nr.add(n.key);
    });
  });
export type EngineResultEnvelope = z.infer<typeof engineResultEnvelopeSchema>;

// ---------------------------------------------------------------------------
// The runner's self-test (reported at registration)
// ---------------------------------------------------------------------------

export const runnerSelfTestSchema = z
  .object({
    /** the image the runner is actually running, as the container runtime reports it */
    imageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    engineVersion: z.string().min(1).max(64).regex(PRINTABLE),
    /** each usage-data switch the manifest names, and whether it is set to the required value */
    usageDataEnv: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), z.boolean()),
    /** the egress probe: an external host must neither resolve nor connect */
    egress: z
      .object({
        host: z.string().min(1).max(253).regex(PRINTABLE),
        dnsResolved: z.boolean(),
        connected: z.boolean(),
        /** the public literal address probed with no resolver (null = none configured: the test fails) */
        address: z.string().max(45).regex(/^[0-9a-fA-F:.]+$/).nullable(),
        addressConnected: z.boolean(),
      })
      .strict(),
    at: z.string().datetime(),
  })
  .strict();
export type RunnerSelfTest = z.infer<typeof runnerSelfTestSchema>;

// ---------------------------------------------------------------------------
// Runner API bodies
// ---------------------------------------------------------------------------

/**
 * POST /v1/engine-runner/register (enrolment token as the bearer).
 *
 * PR #205 review [54]: the RUNNER generates its own runner token (`rge_` + 256 CSPRNG bits),
 * persists it before it calls this route, and sends only its sha256 (`tokenHash`). Nothing secret
 * comes back, so a lost response loses nothing; a retry with the same enrolment token and the same
 * hash is answered with the same runner (idempotent), a different hash is refused.
 */
export const engineRunnerRegisterSchema = z
  .object({
    name: z.string().trim().min(1).max(100).regex(PRINTABLE),
    imageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    engineVersion: z.string().min(1).max(64).regex(PRINTABLE),
    selfTest: runnerSelfTestSchema,
    tokenHash: z.string().regex(SHA256_HEX),
    /**
     * PR #205 review round 5 [67]: a runner re-enrolling because its build changed presents the
     * runner token it held (proof of possession). On a successful registration the gateway revokes
     * that runner, if it is a live runner of the same engine, in the same transaction (audited).
     */
    supersedes: z.string().startsWith(ENGINE_RUNNER_TOKEN_PREFIX).max(200).regex(/^[\x21-\x7e]+$/).optional(),
  })
  .strict();

/** POST /v1/engine-runner/self-test (runner token) — PR #205 review [53] */
export const engineRunnerSelfTestSchema = z.object({ selfTest: runnerSelfTestSchema }).strict();

/**
 * PR #205 review round 5: THE ONE SIGNAL a runner acts on. Every lease refusal and every self-test
 * answer carries `next`; the runner's loop is a state machine driven by it (ADR-0187 decision 67):
 * - `ok`: lease (a 200 or a 204 lease means the same);
 * - `admin_disabled`: the engine is off by an admin and this runner's report is fresh: wait;
 * - `self_test_required`: this runner's report is stale or failing, or the engine's record needs
 *   it, whatever the engine's state: re-run the self-test and submit it;
 * - `reenrol_required`: the runner presents a build other than the one its credential registered:
 *   re-enrol with an enrolment token, or stop and say so;
 * - `revoked`: the credential authenticates nothing: stop (an admin mints an enrolment token).
 */
export const ENGINE_RUNNER_NEXT = ["ok", "admin_disabled", "self_test_required", "reenrol_required", "revoked"] as const;
export type EngineRunnerNext = (typeof ENGINE_RUNNER_NEXT)[number];

/** POST /v1/engine-runner/lease — round 5 [67]: the build the runner is running now */
export const engineRunnerLeaseSchema = z
  .object({
    imageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    engineVersion: z.string().min(1).max(64).regex(PRINTABLE),
    /**
     * PR #205 review round 13 [94]: a request id the runner generated for this lease attempt, kept
     * across its retries. A retry with the same id, while the run it leased is still leased to this
     * runner, returns that run again (with a rotated key) instead of leasing a second one.
     */
    requestId: z.string().uuid().optional(),
  })
  .strict();
export type EngineRunnerLeaseInput = z.infer<typeof engineRunnerLeaseSchema>;
export type EngineRunnerRegisterInput = z.infer<typeof engineRunnerRegisterSchema>;

/** POST /v1/engine-runner/runs/:runId/heartbeat */
export const engineHeartbeatSchema = z
  .object({ phase: z.enum(ENGINE_RUN_PHASES), progress: z.number().min(0).max(1) })
  .strict();
export type EngineHeartbeatInput = z.infer<typeof engineHeartbeatSchema>;

/** what a lease hands the runner. `target` is null for an artifact scan (no model access). */
export interface EngineLease {
  runId: string;
  engineId: EngineId;
  engineVersion: string;
  spec: { config: EngineRunConfig; trials: number };
  target: {
    /** the gateway's OpenAI-compatible base, e.g. http://gateway:3000/v1 */
    baseUrl: string;
    /** the target agent's provider model string */
    model: string;
    /** the run's virtual key (`rglv_…`), purpose `engine`, revoked at the end */
    apiKey: string;
    /** headers every call must carry: the agent pin and the run's project */
    headers: Record<string, string>;
  } | null;
  /** the judge behind the gateway (same key), or null */
  judge: { model: string; headers: Record<string, string> } | null;
  artifacts: Array<{ id: string; sha256: string; size: number }>;
  deadlineAt: string;
  budgetUsd: number | null;
}

// ---------------------------------------------------------------------------
// Runner-route ANSWERS, as the runner validates them (PR #205 follow-up [101])
// ---------------------------------------------------------------------------
//
// A 2xx whose body does not parse, or does not match these, is NOT an answer: the runner treats it
// as transient, exactly like a timeout (decision 94), and retries according to the route's own
// idempotency. Objects are not strict, so a newer gateway may add fields; every field the runner
// reads is required and typed.

const headerMap = z.record(z.string(), z.string());

/** 200 from POST /v1/engine-runner/lease (204 is "no work"; anything else is not a lease) */
export const engineLeaseResponseSchema = z.object({
  runId: z.string().uuid(),
  engineId: z.enum(ENGINE_IDS),
  engineVersion: z.string().min(1),
  spec: z.object({
    config: z.object({
      sets: z.array(z.string()).min(1),
      params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    }),
    trials: z.number().int().positive(),
  }),
  target: z.object({ baseUrl: z.string().min(1), model: z.string().min(1), apiKey: z.string().min(1), headers: headerMap }).nullable(),
  judge: z.object({ model: z.string().min(1), headers: headerMap }).nullable(),
  artifacts: z.array(z.object({ id: z.string().uuid(), sha256: z.string(), size: z.number().int().nonnegative() })),
  deadlineAt: z.string().datetime({ offset: true }),
  budgetUsd: z.number().nonnegative().nullable(),
});
// the schema yields exactly what an EngineLease is (a compile-time check, no runtime cost)
const _leaseShape: (l: z.infer<typeof engineLeaseResponseSchema>) => EngineLease = (l) => l;
void _leaseShape;

const selfTestVerdictAnswer = z.object({ passed: z.boolean(), failures: z.array(z.string()) });

/** 200 from POST /v1/engine-runner/runs/:runId/heartbeat */
export const engineHeartbeatResponseSchema = z.object({ cancel: z.boolean() });

/** 200 from POST /v1/engine-runner/self-test (`next` is read separately: an unknown signal is ignored) */
export const engineRunnerSelfTestResponseSchema = z.object({ selfTest: selfTestVerdictAnswer, next: z.unknown().optional() });

/** 201 from POST /v1/engine-runner/register */
export const engineRunnerRegisterResponseSchema = z.object({
  runnerId: z.string().min(1),
  selfTest: selfTestVerdictAnswer,
  replayed: z.boolean().optional(),
  supersededRunnerId: z.string().min(1).nullable().optional(),
});

// ---------------------------------------------------------------------------
// Admin and user API bodies
// ---------------------------------------------------------------------------

/** a named plugin/probe set: lower-case id */
const SET_ID = z.string().regex(/^[a-z0-9][a-z0-9:_.-]{0,99}$/);

/** what a run asks the engine to do. Engine-specific meaning; the shape is shared. */
export const engineRunConfigSchema = z
  .object({
    sets: z.array(SET_ID).min(1).max(50).refine((a) => new Set(a).size === a.length, "each set at most once"),
    params: z.record(z.string().max(64), z.union([z.string().max(500), z.number(), z.boolean()])).default({}),
  })
  .strict();
export type EngineRunConfig = z.infer<typeof engineRunConfigSchema>;

export const engineRunTargetSchema = z.union([
  z.object({ agentId: z.string().uuid(), judgeAgentId: z.string().uuid().optional() }).strict(),
  z.object({ artifactId: z.string().uuid() }).strict(),
]);
export type EngineRunTarget = z.infer<typeof engineRunTargetSchema>;

/** POST /v1/engine-runs — also what a schedule and a workflow binding name */
export const createEngineRunSchema = z
  .object({
    engineId: z.enum(ENGINE_IDS),
    target: engineRunTargetSchema,
    config: engineRunConfigSchema,
    projectId: z.string().uuid().optional(),
    /** USD; defaults to the org's default run budget, capped by the engine's ceiling */
    budgetUsd: z.number().positive().max(10_000).optional(),
    trials: z.number().int().min(1).max(25).default(3),
    /** who approves an over-threshold or sensitive run (else the org's default approver) */
    approverUserId: z.string().uuid().optional(),
  })
  .strict();
export type CreateEngineRunInput = z.infer<typeof createEngineRunSchema>;

/** PATCH /v1/engines/:engineId — every field optional; enabling and raising are relaxations */
export const ENGINE_ROW_LIMITS = {
  timeoutSeconds: { min: 60, max: 7200 },
  maxBudgetUsd: { min: 0.01, max: 10_000 },
  maxConcurrent: { min: 1, max: 20 },
} as const;
export const ENGINE_ROW_STRICT_DEFAULTS = Object.freeze({
  enabled: false,
  timeoutSeconds: 1800,
  maxBudgetUsd: 5,
  maxConcurrent: 1,
});
export const updateEngineSchema = z
  .object({
    enabled: z.boolean().optional(),
    timeoutSeconds: z.number().int().min(ENGINE_ROW_LIMITS.timeoutSeconds.min).max(ENGINE_ROW_LIMITS.timeoutSeconds.max).optional(),
    maxBudgetUsd: z.number().min(ENGINE_ROW_LIMITS.maxBudgetUsd.min).max(ENGINE_ROW_LIMITS.maxBudgetUsd.max).optional(),
    maxConcurrent: z.number().int().min(ENGINE_ROW_LIMITS.maxConcurrent.min).max(ENGINE_ROW_LIMITS.maxConcurrent.max).optional(),
    /**
     * PR #205 review round 9 [79]: enabling an engine whose build does not isolate the runner
     * credential from the engine process (the manifest's `credentialIsolation: false`) is refused
     * unless the admin accepts that risk explicitly. It is a relaxation: the step-up binds to it,
     * and it is audited. Only meaningful with `enabled: true`.
     */
    acceptCredentialIsolationRisk: z.literal(true).optional(),
  })
  .strict();
export type UpdateEngineInput = z.infer<typeof updateEngineSchema>;

/**
 * Which fields of an engine PATCH are relaxations against the row as stored
 * (ADR-0180; ADR-0186 decision 26's stored-value rule): turning it on, a longer
 * timeout, a higher budget ceiling, more concurrent runs. Each needs a
 * `settings_relax` step-up bound to `engine.<id>.<field>` and its new value.
 */
export function engineRowRelaxations(
  engineId: string,
  next: UpdateEngineInput,
  stored: { enabled: boolean; timeoutSeconds: number; maxBudgetUsd: number; maxConcurrent: number },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const k = (f: string) => `engine.${engineId}.${f}`;
  if (next.enabled === true && !stored.enabled) out[k("enabled")] = true;
  // round 9 [79]: accepting the credential-isolation risk is part of what the step-up approves
  if (next.enabled === true && !stored.enabled && next.acceptCredentialIsolationRisk === true) out[k("acceptCredentialIsolationRisk")] = true;
  if (next.timeoutSeconds !== undefined && next.timeoutSeconds > stored.timeoutSeconds) out[k("timeoutSeconds")] = next.timeoutSeconds;
  if (next.maxBudgetUsd !== undefined && next.maxBudgetUsd > stored.maxBudgetUsd) out[k("maxBudgetUsd")] = next.maxBudgetUsd;
  if (next.maxConcurrent !== undefined && next.maxConcurrent > stored.maxConcurrent) out[k("maxConcurrent")] = next.maxConcurrent;
  return out;
}

/** POST /v1/engines/:engineId/enrollment-tokens */
export const createEnrollmentTokenSchema = z
  .object({
    label: z.string().trim().min(1).max(100).optional(),
    ttlMinutes: z
      .number()
      .int()
      .min(ENGINE_ENROLLMENT_TTL_MINUTES.min)
      .max(ENGINE_ENROLLMENT_TTL_MINUTES.max)
      .default(ENGINE_ENROLLMENT_TTL_MINUTES.default),
  })
  .strict();

/** DELETE /v1/engine-runners/:runnerId (optional body) */
export const revokeRunnerSchema = z.object({ reason: z.string().trim().min(1).max(500).optional() }).strict();

/** POST /v1/engine-runs/:runId/cancel (optional body) */
export const cancelEngineRunSchema = z.object({ reason: z.string().trim().min(1).max(500).optional() }).strict();

/** POST /v1/engine-schedules — a scheduled run, executed as the person who configured it */
export const createEngineScheduleSchema = z
  .object({
    request: createEngineRunSchema,
    intervalHours: z.number().int().min(1).max(720),
  })
  .strict();
export const updateEngineScheduleSchema = z.object({ enabled: z.boolean() }).strict();
