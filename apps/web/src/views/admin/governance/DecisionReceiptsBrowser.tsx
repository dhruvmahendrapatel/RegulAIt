/**
 * Batch U4 — page through signed decision receipts (`GET /v1/receipts`) and
 * open one decision's receipt envelope(s) (`GET /v1/receipts/:auditId`), on the
 * Audit log page beside the receipt status, export and verify controls.
 *
 * Both reads are audited by the gateway, so neither runs on page load: the
 * list is fetched when the person asks for a page, and a receipt when they
 * open one. A receipt carries no reason or detail text (ADR-0186 R), so the
 * dialog shows exactly the signed payload and says so.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { fmtAt, UUID_RE } from "../../../api/format";
import { Badge, Button, CodeBlock, EmptyState, Field, Input, Select, Table } from "../../../ui/kit";
import { KV } from "../adminKit";
import { DetailDialog } from "../DetailDialog";
import { refusalWords } from "../detailModel";
import {
  RECEIPT_PAGE_SIZES,
  RECEIPT_REFUSALS,
  nextFromSeq,
  parseFromSeq,
  receiptRow,
  type ReceiptEnvelope,
  type ReceiptRow,
} from "./receiptsModel";
import a from "../admin.module.css";
import v from "../../views.module.css";

const effectTone = (effect: string | null) => (effect === "allow" ? "ok" : effect === "deny" ? "danger" : effect ? "warn" : "neutral");
const missing = <span className={v.faint}>not stated</span>;

/** one decision's signed receipt envelope(s) */
export function ReceiptDialog(props: { auditId: string; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["admin", "decision-receipt", props.auditId],
    retry: false,
    queryFn: () => api.get<{ receipts: ReceiptEnvelope[] }>(`/v1/receipts/${encodeURIComponent(props.auditId)}`),
  });
  return (
    <DetailDialog title="Decision receipt" noun="decision receipt" query={q} refusals={RECEIPT_REFUSALS} onClose={props.onClose}>
      {(data) =>
        data.receipts.length === 0 ? (
          <EmptyState
            title="No signed receipt for this decision"
            body="Either the signing sweep has not reached it yet, receipt signing is off or has no key, or this audit row is not a governed decision (admin configuration stays on the audit hash chain only). This read is recorded in the audit log."
          />
        ) : (
          <div className={v.stack}>
            <p className={v.faint}>
              Audit row <code>{props.auditId}</code>. A receipt signs the decision without its reason or detail text; this read is recorded in the
              audit log.
            </p>
            {data.receipts.map((e) => {
              const r = receiptRow(e);
              return (
                <section key={e.receiptSeq} className={v.stack} aria-label={`Receipt ${e.receiptSeq}`}>
                  <KV
                    rows={[
                      ["Receipt sequence", <span className={v.num}>{r.receiptSeq}</span>],
                      ["Payload version", r.version ?? missing],
                      ["Decided", r.at ? fmtAt(r.at) : missing],
                      ["Effect", r.effect ? <Badge tone={effectTone(r.effect)}>{r.effect}</Badge> : missing],
                      ["Object", r.objectType ? `${r.objectType}${r.objectId ? ` ${r.objectId}` : ""}` : missing],
                      ["Tool", r.toolName ?? "none"],
                      ["Rule", r.ruleId ?? missing],
                      ["Audit sequence", r.auditSeq ?? missing],
                      ["Signing key", <code>{r.keyId}</code>],
                      ["Chains from", r.prev ? <code style={{ wordBreak: "break-all" }}>{r.prev}</code> : missing],
                      ["Signature (Ed25519)", <code style={{ wordBreak: "break-all" }}>{r.signature}</code>],
                    ]}
                  />
                  <details>
                    <summary>Signed payload (JSON)</summary>
                    <CodeBlock maxHeight="320px">{JSON.stringify(e.payload, null, 2)}</CodeBlock>
                  </details>
                </section>
              );
            })}
            <p className={v.faint}>
              To check a signature, export a range that includes this sequence and verify the bundle below, or verify it offline with the receipt
              verifier CLI.
            </p>
          </div>
        )
      }
    </DetailDialog>
  );
}

