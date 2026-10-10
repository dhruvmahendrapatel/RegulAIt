import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { Card } from "../../../ui/kit";
import { QueryGate } from "../adminKit";
import v from "../../views.module.css";
interface Pack { id: string; source: string; repo: string; commit: string; sha256: string; licence: string; rules: number; notImported: Array<{ id: string; reason: string }>; enabled: boolean; auditRedactionAlways?: boolean }
export function DetectionContentPanel() {
  const query = useQuery({ queryKey: ["admin", "detection-content"], retry: false, queryFn: () => api.get<{ packs: Pack[]; outboundAudienceEnforced?: boolean }>("/v1/detection-content") });
  return <Card title="Vendored detection content">
    <p>Pinned upstream data runs through the local detector. Enabled packs can still have coverage gaps; excluded rules are listed below.</p>
    <QueryGate loading={query.isLoading} error={query.error} onRetry={() => void query.refetch()}>
      {Array.isArray(query.data?.packs) ? <div className={v.stack}>
        <p>{query.data!.outboundAudienceEnforced === true ? "Credential audience restrictions are enforced on outbound requests." : query.data!.outboundAudienceEnforced === false ? "Credential audience restrictions are not installed on outbound requests." : "Outbound credential audience enforcement is not reported."}</p>
        {query.data!.packs.map((pack) => <div key={pack.id}>
          <p><strong>{pack.id}</strong>: {pack.enabled ? "Enabled" : "Disabled"}; {pack.rules} imported {pack.rules === 1 ? "rule" : "rules"}; {pack.notImported.length} exclusions.</p>
          {pack.rules === 0 && <p>This pack has no eligible imported rules and contributes no detections.</p>}
          {pack.id === "pipelock-secrets" && <p>This setting controls credential detections in the runtime DLP detector and caller-content audience checks where installed. Audit redaction always remains on.</p>}
          {pack.auditRedactionAlways && <p>Secret redaction on the audit path always applies, including when this pack is disabled elsewhere.</p>}
          <p>Source: {pack.source}. Licence: {pack.licence}. Commit: <code>{pack.commit}</code>.</p>
          <p>Snapshot SHA-256: <code>{pack.sha256}</code>.</p>
          {pack.notImported.length > 0 && <details><summary>Excluded content for {pack.id}</summary><ul>{pack.notImported.map((entry) => <li key={entry.id}><code>{entry.id}</code>: {entry.reason}</li>)}</ul></details>}
        </div>)}
      </div> : query.data ? <p>Detection content is not reported by this gateway.</p> : null}
    </QueryGate>
  </Card>;
}
