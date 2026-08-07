/**
 * ADR-0045 — the GATEWAY half of the MODEL RISK MANAGEMENT registry.
 *
 *   `packages/shared/src/mrm.ts`  the effective-status computation, the
 *                                 completeness assessment, and the gate
 *                                 decision. Pure — no db, no clock, no provider.
 *   THIS FILE                     persistence, the admin API, the sign-off that
 *                                 rides the ONE Approvals Queue, the expiry
 *                                 sweep, the evidence links, and the audit rows.
 *   `agents-connectors.ts`        calls `mrmDispatchGate` inside
 *                                 `executeGovernedDispatch`, after entitlement
 *                                 and before any provider work.
 *
 * TWO PROPERTIES THIS FILE EXISTS TO GUARANTEE
 *
 *  1. THERE IS NO SECOND APPROVALS QUEUE. A sign-off request INSERTs into the
 *     one `approvals` table with `objectType: 'model_card'`, and the decision
 *     comes back through the one `POST /v1/approvals/:id/decide` endpoint —
 *     with its separation-of-duties guards, its delegation window, its admin
 *     override, and its audit rows — via `applyModelCardApprovalDecision`
 *     below. Nothing here decides anything on its own.
 *
 *  2. EXPIRY IS ENFORCED, NOT DECORATIVE. `mrmDispatchGate` recomputes
 *     `validUntil < now` on every call. The `expired` STATUS in the database is
 *     a cache the sweep refreshes for display and for the queue; the gate never
 *     reads it. So a deployment that never runs the sweep still stops
 *     dispatching under a lapsed risk acceptance. ADR-0064 later added an
 *     in-process scheduler that CAN drive the sweep — and this property is
 *     precisely what makes that addition safe: turning the scheduler on buys
 *     timeliness of the displayed status, never the enforcement itself, and
 *     turning it off cannot un-enforce anything.
 *
 * WHAT THIS FILE DOES NOT DO — stated here because a governance product that
 * overstates itself is worse than one that ships less: it does not MEASURE bias
 * or fairness. It records declared assessments, tracks their absence, and links
 * evidence (an ADR-0044 eval run, or an external report). No code path here
 * evaluates a model for fairness, and none should be read as if it did.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  agents,
  and,
  approvals,
  asc,
  auditLog,
  customModelProviders,
  desc,
  eq,
  evalResults,
  evalRuns,
  inArray,
  lte,
  modelCardApprovals,
  modelCardEvidence,
  modelCards,
  ne,
  orgSettings,
  users,
  type Db,
  type ModelCardApprovalRow,
  type ModelCardRow,
} from "@regulait/db";
import {
  assessCardCompleteness,
  attachModelCardEvidenceSchema,
  cardState,
  createModelCardSchema,
  daysUntilExpiry,
  effectiveApprovalStatus,
  evaluateMrmGate,
  mrmPosture,
  requestModelCardSignOffSchema,
  revokeModelCardApprovalSchema,
  updateModelCardSchema,
  type BiasFairnessEntryInput,
  type MrmGateCard,
  type MrmGateDecision,
} from "@regulait/shared";
import { loadOrgSettings } from "./org-settings.js";
import { summarizeGroundedness } from "./evals.js";

const ORG_SETTINGS_ID = "singleton";
/** the audit row's actor when the caller is the identity-less bootstrap token —
 * the same sentinel org-settings.ts uses, so "who did this" stays one idiom */
const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";

// ---------------------------------------------------------------------------
// Loading a model's cards
// ---------------------------------------------------------------------------

/** every card + sign-off chain for ONE model subject, newest sign-off first */
export async function loadCardsForSubject(
  db: Db,
  subject: { agentId?: string | null; customProviderId?: string | null },
): Promise<MrmGateCard[]> {
  const where = subject.agentId
    ? eq(modelCards.agentId, subject.agentId)
    : subject.customProviderId
      ? eq(modelCards.customProviderId, subject.customProviderId)
      : null;
  if (!where) return [];
  const cards = await db.select().from(modelCards).where(where);
  if (cards.length === 0) return [];
  const chain = await db
    .select()
    .from(modelCardApprovals)
    .where(
      inArray(
        modelCardApprovals.cardId,
        cards.map((c) => c.id),
      ),
    )
    .orderBy(desc(modelCardApprovals.requestedAt));
  return cards.map((c) => ({
    id: c.id,
    intendedUse: c.intendedUse,
    approvals: chain
      .filter((a) => a.cardId === c.id)
      .map((a) => ({ id: a.id, status: a.status, validUntil: a.validUntil })),
  }));
}

