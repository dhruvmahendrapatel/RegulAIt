import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type { OrgSettingsResponse } from "../../../api/adminTypes";
import { PageHeader } from "../../../shell/AppShell";
import { Button, Card, ConfirmModal, Field, Input, Table } from "../../../ui/kit";
import { QueryGate, useAction } from "../adminKit";
import v from "../../views.module.css";

interface MemoryStore {
  kind: string;
  rows: number;
  oldestAt: string | null;
  isolation: string;
  retention: { setting: string | null; value: number | null; enforcedBy: string | null; lastRunAt: string | null };
  held: number | null;
  owner: { kind: "org" };
}
const STORE_NAMES: Record<string, string> = {
  semantic_cache: "Semantic cache", conversations: "Conversations",
  builder_agent_memory: "Builder agent memory", project_context_items: "Project context items",
};

export default function RetentionPage() {
  const settings = useQuery({ queryKey: ["admin", "org-settings"], queryFn: () => api.get<OrgSettingsResponse>("/v1/org/settings") });
  const inventory = useQuery({ queryKey: ["admin", "memory-stores"], queryFn: () => api.get<{ stores: MemoryStore[] }>("/v1/inventory/memory-stores") });
  return <>
    <PageHeader title="Memory & retention" sub="Retention limits, isolation and evidence holds for this organisation's memory stores." />
    <div className={v.stack}>
      <Card title="Retention settings">
        <QueryGate loading={settings.isLoading} error={settings.error} onRetry={() => void settings.refetch()}>
          {settings.data && <RetentionSettings key={JSON.stringify(settings.data.settings)} settings={settings.data.settings} />}
        </QueryGate>
      </Card>
      <Card title="Memory-store inventory">
        <p>Counts and dates only; stored content is never loaded here. An evidence hold keeps incident records past their retention limit.</p>
        <Table<MemoryStore> rows={inventory.data?.stores ?? []} rowKey={(row) => row.kind}
          loading={inventory.isLoading} error={inventory.error} onRetry={() => void inventory.refetch()}
          columns={[
            { key: "kind", header: "Store", render: (row) => STORE_NAMES[row.kind] ?? row.kind },
            { key: "rows", header: "Rows", render: (row) => row.rows.toLocaleString() },
            { key: "oldest", header: "Oldest record", render: (row) => row.oldestAt ? new Date(row.oldestAt).toLocaleString() : "No records" },
            { key: "isolation", header: "Isolation", render: (row) => row.isolation },
            { key: "retention", header: "Retention", render: (row) => row.retention.enforcedBy === null ? "No retention sweep implemented" : `${row.retention.value} ${row.retention.setting === "semanticCacheTtlSeconds" ? "seconds" : "days"}` },
            { key: "run", header: "Last successful sweep", render: (row) => row.retention.enforcedBy === null ? "Not applicable" : row.retention.lastRunAt ? new Date(row.retention.lastRunAt).toLocaleString() : "No successful run recorded" },
            { key: "held", header: "Held past retention", render: (row) => row.held === null ? "Not measured" : row.held },
            { key: "owner", header: "Owner", render: () => "Organisation" },
          ]} />
      </Card>
      <MetricsPostureCard />
    </div>
  </>;
}

