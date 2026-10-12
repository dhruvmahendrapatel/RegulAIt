/**
 * Batch U4 — billing records past the overview's newest 25, and one record at
 * a time (ADR-0051):
 *
 *  - a rate card with its entries (`GET /v1/billing/rate-cards/:id`);
 *  - one statement, scope-checked by the gateway (`GET /v1/billing/statements/:id`);
 *  - the full lists: every rate card (`GET /v1/billing/rate-cards`), every
 *    period (`GET /v1/billing/periods`) and statements filtered by period with
 *    the route's own limit (`GET /v1/billing/statements?periodId=&limit=`).
 *
 * The lists load when their tab is opened, not with the page.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago, fmtAt, fmtUsd } from "../../../api/format";
import { Badge, Button, Card, EmptyState, Field, Select, Table, Tabs, tabIds } from "../../../ui/kit";
import { KV } from "../adminKit";
import { DetailDialog } from "../DetailDialog";
import { BILLING_REFUSALS, STATEMENT_LIMITS, statementHeadline, statementLines, type StatementLine } from "./billingDetailModel";
import a from "../admin.module.css";
import v from "../../views.module.css";

interface RateEntry {
  id: string;
  dimension: string;
  matchKey: string;
  unit: string;
  unitPriceUsd: number;
}
interface RateCard {
  id: string;
  name: string;
  version: number;
  currency: string;
  status: string;
  description: string | null;
  createdAt: string;
  entries: RateEntry[];
}

export function RateCardDetail(props: { id: string; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["admin", "billing-rate-card", props.id],
    retry: false,
    queryFn: () => api.get<{ rateCard: RateCard }>(`/v1/billing/rate-cards/${encodeURIComponent(props.id)}`),
  });
  return (
    <DetailDialog
      title={q.data ? `Rate card ${q.data.rateCard.name} v${q.data.rateCard.version}` : "Rate card"}
      noun="rate card"
      query={q}
      refusals={BILLING_REFUSALS}
      onClose={props.onClose}
    >
      {({ rateCard: c }) => (
        <div className={v.stack}>
          <KV
            rows={[
              ["Status", <Badge tone={c.status === "active" ? "ok" : "neutral"}>{c.status}</Badge>],
              ["Currency", c.currency],
              ["Description", c.description ?? "none"],
              ["Created", fmtAt(c.createdAt)],
            ]}
          />
          <Table<RateEntry>
            rows={c.entries}
            rowKey={(e) => e.id}
            empty={<EmptyState title="This card prices nothing" body="With no entries, every event rated against it is reported UNPRICED." />}
            columns={[
              { key: "d", header: "Dimension", render: (e) => e.dimension },
              { key: "m", header: "Matches", render: (e) => <code>{e.matchKey}</code> },
              { key: "u", header: "Unit", render: (e) => e.unit },
              { key: "p", header: "Unit price", align: "right", render: (e) => <span className={v.num}>{fmtUsd(e.unitPriceUsd)}</span> },
            ]}
          />
          <p className={v.faint}>A rate card version never changes. A new price is a new version; issued statements keep the snapshot they were rated against.</p>
        </div>
      )}
    </DetailDialog>
  );
}

interface Statement {
  id: string;
  periodId: string;
  version: number;
  status: string;
  ratingMode: string;
  rateCardName: string;
  rateCardVersion: number;
  entitlementScope: string;
  effectiveProjectIds: string[] | null;
  coversFullScope: boolean;
  derivedThroughAt: string;
  sourceUsageEventCount: number;
  unpricedEventCount: number;
  ledgerEstimatedCostUsd: number;
  seatCount: number;
  usageSubtotalUsd: number;
  seatSubtotalUsd: number;
  totalUsd: number;
  generatedAt: string;
  issuedAt: string | null;
  payload: unknown;
}

export function StatementDetail(props: { id: string; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["admin", "billing-statement", props.id],
    retry: false,
    queryFn: () => api.get<{ statement: Statement; disclaimer: string }>(`/v1/billing/statements/${encodeURIComponent(props.id)}`),
  });
  return (
    <DetailDialog
      title={q.data ? `Statement v${q.data.statement.version}` : "Statement"}
      noun="statement"
      query={q}
      refusals={BILLING_REFUSALS}
      onClose={props.onClose}
    >
      {({ statement: s, disclaimer }) => {
        const head = statementHeadline(s.payload);
        const lines = statementLines(s.payload);
        return (
          <div className={v.stack}>
            <p className={v.dim}>{disclaimer}</p>
            <KV
              rows={[
                ["Period", head.periodLabel ?? <code>{s.periodId}</code>],
                ["Status", <Badge tone={s.status === "issued" ? "ok" : s.status === "superseded" ? "neutral" : "info"}>{s.status}</Badge>],
                ["Rating", s.ratingMode],
                ["Rate card", `${s.rateCardName} v${s.rateCardVersion}`],
                ["Scope", s.coversFullScope ? `${s.entitlementScope}, full scope` : `${s.entitlementScope}, PARTIAL (${s.effectiveProjectIds?.length ?? 0} project(s) its generator could see)`],
                ["Usage subtotal", fmtUsd(s.usageSubtotalUsd)],
                ["Seats", `${s.seatCount} — ${fmtUsd(s.seatSubtotalUsd)}`],
                ["Total", <strong>{fmtUsd(s.totalUsd)}</strong>],
                ["Ledger list-price estimate", fmtUsd(s.ledgerEstimatedCostUsd)],
                ["Usage events", `${s.sourceUsageEventCount} (${s.unpricedEventCount} unpriced)`],
                ["Derived through", fmtAt(s.derivedThroughAt)],
                ["Cut", fmtAt(s.generatedAt)],
                ["Issued", s.issuedAt ? fmtAt(s.issuedAt) : "draft — not issued"],
              ]}
            />
            <Table<StatementLine>
              rows={lines}
              rowKey={(l) => `${l.dimension}:${l.matchKey}`}
              empty={<EmptyState title="No usage lines" body="No usage event fell in this period and scope." />}
              columns={[
                { key: "d", header: "Dimension", render: (l) => l.dimension },
                { key: "m", header: "Matches", render: (l) => <code>{l.matchKey}</code> },
                { key: "e", header: "Events", align: "right", render: (l) => l.events },
                { key: "t", header: "Tokens in / out", align: "right", render: (l) => `${l.inputTokens} / ${l.outputTokens}` },
                {
                  key: "b",
                  header: "Billed",
                  align: "right",
                  render: (l) => (l.unpriced ? <Badge tone="warn" title={l.rateNote}>unpriced</Badge> : <span className={v.num}>{fmtUsd(l.billedUsd)}</span>),
                },
              ]}
            />
          </div>
        );
      }}
    </DetailDialog>
  );
}

interface PeriodRow {
  id: string;
  scopeKind: string;
  scopeKey: string;
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
  rateCardName: string;
  rateCardVersion: number;
  totalUsd: number;
  unpricedEventCount: number;
  coversFullScope: boolean;
  generatedAt: string;
  issuedAt: string | null;
}

const periodLabel = (p: PeriodRow) => `${p.periodStart.slice(0, 10)} – ${p.periodEnd.slice(0, 10)} (${p.scopeKind})`;
const PREFIX = "billing-history";

export function BillingHistoryCard() {
  const [tab, setTab] = useState<"cards" | "periods" | "statements">("statements");
  const [periodId, setPeriodId] = useState("");
  const [limit, setLimit] = useState<number>(STATEMENT_LIMITS[0]);
  const [openCard, setOpenCard] = useState<string | null>(null);
  const [openStatement, setOpenStatement] = useState<string | null>(null);

  const cards = useQuery({
    queryKey: ["admin", "billing-rate-cards-all"],
    enabled: tab === "cards",
    queryFn: () => api.get<{ rateCards: RateCard[]; note: string }>("/v1/billing/rate-cards"),
  });
  // the period filter on the statements tab needs the periods too
  const periods = useQuery({
    queryKey: ["admin", "billing-periods-all"],
    enabled: tab === "periods" || tab === "statements",
    queryFn: () => api.get<{ periods: PeriodRow[]; note: string }>("/v1/billing/periods"),
  });
  const statements = useQuery({
    queryKey: ["admin", "billing-statements-all", periodId, limit],
    enabled: tab === "statements",
    queryFn: () =>
      api.get<{ statements: StatementRow[]; disclaimer: string }>(
        `/v1/billing/statements?limit=${limit}${periodId ? `&periodId=${encodeURIComponent(periodId)}` : ""}`,
      ),
  });
  const periodName = new Map((periods.data?.periods ?? []).map((p) => [p.id, periodLabel(p)]));
  const panel = tabIds(PREFIX, tab);

  return (
    <Card title="Full billing history">
      <div className={v.stack}>
        <p className={v.faint}>The cards above show the newest 25 of each. Every record is here.</p>
        <Tabs
          idPrefix={PREFIX}
          active={tab}
          onChange={(id) => setTab(id as typeof tab)}
          tabs={[
            { id: "statements", label: "Statements" },
            { id: "periods", label: "Periods" },
            { id: "cards", label: "Rate cards" },
          ]}
        />
        <div role="tabpanel" id={panel.panel} aria-labelledby={panel.tab} className={v.stack}>
          {tab === "statements" && (
            <>
              <div className={a.formRow}>
                <Field label="Period">
                  <Select value={periodId} onChange={(e) => setPeriodId(e.target.value)}>
                    <option value="">every period</option>
                    {(periods.data?.periods ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {periodLabel(p)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Show at most">
                  <Select value={String(limit)} onChange={(e) => setLimit(Number(e.target.value))}>
                    {STATEMENT_LIMITS.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Table<StatementRow>
                rows={statements.data?.statements}
                loading={statements.isLoading}
                error={statements.error}
                onRetry={() => void statements.refetch()}
                rowKey={(s) => s.id}
                empty={<EmptyState title="No statements match" />}
                columns={[
                  { key: "p", header: "Period", render: (s) => periodName.get(s.periodId) ?? "—" },
                  { key: "v", header: "Version", render: (s) => `v${s.version}` },
                  { key: "st", header: "Status", render: (s) => <Badge tone={s.status === "issued" ? "ok" : s.status === "superseded" ? "neutral" : "info"}>{s.status}</Badge> },
                  { key: "rc", header: "Rate card", render: (s) => `${s.rateCardName} v${s.rateCardVersion}` },
                  { key: "t", header: "Total", align: "right", render: (s) => fmtUsd(s.totalUsd) },
                  { key: "u", header: "Unpriced", render: (s) => (s.unpricedEventCount > 0 ? <Badge tone="warn">{s.unpricedEventCount}</Badge> : 0) },
                  { key: "g", header: "Cut", render: (s) => ago(s.generatedAt) },
                  {
                    key: "o",
                    header: "",
                    align: "right",
                    render: (s) => (
                      <Button size="sm" aria-label={`Open statement v${s.version} of ${periodName.get(s.periodId) ?? "its period"}`} onClick={() => setOpenStatement(s.id)}>
                        Open
                      </Button>
                    ),
                  },
                ]}
              />
              {(statements.data?.statements?.length ?? 0) >= limit && (
                <p className={v.faint}>Showing the newest {limit}. Choose a period, or raise the limit, for older statements.</p>
              )}
            </>
          )}
          {tab === "periods" && (
            <Table<PeriodRow>
              rows={periods.data?.periods}
              loading={periods.isLoading}
              error={periods.error}
              onRetry={() => void periods.refetch()}
              rowKey={(p) => p.id}
              empty={<EmptyState title="No billing periods" />}
              columns={[
                { key: "r", header: "Period", render: (p) => `${p.periodStart.slice(0, 10)} – ${p.periodEnd.slice(0, 10)}` },
                { key: "s", header: "Scope", render: (p) => p.scopeKind },
                { key: "st", header: "Status", render: (p) => <Badge tone={p.status === "closed" ? "neutral" : "info"}>{p.status}</Badge> },
                { key: "c", header: "Closed", render: (p) => (p.closedAt ? ago(p.closedAt) : <span className={v.faint}>open — nothing closes it automatically</span>) },
                {
                  key: "o",
                  header: "",
                  align: "right",
                  render: (p) => (
                    <Button
                      size="sm"
                      aria-label={`Statements for ${periodLabel(p)}`}
                      onClick={() => {
                        setPeriodId(p.id);
                        setTab("statements");
                      }}
                    >
                      Statements
                    </Button>
                  ),
                },
              ]}
            />
          )}
          {tab === "cards" && (
            <Table<RateCard>
              rows={cards.data?.rateCards}
              loading={cards.isLoading}
              error={cards.error}
              onRetry={() => void cards.refetch()}
              rowKey={(c) => c.id}
              empty={<EmptyState title="No rate cards" />}
              columns={[
                { key: "n", header: "Name", render: (c) => c.name },
                { key: "v", header: "Version", render: (c) => `v${c.version}` },
                { key: "st", header: "Status", render: (c) => <Badge tone={c.status === "active" ? "ok" : "neutral"}>{c.status}</Badge> },
                { key: "e", header: "Entries", render: (c) => c.entries.length },
                { key: "at", header: "Created", render: (c) => ago(c.createdAt) },
                {
                  key: "o",
                  header: "",
                  align: "right",
                  render: (c) => (
                    <Button size="sm" aria-label={`Open rate card ${c.name} v${c.version}`} onClick={() => setOpenCard(c.id)}>
                      Open
                    </Button>
                  ),
                },
              ]}
            />
          )}
        </div>
      </div>
      {openCard && <RateCardDetail key={openCard} id={openCard} onClose={() => setOpenCard(null)} />}
      {openStatement && <StatementDetail key={openStatement} id={openStatement} onClose={() => setOpenStatement(null)} />}
    </Card>
  );
}
