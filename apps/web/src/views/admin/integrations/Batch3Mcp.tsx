import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { putOrgSettings } from "../../../stepup/stepUp";
import type { McpServer, OrgSettingsResponse } from "../../../api/adminTypes";
import { Button, Card, ConfirmModal, Field, InfoButton, Input, Select } from "../../../ui/kit";
import { adminKeys, optionEls, QueryGate, readCurrentOrgSettings, reconfirmNeeded, serverOpts, StaleAfterWrite, useAction, useSettleAfterWrite, useSingleFlight, useUserPicker, userOpts } from "../adminKit";
import { PeopleLoadError, UserListTruncated } from "./IntegrationOwnership";
import v from "../../views.module.css";

// Browser-only mirrors of shared/batch3.ts; batch3 contract tests pin these.
export const MCP_PROTOCOL_METHODS = ["resources/list", "resources/templates/list", "resources/read", "prompts/list", "prompts/get", "completion/complete", "logging/setLevel"] as const;
export const MCP_PROTOCOL_GRANT_NAMES = ["mcp:resources", "mcp:prompts", "mcp:completion", "mcp:logging"] as const;
export const MCP_UPSTREAM_TRANSPORTS = ["streamable_http", "sse", "stdio"] as const;

export function McpCoverage({ servers }: { servers: McpServer[] }) {
  const settings = useQuery({ queryKey: ["admin", "org-settings"], queryFn: () => api.get<OrgSettingsResponse>("/v1/org/settings") });
  return <>
    <Card title="MCP protocol coverage" info={<p>Tool calls use their existing tool grants. Other protocol methods need both organisation enablement and a separate per-user protocol grant. A read-only server grant includes no protocol methods.</p>}>
      <QueryGate loading={settings.isLoading} error={settings.error} onRetry={() => void settings.refetch()}>
        {settings.data?.settings ? <CoverageSettings key={JSON.stringify(settings.data.settings)} settings={settings.data.settings} />
          : !settings.isLoading && !settings.error && <p role="alert">This gateway has not reported MCP protocol coverage. Refresh before changing it.</p>}
      </QueryGate>
      <p>Subscriptions, sampling, elicitation and roots remain unsupported and are always refused.</p>
    </Card>
    <ProtocolGrantForm servers={servers} />
    <StdioUpdate servers={servers} />
  </>;
}

type CoverageBody = Partial<{ mcpProtocolMethods: string[]; mcpUpstreamTransports: string[] }>;
const COVERAGE_KEYS = ["mcpProtocolMethods", "mcpUpstreamTransports"] as const;
export type CoverageChange =
  | { kind: "unchanged" }
  | { kind: "error"; error: string }
  | { kind: "save"; body: CoverageBody; adds: boolean; added: string[] };
/**
 * PUT /v1/org/settings is a partial update and these are whole lists, so a
 * save never sends the form's list as loaded. This admin's delta (added and
 * removed, against `loaded`, the snapshot the form opened with) is applied to
 * `current`, the lists re-read just before saving, and only a list whose
 * merged value differs from what is stored is sent: another admin's
 * concurrent change survives. `adds` is decided on that merged list against
 * `current` (`added` names each newly enabled value as `key:value`). Without a
 * readable `current` nothing is sent (no stale overwrite).
 */
export function coverageChanges(loaded: Record<string, unknown>, methods: string[], transports: string[], current: Record<string, unknown> | null): CoverageChange {
  const list = (source: Record<string, unknown> | null, key: string) => (source && Array.isArray(source[key]) ? (source[key] as string[]) : null);
  const local = { mcpProtocolMethods: methods, mcpUpstreamTransports: transports };
  const body: CoverageBody = {};
  const newlyEnabled: string[] = [];
  for (const key of COVERAGE_KEYS) {
    const before = list(loaded, key) ?? [];
    const added = local[key].filter((value) => !before.includes(value));
    const removed = before.filter((value) => !local[key].includes(value));
    if (added.length === 0 && removed.length === 0) continue;
    const now = list(current, key);
    if (now === null) return { kind: "error", error: "Could not load the current MCP coverage, so nothing was saved. Retry." };
    const merged = [...new Set([...now.filter((value) => !removed.includes(value)), ...added])];
    if (merged.length === now.length && merged.every((value) => now.includes(value))) continue;
    body[key] = merged;
    newlyEnabled.push(...merged.filter((value) => !now.includes(value)).map((value) => `${key}:${value}`));
  }
  return Object.keys(body).length === 0 ? { kind: "unchanged" } : { kind: "save", body, adds: newlyEnabled.length > 0, added: newlyEnabled };
}