export function DecisionReceiptsBrowser() {
  const [fromText, setFromText] = useState("1");
  const [limit, setLimit] = useState<number>(RECEIPT_PAGE_SIZES[0]);
  const [page, setPage] = useState<{ from: number; limit: number } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [openAudit, setOpenAudit] = useState<string | null>(null);
  const [auditDraft, setAuditDraft] = useState("");
  const [auditError, setAuditError] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ["admin", "decision-receipts", page?.from, page?.limit],
    enabled: page !== null,
    retry: false,
    queryFn: () => api.get<{ receipts: ReceiptEnvelope[] }>(`/v1/receipts?fromSeq=${page!.from}&limit=${page!.limit}`),
  });
  const rows = (list.data?.receipts ?? []).map(receiptRow);
  const next = page && list.data ? nextFromSeq(list.data.receipts, page.limit) : null;

  return (
    <div className={v.stack}>
      <div className={v.sectionTitle}>Browse signed receipts</div>
      <form
        className={a.formRow}
        onSubmit={(event) => {
          event.preventDefault();
          const from = parseFromSeq(fromText);
          if (from === null) {
            setFormError("Enter a first receipt sequence of 1 or more (a whole number).");
            return;
          }
          setFormError(null);
          setPage({ from, limit });
        }}
      >
        <Field label="Start at receipt sequence">
          <Input inputMode="numeric" value={fromText} onChange={(event) => setFromText(event.target.value)} aria-describedby="receipt-list-help" />
        </Field>
        <Field label="Receipts per page">
          <Select value={String(limit)} onChange={(event) => setLimit(Number(event.target.value))}>
            {RECEIPT_PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="&nbsp;">
          <Button type="submit" disabled={list.isFetching}>
            Show receipts
          </Button>
        </Field>
      </form>
      <p id="receipt-list-help" className={v.faint}>
        Listing receipts is recorded in the audit log, so nothing is listed until you ask.
      </p>
      {formError && (
        <p className={v.errLine} role="alert">
          {formError}
        </p>
      )}
      {page && (
        <div aria-live="polite" className={v.stack}>
          {list.isLoading ? (
            <p role="status" className={v.faint}>
              Loading receipts from sequence {page.from}…
            </p>
          ) : list.isError ? (
            (() => {
              const w = refusalWords("receipt list", list.error, RECEIPT_REFUSALS);
              return (
                <div role="alert" className={v.stack}>
                  <strong>{w.title}</strong>
                  <p>{w.body}</p>
                  {w.retry && (
                    <div>
                      <Button size="sm" onClick={() => void list.refetch()}>
                        Retry
                      </Button>
                    </div>
                  )}
                </div>
              );
            })()
          ) : (
            <>
              <Table<ReceiptRow>
                rows={rows}
                rowKey={(r) => String(r.receiptSeq)}
                empty={
                  <EmptyState
                    title={`No receipts from sequence ${page.from}`}
                    body="Nothing has been signed at or after this sequence yet. The status above says whether signing is on and how many decisions await it."
                  />
                }
                columns={[
                  { key: "seq", header: "Sequence", render: (r) => <span className={v.num}>{r.receiptSeq}</span> },
                  { key: "at", header: "Decided", render: (r) => (r.at ? fmtAt(r.at) : "—") },
                  { key: "effect", header: "Effect", render: (r) => (r.effect ? <Badge tone={effectTone(r.effect)}>{r.effect}</Badge> : "—") },
                  { key: "object", header: "Object", render: (r) => r.objectType ?? "—" },
                  { key: "rule", header: "Rule", render: (r) => (r.ruleId ? <code>{r.ruleId}</code> : "—") },
                  { key: "v", header: "Version", render: (r) => (r.version === null ? "—" : `v${r.version}`) },
                  {
                    key: "open",
                    header: "",
                    align: "right",
                    render: (r) =>
                      r.auditId ? (
                        <Button size="sm" aria-label={`Open receipt ${r.receiptSeq}`} onClick={() => setOpenAudit(r.auditId)}>
                          Open
                        </Button>
                      ) : null,
                  },
                ]}
              />
              <div className={v.row}>
                <span className={v.faint}>
                  {rows.length === 0
                    ? ""
                    : `Showing sequences ${rows[0]!.receiptSeq}–${rows[rows.length - 1]!.receiptSeq}.`}
                </span>
                {page.from > 1 && (
                  <Button size="sm" onClick={() => setPage({ from: Math.max(1, page.from - page.limit), limit: page.limit })}>
                    Previous page
                  </Button>
                )}
                {next !== null && (
                  <Button size="sm" onClick={() => setPage({ from: next, limit: page.limit })}>
                    Next page
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      )}
      <form
        className={a.formRow}
        onSubmit={(event) => {
          event.preventDefault();
          const id = auditDraft.trim().toLowerCase();
          if (!UUID_RE.test(id)) {
            setAuditError("Enter the decision's audit row ID (a UUID). It is not the receipt sequence.");
            return;
          }
          setAuditError(null);
          setOpenAudit(id);
        }}
      >
        <Field label="Audit row ID for a decision receipt" grow>
          <Input value={auditDraft} onChange={(event) => setAuditDraft(event.target.value)} />
        </Field>
        <Field label="&nbsp;">
          <Button type="submit">Open receipt</Button>
        </Field>
      </form>
      {auditError && (
        <p className={v.errLine} role="alert">
          {auditError}
        </p>
      )}
      {openAudit && <ReceiptDialog key={openAudit} auditId={openAudit} onClose={() => setOpenAudit(null)} />}
    </div>
  );
}
