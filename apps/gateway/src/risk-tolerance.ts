/**
 * ADR-0180 §6 (A10) — RISK TOLERANCE AND TIME-BOXED ACCEPTANCE.
 *
 *   `packages/shared/src/risks.ts`   the request shapes and the pure rules:
 *                                    the calendar expiry cap, the tolerance
 *                                    resolution (strict default, stricter of
 *                                    category and tier wins), band comparison.
 *   THIS FILE                        the routes, `recordRiskAcceptance` (the ONE
 *                                    acceptance write path), `residualPosition`
 *                                    (read by the deploy gate), the expiry
 *                                    sweep and the monitor loader.
 *
 * THE RULES THIS FILE HOLDS
 * -------------------------
 *  1. STRICT BY DEFAULT. With no `risk_tolerances` row, residual risk above
 *     `ASSURANCE_DEFAULTS.toleranceMaxBand` (medium) needs a valid acceptance.
 *     An admin may relax a category or a tier; the change is audited with the
 *     set it replaced and the set it wrote.
 *  2. AN ACCEPTANCE IS TIME-BOXED. At most 6 calendar months for high or
 *     critical residual risk, 12 otherwise (`maxAcceptanceMonths`). An expiry
 *     beyond the cap is refused (422), never clamped; none given = the cap.
 *  3. ONE WRITE PATH, ONE LIVE ROW. `recordRiskAcceptance` is called by the new
 *     route, the legacy `POST /v1/risks/:riskId/accept` (now a wrapper) and the
 *     sign-off's `acceptRisks`. A new acceptance supersedes the live one in the
 *     caller's transaction: either both rows change or neither does. The
 *     `ai_risks` accepted-by/at/note columns are kept in step.
 *  4. AN EXPIRED ACCEPTANCE REOPENS ITS RISK. The sweep stamps `expired_at`,
 *     moves the risk back to `open` (audited as the deployment, never as a
 *     person) and raises `risk_acceptance_expired`. The gate does not wait for
 *     the sweep: an acceptance past `expires_at` is never valid.
 *
 * THE RESIDUAL BAND reuses the register's one mapping, `effectiveRiskRating`
 * (ADR-0156's 3x3 matrix over the DECLARED residual likelihood and impact, or
 * the inherent pair when no residual is declared; a closed risk has none).
 * The three-level scale never yields `critical`, so a high residual is `high`.
 *
 * Who may accept: an admin, or a risk acceptor the review policy names
 * (`governance_review_policy.risk_acceptor_user_ids`, the ADR-0168 rule). The
 * owner of the risk's use case may not accept it (ADR-0170 §8).
 */
import type { FastifyInstance } from "fastify";
import {
  PROSE_SCRUB,
  aiRisks,
  aiUseCases,
  and,
  asc,
  auditLog,
  desc,
  eq,
  governanceAlerts,
  inArray,
  isNull,
  lte,
  ne,
  notInArray,
  riskAcceptances,
  riskTolerances,
  users,
  type AiRiskRow,
  type Db,
  type RiskAcceptanceRow,
} from "@regulait/db";
import {
  ASSURANCE_DEFAULTS,
  AI_RISK_CATEGORIES,
  MONITOR_RULES,
  REVIEW_POLICY_TIER_KEYS,
  RISK_TOLERANCE_SCOPE_KEYS,
  TOLERANCE_BANDS,
  acceptanceCoversBand,
  bandExceedsTolerance,
  createRiskAcceptanceSchema,
  effectiveRiskRating,
  maxAcceptanceExpiry,
  maxAcceptanceMonths,
  putRiskTolerancesSchema,
  resolveRiskTolerance,
  type AssuranceMonitorRuleId,
  type CompensatingControlInput,
  type MonitorAssuranceInput,
  type MonitorAssuranceSubject,
  type ResidualPosition,
  type ResidualPositionFn,
  type ResidualRiskBand,
  type RiskAcceptanceSummary,
  type RiskResponseType,
  type ToleranceBand,
  type ToleranceRowInput,
} from "@regulait/shared";
import { z } from "zod";
import { isRiskAcceptor, loadReviewPolicy, tierKeyFor } from "./review-policy.js";
import { MONITOR_AUDIT_RULE_IDS } from "./governance-monitor.js";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
const riskIdParam = z.object({ riskId: z.string().uuid() });

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** a handle or a transaction: the acceptance write runs inside the caller's */
export type DbOrTx = Db | Tx;

