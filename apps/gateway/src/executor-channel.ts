/**
 * ADR-0190 decisions 4, 6 and 13 (slice I3) — THE EXECUTOR CHANNEL and THE
 * PLACEMENT BROKER.
 *
 * THE CHANNEL (`/v1/executor-channel/*`, authenticated in-route by
 * `executor-channel-auth.ts`; raw bodies kept as strings for the proof's body
 * hash):
 *   POST /announce              what this executor is; must agree with the admin's registration
 *   POST /self-test             signed canary reports, one per live profile → verdict rows
 *   GET  /stream?window=        NDJSON for one window: hello, offers, status changes, keepalives, bye
 *   POST /offers/:id/accept     take an offer (fresh attestation re-checked on the database clock)
 *   POST /offers/:id/decline    with a reason; the placement is refused
 *   POST /offers/:id/report     the signed per-placement report: `release: true`, or a MISMATCH
 *   POST /offers/:id/end        how the sandbox ended
 *
 * THE BROKER (`offerPlacement`, `awaitPlacement`): called by the governed
 * paths (I2/I4) once a required class is known. It picks one ACTIVE executor
 * whose latest `pass` attestation for the profile is fresh and at or above
 * the required class — or REFUSES before any sandbox starts, with decision 7's
 * fixed reason. There is no fallback to a lower class: a placement row is
 * written for every outcome, under an audit row (`execution-placed`,
 * `execution-refused`, `execution-profile-mismatch`), on the database clock.
 *
 * A MISMATCH (decision 6): the per-placement report fails evaluation → the
 * placement is `mismatch`, the executor is QUARANTINED (`status`,
 * `quarantine_code`, every other open offer withdrawn), an audit row and a
 * governance alert are raised, and the executor is told `next: quarantined`
 * (it kills the sandbox: input was never released).
 */
import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { decodeProtectedHeader, flattenedVerify, importJWK, type JWK } from "jose";
import { z } from "zod";
import {
  and,
  auditLog,
  desc,
  eq,
  executionOffers,
  executionPlacementReports,
  executionPlacements,
  executionProfiles,
  executorAttestations,
  executors,
  governanceAlerts,
  inArray,
  sql,
  type Db,
  type ExecutionOfferRow,
  type ExecutionProfileRow,
  type ExecutorRow,
} from "@regulait/db";
import {
  attestationMaxAgeMinutes,
  canonicalExecutorReport,
  evaluateExecutorReport,
  EXECUTION_OFFER_REPORT_TTL_SECONDS,
  EXECUTION_OFFER_TTL_SECONDS,
  EXECUTOR_CHANNEL_PREFIX,
  EXECUTOR_PROOF_ALGS,
  EXECUTOR_STREAM_WINDOW,
  executionProfileBodySchema,
  canonicalJson,
  executorAnnounceSchema,
  executorDeclineSchema,
  executorEndSchema,
  executorPlacementReportSchema,
  executorReportDigest,
  executorSelfTestSchema,
  isolationClassRank,
  unresolvedPlacementFact,
  type AppliedIsolationKind,
  type ExecutionOffer,
  type ExecutionProfileBody,
  type ExecutionRefusalReason,
  type ExecutorNext,
  type ExecutorProfileRef,
  type ExecutorQuarantineCode,
  type ExecutorStreamMessage,
  type ExecutorView,
  type IsolableWorkloadKind,
  type ReportFailure,
  type RequirableIsolationClass,
  type RequiredClassSource,
  type SignedExecutorReport,
} from "@regulait/shared";
import { completeExecutorRequest, NO_IDENTITY, sendExecutorRefusal, verifyExecutorProofHeader, type ExecutorAuth, type ExecutorProofHeaderResult } from "./executor-channel-auth.js";
import { databaseNow } from "./delegation.js";
import { attestationCounts, freshAttestation, type FreshAttestationRow } from "./executor-attestation.js";
import { endStdioSession, registerExecutorStdioRoutes } from "./executor-stdio.js";
import { loadOrgSettings } from "./org-settings.js";

export interface ExecutorChannelOptions {
  /** how often the stream looks for offers and status changes (default 500 ms; tests shorten it) */
  streamPollMs?: number;
  /** keepalive interval on the stream (default 10 s) */
  keepaliveMs?: number;
}

/** the bound on a self-test or report body (64 reports of at most 64 KiB each fit well inside) */
export const EXECUTOR_REPORT_BODY_LIMIT_BYTES = 4 * 1024 * 1024;

const uuidParam = z.object({ offerId: z.string().uuid() });

// ---------------------------------------------------------------------------
// Audit, views, profiles
// ---------------------------------------------------------------------------

type AuditValues = typeof auditLog.$inferInsert;
/** one audit row, its id chosen here so placement rows can name it without a RETURNING through the chain wrapper */
export async function auditExecutor(db: Db, row: Omit<AuditValues, "id" | "ruleChain" | "effect"> & { effect?: AuditValues["effect"] }): Promise<string> {
  const id = randomUUID();
  await db.insert(auditLog).values({ id, effect: "allow", ruleChain: [], ...row } as AuditValues);
  return id;
}

export function executorView(row: ExecutorRow): ExecutorView {
  return {
    executorId: row.id,
    name: row.name,
    backend: row.backend,
    classesDeclared: row.classesDeclared,
    status: row.status,
    quarantineCode: row.quarantineCode,
  };
}

/** the live (not retired) profiles with their bodies, as the executor receives them */
export async function liveProfileRefs(db: Db): Promise<ExecutorProfileRef[]> {
  const rows = await db.select().from(executionProfiles).where(sql`${executionProfiles.retiredAt} IS NULL`);
  return rows.map((r) => ({ digest: r.digest, name: r.name, version: r.version, minClass: r.minClass, body: executionProfileBodySchema.parse(JSON.parse(r.body)) }));
}

async function profileByDigest(db: Db, digest: string): Promise<(ExecutionProfileRow & { parsed: ExecutionProfileBody }) | null> {
  const [row] = await db.select().from(executionProfiles).where(eq(executionProfiles.digest, digest));
  return row ? { ...row, parsed: executionProfileBodySchema.parse(JSON.parse(row.body)) } : null;
}

const nextFor = (e: ExecutorRow | null): ExecutorNext => (e?.status === "revoked" ? "revoked" : e?.status === "quarantined" ? "quarantined" : "ok");

// ---------------------------------------------------------------------------
// Report signatures (decision 6: "the executor signs the report with its workload key")
// ---------------------------------------------------------------------------

