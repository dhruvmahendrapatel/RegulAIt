/**
 * ADR-0080 amendment (batch B3) — THE USE-CASE DISPATCH GATE, the follow-up
 * ADR-0080 named out loud rather than shipping by implication ("approval
 * registers intent; it does not yet gate dispatch — the obvious next step").
 *
 * `org_settings.use_case_gate_mode` (migration 0098) arms it. ADR-0181
 * (migration 0158) made `enforce` the default; an admin may relax it on the
 * audited PUT /v1/org/settings:
 *
 *   off      approval registers intent and gates nothing. An unattributed
 *            dispatch does not even read the settings row here.
 *   warn     the dispatch proceeds; the refusal-shaped fact is recorded —
 *            an `use-case-gate-warned` audit row plus a `useCaseGate`
 *            annotation on the dispatch result. Nothing is blocked.
 *   enforce  a governed dispatch attributed to a project that at least one
 *            AI use case LINKS (`ai_use_cases.project_id`) is refused with a
 *            named 409 `use_case_approval_required` — audited, before any
 *            provider work, cost, or content processing: the exact ADR-0045
 *            gate shape — unless at least one linked use case is `approved`.
 *
 * THE HONEST JOIN, stated because it bounds what this gate can claim: use
 * cases reference a project OPTIONALLY (`projectId` is nullable — "a use case
 * may be proposed before any project exists for it"), and that column is the
 * ONLY join between the registry and dispatch attribution the schema holds.
 * So the gate applies exactly where a link EXISTS: a dispatch attributed to a
 * project no use case names, or attributed to no project at all, is untouched
 * in every mode. "Every dispatch runs under an approved use case" is NOT what
 * this enforces and must not be claimed of it — what it enforces is "a
 * project the register governs does not dispatch on unapproved intent".
 *
 * A use case that was approved and later retired reads status 'retired' and
 * therefore does NOT satisfy the gate — retirement takes the approval out of
 * service for dispatch exactly as it does for the register.
 */
import { aiUseCases, auditLog, eq, type Db } from "@regulait/db";
import { loadOrgSettings } from "./org-settings.js";

// ---------------------------------------------------------------------------
// B6b (ADR-0080 amendment, migration 0101) — THE ATTRIBUTION MANDATE
// ---------------------------------------------------------------------------

/**
 * The hole B3a recorded in its own amendment and could not close from inside
 * itself: *"nothing mandates that a dispatch be attributed to a linked project
 * at all — attribution stays the pillar-5 opt-in, so the gate cannot see a
 * call naming no project."* The use-case gate below binds only dispatches that
 * NAME a project; a caller who simply omits `projectId` walked past it.
 *
 * `org_settings.dispatch_attribution_required` is that mandate:
 *
 *   false  (an audited admin relaxation) an unattributed governed dispatch
 *          runs and its cost lands in the explicit "Unattributed" bucket
 *          (GET /v1/costs/unattributed), visible rather than hidden.
 *   true   (the ADR-0181 default) a governed dispatch that names NO `projectId` is refused 409
 *          `attribution_required`, audited, before ANY provider work, cost or
 *          content processing — the same rung, the same shape, as ADR-0045's
 *          MRM gate and the use-case gate beside it.
 *
 * THE COMPOSITION WITH `use_case_gate_mode`, stated because two knobs on one
 * rung invite a precedence question: **there is none, by construction.** This
 * gate acts only where `projectId IS NULL`; the use-case gate acts only where
 * it is NOT NULL (its first line returns for an unattributed call). The two
 * can therefore never see the same dispatch, and all four combinations are
 * exactly the union of their independent behaviours:
 *
 *   | attribution | use-case gate | projectless dispatch | attributed dispatch |
 *   |---|---|---|---|
 *   | off | off     | runs                     | runs                          |
 *   | off | enforce | runs (the B3a hole)      | gated on an approved use case |
 *   | on  | off     | 409 attribution_required | runs                          |
 *   | on  | enforce | 409 attribution_required | gated on an approved use case |
 *
 * Mandating attribution WITHOUT the use-case gate is a legitimate posture on
 * its own (chargeback completeness), which is why it is a separate knob and
 * not a mode of the other one.
 *
 * WHAT IT DOES NOT COVER, said plainly. It sits inside the one governed
 * model-dispatch path (`dispatchAttempt`), so it binds every caller of that —
 * the native invoke, both compat shims, conversations, the orchestration
 * worker loop, decompose's lead turn, the compaction summarizer, the copilot
 * narrator, evals/judges and the red-team runner. It does NOT bind the MCP
 * proxy's tool calls, which are not model dispatches and have their own
 * `interception_settings.require_mcp_attribution` (ADR-0024 O11, 400
 * `mcp_attribution_required`); nor does it replace
 * `interception_settings.require_project_attribution` (ADR-0020), which
 * refuses a header-less compat call 400 at the compat edge, upstream of here.
 * A deployment wanting attribution everywhere sets all three.
 */
