/**
 * Metering & billing (ADR-0051).
 *
 * Four things this page exists to keep honest, RENDERED rather than merely
 * documented:
 *
 *  - **Nothing here meters.** Every figure is derived from `usage_events`, the
 *    ledger every governed call already writes. The page says so, and shows the
 *    ledger's own list-price estimate beside the billed number so the two are
 *    never confused for each other.
 *  - **No payment processor is integrated.** `paymentProcessorIntegrated` comes
 *    from the API and is rendered as a badge. Issuing a statement charges
 *    nobody.
 *  - **Nothing is scheduled.** A period stays open until an operator or a cron
 *    calls the close endpoint. `closedAt` staying empty is how that is visible.
 *  - **An unpriced event is UNPRICED, not zero.** The count is on the face of
 *    every statement row, because a subtotal that silently omits unpriced usage
 *    reads as a total.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago, fmtUsd } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table } from "../../../ui/kit";
import { KV, QueryGate, Stat, optionEls, projectOpts, teamOpts, useAction, useProjects, useTeams } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

interface RateCardEntry {
  dimension: string;
  matchKey: string;
  unit: string;
  unitPriceUsd: number;
}
interface RateCardRow {
  id: string;
  name: string;
  version: number;
  currency: string;
  status: string;
  createdAt: string;
}
interface PeriodRow {
  id: string;
  scopeKind: string;
  scopeId: string | null;
  periodStart: string;
  periodEnd: string;
  status: string;
  closedAt: string | null;
}
interface StatementRow {
  id: string;
  periodId: string;
  version: number;
  status: string;
  ratingMode: string;
  totalUsd: number;
  seatCount: number;
  unpricedEventCount: number;
  generatedAt: string;
  issuedAt: string | null;
}
interface ExportRow {
  id: string;
  statementId: string;
  backend: string;
  format: string;
  rowCount: number;
  exportedAt: string;
}
interface Overview {
  rateCards: RateCardRow[];
  periods: PeriodRow[];
  statements: StatementRow[];
  exports: ExportRow[];
  activeSeats: number;
  backend: { name: string; capabilities: Record<string, boolean> };
  ledger: { totalEvents: number; totalListPriceUsd: number };
  schedulerPresent: boolean;
  paymentProcessorIntegrated: boolean;
  reconciledRatingAvailable: boolean;
  disclaimer: string;
  note: string;
}
interface CutResult {
  statement: { id: string; version: number; coversFullScope: boolean };
  report: {
    periodLabel: string;
    ratingMode: string;
    usageSubtotalUsd: number;
    seatSubtotalUsd: number;
    totalUsd: number;
    disclaimer: string;
    pricing: { name: string; version: number; currency: string; entries: RateCardEntry[] };
    seats: { seatCount: number; billedUsd: number | null; note: string };
    usage: {
      eventCount: number;
      unpricedEventCount: number;
      measuredInputTokens: number;
      measuredOutputTokens: number;
      ledgerEstimatedCostUsd: number;
      lines: Array<{
        dimension: string;
        matchKey: string;
        events: number;
        inputTokens: number;
        outputTokens: number;
        billedUsd: number | null;
        unpriced: boolean;
        ledgerEstimatedUsd: number | null;
        rateNote: string;
      }>;
    };
  };
  scope: { effectiveProjectIds: string[] | null; coversFullScope: boolean; reason: string };
}
interface ReconcileResult {
  matches: boolean;
  diffs: Array<{ field: string; issued: number; rederived: number }>;
  note: string;
}

const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
const nextMonthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();

export default function BillingPage() {
  const act = useAction();
  const teams = useTeams();
  const projects = useProjects();

  const overview = useQuery({
    queryKey: ["admin", "billing-overview"],
    queryFn: () => api.get<Overview>("/v1/billing/overview"),
  });

  // --- rate card authoring ---
  const [cardName, setCardName] = useState("standard");
  const [modelKey, setModelKey] = useState("*");
  const [inPrice, setInPrice] = useState("3");
  const [outPrice, setOutPrice] = useState("15");
  const [callPrice, setCallPrice] = useState("0.01");
  const [seatPrice, setSeatPrice] = useState("40");

  // --- period authoring ---
  const now = new Date();
  const [scopeKind, setScopeKind] = useState<"org" | "team" | "project">("org");
  const [scopeId, setScopeId] = useState("");
  const [start, setStart] = useState(monthStart(now).slice(0, 10));
  const [end, setEnd] = useState(nextMonthStart(now).slice(0, 10));

  const [cut, setCut] = useState<CutResult | null>(null);
  const [recon, setRecon] = useState<ReconcileResult | null>(null);

  const o = overview.data;

  return (
    <>
      <PageHeader
        title="Metering & billing"
        sub="Invoices and rate cards, read from the one usage ledger."
        info={<p>Nothing on this page meters. Every governed agent, connector and MCP call already writes a measured row to usage_events and an estimated (list-price) row to cost_events at the point of the call; billing is a read-side consumer of that one ledger, so no number here can drift from the cost dashboard. Rate cards are immutable versions and every statement freezes the snapshot it was rated against, so changing a price cannot restate an invoice you already issued.</p>}
      />
      <div className={v.stack}>
        <QueryGate loading={overview.isLoading} error={overview.error} onRetry={() => void overview.refetch()}>
          <Card title="What this does and does not do">
            <div className={a.statRow}>
              <Stat value={o?.ledger.totalEvents ?? 0} label="metered events in the ledger" />
              <Stat value={fmtUsd(o?.ledger.totalListPriceUsd ?? 0)} label="list-price estimate (not a bill)" />
              <Stat value={o?.activeSeats ?? 0} label="active seats (ADR-0052's definition)" />
              <Stat
                value={<Badge tone={o?.paymentProcessorIntegrated ? "ok" : "warn"}>{o?.paymentProcessorIntegrated ? "yes" : "no"}</Badge>}
                label="payment processor integrated"
              />
              <Stat
                value={<Badge tone={o?.schedulerPresent ? "ok" : "warn"}>{o?.schedulerPresent ? "yes" : "no"}</Badge>}
                label="in-process scheduler"
              />
              <Stat
                value={<Badge tone={o?.reconciledRatingAvailable ? "ok" : "warn"}>{o?.reconciledRatingAvailable ? "yes" : "no"}</Badge>}
                label="provider-invoice reconciliation"
              />
            </div>
            <div className={v.faint}>{o?.note}</div>
            <div className={v.faint}>
              Backend: <strong>{o?.backend.name}</strong> — export-only, and it makes no network call of any kind.
              That is ADR-0051 §6's default for the BYOC/air-gapped motion, where there is no outbound path to a
              hosted billing system: billing is settled by an exported statement the customer transmits on their own
              schedule.
            </div>
          </Card>

          <Card title="Rate cards — immutable versions">
            <div className={v.stack}>
              <div className={a.formRow}>
                <Field label="Card name">
                  <Input value={cardName} onChange={(e) => setCardName(e.target.value)} />
                </Field>
                <Field label="Model key ('*' = all)">
                  <Input value={modelKey} onChange={(e) => setModelKey(e.target.value)} />
                </Field>
                <Field label="$ / 1k input">
                  <Input value={inPrice} onChange={(e) => setInPrice(e.target.value)} />
                </Field>
                <Field label="$ / 1k output">
                  <Input value={outPrice} onChange={(e) => setOutPrice(e.target.value)} />
                </Field>
                <Field label="$ / connector call">
                  <Input value={callPrice} onChange={(e) => setCallPrice(e.target.value)} />
                </Field>
                <Field label="$ / seat / period">
                  <Input value={seatPrice} onChange={(e) => setSeatPrice(e.target.value)} />
                </Field>
                <Field label="&nbsp;">
                  <Button
                    disabled={act.busy || !cardName}
                    onClick={() =>
                      void act.run(async () => {
                        await api.post("/v1/billing/rate-cards", {
                          name: cardName,
                          entries: [
                            { dimension: "model", matchKey: modelKey, unit: "per_1k_input_tokens", unitPriceUsd: Number(inPrice) },
                            { dimension: "model", matchKey: modelKey, unit: "per_1k_output_tokens", unitPriceUsd: Number(outPrice) },
                            { dimension: "connector", matchKey: "*", unit: "per_call", unitPriceUsd: Number(callPrice) },
                            { dimension: "seat", matchKey: "*", unit: "per_seat_month", unitPriceUsd: Number(seatPrice) },
                          ],
                        });
                        await overview.refetch();
                      }, "Rate card version created")
                    }
                  >
                    Create version
                  </Button>
                </Field>
              </div>
              <div className={v.faint}>
                A rate card is a <strong>commercial</strong> price, deliberately separate from the provider list price
                the ledger already records. Keeping them apart is what makes a rating mistake a billing bug rather
                than a corrupted meter. Cards are never edited: creating a version supersedes the previous one and
                leaves every already-cut statement exactly where it was.
              </div>
              {(o?.rateCards.length ?? 0) === 0 ? (
                <EmptyState
                  title="No rate card yet"
                  body="With no card, every event is reported UNPRICED rather than billed at zero — which is the correct answer, not a failure."
                />
              ) : (
                <Table
                  rows={o!.rateCards}
                  rowKey={(c) => c.id}
                  columns={[
                    { key: "name", header: "Name", render: (c) => c.name },
                    { key: "v", header: "Version", render: (c) => `v${c.version}` },
                    { key: "cur", header: "Currency", render: (c) => c.currency },
                    {
                      key: "st",
                      header: "Status",
                      render: (c) => <Badge tone={c.status === "active" ? "ok" : "neutral"}>{c.status}</Badge>,
                    },
                    { key: "at", header: "Created", render: (c) => ago(c.createdAt) },
                  ]}
                />
              )}
            </div>
          </Card>

          <Card title="Billing periods">
            <div className={v.stack}>
              <div className={a.formRow}>
                <Field label="Scope">
                  <Select
                    value={scopeKind}
                    onChange={(e) => {
                      setScopeKind(e.target.value as typeof scopeKind);
                      setScopeId("");
                    }}
                  >
                    <option value="org">org</option>
                    <option value="team">team</option>
                    <option value="project">project</option>
                  </Select>
                </Field>
                {scopeKind !== "org" && (
                  <Field label={scopeKind === "team" ? "Team" : "Project"}>
                    <Select value={scopeId} onChange={(e) => setScopeId(e.target.value)}>
                      {optionEls(
                        scopeKind === "team" ? teamOpts(teams.data?.teams) : projectOpts(projects.data?.projects),
                        "select…",
                      )}
                    </Select>
                  </Field>
                )}
                <Field label="Start (UTC date)">
                  <Input value={start} onChange={(e) => setStart(e.target.value)} />
                </Field>
                <Field label="End (UTC date, exclusive)">
                  <Input value={end} onChange={(e) => setEnd(e.target.value)} />
                </Field>
                <Field label="&nbsp;">
                  <Button
                    disabled={act.busy || (scopeKind !== "org" && !scopeId)}
                    onClick={() =>
                      void act.run(async () => {
                        await api.post("/v1/billing/periods", {
                          scopeKind,
                          ...(scopeKind === "org" ? {} : { scopeId }),
                          periodStart: `${start}T00:00:00.000Z`,
                          periodEnd: `${end}T00:00:00.000Z`,
                        });
                        await overview.refetch();
                      }, "Billing period opened")
                    }
                  >
                    Open period
                  </Button>
                </Field>
              </div>
              <div className={v.faint}>
                Opening a period computes nothing. There is no in-process scheduler in this deployment: an operator or
                an external cron must close a period, and closing is idempotent so driving it repeatedly cuts one
                statement, not many. A period whose <strong>closed</strong> column stays empty has never been closed —
                that is the disclosure, not an assumption that it worked.
              </div>
              {(o?.periods.length ?? 0) === 0 ? (
                <EmptyState title="No billing periods" body="A period is the window an invoice is cut for." />
              ) : (
                <Table
                  rows={o!.periods}
                  rowKey={(p) => p.id}
                  columns={[
                    { key: "scope", header: "Scope", render: (p) => p.scopeKind },
                    { key: "win", header: "Window", render: (p) => `${p.periodStart.slice(0, 10)} → ${p.periodEnd.slice(0, 10)}` },
                    {
                      key: "st",
                      header: "Status",
                      render: (p) => <Badge tone={p.status === "closed" ? "ok" : "info"}>{p.status}</Badge>,
                    },
                    {
                      key: "closed",
                      header: "Closed",
                      render: (p) => (p.closedAt ? ago(p.closedAt) : <span className={v.faint}>never</span>),
                    },
                    {
                      key: "act",
                      header: "",
                      render: (p) => (
                        <div className={a.formRow}>
                          <Button
                            size="sm"
                            onClick={() =>
                              void act.run(async () => {
                                const r = await api.post<CutResult>(`/v1/billing/periods/${p.id}/statements`, {});
                                setCut(r);
                                setRecon(null);
                                await overview.refetch();
                                return "Statement cut (draft)";
                              })
                            }
                          >
                            Cut statement
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={p.status === "closed"}
                            onClick={() =>
                              void act.run(async () => {
                                await api.post(`/v1/billing/periods/${p.id}/close`, {});
                                await overview.refetch();
                              }, "Period closed")
                            }
                          >
                            Close
                          </Button>
                        </div>
                      ),
                    },
                  ]}
                />
              )}
            </div>
          </Card>

          {cut && (
            <Card title={`Statement v${cut.statement.version} — ${cut.report.periodLabel}`}>
              <div className={v.stack}>
                <div className={a.statRow}>
                  <Stat value={fmtUsd(cut.report.usageSubtotalUsd)} label="usage subtotal" />
                  <Stat value={fmtUsd(cut.report.seatSubtotalUsd)} label={`seats (${cut.report.seats.seatCount})`} />
                  <Stat value={fmtUsd(cut.report.totalUsd)} label="total" />
                  <Stat
                    value={
                      <Badge tone={cut.report.usage.unpricedEventCount > 0 ? "warn" : "ok"}>
                        {cut.report.usage.unpricedEventCount}
                      </Badge>
                    }
                    label="UNPRICED events (not billed as zero)"
                  />
                  <Stat value={fmtUsd(cut.report.usage.ledgerEstimatedCostUsd)} label="ledger list-price estimate" />
                </div>
                <KV
                  rows={[
                    ["Rate card", `${cut.report.pricing.name} v${cut.report.pricing.version} (${cut.report.pricing.currency})`],
                    ["Rating mode", <Badge tone="info">{cut.report.ratingMode}</Badge>],
                    [
                      "Scope this version was permitted to total",
                      cut.scope.effectiveProjectIds === null
                        ? "org-wide (admin, org-scoped period)"
                        : `${cut.scope.effectiveProjectIds.length} project(s)`,
                    ],
                    [
                      "Issuable as an invoice",
                      <Badge tone={cut.scope.coversFullScope ? "ok" : "warn"}>
                        {cut.scope.coversFullScope ? "yes — covers the whole period scope" : "no — partial-scope personal view"}
                      </Badge>,
                    ],
                  ]}
                />
                <Table
                  rows={cut.report.usage.lines}
                  rowKey={(l) => `${l.dimension}:${l.matchKey}`}
                  columns={[
                    { key: "d", header: "Dimension", render: (l) => l.dimension },
                    { key: "k", header: "Key", render: (l) => l.matchKey },
                    { key: "e", header: "Events", render: (l) => l.events },
                    { key: "in", header: "Input tok", render: (l) => l.inputTokens },
                    { key: "out", header: "Output tok", render: (l) => l.outputTokens },
                    {
                      key: "b",
                      header: "Billed",
                      render: (l) => (l.unpriced ? <Badge tone="warn">UNPRICED</Badge> : fmtUsd(l.billedUsd ?? 0)),
                    },
                    {
                      key: "le",
                      header: "Ledger estimate",
                      render: (l) =>
                        l.ledgerEstimatedUsd == null ? <span className={v.faint}>—</span> : fmtUsd(l.ledgerEstimatedUsd),
                    },
                    { key: "n", header: "Basis", render: (l) => <span className={v.faint}>{l.rateNote}</span> },
                  ]}
                />
                <div className={a.formRow}>
                  <Button
                    disabled={act.busy || !cut.scope.coversFullScope}
                    onClick={() =>
                      void act.run(async () => {
                        await api.post(`/v1/billing/statements/${cut.statement.id}/issue`, {
                          reason: "issued from the admin console",
                        });
                        await overview.refetch();
                      }, "Statement issued — its money is now frozen")
                    }
                  >
                    Issue
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={act.busy}
                    onClick={() =>
                      void act.run(async () => {
                        const r = await api.post<ReconcileResult>(
                          `/v1/billing/statements/${cut.statement.id}/reconcile`,
                          {},
                        );
                        setRecon(r);
                        return r.matches ? "Re-derives exactly from the ledger" : "DRIFT — see the diff";
                      })
                    }
                  >
                    Re-derive &amp; compare
                  </Button>
                </div>
                {recon && (
                  <div className={v.stack}>
                    <Badge tone={recon.matches ? "ok" : "danger"}>
                      {recon.matches ? "re-derives exactly" : "does not re-derive"}
                    </Badge>
                    <div className={v.faint}>{recon.note}</div>
                    {recon.diffs.length > 0 && (
                      <Table
                        rows={recon.diffs}
                        rowKey={(d) => d.field}
                        columns={[
                          { key: "f", header: "Field", render: (d) => d.field },
                          { key: "i", header: "Issued", render: (d) => d.issued },
                          { key: "r", header: "Re-derived", render: (d) => d.rederived },
                        ]}
                      />
                    )}
                  </div>
                )}
                <div className={v.faint}>{cut.report.disclaimer}</div>
              </div>
            </Card>
          )}

          <Card title="Statements">
            {(o?.statements.length ?? 0) === 0 ? (
              <EmptyState title="No statements yet" body="Cut one from a period above. A statement is a draft until it is explicitly issued." />
            ) : (
              <Table
                rows={o!.statements}
                rowKey={(s) => s.id}
                columns={[
                  { key: "v", header: "Version", render: (s) => `v${s.version}` },
                  {
                    key: "st",
                    header: "Status",
                    render: (s) => (
                      <Badge tone={s.status === "issued" ? "ok" : s.status === "superseded" ? "neutral" : "info"}>
                        {s.status}
                      </Badge>
                    ),
                  },
                  { key: "mode", header: "Rating", render: (s) => <Badge tone="info">{s.ratingMode}</Badge> },
                  { key: "t", header: "Total", render: (s) => fmtUsd(s.totalUsd) },
                  { key: "seats", header: "Seats", render: (s) => s.seatCount },
                  {
                    key: "u",
                    header: "Unpriced",
                    render: (s) =>
                      s.unpricedEventCount > 0 ? <Badge tone="warn">{s.unpricedEventCount}</Badge> : s.unpricedEventCount,
                  },
                  { key: "g", header: "Cut", render: (s) => ago(s.generatedAt) },
                  {
                    key: "i",
                    header: "Issued",
                    render: (s) => (s.issuedAt ? ago(s.issuedAt) : <span className={v.faint}>draft</span>),
                  },
                ]}
              />
            )}
          </Card>

          <Card title="Exports">
            <div className={v.stack}>
              <div className={v.faint}>
                One shipment per (period, backend), enforced by a unique index — a double-bill is structurally
                impossible rather than merely unlikely. Chargeback/showback needs no billing backend at all: the CSV
                is the interchange format, and it works in the air-gapped default.
              </div>
              {(o?.exports.length ?? 0) === 0 ? (
                <EmptyState title="Nothing exported yet" body="Export a statement to record a shipment." />
              ) : (
                <Table
                  rows={o!.exports}
                  rowKey={(e) => e.id}
                  columns={[
                    { key: "b", header: "Backend", render: (e) => e.backend },
                    { key: "f", header: "Format", render: (e) => e.format },
                    { key: "r", header: "Rows", render: (e) => e.rowCount },
                    { key: "at", header: "Exported", render: (e) => ago(e.exportedAt) },
                  ]}
                />
              )}
            </div>
          </Card>
        </QueryGate>
      </div>
    </>
  );
}
