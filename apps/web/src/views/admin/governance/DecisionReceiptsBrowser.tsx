/**
 * Batch U4 — page through signed decision receipts (`GET /v1/receipts`) and
 * open one decision's receipt envelope(s) (`GET /v1/receipts/:auditId`), on the
 * Audit log page beside the receipt status, export and verify controls.
 *
 * Both reads are audited by the gateway, so neither runs on page load: the
 * list (under the shared list control, ADR-0219) is fetched when the person asks for it, and a receipt when they
 * open one. A receipt carries no reason or detail text (ADR-0186 R), so the
 * dialog shows exactly the signed payload and says so.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { fmtAt, UUID_RE } from "../../../api/format";
import { Badge, Button, CodeBlock, EmptyState, Field, Input } from "../../../ui/kit";
import { DataList, type DataColumn } from "../../../ui/DataList";
import { KV } from "../adminKit";
import { DetailDialog } from "../DetailDialog";
import { refusalWords } from "../detailModel";
import { RECEIPT_REFUSALS, parseFromSeq, receiptRow, type ReceiptEnvelope } from "./receiptsModel";
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

/** ADR-0219: the receipts list's columns; the ids and sortable ones match the gateway's RECEIPTS_LIST */
function receiptColumns(open: (auditId: string) => void): Array<DataColumn<ReceiptEnvelope>> {
  return [
    { key: "seq", header: "Sequence", main: true, sortable: true, render: (e) => <span className={v.num}>{e.receiptSeq}</span> },
    { key: "at", header: "Decided", main: true, sortable: true, render: (e) => { const r = receiptRow(e); return r.at ? fmtAt(r.at) : "—"; } },
    {
      key: "effect",
      header: "Effect",
      main: true,
      sortable: true,
      required: "The decision's effect is always shown",
      render: (e) => { const r = receiptRow(e); return r.effect ? <Badge tone={effectTone(r.effect)}>{r.effect}</Badge> : "—"; },
    },
    { key: "object", header: "Object", main: true, sortable: true, render: (e) => receiptRow(e).objectType ?? "—" },
    { key: "rule", header: "Rule", main: true, sortable: true, render: (e) => { const r = receiptRow(e); return r.ruleId ? <code>{r.ruleId}</code> : "—"; } },
    { key: "v", header: "Version", main: true, sortable: true, render: (e) => { const r = receiptRow(e); return r.version === null ? "—" : `v${r.version}`; } },
    {
      key: "open",
      header: "",
      srHeader: "Actions",
      align: "right",
      action: true,
      render: (e) => {
        const r = receiptRow(e);
        return r.auditId ? (
          <Button size="sm" aria-label={`Open receipt ${r.receiptSeq}`} onClick={() => open(r.auditId!)}>
            Open
          </Button>
        ) : null;
      },
    },
  ];
}

export function DecisionReceiptsBrowser() {
  const [fromText, setFromText] = useState("1");
  const [from, setFrom] = useState<number | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [openAudit, setOpenAudit] = useState<string | null>(null);
  const [auditDraft, setAuditDraft] = useState("");
  const [auditError, setAuditError] = useState<string | null>(null);
  const filters = useMemo(() => ({ fromSeq: from === null ? undefined : String(from) }), [from]);
  const columns = useMemo(() => receiptColumns(setOpenAudit), []);

  return (
    <div className={v.stack}>
      <div className={v.sectionTitle}>Browse signed receipts</div>
      <form
        className={a.formRow}
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = parseFromSeq(fromText);
          if (parsed === null) {
            setFormError("Enter a first receipt sequence of 1 or more (a whole number).");
            return;
          }
          setFormError(null);
          setFrom(parsed);
        }}
      >
        <Field label="Start at receipt sequence">
          <Input inputMode="numeric" value={fromText} onChange={(event) => setFromText(event.target.value)} aria-describedby="receipt-list-help" />
        </Field>
        <Field label="&nbsp;">
          <Button type="submit">Show receipts</Button>
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
      {from !== null && (
        <DataList<ReceiptEnvelope>
          listId="decision-receipts"
          noun="receipts"
          endpoint="/v1/receipts"
          exportPath="/v1/receipts/export.xlsx"
          queryKey={["admin", "decision-receipts"]}
          legacyKey="receipts"
          filters={filters}
          defaultSort={{ key: "seq", dir: "asc" }}
          columns={columns}
          rowKey={(e) => String(e.receiptSeq)}
          empty={
            <EmptyState
              title={`No receipts from sequence ${from}`}
              body="Nothing has been signed at or after this sequence yet. The status above says whether signing is on and how many decisions await it."
            />
          }
        />
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