/** does this detached signature verify, under a LIVE jwk credential of the executor's identity? */
export async function verifyReportSignature(auth: ExecutorAuth, signed: SignedExecutorReport): Promise<boolean> {
  let kid: string | undefined;
  let alg: string | undefined;
  try {
    const h = decodeProtectedHeader({ protected: signed.signature.protected, signature: signed.signature.signature, payload: "" } as never);
    kid = typeof h.kid === "string" ? h.kid : undefined;
    alg = h.alg;
    if (h.b64 !== false || !Array.isArray(h.crit) || !h.crit.includes("b64")) return false;
  } catch {
    return false;
  }
  if (!kid || !alg || !(EXECUTOR_PROOF_ALGS as readonly string[]).includes(alg)) return false;
  const cred = auth.client.credentials.find((c) => c.kind === "jwk" && c.jwkThumbprint === kid);
  const j = cred?.publicJwk as unknown as Record<string, string> | undefined;
  if (!cred || !j) return false;
  const jwk: JWK = j.kty === "OKP" ? { kty: "OKP", crv: "Ed25519", x: j.x! } : { kty: "EC", crv: "P-256", x: j.x!, y: j.y! };
  try {
    await flattenedVerify({ protected: signed.signature.protected, signature: signed.signature.signature, payload: canonicalExecutorReport(signed.report) }, await importJWK(jwk, alg), { algorithms: [alg] });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Attestations (decision 6)
// ---------------------------------------------------------------------------

// amendment T's one predicate lives in `executor-attestation.ts` (the live delegation chain applies it too)
export { attestationCounts, freshAttestation, type FreshAttestationRow } from "./executor-attestation.js";

// ---------------------------------------------------------------------------
// Quarantine (decision 6)
// ---------------------------------------------------------------------------

/**
 * Quarantine an executor: status and code (one atomic transition: of two
 * concurrent callers, the one whose UPDATE moved the row does the rest), every
 * open offer withdrawn, an audit row, a governance alert.
 */
export async function quarantineExecutor(db: Db, executorId: string, code: ExecutorQuarantineCode, opts: { actorUserId?: string; detail?: Record<string, unknown> } = {}): Promise<boolean> {
  const [row] = await db
    .update(executors)
    .set({ status: "quarantined", quarantineCode: code, quarantinedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(executors.id, executorId), eq(executors.status, "active")))
    .returning();
  if (!row) return false;
  await withdrawOpenOffers(db, executorId);
  await auditExecutor(db, {
    userId: opts.actorUserId ?? NO_IDENTITY,
    objectType: "executor",
    objectId: executorId,
    ruleId: "executor-quarantined",
    effect: "deny",
    detail: { code, executorName: row.name, backend: row.backend, ...(opts.detail ?? {}) },
    reason: `executor ${row.name} quarantined (${code}): its classes are withdrawn until an admin re-enables it (ADR-0190 decision 6)`,
  });
  await db
    .insert(governanceAlerts)
    .values({
      ruleId: "execution-profile-mismatch",
      subjectKey: `executor:${executorId}`,
      severity: "high",
      title: `Executor ${row.name} quarantined: ${code}`,
      detail: { executorId, code, backend: row.backend, ...(opts.detail ?? {}) },
    })
    .onConflictDoNothing();
  return true;
}

/**
 * Every offered or accepted offer of this executor is withdrawn (its placement
 * refused `executor_quarantined`). Each offer is locked first: one whose report
 * is being judged at this moment is left to that outcome.
 */
async function withdrawOpenOffers(db: Db, executorId: string): Promise<void> {
  const open = await db
    .select({ id: executionOffers.id })
    .from(executionOffers)
    .where(and(eq(executionOffers.executorId, executorId), inArray(executionOffers.status, ["offered", "accepted"])));
  for (const { id } of open) {
    await db.transaction(async (tx) => {
      const [o] = await tx.select().from(executionOffers).where(eq(executionOffers.id, id)).for("update");
      if (!o || (o.status !== "offered" && o.status !== "accepted")) return;
      const placementId = await refusedPlacement(tx as unknown as Db, o, "executor_quarantined");
      await tx.update(executionOffers).set({ status: "withdrawn", endedAt: sql`now()`, placementId }).where(eq(executionOffers.id, o.id));
    });
  }
}

// ---------------------------------------------------------------------------
// Placement rows
// ---------------------------------------------------------------------------

/**
 * Every offer and placement is written `enforce`, the only mode (ADR-0190 OWNER DECISION A). Migration 0191
 * rewrote stored offers; an older placement keeps the mode it was recorded under, and nothing here copies the
 * mode from a stored row.
 */
const ENFORCEMENT = "enforce" as const;

/**
 * What a governed caller adds to the audit row of a placement it asked for (slice I2): the person the call runs
 * for, and the requirement's evidence (every floor and which one won, decision 7; ids and fixed vocabularies only).
 */
export interface PlacementAuditContext {
  userId?: string;
  detail?: Record<string, unknown>;
}

/**
 * I4 (migration 0198): the decision-time placement row an offer belongs to, if
 * a governed stdio decision made that offer (`outcome = 'offered'`). Its
 * outcome is then a LINKED report row, never a second placement row: the
 * decision-time row is the one the decision's facts name.
 */
async function linkedPlacementOf(db: Db, offerId: string): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: executionPlacements.id })
    .from(executionPlacements)
    .where(and(eq(executionPlacements.offerId, offerId), eq(executionPlacements.outcome, "offered")));
  return row ?? null;
}

async function refusedPlacement(
  db: Db,
  o: Pick<ExecutionOfferRow, "id" | "workloadKind" | "requiredClass" | "requiredBy" | "profileDigest"> & { executorId: string | null; imageDigest?: string },
  code: ExecutionRefusalReason,
  context: PlacementAuditContext = {},
): Promise<string> {
  const linked = await linkedPlacementOf(db, o.id);
  const auditId = await auditExecutor(db, {
    userId: context.userId ?? NO_IDENTITY,
    objectType: "execution_placement",
    objectId: o.id,
    ruleId: "execution-refused",
    effect: "deny",
    detail: { offerId: o.id, workloadKind: o.workloadKind, requiredClass: o.requiredClass, requiredBy: o.requiredBy, profileDigest: o.profileDigest, executorId: o.executorId, code, ...(context.detail ?? {}) },
    reason: `placement refused (${code}): no executor with a fresh attestation at ${o.requiredClass} took it (ADR-0190 decision 7; no fallback)`,
  });
  if (linked) {
    await db.insert(executionPlacementReports).values({ placementId: linked.id, offerId: o.id, auditId, outcome: "refused", refusalCode: code });
    return linked.id;
  }
  const image = typeof o.imageDigest === "string" && /^sha256:[0-9a-f]{64}$/.test(o.imageDigest) ? o.imageDigest : null;
  const [row] = await db
    .insert(executionPlacements)
    .values({ auditId, workloadKind: o.workloadKind, requiredClass: o.requiredClass, requiredBy: o.requiredBy, enforcement: ENFORCEMENT, profileDigest: o.profileDigest, outcome: "refused", refusalCode: code, imageDigest: image })
    .returning({ id: executionPlacements.id });
  return row!.id;
}

/** I4: the SHA-256 of the runtime flags an attestation's stored report observed (canonical JSON of the sorted list); null if none */
export function runtimeFlagsDigest(report: Record<string, unknown>): string | null {
  const flags = (report as { probes?: { runtime_config?: { observed?: { flags?: unknown } | null } } }).probes?.runtime_config?.observed?.flags;
  if (!Array.isArray(flags) || !flags.every((f) => typeof f === "string")) return null;
  return createHash("sha256").update(canonicalJson([...(flags as string[])].sort())).digest("hex");
}

