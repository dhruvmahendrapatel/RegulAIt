/**
 * ADR-0345 slice 2a: the scheduled run of the agent-risk proofs, and their evidence.
 *
 * Every proof in `AGENT_RISKS` (`@regulait/shared`) runs through an EXISTING engine; nothing here is a new test runner
 * (ADR-0176):
 *   - `assurance_metric`: ADR-0180's `measureAssuranceMetric`, judged by its own `measurementStateFor`;
 *   - `ledger_check`:     ADR-0060's `verifyAuditChain` (the chain verifies), and a read of the ADR-0081 register
 *                         (every live risk has an active owner, a scope and a review inside the window);
 *   - `gateway_probe`:    not built yet (slice 2b). Each is recorded as `not_run`, which is never a pass, so the page
 *                         shows a raised alert for it rather than a green tick.
 *
 * Each result is one append-only `agent_risk_proof_results` row written in the SAME transaction as its audit row,
 * which `withAuditChain` (applied by `createDb`) hash-chains. The audit row's `detail.contentHash` carries the result's
 * own hash, so a verifier can tie the two together. When the ADR-0116 export key is configured, the result is also
 * Ed25519-signed; otherwise `signature` and `signing_key_id` stay null and the result reads as unsigned.
 *
 * Anything but `pass` raises a governance alert (ADR-0157, deduped per proof while open) and an approvals-queue item
 * for an owner to acknowledge, both linked in `agent_risk_proof_followups`. A later `pass` resolves the open alert.
 *
 * RLS: results and follow-ups accept inserts only under the `system_task` (or `migration`) reason. The scheduler
 * already runs every job under `system_task`; a manual run route must wrap its call in `runWithRlsSystem`.
 */
import {
  agentRiskProofResults,
  agentRiskProofFollowups,
  agentRiskProofSettings,
  agents,
  aiRisks,
  approvals,
  auditLog,
  governanceAlerts,
  users,
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  ne,
  sql,
  type Db,
} from "@regulait/db";
import {
  AGENT_RISK_CATALOG_VERSION,
  AGENT_RISK_PROOF_ORIGIN_TAG,
  LIVE_RISK_STATUSES,
  agentRiskProofs,
  canonicalJson,
  measurementStateFor,
  sha256Hex,
  type AgentRisk,
  type AgentRiskProof,
  type AgentRiskProofTrigger,
  type MeasureAssuranceMetricFn,
  type MeasurementState,
  type MonitorFinding,
} from "@regulait/shared";
import { afterAlertsRaised, alertOwnershipAtRaise } from "./alert-ownership.js";
import { resolveAnchorSink, verifyAuditChain, type VerifyReport } from "./audit-chain.js";
import { measureAssuranceMetric } from "./condition-metrics.js";
import { resolveExportSigningKey, type ExportSigningKey, type ExportSigningRefusal } from "./export-bundle.js";
import type { SchedulerJobDefinition } from "./scheduler.js";
import { oldestActiveAdmin, systemAttributionActor } from "./system-attribution.js";

export const AGENT_RISK_PROOF_JOB_NAME = "agent-risk-proof-sweep";
/** the governance alert rule a failed proof raises; subject key = the proof key */
export const AGENT_RISK_PROOF_ALERT_RULE = "agent_risk_proof_failed";
/** the approvals-queue stage an acknowledgement waits on: prefix + proof key */
export const AGENT_RISK_PROOF_APPROVAL_STAGE_PREFIX = "agent-risk-proof:";
export const AGENT_RISK_PROOF_AUDIT_RULES = {
  result: "agent-risk-proof-result",
  alertRaised: "agent-risk-proof-alert-raised",
  alertResolved: "agent-risk-proof-alert-resolved",
  followupFailed: "agent-risk-proof-followup-failed",
  runFailed: "agent-risk-proof-run-failed",
} as const;
/**
 * The register-hygiene review window. ADR-0345 owner question: 90 days is the proposed default. `ai_risks` has no
 * review-date column, so the last review is its `updated_at` (the last recorded change to the risk).
 */
export const AGENT_RISK_REVIEW_WINDOW_DAYS = 90;
/** detail fields are bounded so a result row stays small */
const MAX_DETAIL_ITEMS = 50;
const HOUR_MS = 3_600_000;

