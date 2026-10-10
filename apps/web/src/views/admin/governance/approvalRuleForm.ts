/**
 * ADR-0186 A — the approval-rule form's dual-control half: how many different
 * approvers a matching call needs (1–5) and the approver role whose active
 * members join the named approver in the eligible pool. The gateway decides
 * whether that pool can ever reach the number (422 `quorum_unsatisfiable`).
 */

/** ADR-0186 A: an approval rule's quorum bounds (APPROVAL_QUORUM_LIMITS in @regulait/shared) */
export const APPROVAL_QUORUM_CHOICES = [1, 2, 3, 4, 5] as const;

/** the exact body POST /v1/rules/approvals receives from the form */
export function approvalRuleBody(subject: Record<string, unknown>, extra: Record<string, string>): Record<string, unknown> {
  const quorum = Number(extra.quorum ?? "1");
  return {
    ...subject,
    approverUserId: extra.approverUserId,
    ...(Number.isInteger(quorum) && quorum > 1 ? { quorum } : {}),
    ...(extra.approverRoleId ? { approverRoleId: extra.approverRoleId } : {}),
  };
}

/** the exact body PATCH /v1/rules/approvals/:id receives from the inline editor */
export function approvalRuleQuorumPatch(quorum: string, approverRoleId: string): { quorum: number; approverRoleId: string | null } {
  return { quorum: Number(quorum), approverRoleId: approverRoleId || null };
}
