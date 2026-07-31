/**
 * ADR-0022 — approver delegation helpers, shared by the approvals inbox, the
 * decide endpoint, and the workflow-instance read gate.
 *
 * A delegation is a WINDOW (starts_at <= now < ends_at), not a standing grant:
 * expiry needs no cleanup, the time predicate does it. The org master switch
 * (org_settings.approval_delegation_enabled) is consulted on EVERY call, so an
 * org that turns delegation off stops every window applying immediately — no
 * cached state, no restart.
 */

import {
  and,
  approvalDelegations,
  eq,
  gt,
  lte,
  type Db,
} from "@regulait/db";
import { loadOrgSettings } from "./org-settings.js";

export interface ActiveDelegation {
  id: string;
  fromUserId: string;
  toUserId: string;
  reason: string | null;
}

/** Every user who has ACTIVELY delegated their approvals to `toUserId` right
 * now. Empty when the org has delegation disabled. */
export async function activeDelegatorsFor(db: Db, toUserId: string): Promise<string[]> {
  const org = await loadOrgSettings(db);
  if (!org.approvalDelegationEnabled) return [];
  const now = new Date();
  const rows = await db
    .select({ fromUserId: approvalDelegations.fromUserId })
    .from(approvalDelegations)
    .where(
      and(
        eq(approvalDelegations.toUserId, toUserId),
        lte(approvalDelegations.startsAt, now),
        gt(approvalDelegations.endsAt, now),
      ),
    );
  return [...new Set(rows.map((r) => r.fromUserId))];
}

/** The active delegation letting `toUserId` decide in `fromUserId`'s place,
 * or null. Null when the org has delegation disabled. */
export async function activeDelegationFrom(
  db: Db,
  fromUserId: string,
  toUserId: string,
): Promise<ActiveDelegation | null> {
  const org = await loadOrgSettings(db);
  if (!org.approvalDelegationEnabled) return null;
  const now = new Date();
  const [row] = await db
    .select({
      id: approvalDelegations.id,
      fromUserId: approvalDelegations.fromUserId,
      toUserId: approvalDelegations.toUserId,
      reason: approvalDelegations.reason,
    })
    .from(approvalDelegations)
    .where(
      and(
        eq(approvalDelegations.fromUserId, fromUserId),
        eq(approvalDelegations.toUserId, toUserId),
        lte(approvalDelegations.startsAt, now),
        gt(approvalDelegations.endsAt, now),
      ),
    )
    .limit(1);
  return row ?? null;
}
