/**
 * ADR-0065 — the GATEWAY half of REGULAIT-LLM.
 *
 * Division of labour, drawn exactly where ADR-0042/0044 already drew it:
 *
 *   `packages/training-provider`  the backend interface, the registry, and all
 *                                 the pure logic — dataset validation and
 *                                 splitting, hyperparameter validation, cost
 *                                 estimation, and the two REAL trainers (a
 *                                 TF-IDF retrieval index and a logistic-
 *                                 regression classifier trained by gradient
 *                                 descent). No db, no clock, no Fastify.
 *   THIS FILE                     ingest with a PII/secret scan, immutable
 *                                 dataset versions, the governed job
 *                                 lifecycle, cost attribution, the approval
 *                                 gate, lineage capture, the artifact registry
 *                                 and the admin surface.
 *   `agents-connectors.ts`        serves a REGISTERED artifact through the ONE
 *                                 governed dispatch core, so a home-trained
 *                                 model is entitled, MRM-gated, guardrailed,
 *                                 budgeted and metered exactly like a vendor
 *                                 one.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * THE SCOPE SENTENCE, WHICH EVERYTHING BELOW IS BUILT TO KEEP TRUE
 * ═════════════════════════════════════════════════════════════════════════
 *
 * This is MODEL CUSTOMISATION AND GOVERNANCE. It is not a claim to train
 * frontier models, and there is deliberately no code path that pretends to.
 * The `local` backend genuinely runs to completion in this process because what
 * it does is genuinely small — a retrieval index, or a bag-of-words classifier
 * — and both are labelled with the method they really used. The four real
 * remote adapters carry the vendor's documented API shape and REFUSE, with a
 * typed error and an audit row, when no credential is configured. A "Train"
 * button that slept and reported success would be the single worst thing this
 * feature could ship, and the refusal path is tested harder than the happy one.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * SIX PROPERTIES THIS FILE EXISTS TO GUARANTEE
 * ═════════════════════════════════════════════════════════════════════════
 *
 *  1. PII IS CAUGHT AT INGEST, NOT AT INFERENCE. Every uploaded row is scanned
 *     by ADR-0042's guardrail detectors and §8.4's PII classifiers BEFORE the
 *     dataset exists. Under a `block` mode the dataset is never created. This
 *     is the governance win nobody else has: by the time PII is in a training
 *     corpus it is, for practical purposes, in the model.
 *
 *  2. A DATASET VERSION A JOB TRAINED ON CANNOT MOVE. ADR-0044's discipline,
 *     reused verbatim: `(dataset_id, dataset_version)` is a real composite FK,
 *     editing a version that a job cites is refused, and the next version is
 *     minted by copying. A claim about a model is worthless if the data behind
 *     it can be edited afterwards.
 *
 *  3. TRAINING IS NOT A SIDE CHANNEL. A job runs under the initiating user's
 *     entitlement to the BASE AGENT it is anchored to — you cannot train a
 *     derivative of a model you may not use — and its cost lands in the ONE
 *     `usage_events` ledger attributed to the job's project.
 *
 *  4. THERE IS NO SECOND APPROVALS QUEUE. An over-threshold job INSERTs into
 *     the one `approvals` table with `objectType: 'training_job'` and starts
 *     only when the one decide path says so.
 *
 *  5. A HOME-TRAINED MODEL IS GOVERNED LIKE A BOUGHT ONE. Registering an
 *     artifact for inference mints an ADR-0045 model card for it, so with
 *     `mrmEnforced` on it cannot be dispatched until a human has accepted the
 *     risk — the same gate a vendor model takes.
 *
 *  6. PROVENANCE IS IN THE ONE GRAPH. dataset → job → artifact lands in
 *     ADR-0050's lineage graph as `training_dataset` → `training_job` →
 *     `model_artifact`, so "what data is behind this model?" is answerable with
 *     the same traversal that answers it for anything else.
 */
import crypto from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  agents,
  agentGrants,
  and,
  approvals,
  asc,
  auditLog,
  desc,
  eq,
  inArray,
  modelCards,
  orgSettings,
  projects,
  sql,
  trainingArtifacts,
  trainingBackendConfigs,
  trainingDatasetRows,
  trainingDatasets,
  trainingJobs,
  usageEvents,
  userAgentPolicies,
  users,
  type Db,
  type TrainingArtifactRow,
  type TrainingJobRow,
} from "@regulait/db";
import { evaluateAgent, type AgentDecision } from "@regulait/policy-kernel";
import {
  detectPII,
  evaluateGuardrails,
  guardrailCategoryList,
  type GuardrailMode,
  type GuardrailModes,
  type PiiHit,
} from "@regulait/shared";
import {
  ArtifactModelProvider,
  TrainingBackendError,
  TRAINING_BACKEND_KINDS,
  TRAINING_DATASET_FORMATS,
  TRAINING_METHODS,
  datasetChecksum,
  defaultTrainingBaseUrl,
  estimateTrainingCostUsd,
  isInProcessMethod,
  queryArtifact,
  resolveTrainingBackend,
  trainingBackendRegistry,
  validateHyperparameters,
  type TrainingBackend,
  type TrainingBackendKind,
  type TrainingJobHandle,
  type TrainingMethod,
  type TrainingRow,
} from "@regulait/training-provider";
import { loadOrgSettings } from "./org-settings.js";
import { loadAgentRevocations, loadRoleAgentGrants } from "./entitlements.js";
import { assertProjectAttribution, projectPiiMode } from "./projects.js";
import { resolveGuardrailPolicy } from "./guardrails.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { loadEgressAllowList } from "./custom-providers.js";
import { checkEgress, createGuardedFetch, type EgressResolver } from "./egress-guard.js";
import {
  auditCompiledDefaultDenied,
  decideCompiledDefault,
  loadCompiledEgressContext,
} from "./compiled-egress.js";
import { ensureLineageEdge, ensureLineageNode } from "./lineage.js";

/** the audit actor when the caller is the identity-less bootstrap token — the
 * same sentinel every other admin surface in this gateway uses */
const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
const ORG_SETTINGS_ID = "singleton";

/** how much of a matched row is echoed back on a scan report. Nothing at all:
 * §8.4 and ADR-0042 are counts-only, and a training corpus is precisely the
 * kind of data where "just show me the match" is how the leak happens. */
type ScanFindings = {
  pii: Array<{ category: string; count: number }>;
  guardrails: Array<{ detector: string; category: string; count: number }>;
};

export interface RegulAItLlmOptions {
  dataKey?: string | undefined;
  /** test seam for the egress guard, mirroring custom-providers.ts */
  resolve?: EgressResolver | undefined;
  fetchImpl?: typeof fetch | undefined;
}

// ---------------------------------------------------------------------------
// Ingest scanning — property 1
// ---------------------------------------------------------------------------

/**
 * Scan an entire corpus for PII and for the ADR-0042 content classes, and
 * return the verdict plus COUNTS ONLY.
 *
 * Both halves run at their strictest configured setting rather than the mode a
 * dispatch would use, and then the CALLER composes the effective mode. That
 * split is deliberate: detection and enforcement are different decisions, and
 * conflating them is how a `log`-mode deployment ends up with no record of what
 * it accepted.
 */
export function scanTrainingRows(
  rows: TrainingRow[],
  guardrailModes: GuardrailModes,
): { findings: ScanFindings; piiHits: PiiHit[]; hasPii: boolean; guardrailBlocked: boolean } {
  const piiCounts = new Map<string, number>();
  const guardrailCounts = new Map<string, { detector: string; category: string; count: number }>();
  const allHits: PiiHit[] = [];
  let guardrailBlocked = false;

  for (const row of rows) {
    // input AND output: a completion is training signal too, and a corpus
    // whose answers carry customer emails is exactly as leaky as one whose
    // questions do
    const text = `${row.input}\n${row.output ?? ""}`;
    for (const hit of detectPII(text)) {
      allHits.push(hit);
      piiCounts.set(hit.category, (piiCounts.get(hit.category) ?? 0) + hit.count);
    }
    // The training corpus is scanned as INPUT-phase content: it is material
    // that will be handed to a model, which is exactly what the input phase
    // detectors are for. `pii` is excluded because it has its own path above.
    const evaluation = evaluateGuardrails({
      phase: "input",
      text,
      modes: guardrailModes,
      terms: {},
      exclude: ["pii"],
    });
    if (evaluation.action === "block") guardrailBlocked = true;
    for (const finding of evaluation.findings) {
      for (const hit of finding.hits) {
        const key = `${finding.detector}:${hit.category}`;
        const prev = guardrailCounts.get(key);
        guardrailCounts.set(key, {
          detector: finding.detector,
          category: hit.category,
          count: (prev?.count ?? 0) + hit.count,
        });
      }
    }
  }

  return {
    findings: {
      pii: [...piiCounts.entries()].map(([category, count]) => ({ category, count })),
      guardrails: [...guardrailCounts.values()],
    },
    piiHits: allHits,
    hasPii: allHits.length > 0,
    guardrailBlocked,
  };
}

const STRICTNESS: Record<GuardrailMode, number> = { off: 0, log: 1, warn: 2, block: 3 };

/**
 * The effective ingest mode: the STRICTEST of what the caller asked for and
 * what the project's compliance cascade demands.
 *
 * MAX composition, exactly like `composeGuardrailModes` — which means a
 * requested `warn` can never walk back a HIPAA profile's `block`. The default
 * when nothing is requested is `block`: refusing PII-laden training data unless
 * somebody deliberately says otherwise is the correct posture for the one place
 * in this product where accepted data becomes permanent.
 */
export function effectiveIngestMode(
  requested: GuardrailMode | undefined,
  complianceFloor: GuardrailMode | null,
): GuardrailMode {
  const local = requested ?? "block";
  if (!complianceFloor) return local;
  return STRICTNESS[complianceFloor] > STRICTNESS[local] ? complianceFloor : local;
}

// ---------------------------------------------------------------------------
// Entitlement — property 3
// ---------------------------------------------------------------------------

/** the entitlement inputs, loaded once — the SAME `evaluateAgent` path an
 * ordinary invoke (and an ADR-0044 eval run) takes. There is no "training
 * mode" that skips it. */