function CoverageSettings({ settings }: { settings: Record<string, unknown> }) {
  const act = useAction();
  const flight = useSingleFlight();
  // after a save the form stays locked until the settings query has the server's values
  const baseline = useSettleAfterWrite(["admin", "org-settings"]);
  const [methods, setMethods] = useState<string[]>(Array.isArray(settings.mcpProtocolMethods) ? settings.mcpProtocolMethods : []);
  const [transports, setTransports] = useState<string[]>(Array.isArray(settings.mcpUpstreamTransports) ? settings.mcpUpstreamTransports : []);
  // the dialog keeps this admin's INTENT (the form's lists, read against the
  // load-time snapshot), not the merged lists: confirming re-reads and re-merges
  const [pending, setPending] = useState<{ methods: string[]; transports: string[]; shown: Extract<CoverageChange, { kind: "save" }>; changedWhileOpen: boolean } | null>(null);
  const unavailable = !Array.isArray(settings.mcpProtocolMethods) || !Array.isArray(settings.mcpUpstreamTransports);
  // ADR-0186 A (B4S-04): enabling a method or transport is a relaxation the gateway refuses with step_up_required;
  // the step-up dialog opens inside the held flight, and a cancelled step-up writes nothing and frees the form
  const save = async (body: CoverageBody) => {
    if (await act.run(() => putOrgSettings(body), "MCP coverage saved")) await baseline.settle();
  };
  const toggle = (values: string[], value: string, checked: boolean) => checked ? [...values, value] : values.filter((item) => item !== value);
  const submit = async () => {
    // busy BEFORE the re-read: a second submit meanwhile is ignored
    if (baseline.stale || !flight.enter()) return;
    let confirming = false;
    try {
      if (coverageChanges(settings, methods, transports, settings).kind === "unchanged") { act.setError("No MCP coverage setting changed."); return; }
      // merge into, and classify against, the lists stored now
      const change = coverageChanges(settings, methods, transports, await readCurrentOrgSettings());
      if (change.kind === "error") { act.setError(change.error); return; }
      if (change.kind === "unchanged") { act.setError("The stored MCP coverage already matches your change; nothing was saved."); return; }
      if (change.adds) { confirming = true; setPending({ methods, transports, shown: change, changedWhileOpen: false }); return; }
      await save(change.body);
    } finally {
      // a confirmation keeps the flight until it is cancelled or saved
      if (!confirming) flight.leave();
    }
  };
  const confirm = async () => {
    const intent = pending;
    setPending(null);
    let confirming = false;
    try {
      if (!intent) return;
      // the dialog may have been open for minutes: merge into what is stored NOW
      const change = coverageChanges(settings, intent.methods, intent.transports, await readCurrentOrgSettings());
      if (change.kind === "error") { act.setError(change.error); return; }
      if (change.kind === "unchanged") { act.setError("The stored MCP coverage already matches your change; nothing was saved."); return; }
      if (reconfirmNeeded(intent.shown.added, change)) { confirming = true; setPending({ ...intent, shown: change, changedWhileOpen: true }); return; }
      await save(change.body);
    } finally {
      if (!confirming) flight.leave();
    }
  };
  const busy = act.busy || flight.busy || baseline.stale;
  return <form className={v.stack} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    {unavailable && <p role="alert">This gateway has not reported MCP protocol coverage. Refresh before changing it.</p>}
    {/* the (i) sits in the legend, which a disabled fieldset never disables */}
    <fieldset disabled={busy || unavailable}><legend>Enabled protocol methods <InfoButton label="enabled protocol methods">The strict default refuses all these methods. Enabling one relaxes that boundary and is audited; a matching user grant is still required.</InfoButton></legend>
      <p className={v.faint}>Also needs a per-user grant.</p>
      {MCP_PROTOCOL_METHODS.map((method) => <label key={method} className={v.row}><input type="checkbox" checked={methods.includes(method)} onChange={(event) => setMethods(toggle(methods, method, event.target.checked))} />{method} · {method.startsWith("logging/") ? "write" : "read"}</label>)}
    </fieldset>
    <fieldset disabled={busy || unavailable}><legend>Enabled upstream transports <InfoButton label="enabled upstream transports">Only streamable HTTP is enabled by default. Enabling SSE or stdio is an audited relaxation. A stdio server never runs on the gateway: it runs from an image pinned by digest, inside a sandbox started by an executor that proves the required isolation, and it still needs admission approval.</InfoButton></legend>
      <p className={v.faint}>stdio also needs admission approval.</p>
      {MCP_UPSTREAM_TRANSPORTS.map((transport) => <label key={transport} className={v.row}><input type="checkbox" checked={transports.includes(transport)} onChange={(event) => setTransports(toggle(transports, transport, event.target.checked))} />{transport}</label>)}
    </fieldset>
    <Button type="submit" disabled={busy || unavailable}>Save MCP coverage</Button>
    {act.error && <p role="alert">{act.error}</p>}
    {baseline.stale && <StaleAfterWrite onRetry={() => void baseline.settle()} />}
    <ConfirmModal open={pending !== null} title="Enable more MCP coverage?" body={<p>{pending?.changedWhileOpen && <>The stored coverage changed while this was open; review the result again. </>}{pending?.shown.body.mcpProtocolMethods && <>Enabled methods: {pending.shown.body.mcpProtocolMethods.join(", ") || "none"}. </>}{pending?.shown.body.mcpUpstreamTransports && <>Transports: {pending.shown.body.mcpUpstreamTransports.join(", ") || "none"}. </>}The gateway audits this relaxation; user grants and admission checks still apply.</p>}
      confirmLabel="Save audited change" onCancel={() => { setPending(null); flight.leave(); }}
      onConfirm={() => void confirm()} />
  </form>;
}