// ---------------------------------------------------------------------------
// THE DISPATCH GATE
// ---------------------------------------------------------------------------

export interface MrmGateContext {
  userId: string;
  agentId: string;
  agentName: string;
  model: string | null;
  customProviderId: string | null;
  projectId?: string | null;
}

/**
 * The rung `executeGovernedDispatch` gains. Returns null when the dispatch may
 * proceed; a refusal object (already audited) when it may not.
 *
 * The org toggle is read FIRST and short-circuits: with `mrmEnforced` false
 * this costs one settings read and nothing else changes — the byte-identical
 * default ADR-0045 §4 promises.
 */
export async function mrmDispatchGate(
  db: Db,
  ctx: MrmGateContext,
  now: Date = new Date(),
): Promise<{ status: number; error: string; detail: string } | null> {
  const org = await loadOrgSettings(db);
  if (!org.mrmEnforced) return null;

  const cards = await loadCardsForSubject(db, {
    agentId: ctx.agentId,
    customProviderId: null,
  });
  // A custom-provider-backed agent is governed by EITHER a card on the agent or
  // a card on the endpoint — the same model reached two ways is one risk
  // position if the operator chose to record it at the endpoint level.
  const providerCards = ctx.customProviderId
    ? await loadCardsForSubject(db, { customProviderId: ctx.customProviderId })
    : [];
  const decision = evaluateMrmGate({
    enforced: true,
    cards: [...cards, ...providerCards],
    now,
  });
  if (decision.allowed) return null;

  await db.insert(auditLog).values({
    userId: ctx.userId,
    objectType: "model_card",
    objectId: decision.cardId,
    detail: {
      phase: "dispatch",
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      model: ctx.model,
      customProviderId: ctx.customProviderId,
      mrmReason: decision.reason,
      modelCardId: decision.cardId,
      modelCardApprovalId: decision.approvalId,
      validUntil: decision.validUntil,
      ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
    },
    effect: "deny",
    ruleId: decision.ruleId,
    ruleChain: [],
    reason: decision.detail,
  });
  return {
    status: 409,
    // ONE stable error code for every MRM refusal — the caller's remediation is
    // the same ("get this model reviewed / recertified"); the audit trail's
    // ruleId is where the three cases are distinguishable.
    error: "mrm_approval_required",
    detail: decision.detail,
  };
}

// ---------------------------------------------------------------------------
// The decide hook — called from the ONE approvals decide path
// ---------------------------------------------------------------------------

/**
 * ADR-0045 §3: the sign-off decision arrives through
 * `POST /v1/approvals/:approvalId/decide`, which has already applied every
 * separation-of-duties guard the queue applies to anything else. This function
 * only translates that decision onto the MRM chain.
 *
 * On APPROVE: the record becomes `approved` and (if it was a recertification)
 * the record it supersedes becomes `superseded` — the previous risk acceptance
 * is never deleted or rewritten, so the chain stays readable.
 * On DENY: the record becomes `denied`. It does NOT become `revoked`: a refused
 * request and a withdrawn acceptance are different facts.
 */