async function agentDecider(db: Db, userId: string) {
  const [grants, roleGrants, revocations, [policy]] = await Promise.all([
    db.select().from(agentGrants).where(eq(agentGrants.userId, userId)),
    loadRoleAgentGrants(db, userId),
    loadAgentRevocations(db, userId),
    db.select().from(userAgentPolicies).where(eq(userAgentPolicies.userId, userId)),
  ]);
  let ceilingTier: number | null = null;
  if (policy?.ceilingAgentId) {
    const [ceiling] = await db
      .select({ tier: agents.tier })
      .from(agents)
      .where(eq(agents.id, policy.ceilingAgentId));
    ceilingTier = ceiling?.tier ?? null;
  }
  return (agent: typeof agents.$inferSelect, mode: string): AgentDecision =>
    evaluateAgent({
      userId,
      agent: {
        id: agent.id,
        name: agent.name,
        tier: agent.tier,
        enabled: agent.enabled,
        modes: agent.modes ?? null,
      },
      mode,
      agentGrants: grants,
      roleAgentGrants: roleGrants,
      agentRevocations: revocations,
      ceilingTier,
    });
}

// ---------------------------------------------------------------------------
// Backend resolution — the egress guard applies here, on every use
// ---------------------------------------------------------------------------

export type BackendResolution =
  | { ok: true; backend: TrainingBackend; hasCredential: boolean; destination: string | null }
  | { ok: false; status: number; error: string; detail: string };

/**
 * Resolve a training backend into a live, egress-guarded adapter.
 *
 * Called on EVERY use, never cached, for exactly the reasons ADR-0034 gives:
 * the allow-list may have changed, the config may have been disabled, and the
 * hostname may have been re-pointed in DNS since the day an admin approved it.
 *
 * `local`/`mock` short-circuit — they make no outbound call, which is what
 * makes custom-model creation work on an air-gapped install.
 */
