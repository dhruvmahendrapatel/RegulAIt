/**
 * ADR-0333 §5 (slice 2) — the admin-configured response of a detection rule, run after the incident commits.
 *
 * Every response is deterministic and reuses an existing mechanism; nothing here is a new enforcement path:
 *   suspend_grant      revoke the group's delegation tree at its root (ADR-0188 `revokeDelegationGrant`, cascading)
 *   revoke_credential  revoke the acting identity's live short-lived access tokens (`issued_tokens`)
 *   require_approval   a user-scoped, all-servers approval rule for the sponsor, through the one approval-rule create
 *                      (`createApprovalRuleRow`), so every later MCP tool call goes through the Approvals Queue
 *
 * A response stronger than `alert` exists only in a pack that passed the `settings_relax` step-up (pack.ts
 * `packChangeIsRelaxation`). The author of that pack version is the acting admin and the approver. The outcome is
 * recorded on the incident (`response_state`, a fixed `response_error_code`) and audited; a failure is never retried
 * silently.
 */
import { and, auditLog, approvalRules, detectionIncidents, eq, isNull, sql, type Db } from "@regulait/db";
import { createApprovalRuleSchema } from "@regulait/shared";
import { DelegationRefusedError, revokeDelegationGrant } from "../delegation.js";
import { createApprovalRuleRow } from "../rule-creates.js";
import { ApprovalRuleWriteRefusedError } from "../approval-pool.js";
import type { DetectionResponse } from "./pack.js";
import { DETECTION_RESPONSE_MACHINE } from "@regulait/shared";
import { whereFrom } from "../state-transition.js";

export const DETECTION_RESPONSE_RULE_ID = "detection-response";

export type DetectionResponseCode =
  | "not_delegated"
  | "grant_not_found"
  | "no_actor_identity"
  | "no_sponsor"
  | "no_independent_approver"
  | "approval_rule_refused"
  | "response_error";

export interface DetectionResponseTarget {
  incidentId: string;
  ruleId: string;
  response: Exclude<DetectionResponse, "alert">;
  groupKey: string;
  /** the sponsor, when the user row still exists */
  userId: string | null;
  actorIdentityId: string | null;
  /** the admin who authored the active pack version (null for the built-in pack, which is alert-only) */
  packAuthor: string | null;
  /** the audit row's user when no sponsor or author resolves */
  auditUserId: string;
}

type Outcome = { ok: true; detail: Record<string, unknown> } | { ok: false; code: DetectionResponseCode };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function suspendGrant(db: Db, t: DetectionResponseTarget): Promise<Outcome> {
  const root = t.groupKey.startsWith("grant:") ? t.groupKey.slice("grant:".length) : null;
  if (!root || !UUID.test(root)) return { ok: false, code: "not_delegated" };
  try {
    const out = await revokeDelegationGrant(db, { grantId: root, reason: "admin", actorUserId: t.packAuthor });
    return { ok: true, detail: { rootGrantId: root, revokedGrants: out.revokedGrantIds.length } };
  } catch (err) {
    if (err instanceof DelegationRefusedError) return { ok: false, code: "grant_not_found" };
    throw err;
  }
}

async function revokeTokens(db: Db, t: DetectionResponseTarget): Promise<Outcome> {
  if (!t.actorIdentityId) return { ok: false, code: "no_actor_identity" };
  const revoked = await db.execute(sql`
    UPDATE issued_tokens SET revoked_at = GREATEST(now(), issued_at)
    WHERE subject_identity_id = ${t.actorIdentityId} AND revoked_at IS NULL AND expires_at > now()
    RETURNING jti`);
  return { ok: true, detail: { actorIdentityId: t.actorIdentityId, tokensRevoked: (revoked as unknown as { rows: unknown[] }).rows.length } };
}

async function requireApproval(db: Db, t: DetectionResponseTarget): Promise<Outcome> {
  if (!t.userId) return { ok: false, code: "no_sponsor" };
  // the approver pool never includes the requester (ADR-0186 A)
  if (!t.packAuthor || t.packAuthor === t.userId) return { ok: false, code: "no_independent_approver" };
  const sponsor = t.userId;
  const approver = t.packAuthor;
  try {
    return await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [existing] = await tx
        .select({ id: approvalRules.id })
        .from(approvalRules)
        .where(
          and(
            eq(approvalRules.scope, "user"),
            eq(approvalRules.serverScope, "all"),
            eq(approvalRules.userId, sponsor),
            isNull(approvalRules.toolName),
            eq(approvalRules.approverUserId, approver),
          ),
        )
        .limit(1);
      if (existing) return { ok: true, detail: { approvalRuleId: existing.id, existing: true } } as Outcome;
      const rule = createApprovalRuleSchema.parse({
        scope: "user",
        serverScope: "all",
        userId: sponsor,
        toolName: null,
        approvalScope: "action",
        approverUserId: approver,
        quorum: 1,
      });
      const row = await createApprovalRuleRow(tx, rule);
      return { ok: true, detail: { approvalRuleId: row.id, existing: false } } as Outcome;
    });
  } catch (err) {
    // the one create refuses an unsatisfiable pool or a pool takeover that needs its own step-up
    if (err instanceof ApprovalRuleWriteRefusedError) return { ok: false, code: "approval_rule_refused" };
    throw err;
  }
}

/** Run one incident's response, record the outcome on the incident and audit it. Never throws. */
export async function runDetectionResponse(db: Db, t: DetectionResponseTarget): Promise<"done" | "failed"> {
  let outcome: Outcome;
  try {
    outcome =
      t.response === "suspend_grant" ? await suspendGrant(db, t) : t.response === "revoke_credential" ? await revokeTokens(db, t) : await requireApproval(db, t);
  } catch {
    outcome = { ok: false, code: "response_error" };
  }
  const state = outcome.ok ? "done" : "failed";
  await db.transaction(async (tx) => {
    await tx
      .update(detectionIncidents)
      .set({ responseState: state, responseErrorCode: outcome.ok ? null : outcome.code })
      // ADR-0348 DETECTION_RESPONSE_MACHINE: a terminal response state is never overwritten
      .where(and(eq(detectionIncidents.id, t.incidentId), whereFrom(detectionIncidents.responseState, DETECTION_RESPONSE_MACHINE, outcome.ok ? "apply" : "fail")));
    await tx.insert(auditLog).values({
      userId: t.packAuthor ?? t.auditUserId,
      objectType: "detection_incident",
      objectId: t.incidentId,
      detail: {
        subsystem: "agent-detection",
        adr: "0333",
        rule: t.ruleId,
        response: t.response,
        outcome: state,
        ...(outcome.ok ? outcome.detail : { code: outcome.code }),
      },
      // a response that took effect restricted the agent; a failed one restricted nothing
      effect: outcome.ok ? "deny" : "allow",
      ruleId: DETECTION_RESPONSE_RULE_ID,
      ruleChain: [],
      reason: outcome.ok ? `Detection response ${t.response} applied` : `Detection response ${t.response} failed (${outcome.code})`,
    });
  });
  return state;
}