export async function applyModelCardApprovalDecision(
  tx: Db,
  approvalRow: { id: string; decisionReason: string | null },
  decision: "approved" | "denied",
  deciderUserId: string,
): Promise<void> {
  const [record] = await tx
    .select()
    .from(modelCardApprovals)
    .where(eq(modelCardApprovals.approvalId, approvalRow.id));
  if (!record || record.status !== "pending") return;

  const [updated] = await tx
    .update(modelCardApprovals)
    .set({
      status: decision === "approved" ? "approved" : "denied",
      decidedBy: deciderUserId,
      decidedAt: new Date(),
      decisionReason: approvalRow.decisionReason ?? null,
    })
    .where(and(eq(modelCardApprovals.id, record.id), eq(modelCardApprovals.status, "pending")))
    .returning();
  if (!updated) return;

  if (decision === "approved" && updated.supersedesId) {
    await tx
      .update(modelCardApprovals)
      .set({ status: "superseded" })
      .where(
        and(
          eq(modelCardApprovals.id, updated.supersedesId),
          eq(modelCardApprovals.status, "approved"),
        ),
      );
  }

  await tx.insert(auditLog).values({
    userId: deciderUserId,
    objectType: "model_card",
    objectId: updated.cardId,
    detail: {
      phase: "sign_off",
      modelCardApprovalId: updated.id,
      approvalId: approvalRow.id,
      decision,
      validUntil: updated.validUntil?.toISOString() ?? null,
      supersedesId: updated.supersedesId,
    },
    effect: decision === "approved" ? "allow" : "deny",
    ruleId: decision === "approved" ? "mrm-sign-off-approved" : "mrm-sign-off-denied",
    ruleChain: [],
    reason:
      decision === "approved"
        ? `model-card risk sign-off accepted${updated.validUntil ? `, valid until ${updated.validUntil.toISOString()}` : " with NO expiry (explicitly acknowledged)"}`
        : "model-card risk sign-off refused",
  });
}

// ---------------------------------------------------------------------------
// The expiry sweep
// ---------------------------------------------------------------------------

export const MRM_EXPIRY_SWEEP_NOTE =
  "This refreshes the STORED status of lapsed sign-offs. It is a display/consistency job, not a " +
  "control: dispatch enforcement recomputes expiry from validUntil on every call, so a lapse blocks " +
  "whether or not this has run. ADR-0064's scheduler drives it when switched on (REGULAIT_SCHEDULER=on); " +
  "this endpoint calls exactly the same function on demand.";

/**
 * Flip every lapsed `approved` record to `expired` and audit each flip.
 *
 * READ THIS BEFORE TRUSTING IT: ENFORCEMENT DOES NOT DEPEND ON THIS FUNCTION.
 * `mrmDispatchGate` recomputes expiry from `validUntil` on every dispatch, so a
 * lapse blocks whether or not this has ever run. That split is deliberate and
 * did not change when ADR-0064 gave the sweep a real driver: the sweep is a
 * display/consistency job, the gate is the control.
 *
 * Two things call this, and they call THIS, not a copy: the ADR-0064
 * `mrm-expiry-sweep` job (when REGULAIT_SCHEDULER=on, which is OFF by default)
 * and `POST /v1/mrm/expiry-sweep`, which remains the manual/cron door.
 */
export async function runMrmExpirySweep(
  db: Db,
  opts: { actorUserId: string | null; now?: Date } = { actorUserId: null },
): Promise<{ expired: number; ids: string[] }> {
  const now = opts.now ?? new Date();
  const lapsed = await db
    .select()
    .from(modelCardApprovals)
    .where(
      and(
        eq(modelCardApprovals.status, "approved"),
        lte(modelCardApprovals.validUntil, now),
      ),
    );
  const ids: string[] = [];
  for (const row of lapsed) {
    const [flipped] = await db
      .update(modelCardApprovals)
      .set({ status: "expired" })
      .where(and(eq(modelCardApprovals.id, row.id), eq(modelCardApprovals.status, "approved")))
      .returning();
    if (!flipped) continue;
    ids.push(flipped.id);
    await db.insert(auditLog).values({
      userId: opts.actorUserId ?? flipped.approverUserId,
      objectType: "model_card",
      objectId: flipped.cardId,
      detail: {
        phase: "expiry_sweep",
        modelCardApprovalId: flipped.id,
        validUntil: flipped.validUntil?.toISOString() ?? null,
        sweptBy: opts.actorUserId,
      },
      effect: "deny",
      ruleId: "mrm-approval-expired-swept",
      ruleChain: [],
      reason: `model-card risk sign-off lapsed at ${flipped.validUntil?.toISOString() ?? "an unset date"} and was marked expired`,
    });
  }
  return { expired: ids.length, ids };
}

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------

const idParam = z.object({ id: z.string().uuid() });
const evidenceParam = z.object({ id: z.string().uuid(), evidenceId: z.string().uuid() });

