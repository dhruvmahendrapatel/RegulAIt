/**
 * ADR-0055 / ADR-0076 — the person's own spend across vendors, from
 * `GET /v1/users/:userId/cost-consolidated` (the self-scoped twin of the admin
 * consolidation page; the gateway refuses anyone else's figures with 403).
 *
 * Two sides, never added together: `metered` is what RegulAIt observed and
 * priced itself; `imported` is restated from a vendor export an admin
 * uploaded. A side with lines in more than one currency has no single USD
 * figure (the gateway does no FX conversion) and says why. The imported side
 * is only as fresh as the last upload, so the staleness per vendor is shown.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import { fmtUsd, plural } from "../../api/format";
import { Badge, Card, EmptyState, ErrorState, InfoButton, SkeletonBlock, Table } from "../../ui/kit";
import v from "../views.module.css";

interface Side {
  usd: number | null;
}
export interface ConsolidatedSubject {
  subjectKind: string;
  subjectId: string | null;
  label: string;
  attributed: boolean;
  metered: Side & { events: number; unpricedEvents: number };
  imported: Side & {
    lines: number;
    byVendor: Array<{ vendor: string; currency: string; amount: number; lines: number }>;
    usdNote: string | null;
  };
  coverage: string;
}
export interface MyConsolidated {
  window: { from: string; to: string };
  subjects: ConsolidatedSubject[];
  basisStatement: string;
  reconciliation?: { supersededLinesExcluded: number; note: string };
  staleness?: { vendors: Array<{ vendor: string; lastImportedAt: string | null; daysSinceLastImport: number | null }>; note: string };
  note: string;
}

/** the caller's own subject, or null when nothing was metered or imported for them in the window */
export function ownSubject(data: MyConsolidated, userId: string): ConsolidatedSubject | null {
  const rows = Array.isArray(data.subjects) ? data.subjects : [];
  return rows.find((s) => s.subjectId === userId) ?? null;
}

const amount = (n: number, currency: string) => (currency === "USD" ? fmtUsd(n) : `${n.toFixed(2)} ${currency}`);

export function MyConsolidatedSpendCard(props: { userId: string }) {
  const q = useQuery({
    queryKey: ["my-cost-consolidated", props.userId],
    queryFn: () => api.get<MyConsolidated>(`/v1/users/${encodeURIComponent(props.userId)}/cost-consolidated`),
  });
  const day = (iso: string) => new Date(iso).toLocaleDateString();
  return (
    <Card title="All your AI spend, metered and imported">
      <div className={v.stack} data-testid="my-cost-consolidated">
        {q.isLoading ? (
          <SkeletonBlock lines={3} />
        ) : q.isError ? (
          <ErrorState message={(q.error as Error).message} access={(q.error as { status?: number }).status === 403} onRetry={() => void q.refetch()} />
        ) : q.data ? (
          (() => {
            const subject = ownSubject(q.data, props.userId);
            return (
              <>
                {/* the honesty caveats stay as short visible qualifiers; their full sentences are in the (i)s */}
                <p className={v.faint}>
                  {day(q.data.window.from)} to {day(q.data.window.to)} · no combined figure
                </p>
                {subject ? (
                  <div className={v.grid3}>
                    <div className={v.stat}>
                      <span className={v.statValue}>{fmtUsd(subject.metered.usd ?? 0)}</span>
                      <span className={v.statLabel}>
                        metered by regulAIt · {plural(subject.metered.events, "call")}
                        {subject.metered.unpricedEvents > 0 ? ` (${subject.metered.unpricedEvents} unpriced, not counted as zero)` : ""}
                        <InfoButton label="metered spend">{q.data.note}</InfoButton>
                      </span>
                    </div>
                    <div className={v.stat}>
                      <span className={v.statValue}>{subject.imported.usd === null ? "No USD total" : fmtUsd(subject.imported.usd)}</span>
                      <span className={v.statLabel}>
                        Imported · customer-supplied · {plural(subject.imported.lines, "line")}
                        <InfoButton label="imported spend">{q.data.basisStatement}</InfoButton>
                      </span>
                      {subject.imported.usdNote ? <span className={v.faint}>{subject.imported.usdNote}</span> : null}
                    </div>
                    <div className={v.stat}>
                      <span className={v.statValue}>
                        <Badge tone="info">{subject.coverage}</Badge>
                      </span>
                      <span className={v.statLabel}>coverage</span>
                    </div>
                  </div>
                ) : (
                  <EmptyState title="Nothing in this window" body="No metered call and no imported bill line is attributed to you in the last 30 days." />
                )}
                {subject && subject.imported.byVendor.length > 0 ? (
                  <Table
                    rows={subject.imported.byVendor}
                    rowKey={(r) => `${r.vendor}\u0000${r.currency}`}
                    columns={[
                      { key: "vendor", header: "Vendor (imported)", render: (r) => r.vendor },
                      { key: "lines", header: "Lines", align: "right", render: (r) => r.lines },
                      { key: "amount", header: "Amount", align: "right", render: (r) => amount(r.amount, r.currency) },
                    ]}
                  />
                ) : null}
                {q.data.reconciliation && q.data.reconciliation.supersededLinesExcluded > 0 ? (
                  <p className={v.faint}>
                    {plural(q.data.reconciliation.supersededLinesExcluded, "duplicate imported line")} excluded. {q.data.reconciliation.note}
                  </p>
                ) : null}
                {q.data.staleness && q.data.staleness.vendors.length > 0 ? (
                  <p className={v.faint}>
                    Last vendor uploads:{" "}
                    {q.data.staleness.vendors
                      .map((s) => `${s.vendor} ${s.daysSinceLastImport === null ? "never" : `${plural(s.daysSinceLastImport, "day")} ago`}`)
                      .join("; ")}
                    . {q.data.staleness.note}
                  </p>
                ) : null}
              </>
            );
          })()
        ) : null}
      </div>
    </Card>
  );
}
