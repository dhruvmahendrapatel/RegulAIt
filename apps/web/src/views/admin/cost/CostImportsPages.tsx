/**
 * ADR-0069 import history and one batch's imported lines, each on its own page (P3, #453 c6527514889). The
 * consolidation overview keeps a five-row preview of the history with its refused count; these pages carry the full
 * lists with the shared list control, the history's filters, Open and Revoke.
 */
import { useMemo, useState } from "react";
import { Route, Routes, useParams } from "react-router-dom";
import CostConsolidationPage from "./CostConsolidationPage";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Button, Card, EmptyState, Field, Select } from "../../../ui/kit";
import { DataList } from "../../../ui/DataList";
import { SubpageTrail } from "../../../ui/ListPreview";
import { OutcomePanel, QueryGate, ReasonModal, useApiAction, useNameMaps } from "../adminKit";
import { CostImportDetail, IMPORT_REFUSALS, ImportBatchSummary, LINES_SORT, importDetailKey, lineColumns, linesEndpoint, noLinesState, unattributedAttention, useImportDetail, type ImportedLine } from "./CostImportDetail";
import { IMPORTS_ENDPOINT, IMPORTS_QUERY_KEY, IMPORTS_SORT, IMPORTS_PATH, IMPORT_COLUMNS, type ImportBatch } from "./costImports";
import { refusalWords } from "../detailModel";
import v from "../../views.module.css";

const PARENT = { parent: "Cross-vendor consolidation", parentTo: "/admin/cost-consolidation" };
const STATUSES = ["applied", "planned", "refused", "revoked"] as const;

