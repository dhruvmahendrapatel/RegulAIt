/**
 * ADR-0080 amendment (batch B3) — THE USE-CASE DISPATCH GATE, the follow-up
 * ADR-0080 named out loud rather than shipping by implication ("approval
 * registers intent; it does not yet gate dispatch — the obvious next step").
 *
 * The org opt-in `org_settings.use_case_gate_mode` (migration 0098) arms it:
 *
 *   off      (default) BYTE-IDENTICAL to the shipped behaviour. An
 *            unattributed dispatch does not even read the settings row here.
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
  linkedUseCases: Array<{ id: string; name: string; status: string }>;
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

  const linked = await db
    .select({ id: aiUseCases.id, name: aiUseCases.name, status: aiUseCases.status })
    .from(aiUseCases)
    .where(eq(aiUseCases.projectId, ctx.projectId));
  // the honest join: the gate applies only where a link EXISTS
  if (linked.length === 0) return null;
  // 'approved' is a decided, un-retired status — a retired use case reads
  // 'retired' and does not satisfy the gate
  if (linked.some((u) => u.status === "approved")) return null;

  const enforce = org.useCaseGateMode === "enforce";
  const roster = linked.map((u) => `'${u.name}' (${u.status})`).join(", ");
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