/** the engines' seams, injectable for tests; production uses the real ones */
export interface AgentRiskProofDeps {
  measure: MeasureAssuranceMetricFn<Db>;
  verifyChain: (db: Db) => Promise<VerifyReport>;
  signingKey: () => ExportSigningKey | ExportSigningRefusal;
}

const DEFAULT_DEPS: AgentRiskProofDeps = {
  measure: measureAssuranceMetric,
  verifyChain: (db) => verifyAuditChain(db, resolveAnchorSink(process.env)),
  signingKey: resolveExportSigningKey,
};

export interface EngineResult {
  outcome: MeasurementState;
  detail: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// the engines
// ---------------------------------------------------------------------------

async function runAssuranceMetric(db: Db, proof: AgentRiskProof, now: Date, deps: AgentRiskProofDeps): Promise<EngineResult> {
  const spec = proof.metric!;
  // a tenant-wide proof: every registered agent (`measureAssuranceMetric` reads an empty scope as nothing to measure)
  const agentIds = (await db.select({ id: agents.id }).from(agents).orderBy(asc(agents.id))).map((a) => a.id);
  if (agentIds.length === 0) return { outcome: "not_run", detail: { reason: "no_agents_registered", metric: spec.metric } };
  const m = await deps.measure(db, spec, { projectId: null, agentIds }, now);
  return {
    outcome: m.state,
    detail: {
      metric: spec.metric,
      operator: spec.operator,
      threshold: spec.threshold,
      windowDays: spec.windowDays,
      value: m.value,
      samples: m.samples,
      agents: agentIds.length,
      evidence: m.evidence.slice(0, MAX_DETAIL_ITEMS),
    },
  };
}

async function runAuditChainCheck(db: Db, deps: AgentRiskProofDeps): Promise<EngineResult> {
  const r = await deps.verifyChain(db);
  const detail: Record<string, unknown> = {
    status: r.status,
    scannedRows: r.scanned.rows,
    bounded: r.scanned.bounded,
    firstBreakSeq: r.firstBreak?.seq ?? null,
    anchor: { checked: r.anchor.checked, source: r.anchor.source, tamperResistant: r.anchor.tamperResistant, matches: r.anchor.matches ?? null },
  };
  if (r.status === "empty") return { outcome: "not_run", detail };
  // a broken chain, or an anchor the head disagrees with, is a failure
  if (r.status !== "ok" || r.anchor.matches === false) return { outcome: "fail", detail };
  // ADR-0180, fail closed (#1039 security review): an intact chain proves nothing on its own. Without a
  // tamper-resistant anchor that was checked and matched, anyone who can write the database can re-hash the whole
  // chain consistently, and a partial scan cannot see the history in front of it. Neither is a pass.
  if (r.scanned.bounded) return { outcome: "insufficient", detail: { ...detail, reason: "partial_scan" } };
  if (!r.anchor.checked || r.anchor.matches !== true) return { outcome: "insufficient", detail: { ...detail, reason: "no_anchor_checked" } };
  if (!r.anchor.tamperResistant) return { outcome: "insufficient", detail: { ...detail, reason: "anchor_not_tamper_resistant" } };
  return { outcome: "pass", detail };
}

async function runRegisterHygiene(db: Db, now: Date): Promise<EngineResult> {
  const rows = await db
    .select({
      id: aiRisks.id,
      updatedAt: aiRisks.updatedAt,
      projectId: aiRisks.projectId,
      agentId: aiRisks.agentId,
      useCaseId: aiRisks.useCaseId,
      vendorId: aiRisks.vendorId,
      ownerDisabledAt: users.disabledAt,
    })
    .from(aiRisks)
    .innerJoin(users, eq(users.id, aiRisks.ownerUserId))
    .where(inArray(aiRisks.status, [...LIVE_RISK_STATUSES]));
  const stale = now.getTime() - AGENT_RISK_REVIEW_WINDOW_DAYS * 24 * HOUR_MS;
  const problems = rows.flatMap((r) => {
    const why: string[] = [];
    if (r.ownerDisabledAt !== null) why.push("owner_inactive");
    if (!r.projectId && !r.agentId && !r.useCaseId && !r.vendorId) why.push("no_scope");
    if (r.updatedAt.getTime() < stale) why.push("review_overdue");
    return why.length ? [{ riskId: r.id, why }] : [];
  });
  const outcome = measurementStateFor({ value: problems.length, samples: rows.length, minSamples: 1, operator: "lte", threshold: 0 });
  return {
    outcome,
    detail: { liveRisks: rows.length, failing: problems.length, reviewWindowDays: AGENT_RISK_REVIEW_WINDOW_DAYS, problems: problems.slice(0, MAX_DETAIL_ITEMS) },
  };
}

/** run one proof through its engine. Never throws: an engine that throws is `not_run`, never a pass. */
export async function runAgentRiskProofEngine(
  db: Db,
  proof: AgentRiskProof,
  now: Date,
  deps: AgentRiskProofDeps = DEFAULT_DEPS,
): Promise<EngineResult> {
  try {
    switch (proof.engine) {
      case "assurance_metric":
        return await runAssuranceMetric(db, proof, now, deps);
      case "ledger_check":
        return proof.check === "audit_chain_verifies" ? await runAuditChainCheck(db, deps) : await runRegisterHygiene(db, now);
      case "gateway_probe":
        return { outcome: "not_run", detail: { reason: "probe_harness_not_built", probe: proof.probe } };
    }
  } catch (err) {
    // the error's class only: a message may carry tenant data, and the row is evidence that outlives the incident
    return { outcome: "not_run", detail: { reason: "engine_error", error: err instanceof Error ? err.name : "unknown" } };
  }
}

// ---------------------------------------------------------------------------
// evidence
// ---------------------------------------------------------------------------

/** the canonical bytes a result's hash and signature cover (ADR-0060's canonical JSON) */
export function agentRiskProofEvidence(r: {
  proofKey: string;
  riskKey: string;
  catalogVersion: number;
  trigger: AgentRiskProofTrigger;
  outcome: MeasurementState;
  startedAt: Date;
  finishedAt: Date;
  detail: Record<string, unknown>;
}): string {
  return canonicalJson({
    proofKey: r.proofKey,
    riskKey: r.riskKey,
    catalogVersion: r.catalogVersion,
    trigger: r.trigger,
    outcome: r.outcome,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt.toISOString(),
    detail: r.detail,
  });
}

export interface RecordedProof {
  resultId: string;
  outcome: MeasurementState;
  contentHash: string;
  signed: boolean;
  alertId: string | null;
  approvalId: string | null;
}

interface Attribution {
  /** the audit attribution: the oldest active admin, else the all-zero system id (audit_log has no FK to users) */
  actor: string;
  /** a real user for the FK'd columns (`run_as_user_id`, `approvals.user_id`), or null when no admin exists */
  admin: string | null;
}

/** a non-pass: raise (or refresh) the proof's open alert and its pending acknowledgement, and link them to the result */
async function raiseFollowups(
  tx: Db,
  risk: AgentRisk,
  proof: AgentRiskProof,
  resultId: string,
  outcome: MeasurementState,
  who: Attribution,
  now: Date,
): Promise<{ alertId: string | null; approvalId: string | null; raised: string | null }> {
  const severity = outcome === "fail" ? "high" : "medium";
  const title = `Agent risk proof ${outcome === "fail" ? "failed" : outcome === "insufficient" ? "had too little data" : "did not run"}: ${proof.key}`;
  const detail = { proofKey: proof.key, riskKey: risk.key, outcome, resultId, assertion: proof.assertion };
  // ADR-0182 S5: owner and due time decided at raise, by the same function the monitor uses. Its finding type names
  // the monitor's own rules; only subjectKey, severity and detail are read, so the cast is to that shape.
  const ownership = await alertOwnershipAtRaise(
    tx,
    { ruleId: AGENT_RISK_PROOF_ALERT_RULE, subjectKey: proof.key, severity, title, detail } as unknown as MonitorFinding,
    now,
  );
  const [inserted] = await tx
    .insert(governanceAlerts)
    .values({
      ruleId: AGENT_RISK_PROOF_ALERT_RULE,
      subjectKey: proof.key,
      severity,
      title,
      detail,
      firstDetectedAt: now,
      lastDetectedAt: now,
      ownerUserId: ownership.ownerUserId,
      ownerSource: ownership.ownerSource,
      dueAt: ownership.dueAt,
    })
    .onConflictDoNothing()
    .returning({ id: governanceAlerts.id, ownerUserId: governanceAlerts.ownerUserId });
  let alertId: string | null = inserted?.id ?? null;
  let alertOwner: string | null = inserted?.ownerUserId ?? null;
  if (inserted) {
    await tx.insert(auditLog).values({
      userId: who.actor,
      objectType: "governance_alert",
      objectId: inserted.id,
      detail: { ruleId: AGENT_RISK_PROOF_ALERT_RULE, subjectKey: proof.key, severity, resultId },
      effect: "allow",
      ruleId: AGENT_RISK_PROOF_AUDIT_RULES.alertRaised,
      ruleChain: [],
      reason: `governance alert raised (${severity}): ${title}`,
    });
  } else {
    // the episode is already open (the partial unique index deduped it): refresh it and link this result to it
    const [open] = await tx
      .update(governanceAlerts)
      .set({ lastDetectedAt: now, detail, severity, title })
      .where(and(eq(governanceAlerts.ruleId, AGENT_RISK_PROOF_ALERT_RULE), eq(governanceAlerts.subjectKey, proof.key), ne(governanceAlerts.status, "resolved")))
      .returning({ id: governanceAlerts.id, ownerUserId: governanceAlerts.ownerUserId });
    alertId = open?.id ?? null;
    alertOwner = open?.ownerUserId ?? null;
  }

  // The acknowledgement: one pending per proof. `approvals.user_id` has a foreign key to users, so the requester is
  // the attributed admin, never the all-zero id; with no admin there is no one to ask, which the audit row records.
  // The approver is someone other than the requester wherever the deployment has one (#1039 security review): the
  // alert's owner, else another active admin. Only a single-admin deployment gets a self-review, which the queue
  // badges and which needs a recorded reason to decide.
  const stageId = `${AGENT_RISK_PROOF_APPROVAL_STAGE_PREFIX}${proof.key}`;
  const [pending] = await tx
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(eq(approvals.objectType, "agent_risk_proof"), eq(approvals.stageId, stageId), eq(approvals.status, "pending")))
    .limit(1);
  let approvalId = pending?.id ?? null;
  if (!approvalId && who.admin) {
    const approver =
      (alertOwner && alertOwner !== who.admin ? alertOwner : null) ?? (await oldestActiveAdmin(tx, who.admin)) ?? who.admin;
    const [created] = await tx
      .insert(approvals)
      .values({ userId: who.admin, objectType: "agent_risk_proof", stageId, approverUserId: approver })
      .returning({ id: approvals.id });
    approvalId = created!.id;
  }

