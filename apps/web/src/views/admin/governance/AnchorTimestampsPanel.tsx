import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { Button, Card, Table } from "../../../ui/kit";
import { downloadCsv, QueryGate, useAction } from "../adminKit";
import { fmtAt } from "../../../api/format";
import v from "../../views.module.css";

interface Timestamp { status: "not_configured" | "pending" | "granted" | "failed"; genTime: string | null; tsaUrl: string | null; serial: string | null; policyOid: string | null; verified: boolean }
interface Anchor { id: string; seq: number; status: string; timestamp?: Timestamp }
interface AnchorsResponse { anchors: Anchor[]; sink?: { destination: string; tamperResistant: boolean; mode: string | null } | null; disclosure?: string }
/** POST /v1/audit/anchor (201): the head this anchor pins and where it went */
export interface CaptureResult { anchorId: string; seq: number; rowHash: string; destination: string; status: "pending" | "flushed" | "failed"; externalRef: string | null; tamperResistant: boolean; error: string | null }
/** POST /v1/audit/anchors/flush */
export interface FlushResult { attempted: number; flushed: number; failed: number }
export function captureSentence(r: CaptureResult): string {
  const where = r.destination === "none" ? "this database only (no anchor sink is configured)" : r.destination.replaceAll("_", " ");
  const state = r.status === "flushed" ? "written out" : r.status === "pending" ? "waiting to be written out" : `not written out${r.error ? ` (${r.error})` : ""}`;
  return `Anchored the chain at row ${r.seq}: ${state}, to ${where}.${r.tamperResistant ? "" : " This destination is not tamper-resistant, so it is a consistency check, not evidence."}`;
}
export function flushSentence(r: FlushResult): string {
  if (r.attempted === 0) return "No anchors were waiting to be written out.";
  return `${r.flushed} of ${r.attempted} waiting ${r.attempted === 1 ? "anchor" : "anchors"} written out${r.failed ? `; ${r.failed} failed and stay pending` : ""}.`;
}
/** `bare` (G8 f): folded on the audit log, whose disclosure summary carries the title and the timestamp state */
export function AnchorTimestampsPanel(props: { bare?: boolean } = {}) {
  const anchors = useQuery({ queryKey: ["admin", "anchor-timestamps"], retry: false, queryFn: () => api.get<AnchorsResponse>("/v1/audit/anchors") });
  const act = useAction();
  const [said, setSaid] = useState<string | null>(null);
  const rows = anchors.data?.anchors;
  const pending = Array.isArray(rows) ? rows.filter((row) => row.status === "pending" || row.status === "failed").length : 0;
  return <Card title={props.bare ? undefined : "Anchor timestamps"}>
    <p>A configured time-stamping authority can sign the canonical anchor bytes. Without a verified token, an anchor has no trusted timestamp.</p>
    {anchors.data?.disclosure ? <p className={v.faint}>{anchors.data.disclosure}</p> : null}
    <div className={v.row}>
      <Button variant="primary" disabled={act.busy} onClick={() => void act.run(async () => { const out = await api.post<CaptureResult>("/v1/audit/anchor"); const sentence = captureSentence(out); setSaid(sentence); await anchors.refetch(); return sentence; })}>Anchor the chain now</Button>
      <Button disabled={act.busy} onClick={() => void act.run(async () => { const out = await api.post<FlushResult>("/v1/audit/anchors/flush"); const sentence = flushSentence(out); setSaid(sentence); await anchors.refetch(); return sentence; })}>Write out pending anchors{pending ? ` (${pending})` : ""}</Button>
    </div>
    <p className={v.faint}>Anchoring pins the current head of the audit chain and records that it did. Writing out retries every anchor not yet stored at the configured destination.</p>
    {said ? <p role="status" data-testid="anchor-said">{said}</p> : null}
    <QueryGate loading={anchors.isLoading} error={anchors.error} onRetry={() => void anchors.refetch()}>
      {Array.isArray(rows) ? rows.length === 0 ? <p>No anchors are available to timestamp.</p> : <Table rows={rows} rowKey={(row) => row.id} columns={[
        { key: "seq", header: "Anchor sequence", render: (row) => row.seq },
        { key: "timestamp", header: "Timestamp", render: (row) => {
          const value = row.timestamp;
          if (!value || !["not_configured", "pending", "granted", "failed"].includes(value.status)) return "Timestamp state not reported";
          if (value.status === "granted") return value.verified && value.genTime ? `Verified at issuance: ${fmtAt(value.genTime)}` : "Token present; verification not reported";
          return value.status === "not_configured" ? "Not timestamped: no authority configured" : value.status === "pending" ? "Waiting for anchor storage or timestamp retry" : "Timestamp attempt failed";
        } },
        { key: "actions", header: "Actions", render: (row) => <div className={v.stack}>
          <Button disabled={act.busy || row.status !== "flushed" || (row.timestamp?.status === "granted" || row.timestamp?.status === "not_configured")} onClick={() => void act.run(async () => { await api.post(`/v1/audit/anchors/${row.id}/timestamp`); await anchors.refetch(); }, "Anchor timestamp checked").then(() => void anchors.refetch())}>Retry timestamp for anchor {row.seq}</Button>
          <Button disabled={act.busy || row.timestamp?.status !== "granted" || !row.timestamp.verified} onClick={() => void act.run(async () => { await downloadCsv(`/v1/audit/anchors/${row.id}/timestamp.tsr`, `anchor-${row.seq}.tsr`, (message) => { throw new Error(message); }); }, "Timestamp reply downloaded")}>Download timestamp for anchor {row.seq}</Button>
        </div> },
      ]} /> : anchors.data ? <p>Anchor timestamp data is not reported by this gateway.</p> : null}
    </QueryGate>
    {act.error && <p role="alert">{act.error}</p>}
    <p>Verify exported tokens against independently trusted certificates and the canonical anchor bytes. A timestamp does not prove the underlying decisions were correct, that later records are complete, or when a separate receipt was signed. Certificate revocation checks are not performed by this air-gapped verifier.</p>
  </Card>;
}
