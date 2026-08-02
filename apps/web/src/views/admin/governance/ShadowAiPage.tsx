/**
 * Shadow-AI discovery (ADR-0055).
 *
 * Four things this page exists to keep honest, RENDERED rather than merely
 * documented:
 *
 *  - **No collector ships.** The coverage scorecard's own `statement` is
 *    printed at the top of the inventory, so a number can never appear without
 *    the caveat that it derives from evidence the customer supplied.
 *  - **The catalogue is data.** It is edited here, as rows, with `provenance`
 *    and `lastUpdatedAt` on every one — so an admin can see how fresh their
 *    detection surface is and add a private in-house endpoint without a release.
 *  - **Detection is signal, not proof.** Every finding carries a disposition
 *    the operator sets (`sanctioned`, `false_positive`, …) with a required
 *    reason. There is no "resolve" button that silences a row without a record.
 *  - **A finding points at its replacement.** The governed agent that would
 *    replace the ungoverned usage is on the row, because a finding without one
 *    is a complaint rather than a next step.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table, Textarea } from "../../../ui/kit";
import { QueryGate, Stat, useAction } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

interface Signature {
  id: string;
  provider: string;
  kind: string;
  value: string;
  matchType: string;
  minLength: number | null;
  replacementAgentId: string | null;
  replacementNote: string | null;
  provenance: string;
  enabled: boolean;
  lastUpdatedAt: string;
}
interface CatalogueResponse {
  signatures: Signature[];
  total: number;
  enabled: number;
  oldestEntryAt: string | null;
  posture: string;
}
interface Finding {
  id: string;
  subjectKind: string;
  subject: string;
  provider: string;
  signalSources: string[];
  severity: string;
  confidence: string;
  disposition: string;
  observationCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  replacementAgent: { id: string; name: string; provider: string; enabled: boolean } | null;
  replacementNote: string | null;
  dispositionStale: boolean;
}
interface FindingsResponse {
  findings: Finding[];
  coverage: {
    sources: Array<{ kind: string; on: boolean; imports: number; rows: number; whatItSees: string; whatItMisses: string }>;
    sourcesOn: number;
    sourcesPossible: number;
    statement: string;
  };
  posture: string;
}
interface ImportRow {
  id: string;
  kind: string;
  mode: string;
  status: string;
  rowCount: number;
  reason: string;
  createdAt: string;
}

const SEVERITY_TONE: Record<string, "danger" | "warn" | "info" | "neutral"> = {
  critical: "danger",
  high: "warn",
  medium: "info",
  low: "neutral",
};

const EXAMPLE = JSON.stringify(
  {
    kind: "egress_log",
    mode: "dry_run",
    source: "acme forward proxy, week 31",
    rows: [{ observedAt: "2026-07-28T09:00:00Z", destinationHost: "api.openai.com", sourceIdentity: "build-runner-01", requestCount: 412 }],
  },
  null,
  2,
);

export default function ShadowAiPage() {
  const catalogue = useQuery({ queryKey: ["shadow-ai", "catalogue"], queryFn: () => api.get<CatalogueResponse>("/v1/shadow-ai/catalogue") });
  const findings = useQuery({ queryKey: ["shadow-ai", "findings"], queryFn: () => api.get<FindingsResponse>("/v1/shadow-ai/findings") });
  const imports = useQuery({ queryKey: ["shadow-ai", "imports"], queryFn: () => api.get<{ imports: ImportRow[] }>("/v1/shadow-ai/imports") });
  const act = useAction();

  const [evidence, setEvidence] = useState(EXAMPLE);
  const [preview, setPreview] = useState<unknown>(null);
  const [dispositionFor, setDispositionFor] = useState<string | null>(null);
  const [disposition, setDisposition] = useState("sanctioned");
  const [reason, setReason] = useState("");

  const refresh = () => {
    void catalogue.refetch();
    void findings.refetch();
    void imports.refetch();
  };

  const bySeverity = useMemo(() => {
    const out: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of findings.data?.findings ?? []) out[f.severity] = (out[f.severity] ?? 0) + 1;
    return out;
  }, [findings.data]);

  const submitEvidence = async (mode: "dry_run" | "apply") => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(evidence) as Record<string, unknown>;
    } catch {
      act.setError("that is not valid JSON");
      return;
    }
    const ok = await act.run(async () => {
      const res = await api.post<unknown>("/v1/shadow-ai/imports", { ...parsed, mode });
      setPreview(res);
    }, mode === "dry_run" ? "Evidence analyzed (nothing written)" : "Evidence applied to the inventory");
    if (ok) refresh();
  };

  return (
    <>
      <PageHeader
        title="Shadow-AI discovery"
        sub="Inventory ungoverned LLM usage from evidence you already have — and pull it into governance."
      />

      <Card title="What this does, and what it cannot do">
        <p className={v.faint}>
          RegulAIt ships no collector. Everything below analyzes evidence you export and upload.
        </p>
        <p className={v.dim}>{findings.data?.coverage.statement ?? "Loading coverage…"}</p>
        <p className={v.dim}>{findings.data?.posture}</p>
      </Card>

      <div className={a.statRow}>
        <Stat value={bySeverity.critical} label="Critical (leaked credential)" />
        <Stat value={bySeverity.high} label="High (observed model traffic)" />
        <Stat value={(bySeverity.medium ?? 0) + (bySeverity.low ?? 0)} label="Medium / low" />
        <Stat
          value={`${findings.data?.coverage.sourcesOn ?? 0} / ${findings.data?.coverage.sourcesPossible ?? 4}`}
          label="Evidence classes supplied"
        />
      </div>

      <Card title="Coverage scorecard">
        <p className={v.faint}>Gaps are shown, never papered over.</p>
        <QueryGate loading={findings.isLoading} error={findings.error} onRetry={refresh}>
          <Table<FindingsResponse["coverage"]["sources"][number]>
            rows={findings.data?.coverage.sources ?? []}
            rowKey={(r) => r.kind}
            columns={[
              { key: "evidence_class", header: "Evidence class", render: (r) => <code>{r.kind}</code> },
              { key: "supplied", header: "Supplied", render: (r) => <Badge tone={r.on ? "ok" : "neutral"}>{r.on ? "on" : "off"}</Badge> },
              { key: "imports", header: "Imports", render: (r) => r.imports },
              { key: "rows", header: "Rows", render: (r) => r.rows },
              { key: "what_it_sees", header: "What it sees", render: (r) => <span className={v.dim}>{r.whatItSees}</span> },
              { key: "what_it_misses", header: "What it misses", render: (r) => <span className={v.dim}>{r.whatItMisses}</span> },
            ]}
          />
        </QueryGate>
      </Card>

      <Card title="Import evidence">
        <p className={v.faint}>
          An evidence file is untrusted input: size-bounded, schema-checked, and refused outright if it carries a
          governance-shaped field. The most it can ever do is write findings.
        </p>
        <Field label="Evidence JSON" grow>
          <Textarea rows={10} value={evidence} onChange={(e) => setEvidence(e.target.value)} spellCheck={false} />
        </Field>
        {act.error ? <p className={v.errLine}>{act.error}</p> : null}
        <div className={v.row}>
          <Button disabled={act.busy} onClick={() => void submitEvidence("dry_run")}>
            Analyze (dry run)
          </Button>
          <Button variant="primary" disabled={act.busy} onClick={() => void submitEvidence("apply")}>
            Apply to inventory
          </Button>
        </div>
        {preview ? (
          <pre className={v.mono}>{JSON.stringify(preview, null, 2)}</pre>
        ) : null}
      </Card>

      <Card title="Inventory">
        <p className={v.faint}>Every row is a lead for triage, not a verdict.</p>
        <QueryGate loading={findings.isLoading} error={findings.error} onRetry={refresh}>
          {(findings.data?.findings.length ?? 0) === 0 ? (
            <EmptyState title="No findings yet" body="Import an egress-log, code-scan, SaaS or self-reported evidence file above." />
          ) : (
            <Table<Finding>
              rows={findings.data?.findings ?? []}
              rowKey={(r) => r.id}
              columns={[
                { key: "severity", header: "Severity", render: (r) => <Badge tone={SEVERITY_TONE[r.severity] ?? "neutral"}>{r.severity}</Badge> },
                { key: "subject", header: "Subject", render: (r) => <span title={r.subjectKind}>{r.subject}</span> },
                { key: "provider", header: "Provider", render: (r) => r.provider },
                { key: "sources", header: "Sources", render: (r) => r.signalSources.join(", ") },
                { key: "confidence", header: "Confidence", render: (r) => r.confidence },
                { key: "observations", header: "Observations", render: (r) => r.observationCount },
                { key: "last_seen", header: "Last seen", render: (r) => ago(r.lastSeenAt) },
                {
                  key: "replacement",
                  header: "Governed replacement",
                  render: (r) =>
                    r.replacementAgent ? (
                      <Badge tone="ok">{r.replacementAgent.name}</Badge>
                    ) : (
                      <span className={v.dim}>{r.replacementNote ?? "none registered"}</span>
                    ),
                },
                {
                  key: "disposition",
                  header: "Disposition",
                  render: (r) => (
                    <>
                      <Badge tone={r.disposition === "open" ? "warn" : "neutral"}>{r.disposition}</Badge>
                      {r.dispositionStale ? <Badge tone="danger">seen again since</Badge> : null}
                    </>
                  ),
                },
                {
                  key: "triage",
                  header: "",
                  render: (r) => (
                    <Button onClick={() => { setDispositionFor(r.id); setReason(""); }}>Triage</Button>
                  ),
                },
              ]}
            />
          )}
        </QueryGate>

        {dispositionFor ? (
          <Card title="Record a disposition">
            <p className={v.faint}>
              Moving a finding off &lsquo;open&rsquo; requires a reason — a later reviewer has to be able to audit the
              judgement.
            </p>
            <Field label="Disposition">
              <Select value={disposition} onChange={(e) => setDisposition(e.target.value)}>
                {["confirmed", "sanctioned", "false_positive", "remediated", "open"].map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </Select>
            </Field>
            <Field label="Reason">
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="why this judgement" />
            </Field>
            <div className={v.row}>
              <Button
                variant="primary"
                disabled={act.busy}
                onClick={() =>
                  void act
                    .run(
                      () =>
                        api.post(`/v1/shadow-ai/findings/${dispositionFor}/disposition`, {
                          disposition,
                          ...(reason.trim() ? { reason: reason.trim() } : {}),
                        }),
                      "Disposition recorded",
                    )
                    .then((ok) => {
                      if (ok) {
                        setDispositionFor(null);
                        refresh();
                      }
                    })
                }
              >
                Record
              </Button>
              <Button onClick={() => setDispositionFor(null)}>Cancel</Button>
            </div>
          </Card>
        ) : null}
      </Card>

      <Card title="Detection catalogue">
        <p className={v.faint}>{catalogue.data?.posture ?? ""}</p>
        <QueryGate loading={catalogue.isLoading} error={catalogue.error} onRetry={refresh}>
          <div className={v.row}>
            <Button
              disabled={act.busy}
              onClick={() => void act.run(() => api.post("/v1/shadow-ai/catalogue/seed", {}), "Seed installed").then((ok) => ok && refresh())}
            >
              Install / refresh shipped seed
            </Button>
          </div>
          <Table<Signature>
            rows={catalogue.data?.signatures ?? []}
            rowKey={(r) => r.id}
            columns={[
              { key: "provider", header: "Provider", render: (r) => r.provider },
              { key: "kind", header: "Kind", render: (r) => <code>{r.kind}</code> },
              { key: "value", header: "Value", render: (r) => <code>{r.value}</code> },
              { key: "match", header: "Match", render: (r) => r.matchType + (r.minLength ? ` (≥${r.minLength})` : "") },
              { key: "provenance", header: "Provenance", render: (r) => r.provenance },
              { key: "updated", header: "Updated", render: (r) => ago(r.lastUpdatedAt) },
              { key: "enabled", header: "Enabled", render: (r) => <Badge tone={r.enabled ? "ok" : "neutral"}>{r.enabled ? "yes" : "no"}</Badge> },
              {
                key: "remove",
                header: "",
                render: (r) => (
                  <Button
                    disabled={act.busy}
                    onClick={() => void act.run(() => api.del(`/v1/shadow-ai/catalogue/${r.id}`), "Signature removed").then((ok) => ok && refresh())}
                  >
                    Remove
                  </Button>
                ),
              },
            ]}
          />
        </QueryGate>
      </Card>

      <Card title="Import history">
        <p className={v.faint}>
          Including refusals — an evidence file that tried to carry a privilege field is recorded, not discarded.
        </p>
        <QueryGate loading={imports.isLoading} error={imports.error} onRetry={refresh}>
          <Table<ImportRow>
            rows={imports.data?.imports ?? []}
            rowKey={(r) => r.id}
            columns={[
              { key: "when", header: "When", render: (r) => ago(r.createdAt) },
              { key: "kind", header: "Kind", render: (r) => <code>{r.kind}</code> },
              { key: "mode", header: "Mode", render: (r) => r.mode },
              { key: "status", header: "Status", render: (r) => <Badge tone={r.status === "refused" ? "danger" : "ok"}>{r.status}</Badge> },
              { key: "rows", header: "Rows", render: (r) => r.rowCount },
              { key: "outcome", header: "Outcome", render: (r) => <span className={v.dim}>{r.reason}</span> },
            ]}
          />
        </QueryGate>
      </Card>
    </>
  );
}
