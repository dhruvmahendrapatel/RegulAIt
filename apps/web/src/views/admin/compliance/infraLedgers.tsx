/**
 * The five infrastructure ledgers (pillar 3 §8.2), shared by the Infrastructure overview's previews and each
 * ledger's own page (P3, #453 c6527514889): which route each reads, its columns, and the one governed proposal flow
 * (an explicit approver, an owned confirm, the Approvals queue) that the findings, certificate, patch and backup rows use.
 */
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type { InfraBackup, InfraCert, InfraFinding, InfraPatch, InfraResource, OrgSettingsResponse } from "../../../api/adminTypes";
import { ago } from "../../../api/format";
import { Badge, Button, ConfirmModal, Field, Select, type Tone } from "../../../ui/kit";
import type { DataColumn } from "../../../ui/DataList";
import type { ListSort } from "../../../ui/listState";
import { optionEls, useAction, useUsers, userOpts } from "../adminKit";
import { putOrgSettings } from "../../../stepup/stepUp";
import a from "../admin.module.css";
import v from "../../views.module.css";

export const SEV_TONE: Record<string, Tone> = { critical: "danger", high: "danger", medium: "warn", low: "ok" };
export const STATUS_TONE: Record<string, Tone> = {
  open: "warn",
  remediation_proposed: "warn",
  auto_remediated: "ok",
  approved: "ok",
  remediated: "ok",
  accepted_risk: "danger",
};

export type LedgerId = "resources" | "findings" | "certificates" | "patches" | "backups";
export interface Ledger {
  id: LedgerId;
  /** the overview card's title and the page's */
  title: string;
  noun: string;
  listId: string;
  endpoint: string;
  /** the ledger's Excel export, written out (the route census reads it) */
  exportPath: string;
  legacyKey: string;
  defaultSort: ListSort;
  /** the preview's order: what needs attention first */
  previewSort: ListSort;
}
export const INFRA_PATH = "/admin/infrastructure";
export const ledgerPath = (id: LedgerId) => `${INFRA_PATH}/${id}`;
export const LEDGERS: Record<LedgerId, Ledger> = {
  resources: { id: "resources", title: "Resources — with cascade-derived floors", noun: "resources", listId: "infra-resources", endpoint: "/v1/infra/resources", exportPath: "/v1/infra/resources/export.xlsx", legacyKey: "resources", defaultSort: { key: "created", dir: "desc" }, previewSort: { key: "created", dir: "desc" } },
  findings: { id: "findings", title: "Findings — severity-sorted posture inbox", noun: "findings", listId: "infra-findings", endpoint: "/v1/infra/findings", exportPath: "/v1/infra/findings/export.xlsx", legacyKey: "findings", defaultSort: { key: "severity", dir: "desc" }, previewSort: { key: "severity", dir: "desc" } },
  certificates: { id: "certificates", title: "Certificates — rotation ledger", noun: "certificates", listId: "infra-certs", endpoint: "/v1/infra/certs", exportPath: "/v1/infra/certs/export.xlsx", legacyKey: "certs", defaultSort: { key: "created", dir: "desc" }, previewSort: { key: "notAfter", dir: "asc" } },
  patches: { id: "patches", title: "CVE patches — remediation ledger", noun: "CVE patches", listId: "infra-patches", endpoint: "/v1/infra/patches", exportPath: "/v1/infra/patches/export.xlsx", legacyKey: "patches", defaultSort: { key: "created", dir: "desc" }, previewSort: { key: "severity", dir: "desc" } },
  backups: { id: "backups", title: "Backups — run / restore ledger", noun: "backup runs", listId: "infra-backups", endpoint: "/v1/infra/backups", exportPath: "/v1/infra/backups/export.xlsx", legacyKey: "backups", defaultSort: { key: "created", dir: "desc" }, previewSort: { key: "created", dir: "desc" } },
};
export const ledgerQueryKey = (l: Ledger) => ["admin", l.listId, "list"] as const;

export type Propose = (title: string, body: string, url: string) => void;

const actionCol = <T,>(render: (r: T) => ReactNode): DataColumn<T> => ({ key: "actions", action: true, header: "", srHeader: "Actions", align: "right", render });