export function CostImportsPage() {
  const act = useApiAction();
  const qc = useQueryClient();
  const [status, setStatus] = useState("");
  const [vendor, setVendor] = useState("");
  const filters = useMemo(() => ({ status: status || undefined, vendor: vendor || undefined }), [status, vendor]);
  const [vendors, setVendors] = useState<string[]>([]);
  const [openImport, setOpenImport] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ImportBatch | null>(null);

  const revokeBatch = async (reason: string) => {
    if (!revoking) return;
    const target = revoking;
    setRevoking(null);
    await act.run(() => api.del(`/v1/cost-imports/${target.id}`, { reason }), "Batch revoked — its lines are withdrawn and the batch row remains as a record.");
    void qc.invalidateQueries({ queryKey: ["admin", "cost-imports"] });
    void qc.invalidateQueries({ queryKey: ["admin", "cost-consolidated"] });
    void qc.invalidateQueries({ queryKey: ["admin", "cost-reconciliation"] });
  };

  return (
    <>
      <SubpageTrail {...PARENT} current="Import history" />
      <PageHeader title="Import history" sub="Every vendor export applied, dry-run, refused or revoked. Imported figures are reporting-only, never metered." />
      <div className={v.stack}>
        <OutcomePanel outcome={act.outcome} testId="ci-outcome" />
        <Card title="Import history">
          <div className={v.stack}>
            <div className={v.row}>
              <Field label="Status">
                <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="">any status</option>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Vendor">
                <Select value={vendor} onChange={(e) => setVendor(e.target.value)}>
                  <option value="">any vendor</option>
                  {[...new Set([...vendors, vendor].filter(Boolean))].sort().map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <DataList<ImportBatch>
              listId="cost-imports"
              noun="imports"
              endpoint={IMPORTS_ENDPOINT}
              exportPath="/v1/cost-imports/export.xlsx"
              queryKey={IMPORTS_QUERY_KEY}
              legacyKey="imports"
              filters={filters}
              defaultSort={IMPORTS_SORT}
              rowKey={(r) => r.id}
              onRows={(rows) => setVendors((prev) => [...new Set([...prev, ...rows.map((r) => r.vendor)])])}
              empty={<EmptyState title={status || vendor ? "No imports match" : "Nothing imported yet"} />}
              columns={[
                ...IMPORT_COLUMNS,
                {
                  key: "act",
                  action: true,
                  header: "",
                  srHeader: "Actions",
                  render: (r) => (
                    <div className={v.row}>
                      <Button size="sm" aria-label={`Open the ${r.vendor} import from ${ago(r.createdAt)}`} onClick={() => setOpenImport(r.id)}>
                        Open
                      </Button>
                      {r.status === "applied" ? (
                        <Button size="sm" variant="danger" onClick={() => setRevoking(r)}>
                          Revoke
                        </Button>
                      ) : null}
                    </div>
                  ),
                },
              ]}
            />
            <p className={v.faint}>
              A refused import is recorded, not discarded — &ldquo;somebody tried to import July&apos;s invoice and it would not parse&rdquo; is exactly the kind of
              thing an auditor asks about later. Revoking withdraws a batch&apos;s lines and keeps the batch row.
            </p>
          </div>
        </Card>
      </div>

      {openImport && <CostImportDetail key={openImport} importId={openImport} onClose={() => setOpenImport(null)} />}
      <ReasonModal
        open={revoking !== null}
        title={revoking ? `Withdraw the lines from this ${revoking.vendor} import?` : ""}
        danger
        confirmLabel="Revoke batch"
        placeholder="why this batch is being withdrawn (required, audited)"
        body={
          <p>
            The imported cost lines are deleted and every consolidated figure they contributed to changes. The batch row itself is <strong>kept</strong>,
            marked revoked, with your reason attached. This is the correction path: revoke, then re-import the corrected file.
          </p>
        }
        onConfirm={(reason) => void revokeBatch(reason)}
        onCancel={() => setRevoking(null)}
      />
    </>
  );
}

export function CostImportLinesPage() {
  const importId = useParams().importId ?? "";
  const names = useNameMaps();
  const q = useImportDetail(importId);
  const d = q.data;
  // a refusal (no such batch) in words; anything retryable stays with QueryGate and its Retry
  const words = q.isError ? refusalWords("import batch", q.error, IMPORT_REFUSALS) : null;
  const refused = words && !words.retry ? words : null;
  const attention = d ? unattributedAttention(d) : null;
  return (
    <>
      <SubpageTrail parent="Import history" parentTo={IMPORTS_PATH} current={d ? `${d.import.vendor} import` : "Import batch"} />
      <PageHeader
        title={d ? `${d.import.vendor} import, ${ago(d.import.createdAt)}` : "Imported cost batch"}
        sub={attention && attention.count > 0 ? `${attention.count.toLocaleString("en-GB")} line(s) ${attention.label}: map their accounts on the consolidation page to attribute them.` : "IMPORTED cost lines, exactly as the file stated them."}
      />
      <div className={v.stack}>
        {refused ? (
          <Card>
            <EmptyState title={refused.title} body={refused.body} />
          </Card>
        ) : (
          <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
            {d && (
              <>
                <Card title="Batch">
                  <div className={v.stack}>
                    <ImportBatchSummary detail={d} />
                  </div>
                </Card>
                <Card title="Imported lines">
                  <DataList<ImportedLine>
                    listId="cost-import-lines"
                    noun="imported lines"
                    endpoint={linesEndpoint(importId)}
                    exportPath={`/v1/cost-imports/${encodeURIComponent(importId)}/export.xlsx`}
                    queryKey={[...importDetailKey(importId), "lines"]}
                    legacyKey="lines"
                    defaultSort={LINES_SORT}
                    rowKey={(l) => l.id}
                    empty={noLinesState(d)}
                    columns={lineColumns(names.userName)}
                  />
                </Card>
              </>
            )}
          </QueryGate>
        )}
      </div>
    </>
  );
}

/**
 * The cross-vendor consolidation area: the consolidation overview (with its five-row import-history preview) at the
 * index, the full import history and one batch's imported lines on their own nested routes. One lazy chunk mounted at
 * `cost-consolidation/*` so it adds nothing to the entry bundle (ADR-0196 U4; the SPA route census follows this
 * module — scripts/ui-spa-routes.mjs).
 */
export function CostConsolidationArea() {
  return (
    <Routes>
      <Route index element={<CostConsolidationPage />} />
      <Route path="imports" element={<CostImportsPage />} />
      <Route path="imports/:importId" element={<CostImportLinesPage />} />
    </Routes>
  );
}
