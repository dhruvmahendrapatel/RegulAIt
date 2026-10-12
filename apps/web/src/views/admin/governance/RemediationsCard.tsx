/**
 * ADR-0159 — every remediation proposal across all alerts
 * (`GET /v1/governance/remediations`), newest first, filterable by status.
 * A proposal is approval-gated: this list says where each one stands and
 * links to the approval that decides it; it never applies anything itself.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../../api/client";
import { ago, humanize } from "../../../api/format";
import { Badge, Card, Field, Select, Table, type Tone } from "../../../ui/kit";
import { QueryGate, useNameMaps } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

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

export const remediationTone = (status: string): Tone =>
  status === "applied" ? "ok" : status === "pending_approval" ? "info" : status === "denied" || status === "failed" ? "danger" : "warn";

export function RemediationsCard() {
  const [status, setStatus] = useState<"" | RemediationStatus>("");
  const names = useNameMaps();
  const list = useQuery({
    queryKey: ["admin", "governance-remediations", status],
    queryFn: () =>
      api.get<{ proposals: OrgRemediation[] }>(`/v1/governance/remediations${status ? `?status=${status}` : ""}`),
  });
  const who = (id: string | null) => (id ? (names.userName.get(id) ?? id) : "—");
  return (
    <Card title="Remediation proposals — all alerts">
      <p className={v.faint}>
        Every remediation proposed from any alert, newest first (at most 200). Each waits for a different person to
        approve it; nothing here applies a change.
      </p>
      <div className={a.formRow}>
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value as "" | RemediationStatus)}>
            <option value="">Any status</option>
            {REMEDIATION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusWords(s)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <QueryGate loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}>
        <Table<OrgRemediation>
          rows={Array.isArray(list.data?.proposals) ? list.data.proposals : []}
          rowKey={(r) => r.id}
          empty={<span className={v.faint}>{status ? `No remediations with status “${statusWords(status).toLowerCase()}”.` : "No remediation has been proposed from any alert."}</span>}
          columns={[
            { key: "title", header: "Remediation", render: (r) => <span>{r.title}</span> },
            { key: "kind", header: "Kind", render: (r) => <code>{r.kind}</code> },
            { key: "status", header: "Status", render: (r) => <Badge tone={remediationTone(r.status)}>{statusWords(r.status)}</Badge> },
            { key: "proposed", header: "Proposed", render: (r) => `${who(r.proposedByUserId)} · ${ago(r.createdAt)}`, sort: (r) => r.createdAt },
            {
              key: "decided",
              header: "Decided",
              render: (r) => (r.decidedAt ? `${who(r.decidedByUserId)} · ${ago(r.decidedAt)}` : <span className={v.faint}>not yet</span>),
            },
            {
              key: "links",
              header: "",
              align: "right",
              render: (r) => (
                r.approvalId ? (
                  <Link to="/admin/approvals?objectType=remediation" aria-label={`Open the approval for ${r.title}`}>
                    Open approval
                  </Link>
                ) : null
              ),
            },
          ]}
        />
      </QueryGate>
    </Card>
  );
}
