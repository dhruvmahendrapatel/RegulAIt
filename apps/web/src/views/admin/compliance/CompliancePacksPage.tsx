/**
 * Regulatory compliance packs (ADR-0058).
 *
 * Four things this page exists to keep honest, RENDERED rather than merely
 * documented:
 *
 *  - **A control-mapping report is not a certification.** The disclaimer the
 *    API returns on every scorecard is printed at the top of the page and again
 *    beside the scorecard itself. There is no "compliant" badge on this page
 *    because there is no such field in the payload to render.
 *  - **Packs are data.** They are listed as versioned rows with provenance, and
 *    a new framework — including a customer's own internal control set — is
 *    authored here as JSON and evaluated with no release.
 *  - **Evidence is counted, not ticked.** Each control shows the collector that
 *    produced its number and the threshold it was compared against. There is no
 *    control on this page an admin can mark as met.
 *  - **Organisational controls stop at the platform edge.** Attestation-required
 *    controls are rendered in their own tone, never as satisfied, and their
 *    owner note says what the customer has to do instead.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Select, Table, Textarea } from "../../../ui/kit";
import { QueryGate, Stat, useAction } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

interface Pack {
  id: string;
  framework: string;
  version: number;
  title: string;
  description: string | null;
  provenance: Record<string, unknown>;
  cascadeTag: string | null;
  status: string;
  controlCount: number;
  activatedAt: string | null;
  retiredAt: string | null;
}
interface PacksResponse {
  packs: Pack[];
  updatePolicy: string;
  disclaimer: string;
}
interface ControlAssessment {
  controlRef: string;
  title: string;
  coverage: string;
  collector: string;
  status: string;
  evidenceCount: number | null;
  minEvidenceCount: number;
  attestationRequired: boolean;
  note: string;
}
interface Scorecard {
  framework: string;
  packVersion: number;
  packTitle: string;
  cascadeTag: string | null;
  period: { label: string };
  totals: {
    controls: number;
    satisfied: number;
    unsatisfied: number;
    attested: number;
    attestationRequired: number;
    unaddressed: number;
    declaredEnforced: number;
  };
  controls: ControlAssessment[];
  statement: string;
  disclaimer: string;
  updatePolicy: string;
}

const STATUS_TONE: Record<string, "ok" | "warn" | "danger" | "info" | "neutral"> = {
  satisfied: "ok",
  attested: "info",
  unsatisfied: "danger",
  attestation_required: "warn",
  unaddressed: "neutral",
};

const EXAMPLE = JSON.stringify(
  {
    framework: "acme-internal-ai-standard",
    version: 1,
    title: "ACME internal AI standard",
    provenance: { source: "ACME GRC team", catalogueRevision: "2026.1" },
    cascadeTag: null,
    controls: [
      {
        controlRef: "acme:1.1",
        title: "Every governed decision is recorded",
        coverage: "enforced",
        collector: "audit_decisions",
        collectorParams: {},
        minEvidenceCount: 1,
        attestationRequired: false,
      },
      {
        controlRef: "acme:9.9",
        title: "Staff operating the system are trained",
        coverage: "unaddressed",
        collector: "none",
        collectorParams: {},
        attestationRequired: true,
        ownerNote: "Training records live in the LMS, not here.",
      },
    ],
  },
  null,
  2,
);

export default function CompliancePacksPage() {
  const packs = useQuery({
    queryKey: ["compliance-packs"],
    queryFn: () => api.get<PacksResponse>("/v1/compliance/packs"),
  });
  const act = useAction();

  const [draft, setDraft] = useState(EXAMPLE);
  const [scorecard, setScorecard] = useState<Scorecard | null>(null);
  const [period, setPeriod] = useState("current_quarter");

  const refresh = () => void packs.refetch();

  const seed = async () => {
    const ok = await act.run(
      () => api.post<unknown>("/v1/compliance/packs/seed", {}),
      "Launch packs installed as rows (draft — activate the one you report against)",
    );
    if (ok) refresh();
  };

  const create = async () => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(draft) as Record<string, unknown>;
    } catch {
      act.setError("that is not valid JSON");
      return;
    }
    const ok = await act.run(
      () => api.post<unknown>("/v1/compliance/packs", parsed),
      "Pack authored as data — no release needed",
    );
    if (ok) refresh();
  };

  const activate = async (p: Pack) => {
    const ok = await act.run(
      () => api.post<unknown>(`/v1/compliance/packs/${p.id}/activate`, {}),
      `${p.framework} v${p.version} activated; any previous version is retired`,
    );
    if (ok) refresh();
  };

  const evaluate = async (p: Pack) => {
    await act.run(async () => {
      const res = await api.post<{ scorecard: Scorecard }>(`/v1/compliance/packs/${p.id}/evaluate`, {
        scopeKind: "org",
        entitlementScope: "org",
        period,
      });
      setScorecard(res.scorecard);
    }, "Scorecard computed from the ledgers");
  };

  return (
    <>
      <PageHeader
        title="Compliance packs"
        sub="Framework control mappings, evidenced from your own ledgers — an accelerator, not a certification."
      />

      <Card title="What a pack is, and what it is not">
        <p className={v.faint}>
          A pack maps a framework's controls onto RegulAIt configuration and counts the evidence this
          deployment's own ledgers hold. It does not certify compliance and does not substitute for an
          auditor or for counsel.
        </p>
        <p className={v.dim}>{packs.data?.disclaimer}</p>
        <p className={v.dim}>{packs.data?.updatePolicy}</p>
      </Card>

      <Card title="Packs">
        <p className={v.faint}>
          Versioned rows, not a build artifact. A framework revision is a new version, activated — which
          retires the previous one. Reports keep the version that produced them.
        </p>
        <div className={v.row}>
          <Button disabled={act.busy} onClick={() => void seed()}>
            Install the launch packs
          </Button>
          <Field label="Evaluation period">
            <Select value={period} onChange={(e) => setPeriod(e.target.value)}>
              <option value="current_month">Current month</option>
              <option value="last_month">Last month</option>
              <option value="current_quarter">Current quarter</option>
              <option value="last_quarter">Last quarter</option>
              <option value="last_30_days">Last 30 days</option>
            </Select>
          </Field>
        </div>
        {act.error ? <p className={v.errLine}>{act.error}</p> : null}
        <QueryGate loading={packs.isLoading} error={packs.error} onRetry={refresh}>
          {(packs.data?.packs ?? []).length === 0 ? (
            <EmptyState title="No packs yet" body="Install the launch packs, or author your own below." />
          ) : (
            <Table<Pack>
              rows={packs.data?.packs ?? []}
              rowKey={(p) => p.id}
              columns={[
                { key: "framework", header: "Framework", render: (p) => <code>{p.framework}</code> },
                { key: "version", header: "Version", render: (p) => `v${p.version}` },
                { key: "title", header: "Title", render: (p) => <span className={v.dim}>{p.title}</span> },
                { key: "controls", header: "Controls", render: (p) => p.controlCount },
                {
                  key: "cascade",
                  header: "Cascade tag",
                  render: (p) =>
                    p.cascadeTag ? <code>{p.cascadeTag}</code> : <span className={v.faint}>evidence only</span>,
                },
                {
                  key: "status",
                  header: "Status",
                  render: (p) => (
                    <Badge tone={p.status === "active" ? "ok" : p.status === "retired" ? "neutral" : "info"}>
                      {p.status}
                    </Badge>
                  ),
                },
                {
                  key: "actions",
                  header: "",
                  render: (p) => (
                    <div className={v.row}>
                      {p.status !== "active" ? (
                        <Button disabled={act.busy} onClick={() => void activate(p)}>
                          Activate
                        </Button>
                      ) : null}
                      <Button variant="primary" disabled={act.busy} onClick={() => void evaluate(p)}>
                        Evaluate
                      </Button>
                    </div>
                  ),
                },
              ]}
            />
          )}
        </QueryGate>
      </Card>

      {scorecard ? (
        <Card title={`Scorecard — ${scorecard.framework} v${scorecard.packVersion} (${scorecard.period.label})`}>
          {/* NO "compliant" badge here, because the payload has no such field. */}
          <p className={v.dim}>{scorecard.statement}</p>
          <div className={a.statRow}>
            <Stat value={scorecard.totals.satisfied} label="Evidenced from the ledgers" />
            <Stat value={scorecard.totals.unsatisfied} label="No evidence in the period" />
            <Stat value={scorecard.totals.attestationRequired} label="Attestation outstanding" />
            <Stat value={scorecard.totals.attested} label="Attested (customer's own statement)" />
            <Stat value={scorecard.totals.unaddressed} label="Not addressed by platform config" />
          </div>
          <Table<ControlAssessment>
            rows={scorecard.controls}
            rowKey={(c) => c.controlRef}
            columns={[
              { key: "ref", header: "Control", render: (c) => <code>{c.controlRef}</code> },
              { key: "title", header: "Title", render: (c) => <span className={v.dim}>{c.title}</span> },
              {
                key: "status",
                header: "Status",
                render: (c) => <Badge tone={STATUS_TONE[c.status] ?? "neutral"}>{c.status}</Badge>,
              },
              {
                key: "evidence",
                header: "Evidence",
                render: (c) =>
                  c.evidenceCount === null ? (
                    <span className={v.faint}>not auto-evidenced</span>
                  ) : (
                    `${c.evidenceCount} / ${c.minEvidenceCount}`
                  ),
              },
              { key: "collector", header: "Collector", render: (c) => <code>{c.collector}</code> },
              { key: "note", header: "Note", render: (c) => <span className={v.dim}>{c.note}</span> },
            ]}
          />
          <p className={v.faint}>{scorecard.disclaimer}</p>
        </Card>
      ) : null}

      <Card title="Author a pack">
        <p className={v.faint}>
          A pack is data. Your own internal control framework is a first-class pack authored with the same
          schema — no code change, no release. Collectors are a fixed vocabulary over ledgers that already
          exist; a control needing a ledger RegulAIt does not keep must be marked attestation-required
          rather than silently reported as satisfied.
        </p>
        <Field label="Pack JSON" grow>
          <Textarea rows={14} value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
        </Field>
        <div className={v.row}>
          <Button variant="primary" disabled={act.busy} onClick={() => void create()}>
            Create pack (draft)
          </Button>
        </div>
      </Card>
    </>
  );
}