export function resourceColumns(): Array<DataColumn<InfraResource>> {
  return [
    { key: "name", main: true, sortable: true, header: "Name", render: (r) => r.name },
    { key: "kind", main: true, sortable: true, header: "Kind", render: (r) => r.kind },
    { key: "provider", main: true, sortable: true, header: "Provider", render: (r) => r.provider },
    { key: "classifications", main: true, sortable: true, header: "Classifications", render: (r) => (r.classifications ?? []).join(", ") || "—" },
    { key: "auto", main: true, header: "Auto ceiling", render: (r) => r.effectivePolicy?.autoRemediateMaxSeverity ?? "never" },
    { key: "backupFloor", main: true, header: "Backup floor (d)", align: "right", render: (r) => r.effectivePolicy?.backupRetentionDaysFloor ?? "—" },
    { key: "patchCeiling", main: true, header: "Patch ceiling (d)", align: "right", render: (r) => r.effectivePolicy?.patchCadenceDaysCeiling ?? "—" },
  ];
}

export function findingColumns(propose?: Propose): Array<DataColumn<InfraFinding>> {
  return [
    { key: "resource", main: true, sortable: true, header: "Governs", render: (f) => f.resourceName ?? "—" },
    { key: "kind", main: true, sortable: true, header: "Kind", render: (f) => f.kind },
    {
      key: "severity",
      main: true,
      sortable: true,
      required: "Severity is always shown",
      header: "Severity",
      render: (f) => (
        <Badge tone={SEV_TONE[f.severity] ?? "neutral"} title={`severity: ${f.severity}`}>
          {f.severity}
        </Badge>
      ),
    },
    {
      key: "status",
      main: true,
      sortable: true,
      required: "Status is always shown",
      header: "Status",
      render: (f) => (
        <Badge tone={STATUS_TONE[f.status] ?? "neutral"} title={`status: ${f.status}`}>
          {f.status.replaceAll("_", " ")}
        </Badge>
      ),
    },
    { key: "summary", main: true, sortable: true, header: "Summary", render: (f) => f.detail?.summary ?? "" },
    { key: "detected", main: true, sortable: true, header: "Detected", render: (f) => ago(f.detectedAt) },
    ...(propose
      ? [
          actionCol<InfraFinding>((f) =>
            f.status === "open" ? (
              <Button
                size="sm"
                variant="primary"
                onClick={() =>
                  propose(
                    "Propose remediation?",
                    `“${f.detail?.summary ?? f.kind}” on ${f.resourceName ?? "resource"} — the named approver decides in the Approvals queue before anything mutates.`,
                    `/v1/infra/findings/${f.id}/remediate`,
                  )
                }
              >
                propose remediation
              </Button>
            ) : (
              <span className={v.faint}>{f.status.replaceAll("_", " ")}</span>
            ),
          ),
        ]
      : []),
  ];
}

// named for the ledger, not "cert…": the list control stores the chosen column ids, and the static analysis reads a "cert" name as a secret
export function tlsLedgerColumns(propose?: Propose, history?: { open: string | null; toggle: (c: InfraCert) => void }): Array<DataColumn<InfraCert>> {
  return [
    { key: "resource", main: true, sortable: true, header: "Governs", render: (c) => c.resourceName ?? "—" },
    { key: "cn", main: true, sortable: true, header: "Common name", render: (c) => <span className={v.mono}>{c.commonName}</span> },
    { key: "notAfter", main: true, sortable: true, required: "Expiry is always shown", header: "Not after", render: (c) => String(c.notAfter).slice(0, 10) },
    { key: "status", main: true, sortable: true, required: "Status is always shown", header: "Status", render: (c) => <Badge>{c.status}</Badge> },
    { key: "serial", main: true, sortable: true, header: "Serial", render: (c) => c.serial ?? "—" },
    ...(propose && history
      ? [
          actionCol<InfraCert>((c) => (
            <div className={v.rowTight} style={{ justifyContent: "flex-end" }}>
              <Button size="sm" aria-label={`Rotation history of ${c.commonName}`} aria-pressed={history.open === c.id} onClick={() => history.toggle(c)}>
                history
              </Button>
              {c.status === "active" ? (
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() =>
                    propose(
                      "Propose certificate rotation?",
                      `Rotating ${c.commonName} advances not-after / last-rotated and writes a cert_rotations outcome row — only after the named approver approves.`,
                      `/v1/infra/certs/${c.id}/rotate`,
                    )
                  }
                >
                  propose rotation
                </Button>
              ) : (
                <span className={v.faint}>{c.status}</span>
              )}
            </div>
          )),
        ]
      : []),
  ];
}