  await tx.insert(agentRiskProofFollowups).values({ resultId, alertId, approvalId });
  return { alertId, approvalId, raised: inserted?.id ?? null };
}

/** a pass clears the proof's open alert episode and its pending acknowledgement (the condition no longer holds) */
async function resolveFollowups(tx: Db, proof: AgentRiskProof, who: Attribution, now: Date): Promise<void> {
  const resolved = await tx
    .update(governanceAlerts)
    .set({ status: "resolved", resolvedAt: now })
    .where(and(eq(governanceAlerts.ruleId, AGENT_RISK_PROOF_ALERT_RULE), eq(governanceAlerts.subjectKey, proof.key), ne(governanceAlerts.status, "resolved")))
    .returning({ id: governanceAlerts.id, title: governanceAlerts.title });
  for (const r of resolved) {
    await tx.insert(auditLog).values({
      userId: who.actor,
      objectType: "governance_alert",
      objectId: r.id,
      detail: { ruleId: AGENT_RISK_PROOF_ALERT_RULE, subjectKey: proof.key },
      effect: "allow",
      ruleId: AGENT_RISK_PROOF_AUDIT_RULES.alertResolved,
      ruleChain: [],
      reason: `governance alert resolved — the proof passed again: ${r.title}`,
    });
  }
  // the acknowledgement asked about a failure that no longer holds: supersede it, as the builder and pool paths do
  await tx
    .update(approvals)
    .set({ status: "superseded", decisionReason: "superseded: the agent risk proof passed again" })
    .where(
      and(
        eq(approvals.objectType, "agent_risk_proof"),
        eq(approvals.stageId, `${AGENT_RISK_PROOF_APPROVAL_STAGE_PREFIX}${proof.key}`),
        eq(approvals.status, "pending"),
      ),
    );
}