export async function resolveTrainingBackendForUse(
  db: Db,
  kind: TrainingBackendKind,
  opts: RegulAItLlmOptions = {},
): Promise<BackendResolution> {
  if (kind === "local" || kind === "mock") {
    return { ok: true, backend: resolveTrainingBackend({ backend: kind }), hasCredential: true, destination: null };
  }

  const [config] = await db
    .select()
    .from(trainingBackendConfigs)
    .where(eq(trainingBackendConfigs.backend, kind));

  if (!config || !config.enabled) {
    // NOT an error yet — resolution succeeds with no credential so that
    // capability listing and dataset validation still work. `startJob` is where
    // the honest refusal fires, and it fires from the adapter itself.
    return {
      ok: true,
      backend: resolveTrainingBackend({ backend: kind }),
      hasCredential: false,
      destination: defaultTrainingBaseUrl(kind),
    };
  }

  let apiKey: string | null = null;
  if (config.keyCiphertext) {
    if (!opts.dataKey) {
      return { ok: false, status: 503, error: "no_data_key", detail: "set REGULAIT_DATA_KEY" };
    }
    apiKey = decryptSecret(opts.dataKey, config.keyCiphertext);
  }

  let guardedFetch: typeof fetch | undefined;
  if (config.baseUrl) {
    // THE ADR-0034 GUARD, at use time. Not a cached verdict from the day the
    // admin typed the URL.
    const allowList = await loadEgressAllowList(db);
    const decision = await checkEgress(config.baseUrl, {
      allowList,
      providerAllowsPlaintextHttp: config.allowPlaintextHttp,
      ...(opts.resolve ? { resolve: opts.resolve } : {}),
    });
    if (!decision.ok) {
      return {
        ok: false,
        status: 403,
        error: "egress_blocked",
        detail: `training backend '${kind}': ${decision.reason}`,
      };
    }
    guardedFetch = createGuardedFetch({
      allowList,
      providerAllowsPlaintextHttp: config.allowPlaintextHttp,
      ...(opts.resolve ? { resolve: opts.resolve } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  } else {
    // ADR-0062 — THE COMPILED DEFAULT. With no stored baseUrl the adapter uses
    // its own compiled vendor endpoint, which no human typed and which the
    // SSRF guard therefore never saw. Under a strict (air-gapped) posture that
    // destination must be in the same allow-list as everything else.
    const { posture, allowList } = await loadCompiledEgressContext(db);
    const decision = decideCompiledDefault({
      posture,
      surface: "training_backend",
      kind,
      defaultBaseUrl: defaultTrainingBaseUrl(kind),
      allowList,
    });
    if (!decision.ok) {
      await auditCompiledDefaultDenied(db, {
        userId: NO_IDENTITY,
        surface: "training_backend",
        objectId: config.id,
        kind,
        decision,
        posture,
        detail: { backend: kind },
      });
      return { ok: false, status: 403, error: "egress_blocked", detail: decision.reason };
    }
    if (opts.fetchImpl) guardedFetch = opts.fetchImpl;
  }

  return {
    ok: true,
    backend: resolveTrainingBackend(
      {
        backend: kind,
        apiKey,
        baseUrl: config.baseUrl,
        settings: config.settings,
      },
      guardedFetch,
    ),
    hasCredential: apiKey != null,
    destination: config.baseUrl ?? defaultTrainingBaseUrl(kind),
  };
}

// ---------------------------------------------------------------------------
// Serving a registered artifact — property 5's other half
// ---------------------------------------------------------------------------

export type ArtifactProviderResolution =
  | { ok: true; provider: ArtifactModelProvider; artifact: TrainingArtifactRow }
  | { ok: false; status: number; error: string; detail: string };

/**
 * Load the artifact a `regulait_llm` agent serves, and wrap it as an ordinary
 * `ModelProvider`.
 *
 * Called from `executeGovernedDispatch`, in exactly the position the guarded
 * custom-provider resolution occupies — which is what makes a home-trained
 * model inherit entitlement, the MRM gate, the project budget, §8.4 PII,
 * ADR-0042 guardrails and the one usage ledger with no special case anywhere.
 */
export async function resolveArtifactProviderForDispatch(
  db: Db,
  agentId: string,
): Promise<ArtifactProviderResolution> {
  // ADR-0107 (F01): `training_artifacts` is UNIQUE on `job_id`, NOT on
  // `agent_id` — a second training job for the same agent registers a second
  // artifact against it. Without an order, Postgres was free to hand back
  // either, so WHICH MODEL ANSWERED an inference call was arbitrary and could
  // change between two identical requests. Newest-registered wins: registering
  // an artifact against an agent is the act of saying "serve this one now", and
  // `id` breaks a same-millisecond tie so the order is total, not merely likely.
  const [artifact] = await db
    .select()
    .from(trainingArtifacts)
    .where(eq(trainingArtifacts.agentId, agentId))
    .orderBy(desc(trainingArtifacts.createdAt), desc(trainingArtifacts.id))
    .limit(1);
  if (!artifact) {
    return {
      ok: false,
      status: 409,
      error: "artifact_not_registered",
      detail:
        "this agent declares provider 'regulait_llm' but no RegulAIt-LLM artifact is registered against it",
    };
  }
  if (artifact.kind !== "inline" || !artifact.payload) {
    return {
      ok: false,
      status: 409,
      error: "artifact_not_servable",
      detail:
        `artifact '${artifact.name}' lives on the training backend (${artifact.location ?? "unknown location"}). ` +
        "RegulAIt holds a reference to it and cannot run inference against it here — register it as a " +
        "custom model provider (ADR-0034) pointing at wherever it is served.",
    };
  }
  return {
    ok: true,
    artifact,
    provider: new ArtifactModelProvider({
      id: artifact.id,
      name: artifact.name,
      method: artifact.method as TrainingMethod,
      payload: artifact.payload,
    }),
  };
}

// ---------------------------------------------------------------------------
// Lineage capture — property 6
// ---------------------------------------------------------------------------

/** BEST-EFFORT, like every other capture site: lineage is a derived read-model
 * and a write failure must never fail a job that has already been metered. */
async function recordTrainingLineage(
  db: Db,
  input: {
    projectId: string;
    datasetId: string;
    datasetName: string;
    datasetVersion: number;
    jobId: string;
    jobName: string;
    artifactId: string;
    artifactName: string;
    method: string;
  },
): Promise<void> {
  try {
    const source = await ensureLineageNode(db, {
      projectId: input.projectId,
      naturalKey: `training_dataset:${input.datasetId}:v${input.datasetVersion}`,
      kind: "source",
      subtype: "training_dataset",
      refId: input.datasetId,
      refKey: input.datasetName,
      version: input.datasetVersion,
      label: `training dataset '${input.datasetName}' v${input.datasetVersion}`,
    });
    const run = await ensureLineageNode(db, {
      projectId: input.projectId,
      naturalKey: `training_job:${input.jobId}`,
      kind: "run",
      subtype: "training_job",
      refId: input.jobId,
      refKey: input.jobName,
      label: `training job '${input.jobName}' (${input.method})`,
    });
    const output = await ensureLineageNode(db, {
      projectId: input.projectId,
      naturalKey: `model_artifact:${input.artifactId}`,
      kind: "output",
      subtype: "model_artifact",
      refId: input.artifactId,
      refKey: input.artifactName,
      label: `model artifact '${input.artifactName}'`,
    });
    await ensureLineageEdge(db, {
      projectId: input.projectId,
      fromNodeId: source,
      toNodeId: run,
      kind: "flowed_into",
      detail: { supplied: "the pinned training dataset version this job consumed" },
    });
    await ensureLineageEdge(db, {
      projectId: input.projectId,
      fromNodeId: run,
      toNodeId: output,
      kind: "produced",
      detail: { method: input.method },
    });
  } catch {
    /* lineage is a derived read-model; it is rebuildable from these tables */
  }
}

// ---------------------------------------------------------------------------
// The job lifecycle
// ---------------------------------------------------------------------------

async function audit(
  db: Db,
  args: {
    userId: string | null;
    objectType: "training_dataset" | "training_job" | "training_artifact";
    objectId: string | null;
    ruleId: string;
    reason: string;
    detail: Record<string, unknown>;
    effect?: "allow" | "deny";
  },
): Promise<void> {
  await db.insert(auditLog).values({
    userId: args.userId ?? NO_IDENTITY,
    objectType: args.objectType,
    objectId: args.objectId,
    detail: args.detail,
    effect: args.effect ?? "allow",
    ruleId: args.ruleId,
    ruleChain: [],
    reason: args.reason,
  });
}

async function loadRows(db: Db, datasetId: string, version: number): Promise<TrainingRow[]> {
  const rows = await db
    .select()
    .from(trainingDatasetRows)
    .where(and(eq(trainingDatasetRows.datasetId, datasetId), eq(trainingDatasetRows.datasetVersion, version)))
    .orderBy(asc(trainingDatasetRows.idx));
  return rows.map((r) => ({ input: r.input, output: r.output, tags: r.tags }));
}

/**
 * PILLAR 5. One row in the ONE ledger per training job, whatever the outcome.
 *
 * A refused or failed job bills ZERO and still writes a row, because "we tried
 * to train and nothing happened" is a fact the cost dashboard should show
 * rather than an absence somebody has to notice. In-process training costs
 * exactly nothing and says so — inventing a figure for arithmetic this box did
 * itself would put fiction into the ledger the whole of pillar 5 rests on.
 */
async function meterTrainingJob(
  db: Db,
  job: TrainingJobRow,
  outcome: { status: string; costUsd: number | null; detail?: Record<string, unknown> },
): Promise<void> {
  await db.insert(usageEvents).values({
    userId: job.initiatedByUserId ?? NO_IDENTITY,
    objectType: "training_job",
    operation: `${job.backend}:${job.method}`,
    provider: job.backend,
    model: job.baseModel,
    costUsd: outcome.costUsd,
    projectId: job.projectId,
    detail: {
      trainingJobId: job.id,
      datasetId: job.datasetId,
      datasetVersion: job.datasetVersion,
      backend: job.backend,
      method: job.method,
      status: outcome.status,
      estimatedCostUsd: job.estimatedCostUsd,
      inProcess: isInProcessMethod(job.method as TrainingMethod),
      ...(outcome.detail ?? {}),
    },
  });
}

export interface RunJobResult {
  job: TrainingJobRow;
  artifact: TrainingArtifactRow | null;
  refusal: { code: string; detail: string } | null;
}

/**
 * START (and, for an in-process backend, COMPLETE) one training job.
 *
 * Called from three places and identical in all three: the create endpoint when
 * the job is under the approval threshold, the approvals decide hook when a
 * human approves an over-threshold one, and the manual re-run endpoint. There
 * is exactly one implementation so a scheduled, approved and manual run cannot
 * drift apart.
 */
export async function runTrainingJob(
  db: Db,
  jobId: string,
  opts: RegulAItLlmOptions = {},
): Promise<RunJobResult> {
  const [job] = await db.select().from(trainingJobs).where(eq(trainingJobs.id, jobId));
  if (!job) throw new Error(`unknown training job ${jobId}`);

  const started = new Date();
  await db
    .update(trainingJobs)
    .set({ status: "running", startedAt: started, progress: 0 })
    .where(eq(trainingJobs.id, jobId));

  const resolution = await resolveTrainingBackendForUse(db, job.backend as TrainingBackendKind, opts);
  if (!resolution.ok) {
    return finishRefused(db, job, "egress_blocked", resolution.detail);
  }

  const rows = await loadRows(db, job.datasetId, job.datasetVersion);
  const [dataset] = await db.select().from(trainingDatasets).where(eq(trainingDatasets.id, job.datasetId));

  let handle: TrainingJobHandle;
  try {
    handle = await resolution.backend.startJob({
      jobId: job.id,
      name: job.name,
      method: job.method as TrainingMethod,
      baseModel: job.baseModel,
      hyperparameters: job.hyperparameters,
      rows,
      format: (dataset?.format ?? "prompt_completion") as never,
    });
  } catch (err) {
    // THE HONEST REFUSAL. A credential-less real backend lands here, and it
    // becomes a TERMINAL `refused` job with an audit row — never a silent
    // success and never an indistinguishable `failed`.
    if (err instanceof TrainingBackendError && err.code === "credential_required") {
      return finishRefused(db, job, err.code, err.message);
    }
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof TrainingBackendError ? err.code : "upstream_error";
    if (err instanceof TrainingBackendError && (code === "method_unsupported" || code === "backend_disabled")) {
      return finishRefused(db, job, code, message);
    }
    return finishFailed(db, job, message);
  }

  await db
    .update(trainingJobs)
    .set({ externalJobId: handle.externalJobId })
    .where(eq(trainingJobs.id, jobId));

  // ONE poll immediately. An in-process backend is already finished by now and
  // reporting `running` for it would be theatre; a remote backend that really
  // is still running stays running and ADR-0064's sweep picks it up.
  const [current] = await db.select().from(trainingJobs).where(eq(trainingJobs.id, jobId));
  return pollTrainingJob(db, current!, opts);
}

/** Poll one job and settle it if the backend says it is done. The manual
 * endpoint, the scheduler sweep and `runTrainingJob` all come through here. */
export async function pollTrainingJob(
  db: Db,
  job: TrainingJobRow,
  opts: RegulAItLlmOptions = {},
): Promise<RunJobResult> {
  const resolution = await resolveTrainingBackendForUse(db, job.backend as TrainingBackendKind, opts);
  if (!resolution.ok) return finishRefused(db, job, "egress_blocked", resolution.detail);

  const handle: TrainingJobHandle = {
    backend: job.backend as TrainingBackendKind,
    jobId: job.id,
    externalJobId: job.externalJobId,
  };

  let report;
  try {
    report = await resolution.backend.pollJob(handle);
  } catch (err) {
    if (err instanceof TrainingBackendError && err.code === "credential_required") {
      return finishRefused(db, job, err.code, err.message);
    }
    return finishFailed(db, job, err instanceof Error ? err.message : String(err));
  }

  if (report.status === "running") {
    const [updated] = await db
      .update(trainingJobs)
      .set({ progress: report.progress })
      .where(eq(trainingJobs.id, job.id))
      .returning();
    return { job: updated!, artifact: null, refusal: null };
  }
  if (report.status === "failed") return finishFailed(db, job, report.error ?? "the backend reported failure");
  if (report.status === "cancelled") return finishCancelled(db, job);

  // SUCCEEDED — fetch what actually came out.
  let payload;
  try {
    payload = await resolution.backend.fetchArtifact(handle);
  } catch (err) {
    return finishFailed(db, job, err instanceof Error ? err.message : String(err));
  }

  const finishedAt = new Date();
  const [artifact] = await db
    .insert(trainingArtifacts)
    .values({
      jobId: job.id,
      name: job.name,
      method: job.method,
      baseModel: job.baseModel,
      kind: payload.kind,
      payload: payload.payload ?? null,
      location: payload.location ?? null,
      metrics: payload.metrics,
    })
    .onConflictDoNothing()
    .returning();

  // In-process training bills nothing; a remote job's real cost is whatever the
  // vendor charged, which this deployment cannot observe — so it records the
  // ESTIMATE and the ledger detail says which it is.
  const costUsd = isInProcessMethod(job.method as TrainingMethod) ? 0 : job.estimatedCostUsd;

  const [finished] = await db
    .update(trainingJobs)
    .set({
      status: "succeeded",
      progress: 1,
      finishedAt,
      durationMs: job.startedAt ? finishedAt.getTime() - job.startedAt.getTime() : null,
      costUsd,
      error: null,
    })
    .where(eq(trainingJobs.id, job.id))
    .returning();

  await meterTrainingJob(db, finished!, {
    status: "succeeded",
    costUsd,
    detail: {
      artifactId: artifact?.id ?? null,
      costBasis: isInProcessMethod(job.method as TrainingMethod)
        ? "measured: in-process training, nothing was billed by anyone"
        : "ESTIMATE: the vendor's own charge is not observable from this deployment",
    },
  });

  if (artifact && finished!.projectId) {
    const [dataset] = await db.select().from(trainingDatasets).where(eq(trainingDatasets.id, job.datasetId));
    await recordTrainingLineage(db, {
      projectId: finished!.projectId,
      datasetId: job.datasetId,
      datasetName: dataset?.name ?? job.datasetId,
      datasetVersion: job.datasetVersion,
      jobId: job.id,
      jobName: job.name,
      artifactId: artifact.id,
      artifactName: artifact.name,
      method: job.method,
    });
  }

  await audit(db, {
    userId: job.initiatedByUserId,
    objectType: "training_job",
    objectId: job.id,
    ruleId: "llm-training-job-succeeded",
    reason:
      `training job '${job.name}' completed on backend '${job.backend}' using method '${job.method}'` +
      (isInProcessMethod(job.method as TrainingMethod)
        ? " — an in-process artifact, NOT a fine-tuned language model"
        : ""),
    detail: {
      phase: "training",
      backend: job.backend,
      method: job.method,
      datasetId: job.datasetId,
      datasetVersion: job.datasetVersion,
      artifactId: artifact?.id ?? null,
      metrics: payload.metrics,
      costUsd,
    },
  });

  return { job: finished!, artifact: artifact ?? null, refusal: null };
}

async function finishRefused(db: Db, job: TrainingJobRow, code: string, detail: string): Promise<RunJobResult> {
  const finishedAt = new Date();
  const [updated] = await db
    .update(trainingJobs)
    .set({ status: "refused", finishedAt, error: detail, progress: 0 })
    .where(eq(trainingJobs.id, job.id))
    .returning();
  await meterTrainingJob(db, updated!, { status: "refused", costUsd: 0, detail: { refusalCode: code } });
  await audit(db, {
    userId: job.initiatedByUserId,
    objectType: "training_job",
    objectId: job.id,
    ruleId: "llm-training-job-refused",
    effect: "deny",
    reason: `training job '${job.name}' was REFUSED before any work happened (${code}): ${detail}`,
    detail: { phase: "training", backend: job.backend, method: job.method, refusalCode: code },
  });
  return { job: updated!, artifact: null, refusal: { code, detail } };
}

async function finishFailed(db: Db, job: TrainingJobRow, message: string): Promise<RunJobResult> {
  const finishedAt = new Date();
  const [updated] = await db
    .update(trainingJobs)
    .set({ status: "failed", finishedAt, error: message })
    .where(eq(trainingJobs.id, job.id))
    .returning();
  await meterTrainingJob(db, updated!, { status: "failed", costUsd: 0, detail: { error: message } });
  await audit(db, {
    userId: job.initiatedByUserId,
    objectType: "training_job",
    objectId: job.id,
    ruleId: "llm-training-job-failed",
    effect: "deny",
    reason: `training job '${job.name}' failed: ${message}`,
    detail: { phase: "training", backend: job.backend, method: job.method, error: message },
  });
  return { job: updated!, artifact: null, refusal: null };
}

async function finishCancelled(db: Db, job: TrainingJobRow): Promise<RunJobResult> {
  const [updated] = await db
    .update(trainingJobs)
    .set({ status: "cancelled", finishedAt: new Date() })
    .where(eq(trainingJobs.id, job.id))
    .returning();
  await meterTrainingJob(db, updated!, { status: "cancelled", costUsd: 0 });
  return { job: updated!, artifact: null, refusal: null };
}

// ---------------------------------------------------------------------------
// ADR-0064 — the poll sweep
// ---------------------------------------------------------------------------

export const TRAINING_POLL_SWEEP_NOTE =
  "Remote training jobs run for hours on someone else's compute, so somebody has to ask how they are " +
  "getting on. This sweep is that somebody. It polls every job still marked running on a REMOTE backend " +
  "and settles the ones that finished. It is deliberately NOT a setInterval: a poll loop that lived in a " +
  "module-level timer would double-fire the moment there are two gateway instances, and would be " +
  "invisible when it stopped. In-process (local/mock) jobs are never swept — they are already finished " +
  "by the time their start call returns.";

export interface TrainingPollSweepResult {
  polled: Array<{ jobId: string; status: string }>;
  skipped: Array<{ jobId: string; reason: string }>;
}

export async function runTrainingJobPollSweep(
  db: Db,
  opts: RegulAItLlmOptions = {},
): Promise<TrainingPollSweepResult> {
  const running = await db
    .select()
    .from(trainingJobs)
    .where(eq(trainingJobs.status, "running"))
    .orderBy(asc(trainingJobs.startedAt));
  const polled: TrainingPollSweepResult["polled"] = [];
  const skipped: TrainingPollSweepResult["skipped"] = [];
  for (const job of running) {
    if (job.backend === "local" || job.backend === "mock") {
      skipped.push({ jobId: job.id, reason: "in-process backend — nothing to poll" });
      continue;
    }
    try {
      const result = await pollTrainingJob(db, job, opts);
      polled.push({ jobId: job.id, status: result.job.status });
    } catch (err) {
      skipped.push({ jobId: job.id, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { polled, skipped };
}

// ---------------------------------------------------------------------------
// The approvals hook — property 4
// ---------------------------------------------------------------------------

/**
 * ADR-0065 §4: the decision arrives through `POST /v1/approvals/:id/decide`,
 * which has already applied every separation-of-duties guard the queue applies
 * to anything else. This function only translates that decision onto the job,
 * and — on approve — returns the post-commit closure that actually starts it.
 *
 * The start is post-commit and not inside the transaction on purpose: training
 * can take real time (and, on a remote backend, makes a network call), and
 * holding an approvals-table transaction open across it would be a lock on the
 * one queue every other governed action shares.
 */
export async function applyTrainingJobApprovalDecision(
  tx: Db,
  approvalRow: { id: string; stageId: string | null; decisionReason: string | null },
  decision: "approved" | "denied",
  deciderUserId: string,
): Promise<((db: Db) => Promise<void>) | null> {
  const [job] = await tx.select().from(trainingJobs).where(eq(trainingJobs.approvalId, approvalRow.id));
  if (!job || job.status !== "pending_approval") return null;

  if (decision === "denied") {
    await tx
      .update(trainingJobs)
      .set({
        status: "cancelled",
        finishedAt: new Date(),
        error: `training was refused in the Approvals Queue${approvalRow.decisionReason ? `: ${approvalRow.decisionReason}` : ""}`,
      })
      .where(eq(trainingJobs.id, job.id));
    await tx.insert(auditLog).values({
      userId: deciderUserId,
      objectType: "training_job",
      objectId: job.id,
      detail: {
        phase: "approval",
        approvalId: approvalRow.id,
        decision,
        estimatedCostUsd: job.estimatedCostUsd,
      },
      effect: "deny",
      ruleId: "llm-training-approval-denied",
      ruleChain: [],
      reason: `an estimated $${job.estimatedCostUsd.toFixed(2)} training job was refused and never started`,
    });
    return null;
  }

  await tx.update(trainingJobs).set({ status: "queued" }).where(eq(trainingJobs.id, job.id));
  await tx.insert(auditLog).values({
    userId: deciderUserId,
    objectType: "training_job",
    objectId: job.id,
    detail: {
      phase: "approval",
      approvalId: approvalRow.id,
      decision,
      estimatedCostUsd: job.estimatedCostUsd,
      backend: job.backend,
      method: job.method,
    },
    effect: "allow",
    ruleId: "llm-training-approval-granted",
    ruleChain: [],
    reason: `an estimated $${job.estimatedCostUsd.toFixed(2)} training job was approved and will now start`,
  });
  return async (db: Db) => {
    await runTrainingJob(db, job.id, {});
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const idParam = z.object({ id: z.string().uuid() });
const backendParam = z.object({ backend: z.enum(TRAINING_BACKEND_KINDS) });

const rowSchema = z.object({
  input: z.string().min(1).max(50_000),
  output: z.string().max(50_000).nullable().optional(),
  tags: z.array(z.string().min(1).max(64)).max(20).optional(),
});

const createDatasetSchema = z
  .object({
    name: z.string().min(1).max(200),
    note: z.string().max(2000).optional(),
    format: z.enum(TRAINING_DATASET_FORMATS).default("prompt_completion"),
    rows: z.array(rowSchema).min(1).max(20_000),
    projectId: z.string().uuid().nullable().optional(),
    /** the REQUESTED ingest posture. Composed as a MAX with the project's
     * compliance floor, so this can only ever be as strict as, or stricter
     * than, what the cascade already demands. Absent = `block`. */
    piiMode: z.enum(["off", "log", "warn", "block"]).optional(),
  })
  .strict();

const createJobSchema = z
  .object({
    name: z.string().min(1).max(200),
    datasetId: z.string().uuid(),
    backend: z.enum(TRAINING_BACKEND_KINDS),
    method: z.enum(TRAINING_METHODS),
    baseModel: z.string().min(1).max(200).nullable().optional(),
    /** the registry agent this customisation is anchored to. REQUIRED, because
     * it is what the entitlement check is made against. */
    baseAgentId: z.string().uuid(),
    hyperparameters: z.record(z.unknown()).default({}),
    projectId: z.string().uuid().nullable().optional(),
    /** who decides, if the estimate crosses the org threshold. Falls back to
     * the org's default infra approver. */
    approverUserId: z.string().uuid().optional(),
    /** vendor list price per MILLION training tokens, for the estimate. Absent
     * on a remote backend yields a NULL estimate, which is refused rather than
     * guessed at — see the route. */
    pricePerMTokUsd: z.number().min(0).max(10_000).optional(),
  })
  .strict();

export function registerRegulAItLlmRoutes(app: FastifyInstance, db: Db, opts: RegulAItLlmOptions = {}) {
  const actor = (req: { authCtx: { userId?: string | null } }) => req.authCtx.userId ?? null;

  async function capabilityOn(): Promise<boolean> {
    return (await loadOrgSettings(db)).llmTrainingEnabled;
  }

  const disabledReply = {
    error: "llm_training_disabled",
    detail:
      "custom-model creation is switched off for this organisation (org settings: llmTrainingEnabled). " +
      "No dataset is accepted and no job is started while it is off.",
  };

  // --- backends -----------------------------------------------------------

  /**
   * The registry, verbatim from the code — including each backend's honest
   * `limits` string. The admin screen renders that next to the choice, the same
   * discipline `GET /v1/guardrails/detectors` and `GET /v1/evals/scorers` use:
   * a person picking a backend reads what it cannot do at the moment they
   * decide, not in an ADR they will never open.
   */
  app.get("/v1/llm/backends", async () => {
    const org = await loadOrgSettings(db);
    const configs = await db.select().from(trainingBackendConfigs);
    const byKind = new Map(configs.map((c) => [c.backend, c]));
    return {
      enabled: org.llmTrainingEnabled,
      approvalThresholdUsd: org.llmTrainingApprovalThresholdUsd,
      backends: trainingBackendRegistry().map((c) => {
        const cfg = byKind.get(c.kind);
        return {
          ...c,
          defaultBaseUrl: defaultTrainingBaseUrl(c.kind),
          configured: cfg != null,
          configEnabled: cfg?.enabled ?? false,
          hasCredential: cfg?.keyCiphertext != null,
          baseUrl: cfg?.baseUrl ?? null,
          lastTestedAt: cfg?.lastTestedAt ?? null,
          lastTestError: cfg?.lastTestError ?? null,
        };
      }),
      note:
        "regulAIt-LLM is MODEL CUSTOMISATION under governance. The 'local' backend really runs — it " +
        "builds a TF-IDF retrieval index or trains a bag-of-words classifier by gradient descent, in " +
        "this process, and the artifact answers from your data. It does NOT fine-tune a language model " +
        "and never says it does. The four remote backends do fine-tune, on the vendor's compute, and " +
        "refuse honestly until you give them a credential.",
    };
  });

  app.put("/v1/llm/backend-configs/:backend", async (req, reply) => {
    const { backend } = backendParam.parse(req.params);
    const body = z
      .object({
        enabled: z.boolean().optional(),
        baseUrl: z.string().url().max(2000).nullable().optional(),
        apiKey: z.string().min(1).max(4000).nullable().optional(),
        allowPlaintextHttp: z.boolean().optional(),
        settings: z.record(z.unknown()).optional(),
      })
      .strict()
      .parse(req.body ?? {});

    if (backend === "local" || backend === "mock") {
      return reply.status(409).send({
        error: "backend_needs_no_config",
        detail: `the '${backend}' backend runs in-process and holds no credential — there is nothing to configure`,
      });
    }
    if (body.apiKey && !opts.dataKey) {
      return reply.status(503).send({ error: "no_data_key", detail: "set REGULAIT_DATA_KEY" });
    }

    const allowPlaintextHttp = body.allowPlaintextHttp ?? false;
    if (body.baseUrl) {
      // WRITE-TIME GUARD. Not a substitute for the use-time one above — it is
      // the earliest honest failure, so a bad endpoint is a 400 now rather than
      // a surprise in the middle of a training job.
      const decision = await checkEgress(body.baseUrl, {
        allowList: await loadEgressAllowList(db),
        providerAllowsPlaintextHttp: allowPlaintextHttp,
        ...(opts.resolve ? { resolve: opts.resolve } : {}),
      });
      if (!decision.ok) {
        await audit(db, {
          userId: actor(req),
          objectType: "training_job",
          objectId: null,
          ruleId: "llm-backend-egress-blocked",
          effect: "deny",
          reason: `training backend '${backend}' endpoint refused: ${decision.reason}`,
          detail: { phase: "backend_config", backend, baseUrl: body.baseUrl, code: decision.code },
        });
        return reply.status(400).send({ error: "egress_blocked", code: decision.code, detail: decision.reason });
      }
    }

    const [existing] = await db
      .select()
      .from(trainingBackendConfigs)
      .where(eq(trainingBackendConfigs.backend, backend));
    const values = {
      backend,
      enabled: body.enabled ?? existing?.enabled ?? false,
      baseUrl: body.baseUrl === undefined ? (existing?.baseUrl ?? null) : body.baseUrl,
      // null CLEARS the key (the backend becomes keyless and will refuse);
      // undefined keeps whatever is stored
      keyCiphertext:
        body.apiKey === undefined
          ? (existing?.keyCiphertext ?? null)
          : body.apiKey && opts.dataKey
            ? encryptSecret(opts.dataKey, body.apiKey)
            : null,
      allowPlaintextHttp,
      settings: body.settings ?? existing?.settings ?? {},
      createdByUserId: existing?.createdByUserId ?? actor(req),
      updatedAt: new Date(),
    };
    const [row] = existing
      ? await db
          .update(trainingBackendConfigs)
          .set(values)
          .where(eq(trainingBackendConfigs.id, existing.id))
          .returning()
      : await db.insert(trainingBackendConfigs).values(values).returning();

    await audit(db, {
      userId: actor(req),
      objectType: "training_job",
      objectId: null,
      ruleId: "llm-backend-config-set",
      reason:
        `training backend '${backend}' ${values.enabled ? "ENABLED" : "configured (disabled)"}` +
        (values.keyCiphertext ? " with a credential" : " with NO credential — it will refuse every job"),
      detail: {
        phase: "backend_config",
        backend,
        enabled: values.enabled,
        baseUrl: values.baseUrl,
        hasCredential: values.keyCiphertext != null,
      },
    });
    const { keyCiphertext, ...rest } = row!;
    return { config: { ...rest, hasCredential: keyCiphertext != null } };
  });

  app.delete("/v1/llm/backend-configs/:backend", async (req, reply) => {
    const { backend } = backendParam.parse(req.params);
    const [removed] = await db
      .delete(trainingBackendConfigs)
      .where(eq(trainingBackendConfigs.backend, backend))
      .returning();
    if (!removed) return reply.status(404).send({ error: "unknown_backend_config" });
    await audit(db, {
      userId: actor(req),
      objectType: "training_job",
      objectId: null,
      ruleId: "llm-backend-config-removed",
      reason: `training backend '${backend}' configuration removed — it will refuse every job again`,
      detail: { phase: "backend_config", backend },
    });
    return { removed: true };
  });

  // --- datasets -----------------------------------------------------------

  app.get("/v1/llm/datasets", async () => {
    const rows = await db
      .select()
      .from(trainingDatasets)
      .orderBy(asc(trainingDatasets.name), desc(trainingDatasets.version));
    const jobCounts = await db
      .select({ datasetId: trainingJobs.datasetId, version: trainingJobs.datasetVersion, n: sql<number>`count(*)::int` })
      .from(trainingJobs)
      .groupBy(trainingJobs.datasetId, trainingJobs.datasetVersion);
    const used = new Map(jobCounts.map((c) => [`${c.datasetId}:${c.version}`, c.n]));
    return {
      datasets: rows.map((d) => ({
        ...d,
        jobCount: used.get(`${d.id}:${d.version}`) ?? 0,
        frozen: (used.get(`${d.id}:${d.version}`) ?? 0) > 0,
      })),
      note:
        "A dataset version FREEZES the moment a training job cites it. Editing mints the next version " +
        "instead — a claim about a model is worthless if the data behind it can move afterwards. Every " +
        "version carries the verdict of the PII/secret scan it passed at ingest.",
    };
  });

  /**
   * INGEST. The scan happens BEFORE the dataset exists, which is the entire
   * point: under a `block` mode a corpus carrying PII is refused and nothing is
   * written, so there is no window in which it was stored "just for a moment".
   */
  app.post("/v1/llm/datasets", async (req, reply) => {
    const body = createDatasetSchema.parse(req.body);
    if (!(await capabilityOn())) return reply.status(409).send(disabledReply);

    const [clash] = await db
      .select({ id: trainingDatasets.id })
      .from(trainingDatasets)
      .where(eq(trainingDatasets.name, body.name));
    if (clash) {
      return reply.status(409).send({
        error: "dataset_name_taken",
        detail: `a training dataset named '${body.name}' already exists — mint a new VERSION of it instead`,
      });
    }
    if (body.projectId) {
      const attribution = await assertProjectAttribution(db, body.projectId, req.authCtx.userId ?? NO_IDENTITY, req.authCtx.isAdmin);
      if (!attribution.ok) return reply.status(attribution.status).send({ error: attribution.error });
    }

    const rows: TrainingRow[] = body.rows.map((r) => ({
      input: r.input,
      output: r.output ?? null,
      ...(r.tags ? { tags: r.tags } : {}),
    }));

    const scan = await scanAndDecide(db, rows, body.piiMode, body.projectId ?? null);
    if (scan.verdict === "blocked") {
      await audit(db, {
        userId: actor(req),
        objectType: "training_dataset",
        objectId: null,
        ruleId: "llm-dataset-pii-blocked",
        effect: "deny",
        reason:
          `training dataset '${body.name}' was REFUSED at ingest: ${scan.summary}. ` +
          "Nothing was stored — by the time personal data is in a training corpus it is, for practical " +
          "purposes, in the model.",
        detail: { phase: "ingest", datasetName: body.name, mode: scan.mode, findings: scan.findings, rows: rows.length },
      });
      return reply.status(422).send({
        error: "training_data_refused",
        detail: scan.summary,
        mode: scan.mode,
        // COUNTS ONLY — never the matched text
        findings: scan.findings,
      });
    }

    const [dataset] = await db
      .insert(trainingDatasets)
      .values({
        name: body.name,
        version: 1,
        note: body.note ?? null,
        format: body.format,
        rowCount: rows.length,
        charCount: rows.reduce((a, r) => a + r.input.length + (r.output?.length ?? 0), 0),
        checksum: datasetChecksum(rows),
        piiVerdict: scan.verdict,
        piiMode: scan.mode,
        scanFindings: scan.findings as unknown as Record<string, unknown>,
        projectId: body.projectId ?? null,
        createdByUserId: actor(req),
      })
      .returning();

    await insertRows(db, dataset!.id, 1, rows);
    await audit(db, {
      userId: actor(req),
      objectType: "training_dataset",
      objectId: dataset!.id,
      ruleId: scan.verdict === "flagged" ? "llm-dataset-pii-flagged" : "llm-dataset-created",
      reason:
        scan.verdict === "flagged"
          ? `training dataset '${body.name}' v1 accepted WITH FINDINGS at ingest mode '${scan.mode}': ${scan.summary}`
          : `training dataset '${body.name}' v1 created (${rows.length} rows) — ingest scan clean`,
      detail: {
        phase: "ingest",
        datasetId: dataset!.id,
        version: 1,
        rows: rows.length,
        mode: scan.mode,
        verdict: scan.verdict,
        findings: scan.findings,
      },
    });
    return reply.status(201).send({ dataset, scan: { verdict: scan.verdict, mode: scan.mode, findings: scan.findings } });
  });

  app.get("/v1/llm/datasets/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [dataset] = await db.select().from(trainingDatasets).where(eq(trainingDatasets.id, id));
    if (!dataset) return reply.status(404).send({ error: "unknown_training_dataset" });
    const rows = await db
      .select()
      .from(trainingDatasetRows)
      .where(and(eq(trainingDatasetRows.datasetId, id), eq(trainingDatasetRows.datasetVersion, dataset.version)))
      .orderBy(asc(trainingDatasetRows.idx))
      .limit(500);
    const versions = await db
      .select({ id: trainingDatasets.id, version: trainingDatasets.version, rowCount: trainingDatasets.rowCount, checksum: trainingDatasets.checksum, createdAt: trainingDatasets.createdAt })
      .from(trainingDatasets)
      .where(eq(trainingDatasets.name, dataset.name))
      .orderBy(desc(trainingDatasets.version));
    const jobs = await db
      .select()
      .from(trainingJobs)
      .where(eq(trainingJobs.datasetId, id))
      .orderBy(desc(trainingJobs.createdAt));
    return {
      dataset,
      rows,
      versions,
      jobs,
      frozen: jobs.some((j) => j.datasetVersion === dataset.version),
    };
  });

  app.post("/v1/llm/datasets/:id/rows", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ rows: z.array(rowSchema).min(1).max(5000) }).strict().parse(req.body);
    if (!(await capabilityOn())) return reply.status(409).send(disabledReply);
    const [dataset] = await db.select().from(trainingDatasets).where(eq(trainingDatasets.id, id));
    if (!dataset) return reply.status(404).send({ error: "unknown_training_dataset" });
    if (await datasetIsFrozen(db, dataset.id, dataset.version)) {
      return reply.status(409).send({
        error: "dataset_version_frozen",
        detail:
          `version ${dataset.version} of '${dataset.name}' has already been trained on and is immutable — ` +
          `POST /v1/llm/datasets/${dataset.id}/versions to mint the next version, then edit that`,
      });
    }

    const existing = await loadRows(db, dataset.id, dataset.version);
    const added: TrainingRow[] = body.rows.map((r) => ({
      input: r.input,
      output: r.output ?? null,
      ...(r.tags ? { tags: r.tags } : {}),
    }));
    // THE SCAN RUNS ON THE ADDED ROWS TOO. A dataset that passed at ingest must
    // not become a laundering route for a second upload.
    const scan = await scanAndDecide(db, added, dataset.piiMode, dataset.projectId);
    if (scan.verdict === "blocked") {
      await audit(db, {
        userId: actor(req),
        objectType: "training_dataset",
        objectId: dataset.id,
        ruleId: "llm-dataset-pii-blocked",
        effect: "deny",
        reason: `rows appended to '${dataset.name}' v${dataset.version} were REFUSED: ${scan.summary}`,
        detail: { phase: "append", mode: scan.mode, findings: scan.findings, rows: added.length },
      });
      return reply.status(422).send({ error: "training_data_refused", detail: scan.summary, findings: scan.findings });
    }

    await insertRows(db, dataset.id, dataset.version, added, existing.length);
    const all = [...existing, ...added];
    const [updated] = await db
      .update(trainingDatasets)
      .set({
        rowCount: all.length,
        charCount: all.reduce((a, r) => a + r.input.length + (r.output?.length ?? 0), 0),
        checksum: datasetChecksum(all),
        // the version's verdict only ever gets WORSE, never better: a clean
        // corpus that later accepted flagged rows is a flagged corpus
        piiVerdict: dataset.piiVerdict === "flagged" || scan.verdict === "flagged" ? "flagged" : "clean",
      })
      .where(eq(trainingDatasets.id, dataset.id))
      .returning();
    return { dataset: updated, added: added.length, scan: { verdict: scan.verdict, findings: scan.findings } };
  });

  /** Mint version N+1, COPYING the current version's rows. This is the ONLY way
   * to change a frozen dataset — every earlier version keeps standing behind
   * the jobs and artifacts that cite it. */
  app.post("/v1/llm/datasets/:id/versions", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({ note: z.string().max(2000).optional(), rows: z.array(rowSchema).max(20_000).optional() })
      .strict()
      .parse(req.body ?? {});
    if (!(await capabilityOn())) return reply.status(409).send(disabledReply);
    const [dataset] = await db.select().from(trainingDatasets).where(eq(trainingDatasets.id, id));
    if (!dataset) return reply.status(404).send({ error: "unknown_training_dataset" });

    const rows: TrainingRow[] = body.rows
      ? body.rows.map((r) => ({ input: r.input, output: r.output ?? null, ...(r.tags ? { tags: r.tags } : {}) }))
      : await loadRows(db, dataset.id, dataset.version);

    const scan = await scanAndDecide(db, rows, dataset.piiMode, dataset.projectId);
    if (scan.verdict === "blocked") {
      return reply.status(422).send({ error: "training_data_refused", detail: scan.summary, findings: scan.findings });
    }

    const [maxRow] = await db
      .select({ max: sql<number>`coalesce(max(${trainingDatasets.version}), 0)::int` })
      .from(trainingDatasets)
      .where(eq(trainingDatasets.name, dataset.name));
    const nextVersion = (maxRow?.max ?? dataset.version) + 1;
    const [next] = await db
      .insert(trainingDatasets)
      .values({
        // A NEW ROW, with its own id — the `eval_datasets` discipline verbatim
        // (ADR-0044). The previous version is not touched, so a completed job's
        // `(dataset_id, dataset_version)` pair keeps resolving to precisely the
        // corpus it consumed however many versions the dataset later grows.
        name: dataset.name,
        version: nextVersion,
        note: body.note ?? dataset.note,
        format: dataset.format,
        rowCount: rows.length,
        charCount: rows.reduce((a, r) => a + r.input.length + (r.output?.length ?? 0), 0),
        checksum: datasetChecksum(rows),
        piiVerdict: scan.verdict,
        piiMode: scan.mode,
        scanFindings: scan.findings as unknown as Record<string, unknown>,
        projectId: dataset.projectId,
        createdByUserId: actor(req),
      })
      .returning();
    await insertRows(db, next!.id, nextVersion, rows);
    await audit(db, {
      userId: actor(req),
      objectType: "training_dataset",
      objectId: dataset.id,
      ruleId: "llm-dataset-version-minted",
      reason:
        `training dataset '${dataset.name}' v${nextVersion} minted with ${rows.length} rows — ` +
        `v${dataset.version} is unchanged and still stands behind every job that cited it`,
      detail: { phase: "version", datasetId: dataset.id, from: dataset.version, to: nextVersion, rows: rows.length },
    });
    return reply.status(201).send({ dataset: next, rows: rows.length, scan: { verdict: scan.verdict, findings: scan.findings } });
  });

  /** Dry-run: would this corpus train under this method, and what would it
   * cost? No row is written and no backend is contacted. */
  app.post("/v1/llm/datasets/:id/validate", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        method: z.enum(TRAINING_METHODS),
        backend: z.enum(TRAINING_BACKEND_KINDS).default("local"),
        hyperparameters: z.record(z.unknown()).default({}),
        pricePerMTokUsd: z.number().min(0).max(10_000).optional(),
      })
      .strict()
      .parse(req.body ?? {});
    const [dataset] = await db.select().from(trainingDatasets).where(eq(trainingDatasets.id, id));
    if (!dataset) return reply.status(404).send({ error: "unknown_training_dataset" });
    const rows = await loadRows(db, dataset.id, dataset.version);
    const hp = validateHyperparameters(body.method, body.hyperparameters);
    const backend = resolveTrainingBackend({ backend: body.backend });
    const validation = backend.validateDataset(rows, {
      format: dataset.format,
      method: body.method,
      ...(hp.ok ? { evalFraction: hp.value.evalFraction } : {}),
    });
    return {
      validation,
      hyperparameters: hp.ok ? hp.value : null,
      hyperparameterErrors: hp.ok ? [] : hp.errors,
      estimatedCostUsd: estimateTrainingCostUsd({
        method: body.method,
        backend: body.backend,
        charCount: dataset.charCount,
        epochs: hp.ok ? hp.value.epochs : 1,
        ...(body.pricePerMTokUsd !== undefined ? { pricePerMTokUsd: body.pricePerMTokUsd } : {}),
      }),
      capabilities: backend.capabilities,
    };
  });

  // --- jobs ---------------------------------------------------------------

  app.get("/v1/llm/jobs", async (req) => {
    const q = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50), status: z.string().optional() })
      .parse(req.query ?? {});
    const rows = await db
      .select()
      .from(trainingJobs)
      .where(q.status ? eq(trainingJobs.status, q.status as never) : undefined)
      .orderBy(desc(trainingJobs.createdAt))
      .limit(q.limit);
    const names = await db
      .select({ id: trainingDatasets.id, name: trainingDatasets.name })
      .from(trainingDatasets);
    const nameMap = new Map(names.map((n) => [n.id, n.name]));
    const artifacts = rows.length
      ? await db
          .select()
          .from(trainingArtifacts)
          .where(inArray(trainingArtifacts.jobId, rows.map((r) => r.id)))
      : [];
    const artifactByJob = new Map(artifacts.map((a) => [a.jobId, a]));
    return {
      jobs: rows.map((j) => ({
        ...j,
        datasetName: nameMap.get(j.datasetId) ?? null,
        artifactId: artifactByJob.get(j.id)?.id ?? null,
        inProcess: isInProcessMethod(j.method as TrainingMethod),
      })),
    };
  });

  /**
   * CREATE + START a training job.
   *
   * Deliberately NOT admin-only (it is in NON_ADMIN_ROUTES): the gate is the
   * caller's own entitlement to the BASE AGENT this customisation is anchored
   * to, checked below exactly as an invoke would check it. A user who cannot
   * use a model cannot train a derivative of it either.
   */
  app.post("/v1/llm/jobs", async (req, reply) => {
    const body = createJobSchema.parse(req.body);
    const userId = req.authCtx.userId;
    if (!userId) {
      return reply.status(403).send({
        error: "bootstrap_cannot_train",
        detail: "training runs under a named user's entitlement; the bootstrap token has no identity",
      });
    }
    const org = await loadOrgSettings(db);
    if (!org.llmTrainingEnabled) return reply.status(409).send(disabledReply);

    const [dataset] = await db.select().from(trainingDatasets).where(eq(trainingDatasets.id, body.datasetId));
    if (!dataset) return reply.status(404).send({ error: "unknown_training_dataset" });
    if (body.projectId) {
      const attribution = await assertProjectAttribution(db, body.projectId, userId, req.authCtx.isAdmin);
      if (!attribution.ok) return reply.status(attribution.status).send({ error: attribution.error });
    }

    // ENTITLEMENT, FIRST AND UNCONDITIONALLY.
    const [baseAgent] = await db.select().from(agents).where(eq(agents.id, body.baseAgentId));
    if (!baseAgent) return reply.status(404).send({ error: "unknown_agent" });
    const decide = await agentDecider(db, userId);
    const decision = decide(baseAgent, "execute");
    if (decision.effect !== "allow") {
      await db.insert(auditLog).values({
        userId,
        objectType: "training_job",
        objectId: null,
        detail: {
          phase: "agent-entitlement",
          baseAgentId: baseAgent.id,
          datasetId: dataset.id,
          datasetVersion: dataset.version,
          backend: body.backend,
          method: body.method,
        },
        effect: "deny",
        ruleId: decision.ruleId,
        ruleChain: decision.ruleChain,
        reason:
          `${decision.reason} — training a derivative of a model requires entitlement to that model, ` +
          "so no job was created",
      });
      return reply.status(403).send({ error: "agent_not_entitled", decision });
    }

    // VALIDATION, before anything is written.
    const rows = await loadRows(db, dataset.id, dataset.version);
    const hp = validateHyperparameters(body.method, body.hyperparameters);
    if (!hp.ok) {
      return reply.status(422).send({ error: "hyperparameters_invalid", detail: hp.errors.join("; ") });
    }
    const resolution = await resolveTrainingBackendForUse(db, body.backend, opts);
    if (!resolution.ok) {
      return reply.status(resolution.status).send({ error: resolution.error, detail: resolution.detail });
    }
    if (!resolution.backend.capabilities.methods.includes(body.method)) {
      return reply.status(409).send({
        error: "method_unsupported",
        detail:
          `backend '${body.backend}' cannot perform '${body.method}' — it offers ` +
          `${resolution.backend.capabilities.methods.join(", ")}`,
      });
    }
    const validation = resolution.backend.validateDataset(rows, {
      format: dataset.format,
      method: body.method,
      evalFraction: hp.value.evalFraction,
    });
    if (!validation.ok) {
      return reply.status(422).send({ error: "dataset_unusable", detail: validation.errors.join("; "), validation });
    }

    const estimate = estimateTrainingCostUsd({
      method: body.method,
      backend: body.backend,
      charCount: dataset.charCount,
      epochs: hp.value.epochs,
      ...(body.pricePerMTokUsd !== undefined ? { pricePerMTokUsd: body.pricePerMTokUsd } : {}),
    });
    if (estimate === null) {
      // A JOB WITH NO ESTIMATE CANNOT BE GATED. Refusing is the only honest
      // answer: starting it would mean the approval threshold silently did not
      // apply to the one job nobody could price.
      return reply.status(422).send({
        error: "cost_not_estimable",
        detail:
          `no list price is known for training on '${body.backend}', so the approval threshold cannot be ` +
          "applied. Supply pricePerMTokUsd (the vendor's per-million-training-token rate) and try again.",
      });
    }

    const threshold = org.llmTrainingApprovalThresholdUsd;
    const needsApproval = threshold > 0 && estimate >= threshold;
    const approverUserId = body.approverUserId ?? org.infraApproverUserId ?? null;
    if (needsApproval && !approverUserId) {
      return reply.status(422).send({
        error: "approver_required",
        detail:
          `this job's estimated $${estimate.toFixed(2)} is at or above the org's $${threshold.toFixed(2)} ` +
          "training-approval threshold, so it needs a named approver. Supply approverUserId, or set a " +
          "default approver in org settings.",
      });
    }
    if (needsApproval && approverUserId) {
      const [approver] = await db.select({ id: users.id }).from(users).where(eq(users.id, approverUserId));
      if (!approver) return reply.status(404).send({ error: "unknown_approver" });
    }

    const created = await db.transaction(async (tx) => {
      const [job] = await tx
        .insert(trainingJobs)
        .values({
          name: body.name,
          datasetId: dataset.id,
          // THE PIN. Recorded now, and the composite FK guarantees this exact
          // version survives every later edit of the dataset.
          datasetVersion: dataset.version,
          backend: body.backend,
          method: body.method,
          baseModel: body.baseModel ?? null,
          baseAgentId: baseAgent.id,
          // ONLY the dials this method actually reads. Storing the full
          // normalised set would put numbers on the row that nothing consumes,
          // and re-validating the row on an approved start would then trip the
          // very no-op check that exists to stop exactly that.
          hyperparameters: hp.applied,
          status: needsApproval ? "pending_approval" : "queued",
          estimatedCostUsd: estimate,
          projectId: body.projectId ?? null,
          initiatedByUserId: userId,
        })
        .returning();
      if (!needsApproval) return { job: job!, approvalId: null as string | null };
      // THE ONE APPROVALS QUEUE. objectType 'training_job'; the decision comes
      // back through POST /v1/approvals/:id/decide like everything else.
      const [queued] = await tx
        .insert(approvals)
        .values({
          userId,
          objectType: "training_job",
          approverUserId: approverUserId!,
          projectId: body.projectId ?? null,
          stageId: `__training_job__:${job!.id}`,
          status: "pending",
        })
        .returning();
      const [linked] = await tx
        .update(trainingJobs)
        .set({ approvalId: queued!.id })
        .where(eq(trainingJobs.id, job!.id))
        .returning();
      return { job: linked!, approvalId: queued!.id };
    });

    await audit(db, {
      userId,
      objectType: "training_job",
      objectId: created.job.id,
      ruleId: needsApproval ? "llm-training-job-queued-for-approval" : "llm-training-job-created",
      reason: needsApproval
        ? `training job '${body.name}' estimated at $${estimate.toFixed(2)} is at or above the $${threshold.toFixed(2)} threshold — queued for approval, nothing has started`
        : `training job '${body.name}' created on backend '${body.backend}' (${body.method}) against dataset '${dataset.name}' v${dataset.version}`,
      detail: {
        phase: "create",
        backend: body.backend,
        method: body.method,
        baseAgentId: baseAgent.id,
        datasetId: dataset.id,
        datasetVersion: dataset.version,
        datasetChecksum: dataset.checksum,
        estimatedCostUsd: estimate,
        approvalId: created.approvalId,
        warnings: validation.warnings,
      },
    });

    if (needsApproval) {
      return reply.status(202).send({
        job: created.job,
        approvalId: created.approvalId,
        validation,
        note:
          "Queued in the ONE Approvals Queue. Nothing has started and nothing has been billed — decide " +
          "it at POST /v1/approvals/:approvalId/decide.",
      });
    }

    const result = await runTrainingJob(db, created.job.id, opts);
    return reply.status(201).send({
      job: result.job,
      // the SUMMARY, never the raw row: an inline artifact's payload holds a
      // normalised copy of every training row, and returning it from the create
      // call would make "train a model" quietly also mean "download the corpus"
      artifact: result.artifact ? publicArtifact(result.artifact) : null,
      validation,
      ...(result.refusal ? { refusal: result.refusal } : {}),
    });
  });

  app.get("/v1/llm/jobs/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [job] = await db.select().from(trainingJobs).where(eq(trainingJobs.id, id));
    if (!job) return reply.status(404).send({ error: "unknown_training_job" });
    const [artifact] = await db.select().from(trainingArtifacts).where(eq(trainingArtifacts.jobId, id));
    const [dataset] = await db
      .select()
      .from(trainingDatasets)
      .where(and(eq(trainingDatasets.id, job.datasetId), eq(trainingDatasets.version, job.datasetVersion)));
    return {
      job,
      // WHAT IT ACTUALLY TRAINED ON — the pinned version, not "the dataset",
      // which may since have moved on to v2 or v7.
      trainedOn: dataset ?? null,
      artifact: artifact ? publicArtifact(artifact) : null,
      inProcess: isInProcessMethod(job.method as TrainingMethod),
    };
  });

  app.post("/v1/llm/jobs/:id/cancel", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [job] = await db.select().from(trainingJobs).where(eq(trainingJobs.id, id));
    if (!job) return reply.status(404).send({ error: "unknown_training_job" });
    if (["succeeded", "failed", "cancelled", "refused"].includes(job.status)) {
      return reply.status(409).send({ error: "job_already_terminal", detail: `job is '${job.status}'` });
    }
    if (job.status === "running") {
      const resolution = await resolveTrainingBackendForUse(db, job.backend as TrainingBackendKind, opts);
      if (resolution.ok) {
        try {
          await resolution.backend.cancelJob({
            backend: job.backend as TrainingBackendKind,
            jobId: job.id,
            externalJobId: job.externalJobId,
          });
        } catch {
          /* the backend may have finished already; the local state below is the record */
        }
      }
    }
    const result = await finishCancelled(db, job);
    await audit(db, {
      userId: actor(req),
      objectType: "training_job",
      objectId: job.id,
      ruleId: "llm-training-job-cancelled",
      reason: `training job '${job.name}' cancelled`,
      detail: { phase: "cancel", backend: job.backend, previousStatus: job.status },
    });
    return { job: result.job };
  });

  /** poll ONE job on demand — the manual door to the same function the
   * ADR-0064 sweep drives */
  app.post("/v1/llm/jobs/:id/poll", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [job] = await db.select().from(trainingJobs).where(eq(trainingJobs.id, id));
    if (!job) return reply.status(404).send({ error: "unknown_training_job" });
    if (job.status !== "running") {
      return reply.status(409).send({ error: "job_not_running", detail: `job is '${job.status}'` });
    }
    const result = await pollTrainingJob(db, job, opts);
    return { job: result.job, artifact: result.artifact ? publicArtifact(result.artifact) : null };
  });

  /** the sweep, as an ENDPOINT. ADR-0064's scheduler drives the SAME function. */
  app.post("/v1/llm/jobs/poll-sweep", async () => {
    const result = await runTrainingJobPollSweep(db, opts);
    return { ...result, note: TRAINING_POLL_SWEEP_NOTE };
  });

  // --- artifacts ----------------------------------------------------------

  app.get("/v1/llm/artifacts", async () => {
    const rows = await db.select().from(trainingArtifacts).orderBy(desc(trainingArtifacts.createdAt));
    const jobs = rows.length
      ? await db.select().from(trainingJobs).where(inArray(trainingJobs.id, rows.map((r) => r.jobId)))
      : [];
    const jobById = new Map(jobs.map((j) => [j.id, j]));
    return {
      artifacts: rows.map((a) => ({
        ...publicArtifact(a),
        job: jobById.get(a.jobId) ?? null,
      })),
      note:
        "An artifact produced by the 'local' backend is a retrieval index or a small classifier and can " +
        "be queried here. An artifact from a remote backend is a REFERENCE to weights that live on the " +
        "vendor's side — regulAIt cannot run inference against it and does not claim to.",
    };
  });

  app.get("/v1/llm/artifacts/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [artifact] = await db.select().from(trainingArtifacts).where(eq(trainingArtifacts.id, id));
    if (!artifact) return reply.status(404).send({ error: "unknown_artifact" });
    const [job] = await db.select().from(trainingJobs).where(eq(trainingJobs.id, artifact.jobId));
    const [dataset] = job
      ? await db
          .select()
          .from(trainingDatasets)
          .where(and(eq(trainingDatasets.id, job.datasetId), eq(trainingDatasets.version, job.datasetVersion)))
      : [];
    const [card] = artifact.modelCardId
      ? await db.select().from(modelCards).where(eq(modelCards.id, artifact.modelCardId))
      : [];
    const [agent] = artifact.agentId
      ? await db.select().from(agents).where(eq(agents.id, artifact.agentId))
      : [];
    return {
      artifact: publicArtifact(artifact),
      job: job ?? null,
      trainedOn: dataset ?? null,
      modelCard: card ?? null,
      agent: agent ?? null,
    };
  });

  /**
   * QUERY THE ARTIFACT. The same pure `queryArtifact` the inference path uses,
   * so a model cannot answer one way here and another way through a dispatch.
   *
   * Admin-only by the default gate, and deliberately so: this is a bench test
   * of an artifact that has not necessarily been registered, so it does not go
   * through the MRM gate. The governed path for everybody else is to register
   * it as an agent and invoke it — which is entitled, carded and metered.
   */
  app.post("/v1/llm/artifacts/:id/query", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({ query: z.string().min(1).max(20_000), topK: z.number().int().min(1).max(25).optional() })
      .strict()
      .parse(req.body);
    const [artifact] = await db.select().from(trainingArtifacts).where(eq(trainingArtifacts.id, id));
    if (!artifact) return reply.status(404).send({ error: "unknown_artifact" });
    if (artifact.kind !== "inline" || !artifact.payload) {
      return reply.status(409).send({
        error: "artifact_not_queryable",
        detail:
          `artifact '${artifact.name}' lives on the training backend (${artifact.location ?? "unknown"}). ` +
          "RegulAIt holds a reference to it and cannot run inference against it here.",
      });
    }
    try {
      const result = queryArtifact(artifact.payload, body.query, {
        ...(body.topK !== undefined ? { topK: body.topK } : {}),
      });
      await audit(db, {
        userId: actor(req),
        objectType: "training_artifact",
        objectId: artifact.id,
        ruleId: "llm-artifact-queried",
        reason: `artifact '${artifact.name}' (${artifact.method}) was queried from the admin bench`,
        // the QUERY is not stored — a bench query against a corpus is exactly
        // the kind of text §8.4 keeps out of the audit trail. Its hash makes
        // repeat queries correlatable without retaining the content.
        detail: {
          phase: "query",
          method: artifact.method,
          queryHash: crypto.createHash("sha256").update(body.query).digest("hex").slice(0, 16),
          answered: result.answer != null,
        },
      });
      return { ...result, artifactId: artifact.id, name: artifact.name };
    } catch (err) {
      if (err instanceof TrainingBackendError) {
        return reply.status(err.status).send({ error: err.code, detail: err.message });
      }
      throw err;
    }
  });

  /**
   * REGISTER AN ARTIFACT FOR INFERENCE.
   *
   * This is the moment a thing somebody trained becomes a thing the platform
   * will dispatch to, so it does three governed things at once and none of them
   * is optional:
   *   1. mints a registry agent with provider `regulait_llm`, at the BASE
   *      AGENT's tier — an artifact cannot be promoted above the model it was
   *      anchored to,
   *   2. mints an ADR-0045 MODEL CARD for it, carrying the backend's own honest
   *      `limits` string as the declared limitations, so with `mrmEnforced` on
   *      it cannot be dispatched until a human accepts the risk,
   *   3. leaves it UNPRICED (`costPerMTok*` null) — nothing is billed, and a
   *      zero price would make the pillar-6 optimizer route every request onto
   *      a retrieval index because it looked free.
   */
  app.post("/v1/llm/artifacts/:id/register", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        agentName: z.string().min(1).max(200),
        intendedUse: z.string().min(1).max(2000),
        dataClaims: z.string().max(4000).optional(),
        modes: z.array(z.string().min(1)).nullable().optional(),
        tier: z.number().int().min(0).max(100).optional(),
      })
      .strict()
      .parse(req.body);
    if (!(await capabilityOn())) return reply.status(409).send(disabledReply);

    const [artifact] = await db.select().from(trainingArtifacts).where(eq(trainingArtifacts.id, id));
    if (!artifact) return reply.status(404).send({ error: "unknown_artifact" });
    if (artifact.agentId) {
      return reply.status(409).send({ error: "already_registered", detail: `artifact '${artifact.name}' is already served by an agent` });
    }
    if (artifact.kind !== "inline") {
      return reply.status(409).send({
        error: "artifact_not_servable",
        detail:
          "this artifact's weights live on the training backend. Register the endpoint that serves it as " +
          "a custom model provider (ADR-0034) instead — RegulAIt will not pretend it can run it here.",
      });
    }
    const [job] = await db.select().from(trainingJobs).where(eq(trainingJobs.id, artifact.jobId));
    const [baseAgent] = job?.baseAgentId
      ? await db.select().from(agents).where(eq(agents.id, job.baseAgentId))
      : [];
    const [clash] = await db.select({ id: agents.id }).from(agents).where(eq(agents.name, body.agentName));
    if (clash) return reply.status(409).send({ error: "agent_name_taken" });

    const backend = resolveTrainingBackend({ backend: (job?.backend ?? "local") as TrainingBackendKind });
    const [dataset] = job
      ? await db
          .select()
          .from(trainingDatasets)
          .where(and(eq(trainingDatasets.id, job.datasetId), eq(trainingDatasets.version, job.datasetVersion)))
      : [];

    const registered = await db.transaction(async (tx) => {
      const [agent] = await tx
        .insert(agents)
        .values({
          name: body.agentName,
          provider: "regulait_llm",
          // never above the model it was anchored to
          tier: body.tier ?? baseAgent?.tier ?? 1,
          modes: body.modes ?? null,
          enabled: true,
          // UNPRICED ON PURPOSE — see the header note (3)
          costPerMTokIn: null,
          costPerMTokOut: null,
          model: artifact.name,
        })
        .returning();
      const [card] = await tx
        .insert(modelCards)
        .values({
          agentId: agent!.id,
          intendedUse: body.intendedUse,
          // MEASURED provenance, not a vendor's assertion. This is the one
          // model card in the product whose data claims RegulAIt can actually
          // stand behind, because it watched the corpus arrive: the exact
          // version, its row count, its content checksum and the verdict of
          // the ingest scan it passed.
          dataClaims: {
            source: "regulait-llm",
            method: artifact.method,
            backend: job?.backend ?? null,
            ...(dataset
              ? {
                  datasetName: dataset.name,
                  datasetVersion: dataset.version,
                  rows: dataset.rowCount,
                  checksum: dataset.checksum,
                  ingestScanVerdict: dataset.piiVerdict,
                  ingestScanMode: dataset.piiMode,
                }
              : {}),
            ...(body.dataClaims ? { note: body.dataClaims } : {}),
          },
          // THE BACKEND'S OWN LIMITS STRING, verbatim. The person accepting the
          // risk reads what this thing actually is at the moment they sign.
          limitations: backend.capabilities.limits,
          biasFairness: [],
          standardRefs: [],
          note: `Auto-created by RegulAIt-LLM for artifact ${artifact.id} (method ${artifact.method}).`,
          createdByUserId: actor(req),
        })
        .returning();
      const [updated] = await tx
        .update(trainingArtifacts)
        .set({ agentId: agent!.id, modelCardId: card!.id })
        .where(eq(trainingArtifacts.id, artifact.id))
        .returning();
      return { agent: agent!, card: card!, artifact: updated! };
    });

    await audit(db, {
      userId: actor(req),
      objectType: "training_artifact",
      objectId: artifact.id,
      ruleId: "llm-artifact-registered",
      reason:
        `artifact '${artifact.name}' (${artifact.method}) registered as agent '${body.agentName}' and given a ` +
        "model card — with mrmEnforced on it stays undispatchable until a human accepts the risk",
      detail: {
        phase: "registration",
        agentId: registered.agent.id,
        modelCardId: registered.card.id,
        method: artifact.method,
        tier: registered.agent.tier,
        baseAgentId: job?.baseAgentId ?? null,
      },
    });
    return reply.status(201).send({
      agent: registered.agent,
      modelCard: registered.card,
      artifact: publicArtifact(registered.artifact),
      note:
        "The agent is unpriced by design: nothing is billed for serving it, and a zero price would make " +
        "the optimizer route traffic onto it because it looked cheap. Grant it to users like any other " +
        "agent; it dispatches through the same governed core.",
    });
  });

  // --- helpers ------------------------------------------------------------

  /** the SCAN + the composed mode + the verdict, in one place so ingest,
   * append and version-mint cannot disagree */
  async function scanAndDecide(
    database: Db,
    rows: TrainingRow[],
    requested: GuardrailMode | undefined,
    projectId: string | null,
  ): Promise<{ verdict: "clean" | "flagged" | "blocked"; mode: GuardrailMode; findings: ScanFindings; summary: string }> {
    const policy = await resolveGuardrailPolicy(database, { projectId });
    // §8.3's PII floor for the project, expressed in the guardrail vocabulary.
    // `projectPiiMode` returns log|warn|block or null; null means "no floor".
    // Since the ADR-0021 amendment an UNATTRIBUTED ingest also resolves here —
    // to the org defaultPiiMode — so training data cannot dodge the floor by
    // omitting the project any more than a dispatch can.
    const piiFloor = (await projectPiiMode(database, projectId)) as GuardrailMode | null;
    const mode = effectiveIngestMode(requested, piiFloor);
    // The detectors run at their configured strength for content classes, and
    // PII runs at the composed ingest mode above.
    const scan = scanTrainingRows(rows, policy.modes);
    const findings = scan.findings;
    const anything = scan.hasPii || findings.guardrails.length > 0;
    if (!anything) {
      return { verdict: "clean", mode, findings, summary: "no PII or guardrail findings" };
    }
    const piiSummary = findings.pii.map((f) => `${f.category}×${f.count}`).join(", ");
    const guardSummary = findings.guardrails.map((f) => `${f.detector}/${f.category}×${f.count}`).join(", ");
    const summary = [piiSummary && `PII: ${piiSummary}`, guardSummary && `content: ${guardSummary}`]
      .filter(Boolean)
      .join("; ");
    const blocked = (scan.hasPii && mode === "block") || scan.guardrailBlocked;
    return { verdict: blocked ? "blocked" : "flagged", mode, findings, summary };
  }

  async function insertRows(
    database: Db,
    datasetId: string,
    version: number,
    rows: TrainingRow[],
    offset = 0,
  ): Promise<void> {
    if (rows.length === 0) return;
    // chunked so a large corpus does not build one enormous parameterised
    // statement — Postgres has a hard parameter ceiling and a 20k-row upload
    // would sail straight past it
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await database.insert(trainingDatasetRows).values(
        rows.slice(i, i + CHUNK).map((r, j) => ({
          datasetId,
          datasetVersion: version,
          idx: offset + i + j,
          input: r.input,
          output: r.output ?? null,
          tags: r.tags ?? [],
        })),
      );
    }
  }
}

