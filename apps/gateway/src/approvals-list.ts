/**
 * ADR-0226 (P2 batch D) — the approvals queue under the shared list contract: the Inbox's "Recently decided" list
 * (and any other read of `/v1/approvals` that sends a contract param). The route keeps its own WHERE (the visibility
 * rules of ADR-0022, ADR-0046, ADR-0168 and ADR-0186, and the status, objectType and approverUserId filters), so
 * the page and its count read through one predicate. The columns are declared for the Excel export, which is not
 * routed yet: it ships with the Inbox's list control, held in P2 batch D because the "Recently decided" card must keep
 * its X6b fold and a card holding the control's page-size select cannot fold.
 */
import { approvals, sql, type PgColumn, type SQL } from "@regulait/db";
import type { ListSpec } from "./list-contract.js";

/** the queue row as the list shows it (the enrichment adds more; these are what the columns read) */
export interface ApprovalListRow {
  id: string;
  objectType: string;
  status: string;
  toolName: string | null;
  stageId: string | null;
  requestedAt: Date | string;
  decidedAt: Date | string | null;
  decisionReason: string | null;
  requestedByName: string | null;
  approverName: string | null;
  decidedByName: string | null;
  objectLabel: string | null;
}

/**
 * A person's name for a sort, as a correlated subquery. The inner table is aliased (`u`) and its columns are named
 * through the alias, so the outer `approvals` column can never bind to the inner table.
 */
const nameOf = (col: PgColumn): SQL =>
  sql`(select lower(coalesce(nullif(u.display_name, ''), u.email)) from users u where u.id = ${col})`;

const at = (v: Date | string | null) => (v === null ? null : v instanceof Date ? v : new Date(v));

export const APPROVALS_LIST: ListSpec<ApprovalListRow> = {
  id: "approvals",
  sorts: {
    requested: { expr: approvals.requestedAt, keysetAt: approvals.requestedAt },
    decided: { expr: approvals.decidedAt },
    status: { expr: approvals.status },
    kind: { expr: approvals.objectType },
    requester: { expr: nameOf(approvals.userId) },
    approver: { expr: nameOf(approvals.approverUserId) },
    decider: { expr: nameOf(approvals.decidedBy) },
  },
  columns: {
    item: {
      label: "Item",
      value: (r) => [r.objectType.replace(/_/g, " "), r.objectLabel ?? r.toolName].filter(Boolean).join(" · "),
    },
    status: { label: "Status", value: (r) => r.status },
    kind: { label: "Kind", value: (r) => r.objectType.replace(/_/g, " ") },
    requester: { label: "Requested by", value: (r) => r.requestedByName },
    approver: { label: "Approver", value: (r) => r.approverName },
    decider: { label: "Decided by", value: (r) => r.decidedByName },
    decided: { label: "Decided", value: (r) => at(r.decidedAt) },
    requested: { label: "Requested", value: (r) => at(r.requestedAt) },
    reason: { label: "Reason", value: (r) => r.decisionReason },
  },
  filters: ["status", "objectType", "approverUserId"],
  defaultSort: { col: "requested", dir: "desc" },
  idCol: approvals.id,
};