/** an offer as the stream carries it */
function offerView(o: ExecutionOfferRow): ExecutionOffer {
  return {
    id: o.id,
    workloadKind: o.workloadKind,
    requiredClass: o.requiredClass,
    requiredBy: o.requiredBy,
    enforcement: ENFORCEMENT,
    profileDigest: o.profileDigest,
    imageDigest: o.imageDigest,
    expiresAt: o.expiresAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// The broker
// ---------------------------------------------------------------------------

export interface OfferPlacementInput {
  workloadKind: IsolableWorkloadKind;
  requiredClass: RequirableIsolationClass;
  requiredBy: RequiredClassSource;
  profileDigest: string;
  imageDigest: string;
  /** how long the offer waits to be accepted (default EXECUTION_OFFER_TTL_SECONDS) */
  ttlSeconds?: number;
  /** consider only these executors (a placement affinity, and the seam a test uses to pick its own executor) */
  onlyExecutorIds?: readonly string[];
  /** slice I2: the caller's audit context, written on every refusal row of this placement */
  audit?: PlacementAuditContext;
}

export type OfferPlacementOutcome =
  | { kind: "offered"; offerId: string; executorId: string; attestedClass: AppliedIsolationKind }
  /** `placementId` is null only for a profile digest that no row names (nothing to reference; the refusal is audited) */
  | { kind: "refused"; code: ExecutionRefusalReason; placementId: string | null };

/**
 * Decision 7's last step, for one call: pick an executor whose fresh
 * attestation meets the requirement, or refuse with the most specific reason
 * before any sandbox starts. Nothing here lowers the class.
 */
/** what the broker's selection found, before anything is written */
type Selection =
  | { kind: "unresolved"; fact: string }
  | { kind: "unknown_profile" }
  | { kind: "refused"; code: ExecutionRefusalReason; input: OfferPlacementInput }
  | { kind: "chosen"; executor: ExecutorRow; cls: AppliedIsolationKind; attestation: FreshAttestationRow; input: OfferPlacementInput };

/**
 * Decision 7's last step, read-only: an active executor whose fresh attestation meets the requirement (the
 * profile's own floor raises it), or the most specific refusal. Shared by the I3 broker (`offerPlacement`) and the
 * I4 governed stdio decision (`offerLinkedPlacement`), so both refuse and choose by the same rule.
 */
async function selectExecutor(db: Db, input: OfferPlacementInput): Promise<Selection> {
  // Amendment item 15 with OWNER DECISION B: a policy fact that is missing or outside its vocabulary refuses
  // `policy_unresolved` before anything else is looked at, and before any executor is offered work.
  const unresolved = unresolvedPlacementFact({
    workloadKind: input.workloadKind,
    requiredClass: input.requiredClass,
    requiredBy: input.requiredBy,
    profileDigest: input.profileDigest,
    imageDigest: input.imageDigest,
  });
  if (unresolved) return { kind: "unresolved", fact: unresolved };
  const now = await databaseNow(db);
  const profile = await profileByDigest(db, input.profileDigest);
  if (!profile) return { kind: "unknown_profile" };
  if (profile.retiredAt) return { kind: "refused", code: "profile_retired", input };
  // the profile's own floor is a policy fact too: one that does not resolve is never dropped from the MAX
  if (unresolvedPlacementFact({ workloadKind: input.workloadKind, requiredClass: input.requiredClass, requiredBy: input.requiredBy, profileMinClass: profile.minClass })) {
    return { kind: "refused", code: "policy_unresolved", input };
  }
  if (isolationClassRank(profile.minClass) > isolationClassRank(input.requiredClass)) {
    // the profile's own floor is part of the requirement (decision 7 item 5)
    input = { ...input, requiredClass: profile.minClass, requiredBy: "configured_profile" };
  }
  const only = input.onlyExecutorIds;
  const rows = (await db.select().from(executors).where(inArray(executors.status, ["active", "quarantined"]))).filter((r) => !only || only.includes(r.id));
  const active = rows.filter((r) => r.status === "active");
  if (active.length === 0) return { kind: "refused", code: rows.length > 0 ? "executor_quarantined" : "no_executor", input };

  let sawAttestation = false;
  let sawFresh = false;
  const candidates: Array<{ row: ExecutorRow; fresh: FreshAttestationRow; open: number }> = [];
  for (const row of active) {
    const [any] = await db
      .select({ id: executorAttestations.id })
      .from(executorAttestations)
      .where(and(attestationCounts(row.id), eq(executorAttestations.profileDigest, input.profileDigest)))
      .limit(1);
    if (any) sawAttestation = true;
    const fresh = await freshAttestation(db, row.id, input.profileDigest, now);
    if (!fresh) continue;
    sawFresh = true;
    // OWNER DECISION 6: a customer plane satisfies a class only through the admin's mapping
    const effective = fresh.class === "customer_declared" ? row.declaredClass : fresh.class;
    if (!effective || isolationClassRank(effective) < isolationClassRank(input.requiredClass)) continue;
    const [open] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(executionOffers)
      .where(and(eq(executionOffers.executorId, row.id), inArray(executionOffers.status, ["offered", "accepted", "placed"])));
    candidates.push({ row, fresh, open: open?.n ?? 0 });
  }
  if (candidates.length === 0) return { kind: "refused", code: sawFresh ? "class_below_required" : sawAttestation ? "attestation_stale" : "no_executor", input };
  candidates.sort((a, b) => a.open - b.open);
  const chosen = candidates[0]!;
  return { kind: "chosen", executor: chosen.row, cls: chosen.fresh.class, attestation: chosen.fresh, input };
}

async function insertOffer(db: Db, executorId: string, input: OfferPlacementInput): Promise<string> {
  const ttl = Math.max(1, Math.min(600, input.ttlSeconds ?? EXECUTION_OFFER_TTL_SECONDS));
  const [offer] = await db
    .insert(executionOffers)
    .values({
      executorId,
      workloadKind: input.workloadKind,
      requiredClass: input.requiredClass,
      requiredBy: input.requiredBy,
      enforcement: ENFORCEMENT,
      profileDigest: input.profileDigest,
      imageDigest: input.imageDigest,
      expiresAt: sql`now() + make_interval(secs => ${ttl})`,
    })
    .returning({ id: executionOffers.id });
  return offer!.id;
}

export async function offerPlacement(db: Db, input: OfferPlacementInput): Promise<OfferPlacementOutcome> {
  const sel = await selectExecutor(db, input);
  if (sel.kind === "unresolved") {
    // no placement row (the row's own columns would have to hold the unresolved fact); the audit row records it
    await auditExecutor(db, {
      userId: input.audit?.userId ?? NO_IDENTITY,
      objectType: "execution_placement",
      objectId: null,
      ruleId: "execution-refused",
      effect: "deny",
      // only well-formed values are echoed: a malformed one is caller input of unbounded shape
      detail: {
        unresolvedFact: sel.fact,
        profileDigest: typeof input.profileDigest === "string" && /^[0-9a-f]{64}$/.test(input.profileDigest) ? input.profileDigest : null,
        code: "policy_unresolved",
        ...(input.audit?.detail ?? {}),
      },
      reason: `placement refused (policy_unresolved): the policy fact ${sel.fact} did not resolve (ADR-0190 decision 7, amendment item 15; never defaulted)`,
    });
    return { kind: "refused", code: "policy_unresolved", placementId: null };
  }
  if (sel.kind === "unknown_profile") {
    await auditExecutor(db, {
      userId: input.audit?.userId ?? NO_IDENTITY,
      objectType: "execution_placement",
      objectId: null,
      ruleId: "execution-refused",
      effect: "deny",
      detail: { workloadKind: input.workloadKind, requiredClass: input.requiredClass, requiredBy: input.requiredBy, profileDigest: input.profileDigest, code: "profile_retired", ...(input.audit?.detail ?? {}) },
      reason: "placement refused (profile_retired): no execution profile has that digest (ADR-0190 decision 7)",
    });
    return { kind: "refused", code: "profile_retired", placementId: null };
  }
  if (sel.kind === "refused") {
    return { kind: "refused", code: sel.code, placementId: await refusedPlacement(db, { id: randomUUID(), ...sel.input, executorId: null }, sel.code, input.audit) };
  }
  const offerId = await insertOffer(db, sel.executor.id, sel.input);
  return { kind: "offered", offerId, executorId: sel.executor.id, attestedClass: sel.cls };
}

/**
 * ADR-0190 I4 (with the I8 contract): decision 7 for a GOVERNED stdio call, inside the transaction that writes that
 * decision's audit row and BEFORE it, so the decision's facts read the placement. The placement row is keyed to the
 * decision's audit id (`auditId`, chosen by the caller) and is:
 *  - `offered`: the chosen executor, the class its fresh attestation shows, that attestation (`attestationId`), the
 *    image and the runtime flags hash; an offer is made to that executor in the same transaction. Its outcome is the
 *    linked report row written when the executor reports (or the offer expires, is declined or withdrawn);
 *  - `refused`: decision 7's fixed code (the decision itself becomes that refusal);
 *  - none, for a policy fact that does not resolve (`policy_unresolved`: the row's columns would have to hold it).
 * Nothing here audits: the decision row is the audit.
 */
export type LinkedPlacementOutcome =
  | { kind: "offered"; placementId: string; offerId: string; executorId: string; attestedClass: AppliedIsolationKind }
  | { kind: "refused"; code: ExecutionRefusalReason; placementId: string | null };

export async function offerLinkedPlacement(tx: Db, auditId: string, input: OfferPlacementInput): Promise<LinkedPlacementOutcome> {
  const sel = await selectExecutor(tx, input);
  if (sel.kind === "unresolved") return { kind: "refused", code: "policy_unresolved", placementId: null };
  if (sel.kind === "unknown_profile") return { kind: "refused", code: "profile_retired", placementId: null };
  const base = {
    auditId,
    workloadKind: sel.input.workloadKind,
    requiredClass: sel.input.requiredClass,
    requiredBy: sel.input.requiredBy,
    enforcement: ENFORCEMENT,
    profileDigest: sel.input.profileDigest,
    imageDigest: sel.input.imageDigest,
  };
  if (sel.kind === "refused") {
    const [row] = await tx.insert(executionPlacements).values({ ...base, outcome: "refused", refusalCode: sel.code }).returning({ id: executionPlacements.id });
    return { kind: "refused", code: sel.code, placementId: row!.id };
  }
  const offerId = await insertOffer(tx, sel.executor.id, sel.input);
  const [row] = await tx
    .insert(executionPlacements)
    .values({
      ...base,
      outcome: "offered",
      executorId: sel.executor.id,
      appliedClass: sel.cls,
      attestationId: sel.attestation.id,
      runtimeFlagsSha256: runtimeFlagsDigest(sel.attestation.report),
      offerId,
    })
    .returning({ id: executionPlacements.id });
  return { kind: "offered", placementId: row!.id, offerId, executorId: sel.executor.id, attestedClass: sel.cls };
}

export type PlacementResult =
  | { kind: "placed"; placementId: string; reportSha256: string; appliedClass: AppliedIsolationKind; executorId: string }
  | { kind: "failed"; status: ExecutionOfferRow["status"]; code: ExecutionRefusalReason | "execution_profile_mismatch"; placementId: string | null };

/** wait for an offer to be placed (the report accepted) or to fail; expiries are applied while waiting */
export async function awaitPlacement(db: Db, offerId: string, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<PlacementResult> {
  const deadline = Date.now() + (opts.timeoutMs ?? (EXECUTION_OFFER_TTL_SECONDS + EXECUTION_OFFER_REPORT_TTL_SECONDS) * 1000);
  const poll = opts.pollMs ?? 250;
  for (;;) {
    await expireOffers(db);
    const [o] = await db.select().from(executionOffers).where(eq(executionOffers.id, offerId));
    if (!o) return { kind: "failed", status: "expired", code: "no_executor", placementId: null };
    if (o.status === "placed" || o.status === "ended") {
      const [p] = await db.select().from(executionPlacements).where(eq(executionPlacements.id, o.placementId!));
      // I4: a decision-time (`offered`) placement's outcome is its linked report row
      const [r] = p?.outcome === "offered" ? await db.select().from(executionPlacementReports).where(eq(executionPlacementReports.placementId, p.id)) : [];
      return { kind: "placed", placementId: o.placementId!, reportSha256: (r?.reportSha256 ?? p!.reportSha256)!, appliedClass: (r?.appliedClass ?? p!.appliedClass)!, executorId: o.executorId };
    }
    if (o.status === "mismatch") return { kind: "failed", status: o.status, code: "execution_profile_mismatch", placementId: o.placementId };
    if (o.status === "declined" || o.status === "expired" || o.status === "withdrawn") {
      const [p] = o.placementId ? await db.select().from(executionPlacements).where(eq(executionPlacements.id, o.placementId)) : [];
      const [r] = p?.outcome === "offered" ? await db.select().from(executionPlacementReports).where(eq(executionPlacementReports.placementId, p.id)) : [];
      return { kind: "failed", status: o.status, code: ((r?.refusalCode ?? p?.refusalCode) as ExecutionRefusalReason | null) ?? "no_executor", placementId: o.placementId };
    }
    if (Date.now() >= deadline) return { kind: "failed", status: o.status, code: "no_executor", placementId: null };
    await new Promise((r) => setTimeout(r, poll));
  }
}

/** the SQL condition for an offer whose deadline has passed on the database clock (one predicate: sweep and report) */
const offerOverdue = sql`((${executionOffers.status} = 'offered' AND ${executionOffers.expiresAt} <= now())
  OR (${executionOffers.status} = 'accepted' AND ${executionOffers.acceptedAt} + make_interval(secs => ${EXECUTION_OFFER_REPORT_TTL_SECONDS}) <= now()))`;

/** expire one offer the caller holds locked and has re-checked as overdue: its refused placement, then the status */
async function expireLockedOffer(tx: Db, o: ExecutionOfferRow): Promise<void> {
  const placementId = await refusedPlacement(tx, o, "no_executor");
  await tx.update(executionOffers).set({ status: "expired", endedAt: sql`now()`, placementId }).where(eq(executionOffers.id, o.id));
}

/**
 * Offers not accepted in time, and accepted offers not reported in time,
 * expire (each a refused placement). Each expiry is one transaction: the row
 * is locked (`SKIP LOCKED`: a row another sweep, a report or a withdrawal
 * holds is theirs), re-checked as still overdue on the database clock, and
 * only then given its placement, audit row and status. Concurrent sweeps
 * write exactly one of each.
 */
export async function expireOffers(db: Db): Promise<number> {
  const due = await db.select({ id: executionOffers.id }).from(executionOffers).where(offerOverdue);
  let n = 0;
  for (const { id } of due) {
    const done = await db.transaction(async (tx) => {
      const [o] = await tx.select().from(executionOffers).where(and(eq(executionOffers.id, id), offerOverdue)).for("update", { skipLocked: true });
      if (!o) return false;
      await expireLockedOffer(tx as unknown as Db, o);
      return true;
    });
    if (done) n += 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

const declineToRefusal: Record<z.infer<typeof executorDeclineSchema>["reason"], ExecutionRefusalReason> = {
  attestation_stale: "attestation_stale",
  class_below_required: "class_below_required",
  capacity: "no_executor",
  quarantined: "executor_quarantined",
  profile_unknown: "profile_retired",
};

export function registerExecutorChannelRoutes(app: FastifyInstance, db: Db, opts: ExecutorChannelOptions = {}): void {
  const pollMs = Math.max(20, opts.streamPollMs ?? 500);
  const keepaliveMs = Math.max(pollMs, opts.keepaliveMs ?? 10_000);

  app.register(async (scope) => {
    // the proof binds the EXACT bytes of the body: this scope keeps them as a string (as the chatops and PM webhooks do)
    const keepRaw = (_req: unknown, raw: string, done: (err: Error | null, result?: unknown) => void) => done(null, raw);
    scope.addContentTypeParser("application/json", { parseAs: "string" }, keepRaw);
    scope.addContentTypeParser("*", { parseAs: "string" }, keepRaw);

    const rawOf = (req: FastifyRequest): string | undefined => (typeof req.body === "string" ? req.body : undefined);
    const jsonOf = (req: FastifyRequest): unknown => {
      const raw = rawOf(req);
      if (raw === undefined || raw === "") return undefined;
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return Symbol.for("unparseable");
      }
    };
    const refused = (reply: FastifyReply, status: number, code: string, executor: ExecutorRow | null, extra: Record<string, unknown> = {}) =>
      reply.status(status).send({ error: code, next: nextFor(executor), ...extra });

    // review L6: the proof's header phase runs BEFORE the body is read; an unproven caller is refused (and audited)
    // without the gateway buffering its body. Only the body hash, the jti claim and the executor wait for the body.
    const proven = new WeakMap<FastifyRequest, ExecutorProofHeaderResult>();
    scope.addHook("onRequest", async (req, reply) => {
      const head = await verifyExecutorProofHeader(db, req);
      if (!head.ok) {
        await sendExecutorRefusal(db, reply, head, `${req.method} ${req.routeOptions.url ?? ""}`);
        return reply;
      }
      proven.set(req, head.pre);
    });

    /** authenticate, or answer the refusal; `registered` = the identity must already be an executor */
    async function authed(req: FastifyRequest, reply: FastifyReply, registered: boolean): Promise<ExecutorAuth | null> {
      const route = `${req.method} ${req.routeOptions.url ?? ""}`;
      const pre = proven.get(req);
      const out = pre ? await completeExecutorRequest(db, pre, rawOf(req)) : ({ ok: false, status: 401, code: "proof_missing" } as const);
      if (!out.ok) {
        await sendExecutorRefusal(db, reply, out, route);
        return null;
      }
      if (registered && !out.auth.executor) {
        await sendExecutorRefusal(db, reply, { ok: false, status: 401, code: "executor_not_registered" }, route);
        return null;
      }
      return out.auth;
    }

    // ---- announce -------------------------------------------------------
    scope.post(`${EXECUTOR_CHANNEL_PREFIX}/announce`, { bodyLimit: 16 * 1024 }, async (req, reply) => {
      const auth = await authed(req, reply, false);
      if (!auth) return reply;
      const body = executorAnnounceSchema.safeParse(jsonOf(req));
      if (!body.success) return refused(reply, 400, "invalid_body", auth.executor);
      if (!auth.executor) return sendExecutorRefusal(db, reply, { ok: false, status: 401, code: "executor_not_registered" }, `POST ${EXECUTOR_CHANNEL_PREFIX}/announce`);
      const row = auth.executor;
      if (body.data.backend !== row.backend) return refused(reply, 409, "executor_backend_mismatch", row);
      if (!body.data.classesDeclared.every((c) => row.classesDeclared.includes(c))) return refused(reply, 409, "executor_classes_not_declared", row);
      await db.update(executors).set({ runtimeVersion: body.data.runtimeVersion, updatedAt: sql`now()` }).where(eq(executors.id, row.id));
      await auditExecutor(db, {
        userId: NO_IDENTITY,
        objectType: "executor",
        objectId: row.id,
        ruleId: "executor-announced",
        detail: { executorName: row.name, backend: row.backend, runtimeVersion: body.data.runtimeVersion, classesDeclared: body.data.classesDeclared, credentialId: auth.credential.id },
        reason: `executor ${row.name} announced itself over its channel (ADR-0190 decision 4)`,
      });
      const org = await loadOrgSettings(db);
      const fresh = { ...row, runtimeVersion: body.data.runtimeVersion };
      return reply.status(200).send({ executor: executorView(fresh), profiles: await liveProfileRefs(db), attestationMaxAgeMinutes: org.executorAttestationMaxAgeMinutes, next: nextFor(fresh) });
    });

    // ---- self-test --------------------------------------------------------
    scope.post(`${EXECUTOR_CHANNEL_PREFIX}/self-test`, { bodyLimit: EXECUTOR_REPORT_BODY_LIMIT_BYTES }, async (req, reply) => {
      const auth = await authed(req, reply, true);
      if (!auth) return reply;
      const row = auth.executor!;
      // amendment T: a quarantined executor's self-test is refused; its classes return only through a re-enable and a new pass
      if (row.status !== "active") {
        await auditSelfTestRefusal(row, row);
        return refused(reply, 409, "executor_quarantined", row);
      }
      const body = executorSelfTestSchema.safeParse(jsonOf(req));
      if (!body.success) return refused(reply, 400, "invalid_body", row);
      const seen = new Set<string>();
      for (const s of body.data.reports) {
        if (s.report.kind !== "self_test") return refused(reply, 400, "report_kind", row);
        if (s.report.executor.identifier !== auth.client.identity.identifier) return refused(reply, 400, "report_identifier", row);
        if (seen.has(s.report.profileDigest)) return refused(reply, 400, "report_duplicate_profile", row);
        seen.add(s.report.profileDigest);
        if (!(await verifyReportSignature(auth, s))) return refused(reply, 401, "report_signature_invalid", row);
      }
      const org = await loadOrgSettings(db);
      // the verdicts are written under a share lock on the executor row, re-checked active: a quarantine or a
      // re-enable cannot cross a self-test while it is judged (amendment T)
      const out = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const [current] = await tx.select().from(executors).where(eq(executors.id, row.id)).for("share");
        if (!current || current.status !== "active") return { ok: false as const, current: current ?? null };
        const results = [];
        for (const s of body.data.reports) {
          const profile = await profileByDigest(txDb, s.report.profileDigest);
          const failures: ReportFailure[] = [];
          let verdict: "pass" | "fail" = "fail";
          if (!profile || profile.retiredAt) failures.push({ probe: "report", code: "profile_digest_mismatch" });
          else {
            const v = evaluateExecutorReport(s.report, { profile: profile.parsed, profileDigest: profile.digest, backend: row.backend, classesDeclared: row.classesDeclared });
            verdict = v.verdict;
            failures.push(...v.failures);
          }
          if (!profile) {
            results.push({ profileDigest: s.report.profileDigest, class: s.report.class, verdict, failures, expiresAt: null });
            continue;
          }
          const maxAge = attestationMaxAgeMinutes(profile.parsed, org.executorAttestationMaxAgeMinutes);
          const reportSha256 = executorReportDigest(s.report);
          const [inserted] = await txDb
            .insert(executorAttestations)
            .values({
              executorId: row.id,
              profileDigest: profile.digest,
              class: s.report.class,
              reportSha256,
              report: { ...s.report, signature: s.signature } as Record<string, unknown>,
              verdict,
              observedAt: sql`now()`,
              expiresAt: sql`now() + make_interval(mins => ${maxAge})`,
            })
            .returning({ expiresAt: executorAttestations.expiresAt });
          await auditExecutor(txDb, {
            userId: NO_IDENTITY,
            objectType: "executor",
            objectId: row.id,
            ruleId: verdict === "pass" ? "executor-attestation-passed" : "executor-attestation-failed",
            effect: verdict === "pass" ? "allow" : "deny",
            detail: { executorName: row.name, profileDigest: profile.digest, profileName: profile.name, profileVersion: profile.version, class: s.report.class, reportSha256, failures, maxAgeMinutes: maxAge },
            reason:
              verdict === "pass"
                ? `executor ${row.name} attested ${s.report.class} for profile ${profile.name} v${profile.version} (software-attested, ADR-0190 decision 6)`
                : `executor ${row.name} failed the self-test for profile ${profile.name} v${profile.version} at ${s.report.class}; the class is withdrawn until the next pass`,
          });
          results.push({ profileDigest: profile.digest, class: s.report.class, verdict, failures, expiresAt: verdict === "pass" ? inserted!.expiresAt.toISOString() : null });
        }
        return { ok: true as const, results, current };
      });
      if (!out.ok) {
        // the deciding transaction wrote nothing; the refusal's own row is written after it, on `db`
        await auditSelfTestRefusal(out.current, row);
        return refused(reply, 409, "executor_quarantined", out.current);
      }
      return reply.status(200).send({ results: out.results, next: nextFor(out.current) });
    });

    // ---- stream -----------------------------------------------------------
    scope.get(`${EXECUTOR_CHANNEL_PREFIX}/stream`, async (req, reply) => {
      const auth = await authed(req, reply, true);
      if (!auth) return reply;
      const row = auth.executor!;
      const q = z.object({ window: z.coerce.number().int().min(EXECUTOR_STREAM_WINDOW.min).max(EXECUTOR_STREAM_WINDOW.max).default(EXECUTOR_STREAM_WINDOW.default) }).safeParse(req.query ?? {});
      if (!q.success) return refused(reply, 400, "invalid_window", row);
      const org = await loadOrgSettings(db);
      const profiles = await liveProfileRefs(db);
      reply.hijack();
      reply.raw.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", connection: "keep-alive" });
      const write = (m: ExecutorStreamMessage) => reply.raw.write(`${JSON.stringify(m)}\n`);
      write({ type: "hello", executor: executorView(row), profiles, attestationMaxAgeMinutes: org.executorAttestationMaxAgeMinutes });
      const sent = new Set<string>();
      let lastStatus = `${row.status}:${row.quarantineCode ?? ""}`;
      let lastKeepalive = Date.now();
      const end = Date.now() + q.data.window * 1000;
      let closed = false;
      req.raw.on("close", () => (closed = true));
      try {
        while (!closed && Date.now() < end) {
          const [current] = await db.select().from(executors).where(eq(executors.id, row.id));
          if (!current) break;
          const status = `${current.status}:${current.quarantineCode ?? ""}`;
          if (status !== lastStatus) {
            lastStatus = status;
            write({ type: "status", status: current.status, quarantineCode: current.quarantineCode });
            if (current.status === "revoked") {
              write({ type: "bye", reason: "revoked" });
              break;
            }
          }
          if (current.status === "active") {
            await expireOffers(db);
            const open = await db
              .select()
              .from(executionOffers)
              .where(and(eq(executionOffers.executorId, row.id), eq(executionOffers.status, "offered"), sql`${executionOffers.expiresAt} > now()`))
              .orderBy(executionOffers.offeredAt);
            for (const o of open) {
              if (sent.has(o.id)) continue;
              sent.add(o.id);
              write({ type: "offer", offer: offerView(o) });
            }
          }
          if (Date.now() - lastKeepalive >= keepaliveMs) {
            lastKeepalive = Date.now();
            write({ type: "keepalive" });
          }
          await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(1, end - Date.now()))));
        }
        if (!closed && lastStatus.split(":")[0] !== "revoked") write({ type: "bye", reason: "window" });
      } finally {
        reply.raw.end();
      }
      return reply;
    });

    /**
     * The executor row as committed now, share-locked for the rest of the caller's transaction (as the self-test
     * does, amendment T): a quarantine, a revoke or a lowered/unmapped declared class committed after authentication
     * is seen here, and none can commit while the caller's decision is made. Taken BEFORE the offer lock.
     */
    async function lockedExecutor(tx: Db, executorId: string): Promise<ExecutorRow | null> {
      const [e] = await tx.select().from(executors).where(eq(executors.id, executorId)).for("share");
      return e ?? null;
    }

    /**
     * Review follow-up (2026-10-10): a take or a report refused because the executor is no longer active leaves its
     * own deny row, as a mismatch does. Written on `db` AFTER the deciding transaction has ended, so it commits
     * whatever that transaction did (the PUT routes' pattern for an audited refusal).
     */
    async function auditQuarantinedRefusal(step: "accept" | "report", executor: ExecutorRow | null, authed: ExecutorRow, offerId: string): Promise<void> {
      const ex = executor ?? authed;
      await auditExecutor(db, {
        userId: NO_IDENTITY,
        objectType: "execution_placement",
        objectId: offerId,
        ruleId: "executor-channel-refused",
        effect: "deny",
        detail: { phase: `offer-${step}`, code: "executor_quarantined", offerId, executorId: ex.id, executorName: ex.name, status: executor?.status ?? null, quarantineCode: executor?.quarantineCode ?? null },
        reason: `executor ${ex.name} may not ${step === "accept" ? "take" : "report on"} offer ${offerId}: it is ${executor?.status ?? "gone"}, not active; nothing was placed (ADR-0190 decision 6)`,
      });
    }

    /**
     * The self-test's twin of `auditQuarantinedRefusal`: a self-test refused because the executor is not active
     * (at authentication, or as the judging transaction re-read it) leaves its own deny row, written on `db` after
     * any deciding transaction has ended. Nothing was judged and no attestation was written.
     */
    async function auditSelfTestRefusal(executor: ExecutorRow | null, authed: ExecutorRow): Promise<void> {
      const ex = executor ?? authed;
      await auditExecutor(db, {
        userId: NO_IDENTITY,
        objectType: "executor",
        objectId: ex.id,
        ruleId: "executor-channel-refused",
        effect: "deny",
        detail: { phase: "self-test", code: "executor_quarantined", executorId: ex.id, executorName: ex.name, status: executor?.status ?? null, quarantineCode: executor?.quarantineCode ?? null },
        reason: `executor ${ex.name} may not self-test: it is ${executor?.status ?? "gone"}, not active; nothing was judged and no attestation was written (ADR-0190 amendment T)`,
      });
    }

    /** the offer named by the route, locked, if it belongs to this executor */
    async function lockedOffer(tx: Db, executorId: string, offerId: string): Promise<ExecutionOfferRow | null> {
      const [o] = await tx
        .select()
        .from(executionOffers)
        .where(and(eq(executionOffers.id, offerId), eq(executionOffers.executorId, executorId)))
        .for("update");
      return o ?? null;
    }

    // ---- accept -----------------------------------------------------------
    scope.post(`${EXECUTOR_CHANNEL_PREFIX}/offers/:offerId/accept`, { bodyLimit: 1024 }, async (req, reply) => {
      const auth = await authed(req, reply, true);
      if (!auth) return reply;
      const row = auth.executor!;
      const p = uuidParam.safeParse(req.params);
      if (!p.success) return refused(reply, 400, "invalid_offer", row);
      // the executor as the transaction sees it (the row loaded at authentication is not trusted for class or status);
      // an executor that is not active is refused there, once, and audited below
      let current: ExecutorRow | null = row;
      const out = await db.transaction(async (tx) => {
        const ex = await lockedExecutor(tx as unknown as Db, row.id);
        current = ex;
        if (!ex || ex.status !== "active") return { status: 409, code: "executor_quarantined" } as const;
        const o = await lockedOffer(tx as unknown as Db, ex.id, p.data.offerId);
        if (!o) return { status: 404, code: "offer_unknown" } as const;
        if (o.status !== "offered") return { status: 409, code: "offer_unavailable" } as const;
        const now = await databaseNow(tx);
        if (o.expiresAt.getTime() <= now.getTime()) return { status: 409, code: "offer_expired" } as const;
        // re-checked at the moment of taking: a fresh attestation at or above the requirement (decision 4)
        const fresh = await freshAttestation(tx as unknown as Db, ex.id, o.profileDigest, now);
        if (!fresh) return { status: 409, code: "attestation_stale" } as const;
        const effective = fresh.class === "customer_declared" ? ex.declaredClass : fresh.class;
        if (!effective || isolationClassRank(effective) < isolationClassRank(o.requiredClass)) return { status: 409, code: "class_below_required" } as const;
        await tx.update(executionOffers).set({ status: "accepted", acceptedAt: sql`now()` }).where(eq(executionOffers.id, o.id));
        return { status: 200, offer: offerView(o) } as const;
      });
      if (out.status !== 200) {
        if (out.code === "executor_quarantined") await auditQuarantinedRefusal("accept", current, row, p.data.offerId);
        return refused(reply, out.status, out.code, current);
      }
      return reply.status(200).send({ offer: out.offer, next: nextFor(current) });
    });

    // ---- decline ----------------------------------------------------------
    scope.post(`${EXECUTOR_CHANNEL_PREFIX}/offers/:offerId/decline`, { bodyLimit: 1024 }, async (req, reply) => {
      const auth = await authed(req, reply, true);
      if (!auth) return reply;
      const row = auth.executor!;
      const p = uuidParam.safeParse(req.params);
      const body = executorDeclineSchema.safeParse(jsonOf(req));
      if (!p.success || !body.success) return refused(reply, 400, "invalid_body", row);
      const out = await db.transaction(async (tx) => {
        const o = await lockedOffer(tx as unknown as Db, row.id, p.data.offerId);
        if (!o) return { status: 404, code: "offer_unknown" } as const;
        if (o.status !== "offered") return { status: 409, code: "offer_unavailable" } as const;
        const placementId = await refusedPlacement(tx as unknown as Db, o, declineToRefusal[body.data.reason]);
        await tx.update(executionOffers).set({ status: "declined", declineReason: body.data.reason, endedAt: sql`now()`, placementId }).where(eq(executionOffers.id, o.id));
        return { status: 204 } as const;
      });
      if (out.status !== 204) return refused(reply, out.status, out.code, row);
      return reply.status(204).send();
    });

    // ---- report (decision 6: before the first byte of input) -----------------
    scope.post(`${EXECUTOR_CHANNEL_PREFIX}/offers/:offerId/report`, { bodyLimit: EXECUTOR_REPORT_BODY_LIMIT_BYTES }, async (req, reply) => {
      const auth = await authed(req, reply, true);
      if (!auth) return reply;
      const row = auth.executor!;
      const p = uuidParam.safeParse(req.params);
      const body = executorPlacementReportSchema.safeParse(jsonOf(req));
      if (!p.success || !body.success) return refused(reply, 400, "invalid_body", row);
      const signed = body.data.report;
      if (signed.report.kind !== "placement" || signed.report.offerId !== p.data.offerId) return refused(reply, 400, "report_offer_mismatch", row);
      if (signed.report.executor.identifier !== auth.client.identity.identifier) return refused(reply, 400, "report_identifier", row);
      if (!(await verifyReportSignature(auth, signed))) return refused(reply, 401, "report_signature_invalid", row);

      // the executor as the transaction sees it (the row loaded at authentication is not trusted for class or status);
      // an executor that is not active is refused there, once, and audited below
      let current: ExecutorRow | null = row;
      const out = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const ex = await lockedExecutor(txDb, row.id);
        current = ex;
        if (!ex || ex.status !== "active") return { status: 409, code: "executor_quarantined" } as const;
        const o = await lockedOffer(txDb, ex.id, p.data.offerId);
        if (!o) return { status: 404, code: "offer_unknown" } as const;
        if (o.status !== "accepted") return { status: 409, code: "offer_unavailable" } as const;
        // review M2: the report deadline (accepted_at + EXECUTION_OFFER_REPORT_TTL_SECONDS) on the database clock; a late
        // report is refused and the offer expires in this same transaction (as the sweep would have)
        const [late] = await tx.select({ id: executionOffers.id }).from(executionOffers).where(and(eq(executionOffers.id, o.id), offerOverdue));
        if (late) {
          await expireLockedOffer(txDb, o);
          return { status: 409, code: "offer_expired" } as const;
        }
        const profile = await profileByDigest(txDb, o.profileDigest);
        const failures: ReportFailure[] = [];
        if (!profile || profile.retiredAt) failures.push({ probe: "report", code: "profile_digest_mismatch" });
        else failures.push(...evaluateExecutorReport(signed.report, { profile: profile.parsed, profileDigest: profile.digest, backend: ex.backend, classesDeclared: ex.classesDeclared, requiredClass: o.requiredClass }).failures);
        if (signed.report.imageDigest !== o.imageDigest) failures.push({ probe: "report", code: "image_digest_mismatch" });
        // the class actually applied must also satisfy the requirement through the customer mapping, if that is what it is.
        // Never below the required class (ADR-0190 decision 7; enforcement is the only mode, OWNER DECISION A).
        const effective = signed.report.class === "customer_declared" ? ex.declaredClass : signed.report.class;
        if (!effective || isolationClassRank(effective) < isolationClassRank(o.requiredClass)) {
          if (!failures.some((f) => f.code === "class_below_required")) failures.push({ probe: "report", code: "class_below_required" });
        }
        const reportSha256 = executorReportDigest(signed.report);
        const detail = { offerId: o.id, workloadKind: o.workloadKind, requiredClass: o.requiredClass, requiredBy: o.requiredBy, profileDigest: o.profileDigest, executorId: ex.id, executorName: ex.name, backend: ex.backend, class: signed.report.class, imageDigest: signed.report.imageDigest, reportSha256, report: signed.report, signature: signed.signature };
        if (failures.length > 0) {
          const auditId = await auditExecutor(txDb, {
            userId: NO_IDENTITY,
            objectType: "execution_placement",
            objectId: o.id,
            ruleId: "execution-profile-mismatch",
            effect: "deny",
            detail: { ...detail, failures },
            reason: `the per-placement report disagrees with the placement (${failures.map((f) => `${f.probe}:${f.code}`).join(", ")}): refused before any input was delivered; the executor is quarantined (ADR-0190 decision 6)`,
          });
          const linked = await linkedPlacementOf(txDb, o.id);
          const [pl] = linked
            ? [linked, await tx.insert(executionPlacementReports).values({ placementId: linked.id, offerId: o.id, auditId, outcome: "mismatch", appliedClass: signed.report.class, reportSha256, refusalCode: "execution_profile_mismatch" })]
            : await tx
                .insert(executionPlacements)
                .values({ auditId, workloadKind: o.workloadKind, requiredClass: o.requiredClass, requiredBy: o.requiredBy, enforcement: ENFORCEMENT, profileDigest: o.profileDigest, executorId: ex.id, appliedClass: signed.report.class, reportSha256, outcome: "mismatch", refusalCode: "execution_profile_mismatch", imageDigest: o.imageDigest })
                .returning({ id: executionPlacements.id });
          await tx.update(executionOffers).set({ status: "mismatch", reportedAt: sql`now()`, placementId: pl!.id }).where(eq(executionOffers.id, o.id));
          return { status: 409, code: "execution_profile_mismatch", failures, placementId: pl!.id } as const;
        }
        const auditId = await auditExecutor(txDb, {
          userId: NO_IDENTITY,
          objectType: "execution_placement",
          objectId: o.id,
          ruleId: "execution-placed",
          detail,
          reason: `placed at ${signed.report.class} on executor ${ex.name} (required ${o.requiredClass} by ${o.requiredBy}); software-attested per-placement report ${reportSha256.slice(0, 12)} verified before input (ADR-0190 decision 6)`,
        });
        // I4: a governed stdio decision already wrote this placement's row (outcome `offered`): its report is linked
        const linked = await linkedPlacementOf(txDb, o.id);
        const [pl] = linked
          ? [linked, await tx.insert(executionPlacementReports).values({ placementId: linked.id, offerId: o.id, auditId, outcome: "placed", appliedClass: signed.report.class, reportSha256 })]
          : await tx
              .insert(executionPlacements)
              .values({ auditId, workloadKind: o.workloadKind, requiredClass: o.requiredClass, requiredBy: o.requiredBy, enforcement: ENFORCEMENT, profileDigest: o.profileDigest, executorId: ex.id, appliedClass: signed.report.class, reportSha256, outcome: "placed", imageDigest: o.imageDigest })
              .returning({ id: executionPlacements.id });
        await tx.update(executionOffers).set({ status: "placed", reportedAt: sql`now()`, placementId: pl!.id }).where(eq(executionOffers.id, o.id));
        return { status: 200, placementId: pl!.id, reportSha256 } as const;
      });
      if (out.status === 409 && out.code === "execution_profile_mismatch") {
        // outside the placement's transaction: the quarantine must hold even if nothing else does
        await quarantineExecutor(db, row.id, "execution_profile_mismatch", { detail: { offerId: p.data.offerId, placementId: out.placementId, failures: out.failures } });
        return reply.status(409).send({ error: out.code, next: "quarantined", failures: out.failures });
      }
      if (out.status !== 200) {
        if (out.code === "executor_quarantined") await auditQuarantinedRefusal("report", current, row, p.data.offerId);
        return refused(reply, out.status, out.code, current);
      }
      return reply.status(200).send({ release: true, placementId: out.placementId, reportSha256: out.reportSha256, next: nextFor(current) });
    });

    // ---- end --------------------------------------------------------------
    scope.post(`${EXECUTOR_CHANNEL_PREFIX}/offers/:offerId/end`, { bodyLimit: 1024 }, async (req, reply) => {
      const auth = await authed(req, reply, true);
      if (!auth) return reply;
      const row = auth.executor!;
      const p = uuidParam.safeParse(req.params);
      const body = executorEndSchema.safeParse(jsonOf(req));
      if (!p.success || !body.success) return refused(reply, 400, "invalid_body", row);
      const ended = await db.transaction(async (tx) => {
        const [o] = await tx
          .update(executionOffers)
          .set({ status: "ended", endOutcome: body.data.outcome, endedAt: sql`now()` })
          .where(and(eq(executionOffers.id, p.data.offerId), eq(executionOffers.executorId, row.id), eq(executionOffers.status, "placed")))
          .returning();
        if (!o) return false;
        // review L5: how a placed sandbox ended is audit evidence too
        await auditExecutor(tx as unknown as Db, {
          userId: NO_IDENTITY,
          objectType: "execution_placement",
          objectId: o.id,
          ruleId: "execution-ended",
          effect: body.data.outcome === "completed" ? "allow" : "deny",
          detail: { offerId: o.id, placementId: o.placementId, executorId: row.id, executorName: row.name, workloadKind: o.workloadKind, outcome: body.data.outcome },
          reason: `the sandbox placed on executor ${row.name} ended: ${body.data.outcome} (ADR-0190 decision 13)`,
        });
        return true;
      });
      if (!ended) return refused(reply, 409, "offer_unavailable", row);
      // I4: a stdio session this process holds ends with its sandbox
      endStdioSession(p.data.offerId);
      return reply.status(204).send();
    });

    // ---- I4: the stdio session's bytes (same proof, same scope) ---------------
    registerExecutorStdioRoutes(scope, db, {
      authed: async (req, reply) => (await authed(req, reply, true))?.executor ?? null,
      refused,
      jsonOf,
      keepaliveMs,
    });
  });
}