/** true once a training job cites this exact (dataset, version) pair */
export async function datasetIsFrozen(db: Db, datasetId: string, version: number): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(trainingJobs)
    .where(and(eq(trainingJobs.datasetId, datasetId), eq(trainingJobs.datasetVersion, version)));
  return (row?.n ?? 0) > 0;
}

/**
 * The read-back projection. The learned model is SUMMARISED rather than
 * returned whole: a TF-IDF index over a 20k-row corpus contains a normalised
 * copy of every document, so shipping it down a list endpoint would turn a
 * metadata read into a bulk export of the training data. `GET
 * /v1/llm/artifacts/:id` returns the same summary; the payload itself is only
 * ever used server-side, to answer a query.
 */
export function publicArtifact(a: TrainingArtifactRow) {
  const payload = a.payload ?? null;
  const kindTag = payload ? String((payload as Record<string, unknown>)["kind"] ?? "") : null;
  return {
    id: a.id,
    jobId: a.jobId,
    name: a.name,
    method: a.method,
    baseModel: a.baseModel,
    kind: a.kind,
    location: a.location,
    metrics: a.metrics,
    agentId: a.agentId,
    modelCardId: a.modelCardId,
    createdAt: a.createdAt,
    queryable: a.kind === "inline" && payload != null,
    payloadKind: kindTag,
    payloadSummary: summarisePayload(payload),
  };
}