/** an error class only: a message may carry tenant data, and the audit row outlives the incident */
const errorClass = (err: unknown) => (err instanceof Error ? err.name : "unknown");

/**
 * Run one proof now and record its evidence and follow-ups. Must run under the `system_task` RLS reason.
 *
 * The result, its chained audit row, and its follow-ups (alert, acknowledgement, link, or their resolution) commit in
 * ONE transaction (#1039 reviews): a recorded `fail` can never be left without its alert. Returns null when another
 * run of the same proof recorded a result after this one started (two replicas racing past the scheduler lease); the
 * transaction-scoped advisory lock serialises them and the later one writes nothing.
 */
export async function runAgentRiskProof(
  db: Db,
  entry: { risk: AgentRisk; proof: AgentRiskProof },
  opts: { trigger: AgentRiskProofTrigger; now?: Date; deps?: AgentRiskProofDeps },
): Promise<RecordedProof | null> {
  const deps = opts.deps ?? DEFAULT_DEPS;
  const { risk, proof } = entry;
  const who: Attribution = { actor: await systemAttributionActor(db), admin: await oldestActiveAdmin(db) };
  const startedAt = opts.now ?? new Date();
  const engine = await runAgentRiskProofEngine(db, proof, startedAt, deps);
  const finishedAt = new Date(Math.max(Date.now(), startedAt.getTime()));
  const contentHash = sha256Hex(
    agentRiskProofEvidence({
      proofKey: proof.key,
      riskKey: risk.key,
      catalogVersion: AGENT_RISK_CATALOG_VERSION,
      trigger: opts.trigger,
      outcome: engine.outcome,
      startedAt,
      finishedAt,
      detail: engine.detail,
    }),
  );
  // ADR-0116: the signature covers the hex hash (the same string the audit row carries)
  const key = deps.signingKey();
  const signature = key.ok ? key.sign(Buffer.from(contentHash, "utf8")).toString("base64") : null;
  const signingKeyId = key.ok ? key.keyId : null;

  const recorded = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`agent-risk-proof:${proof.key}`}))`);
    if (opts.trigger === "scheduled") {
      const [newer] = await tx
        .select({ id: agentRiskProofResults.id })
        .from(agentRiskProofResults)
        .where(and(eq(agentRiskProofResults.proofKey, proof.key), gte(agentRiskProofResults.finishedAt, startedAt)))
        .limit(1);
      if (newer) return null;
    }
    const [audit] = await tx
      .insert(auditLog)
      .values({
        userId: who.actor,
        objectType: "agent_risk_proof",
        objectId: null,
        detail: { proofKey: proof.key, riskKey: risk.key, outcome: engine.outcome, trigger: opts.trigger, contentHash, purpose: AGENT_RISK_PROOF_ORIGIN_TAG },
        effect: engine.outcome === "pass" ? "allow" : "deny",
        ruleId: AGENT_RISK_PROOF_AUDIT_RULES.result,
        ruleChain: [],
        reason: `agent risk proof ${proof.key}: ${engine.outcome}`,
      })
      .returning({ id: auditLog.id });
    const [row] = await tx
      .insert(agentRiskProofResults)
      .values({
        proofKey: proof.key,
        catalogVersion: AGENT_RISK_CATALOG_VERSION,
        trigger: opts.trigger,
        outcome: engine.outcome,
        runAsUserId: who.admin,
        auditLogId: audit!.id,
        contentHash,
        signature,
        signingKeyId,
        detail: engine.detail,
        startedAt,
        finishedAt,
      })
      .returning({ id: agentRiskProofResults.id });
    const resultId = row!.id;
    if (engine.outcome === "pass") {
      await resolveFollowups(tx, proof, who, finishedAt);
      return { resultId, alertId: null, approvalId: null, raised: null };
    }
    const f = await raiseFollowups(tx, risk, proof, resultId, engine.outcome, who, finishedAt);
    return { resultId, ...f };
  });
  if (!recorded) return null;

  // after commit, best effort: owner audit and auto-filed tickets (ADR-0182 S5). A failure is audited, never dropped.
  if (recorded.raised) {
    try {
      await afterAlertsRaised(db, [recorded.raised], who.actor);
    } catch (err) {
      await db.insert(auditLog).values({
        userId: who.actor,
        objectType: "governance_alert",
        objectId: recorded.raised,
        detail: { proofKey: proof.key, phase: "after-raise", error: errorClass(err) },
        effect: "deny",
        ruleId: AGENT_RISK_PROOF_AUDIT_RULES.followupFailed,
        ruleChain: [],
        reason: `agent risk proof ${proof.key}: the alert was raised, but its owner audit or ticket step failed (${errorClass(err)})`,
      });
    }
  }
  return {
    resultId: recorded.resultId,
    outcome: engine.outcome,
    contentHash,
    signed: signature !== null,
    alertId: recorded.alertId,
    approvalId: recorded.approvalId,
  };
}

export interface AgentRiskProofSweepResult {
  ran: number;
  skippedDisabled: number;
  notDue: number;
  /** another replica recorded the same proof first */
  duplicates: number;
  /** a proof whose run or evidence write threw; audited, and the sweep went on to the next proof */
  errors: number;
  outcomes: Record<MeasurementState, number>;
}

/** every enabled proof whose interval has elapsed since its latest result (ADR-0345 decision 3) */
export async function runAgentRiskProofSweep(
  db: Db,
  opts: { now?: Date; deps?: AgentRiskProofDeps } = {},
): Promise<AgentRiskProofSweepResult> {
  const now = opts.now ?? new Date();
  const settings = new Map((await db.select().from(agentRiskProofSettings)).map((s) => [s.proofKey, s]));
  const out: AgentRiskProofSweepResult = {
    ran: 0,
    skippedDisabled: 0,
    notDue: 0,
    duplicates: 0,
    errors: 0,
    outcomes: { pass: 0, fail: 0, insufficient: 0, not_run: 0 },
  };
  for (const entry of agentRiskProofs()) {
    const s = settings.get(entry.proof.key);
    // no row means the secure default: on, at the catalogue's interval
    if (s && !s.enabled) {
      out.skippedDisabled += 1;
      continue;
    }
    const intervalHours = s?.intervalHours ?? entry.proof.defaultIntervalHours;
    const [latest] = await db
      .select({ finishedAt: agentRiskProofResults.finishedAt })
      .from(agentRiskProofResults)
      .where(eq(agentRiskProofResults.proofKey, entry.proof.key))
      .orderBy(desc(agentRiskProofResults.finishedAt))
      .limit(1);
    if (latest && now.getTime() - latest.finishedAt.getTime() < intervalHours * HOUR_MS) {
      out.notDue += 1;
      continue;
    }
    // one proof failing to record must not stop the others (#1039 security review): audit it and go on
    try {
      const rec = await runAgentRiskProof(db, entry, { trigger: "scheduled", now, ...(opts.deps ? { deps: opts.deps } : {}) });
      if (!rec) {
        out.duplicates += 1;
        continue;
      }
      out.ran += 1;
      out.outcomes[rec.outcome] += 1;
    } catch (err) {
      out.errors += 1;
      await db
        .insert(auditLog)
        .values({
          userId: await systemAttributionActor(db),
          objectType: "agent_risk_proof",
          objectId: null,
          detail: { proofKey: entry.proof.key, error: errorClass(err), purpose: AGENT_RISK_PROOF_ORIGIN_TAG },
          effect: "deny",
          ruleId: AGENT_RISK_PROOF_AUDIT_RULES.runFailed,
          ruleChain: [],
          reason: `agent risk proof ${entry.proof.key}: the run could not be recorded (${errorClass(err)}); it is retried on the next pass`,
        })
        .catch(() => undefined);
    }
  }
  return out;
}

export function agentRiskProofJobDefinitions(): SchedulerJobDefinition[] {
  return [
    {
      name: AGENT_RISK_PROOF_JOB_NAME,
      description:
        "Run each enabled ADR-0345 agent-risk proof whose interval has elapsed (daily by default, an admin may " +
        "lengthen it to at most a week) through its existing engine: the ADR-0180 assurance metrics, the ADR-0060 " +
        "chain verification and the ADR-0081 register hygiene check. Gateway probes are recorded as not run until " +
        "their harness exists. Each result is append-only, hash-chained evidence, signed when the export key is set. " +
        "Anything but a pass raises a governance alert and an acknowledgement item; a pass resolves the alert.",
      adr: "ADR-0345",
      defaultIntervalSeconds: 3600,
      run: async (ctx) => {
        const out = await runAgentRiskProofSweep(ctx.db, { now: ctx.now });
        return { itemsProcessed: out.ran, detail: { ...out } };
      },
    },
  ];
}