function ProtocolGrantForm({ servers }: { servers: McpServer[] }) {
  const users = useUserPicker(); const act = useAction(); const flight = useSingleFlight();
  const [userId, setUserId] = useState(""); const [serverId, setServerId] = useState(""); const [grant, setGrant] = useState<string>(MCP_PROTOCOL_GRANT_NAMES[0]);
  return <Card title="Per-user protocol grants" info={<p>Granting protocol access relaxes this person's default deny and is audited. The corresponding method must also be enabled above. Read-only server access does not include these grants; logging is a write operation.</p>}><form className={v.stack} onSubmit={(event) => {
    event.preventDefault();
    if (!flight.enter()) return;
    void (async () => {
      try {
        // a create form's baseline is empty: after a grant is added the choices
        // are cleared, so a second click cannot mint the same grant again
        if (await act.run(() => api.post("/v1/grants/tools", { userId, serverId, toolName: grant }), "Protocol grant added")) {
          setUserId(""); setServerId(""); setGrant(MCP_PROTOCOL_GRANT_NAMES[0]);
        }
      } finally {
        flight.leave();
      }
    })();
  }}>
    <Field label="Protocol user"><Select required value={userId} onChange={(event) => setUserId(event.target.value)}>{optionEls(userOpts(users.data?.users.filter((user) => !user.disabledAt)), "— select —")}</Select></Field>
    {users.data && !users.data.complete && <UserListTruncated count={users.data.users.length} />}
    {users.error && <PeopleLoadError onRetry={() => void users.refetch()} />}
    <Field label="Protocol server"><Select required value={serverId} onChange={(event) => setServerId(event.target.value)}>{optionEls(serverOpts(servers), "— select —")}</Select></Field>
    <Field label="Protocol grant"><Select value={grant} onChange={(event) => setGrant(event.target.value)}>{MCP_PROTOCOL_GRANT_NAMES.map((name) => <option key={name} value={name}>{name}</option>)}</Select></Field>
    <p className={v.faint}>Also needs the method enabled above.</p>
    <Button type="submit" disabled={act.busy || flight.busy || users.isLoading || !!users.error}>Add protocol grant</Button>
    {act.error && <p role="alert">{act.error}</p>}
  </form></Card>;
}

