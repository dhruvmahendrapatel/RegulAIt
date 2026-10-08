/**
 * B8c (ADR-0056 amendment 2026-08-22) — THE ONE APPROVAL-RULE CREATE.
 *
 * `POST /v1/rules/approvals` used to hold this insert inline. The copilot's
 * consent-gated applier (ADR-0056 L6b) must execute a `rule_to_approval`
 * proposal through EXACTLY the create an admin would use by hand — never a
 * parallel insert with its own semantics — so the create moved here and both
 * callers now share it, on the exact pattern `grant-revocation.ts` set for
 * grant removals:
 *
 *   - the admin `POST /v1/rules/approvals` route calls this function
 *     (same behaviour, byte-identical response row);
 *   - the copilot applier calls the same function after running the SAME
 *     `createApprovalRuleSchema` the route parses with, so the applier can
 *     never create a row the route would have refused.
 *
 * There is deliberately nothing else in here: no audit writes (each caller
 * audits as itself — the route today writes none; the applier writes its
 * `copilot-proposal-applied` row), and no versioning hook. A brand-new row
 * with a `defaultRandom()` id and no ON CONFLICT cannot have a
 * `config_versions` row at the instant it is written, so the raw row is what
 * the kernel serves (the same ADR-0074 reasoning the create routes have
 * always carried; see `rule-write-guard.test.ts`).
 */
import { approvalRules } from "@regulait/db";
import type { DbOrTx, DbOrTxDeep } from "./config-versions.js";
import type { z } from "zod";
import type { createApprovalRuleSchema } from "@regulait/shared";
import { assertApprovalRuleWritable } from "./approval-pool.js";

export type CreateApprovalRuleInput = z.infer<typeof createApprovalRuleSchema>;

/** PILLAR 1 rule scoping: null out every off-scope subject/server field so the
 * row is clean and the DB CHECK always passes — a role-scoped rule stores only
 * roleId, a fleet rule stores none, an all-servers rule stores no serverId.
 * (Moved here from app.ts with the approvals create; the data-scope and
 * rate-limit create routes import it back.) */
export const scopedRuleColumns = (body: {
  scope: "user" | "role" | "team" | "fleet";
  serverScope: "server" | "all";
  userId?: string | null;
  roleId?: string | null;
  teamId?: string | null;
  serverId?: string | null;
}) => ({
  scope: body.scope,
  serverScope: body.serverScope,
  userId: body.scope === "user" ? body.userId! : null,
  roleId: body.scope === "role" ? body.roleId! : null,
  teamId: body.scope === "team" ? body.teamId! : null,
  serverId: body.serverScope === "server" ? body.serverId! : null,
});

export async function createApprovalRuleRow(
  // AER-035: a caller may run this inside its own transaction (the copilot's
  // proposal applier does), so it must be able to join one.
  db: DbOrTxDeep,
  /** ADR-0186 A: `quorum` and `approverRoleId` ride in the body (the shared create schema carries them);
   *  omitted -> the column defaults (quorum 1, no role) */
  body: CreateApprovalRuleInput,
): Promise<typeof approvalRules.$inferSelect> {
  const dualControl = { quorum: body.quorum, approverRoleId: body.approverRoleId };
  // one transaction (a savepoint inside a caller's): the guard locks the approver
  // role row, and the lock must hold until the rule naming it is written
  return db.transaction(async (tx) => createApprovalRuleRowLocked(tx as unknown as DbOrTx, body, dualControl));
}

async function createApprovalRuleRowLocked(
  db: DbOrTx,
  body: CreateApprovalRuleInput,
  dualControl: { quorum?: number | undefined; approverRoleId?: string | null | undefined },
): Promise<typeof approvalRules.$inferSelect> {
  // ADR-0186 A: THE ONE GUARD — a pool that can never reach the quorum is refused here,
  // for the admin route and the copilot's rule_to_approval applier alike
  await assertApprovalRuleWritable(db, {
    approverUserId: body.approverUserId,
    approverRoleId: dualControl.approverRoleId ?? null,
    quorum: dualControl.quorum ?? 1,
    scope: body.scope ?? "user",
    userId: body.userId ?? null,
  });
  const [row] = await db
    .insert(approvalRules)
    .values({
      ...scopedRuleColumns(body),
      toolName: body.toolName ?? null,
      writeOnly: body.writeOnly ?? false,
      // ADR-0104: omitted -> the column default, 'action'. Written through
      // rather than defaulted here so the ONE default lives in the DDL.
      ...(body.approvalScope ? { approvalScope: body.approvalScope } : {}),
      approverUserId: body.approverUserId,
      ...(dualControl.quorum !== undefined ? { quorum: dualControl.quorum } : {}),
      ...(dualControl.approverRoleId !== undefined ? { approverRoleId: dualControl.approverRoleId } : {}),
    })
    .returning();
  return row!;
}
