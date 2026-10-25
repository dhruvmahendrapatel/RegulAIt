/**
 * ADR-0101 — federated MCP registries, a tab on Integrations > MCP servers
 * (ADR-0177 §3: no new navigation group).
 *
 * Configure an upstream registry, pull it into the catalogue, browse what it
 * lists, and import ONE entry as an MCP server. What the screen keeps honest:
 *  - a new registry starts disabled (the strict default) and enabling it says
 *    it is a relaxation;
 *  - a sync writes the catalogue and nothing else: its result says how many
 *    entries it saw, never "servers added";
 *  - an import creates exactly one server row, unscanned, with no tools and no
 *    grants, so nobody can use it until an admin grants it and its first
 *    connect passes the admission scan (ADR-0097).
 * Admin only: none of these routes is in the gateway's NON_ADMIN_ROUTES, and
 * the page sits under RequireAdmin.
 */
import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError, api } from "../../../api/client";
import { ago, fmtAt } from "../../../api/format";
import { Badge, Button, Card, ConfirmModal, EmptyState, Field, IdChip, Input, Modal, Select, Table } from "../../../ui/kit";
import { useAction } from "../adminKit";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import {
  EMPTY_REGISTRY_DRAFT,
  PRIVATE_RANGES_TEXT,
  SYNC_OUTCOME_TONE,
  createRegistryBody,
  entryImportability,
  privateRangesOf,
  registryRefusalText,
  syncSucceeded,
  syncSummary,
  updateRegistryBody,
  type CreateRegistryBody,
  type McpRegistry,
  type McpRegistryEntries,
  type McpRegistryEntry,
  type McpRegistryList,
  type PrivateRanges,
  type RefusalScope,
  type RegistryDraft,
  type RegistryImportResult,
  type RegistrySyncResult,
} from "./mcpRegistryModel";
import a from "../admin.module.css";
import v from "../../views.module.css";

export const mcpRegistryKeys = {
  list: ["admin", "mcp-registries"] as const,
  entries: (id: string) => ["admin", "mcp-registries", "entries", id] as const,
};

/** a registry refusal in the page's words (the gateway's detail kept), else the client's reading */
async function registryCall<T>(fn: () => Promise<T>, scope: RefusalScope = "registry"): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const text = e instanceof ApiError ? registryRefusalText(e.payload, scope) : null;
    throw text ? new Error(text) : e;
  }
}

function PrivateRangeOptions() {
  return (
    <>
      {(Object.keys(PRIVATE_RANGES_TEXT) as PrivateRanges[]).map((k) => (
        <option key={k} value={k}>
          {PRIVATE_RANGES_TEXT[k]}
        </option>
      ))}
    </>
  );
}

