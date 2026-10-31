/**
 * Infrastructure (pillar 3 §8.2) — posture stats, resources with their
 * cascade-derived floors, operational policies, the severity-sorted findings
 * inbox with governed remediation (owned confirm modals, persisted org
 * approver), and the cert / patch / backup ledgers whose governed verbs all
 * funnel into the one Approvals queue. Each ledger is a five-row preview here
 * and a full list on its own page (InfraLedgerPages.tsx).
 */
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type { InfraPolicy, InfraPosture, InfraResource, OrgSettingsResponse } from "../../../api/adminTypes";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, InfoButton, Input, Select, Table, Tabs, tabIds } from "../../../ui/kit";
import { Stat, optionEls, useAction, useComplianceProfiles } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";
import { OrgSettingsCard } from "../settings/OrgSettingsCard";
import type { DataColumn } from "../../../ui/DataList";
import { ListPreview } from "../../../ui/ListPreview";
import {
  LEDGERS,
  PROPOSAL_NOTE,
  backupColumns,
  tlsLedgerColumns,
  findingColumns,
  ledgerPath,
  ledgerQueryKey,
  patchColumns,
  resourceColumns,
  useInfraProposals,
  type LedgerId,
} from "./infraLedgers";
import { PolicyActions } from "./InfraRowActions";