export interface AttributionGateContext {
  userId: string;
  agentId: string;
  agentName: string;
  /** the pillar-5 attribution target of this dispatch; null = unattributed */
  projectId: string | null;
}

export type AttributionGateResult = {
  kind: "refuse";
  status: 409;
  error: "attribution_required";
  detail: string;
  auditLogId: string | null;
} | null;

export const ATTRIBUTION_REQUIRED_DETAIL =
  "this deployment requires every governed dispatch to be attributed to a project " +
  "(org setting 'dispatchAttributionRequired'), and this dispatch names none. Nothing was sent " +
  "to a provider and nothing was billed. Re-send with a projectId you are a member of — the " +
  "same field the cost dashboard, the project budget gate and the AI use-case gate all read.";

export async function attributionDispatchGate(
  db: Db,
  ctx: AttributionGateContext,
): Promise<AttributionGateResult> {
  // An ATTRIBUTED dispatch is what this gate exists to require, so it is the
  // free branch: returning before the settings read keeps it literally so.
  if (ctx.projectId) return null;
  const org = await loadOrgSettings(db);
  if (!org.dispatchAttributionRequired) return null;

  const [row] = await db
    .insert(auditLog)
    .values({
      userId: ctx.userId,
      objectType: "agent",
      objectId: ctx.agentId,
      detail: {
        phase: "dispatch",
        attributionRequired: true,
        agentId: ctx.agentId,
        agentName: ctx.agentName,
        projectId: null,
        receiptClass: "decision",
      },
      effect: "deny",
      ruleId: "attribution-required",
      ruleChain: [],
      reason: ATTRIBUTION_REQUIRED_DETAIL,
    })
    .returning({ id: auditLog.id });

  return {
    kind: "refuse",
    status: 409,
    error: "attribution_required",
    detail: ATTRIBUTION_REQUIRED_DETAIL,
    auditLogId: row?.id ?? null,
  };
}

export interface UseCaseGateContext {
  userId: string;
  agentId: string;
  agentName: string;
  /** the pillar-5 attribution target of this dispatch; null = unattributed */
  projectId: string | null;
}

/** the warn-mode annotation carried on the dispatch result — the
 * refusal-shaped fact, recorded rather than enforced */
export interface DispatchUseCaseGate {
  mode: "warn";
  projectId: string;
  linkedUseCases: Array<{ id: string; name: string; status: string; approvalExpired?: true }>;
  note: string;
}

export const USE_CASE_GATE_WARN_NOTE =
  "useCaseGateMode=warn — this dispatch would be REFUSED under enforce: the attributed project " +
  "is linked to AI use cases and none of them is approved. Recorded and annotated; nothing was " +
  "blocked. Approve a linked use case's intake on the one approvals queue, or set the gate to " +
  "enforce to make this a control.";