function RetentionSettings({ settings }: { settings: Record<string, unknown> }) {
  const act = useAction();
  const [ttl, setTtl] = useState(String(settings.semanticCacheTtlSeconds ?? ""));
  const [days, setDays] = useState(String(settings.conversationRetentionDays ?? ""));
  const [pending, setPending] = useState<{ semanticCacheTtlSeconds: number; conversationRetentionDays: number } | null>(null);
  const unavailable = typeof settings.semanticCacheTtlSeconds !== "number" || typeof settings.conversationRetentionDays !== "number";
  const save = (body: NonNullable<typeof pending>) => act.run(() => api.put("/v1/org/settings", body), "Retention settings saved");
  return <form className={v.stack} onSubmit={(event) => {
    event.preventDefault();
    if (!/^\d+$/.test(ttl) || !/^\d+$/.test(days) || Number(ttl) < 1 || Number(ttl) > 2592000 || Number(days) < 1 || Number(days) > 2555) {
      act.setError("Enter whole numbers: cache lifetime 1–2,592,000 seconds; conversation retention 1–2,555 days."); return;
    }
    const body = { semanticCacheTtlSeconds: Number(ttl), conversationRetentionDays: Number(days) };
    if (body.semanticCacheTtlSeconds > Number(settings.semanticCacheTtlSeconds) || body.conversationRetentionDays > Number(settings.conversationRetentionDays)) setPending(body);
    else void save(body);
  }}>
    {unavailable && <p role="alert">This gateway has not reported its retention settings. Refresh before changing them.</p>}
    <Field label="Semantic cache lifetime (seconds)"><Input type="number" required min={1} max={2592000} step={1} value={ttl} onChange={(event) => setTtl(event.target.value)} disabled={act.busy || unavailable} /></Field>
    <p>The default is 3,600 seconds. Extending it retains cached information longer; every change is audited.</p>
    <Field label="Conversation retention (days)"><Input type="number" required min={1} max={2555} step={1} value={days} onChange={(event) => setDays(event.target.value)} disabled={act.busy || unavailable} /></Field>
    <p>The strict default is 30 days since the last activity. More than 30 days relaxes that limit and is audited. Incident evidence holds still apply.</p>
    <Button type="submit" variant="primary" disabled={act.busy || unavailable}>Save retention settings</Button>
    {act.error && <p role="alert">{act.error}</p>}
    <ConfirmModal open={pending !== null} title="Extend memory retention?" body={<p>Cache lifetime: {pending?.semanticCacheTtlSeconds} seconds. Conversation retention: {pending?.conversationRetentionDays} days. This retains information longer and the gateway audits the change.</p>}
      confirmLabel="Save audited change" onCancel={() => setPending(null)} onConfirm={() => { const body = pending; setPending(null); if (body) void save(body); }} />
  </form>;
}

interface MetricsPosture {
  separateListener: "off" | "loopback" | "non_loopback";
  mainListener: boolean;
  tokenConfigured: boolean;
}

function isMetricsPosture(value: unknown): value is MetricsPosture {
  if (!value || typeof value !== "object") return false;
  const metrics = value as Partial<MetricsPosture>;
  return ["off", "loopback", "non_loopback"].includes(metrics.separateListener ?? "") &&
    typeof metrics.mainListener === "boolean" && typeof metrics.tokenConfigured === "boolean";
}

function MetricsPostureCard() {
  const posture = useQuery({ queryKey: ["admin", "org-posture"], retry: false,
    queryFn: () => api.get<{ metrics?: unknown }>("/v1/org/posture"),
  });
  const metrics = posture.data?.metrics;
  const measured = isMetricsPosture(metrics);
  return <Card title="Metrics posture">
    <p>Metrics are disabled by default. This gateway reports its deployment configuration; reachability and authentication through a proxy still need operator verification.</p>
    <QueryGate loading={posture.isLoading} error={posture.error} onRetry={() => void posture.refetch()}>
      {posture.data && (measured ? <>
        <p>Separate metrics listener: {metrics.separateListener === "off" ? "off" : metrics.separateListener === "loopback" ? "loopback only" : "non-loopback"}.</p>
        <p>Main listener: {metrics.mainListener ? "metrics enabled" : "no metrics endpoint served"}.</p>
        <p>Bearer token configured: {metrics.tokenConfigured ? "yes" : "no"}.</p>
        {/* Defensive state: the current gateway refuses enabled metrics listeners without a token. */}
        {(metrics.separateListener !== "off" || metrics.mainListener) && !metrics.tokenConfigured &&
          <p role="alert">The gateway reports an enabled metrics listener without a configured bearer token. Ask the deployment operator to check protection.</p>}
      </> : <p>Separate metrics listener: unmeasured. This gateway has not reported a complete metrics configuration. Ask the deployment operator to verify the listener and token protection.</p>)}
    </QueryGate>
    {posture.error && <p>Metrics configuration is unmeasured because the posture request failed. A refusal or missing route does not mean metrics are disabled.</p>}
    <Button onClick={() => void posture.refetch()} disabled={posture.isFetching}>Refresh metrics posture</Button>
  </Card>;
}
