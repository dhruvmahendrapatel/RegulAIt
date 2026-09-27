/**
 * Infrastructure (pillar 3 §8.2) — posture stats, resources with their
 * cascade-derived floors, operational policies, the severity-sorted findings
 * inbox with governed remediation (owned confirm modals, persisted org
 * approver), and the cert / patch / backup ledgers whose governed verbs all
 * funnel into the one Approvals queue.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type {
  InfraBackup,
  InfraCert,
  InfraFinding,
  InfraPatch,
  InfraPolicy,
  InfraPosture,
  InfraResource,
  OrgSettingsResponse,
} from "../../../api/adminTypes";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, ConfirmModal, EmptyState, Field, Input, Select, Table, type Tone } from "../../../ui/kit";
import { Stat, optionEls, useAction, useComplianceProfiles, useUsers, userOpts } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

const SEV_TONE: Record<string, Tone> = { critical: "danger", high: "danger", medium: "warn", low: "ok" };
const STATUS_TONE: Record<string, Tone> = {
  open: "warn",
  remediation_proposed: "warn",
  auto_remediated: "ok",
  approved: "ok",
  remediated: "ok",
  accepted_risk: "danger",
};

export default function InfrastructurePage() {
  const users = useUsers();
  const act = useAction();
  const posture = useQuery({
    queryKey: ["admin", "infra-posture"],
    queryFn: () => api.get<InfraPosture>("/v1/infra/posture"),
  });
  const resources = useQuery({
    queryKey: ["admin", "infra-resources"],
    queryFn: () => api.get<{ resources: InfraResource[] }>("/v1/infra/resources"),
  });
  const policies = useQuery({
    queryKey: ["admin", "infra-policies"],
    queryFn: () => api.get<{ policies: InfraPolicy[] }>("/v1/infra/policies"),
  });
  const findings = useQuery({
    queryKey: ["admin", "infra-findings"],
    queryFn: () => api.get<{ findings: InfraFinding[] }>("/v1/infra/findings"),
  });
  const certs = useQuery({
    queryKey: ["admin", "infra-certs"],
    queryFn: () => api.get<{ certs: InfraCert[] }>("/v1/infra/certs"),
  });
  const patches = useQuery({
    queryKey: ["admin", "infra-patches"],
    queryFn: () => api.get<{ patches: InfraPatch[] }>("/v1/infra/patches"),
  });
  const backups = useQuery({
    queryKey: ["admin", "infra-backups"],
    queryFn: () => api.get<{ backups: InfraBackup[] }>("/v1/infra/backups"),
  });
  const org = useQuery({
    queryKey: ["admin", "org-settings"],
    queryFn: () => api.get<OrgSettingsResponse>("/v1/org/settings"),
  });

  const [approver, setApprover] = useState<string | null>(null);
  const effectiveApprover =
    approver ?? String(org.data?.settings.infraApproverUserId ?? "") ?? "";
  const [proposal, setProposal] = useState<{
    title: string;
    body: string;
    url: string;
  } | null>(null);

  const p = posture.data ?? {};
  const inline = (obj: Record<string, number>) =>
    Object.entries(obj)
      .map(([k, n]) => `${k} ${n}`)
      .join(" · ") || "—";

  const propose = (title: string, body: string, url: string) => {
    if (!effectiveApprover) {
      act.setError("Pick a remediation approver first — every governed verb names one explicitly.");
      return;
    }
    setProposal({ title, body, url });
  };

  return (
    <>
      <PageHeader
        title="Infrastructure"
        sub="Monitored resources, policies, findings and governed remediation."
        info={<p>Monitored resources, operational policies, detected findings and governed remediation. Findings are inert until governed — auto-remediation happens only under a permissive policy; every 'critical' is always approval-gated.</p>}
      />
      <div className={v.stack}>
        <div className={v.grid4}>
          <Stat value={p.resources ?? 0} label="monitored resources" />
          <Stat value={p.open ?? 0} label={`open findings (${p.findings ?? 0} total)`} />
          <Stat
            value={`${p.bySeverity?.critical ?? 0} / ${p.bySeverity?.high ?? 0}`}
            label="critical / high"
          />
          <Stat
            value={`${p.backup?.missed ?? 0} / ${p.backup?.targets ?? 0}`}
            label="backups missed / targets"
          />
        </div>

        <Card>
          <div className={v.stack}>
            <div className={v.row}>
              <span className={v.dim}>by kind:</span> {inline(p.byKind ?? {})}
            </div>
            <div className={v.row}>
              <span className={v.dim}>by severity:</span> {inline(p.bySeverity ?? {})}
            </div>
            <div className={v.row}>
              <span className={v.dim}>by status:</span> {inline(p.byStatus ?? {})}
            </div>
            <div className={v.row}>
              <Button
                variant="primary"
                size="sm"
                disabled={act.busy}
                onClick={() =>
                  void act.run(async () => {
                    const r = await api.post<{ created: number; autoRemediated: number; refreshed: number }>(
                      "/v1/infra/scan",
                      {},
                    );
                    return Promise.resolve(r);
                  }, "Scan complete — findings refreshed; permissive policies auto-remediated what they may (audited)")
                }
              >
                Scan now
              </Button>
              <span className={v.faint}>
                Scanning detects findings idempotently, then auto-remediates any that a policy permits
                (audited) — everything else waits for a governed remediation.
              </span>
            </div>
          </div>
        </Card>

        <RegisterResourceCard />

        <Card flush title="Resources — with cascade-derived floors">
          <Table<InfraResource>
            columns={[
              { key: "name", header: "Name", render: (r) => r.name },
              { key: "kind", header: "Kind", render: (r) => r.kind },
              { key: "provider", header: "Provider", render: (r) => r.provider },
              {
                key: "classifications",
                header: "Classifications",
                render: (r) => (r.classifications ?? []).join(", ") || "—",
              },
              {
                key: "auto",
                header: "Auto ceiling",
                render: (r) => r.effectivePolicy?.autoRemediateMaxSeverity ?? "never",
              },
              {
                key: "backupFloor",
                header: "Backup floor (d)",
                align: "right",
                render: (r) => r.effectivePolicy?.backupRetentionDaysFloor ?? "—",
              },
              {
                key: "patchCeiling",
                header: "Patch ceiling (d)",
                align: "right",
                render: (r) => r.effectivePolicy?.patchCadenceDaysCeiling ?? "—",
              },
            ]}
            rows={resources.data?.resources ?? []}
            rowKey={(r) => r.id}
            loading={resources.isLoading}
            empty={<EmptyState title="No monitored resources" body="Register one above — mock scans deterministically." />}
          />
        </Card>

        <PolicyCard resources={resources.data?.resources ?? []} policies={policies.data?.policies ?? []} loading={policies.isLoading} />

        <Card title="Findings — severity-sorted posture inbox">
          <div className={a.formRow} style={{ marginBottom: "var(--s2)" }}>
            <Field label="Remediation approver (persisted org default)" grow>
              <Select
                value={effectiveApprover}
                onChange={(e) => setApprover(e.target.value)}
              >
                {optionEls(userOpts(users.data?.users), "— select an approver —")}
              </Select>
            </Field>
            <Button
              size="sm"
              disabled={!effectiveApprover || act.busy}
              onClick={() =>
                void act.run(
                  () => api.put("/v1/org/settings", { infraApproverUserId: effectiveApprover }),
                  "Default remediation approver saved (org setting, audited)",
                )
              }
            >
              Set approver
            </Button>
          </div>
          {act.error && (
            <div className={v.errLine} role="alert">
              {act.error}
            </div>
          )}
          <p className={v.faint}>
            Each “propose remediation” / “rotate” / “patch” / “restore” names the approver explicitly and
            lands in the Approvals queue (objectType infra_operation). Auto-remediated findings are already
            fixed; only 'open' findings can be proposed.
          </p>
          <Table<InfraFinding>
            columns={[
              { key: "resource", header: "Governs", render: (f) => f.resourceName ?? "—" },
              { key: "kind", header: "Kind", render: (f) => f.kind },
              {
                key: "severity",
                header: "Severity",
                sort: (f) => ["critical", "high", "medium", "low"].indexOf(f.severity),
                render: (f) => (
                  <Badge tone={SEV_TONE[f.severity] ?? "neutral"} title={`severity: ${f.severity}`}>
                    {f.severity}
                  </Badge>
                ),
              },
              {
                key: "status",
                header: "Status",
                sort: (f) => f.status,
                render: (f) => (
                  <Badge tone={STATUS_TONE[f.status] ?? "neutral"} title={`status: ${f.status}`}>
                    {f.status.replaceAll("_", " ")}
                  </Badge>
                ),
              },
              { key: "summary", header: "Summary", render: (f) => f.detail?.summary ?? "" },
              { key: "detected", header: "Detected", sort: (f) => f.detectedAt, render: (f) => ago(f.detectedAt) },
              {
                key: "actions",
                header: "",
                align: "right",
                render: (f) =>
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
              },
            ]}
            rows={findings.data?.findings ?? []}
            rowKey={(f) => f.id}
            loading={findings.isLoading}
            empty={<EmptyState title="No findings" body="Run a scan to detect drift, cert expiry, missed backups and CVEs." />}
          />
        </Card>

        <Card title="Certificates — rotation ledger">
          <Table<InfraCert>
            columns={[
              { key: "resource", header: "Governs", render: (c) => c.resourceName ?? "—" },
              { key: "cn", header: "Common name", render: (c) => <span className={v.mono}>{c.commonName}</span> },
              { key: "notAfter", header: "Not after", render: (c) => String(c.notAfter).slice(0, 10) },
              { key: "status", header: "Status", render: (c) => <Badge>{c.status}</Badge> },
              { key: "serial", header: "Serial", render: (c) => c.serial ?? "—" },
              {
                key: "actions",
                header: "",
                align: "right",
                render: (c) =>
                  c.status === "active" ? (
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
                  ),
              },
            ]}
            rows={certs.data?.certs ?? []}
            rowKey={(c) => c.id}
            loading={certs.isLoading}
            empty={<EmptyState title="No certificates tracked" />}
          />
        </Card>

        <Card title="CVE patches — remediation ledger">
          <Table<InfraPatch>
            columns={[
              { key: "resource", header: "Governs", render: (x) => x.resourceName ?? "—" },
              { key: "cve", header: "CVE", render: (x) => <span className={v.mono}>{x.cve}</span> },
              {
                key: "severity",
                header: "Severity",
                render: (x) => <Badge tone={SEV_TONE[x.severity] ?? "neutral"}>{x.severity}</Badge>,
              },
              { key: "package", header: "Package", render: (x) => x.package ?? "—" },
              { key: "fixed", header: "Fixed version", render: (x) => x.fixedVersion ?? "—" },
              { key: "status", header: "Status", render: (x) => <Badge>{x.status}</Badge> },
              {
                key: "actions",
                header: "",
                align: "right",
                render: (x) =>
                  x.status === "open" ? (
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() =>
                        propose(
                          "Propose CVE patch?",
                          `Applying ${x.cve} marks it patched only after approval; denying it records accepted risk.`,
                          `/v1/infra/patches/${x.id}/apply`,
                        )
                      }
                    >
                      propose patch
                    </Button>
                  ) : (
                    <span className={v.faint}>{x.status}</span>
                  ),
              },
            ]}
            rows={patches.data?.patches ?? []}
            rowKey={(x) => x.id}
            loading={patches.isLoading}
            empty={<EmptyState title="No CVE patches tracked" />}
          />
        </Card>

        <Card title="Backups — run / restore ledger">
          <Table<InfraBackup>
            columns={[
              { key: "resource", header: "Governs", render: (b) => b.resourceName ?? "—" },
              { key: "kind", header: "Kind", render: (b) => b.kind },
              { key: "status", header: "Status", render: (b) => <Badge>{b.status}</Badge> },
              { key: "retention", header: "Retention until", render: (b) => (b.retentionUntil ? String(b.retentionUntil).slice(0, 10) : "—") },
              {
                key: "actions",
                header: "",
                align: "right",
                render: (b) =>
                  b.status === "missed" ? (
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() =>
                        propose(
                          "Propose restore?",
                          "A governed restore appends a kind=restore, status=restored run — only after approval.",
                          `/v1/infra/backups/${b.id}/restore`,
                        )
                      }
                    >
                      propose restore
                    </Button>
                  ) : (
                    <span className={v.faint}>{b.status}</span>
                  ),
              },
            ]}
            rows={backups.data?.backups ?? []}
            rowKey={(b) => b.id}
            loading={backups.isLoading}
            empty={<EmptyState title="No backup runs tracked" />}
          />
        </Card>
      </div>

      <ConfirmModal
        open={proposal !== null}
        title={proposal?.title ?? ""}
        body={proposal?.body}
        confirmLabel="Propose"
        onCancel={() => setProposal(null)}
        onConfirm={() => {
          const pr = proposal;
          setProposal(null);
          if (pr)
            void act.run(
              () => api.post(pr.url, { approverUserId: effectiveApprover }),
              "Proposed — awaiting the named approver in the Approvals queue",
            );
        }}
      />
    </>
  );
}

function RegisterResourceCard() {
  const profiles = useComplianceProfiles();
  const act = useAction();
  const [f, setF] = useState({
    name: "",
    kind: "control_plane",
    provider: "mock",
    daysUntilExpiry: "",
    hoursSinceLastBackup: "",
    classifications: [] as string[],
  });
  const set = (k: keyof typeof f, val: string | string[]) => setF((s) => ({ ...s, [k]: val }));
  const tagList = (profiles.data?.profiles ?? []).map((p) => p.tag);
  return (
    <Card title="Register a resource">
      <form
        className={a.formRow}
        onSubmit={(e) => {
          e.preventDefault();
          const config: Record<string, number> = {};
          if (f.daysUntilExpiry !== "") config.daysUntilExpiry = Number(f.daysUntilExpiry);
          if (f.hoursSinceLastBackup !== "") config.hoursSinceLastBackup = Number(f.hoursSinceLastBackup);
          void act
            .run(
              () =>
                api.post("/v1/infra/resources", {
                  name: f.name,
                  kind: f.kind,
                  provider: f.provider,
                  ...(Object.keys(config).length ? { config } : {}),
                  ...(f.classifications.length ? { classifications: f.classifications } : {}),
                }),
              "Resource registered",
            )
            .then((ok) => {
              if (ok)
                setF({ name: "", kind: "control_plane", provider: "mock", daysUntilExpiry: "", hoursSinceLastBackup: "", classifications: [] });
            });
        }}
      >
        <Field label="Name">
          <Input required value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. control-plane-gateway" />
        </Field>
        <Field label="Kind">
          <Select value={f.kind} onChange={(e) => set("kind", e.target.value)}>
            {["control_plane", "agent_runtime", "cert", "backup_target"].map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Provider">
          <Select value={f.provider} onChange={(e) => set("provider", e.target.value)}>
            {["mock", "aws", "azure", "gcp"].map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>
        </Field>
        {f.kind === "cert" && (
          <Field label="Days until expiry (≤0 = expired = critical)">
            <Input type="number" value={f.daysUntilExpiry} onChange={(e) => set("daysUntilExpiry", e.target.value)} />
          </Field>
        )}
        {f.kind === "backup_target" && (
          <Field label="Hours since last backup">
            <Input type="number" value={f.hoursSinceLastBackup} onChange={(e) => set("hoursSinceLastBackup", e.target.value)} />
          </Field>
        )}
        <Field label="Classifications">
          <Select
            multiple
            size={Math.min(4, Math.max(2, tagList.length || 2))}
            value={f.classifications}
            onChange={(e) => set("classifications", Array.from(e.target.selectedOptions).map((o) => o.value))}
          >
            {tagList.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" variant="primary" disabled={act.busy}>
          Register resource
        </Button>
        {act.error && (
          <span className={v.errLine} role="alert">
            {act.error}
          </span>
        )}
      </form>
      <p className={v.faint}>
        Only 'mock' executes today (keyless, deterministic); aws/azure/gcp are interface-ready and 501 on
        scan. Classifications cascade §8.3 backup-retention / patch-cadence floors onto the resource.
      </p>
    </Card>
  );
}

function PolicyCard(props: { resources: InfraResource[]; policies: InfraPolicy[]; loading: boolean }) {
  const act = useAction();
  const [f, setF] = useState({
    resourceId: "",
    patchCadenceDays: "",
    certRotationDaysBeforeExpiry: "",
    backupSchedule: "",
    backupRetentionDays: "",
    autoRemediateMaxSeverity: "",
  });
  const set = (k: keyof typeof f, val: string) => setF((s) => ({ ...s, [k]: val }));
  const rOpts = props.resources.map((r) => ({ v: r.id, l: `${r.name} · ${r.kind}` }));
  const scopeLabel = (resourceId: string | null) =>
    resourceId ? (rOpts.find((o) => o.v === resourceId)?.l ?? "resource") : "fleet-wide";
  return (
    <Card title="Operational policies">
      <form
        className={a.formRow}
        onSubmit={(e) => {
          e.preventDefault();
          const body: Record<string, unknown> = {};
          if (f.resourceId) body.resourceId = f.resourceId;
          for (const k of ["patchCadenceDays", "certRotationDaysBeforeExpiry", "backupRetentionDays"] as const) {
            if (f[k] !== "") body[k] = Number(f[k]);
          }
          if (f.backupSchedule) body.backupSchedule = f.backupSchedule;
          if (f.autoRemediateMaxSeverity) body.autoRemediateMaxSeverity = f.autoRemediateMaxSeverity;
          void act.run(() => api.post("/v1/infra/policies", body), "Policy saved");
        }}
      >
        <Field label="Resource (blank = fleet-wide)">
          <Select value={f.resourceId} onChange={(e) => set("resourceId", e.target.value)}>
            {optionEls(rOpts, "— fleet-wide default —")}
          </Select>
        </Field>
        <Field label="Patch cadence days">
          <Input type="number" value={f.patchCadenceDays} onChange={(e) => set("patchCadenceDays", e.target.value)} />
        </Field>
        <Field label="Cert rotation window days">
          <Input type="number" value={f.certRotationDaysBeforeExpiry} onChange={(e) => set("certRotationDaysBeforeExpiry", e.target.value)} />
        </Field>
        <Field label="Backup schedule">
          <Input value={f.backupSchedule} onChange={(e) => set("backupSchedule", e.target.value)} placeholder="e.g. daily-0200" />
        </Field>
        <Field label="Backup retention days">
          <Input type="number" value={f.backupRetentionDays} onChange={(e) => set("backupRetentionDays", e.target.value)} />
        </Field>
        <Field label="Auto-remediate ceiling">
          <Select value={f.autoRemediateMaxSeverity} onChange={(e) => set("autoRemediateMaxSeverity", e.target.value)}>
            <option value="">— never auto-remediate —</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </Select>
        </Field>
        <Button type="submit" size="sm" disabled={act.busy}>
          Save policy
        </Button>
        {act.error && (
          <span className={v.errLine} role="alert">
            {act.error}
          </span>
        )}
      </form>
      <p className={v.faint}>
        The auto-remediate ceiling cannot be 'critical' — every critical finding is always approval-gated.
        A resource-scoped policy overrides the fleet-wide default.
      </p>
      <Table<InfraPolicy>
        columns={[
          { key: "scope", header: "Scope", render: (p) => scopeLabel(p.resourceId) },
          { key: "patch", header: "Patch cadence (d)", align: "right", render: (p) => p.patchCadenceDays ?? "—" },
          { key: "cert", header: "Cert window (d)", align: "right", render: (p) => p.certRotationDaysBeforeExpiry ?? "—" },
          { key: "schedule", header: "Backup schedule", render: (p) => p.backupSchedule ?? "—" },
          { key: "retention", header: "Backup retention (d)", align: "right", render: (p) => p.backupRetentionDays ?? "—" },
          { key: "auto", header: "Auto ceiling", render: (p) => p.autoRemediateMaxSeverity ?? "never" },
        ]}
        rows={props.policies}
        rowKey={(p) => p.id ?? `${p.resourceId ?? "fleet"}`}
        loading={props.loading}
        empty={<EmptyState title="No policies set" />}
      />
    </Card>
  );
}