export type UseCaseGateResult =
  | { kind: "refuse"; status: 409; error: "use_case_approval_required"; detail: string; auditLogId: string | null }
  | { kind: "warn"; annotation: DispatchUseCaseGate }
  | null;

/**
 * The rung `dispatchAttempt` gains, placed beside the ADR-0045 MRM gate:
 * after the caller's entitlement decision, before ANY provider work. Returns
 * null when the dispatch may proceed unannotated, a warn annotation when the
 * fact is recorded, and an already-audited refusal under enforce.
 */
export async function useCaseDispatchGate(
  db: Db,
  ctx: UseCaseGateContext,
): Promise<UseCaseGateResult> {
  // Unattributed dispatch: no join exists, so no mode changes anything —
  // returning before the settings read keeps this branch literally free.
  if (!ctx.projectId) return null;
  const org = await loadOrgSettings(db);
  if (org.useCaseGateMode === "off") return null;

  const rows = await db
    .select({
      id: aiUseCases.id,
      name: aiUseCases.name,
      status: aiUseCases.status,
      approvedUntil: aiUseCases.approvedUntil,
    })
    .from(aiUseCases)
    .where(eq(aiUseCases.projectId, ctx.projectId));
  // the honest join: the gate applies only where a link EXISTS
  if (rows.length === 0) return null;
  // 'approved' is a decided, un-retired status — a retired use case reads
  // 'retired' and does not satisfy the gate. ADR-0170 §6: nor does an approval
  // whose lifetime has run out (the deploy gate's `approval_expired`), without
  // waiting for the recertification sweep to move it back into review. A NULL
  // `approvedUntil` (only a row migration 0133 could not backfill) is not
  // treated as expired.
  const nowMs = Date.now();
  const expired = (u: (typeof rows)[number]) =>
    u.status === "approved" && u.approvedUntil !== null && u.approvedUntil.getTime() <= nowMs;
  if (rows.some((u) => u.status === "approved" && !expired(u))) return null;
  const linked: DispatchUseCaseGate["linkedUseCases"] = rows.map((u) => ({
    id: u.id,
    name: u.name,
    status: u.status,
    ...(expired(u) ? { approvalExpired: true as const } : {}),
  }));

  const enforce = org.useCaseGateMode === "enforce";
  const roster = linked
    .map((u) => `'${u.name}' (${u.approvalExpired ? "approved, but the approval has expired" : u.status})`)
    .join(", ");
  const detail =
    `project ${ctx.projectId} is linked to ${linked.length} AI use case(s) — ${roster} — and ` +
    `none is approved. With useCaseGateMode=${org.useCaseGateMode}, a governed dispatch ` +
    `attributed to a use-case-linked project ${enforce ? "requires" : "would require"} at least ` +
    `one approved linked use case; the sign-off decision on the one approvals queue is what ` +
    `approves one.`;
  const [row] = await db
    .insert(auditLog)
    .values({
      userId: ctx.userId,
      objectType: "ai_use_case",
      objectId: null,
      detail: {
        phase: "dispatch",
        gateMode: org.useCaseGateMode,
        agentId: ctx.agentId,
        agentName: ctx.agentName,
        projectId: ctx.projectId,
        linkedUseCases: linked,
      },
      effect: enforce ? "deny" : "allow",
      ruleId: enforce ? "use-case-gate-refused" : "use-case-gate-warned",
      ruleChain: [],
      reason: detail,
    })
    .returning({ id: auditLog.id });

  if (enforce) {
    return {
      kind: "refuse",
      status: 409,
      error: "use_case_approval_required",
      detail,
      auditLogId: row?.id ?? null,
    };
  }
  return {
    kind: "warn",
    annotation: {
      mode: "warn",
      projectId: ctx.projectId,
      linkedUseCases: linked,
      note: USE_CASE_GATE_WARN_NOTE,
    },
  };
}
