/**
 * ADR-0219 — the approver delegations table (`/admin/approvals`) under the
 * shared list contract (list-contract.ts). `GET /v1/delegations` is admin-only
 * through the default gate (route-classes.ts), and so is its Excel export.
 */
import { z } from "zod";
import { and, approvalDelegations, gt, lte, sql, users, type Db, type PgColumn, type SQL } from "@regulait/db";
import type { ListReader, ListSpec } from "./list-contract.js";

/** a person's name as the lists show it: the display name, else the email (a correlated subquery, sortable) */
export const userNameSql = (col: PgColumn | SQL): SQL<string | null> =>
  sql<string | null>`(select coalesce(nullif(${users.displayName}, ''), ${users.email}) from ${users} where ${users.id} = ${col})`;

export interface DelegationListRow {
  id: string;
  fromUserId: string;
  toUserId: string;
  startsAt: Date;
  endsAt: Date;
  reason: string | null;
  createdBy: string | null;
  createdAt: Date;
  fromName: string | null;
  toName: string | null;
  active: boolean;
}

export const delegationsFilterQuery = z
  .object({ status: z.enum(["active", "scheduled", "expired"]).optional() })
  .strict();
export type DelegationsFilters = z.infer<typeof delegationsFilterQuery>;

export function delegationsWhere(f: DelegationsFilters): SQL | undefined {
  const d = approvalDelegations;
  if (f.status === "active") return and(lte(d.startsAt, sql`now()`), gt(d.endsAt, sql`now()`));
  if (f.status === "scheduled") return gt(d.startsAt, sql`now()`);
  if (f.status === "expired") return lte(d.endsAt, sql`now()`);
  return undefined;
}

const STATUS = sql`case when ${approvalDelegations.startsAt} <= now() and now() < ${approvalDelegations.endsAt} then 1 when ${approvalDelegations.startsAt} > now() then 2 else 3 end`;

export const delegationsReader = (db: Db): ListReader<DelegationListRow> => ({
  fetch: async (q) => {
    const rows = await db
      .select({
        id: approvalDelegations.id,
        fromUserId: approvalDelegations.fromUserId,
        toUserId: approvalDelegations.toUserId,
        startsAt: approvalDelegations.startsAt,
        endsAt: approvalDelegations.endsAt,
        reason: approvalDelegations.reason,
        createdBy: approvalDelegations.createdBy,
        createdAt: approvalDelegations.createdAt,
        fromName: userNameSql(approvalDelegations.fromUserId),
        toName: userNameSql(approvalDelegations.toUserId),
        _cursorAt: q.cursorAt,
      })
      .from(approvalDelegations)
      .where(q.where)
      .orderBy(...q.orderBy)
      .limit(q.limit)
      .offset(q.offset);
    const now = Date.now();
    return rows.map((r) => ({ ...r, active: r.startsAt.getTime() <= now && now < r.endsAt.getTime() }));
  },
  countable: (where) => db.select({ one: sql`1` }).from(approvalDelegations).where(where),
  idOf: (r) => r.id,
});

const statusOf = (r: DelegationListRow) => (r.active ? "active" : r.endsAt.getTime() < Date.now() ? "expired" : "scheduled");

export const DELEGATIONS_LIST: ListSpec<DelegationListRow> = {
  id: "delegations",
  sorts: {
    from: { expr: sql`lower(${userNameSql(approvalDelegations.fromUserId)})` },
    to: { expr: sql`lower(${userNameSql(approvalDelegations.toUserId)})` },
    starts: { expr: approvalDelegations.startsAt, keysetAt: approvalDelegations.startsAt },
    ends: { expr: approvalDelegations.endsAt, keysetAt: approvalDelegations.endsAt },
    status: { expr: STATUS },
    reason: { expr: sql`lower(${approvalDelegations.reason})` },
    created: { expr: approvalDelegations.createdAt, keysetAt: approvalDelegations.createdAt },
  },
  columns: {
    from: { label: "From", value: (r) => r.fromName ?? r.fromUserId },
    to: { label: "To", value: (r) => r.toName ?? r.toUserId },
    starts: { label: "Starts", value: (r) => r.startsAt },
    ends: { label: "Ends", value: (r) => r.endsAt },
    status: { label: "Status", value: statusOf },
    reason: { label: "Reason", value: (r) => r.reason },
    created: { label: "Created", value: (r) => r.createdAt },
  },
  filters: ["status"],
  defaultSort: { col: "created", dir: "desc" },
  idCol: approvalDelegations.id,
};