async function cardView(db: Db, card: ModelCardRow, now: Date, warnDays: number) {
  const chain = await db
    .select()
    .from(modelCardApprovals)
    .where(eq(modelCardApprovals.cardId, card.id))
    .orderBy(desc(modelCardApprovals.requestedAt));
  const evidenceRows = await db
    .select()
    .from(modelCardEvidence)
    .where(eq(modelCardEvidence.cardId, card.id))
    .orderBy(asc(modelCardEvidence.attachedAt));
  // ADR-0067 — A MODEL CARD THAT CITES AN EVAL RUN NOW CARRIES ITS
  // GROUNDEDNESS FIGURES. "Hallucination rate" is the number a regulated
  // reviewer looks for on a model card, and before this it was measurable but
  // not readable from the artifact the sign-off actually rests on. The
  // `method` field on every metric says whether a MODEL judged it or a lexical
  // method estimated it — a card must never let those two be confused.
  const evidence = await Promise.all(
    evidenceRows.map(async (e) => {
      if (!e.evalRunId) return { ...e, groundedness: null };
      const results = await db
        .select()
        .from(evalResults)
        .where(eq(evalResults.runId, e.evalRunId));
      return { ...e, groundedness: summarizeGroundedness(results) };
    }),
  );
  const state = cardState(chain, now, warnDays);
  return {
    ...card,
    approvals: chain.map((a) => ({
      ...a,
      effectiveStatus: effectiveApprovalStatus(a, now),
      daysUntilExpiry: daysUntilExpiry(a, now),
    })),
    evidence,
    state: state.state,
    daysUntilExpiry: state.daysLeft,
    completeness: assessCardCompleteness({
      intendedUse: card.intendedUse,
      limitations: card.limitations,
      dataClaims: card.dataClaims,
      biasFairness: (card.biasFairness ?? []) as BiasFairnessEntryInput[],
      standardRefs: card.standardRefs,
      evidenceCount: evidence.length,
    }),
  };
}

