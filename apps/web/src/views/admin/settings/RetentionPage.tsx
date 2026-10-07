import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type { OrgSettingsResponse } from "../../../api/adminTypes";
import { PageHeader } from "../../../shell/AppShell";
import { Button, Card, ConfirmModal, Field, Input, Table } from "../../../ui/kit";
import { QueryGate, readCurrentOrgSettings, useAction, useSingleFlight } from "../adminKit";
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

type RetentionBody = Partial<{ semanticCacheTtlSeconds: number; conversationRetentionDays: number }>;
/**
 * PUT /v1/org/settings is a partial update, so the form sends only the fields
 * this admin edited: re-sending an untouched field from the loaded snapshot
 * would silently revert another admin's concurrent change to it. `extends` is
 * classified against `current`, the settings re-read just before saving (null
 * when that read failed, which always asks for confirmation).
 */
export function retentionChanges(settings: Record<string, unknown>, ttl: string, days: string, current: Record<string, unknown> | null): { error: string } | { body: RetentionBody; extends: boolean } {
  // an edit is a different NUMBER ("030" is the stored 30); text that is not
  // a whole number counts as edited so the validation below reports it
  const edited = (text: string, stored: unknown) => !/^\d+$/.test(text) || Number(text) !== stored;
  const ttlEdited = edited(ttl, settings.semanticCacheTtlSeconds);
  const daysEdited = edited(days, settings.conversationRetentionDays);
  if ((ttlEdited && (!/^\d+$/.test(ttl) || Number(ttl) < 1 || Number(ttl) > 2592000)) || (daysEdited && (!/^\d+$/.test(days) || Number(days) < 1 || Number(days) > 2555))) {
    return { error: "Enter whole numbers: cache lifetime 1–2,592,000 seconds; conversation retention 1–2,555 days." };
  }
  const body: RetentionBody = {
    ...(ttlEdited ? { semanticCacheTtlSeconds: Number(ttl) } : {}),
    ...(daysEdited ? { conversationRetentionDays: Number(days) } : {}),
  };
  // classified against what is stored NOW; an unreadable value counts as a relaxation
  const raises = (key: keyof RetentionBody) => {
    const next = body[key];
    if (next === undefined) return false;
    const stored = current?.[key];
    return typeof stored !== "number" || next > stored;
  };
  const extends_ = raises("semanticCacheTtlSeconds") || raises("conversationRetentionDays");
  return { body, extends: extends_ };
}

function RetentionSettings({ settings }: { settings: Record<string, unknown> }) {
  const act = useAction();
  const flight = useSingleFlight();
  const [ttl, setTtl] = useState(String(settings.semanticCacheTtlSeconds ?? ""));
  const [days, setDays] = useState(String(settings.conversationRetentionDays ?? ""));
  const [pending, setPending] = useState<RetentionBody | null>(null);
  const unavailable = typeof settings.semanticCacheTtlSeconds !== "number" || typeof settings.conversationRetentionDays !== "number";
  const save = (body: RetentionBody) => act.run(() => api.put("/v1/org/settings", body), "Retention settings saved");
  const submit = async () => {
    // busy BEFORE the re-read: a second submit meanwhile is ignored
    if (!flight.enter()) return;
    let confirming = false;
    try {
      const edited = retentionChanges(settings, ttl, days, settings);
      if ("error" in edited) { act.setError(edited.error); return; }
      if (Object.keys(edited.body).length === 0) { act.setError("No retention setting changed."); return; }
      // classify against the values stored now, not the loaded snapshot
      const change = retentionChanges(settings, ttl, days, await readCurrentOrgSettings());
      if ("error" in change) { act.setError(change.error); return; }
      if (change.extends) { confirming = true; setPending(change.body); return; }
      await save(change.body);
    } finally {
      // a confirmation keeps the flight until it is cancelled or saved
      if (!confirming) flight.leave();
    }
  };
  const busy = act.busy || flight.busy;
  return <form className={v.stack} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    {unavailable && <p role="alert">This gateway has not reported its retention settings. Refresh before changing them.</p>}
    <Field label="Semantic cache lifetime (seconds)"><Input type="number" required min={1} max={2592000} step={1} value={ttl} onChange={(event) => setTtl(event.target.value)} disabled={busy || unavailable} /></Field>
    <p>The default is 3,600 seconds. Extending it retains cached information longer; every change is audited.</p>
    <Field label="Conversation retention (days)"><Input type="number" required min={1} max={2555} step={1} value={days} onChange={(event) => setDays(event.target.value)} disabled={busy || unavailable} /></Field>
    <p>The strict default is 30 days since the last activity. More than 30 days relaxes that limit and is audited. Incident evidence holds still apply.</p>
    <Button type="submit" variant="primary" disabled={busy || unavailable}>Save retention settings</Button>
    {act.error && <p role="alert">{act.error}</p>}
    <ConfirmModal open={pending !== null} title="Extend memory retention?" body={<p>{pending?.semanticCacheTtlSeconds !== undefined && <>Cache lifetime: {pending.semanticCacheTtlSeconds} seconds. </>}{pending?.conversationRetentionDays !== undefined && <>Conversation retention: {pending.conversationRetentionDays} days. </>}This retains information longer and the gateway audits the change.</p>}
      confirmLabel="Save audited change" onCancel={() => { setPending(null); flight.leave(); }}
      onConfirm={() => { const body = pending; setPending(null); void (async () => { try { if (body) await save(body); } finally { flight.leave(); } })(); }} />
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
        {(metrics.separateListener !== "off" || metrics.mainListener) && !metrics.tokenConfigured &&
          <p role="alert">The gateway reports an enabled metrics listener without a configured bearer token. Ask the deployment operator to check protection.</p>}
      </> : <p>Separate metrics listener: unmeasured. This gateway has not reported a complete metrics configuration. Ask the deployment operator to verify the listener and token protection.</p>)}
    </QueryGate>
    {posture.error && <p>Metrics configuration is unmeasured because the posture request failed. A refusal or missing route does not mean metrics are disabled.</p>}
    <Button onClick={() => void posture.refetch()} disabled={posture.isFetching}>Refresh metrics posture</Button>
  </Card>;
}