export default function InfrastructurePage() {
  const act = useAction();
  const proposals = useInfraProposals();
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

  const org = useQuery({ queryKey: ["admin", "org-settings"], queryFn: () => api.get<OrgSettingsResponse>("/v1/org/settings") });

  // P3: the ledgers and the set-up (register, policies, approver, backup verification) as two tabs. The set-up tab
  // says in its label when no approver is set or scheduled backup verification is off.
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "setup" ? "setup" : "ledgers";
  const panel = tabIds("infra", tab);
  const setTab = (id: string) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (id === "ledgers") next.delete("tab");
      else next.set("tab", id);
      return next;
    });
  const settings = org.data?.settings;
  const setupNotes = settings
    ? [!proposals.effectiveApprover ? "no approver" : null, settings.backupVerifyEnabled === false ? "backup verification off" : null].filter(Boolean)
    : [];

  const p = posture.data ?? {};
  const inline = (obj: Record<string, number>) =>
    Object.entries(obj)
      .map(([k, n]) => `${k} ${n}`)
      .join(" · ") || "—";
  // P3 (#453 c6527514889): each ledger keeps five rows here, worst first, and moves whole to its own page. The
  // ledgers have no status filter, so what needs attention is counted from the posture read this page already makes.
  const preview = (id: LedgerId, columns: Array<DataColumn<never>>, attention: Array<{ label: string; count: number | null }> = []) => {
    const l = LEDGERS[id];
    return (
      <ListPreview<never>
        title={l.title}
        noun={l.noun}
        endpoint={l.endpoint}
        legacyKey={l.legacyKey}
        queryKey={ledgerQueryKey(l)}
        sort={l.previewSort}
        attention={attention}
        columns={columns.filter((c) => c.main)}
        rowKey={(r: { id: string }) => r.id}
        viewAll={ledgerPath(id)}
        empty={<EmptyState title={`No ${l.noun} tracked`} />}
      />
    );
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
              <InfoButton label="scanning">
                Scanning detects findings idempotently, then auto-remediates any that a policy permits
                (audited) — everything else waits for a governed remediation.
              </InfoButton>
            </div>
          </div>
        </Card>

        <Tabs
          tabs={[
            { id: "ledgers", label: "Ledgers" },
            { id: "setup", label: ["Set up", ...setupNotes].join(" · ") },
          ]}
          active={tab}
          idPrefix="infra"
          label="Infrastructure sections"
          onChange={setTab}
        />
        <div role="tabpanel" id={panel.panel} aria-labelledby={panel.tab} className={v.stack}>
          {tab === "ledgers" ? (
            <>
                {preview("findings", findingColumns() as Array<DataColumn<never>>, [{ label: "open", count: posture.data ? (p.open ?? 0) : null }])}
                {preview("certificates", tlsLedgerColumns() as Array<DataColumn<never>>)}
                {preview("patches", patchColumns() as Array<DataColumn<never>>)}

                {preview("backups", backupColumns() as Array<DataColumn<never>>, [{ label: "missed", count: posture.data ? (p.backup?.missed ?? 0) : null }])}
                {preview("resources", resourceColumns() as Array<DataColumn<never>>)}
            </>
          ) : (
            <>
                <RegisterResourceCard />
                <PolicyCard resources={resources.data?.resources ?? []} policies={policies.data?.policies ?? []} loading={policies.isLoading} />
                <Card title="Remediation approver">
                  <div className={v.stack}>
                    {proposals.approverField}
                    {proposals.errorLine}
                    <p className={v.faint}>{PROPOSAL_NOTE}</p>
                  </div>
                </Card>
                {/* O5 (migration 0045): scheduled backup verification, on by default (ADR-0181) */}
                <OrgSettingsCard title="Backup verification" keys={["backupVerifyEnabled", "backupVerifyIntervalHours"]} testId="backup-verify-settings" />

            </>
          )}
        </div>
      </div>
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
          <Input required value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="for example control-plane-gateway" />
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
      <div className={v.row}>
        <Badge
          tone="warn"
          info={
            <p>
              Only 'mock' executes today (keyless, deterministic); aws/azure/gcp are interface-ready and 501 on
              scan. Classifications cascade backup-retention / patch-cadence floors onto the resource.
            </p>
          }
        >
          Mock executor only
        </Badge>
      </div>
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
  // a retired resource takes no new policy (ADR-0208 G8), so only active ones are offered
  const rOpts = props.resources.filter((r) => r.status === "active").map((r) => ({ v: r.id, l: `${r.name} · ${r.kind}` }));
  const nameOf = new Map(props.resources.map((r) => [r.id, r.name]));
  const scopeLabel = (resourceId: string | null) => (resourceId ? (nameOf.get(resourceId) ?? "resource") : "fleet-wide");
  // the fallback a policy retirement states: the ACTIVE fleet policy
  const fleet = props.policies.find((x) => x.resourceId == null && x.status === "active");
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
        <Field label="Resource (blank = fleet-wide)" helpLabel="resource scope" help={<p>A resource-scoped policy overrides the fleet-wide default.</p>}>
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
          <Input value={f.backupSchedule} onChange={(e) => set("backupSchedule", e.target.value)} placeholder="for example daily-0200" />
        </Field>
        <Field label="Backup retention days">
          <Input type="number" value={f.backupRetentionDays} onChange={(e) => set("backupRetentionDays", e.target.value)} />
        </Field>
        <Field label="Auto-remediate ceiling" help={<p>The auto-remediate ceiling cannot be 'critical' — every critical finding is always approval-gated.</p>}>
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
      <Table<InfraPolicy>
        columns={[
          {
            key: "scope",
            header: "Scope",
            render: (p) => (
              <span className={v.row}>
                {scopeLabel(p.resourceId)}
                {p.status === "retired" && <Badge tone="neutral">retired</Badge>}
              </span>
            ),
          },
          { key: "patch", header: "Patch cadence (d)", align: "right", render: (p) => p.patchCadenceDays ?? "—" },
          { key: "cert", header: "Cert window (d)", align: "right", render: (p) => p.certRotationDaysBeforeExpiry ?? "—" },
          { key: "schedule", header: "Backup schedule", render: (p) => p.backupSchedule ?? "—" },
          { key: "retention", header: "Backup retention (d)", align: "right", render: (p) => p.backupRetentionDays ?? "—" },
          { key: "auto", header: "Auto ceiling", render: (p) => p.autoRemediateMaxSeverity ?? "never" },
          {
            key: "actions",
            header: "Actions",
            render: (p) => (
              <PolicyActions policy={p} fleet={fleet} resourceName={scopeLabel(p.resourceId)} />
            ),
          },
        ]}
        rows={props.policies}
        rowKey={(p) => p.id}
        loading={props.loading}
        empty={<EmptyState title="No policies set" />}
      />
    </Card>
  );
}