export function McpRegistriesPanel() {
  const list = useQuery({ queryKey: mcpRegistryKeys.list, queryFn: () => api.get<McpRegistryList>("/v1/mcp-registries") });
  const [editing, setEditing] = useState<McpRegistry | null>(null);
  const [browsing, setBrowsing] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<RegistrySyncResult | null>(null);
  const sync = useAction();
  const registries = list.data?.registries ?? [];
  const browsed = registries.find((r) => r.id === browsing) ?? null;

  const runSync = (r: McpRegistry) =>
    sync.run(async () => {
      const out = await registryCall(() => api.post<RegistrySyncResult>(`/v1/mcp-registries/${r.id}/sync`));
      setLastSync(out);
      await list.refetch();
      // every outcome answers 200: anything but ok is reported as a failure, never a green toast
      if (!syncSucceeded(out)) throw new Error(`Sync of ${r.name} ${out.outcome}: ${out.reason}`);
      return `Synced ${r.name}: ${syncSummary(out)}`;
    }, undefined);

  return (
    <div className={v.stack}>
      {list.data?.federationRefused && (
        <p role="note" className={v.errLine}>
          Federation is refused in this deployment ({list.data.deployMode}): {list.data.federationRefusedReason ?? "registries cannot be pulled"}. Registries can
          be recorded, but every sync is refused.
        </p>
      )}
      <Card title="Federated registries">
        <p className={v.faint} style={{ marginTop: 0 }}>
          An upstream registry lists MCP servers that exist elsewhere. Pulling it fills a catalogue here and changes nothing else: no server,
          tool or grant is created until an admin imports one entry. A registry is off until you enable it; only enabled registries are pulled by
          the scheduled sweep
          {list.data ? ` (at most ${list.data.maxRegistriesPerSweep} per pass, ${list.data.maxPagesPerSync} pages each)` : ""}.
        </p>
        <CreateRegistryForm />
        <Table<McpRegistry>
          rows={registries}
          rowKey={(r) => r.id}
          loading={list.isLoading}
          error={list.error}
          onRetry={() => void list.refetch()}
          empty={<EmptyState title="No registries configured" body="Federation is off because there is nothing to federate. Add a registry above." />}
          columns={[
            { key: "name", header: "Registry", render: (r) => r.name },
            { key: "url", header: "Base URL", render: (r) => <span className={v.mono}>{r.url}</span> },
            { key: "enabled", header: "State", render: (r) => (r.enabled ? <Badge tone="warn">enabled</Badge> : <Badge tone="neutral">disabled</Badge>) },
            { key: "ranges", header: "Private ranges", render: (r) => PRIVATE_RANGES_TEXT[privateRangesOf(r.allowPrivateRanges)] },
            {
              key: "sync",
              header: "Last sync",
              render: (r) =>
                r.lastSyncAt && r.lastSyncOutcome ? (
                  <span title={fmtAt(r.lastSyncAt)}>
                    <Badge tone={SYNC_OUTCOME_TONE[r.lastSyncOutcome]}>{r.lastSyncOutcome}</Badge> {ago(r.lastSyncAt)}
                  </span>
                ) : (
                  <span className={v.faint}>never</span>
                ),
            },
            {
              key: "actions",
              header: "Actions",
              align: "right",
              render: (r) => (
                <span className={v.row}>
                  <Button size="sm" variant="ghost" aria-label={`Edit registry ${r.name}`} onClick={() => setEditing(r)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" aria-label={`Sync now: registry ${r.name}`} disabled={sync.busy} onClick={() => void runSync(r)}>
                    Sync now
                  </Button>
                  <Button size="sm" variant="ghost" aria-label={`Browse entries of ${r.name}`} aria-pressed={browsing === r.id} onClick={() => setBrowsing(browsing === r.id ? null : r.id)}>
                    Entries
                  </Button>
                </span>
              ),
            },
          ]}
        />
        {sync.error && (
          <p className={v.errLine} role="alert">
            {sync.error}
          </p>
        )}
        {lastSync && (
          <div aria-live="polite" data-testid="registry-sync-result" className={v.stackTight}>
            <p>
              <Badge tone={SYNC_OUTCOME_TONE[lastSync.outcome]}>{lastSync.outcome}</Badge> <strong>{lastSync.registryName}</strong>: {syncSummary(lastSync)}
            </p>
          </div>
        )}
      </Card>
      {browsed && <RegistryEntriesCard key={browsed.id} registry={browsed} />}
      {editing && <EditRegistryDialog registry={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function CreateRegistryForm() {
  const act = useAction();
  const [draft, setDraft] = useState<RegistryDraft>(EMPTY_REGISTRY_DRAFT);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<CreateRegistryBody | null>(null);
  const enabledHelp = useId();
  const save = (body: unknown) =>
    void act
      // enabling it or allowing private ranges is a relaxation the gateway confirms with a step-up (settings_relax)
      .run(() => registryCall(() => withStepUp((h) => stepUpApi.post("/v1/mcp-registries", body, h))), "Registry added. Nothing was imported.")
      .then((ok) => {
        if (ok) setDraft(EMPTY_REGISTRY_DRAFT);
      });
  return (
    <form
      className={a.formRow}
      style={{ marginBottom: "var(--s2)" }}
      aria-label="Add a registry"
      onSubmit={(e) => {
        e.preventDefault();
        const out = createRegistryBody(draft);
        if ("error" in out) return setProblem(out.error);
        setProblem(null);
        // enabling at creation is a relaxation of the strict default: say so before sending
        if (out.body.enabled || out.body.allowPrivateRanges === true) setConfirming(out.body);
        else save(out.body);
      }}
    >
      <Field label="Registry name">
        <Input value={draft.name} maxLength={200} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. internal-mirror" />
      </Field>
      <Field label="Registry base URL" grow>
        <Input value={draft.url} maxLength={2000} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="https://registry.example.com" />
      </Field>
      <Field label="Scheduled pulls">
        <Select aria-describedby={enabledHelp} value={draft.enabled ? "on" : "off"} onChange={(e) => setDraft({ ...draft, enabled: e.target.value === "on" })}>
          <option value="off">Disabled (default)</option>
          <option value="on">Enabled</option>
        </Select>
      </Field>
      <Field label="Private ranges (ADR-0043)">
        <Select value={draft.privateRanges} onChange={(e) => setDraft({ ...draft, privateRanges: e.target.value as PrivateRanges })}>
          <PrivateRangeOptions />
        </Select>
      </Field>
      <Button type="submit" variant="primary" disabled={act.busy}>
        Add registry
      </Button>
      <span id={enabledHelp} className={v.hint}>
        Disabled is the strict default: the registry is recorded but never pulled until enabled. Adding one is audited and imports nothing.
      </span>
      {(problem ?? act.error) && (
        <span className={v.errLine} role="alert">
          {problem ?? act.error}
        </span>
      )}
      <ConfirmModal
        open={confirming !== null}
        title="Add this registry with a relaxed setting?"
        confirmLabel="Add registry"
        body={
          <ul>
            {draft.enabled && <li>It starts enabled, so the scheduled sweep pulls it into the catalogue. The strict default is disabled.</li>}
            {draft.privateRanges === "allow" && <li>Its URL may resolve into private network space. The strict default inherits the org setting.</li>}
            <li>Pulling it creates no server, tool or grant. The change is audited.</li>
          </ul>
        }
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          const c = confirming;
          setConfirming(null);
          if (c) save(c);
        }}
      />
    </form>
  );
}

function EditRegistryDialog(props: { registry: McpRegistry; onClose: () => void }) {
  const r = props.registry;
  const act = useAction();
  const formId = useId();
  const [url, setUrl] = useState(r.url);
  const [enabled, setEnabled] = useState(r.enabled);
  const [privateRanges, setPrivateRanges] = useState<PrivateRanges>(privateRangesOf(r.allowPrivateRanges));
  const [problem, setProblem] = useState<string | null>(null);
  const [relaxes, setRelaxes] = useState<string[] | null>(null);
  const computed = updateRegistryBody(r, { url, enabled, privateRanges });
  const send = () => {
    if ("error" in computed) return;
    void act
      // a relaxing edit (enable, open private ranges) is confirmed here AND stepped up at the gateway
      .run(() => registryCall(() => withStepUp((h) => stepUpApi.patch(`/v1/mcp-registries/${r.id}`, computed.body, h))), `Registry ${r.name} updated`)
      .then((ok) => {
        if (ok) props.onClose();
      });
  };
  return (
    <Modal
      open
      title={`Edit registry ${r.name}`}
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button type="submit" form={formId} variant="primary" disabled={act.busy}>
            {relaxes ? "Save the relaxed setting" : "Save"}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className={v.stack}
        onSubmit={(e) => {
          e.preventDefault();
          if ("error" in computed) return setProblem(computed.error);
          setProblem(null);
          // a relaxation is confirmed in place before it is sent
          if (computed.relaxes.length > 0 && relaxes === null) return setRelaxes(computed.relaxes);
          send();
        }}
      >
        <p className={v.dim}>The name cannot be changed. A changed URL or private-range posture is checked by the egress guard before it is saved.</p>
        <Field label="Registry base URL">
          <Input value={url} maxLength={2000} onChange={(e) => (setUrl(e.target.value), setRelaxes(null))} />
        </Field>
        <Field label="Scheduled pulls">
          <Select value={enabled ? "on" : "off"} onChange={(e) => (setEnabled(e.target.value === "on"), setRelaxes(null))}>
            <option value="off">Disabled (strict default)</option>
            <option value="on">Enabled</option>
          </Select>
        </Field>
        <Field label="Private ranges (ADR-0043)">
          <Select value={privateRanges} onChange={(e) => (setPrivateRanges(e.target.value as PrivateRanges), setRelaxes(null))}>
            <PrivateRangeOptions />
          </Select>
        </Field>
        {relaxes && (
          <div role="alert">
            <p>
              <strong>This relaxes the registry&apos;s posture:</strong>
            </p>
            <ul>
              {relaxes.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
            <p>The change is audited. Save again to confirm.</p>
          </div>
        )}
        {(problem ?? act.error) && <p role="alert" className={v.errLine}>{problem ?? act.error}</p>}
      </form>
    </Modal>
  );
}

function RegistryEntriesCard(props: { registry: McpRegistry }) {
  const q = useQuery({
    queryKey: mcpRegistryKeys.entries(props.registry.id),
    queryFn: () => registryCall(() => api.get<McpRegistryEntries>(`/v1/mcp-registries/${props.registry.id}/entries`)),
  });
  const act = useAction();
  const [importing, setImporting] = useState<McpRegistryEntry | null>(null);
  const [imported, setImported] = useState<RegistryImportResult | null>(null);
  return (
    <Card title={`Catalogue: ${props.registry.name}`}>
      <p className={v.faint} style={{ marginTop: 0 }}>
        What this registry says exists. A row here is not a server. Importing one creates a single MCP server, unscanned, with no tools and no
        grants: nobody can call it until an admin grants it, and its first connect is scanned for admission.
      </p>
      <Table<McpRegistryEntry>
        rows={q.data?.entries ?? []}
        rowKey={(e) => e.id}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        empty={<EmptyState title="The catalogue is empty" body="Sync the registry to pull its listing. A disabled registry can still be synced by hand." />}
        columns={[
          {
            key: "name",
            header: "Entry",
            render: (e) => (
              <span>
                <span className={v.mono}>{e.upstreamName}</span> <span className={v.faint}>v{e.upstreamVersion}</span>
                {e.title && <div>{e.title}</div>}
              </span>
            ),
          },
          {
            key: "kind",
            header: "Kind",
            render: (e) => (e.kind === "remote" ? <Badge tone="info">remote · {e.remoteTransport ?? "transport not reported"}</Badge> : <Badge tone="neutral">catalogue only</Badge>),
          },
          { key: "endpoint", header: "Endpoint", render: (e) => (e.remoteUrl ? <span className={v.mono}>{e.remoteUrl}</span> : <span className={v.faint}>none listed</span>) },
          {
            key: "state",
            header: "State",
            render: (e) => (
              <span className={v.stackTight}>
                {e.upstreamStatus && e.upstreamStatus !== "active" && <Badge tone="warn">{e.upstreamStatus}</Badge>}
                {e.missingSince && <Badge tone="warn">no longer listed</Badge>}
                {e.conflictReason && <Badge tone="danger">{e.conflictReason === "name_taken" ? "name taken" : "URL taken"}</Badge>}
                {e.remoteUrlDrift && (
                  <span title="The upstream endpoint moved after import. The local server URL is not rewritten.">
                    <Badge tone="warn">endpoint moved</Badge>
                  </span>
                )}
                {e.serverId && (
                  <span>
                    <Badge tone="ok">imported</Badge> <IdChip id={e.serverId} />
                  </span>
                )}
              </span>
            ),
          },
          {
            key: "import",
            header: "Import",
            align: "right",
            render: (e) => {
              const can = entryImportability(e);
              return can.importable ? (
                <ImportAllowed entry={e} warning={can.warning} busy={act.busy} onImport={() => setImporting(e)} />
              ) : (
                <ImportBlocked entry={e} reason={can.reason} />
              );
            },
          },
        ]}
      />
      {act.error && (
        <p className={v.errLine} role="alert">
          {act.error}
        </p>
      )}
      {imported && (
        <p aria-live="polite" data-testid="registry-import-result">
          Imported <strong>{imported.name}</strong> as an MCP server in admission state <code>{imported.admissionState}</code>, with{" "}
          {imported.toolsCreated} tools and {imported.grantsCreated} grants. Grant it on the Servers tab before anyone can use it.
        </p>
      )}
      <ConfirmModal
        open={importing !== null}
        title={`Import ${importing?.upstreamName ?? "this entry"}?`}
        confirmLabel="Import as an MCP server"
        body={
          <div className={v.stack}>
            <p>
              Creates one MCP server pointing at <code>{importing?.remoteUrl}</code>, marked as federated from {props.registry.name}. It starts
              unscanned, with no tools and no grants, so it is usable by nobody.
            </p>
            <p>Its first connect is scanned for admission and can be held. Later changes to the registry never rewrite this server&apos;s URL. The import is audited.</p>
          </div>
        }
        onCancel={() => setImporting(null)}
        onConfirm={() => {
          const e = importing;
          setImporting(null);
          if (!e) return;
          void act.run(async () => {
            // an import from a registry that allows private ranges is a relaxation the gateway steps up (settings_relax)
            const out = await registryCall(() => withStepUp((h) => stepUpApi.post<RegistryImportResult>(`/v1/mcp-registries/entries/${e.id}/import`, {}, h)), "import");
            setImported(out);
            await q.refetch();
          }, `Imported ${e.upstreamName}. Nobody can use it until granted.`);
        }}
      />
    </Card>
  );
}

/** importable; a stale-catalogue warning is shown beside it, and the gateway decides at import */
function ImportAllowed(props: { entry: McpRegistryEntry; warning: string | null; busy: boolean; onImport: () => void }) {
  const id = useId();
  return (
    <span className={v.row}>
      <Button size="sm" disabled={props.busy} aria-label={`Import ${props.entry.upstreamName}`} aria-describedby={props.warning ? id : undefined} onClick={props.onImport}>
        Import
      </Button>
      {props.warning && (
        <span id={id} className={v.faint}>
          {props.warning}
        </span>
      )}
    </span>
  );
}

function ImportBlocked(props: { entry: McpRegistryEntry; reason: string }) {
  const id = useId();
  return (
    <span className={v.row}>
      <Button size="sm" disabled aria-label={`Import ${props.entry.upstreamName}`} aria-describedby={id}>
        Import
      </Button>
      <span id={id} className={v.faint}>
        {props.reason}
      </span>
    </span>
  );
}
