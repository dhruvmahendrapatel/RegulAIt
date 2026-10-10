import { lazy, Suspense, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { Button, Card, Field, Input } from "../../../ui/kit";
import { QueryGate, useAction } from "../adminKit";
import { checkedAuditId } from "./bomModel";
import v from "../../views.module.css";
const DecisionBomPanel = lazy(() => import("./DecisionBomPanel").then((module) => ({ default: module.DecisionBomPanel })));

interface ReceiptStatus { state: "signing" | "no_key" | "off" | "stalled"; lastSeq: number; lagRows: number }
interface Verification { results: Array<{ receiptSeq: number | null; status: "valid" | "invalid" | "unverifiable"; reason: string }>; cannotProve: string[] }

export function DecisionReceiptsPanel() {
  const status = useQuery({ queryKey: ["admin", "decision-receipts-status"], retry: false, queryFn: () => api.get<ReceiptStatus>("/v1/receipts/status") });
  const act = useAction();
  const [auditId, setAuditId] = useState("");
  const [bomAuditId, setBomAuditId] = useState("");
  const readVersion = useRef(0);
  const [reading, setReading] = useState(false);
  const [from, setFrom] = useState("1"); const [to, setTo] = useState("");
  const [bundle, setBundle] = useState<unknown>(null); const [result, setResult] = useState<Verification | null>(null);
  const measured = status.data && ["signing", "no_key", "off", "stalled"].includes(status.data.state) && Number.isSafeInteger(status.data.lastSeq) && Number.isSafeInteger(status.data.lagRows) && status.data.lastSeq >= 0 && status.data.lagRows >= 0;
  return <Card title="Signed decision receipts">
    <p>Receipts sign governed-call and approval decisions without their reason or detail text. Admin configuration stays on the audit hash chain. Oversized tool names and rule IDs are represented by SHA-256 hashes.</p>
    <QueryGate loading={status.isLoading} error={status.error} onRetry={() => void status.refetch()}>
      {measured ? <>
        <p>{status.data!.state === "signing" ? "Receipt signing is configured." : status.data!.state === "stalled" ? "Receipt signing is stalled or its latest sweep failed. Check the scheduler and unsigned decision backlog." : status.data!.state === "no_key" ? "Unsigned: no receipt signing key is configured." : "Receipt signing is off."}</p>
        <p>Last receipt sequence: {status.data!.lastSeq}. Decision rows awaiting signing: {status.data!.lagRows}.</p>
      </> : status.data ? <p>Receipt signing state is not reported by this gateway.</p> : null}
    </QueryGate>
    <form className={v.stack} onSubmit={(event) => { event.preventDefault(); const id = auditId.trim(); try { checkedAuditId(id); } catch { act.setError("Enter the decision audit UUID from the receipt or audit log."); return; } act.setError(null); setBomAuditId(id); }}>
      <Field label="Audit row ID for Decision BOM"><Input required value={auditId} onChange={(event) => setAuditId(event.target.value)} /></Field>
      <p>Use the audit row ID, which is distinct from the receipt sequence. Access and finality are checked by the gateway.</p>
      <Button type="submit">Open Decision BOM</Button>
    </form>
    {bomAuditId ? <Suspense fallback={<p role="status">Loading Decision BOM controls…</p>}><DecisionBomPanel key={bomAuditId} auditId={bomAuditId} /></Suspense> : null}
    <form className={v.stack} onSubmit={(event) => {
      event.preventDefault();
      const first = Number(from), last = Number(to || status.data?.lastSeq);
      if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first || last - first + 1 > 5000) { act.setError("Choose a nonempty range of at most 5,000 receipt sequences."); return; }
      void act.run(async () => {
        const value = await api.get<unknown>(`/v1/receipts/export?fromSeq=${first}&toSeq=${last}`);
        setBundle(value); setResult(null);
        const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
        const link = document.createElement("a"); link.href = url; link.download = `decision-receipts-${first}-${last}.json`; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }, "Receipt bundle exported");
    }}>
      <Field label="First receipt sequence"><Input type="number" min={1} required step={1} value={from} onChange={(event) => setFrom(event.target.value)} /></Field>
      <Field label="Last receipt sequence (blank = latest)"><Input type="number" min={1} step={1} value={to} onChange={(event) => setTo(event.target.value)} /></Field>
      <p>Exporting is audited. A range starting after sequence 1 cannot verify the omitted prefix on its own.</p>
      <Button type="submit" disabled={act.busy || reading || !measured || status.data!.lastSeq < 1}>Export receipt bundle</Button>
    </form>
    <Field label="Receipt bundle to verify"><Input type="file" accept=".json,application/json" disabled={act.busy} onChange={(event) => {
      const version = ++readVersion.current;
      setReading(false); setResult(null); setBundle(null); act.setError(null);
      const file = event.target.files?.[0]; if (!file) return;
      if (file.size > 5 * 1024 * 1024) { act.setError("Choose a receipt JSON file no larger than 5 MiB."); return; }
      setReading(true);
      void file.text().then((text) => {
        if (version !== readVersion.current) return;
        try { setBundle(JSON.parse(text)); } catch { act.setError("This file is not valid JSON."); }
      }).catch(() => { if (version === readVersion.current) act.setError("The receipt file could not be read."); })
        .finally(() => { if (version === readVersion.current) setReading(false); });
    }} /></Field>
    <Button disabled={act.busy || reading || bundle === null} onClick={() => void act.run(async () => { setResult(await api.post<Verification>("/v1/receipts/verify", bundle)); }, "Receipt bundle checked")}>Verify loaded receipt bundle</Button>
    <p>Online verification uses this deployment’s recorded public keys, never a key supplied only by the uploaded bundle.</p>
    <p>Offline verification is also available with the receipt verifier CLI. Pin public keys independently; keys supplied by an untrusted bundle do not establish the signer’s identity.</p>
    {act.error && <p role="alert">{act.error}</p>}
    {result && <div role="status" className={v.stack}>
      {result.results.length === 0 ? <p>No receipts were checked; this is not a completeness finding.</p> : <ul>{result.results.map((row, i) => <li key={i}>Receipt {row.receiptSeq ?? "unknown"}: {row.status} — {row.reason}</li>)}</ul>}
      <p>A passing signature cannot prove:</p><ul>{result.cannotProve.map((limit) => <li key={limit}>{limit}</li>)}</ul>
    </div>}
  </Card>;
}