export function registerMrmRoutes(app: FastifyInstance, db: Db) {
  /** the posture + the counts an admin screen leads with. The `posture` field
   * is computed, never stored — the UI must not be able to claim an assurance
   * the toggle does not back (ADR-0024's honesty rule, reused). */
  app.get("/v1/mrm/status", async () => {
    const org = await loadOrgSettings(db);
    const now = new Date();
    const cards = await db.select().from(modelCards);
    const chain = await db.select().from(modelCardApprovals);
    const byCard = new Map<string, ModelCardApprovalRow[]>();
    for (const a of chain) byCard.set(a.cardId, [...(byCard.get(a.cardId) ?? []), a]);
    const states = cards.map((c) => cardState(byCard.get(c.id) ?? [], now, org.mrmExpiryWarnDays));
    const count = (s: string) => states.filter((x) => x.state === s).length;
    const approvedCount = count("approved") + count("expiring");
    return {
      enforced: org.mrmEnforced,
      warnDays: org.mrmExpiryWarnDays,
      ...mrmPosture({ enforced: org.mrmEnforced, cardCount: cards.length, approvedCount }),
      cards: cards.length,
      approved: count("approved"),
      expiring: count("expiring"),
      expired: count("expired"),
      pending: count("pending"),
      unsigned: count("unsigned"),
      revoked: count("revoked"),
      note:
        "Bias/fairness here is a RECORDED DECLARATION, not a measurement — RegulAIt does not run " +
        "fairness tests. Expiry is ENFORCED AT DISPATCH by recomputing validUntil, never by a " +
        "background job. ADR-0064's scheduler keeps the STORED statuses truthful when it is switched " +
        "on, and POST /v1/mrm/expiry-sweep does the same on demand; a deployment running neither " +
        "still refuses a lapsed card at dispatch.",
    };
  });

  app.get("/v1/mrm/cards", async () => {
    const org = await loadOrgSettings(db);
    const now = new Date();
    const rows = await db.select().from(modelCards).orderBy(desc(modelCards.createdAt));
    const agentRows = await db.select({ id: agents.id, name: agents.name, model: agents.model }).from(agents);
    const providerRows = await db
      .select({ id: customModelProviders.id, name: customModelProviders.name })
      .from(customModelProviders);
    const agentName = new Map(agentRows.map((a) => [a.id, a.name]));
    const agentModel = new Map(agentRows.map((a) => [a.id, a.model]));
    const providerName = new Map(providerRows.map((p) => [p.id, p.name]));
    const cards = [];
    for (const row of rows) {
      const view = await cardView(db, row, now, org.mrmExpiryWarnDays);
      cards.push({
        ...view,
        subjectKind: row.agentId ? "agent" : "custom_provider",
        subjectName: row.agentId
          ? (agentName.get(row.agentId) ?? null)
          : (providerName.get(row.customProviderId ?? "") ?? null),
        subjectModel: row.agentId ? (agentModel.get(row.agentId) ?? null) : null,
      });
    }
    return { cards, enforced: org.mrmEnforced };
  });

  app.get("/v1/mrm/cards/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const org = await loadOrgSettings(db);
    const [row] = await db.select().from(modelCards).where(eq(modelCards.id, id));
    if (!row) return reply.status(404).send({ error: "unknown_model_card" });
    return { card: await cardView(db, row, new Date(), org.mrmExpiryWarnDays) };
  });

  app.post("/v1/mrm/cards", async (req, reply) => {
    const body = createModelCardSchema.parse(req.body);
    if (body.agentId) {
      const [a] = await db.select({ id: agents.id }).from(agents).where(eq(agents.id, body.agentId));
      if (!a) return reply.status(404).send({ error: "unknown_agent" });
    } else if (body.customProviderId) {
      const [p] = await db
        .select({ id: customModelProviders.id })
        .from(customModelProviders)
        .where(eq(customModelProviders.id, body.customProviderId));
      if (!p) return reply.status(404).send({ error: "unknown_custom_provider" });
    }
    const [existing] = await db
      .select({ id: modelCards.id })
      .from(modelCards)
      .where(
        and(
          body.agentId ? eq(modelCards.agentId, body.agentId) : eq(modelCards.customProviderId, body.customProviderId!),
          eq(modelCards.intendedUse, body.intendedUse),
        ),
      );
    if (existing) {
      return reply.status(409).send({
        error: "model_card_exists",
        detail:
          "a card already records a risk position on this model for this intended use — edit it, or " +
          "author a card for a DIFFERENT intended use",
      });
    }
    const [row] = await db
      .insert(modelCards)
      .values({
        agentId: body.agentId ?? null,
        customProviderId: body.customProviderId ?? null,
        intendedUse: body.intendedUse,
        dataClaims: body.dataClaims,
        limitations: body.limitations ?? null,
        biasFairness: body.biasFairness,
        standardRefs: body.standardRefs,
        note: body.note ?? null,
        createdByUserId: req.authCtx.userId ?? null,
      })
      .returning();
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? NO_IDENTITY,
      objectType: "model_card",
      objectId: row!.id,
      detail: {
        phase: "authoring",
        action: "create",
        agentId: row!.agentId,
        customProviderId: row!.customProviderId,
        intendedUse: row!.intendedUse,
        standardRefs: row!.standardRefs,
      },
      effect: "allow",
      ruleId: "mrm-card-created",
      ruleChain: [],
      reason: `model card authored for intended use '${row!.intendedUse}' — a card enforces NOTHING until it carries an approved sign-off`,
    });
    const org = await loadOrgSettings(db);
    return reply.status(201).send({ card: await cardView(db, row!, new Date(), org.mrmExpiryWarnDays) });
  });

  app.patch("/v1/mrm/cards/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = updateModelCardSchema.parse(req.body);
    const [row] = await db.select().from(modelCards).where(eq(modelCards.id, id));
    if (!row) return reply.status(404).send({ error: "unknown_model_card" });
    const [updated] = await db
      .update(modelCards)
      .set({
        ...(body.intendedUse !== undefined ? { intendedUse: body.intendedUse } : {}),
        ...(body.dataClaims !== undefined ? { dataClaims: body.dataClaims } : {}),
        ...(body.limitations !== undefined ? { limitations: body.limitations ?? null } : {}),
        ...(body.biasFairness !== undefined ? { biasFairness: body.biasFairness } : {}),
        ...(body.standardRefs !== undefined ? { standardRefs: body.standardRefs } : {}),
        ...(body.note !== undefined ? { note: body.note ?? null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(modelCards.id, id))
      .returning();
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? NO_IDENTITY,
      objectType: "model_card",
      objectId: id,
      detail: { phase: "authoring", action: "update", fields: Object.keys(body) },
      effect: "allow",
      ruleId: "mrm-card-updated",
      ruleChain: [],
      reason: "model card edited",
    });
    const org = await loadOrgSettings(db);
    return { card: await cardView(db, updated!, new Date(), org.mrmExpiryWarnDays) };
  });

  app.delete("/v1/mrm/cards/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [row] = await db.select().from(modelCards).where(eq(modelCards.id, id));
    if (!row) return reply.status(404).send({ error: "unknown_model_card" });
    await db.delete(modelCards).where(eq(modelCards.id, id));
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? NO_IDENTITY,
      objectType: "model_card",
      objectId: id,
      detail: { phase: "authoring", action: "delete", intendedUse: row.intendedUse },
      effect: "deny",
      ruleId: "mrm-card-deleted",
      ruleChain: [],
      reason: "model card deleted — with mrmEnforced on, this model becomes undispatchable unless another card covers it",
    });
    return { deleted: true };
  });

  /**
   * THE SIGN-OFF REQUEST. It creates a row in the ONE `approvals` table, and
   * NOTHING here decides it — the decision comes back through
   * `POST /v1/approvals/:approvalId/decide` like every other approval in the
   * product. If this endpoint ever grows a decide path, the "exactly one
   * approvals inbox" invariant is broken.
   *
   * A request while an approved sign-off is live is a RECERTIFICATION: it
   * records `supersedesId`, and the old acceptance is superseded only when the
   * new one is granted — so there is never a window with no risk position.
   */
  app.post("/v1/mrm/cards/:id/sign-off", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = requestModelCardSignOffSchema.parse(req.body);
    const [card] = await db.select().from(modelCards).where(eq(modelCards.id, id));
    if (!card) return reply.status(404).send({ error: "unknown_model_card" });
    const [approver] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, body.approverUserId));
    if (!approver) return reply.status(404).send({ error: "unknown_approver" });

    const now = new Date();
    const chain = await db
      .select()
      .from(modelCardApprovals)
      .where(eq(modelCardApprovals.cardId, id))
      .orderBy(desc(modelCardApprovals.requestedAt));
    if (chain.some((a) => a.status === "pending")) {
      return reply.status(409).send({
        error: "sign_off_already_pending",
        detail: "this card already has a live sign-off request in the Approvals Queue",
      });
    }
    const validUntil = body.validUntil ? new Date(body.validUntil) : null;
    if (validUntil && validUntil.getTime() <= now.getTime()) {
      return reply.status(422).send({
        error: "valid_until_in_past",
        detail: "a recertification date in the past would create an already-lapsed sign-off",
      });
    }
    const superseding = chain.find((a) => a.status === "approved") ?? null;

    const created = await db.transaction(async (tx) => {
      const [queued] = await tx
        .insert(approvals)
        .values({
          // `approvals.userId` is "who the decision is about" and carries an FK
          // to users, so the NO_IDENTITY sentinel is NOT usable here. A
          // bootstrap-token request records the approver as the subject —
          // truthful (there is no other identity in play) and referentially
          // valid, which the sentinel would not be.
          userId: req.authCtx.userId ?? body.approverUserId,
          objectType: "model_card",
          approverUserId: body.approverUserId,
          // the queue's generic linking columns: `stageId` carries the card id
          // so the inbox can label the row without a new column on `approvals`
          stageId: `__model_card__:${card.id}`,
          status: "pending",
        })
        .returning();
      const [record] = await tx
        .insert(modelCardApprovals)
        .values({
          cardId: card.id,
          status: "pending",
          approverUserId: body.approverUserId,
          requestedByUserId: req.authCtx.userId ?? null,
          approvalId: queued!.id,
          validUntil,
          supersedesId: superseding?.id ?? null,
        })
        .returning();
      await tx.insert(auditLog).values({
        userId: req.authCtx.userId ?? NO_IDENTITY,
        objectType: "model_card",
        objectId: card.id,
        detail: {
          phase: "sign_off",
          action: "requested",
          modelCardApprovalId: record!.id,
          approvalId: queued!.id,
          approverUserId: body.approverUserId,
          validUntil: validUntil?.toISOString() ?? null,
          recertificationOf: superseding?.id ?? null,
        },
        effect: "allow",
        ruleId: "mrm-sign-off-requested",
        ruleChain: [],
        reason:
          (superseding ? "recertification" : "initial") +
          ` risk sign-off requested for model card '${card.intendedUse}'` +
          (body.reason ? `: ${body.reason}` : ""),
      });
      return { queued: queued!, record: record! };
    });

    return reply.status(201).send({
      signOff: created.record,
      approvalId: created.queued.id,
      note: "queued in the ONE Approvals Queue — decide it at POST /v1/approvals/:approvalId/decide",
    });
  });

  /** withdraw a granted acceptance. Distinct from a DENIED request: this is an
   * acceptance that existed and was taken back, and with mrmEnforced on it
   * stops dispatch immediately. */
  app.post("/v1/mrm/cards/:id/revoke", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = revokeModelCardApprovalSchema.parse(req.body);
    const [card] = await db.select().from(modelCards).where(eq(modelCards.id, id));
    if (!card) return reply.status(404).send({ error: "unknown_model_card" });
    const rows = await db
      .update(modelCardApprovals)
      .set({
        status: "revoked",
        decidedBy: req.authCtx.userId ?? null,
        decidedAt: new Date(),
        decisionReason: body.reason,
      })
      .where(and(eq(modelCardApprovals.cardId, id), eq(modelCardApprovals.status, "approved")))
      .returning();
    if (rows.length === 0) {
      return reply.status(409).send({ error: "no_approved_sign_off", detail: "this card carries no live sign-off to revoke" });
    }
    for (const row of rows) {
      await db.insert(auditLog).values({
        userId: req.authCtx.userId ?? NO_IDENTITY,
        objectType: "model_card",
        objectId: id,
        detail: { phase: "sign_off", action: "revoked", modelCardApprovalId: row.id },
        effect: "deny",
        ruleId: "mrm-sign-off-revoked",
        ruleChain: [],
        reason: `model-card risk sign-off revoked: ${body.reason}`,
      });
    }
    return { revoked: rows.length };
  });

  /** ADR-0045 §5 — attach the MEASURED evidence (an ADR-0044 eval run) or an
   * external report. The eval-run FK is RESTRICT, so cited evidence cannot be
   * deleted out from under the decision that rests on it. */
  app.post("/v1/mrm/cards/:id/evidence", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = attachModelCardEvidenceSchema.parse(req.body);
    const [card] = await db.select().from(modelCards).where(eq(modelCards.id, id));
    if (!card) return reply.status(404).send({ error: "unknown_model_card" });
    if (body.kind === "eval_run") {
      const [run] = await db.select().from(evalRuns).where(eq(evalRuns.id, body.evalRunId!));
      if (!run) return reply.status(404).send({ error: "unknown_eval_run" });
      const [dupe] = await db
        .select({ id: modelCardEvidence.id })
        .from(modelCardEvidence)
        .where(and(eq(modelCardEvidence.cardId, id), eq(modelCardEvidence.evalRunId, body.evalRunId!)));
      if (dupe) return reply.status(409).send({ error: "evidence_already_attached" });
    }
    const [row] = await db
      .insert(modelCardEvidence)
      .values({
        cardId: id,
        kind: body.kind,
        evalRunId: body.kind === "eval_run" ? body.evalRunId! : null,
        externalRef: body.kind === "external" ? body.externalRef! : null,
        label: body.label ?? null,
        note: body.note ?? null,
        attachedByUserId: req.authCtx.userId ?? null,
      })
      .returning();
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? NO_IDENTITY,
      objectType: "model_card",
      objectId: id,
      detail: {
        phase: "evidence",
        action: "attached",
        evidenceId: row!.id,
        kind: row!.kind,
        evalRunId: row!.evalRunId,
        externalRef: row!.externalRef,
      },
      effect: "allow",
      ruleId: "mrm-evidence-attached",
      ruleChain: [],
      reason:
        row!.kind === "eval_run"
          ? "an ADR-0044 eval run was attached as measured evidence behind this risk position"
          : "an external report was referenced as evidence behind this risk position",
    });
    return reply.status(201).send({ evidence: row });
  });

  app.delete("/v1/mrm/cards/:id/evidence/:evidenceId", async (req, reply) => {
    const { id, evidenceId } = evidenceParam.parse(req.params);
    const [row] = await db
      .select()
      .from(modelCardEvidence)
      .where(and(eq(modelCardEvidence.id, evidenceId), eq(modelCardEvidence.cardId, id)));
    if (!row) return reply.status(404).send({ error: "unknown_evidence" });
    await db.delete(modelCardEvidence).where(eq(modelCardEvidence.id, evidenceId));
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? NO_IDENTITY,
      objectType: "model_card",
      objectId: id,
      detail: { phase: "evidence", action: "detached", evidenceId, evalRunId: row.evalRunId },
      effect: "deny",
      ruleId: "mrm-evidence-detached",
      ruleChain: [],
      reason: "evidence detached from a model card",
    });
    return { deleted: true };
  });

  /**
   * The sweep, as an ENDPOINT. ADR-0064's scheduler drives the SAME function
   * when it is switched on; this stays the manual/on-demand door. Enforcement
   * does not depend on either having run.
   */
  app.post("/v1/mrm/expiry-sweep", async (req) => {
    const result = await runMrmExpirySweep(db, { actorUserId: req.authCtx.userId ?? null });
    return {
      ...result,
      note: MRM_EXPIRY_SWEEP_NOTE,
    };
  });

  /** the expiring/lapsed worklist — what ADR-0045 wants surfaced as WORK ahead
   * of the outage, rather than discovered at the moment of the refusal */
  app.get("/v1/mrm/expiring", async () => {
    const org = await loadOrgSettings(db);
    const now = new Date();
    const rows = await db
      .select()
      .from(modelCardApprovals)
      .where(
        and(
          inArray(modelCardApprovals.status, ["approved", "expired"]),
          ne(modelCardApprovals.status, "revoked"),
        ),
      )
      .orderBy(asc(modelCardApprovals.validUntil));
    const cards = await db.select().from(modelCards);
    const cardById = new Map(cards.map((c) => [c.id, c]));
    const items = rows
      .map((r) => ({
        ...r,
        effectiveStatus: effectiveApprovalStatus(r, now),
        daysUntilExpiry: daysUntilExpiry(r, now),
        intendedUse: cardById.get(r.cardId)?.intendedUse ?? null,
      }))
      .filter(
        (r) =>
          r.effectiveStatus === "expired" ||
          (r.daysUntilExpiry !== null && r.daysUntilExpiry <= org.mrmExpiryWarnDays),
      );
    return { warnDays: org.mrmExpiryWarnDays, items };
  });

  /** the toggle. Its own endpoint rather than a field on the big org-settings
   * PUT, because turning it on can hard-stop production and the act deserves
   * its own audit row. */
  app.post("/v1/mrm/enforcement", async (req, reply) => {
    const body = z.object({ enforced: z.boolean(), warnDays: z.number().int().min(0).max(3650).optional() }).parse(req.body);
    const org = await loadOrgSettings(db);
    const [updated] = await db
      .update(orgSettings)
      .set({
        mrmEnforced: body.enforced,
        ...(body.warnDays !== undefined ? { mrmExpiryWarnDays: body.warnDays } : {}),
        updatedBy: req.authCtx.userId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(orgSettings.id, ORG_SETTINGS_ID))
      .returning();
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? NO_IDENTITY,
      objectType: "org_settings",
      objectId: null,
      detail: { phase: "mrm", from: org.mrmEnforced, to: body.enforced, warnDays: updated!.mrmExpiryWarnDays },
      effect: body.enforced ? "deny" : "allow",
      ruleId: body.enforced ? "mrm-enforcement-enabled" : "mrm-enforcement-disabled",
      ruleChain: [],
      reason: body.enforced
        ? "mrmEnforced ON — dispatch of a model with no unexpired approved card is now REFUSED"
        : "mrmEnforced OFF — model cards are recorded but no dispatch is refused",
    });
    if (!updated) return reply.status(500).send({ error: "org_settings_missing" });
    return { enforced: updated.mrmEnforced, warnDays: updated.mrmExpiryWarnDays };
  });
}

export type { MrmGateDecision };