/** stable rule ids — the strings an operator greps the audit log for */
export const RISK_ACCEPTANCE_RULE_IDS = {
  recorded: "risk-acceptance-recorded",
  expired: "risk-acceptance-expired",
  tolerancesSet: "risk-tolerances-set",
  historyRead: "risk-acceptances-read",
  refused: "risk-acceptance-refused",
} as const;

/** a refusal by name, raised before anything is written */
export class RiskAcceptanceRefusal extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body.error));
  }
}

// ---------------------------------------------------------------------------
// The residual band and the tolerance
// ---------------------------------------------------------------------------

type RiskForBand = Pick<
  AiRiskRow,
  "id" | "title" | "status" | "likelihood" | "impact" | "residualLikelihood" | "residualImpact"
>;

/** the residual band the register's own mapping gives, or null for a closed risk */
export function residualBandOf(risk: RiskForBand): ResidualRiskBand | null {
  const rating = effectiveRiskRating(risk);
  return rating && rating.band !== "none" ? rating.band : null;
}

async function loadToleranceRows(db: DbOrTx): Promise<ToleranceRowInput[]> {
  return db
    .select({ scopeKind: riskTolerances.scopeKind, scopeKey: riskTolerances.scopeKey, maxBand: riskTolerances.maxBand })
    .from(riskTolerances);
}

const liveAcceptance = and(
  isNull(riskAcceptances.supersededAt),
  isNull(riskAcceptances.expiredAt),
  isNull(riskAcceptances.revokedAt),
);