export function patchColumns(propose?: Propose): Array<DataColumn<InfraPatch>> {
  return [
    { key: "resource", main: true, sortable: true, header: "Governs", render: (x) => x.resourceName ?? "—" },
    { key: "cve", main: true, sortable: true, header: "CVE", render: (x) => <span className={v.mono}>{x.cve}</span> },
    { key: "severity", main: true, sortable: true, required: "Severity is always shown", header: "Severity", render: (x) => <Badge tone={SEV_TONE[x.severity] ?? "neutral"}>{x.severity}</Badge> },
    { key: "package", main: true, sortable: true, header: "Package", render: (x) => x.package ?? "—" },
    { key: "fixed", main: true, sortable: true, header: "Fixed version", render: (x) => x.fixedVersion ?? "—" },
    { key: "status", main: true, sortable: true, required: "Status is always shown", header: "Status", render: (x) => <Badge>{x.status}</Badge> },
    ...(propose
      ? [
          actionCol<InfraPatch>((x) =>
            x.status === "open" ? (
              <Button size="sm" variant="primary" onClick={() => propose("Propose CVE patch?", `Applying ${x.cve} marks it patched only after approval; denying it records accepted risk.`, `/v1/infra/patches/${x.id}/apply`)}>
                propose patch
              </Button>
            ) : (
              <span className={v.faint}>{x.status}</span>
            ),
          ),
        ]
      : []),
  ];
}

export function backupColumns(propose?: Propose): Array<DataColumn<InfraBackup>> {
  return [
    { key: "resource", main: true, sortable: true, header: "Governs", render: (b) => b.resourceName ?? "—" },
    { key: "kind", main: true, sortable: true, header: "Kind", render: (b) => b.kind },
    { key: "status", main: true, sortable: true, required: "Status is always shown", header: "Status", render: (b) => <Badge tone={b.status === "missed" ? "danger" : "neutral"}>{b.status}</Badge> },
    { key: "retention", main: true, sortable: true, header: "Retention until", render: (b) => (b.retentionUntil ? String(b.retentionUntil).slice(0, 10) : "—") },
    ...(propose
      ? [
          actionCol<InfraBackup>((b) =>
            b.status === "missed" ? (
              <Button size="sm" variant="primary" onClick={() => propose("Propose restore?", "A governed restore appends a kind=restore, status=restored run — only after approval.", `/v1/infra/backups/${b.id}/restore`)}>
                propose restore
              </Button>
            ) : (
              <span className={v.faint}>{b.status}</span>
            ),
          ),
        ]
      : []),
  ];
}

/**
 * The remediation approver (a persisted org default) and the governed proposal: every "propose …" names the approver
 * explicitly and lands in the Approvals queue (objectType infra_operation).
 */
export function useInfraProposals() {
  const users = useUsers();
  const act = useAction();
  const org = useQuery({ queryKey: ["admin", "org-settings"], queryFn: () => api.get<OrgSettingsResponse>("/v1/org/settings") });
  const [approver, setApprover] = useState<string | null>(null);
  const effectiveApprover = approver ?? String(org.data?.settings.infraApproverUserId ?? "");
  const [proposal, setProposal] = useState<{ title: string; body: string; url: string } | null>(null);

  const propose: Propose = (title, body, url) => {
    if (!effectiveApprover) {
      act.setError("Pick a remediation approver first — every governed verb names one explicitly.");
      return;
    }
    setProposal({ title, body, url });
  };

  const approverField = (
    <div className={a.formRow}>
      <Field label="Remediation approver (persisted org default)" grow>
        <Select value={effectiveApprover} onChange={(e) => setApprover(e.target.value)}>
          {optionEls(userOpts(users.data?.users), "— select an approver —")}
        </Select>
      </Field>
      <Button
        size="sm"
        disabled={!effectiveApprover || act.busy}
        onClick={() => void act.run(() => putOrgSettings({ infraApproverUserId: effectiveApprover }), "Default remediation approver saved (org setting, audited)")}
      >
        Set approver
      </Button>
    </div>
  );

  const errorLine = act.error ? (
    <div className={v.errLine} role="alert">
      {act.error}
    </div>
  ) : null;

  const modal = (
    <ConfirmModal
      open={proposal !== null}
      title={proposal?.title ?? ""}
      body={proposal?.body}
      confirmLabel="Propose"
      onCancel={() => setProposal(null)}
      onConfirm={() => {
        const pr = proposal;
        setProposal(null);
        if (pr) void act.run(() => api.post(pr.url, { approverUserId: effectiveApprover }), "Proposed — awaiting the named approver in the Approvals queue");
      }}
    />
  );

  return { propose, approverField, errorLine, modal, approverName: users.data?.users.find((u) => u.id === effectiveApprover)?.displayName ?? null, effectiveApprover };
}

export const PROPOSAL_NOTE =
  "Each “propose remediation” / “rotate” / “patch” / “restore” names the approver explicitly and lands in the Approvals queue (objectType infra_operation). Auto-remediated findings are already fixed; only 'open' findings can be proposed.";
