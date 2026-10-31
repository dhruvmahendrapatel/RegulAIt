/**
 * ADR-0159 — every remediation proposal across all alerts
 * (`GET /v1/governance/remediations`), under the shared list control (ADR-0226), filterable by status.
 * A proposal is approval-gated: this list says where each one stands and
 * links to the approval that decides it; it never applies anything itself.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ago, humanize } from "../../../api/format";
import { Badge, Card, Field, Select, type Tone } from "../../../ui/kit";
import { DataList, type DataColumn } from "../../../ui/DataList";
import a from "../admin.module.css";
import v from "../../views.module.css";
import s from "./demoGovernance.module.css";

export const REMEDIATION_STATUSES = ["pending_approval", "applied", "denied", "failed"] as const;
export type RemediationStatus = (typeof REMEDIATION_STATUSES)[number];

export interface OrgRemediation {
  id: string;
  alertId: string;
  kind: string;
  params: Record<string, unknown>;
  title: string;
  rationale: string;
  status: RemediationStatus;
  approvalId: string | null;
  proposedByUserId: string;
  decidedByUserId: string | null;
  decidedAt: string | null;
  result: unknown;
  createdAt: string;
}

/** words for a status; "waiting for approval" rather than the code */
export const REMEDIATION_STATUS_WORDS: Record<RemediationStatus, string> = {
  pending_approval: "Waiting for approval",
  applied: "Applied",
  denied: "Denied",
  failed: "Failed",
};
const statusWords = (s: string) => REMEDIATION_STATUS_WORDS[s as RemediationStatus] ?? humanize(s);

/**
 * The approvals list that shows this proposal's approval. The list defaults to pending approvals, which leaves out a
 * proposal already decided, so a decided one opens the list across every status (an empty `status`).
 */
export const remediationApprovalHref = (status: string) =>
  `/admin/approvals?objectType=remediation${status === "pending_approval" ? "" : "&status="}`;

export const remediationTone = (status: string): Tone =>
  status === "applied" ? "ok" : status === "pending_approval" ? "info" : status === "denied" || status === "failed" ? "danger" : "warn";

export type OrgRemediationRow = OrgRemediation & { proposedByName?: string | null; decidedByName?: string | null };

/** ADR-0226: the remediations list's columns; the ids and sortable ones match the gateway's REMEDIATIONS_LIST */
export const REMEDIATION_COLUMNS: Array<DataColumn<OrgRemediationRow>> = [
  { key: "title", header: "Remediation", main: true, sortable: true, render: (r) => <span>{r.title}</span> },
  { key: "kind", header: "Kind", main: true, sortable: true, render: (r) => <span title={r.kind}>{humanize(r.kind)}</span> },
  {
    key: "status",
    header: "Status",
    main: true,
    sortable: true,
    required: "Status is always shown",
    render: (r) => <Badge tone={remediationTone(r.status)}>{statusWords(r.status)}</Badge>,
  },
  { key: "proposed", header: "Proposed", main: true, sortable: true, render: (r) => `${r.proposedByName ?? r.proposedByUserId} · ${ago(r.createdAt)}` },
  {
    key: "decided",
    header: "Decided",
    main: true,
    sortable: true,
    render: (r) => (r.decidedAt ? `${r.decidedByName ?? r.decidedByUserId ?? "—"} · ${ago(r.decidedAt)}` : <span className={v.faint}>not yet</span>),
  },
  { key: "rationale", header: "Rationale", render: (r) => r.rationale },
  {
    key: "links",
    // FS-42: a named column for assistive tech, hidden on screen
    header: <span className={s.srOnly}>Actions</span>,
    srHeader: "Actions",
    align: "right",
    action: true,
    render: (r) =>
      r.approvalId ? (
        <Link to={remediationApprovalHref(r.status)} aria-label={`Open approval: ${r.title}`}>
          Open approval
        </Link>
      ) : null,
  },
];

export function RemediationsCard() {
  const [status, setStatus] = useState<"" | RemediationStatus>("");
  const filters = useMemo(() => ({ status: status || undefined }), [status]);
  return (
    <Card
      title="Remediation proposals — all alerts"
      info={
        <p>
          Every remediation proposed from any alert. Each waits for a different person to approve it; nothing here
          applies a change.
        </p>
      }
    >
      <div className={a.formRow}>
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value as "" | RemediationStatus)}>
            <option value="">Any status</option>
            {REMEDIATION_STATUSES.map((st) => (
              <option key={st} value={st}>
                {statusWords(st)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <DataList<OrgRemediationRow>
        listId="remediations"
        noun="remediations"
        endpoint="/v1/governance/remediations"
        exportPath="/v1/governance/remediations/export.xlsx"
        queryKey={["admin", "governance-remediations"]}
        legacyKey="proposals"
        filters={filters}
        defaultSort={{ key: "proposed", dir: "desc" }}
        columns={REMEDIATION_COLUMNS}
        rowKey={(r) => r.id}
        empty={<span className={v.faint}>{status ? `No remediations with status “${statusWords(status).toLowerCase()}”.` : "No remediation has been proposed from any alert."}</span>}
      />
    </Card>
  );
}
