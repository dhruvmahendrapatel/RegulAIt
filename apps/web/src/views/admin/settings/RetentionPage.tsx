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

function MetricsPostureCard() {
  const probe = useQuery({ queryKey: ["admin", "metrics-main-listener"], retry: false,
    queryFn: async () => {
      try {
        const response = await fetch("/metrics", { credentials: "omit", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5000) });
        const status = response.status;
        await response.body?.cancel();
        return status;
      } catch {
        throw new Error("Could not measure the main metrics listener. Check connectivity and retry.");
      }
    },
  });
  return <Card title="Metrics posture">
    <p>Metrics are disabled by default. Enabling collection is an operator deployment setting; a bearer token protects the enabled metrics endpoint.</p>
    <QueryGate loading={probe.isLoading} error={probe.error} onRetry={() => void probe.refetch()}>
      {probe.data === 404 ? <p>Main listener: no metrics endpoint served (404).</p>
        : probe.data === 401 ? <p>Main listener: refused this request without a bearer token (401).</p>
        : probe.data === 200 ? <p role="alert">Main listener: metrics were accessible without a bearer token. Ask the deployment operator to check authentication.</p>
        : probe.data !== undefined ? <p>Main listener: unmeasured; the probe returned HTTP {probe.data}.</p> : null}
    </QueryGate>
    <p>Separate metrics listener: unmeasured. This gateway does not expose its configuration to the portal; a main-listener 404 does not prove metrics are disabled elsewhere. Ask the deployment operator to verify the listener and its token protection.</p>
    <Button onClick={() => void probe.refetch()} disabled={probe.isFetching}>Refresh metrics posture</Button>
  </Card>;
}
