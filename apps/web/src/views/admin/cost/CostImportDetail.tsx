/**
 * Batch U4 — one imported cost batch with its source lines
 * (`GET /v1/cost-imports/:importId`), opened from Import history.
 *
 * The lines are IMPORTED cost (a file somebody exported), never metered, and
 * the gateway's own basis statement is printed with them. A revoked batch has
 * no lines (they were withdrawn) and says so rather than showing an empty
 * table as if the file had been empty. The gateway returns at most 500 lines;
 * when it says it stopped there, the dialog says so too.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { fmtAt, fmtUsd, shortId } from "../../../api/format";
import { Badge, EmptyState, Table } from "../../../ui/kit";
import { KV, useNameMaps } from "../adminKit";
import { DetailDialog } from "../DetailDialog";
import v from "../../views.module.css";

export interface ImportedLine {
  id: string;
  sourceRow: number;
  accountRef: string;
  resolvedUserId: string | null;
  resolutionMethod: "exact_email" | "admin_alias" | "domain_rule" | "unresolved";
  resolutionDetail: string;
  costCenter: string | null;
  periodStart: string;
  periodEnd: string;
  amount: number;
  currency: string;
  billingKind: string;
  service: string | null;
  description: string | null;
  quantity: number | null;
  supersededAt?: string | null;
}
interface ImportDetail {
  import: {
    id: string;
    adapter: string;
    vendor: string;
    format: string;
    mode: string;
    status: string;
    source: string | null;
    payloadSha256: string;
    rowsParsed: number;
    rowsAccepted: number;
    rowsRefused: number;
    periodStart: string | null;
    periodEnd: string | null;
    totalUsd: number | null;
    reason: string;
    createdAt: string;
    appliedAt: string | null;
    revokedAt: string | null;
  };
  lines: ImportedLine[];
  linesTruncated: boolean;
  basisStatement: string;
}

const METHOD_WORDS: Record<ImportedLine["resolutionMethod"], string> = {
  exact_email: "exact email",
  admin_alias: "admin alias",
  domain_rule: "domain rule",
  unresolved: "unattributed",
};

const amountText = (l: ImportedLine) => (l.currency === "USD" ? fmtUsd(l.amount) : `${l.amount.toLocaleString()} ${l.currency}`);

export function CostImportDetail(props: { importId: string; onClose: () => void }) {
  const names = useNameMaps();
  const q = useQuery({
    queryKey: ["admin", "cost-import", props.importId],
    retry: false,
    queryFn: () => api.get<ImportDetail>(`/v1/cost-imports/${encodeURIComponent(props.importId)}`),
  });
  return (
    <DetailDialog
      title="Imported cost batch"
      noun="import batch"
      query={q}
      refusals={{ unknown_import: "There is no import batch with this ID. Reload Import history; it lists every batch, including refused and revoked ones." }}
      onClose={props.onClose}
    >
      {(d) => (
        <div className={v.stack}>
          <p className={v.dim}>{d.basisStatement}</p>
          <KV
            rows={[
              ["Vendor", d.import.vendor],
              ["Adapter", <code>{d.import.adapter}</code>],
              ["Status", <Badge tone={d.import.status === "applied" ? "ok" : d.import.status === "refused" ? "danger" : d.import.status === "revoked" ? "warn" : "neutral"}>{d.import.status}</Badge>],
              ["Mode", d.import.mode],
              ["Format", d.import.format],
              ["Source", d.import.source ?? "not stated"],
              ["Rows parsed / accepted / refused", <span className={v.num}>{d.import.rowsParsed} / {d.import.rowsAccepted} / {d.import.rowsRefused}</span>],
              ["Period", d.import.periodStart && d.import.periodEnd ? `${fmtAt(d.import.periodStart)} – ${fmtAt(d.import.periodEnd)}` : "not stated"],
              ["Imported total", d.import.totalUsd === null ? "no single USD figure" : fmtUsd(d.import.totalUsd)],
              ["File SHA-256", <code style={{ wordBreak: "break-all" }}>{d.import.payloadSha256}</code>],
              ["Imported", fmtAt(d.import.createdAt)],
              ["Revoked", d.import.revokedAt ? fmtAt(d.import.revokedAt) : "no"],
              ["Outcome", d.import.reason],
            ]}
          />
          {d.lines.length === 0 ? (
            <EmptyState
              title="No lines held for this batch"
              body={
                d.import.status === "revoked"
                  ? "This batch was revoked: its lines were withdrawn and the batch row is kept as the record."
                  : d.import.status === "refused" || d.import.mode === "dry_run"
                    ? "A refused import or a dry run stores no lines; the counts above are what the parse found."
                    : "The gateway holds no lines for this batch."
              }
            />
          ) : (
            <Table<ImportedLine>
              rows={d.lines}
              rowKey={(l) => l.id}
              columns={[
                { key: "row", header: "File line", render: (l) => <span className={v.num}>{l.sourceRow}</span> },
                { key: "acct", header: "Vendor account", render: (l) => <code>{l.accountRef}</code> },
                {
                  key: "who",
                  header: "Attributed to",
                  render: (l) =>
                    l.resolvedUserId ? (
                      <span title={l.resolutionDetail}>
                        {names.userName.get(l.resolvedUserId) ?? shortId(l.resolvedUserId)} <span className={v.faint}>({METHOD_WORDS[l.resolutionMethod] ?? l.resolutionMethod})</span>
                      </span>
                    ) : (
                      <Badge tone="warn" title={l.resolutionDetail}>
                        unattributed
                      </Badge>
                    ),
                },
                { key: "svc", header: "Service", render: (l) => l.service ?? l.description ?? "—" },
                { key: "kind", header: "Kind", render: (l) => l.billingKind },
                { key: "amt", header: "Imported amount", align: "right", render: (l) => <span className={v.num}>{amountText(l)}</span> },
                { key: "cc", header: "Cost center", render: (l) => l.costCenter ?? "—" },
              ]}
            />
          )}
          {d.linesTruncated && (
            <p className={v.faint} role="note">
              The gateway returns the first 500 lines by file order; this batch has more. The totals above cover the whole batch.
            </p>
          )}
        </div>
      )}
    </DetailDialog>
  );
}
