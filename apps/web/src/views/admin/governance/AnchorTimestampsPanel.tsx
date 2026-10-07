import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { Button, Card, Table } from "../../../ui/kit";
import { downloadCsv, QueryGate, useAction } from "../adminKit";
import { fmtAt } from "../../../api/format";
import v from "../../views.module.css";

interface Timestamp { status: "not_configured" | "pending" | "granted" | "failed"; genTime: string | null; tsaUrl: string | null; serial: string | null; policyOid: string | null; verified: boolean }
interface Anchor { id: string; seq: number; status: string; timestamp?: Timestamp }
export function AnchorTimestampsPanel() {
  const anchors = useQuery({ queryKey: ["admin", "anchor-timestamps"], retry: false, queryFn: () => api.get<{ anchors: Anchor[] }>("/v1/audit/anchors") });
  const act = useAction();
  const rows = anchors.data?.anchors;
  return <Card title="Anchor timestamps">
    <p>A configured time-stamping authority can sign the canonical anchor bytes. Without a verified token, an anchor has no trusted timestamp.</p>
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
          <Button disabled={act.busy || row.status !== "flushed" || row.timestamp?.status === "granted"} onClick={() => void act.run(async () => { await api.post(`/v1/audit/anchors/${row.id}/timestamp`); await anchors.refetch(); }, "Anchor timestamp checked").then(() => void anchors.refetch())}>Retry timestamp for anchor {row.seq}</Button>
          <Button disabled={act.busy || row.timestamp?.status !== "granted" || !row.timestamp.verified} onClick={() => void act.run(async () => { await downloadCsv(`/v1/audit/anchors/${row.id}/timestamp.tsr`, `anchor-${row.seq}.tsr`, (message) => { throw new Error(message); }); }, "Timestamp reply downloaded")}>Download timestamp for anchor {row.seq}</Button>
        </div> },
      ]} /> : anchors.data ? <p>Anchor timestamp data is not reported by this gateway.</p> : null}
    </QueryGate>
    {act.error && <p role="alert">{act.error}</p>}
    <p>Verify exported tokens against independently trusted certificates and the canonical anchor bytes. A timestamp does not prove the underlying decisions were correct, that later records are complete, or when a separate receipt was signed. Certificate revocation checks are not performed by this air-gapped verifier.</p>
  </Card>;
}