function summarisePayload(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!payload) return null;
  const kind = payload["kind"];
  if (kind === "tfidf_index_v1") {
    return {
      kind,
      documents: Array.isArray(payload["docs"]) ? (payload["docs"] as unknown[]).length : 0,
      vocabularySize: payload["vocabularySize"] ?? null,
      topK: payload["topK"] ?? null,
    };
  }
  if (kind === "logreg_bow_v1") {
    const vocab = payload["vocabulary"];
    return {
      kind,
      labels: payload["labels"] ?? [],
      vocabularySize: Array.isArray(vocab) ? vocab.length : 0,
      epochs: payload["epochs"] ?? null,
      lossCurve: payload["lossCurve"] ?? null,
      // the 20 highest-weighted terms per class — a genuinely inspectable
      // model, which is one of the few honest advantages of a small one
      topTerms: topTermsPerLabel(payload),
    };
  }
  return { kind: kind ?? null };
}

function topTermsPerLabel(payload: Record<string, unknown>): Record<string, string[]> {
  const labels = (payload["labels"] as string[] | undefined) ?? [];
  const vocab = (payload["vocabulary"] as string[] | undefined) ?? [];
  const weights = (payload["weights"] as number[][] | undefined) ?? [];
  const out: Record<string, string[]> = {};
  labels.forEach((label, li) => {
    const w = weights[li] ?? [];
    out[label] = vocab
      .map((term, i) => ({ term, weight: w[i] ?? 0 }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 20)
      .filter((t) => t.weight > 0)
      .map((t) => t.term);
  });
  return out;
}

/** exported for the org-settings surface: the two dials, in one place */
export async function setLlmTrainingSettings(
  db: Db,
  values: { enabled?: boolean; thresholdUsd?: number },
  actorUserId: string | null,
): Promise<void> {
  await db
    .update(orgSettings)
    .set({
      ...(values.enabled !== undefined ? { llmTrainingEnabled: values.enabled } : {}),
      ...(values.thresholdUsd !== undefined ? { llmTrainingApprovalThresholdUsd: values.thresholdUsd } : {}),
      updatedBy: actorUserId,
      updatedAt: new Date(),
    })
    .where(eq(orgSettings.id, ORG_SETTINGS_ID));
}