function summary(row: RiskAcceptanceRow): RiskAcceptanceSummary {
  return {
    id: row.id,
    responseType: row.responseType,
    residualBand: row.residualBand,
    acceptedByUserId: row.acceptedByUserId,
    acceptedAt: row.acceptedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

/** the live acceptance of each risk that is still VALID at `now`: unexpired
 * (by the clock, whether or not the sweep has run), unsuperseded, unrevoked */
async function validAcceptances(db: DbOrTx, riskIds: string[], now: Date): Promise<Map<string, RiskAcceptanceRow>> {
  if (riskIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(riskAcceptances)
    .where(and(inArray(riskAcceptances.riskId, riskIds), liveAcceptance));
  return new Map(rows.filter((r) => r.expiresAt.getTime() > now.getTime()).map((r) => [r.riskId, r]));
}

function positionOf(
  risk: RiskForBand & { category: string },
  tier: string | null,
  tolerances: readonly ToleranceRowInput[],
  live: RiskAcceptanceRow | undefined,
): ResidualPosition {
  const band = residualBandOf(risk);
  const tolerance = resolveRiskTolerance(tolerances, { category: risk.category, tier });
  // an acceptance covers the band it was recorded at, never a higher one
  const valid = band && live && acceptanceCoversBand(live.residualBand, band) ? live : null;
  const above = band !== null && bandExceedsTolerance(band, tolerance.band);
  return {
    riskId: risk.id,
    band,
    tolerance,
    acceptance: valid ? summary(valid) : null,
    aboveTolerance: above && !valid,
  };
}

/**
 * Each live (not closed) risk recorded against the use case: its residual
 * band, the tolerance that applies and where it came from, the valid
 * acceptance (or null), and `aboveTolerance` — TRUE when the band sits above
 * the tolerance AND no valid acceptance covers it, i.e. the fact that holds
 * the deploy gate (A3 composes it).
 */
export const residualPosition: ResidualPositionFn<Db> = async (db, useCaseId, now) => {
  const [uc] = await db
    .select({ id: aiUseCases.id, euAiActTier: aiUseCases.euAiActTier })
    .from(aiUseCases)
    .where(eq(aiUseCases.id, useCaseId));
  if (!uc) return [];
  const risks = await db
    .select()
    .from(aiRisks)
    .where(and(eq(aiRisks.useCaseId, useCaseId), ne(aiRisks.status, "closed")))
    .orderBy(asc(aiRisks.createdAt), asc(aiRisks.id));
  const tolerances = await loadToleranceRows(db);
  const live = await validAcceptances(db, risks.map((r) => r.id), now);
  const tier = tierKeyFor(uc.euAiActTier);
  return risks.map((r) => positionOf(r, tier, tolerances, live.get(r.id)));
};

// ---------------------------------------------------------------------------
// THE ONE ACCEPTANCE WRITE PATH
// ---------------------------------------------------------------------------

export interface RecordRiskAcceptanceInput {
  riskId: string;
  /** default `accept` */
  responseType?: RiskResponseType;
  rationale: string;
  compensatingControls?: CompensatingControlInput[];
  /** absent/null = the longest the residual band allows */
  expiresAt?: Date | null;
  actorUserId: string | null;
  now?: Date;
  /** which door the acceptance came through, for the audit row */
  origin?: { kind: "register" | "legacy_accept" | "sign_off"; approvalId?: string };
}

export interface RecordedRiskAcceptance {
  acceptance: RiskAcceptanceRow;
  supersededId: string | null;
  band: ResidualRiskBand;
  maxExpiresAt: Date;
}

/**
 * Record an acceptance. RUN IT INSIDE A TRANSACTION (`db.transaction(tx =>
 * recordRiskAcceptance(tx, …))`): it locks the risk row, supersedes the live
 * acceptance, inserts the new one, links the two, keeps `ai_risks` in step and
 * writes the audit row; a failure anywhere leaves the previous acceptance live.
 * Refusals (`RiskAcceptanceRefusal`) are raised before any write. The caller
 * decides who may accept; this decides only what may be recorded.
 */
export async function recordRiskAcceptance(
  db: DbOrTx,
  input: RecordRiskAcceptanceInput,
): Promise<RecordedRiskAcceptance> {
  const now = input.now ?? new Date();
  const [risk] = await db.select().from(aiRisks).where(eq(aiRisks.id, input.riskId)).for("update");
  if (!risk) throw new RiskAcceptanceRefusal(404, { error: "not_found" });
  const band = residualBandOf(risk);
  if (risk.status === "closed" || band === null) {
    throw new RiskAcceptanceRefusal(409, { error: "risk_terminal", detail: "a closed risk has nothing left to accept" });
  }
  const maxExpiresAt = maxAcceptanceExpiry(band, now);
  const expiresAt = input.expiresAt ?? maxExpiresAt;
  if (expiresAt.getTime() > maxExpiresAt.getTime()) {
    throw new RiskAcceptanceRefusal(422, {
      error: "acceptance_expiry_beyond_maximum",
      band,
      maxMonths: maxAcceptanceMonths(band),
      maxExpiresAt: maxExpiresAt.toISOString(),
      detail:
        `an acceptance of ${band} residual risk may run at most ${maxAcceptanceMonths(band)} months ` +
        `(until ${maxExpiresAt.toISOString()}); choose an earlier expiry`,
    });
  }
  if (expiresAt.getTime() <= now.getTime()) {
    throw new RiskAcceptanceRefusal(422, {
      error: "acceptance_expiry_not_in_future",
      detail: "an acceptance must expire after the moment it is recorded",
    });
  }
  // jsonb is outside the prose-scrub registry: scrub each description here
  const controls = (input.compensatingControls ?? []).map((c) => ({
    controlRef: c.controlRef ?? null,
    description: PROSE_SCRUB(c.description),
  }));

  const [previous] = await db
    .update(riskAcceptances)
    .set({ supersededAt: now })
    .where(and(eq(riskAcceptances.riskId, risk.id), liveAcceptance))
    .returning({ id: riskAcceptances.id });
  const [acceptance] = await db
    .insert(riskAcceptances)
    .values({
      riskId: risk.id,
      useCaseId: risk.useCaseId,
      responseType: input.responseType ?? "accept",
      residualBand: band,
      acceptedByUserId: input.actorUserId,
      acceptedAt: now,
      expiresAt,
      rationale: input.rationale,
      compensatingControls: controls,
    })
    .returning();
  if (previous) {
    await db
      .update(riskAcceptances)
      .set({ supersededById: acceptance!.id })
      .where(eq(riskAcceptances.id, previous.id));
  }
  await db
    .update(aiRisks)
    .set({
      status: "accepted",
      acceptedByUserId: input.actorUserId,
      acceptedAt: now,
      acceptanceNote: acceptance!.rationale,
      updatedAt: now,
    })
    .where(eq(aiRisks.id, risk.id));
  await db.insert(auditLog).values({
    userId: input.actorUserId ?? NO_IDENTITY,
    objectType: "ai_risk",
    objectId: risk.id,
    detail: {
      phase: "acceptance-recorded",
      acceptanceId: acceptance!.id,
      supersededId: previous?.id ?? null,
      responseType: acceptance!.responseType,
      residualBand: band,
      expiresAt: expiresAt.toISOString(),
      maxExpiresAt: maxExpiresAt.toISOString(),
      compensatingControls: controls.length,
      origin: input.origin?.kind ?? "register",
      ...(input.origin?.approvalId ? { approvalId: input.origin.approvalId } : {}),
      useCaseId: risk.useCaseId,
    },
    effect: "allow",
    ruleId: RISK_ACCEPTANCE_RULE_IDS.recorded,
    ruleChain: [],
    reason:
      `${band} residual risk '${risk.title}' accepted (${acceptance!.responseType}) until ` +
      `${expiresAt.toISOString().slice(0, 10)}${previous ? `, superseding acceptance ${previous.id}` : ""}: ` +
      `${acceptance!.rationale} — a recorded decision, not a control`,
  });
  return { acceptance: acceptance!, supersededId: previous?.id ?? null, band, maxExpiresAt };
}

const isCheckViolation = (e: unknown, constraint: string): boolean => {
  const err = e as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  return (err?.code ?? err?.cause?.code) === "23514" && (err?.constraint ?? err?.cause?.constraint) === constraint;
};

/** run `recordRiskAcceptance` in its own transaction; a refusal or a store
 * check (a rationale that the credential scrub lengthened past the limit)
 * comes back as `{status, body}` instead of a 500 */
export async function recordRiskAcceptanceTx(
  db: Db,
  input: RecordRiskAcceptanceInput,
): Promise<{ ok: true; recorded: RecordedRiskAcceptance } | { ok: false; status: number; body: Record<string, unknown> }> {
  try {
    const recorded = await db.transaction(async (tx) => recordRiskAcceptance(tx, input));
    return { ok: true, recorded };
  } catch (e) {
    if (e instanceof RiskAcceptanceRefusal) return { ok: false, status: e.status, body: e.body };
    if (isCheckViolation(e, "risk_acceptances_rationale_check")) {
      return {
        ok: false,
        status: 422,
        body: {
          error: "rationale_too_long",
          detail: "the rationale is longer than 4000 characters once credentials in it are redacted; shorten it",
        },
      };
    }
    throw e;
  }
}

/**
 * Who may accept: an admin or a named risk acceptor, and never the owner of
 * the risk's use case (ADR-0170 §8: not an arm's-length acceptance). The
 * bootstrap token (no user) is an operator and passes as admin.
 */
export async function acceptorRefusal(
  db: DbOrTx,
  auth: { isAdmin: boolean; userId: string | null },
  risk: Pick<AiRiskRow, "useCaseId">,
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  if (!auth.isAdmin) {
    if (!auth.userId || !isRiskAcceptor(await loadReviewPolicy(db as Db), auth.userId)) {
      return {
        status: 403,
        body: {
          error: "not_a_risk_acceptor",
          detail: "residual risk is accepted by an admin or by a risk acceptor named in the review policy",
        },
      };
    }
  }
  if (auth.userId && risk.useCaseId) {
    const [uc] = await db
      .select({ ownerUserId: aiUseCases.ownerUserId })
      .from(aiUseCases)
      .where(eq(aiUseCases.id, risk.useCaseId));
    if (uc && uc.ownerUserId === auth.userId) {
      return {
        status: 403,
        body: {
          error: "proposer_cannot_accept_risk",
          detail: "the owner of the use case cannot accept its residual risk: the acceptance must be at arm's length",
        },
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The expiry sweep
// ---------------------------------------------------------------------------

function expiredSubject(
  acceptance: Pick<RiskAcceptanceRow, "id" | "riskId" | "expiresAt" | "residualBand">,
  risk: { title: string; useCaseId: string | null },
): MonitorAssuranceSubject {
  return {
    subjectKey: `risk:${acceptance.riskId}>acceptance:${acceptance.id}`,
    title:
      `Acceptance of risk '${risk.title.slice(0, 120)}' expired on ${acceptance.expiresAt.toISOString().slice(0, 10)}; ` +
      "the risk is reopened and needs a new decision",
    detail: {
      riskId: acceptance.riskId,
      acceptanceId: acceptance.id,
      useCaseId: risk.useCaseId,
      residualBand: acceptance.residualBand,
      expiresAt: acceptance.expiresAt.toISOString(),
    },
  };
}

export interface RiskAcceptanceExpirySweepResult {
  due: number;
  expired: number;
  reopened: number;
  raised: number;
}

/**
 * Stamp every live acceptance past its expiry as expired (compare-and-swap, so
 * a racing pass expires each once), reopen its risk (clearing the accepted
 * state; audited as the deployment) and raise `risk_acceptance_expired`. The
 * monitor keeps reporting the episode until a new acceptance covers the risk
 * or the risk is closed. At most 500 per pass, oldest expiry first.
 */
export async function runRiskAcceptanceExpirySweep(
  db: Db,
  opts: { now?: Date; actorUserId?: string | null } = {},
): Promise<RiskAcceptanceExpirySweepResult> {
  const now = opts.now ?? new Date();
  const actor = opts.actorUserId ?? NO_IDENTITY;
  const due = await db
    .select({ id: riskAcceptances.id })
    .from(riskAcceptances)
    .where(and(liveAcceptance, lte(riskAcceptances.expiresAt, now)))
    .orderBy(asc(riskAcceptances.expiresAt))
    .limit(500);
  const out: RiskAcceptanceExpirySweepResult = { due: due.length, expired: 0, reopened: 0, raised: 0 };
  for (const { id } of due) {
    const done = await db.transaction(async (tx) => {
      const [acc] = await tx
        .update(riskAcceptances)
        .set({ expiredAt: now })
        .where(and(eq(riskAcceptances.id, id), liveAcceptance, lte(riskAcceptances.expiresAt, now)))
        .returning();
      if (!acc) return null;
      const [risk] = await tx.select().from(aiRisks).where(eq(aiRisks.id, acc.riskId)).for("update");
      if (!risk) return null;
      // the unique live index means this was the risk's only live acceptance
      const reopen = risk.status === "accepted";
      if (reopen) {
        await tx
          .update(aiRisks)
          .set({ status: "open", acceptedByUserId: null, acceptedAt: null, acceptanceNote: null, updatedAt: now })
          .where(eq(aiRisks.id, risk.id));
      }
      await tx.insert(auditLog).values({
        userId: actor,
        objectType: "ai_risk",
        objectId: risk.id,
        detail: {
          phase: "acceptance-expired",
          acceptanceId: acc.id,
          residualBand: acc.residualBand,
          expiresAt: acc.expiresAt.toISOString(),
          from: risk.status,
          to: reopen ? "open" : risk.status,
          reopened: reopen,
          useCaseId: risk.useCaseId,
        },
        effect: "allow",
        ruleId: RISK_ACCEPTANCE_RULE_IDS.expired,
        ruleChain: [],
        reason:
          `the acceptance of residual risk '${risk.title}' expired on ${acc.expiresAt.toISOString().slice(0, 10)}` +
          (reopen ? "; the risk is REOPENED and needs a new decision" : `; the risk stays ${risk.status}`),
      });
      if (risk.status === "closed") return { reopened: false, raised: false };
      const subject = expiredSubject(acc, risk);
      const severity = MONITOR_RULES.risk_acceptance_expired.severity;
      const [alert] = await tx
        .insert(governanceAlerts)
        .values({
          ruleId: "risk_acceptance_expired",
          subjectKey: subject.subjectKey,
          severity,
          title: subject.title,
          detail: subject.detail ?? {},
          firstDetectedAt: now,
          lastDetectedAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: governanceAlerts.id });
      if (alert) {
        await tx.insert(auditLog).values({
          userId: actor,
          objectType: "governance_alert",
          objectId: alert.id,
          detail: { ruleId: "risk_acceptance_expired", subjectKey: subject.subjectKey, severity },
          effect: "allow",
          ruleId: MONITOR_AUDIT_RULE_IDS.raised,
          ruleChain: [],
          reason: `governance alert raised (${severity}): ${subject.title}`,
        });
      }
      return { reopened: reopen, raised: !!alert };
    });
    if (!done) continue;
    out.expired += 1;
    if (done.reopened) out.reopened += 1;
    if (done.raised) out.raised += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The monitor loader
// ---------------------------------------------------------------------------

/**
 * `residual_above_tolerance`: one subject per (use case, risk) where the risk's
 * residual band sits above its tolerance with no valid acceptance, for every
 * use case not rejected or retired (checks apply live, no grandfathering).
 * `risk_acceptance_expired`: one subject per live risk whose LATEST acceptance
 * has expired (swept or not) and nothing newer covers it.
 */
export async function residualRiskMonitorInput(
  db: Db,
  now: Date,
): Promise<Partial<Record<AssuranceMonitorRuleId, MonitorAssuranceInput>>> {
  const rows = await db
    .select({
      risk: aiRisks,
      useCaseName: aiUseCases.name,
      euAiActTier: aiUseCases.euAiActTier,
    })
    .from(aiRisks)
    .innerJoin(aiUseCases, eq(aiUseCases.id, aiRisks.useCaseId))
    .where(and(ne(aiRisks.status, "closed"), notInArray(aiUseCases.status, ["rejected", "retired"])));
  const tolerances = await loadToleranceRows(db);
  const live = await validAcceptances(db, rows.map((r) => r.risk.id), now);
  const above: MonitorAssuranceSubject[] = [];
  for (const { risk, useCaseName, euAiActTier } of rows) {
    const p = positionOf(risk, tierKeyFor(euAiActTier), tolerances, live.get(risk.id));
    if (!p.aboveTolerance || !p.band) continue;
    above.push({
      subjectKey: `use_case:${risk.useCaseId}>risk:${risk.id}`,
      title:
        `${useCaseName}: risk '${risk.title.slice(0, 120)}' has ${p.band} residual risk, above the ` +
        `${p.tolerance.band} tolerance (${p.tolerance.source}), with no valid acceptance`,
      detail: {
        useCaseId: risk.useCaseId,
        riskId: risk.id,
        band: p.band,
        tolerance: p.tolerance.band,
        toleranceSource: p.tolerance.source,
      },
    });
  }

  const history = await db
    .select({ acc: riskAcceptances, title: aiRisks.title, useCaseId: aiRisks.useCaseId })
    .from(riskAcceptances)
    .innerJoin(aiRisks, eq(aiRisks.id, riskAcceptances.riskId))
    .where(and(ne(aiRisks.status, "closed"), isNull(riskAcceptances.revokedAt)))
    .orderBy(asc(riskAcceptances.riskId), desc(riskAcceptances.acceptedAt), desc(riskAcceptances.createdAt));
  const expired: MonitorAssuranceSubject[] = [];
  const seen = new Set<string>();
  for (const h of history) {
    if (seen.has(h.acc.riskId)) continue;
    seen.add(h.acc.riskId);
    const lapsed = h.acc.expiredAt !== null || (h.acc.supersededAt === null && h.acc.expiresAt.getTime() <= now.getTime());
    if (!lapsed || live.has(h.acc.riskId)) continue;
    expired.push(expiredSubject(h.acc, { title: h.title, useCaseId: h.useCaseId }));
  }
  return { residual_above_tolerance: { breaches: above }, risk_acceptance_expired: { breaches: expired } };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

type AcceptanceState = "live" | "superseded" | "expired" | "revoked";

function stateOf(row: RiskAcceptanceRow, now: Date): AcceptanceState {
  if (row.revokedAt) return "revoked";
  if (row.supersededAt) return "superseded";
  if (row.expiredAt || row.expiresAt.getTime() <= now.getTime()) return "expired";
  return "live";
}

async function namesOf(db: Db, ids: Array<string | null>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, displayName: users.displayName, email: users.email })
    .from(users)
    .where(inArray(users.id, unique));
  return new Map(rows.map((u) => [u.id, u.displayName || u.email]));
}

async function tolerancesView(db: Db) {
  const rows = await db.select().from(riskTolerances).orderBy(asc(riskTolerances.scopeKind), asc(riskTolerances.scopeKey));
  const names = await namesOf(db, rows.map((r) => r.updatedByUserId));
  const effective = (kind: "category" | "tier", keys: readonly string[]) =>
    Object.fromEntries(
      keys.map((k) => {
        const row = rows.find((r) => r.scopeKind === kind && r.scopeKey === k);
        return [k, row ? { maxBand: row.maxBand, source: "configured" } : { maxBand: ASSURANCE_DEFAULTS.toleranceMaxBand, source: "default" }];
      }),
    );
  return {
    source: rows.length > 0 ? "configured" : "default",
    strictDefault: { maxBand: ASSURANCE_DEFAULTS.toleranceMaxBand },
    tolerances: rows.map((r) => ({
      scopeKind: r.scopeKind,
      scopeKey: r.scopeKey,
      maxBand: r.maxBand,
      relaxed: TOLERANCE_BANDS.indexOf(r.maxBand) > TOLERANCE_BANDS.indexOf(ASSURANCE_DEFAULTS.toleranceMaxBand),
      updatedAt: r.updatedAt.toISOString(),
      updatedByName: r.updatedByUserId ? (names.get(r.updatedByUserId) ?? null) : null,
    })),
    effective: {
      categories: effective("category", AI_RISK_CATEGORIES),
      tiers: effective("tier", REVIEW_POLICY_TIER_KEYS),
    },
    bands: TOLERANCE_BANDS,
    scopeKeys: RISK_TOLERANCE_SCOPE_KEYS,
    acceptanceMaxMonths: {
      highOrCritical: ASSURANCE_DEFAULTS.acceptanceMaxMonthsHighCritical,
      other: ASSURANCE_DEFAULTS.acceptanceMaxMonthsOther,
    },
    note:
      "With no configured row, residual risk above medium needs a valid, time-boxed acceptance. Where a category " +
      "and a tier both apply, the stricter tolerance wins.",
  };
}

/**
 * Routes (classified in route-classes.ts and openapi-registry.ts, A10 block):
 *   GET  /v1/risk-tolerances                admin
 *   PUT  /v1/risk-tolerances                admin, audited (old and new set)
 *   GET  /v1/risks/:riskId/acceptances      non-admin class; owner-or-admin in-handler
 *   POST /v1/risks/:riskId/acceptances      non-admin class; admin or a named risk
 *                                           acceptor in-handler, audited
 */
export function registerRiskToleranceRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/risk-tolerances", async () => tolerancesView(db));

  app.put("/v1/risk-tolerances", async (req) => {
    const body = putRiskTolerancesSchema.parse(req.body);
    const actor = req.authCtx.userId ?? null;
    const before = await db
      .select({ scopeKind: riskTolerances.scopeKind, scopeKey: riskTolerances.scopeKey, maxBand: riskTolerances.maxBand })
      .from(riskTolerances)
      .orderBy(asc(riskTolerances.scopeKind), asc(riskTolerances.scopeKey));
    const after = [...body.tolerances].sort((a, b) =>
      a.scopeKind === b.scopeKind ? a.scopeKey.localeCompare(b.scopeKey) : a.scopeKind.localeCompare(b.scopeKind),
    );
    const key = (t: { scopeKind: string; scopeKey: string; maxBand: string }) => `${t.scopeKind}:${t.scopeKey}=${t.maxBand}`;
    const changed = before.map(key).join(",") !== after.map(key).join(",");
    const relaxed = after.filter(
      (t) => TOLERANCE_BANDS.indexOf(t.maxBand) > TOLERANCE_BANDS.indexOf(ASSURANCE_DEFAULTS.toleranceMaxBand),
    );
    await db.transaction(async (tx) => {
      await tx.delete(riskTolerances);
      if (after.length > 0) {
        const at = new Date();
        await tx.insert(riskTolerances).values(
          after.map((t) => ({
            scopeKind: t.scopeKind,
            scopeKey: t.scopeKey,
            maxBand: t.maxBand as ToleranceBand,
            createdByUserId: actor,
            updatedByUserId: actor,
            createdAt: at,
            updatedAt: at,
          })),
        );
      }
      await tx.insert(auditLog).values({
        userId: actor ?? NO_IDENTITY,
        objectType: "org_settings",
        objectId: null,
        detail: { setting: "riskTolerances", from: before, to: after, changed, relaxed: relaxed.map(key) },
        effect: "allow",
        ruleId: RISK_ACCEPTANCE_RULE_IDS.tolerancesSet,
        ruleChain: [],
        reason:
          after.length === 0
            ? "risk tolerances reset to the strict default (above medium needs a valid acceptance)"
            : `risk tolerances set: ${after.map(key).join(", ")}` +
              (relaxed.length > 0 ? ` — RELAXED above the strict default (medium) for ${relaxed.length} scope(s)` : ""),
      });
    });
    return tolerancesView(db);
  });

  app.get("/v1/risks/:riskId/acceptances", async (req, reply) => {
    const { riskId } = riskIdParam.parse(req.params);
    const [risk] = await db.select().from(aiRisks).where(eq(aiRisks.id, riskId));
    if (!risk) return reply.status(404).send({ error: "not_found" });
    const auth = req.authCtx;
    if (!auth.isAdmin && auth.userId !== risk.ownerUserId) {
      return reply.status(403).send({ error: "forbidden", detail: "a risk is visible to its owner and to admins" });
    }
    const now = new Date();
    const rows = await db
      .select()
      .from(riskAcceptances)
      .where(eq(riskAcceptances.riskId, riskId))
      .orderBy(desc(riskAcceptances.acceptedAt), desc(riskAcceptances.createdAt));
    const names = await namesOf(db, rows.map((r) => r.acceptedByUserId));
    let tier: string | null = null;
    if (risk.useCaseId) {
      const [uc] = await db
        .select({ euAiActTier: aiUseCases.euAiActTier })
        .from(aiUseCases)
        .where(eq(aiUseCases.id, risk.useCaseId));
      tier = uc ? tierKeyFor(uc.euAiActTier) : null;
    }
    const live = rows.find((r) => stateOf(r, now) === "live");
    const position = positionOf(risk, tier, await loadToleranceRows(db), live);
    const refusal = await acceptorRefusal(db, auth, risk);
    if (auth.userId !== risk.ownerUserId) {
      // an admin reading someone else's risk decisions
      await db.insert(auditLog).values({
        userId: auth.userId ?? NO_IDENTITY,
        objectType: "ai_risk",
        objectId: riskId,
        detail: { phase: "acceptances-read", rows: rows.length },
        effect: "allow",
        ruleId: RISK_ACCEPTANCE_RULE_IDS.historyRead,
        ruleChain: [],
        reason: `acceptance history of AI risk '${risk.title}' read by an admin who does not own it`,
      });
    }
    return {
      riskId,
      position: {
        ...position,
        maxAcceptanceMonths: position.band ? maxAcceptanceMonths(position.band) : null,
        maxExpiresAt: position.band ? maxAcceptanceExpiry(position.band, now).toISOString() : null,
      },
      canAccept: refusal === null && position.band !== null,
      acceptRefusal: refusal?.body.error ?? (position.band === null ? "risk_terminal" : null),
      acceptances: rows.map((r) => ({
        id: r.id,
        state: stateOf(r, now),
        responseType: r.responseType,
        residualBand: r.residualBand,
        acceptedByUserId: r.acceptedByUserId,
        acceptedByName: r.acceptedByUserId ? (names.get(r.acceptedByUserId) ?? null) : null,
        acceptedAt: r.acceptedAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
        rationale: r.rationale,
        compensatingControls: r.compensatingControls,
        supersededAt: r.supersededAt?.toISOString() ?? null,
        supersededById: r.supersededById,
        expiredAt: r.expiredAt?.toISOString() ?? null,
        revokedAt: r.revokedAt?.toISOString() ?? null,
        revokeReason: r.revokeReason,
      })),
    };
  });

  app.post("/v1/risks/:riskId/acceptances", async (req, reply) => {
    const { riskId } = riskIdParam.parse(req.params);
    const [risk] = await db.select().from(aiRisks).where(eq(aiRisks.id, riskId));
    if (!risk) return reply.status(404).send({ error: "not_found" });
    const refusal = await acceptorRefusal(db, req.authCtx, risk);
    if (refusal) {
      await db.insert(auditLog).values({
        userId: req.authCtx.userId ?? NO_IDENTITY,
        objectType: "ai_risk",
        objectId: riskId,
        detail: { phase: "acceptance-refused", error: refusal.body.error },
        effect: "deny",
        ruleId: RISK_ACCEPTANCE_RULE_IDS.refused,
        ruleChain: [],
        reason: `acceptance of AI risk '${risk.title}' refused: ${String(refusal.body.error)}`,
      });
      return reply.status(refusal.status).send(refusal.body);
    }
    const body = createRiskAcceptanceSchema.parse(req.body);
    const out = await recordRiskAcceptanceTx(db, {
      riskId,
      responseType: body.responseType,
      rationale: body.rationale,
      compensatingControls: body.compensatingControls,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      actorUserId: req.authCtx.userId ?? null,
      origin: { kind: "register" },
    });
    if (!out.ok) return reply.status(out.status).send(out.body);
    const { acceptance, supersededId, band, maxExpiresAt } = out.recorded;
    return reply.status(201).send({
      acceptance: {
        ...summary(acceptance),
        rationale: acceptance.rationale,
        compensatingControls: acceptance.compensatingControls,
      },
      supersededId,
      band,
      maxExpiresAt: maxExpiresAt.toISOString(),
      note: "acceptance is a record, not a control — it lapses at its expiry and the risk reopens",
    });
  });
}
