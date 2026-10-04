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
import { QueryGate, RemoveButton, Stat, useAction } from "../adminKit";
import { packRatios, pctText } from "./packRatios";
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
interface DiffFieldChange {
  field: string;
  from: unknown;
  to: unknown;
}
interface DiffControlSummary {
  controlRef: string;
  title: string;
  coverage: string;
  collector: string;
  minEvidenceCount: number;
  attestationRequired: boolean;
}
interface ImpactControl {
  controlRef: string;
  title: string;
  definitionChange: "added" | "removed" | "changed" | "unchanged";
  fromStatus: string | null;
  toStatus: string | null;
  fromEvidenceCount: number | null;
  toEvidenceCount: number | null;
  moved: boolean;
  detail: string | null;
}
interface DiffResponse {
  framework: string;
  from: { version: number; title: string; status: string };
  to: { version: number; title: string; status: string };
  diff: {
    packChanges: DiffFieldChange[];
    cascadeTagChange: {
      from: string | null;
      to: string | null;
      consequence: string;
      note: string;
    } | null;
    controlsAdded: DiffControlSummary[];
    controlsRemoved: DiffControlSummary[];
    controlsChanged: Array<{ controlRef: string; title: string; fields: DiffFieldChange[] }>;
    summary: {
      controlsAdded: number;
      controlsRemoved: number;
      controlsChanged: number;
      controlsUnchanged: number;
      packFieldsChanged: number;
      cascadeTagChanged: boolean;
    };
    identical: boolean;
  };
  impact: {
    period: { label: string };
    controls: ImpactControl[];
    statusesMoved: number;
    evaluationIdentical: boolean;
    note: string;
  };
  disclaimer: string;
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

/** render a diffed before/after value: scalars as text, objects as JSON, nullish as a dash */
function showValue(x: unknown): string {
  if (x === null || x === undefined) return "—";
  if (typeof x === "object") return JSON.stringify(x);
  return String(x);
}

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

/** ADR-0175 — coverage beside pass rate, from the totals the API already returns */
function ScorecardRatios({ totals }: { totals: Scorecard["totals"] }) {
  const r = packRatios(totals);
  return (
    <>
      <div className={a.statRow} data-testid="pack-ratios">
        <Stat
          value={`${r.withEvidence} / ${r.mapped}`}
          label={`Coverage ${pctText(r.coveragePct)}: mapped controls a ledger collector checks`}
        />
        <Stat
          value={r.withEvidence > 0 ? `${r.passing} / ${r.withEvidence}` : "—"}
          label={`Passing ${pctText(r.passingPct)}: of those, met their threshold this period`}
        />
      </div>
      <p className={v.faint}>
        Read the two together. Passing counts only controls with evidence; the rest of the mapped
        controls are attestation-only or not addressed by platform configuration, so they lower coverage,
        never the pass rate.
      </p>
    </>
  );
}

export default function CompliancePacksPage() {
  const packs = useQuery({
    queryKey: ["compliance-packs"],
    queryFn: () => api.get<PacksResponse>("/v1/compliance/packs"),
  });
  const act = useAction();

  const [draft, setDraft] = useState(EXAMPLE);
  const [scorecard, setScorecard] = useState<Scorecard | null>(null);
  const [diffView, setDiffView] = useState<DiffResponse | null>(null);
  const [period, setPeriod] = useState("current_quarter");

  /** the active version per framework — what a draft/retired version is
   * reviewed AGAINST */
  const activeVersionOf = (framework: string) =>
    (packs.data?.packs ?? []).find((p) => p.framework === framework && p.status === "active")
      ?.version ?? null;

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

  const diffAgainstActive = async (p: Pack) => {
    const activeVersion = activeVersionOf(p.framework);
    if (activeVersion === null) return;
    await act.run(async () => {
      const res = await api.get<DiffResponse>(
        `/v1/compliance-packs/${encodeURIComponent(p.framework)}/diff?from=${activeVersion}&to=${p.version}&period=${period}`,
      );
      setDiffView(res);
    }, "Diff computed — read-only, nothing activated");
  };

  return (
    <>
      <PageHeader
        title="Compliance packs"
        sub="Framework control mappings, evidenced from your own ledgers — an accelerator, not a certification."
      />

      <Card title="What a pack is, and what it is not">
        <p className={v.faint}>
          A pack maps a framework's controls onto regulAIt configuration and counts the evidence this
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
                  render: (p) => {
                    const activeVersion = activeVersionOf(p.framework);
                    return (
                      <div className={v.row}>
                        {p.status !== "active" ? (
                          <Button disabled={act.busy} onClick={() => void activate(p)}>
                            Activate
                          </Button>
                        ) : null}
                        {activeVersion !== null && activeVersion !== p.version ? (
                          <Button disabled={act.busy} onClick={() => void diffAgainstActive(p)}>
                            Diff vs active
                          </Button>
                        ) : null}
                        <Button variant="primary" disabled={act.busy} onClick={() => void evaluate(p)}>
                          Evaluate
                        </Button>
                        <RemoveButton
                          what={`${p.framework} v${p.version}`}
                          // An ACTIVE pack is the one composing the cascade right
                          // now. Deleting it is not the same act as deleting a
                          // draft, so it is not offered: retire it first, which
                          // is a reversible, audited state change, and then the
                          // delete is an ordinary cleanup.
                          disabledReason={
                            p.status === "active"
                              ? "this version is active — retire it (or activate another version) before deleting, so the cascade is never left without a pack mid-change"
                              : undefined
                          }
                          consequence={
                            <p>
                              The pack definition and its controls are deleted.{" "}
                              {p.cascadeTag ? (
                                <>
                                  It carries the cascade tag <code>{p.cascadeTag}</code>, so anything
                                  tagged with it loses the stages, retention and data-scope defaults
                                  this pack contributed — unless another active pack carries the same
                                  tag.{" "}
                                </>
                              ) : null}
                              Evidence already computed against it stays in the audit trail; what
                              goes is the definition future evaluations would read.
                            </p>
                          }
                          onRemove={() => api.del(`/v1/compliance/packs/${p.id}`)}
                          onDone={refresh}
                        />
                      </div>
                    );
                  },
                },
              ]}
            />
          )}
        </QueryGate>
      </Card>

      {diffView ? (
        <Card
          title={`What v${diffView.to.version} changes — ${diffView.framework} v${diffView.from.version} → v${diffView.to.version}`}
        >
          <p className={v.faint}>
            Read-only review: nothing has been activated. Activation is not gated on this view — it
            exists so the decision is informed, not so a page-load can stand in for diligence. The
            activation audit records whether this from→to diff was computed.
          </p>

          {/* THE UNMISSABLE FLAG: a cascadeTag change is §8.3 enforcement reach, not prose. */}
          {diffView.diff.cascadeTagChange ? (
            <div className={`${a.effectBanner} ${a.effectBannerDeny}`}>
              <span className={a.effectWord}>Cascade tag change</span>
              <div>
                <p>
                  <code>{diffView.diff.cascadeTagChange.from ?? "(none)"}</code>
                  {" → "}
                  <code>{diffView.diff.cascadeTagChange.to ?? "(none)"}</code>{" "}
                  <Badge tone="danger">HIGH consequence</Badge>
                </p>
                <p className={v.dim}>{diffView.diff.cascadeTagChange.note}</p>
              </div>
            </div>
          ) : null}

          {diffView.diff.identical ? (
            <p className={v.dim}>
              The two versions are <strong>identical</strong> — this revision changes no mapping.
            </p>
          ) : (
            <>
              <div className={a.statRow}>
                <Stat value={diffView.diff.summary.controlsAdded} label="Controls added" />
                <Stat value={diffView.diff.summary.controlsRemoved} label="Controls removed" />
                <Stat value={diffView.diff.summary.controlsChanged} label="Controls changed" />
                <Stat value={diffView.diff.summary.controlsUnchanged} label="Unchanged" />
              </div>

              {diffView.diff.packChanges.length ? (
                <Table<DiffFieldChange>
                  rows={diffView.diff.packChanges}
                  rowKey={(c) => `pack-${c.field}`}
                  columns={[
                    { key: "field", header: "Pack field", render: (c) => <code>{c.field}</code> },
                    { key: "from", header: "Was", render: (c) => <span className={v.dim}>{showValue(c.from)}</span> },
                    { key: "to", header: "Becomes", render: (c) => showValue(c.to) },
                  ]}
                />
              ) : null}

              {diffView.diff.controlsAdded.length || diffView.diff.controlsRemoved.length ? (
                <Table<DiffControlSummary & { kind: string }>
                  rows={[
                    ...diffView.diff.controlsAdded.map((c) => ({ ...c, kind: "added" })),
                    ...diffView.diff.controlsRemoved.map((c) => ({ ...c, kind: "removed" })),
                  ]}
                  rowKey={(c) => `${c.kind}-${c.controlRef}`}
                  columns={[
                    {
                      key: "kind",
                      header: "",
                      render: (c) => <Badge tone={c.kind === "added" ? "info" : "warn"}>{c.kind}</Badge>,
                    },
                    { key: "ref", header: "Control", render: (c) => <code>{c.controlRef}</code> },
                    { key: "title", header: "Title", render: (c) => <span className={v.dim}>{c.title}</span> },
                    { key: "coverage", header: "Declared coverage", render: (c) => c.coverage },
                    { key: "collector", header: "Collector", render: (c) => <code>{c.collector}</code> },
                    { key: "min", header: "Threshold", render: (c) => c.minEvidenceCount },
                  ]}
                />
              ) : null}

              {diffView.diff.controlsChanged.map((c) => (
                <div key={c.controlRef}>
                  <p>
                    <Badge tone="info">changed</Badge> <code>{c.controlRef}</code>{" "}
                    <span className={v.dim}>{c.title}</span>
                  </p>
                  <Table<DiffFieldChange>
                    rows={c.fields}
                    rowKey={(f) => `${c.controlRef}-${f.field}`}
                    columns={[
                      { key: "field", header: "Field", render: (f) => <code>{f.field}</code> },
                      { key: "from", header: "Was", render: (f) => <span className={v.dim}>{showValue(f.from)}</span> },
                      { key: "to", header: "Becomes", render: (f) => showValue(f.to) },
                    ]}
                  />
                </div>
              ))}
            </>
          )}

          <h3 className={v.dim}>Impact preview — computed statuses under each version, current ledgers</h3>
          <p className={v.faint}>{diffView.impact.note}</p>
          {diffView.impact.evaluationIdentical ? null : (
            <Table<ImpactControl>
              rows={diffView.impact.controls.filter((c) => c.moved || c.definitionChange !== "unchanged")}
              rowKey={(c) => c.controlRef}
              columns={[
                { key: "ref", header: "Control", render: (c) => <code>{c.controlRef}</code> },
                {
                  key: "def",
                  header: "Definition",
                  render: (c) => (
                    <Badge tone={c.definitionChange === "removed" ? "warn" : c.definitionChange === "unchanged" ? "neutral" : "info"}>
                      {c.definitionChange}
                    </Badge>
                  ),
                },
                {
                  key: "from",
                  header: `Under v${diffView.from.version}`,
                  render: (c) =>
                    c.fromStatus ? (
                      <Badge tone={STATUS_TONE[c.fromStatus] ?? "neutral"}>{c.fromStatus}</Badge>
                    ) : (
                      <span className={v.faint}>not in pack</span>
                    ),
                },
                {
                  key: "to",
                  header: `Under v${diffView.to.version}`,
                  render: (c) =>
                    c.toStatus ? (
                      <Badge tone={STATUS_TONE[c.toStatus] ?? "neutral"}>{c.toStatus}</Badge>
                    ) : (
                      <span className={v.faint}>not in pack</span>
                    ),
                },
                {
                  key: "moved",
                  header: "Would move",
                  render: (c) => (c.moved ? <Badge tone="warn">yes</Badge> : <span className={v.faint}>no</span>),
                },
                { key: "detail", header: "Detail", render: (c) => <span className={v.dim}>{c.detail ?? ""}</span> },
              ]}
            />
          )}
          <p className={v.faint}>{diffView.disclaimer}</p>
        </Card>
      ) : null}

      {scorecard ? (
        <Card title={`Scorecard — ${scorecard.framework} v${scorecard.packVersion} (${scorecard.period.label})`}>
          {/* NO "compliant" badge here, because the payload has no such field. */}
          <p className={v.dim}>{scorecard.statement}</p>
          <ScorecardRatios totals={scorecard.totals} />
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
          exist; a control needing a ledger regulAIt does not keep must be marked attestation-required
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
