/**
 * ADR-0069 import history, shared by the cross-vendor consolidation overview's preview and the full list on its own
 * page (P3, #453 c6527514889): the batch row the gateway answers, its status tone, and the list's columns.
 */
import { ago, fmtUsd } from "../../../api/format";
import { Badge, type Tone } from "../../../ui/kit";
import type { DataColumn } from "../../../ui/DataList";
import v from "../../views.module.css";

export interface ImportBatch {
  id: string;
  adapter: string;
  vendor: string;
  format: string;
  mode: string;
  status: string;
  source: string | null;
  rowsParsed: number;
  rowsAccepted: number;
  rowsRefused: number;
  totalUsd: number | null;
  reason: string;
  createdAt: string;
}

export const IMPORTS_ENDPOINT = "/v1/cost-imports";
export const IMPORTS_QUERY_KEY = ["admin", "cost-imports", "list"] as const;
export const IMPORTS_SORT = { key: "when", dir: "desc" } as const;
export const IMPORTS_PATH = "/admin/cost-consolidation/imports";

export const importStatusTone = (status: string): Tone =>
  status === "refused" ? "danger" : status === "applied" ? "ok" : status === "revoked" ? "warn" : "neutral";

/** the import history's columns, in screen order; the full page adds its row actions */
export const IMPORT_COLUMNS: Array<DataColumn<ImportBatch>> = [
  { key: "when", main: true, sortable: true, header: "When", render: (r) => ago(r.createdAt) },
  { key: "adapter", sortable: true, header: "Adapter", render: (r) => <code>{r.adapter}</code> },
  { key: "vendor", main: true, sortable: true, header: "Vendor", render: (r) => r.vendor },
  { key: "mode", main: true, sortable: true, header: "Mode", render: (r) => r.mode },
  {
    key: "status",
    header: "Status",
    main: true,
    sortable: true,
    required: "Status is always shown",
    render: (r) => <Badge tone={importStatusTone(r.status)}>{r.status}</Badge>,
  },
  {
    key: "rows",
    header: "Parsed / accepted / refused",
    main: true,
    sortable: true,
    render: (r) => (
      <span className={v.num}>
        {r.rowsParsed} / {r.rowsAccepted} / {r.rowsRefused}
      </span>
    ),
  },
  {
    key: "usd",
    header: "Imported",
    sortable: true,
    render: (r) => (r.totalUsd === null ? <span className={v.faint}>no single figure</span> : fmtUsd(r.totalUsd)),
  },
  { key: "reason", main: true, sortable: true, required: "Why an import was refused is always shown", header: "Outcome", render: (r) => <span className={v.dim}>{r.reason}</span> },
];