export function StdioArguments({ args, onChange, disabled }: { args: string[]; onChange: (args: string[]) => void; disabled?: boolean }) {
  const warningId = useId();
  return <fieldset disabled={disabled} aria-describedby={warningId}><legend>Command arguments</legend>
    <p id={warningId}>Arguments are audited and visible to admins. Never put passwords, API keys or other secrets in them.</p>
    <p>Each argument is one separate string. Spaces stay inside that argument; no shell command line is evaluated.</p>
    {args.map((value, index) => <div key={index} className={v.row}>
      <Field label={`Argument ${index + 1}`}><Input aria-describedby={warningId} value={value} onChange={(event) => onChange(args.map((item, position) => position === index ? event.target.value : item))} /></Field>
      <Button type="button" aria-label={`Remove argument ${index + 1}`} onClick={() => onChange(args.filter((_, position) => position !== index))}>Remove</Button>
    </div>)}
    <Button type="button" onClick={() => onChange([...args, ""])}>Add argument</Button>
  </fieldset>;
}

function StdioUpdate({ servers }: { servers: McpServer[] }) {
  const [id, setId] = useState(""); const server = servers.find((row) => row.id === id);
  const stdio = servers.filter((row) => row.transport === "stdio");
  if (!stdio.length) return null;
  return <Card title="Update a stdio command">
    <p>A server's transport is fixed at registration. A change of image, command or arguments is audited and resets admission to unscanned; scan and approve it again before use.</p>
    <Field label="Stdio server to update"><Select value={id} onChange={(event) => setId(event.target.value)}>{optionEls(serverOpts(stdio), "— select —")}</Select></Field>
    {server?.stdio && <StdioUpdateForm key={`${server.id}:${server.stdioCommandDigest}`} server={server} />}
  </Card>;
}
/** True when the form differs from the stored image, command or argv (ADR-0190 I4: the image is the pinned digest). */
export function stdioSpecDirty(server: McpServer, image: string, command: string, args: string[]): boolean {
  const stored = server.stdio;
  return !stored || image !== (stored.image ?? server.stdioCommandDigest ?? "") || command !== stored.command || args.length !== stored.args.length || args.some((arg, index) => arg !== stored.args[index]);
}
/**
 * The sentence after a PATCH, from what the gateway RETURNED: an identical
 * image, command and argv is a no-op there (no audit, admission kept), so it
 * must not be reported as "admission scan required".
 */
export function stdioUpdateOutcome(before: McpServer, after: McpServer): string {
  const state = after.admissionState ?? "not reported";
  const changed = after.stdioCommandDigest !== before.stdioCommandDigest || (after.stdio ? stdioSpecDirty(before, after.stdio.image ?? after.stdioCommandDigest ?? "", after.stdio.command, after.stdio.args) : false);
  return changed
    ? `Server updated; admission is now ${state}: scan and approve it again before use.`
    : `Nothing changed: the image, command and arguments are the same, so admission stays ${state}.`;
}
function StdioUpdateForm({ server }: { server: McpServer }) {
  const act = useAction(); const [image, setImage] = useState(server.stdio!.image ?? server.stdioCommandDigest ?? ""); const [command, setCommand] = useState(server.stdio!.command); const [args, setArgs] = useState(server.stdio!.args);
  const flight = useSingleFlight();
  // after a save the form stays locked until the servers query has the server's command and digest
  const baseline = useSettleAfterWrite(adminKeys.servers);
  const dirty = stdioSpecDirty(server, image, command, args);
  const busy = act.busy || flight.busy || baseline.stale;
  return <form className={v.stack} onSubmit={(event) => {
    event.preventDefault();
    if (baseline.stale || !flight.enter()) return;
    void (async () => {
      try {
        if (await act.run(async () => stdioUpdateOutcome(server, await api.patch<McpServer>(`/v1/servers/${server.id}`, { stdio: { image, command, args } })))) await baseline.settle();
      } finally {
        flight.leave();
      }
    })();
  }}>
    <Field label="Updated closure image digest"><Input required pattern="sha256:[0-9a-f]{64}" value={image} onChange={(event) => setImage(event.target.value)} disabled={busy} /></Field>
    <Field label="Updated entry point in the image"><Input required pattern="/.*" value={command} onChange={(event) => setCommand(event.target.value)} disabled={busy} /></Field>
    <StdioArguments args={args} onChange={setArgs} disabled={busy} />
    {!dirty && <p>The image, entry point and arguments match what is stored. Submitting changes nothing.</p>}
    <Button type="submit" disabled={busy || !dirty}>Update server and reset admission</Button>
    {act.error && <p role="alert">{act.error}</p>}
    {baseline.stale && <StaleAfterWrite onRetry={() => void baseline.settle()} />}
  </form>;
}
