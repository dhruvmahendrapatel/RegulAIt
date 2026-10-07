import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type { McpServer, OrgSettingsResponse } from "../../../api/adminTypes";
import { Button, Card, ConfirmModal, Field, Input, Select } from "../../../ui/kit";
import { optionEls, QueryGate, readCurrentOrgSettings, serverOpts, useAction, useUserPicker, userOpts } from "../adminKit";
import { UserListTruncated } from "./IntegrationOwnership";
import v from "../../views.module.css";

// Browser-only mirrors of shared/batch3.ts; batch3 contract tests pin these.
export const MCP_PROTOCOL_METHODS = ["resources/list", "resources/templates/list", "resources/read", "prompts/list", "prompts/get", "completion/complete", "logging/setLevel"] as const;
export const MCP_PROTOCOL_GRANT_NAMES = ["mcp:resources", "mcp:prompts", "mcp:completion", "mcp:logging"] as const;
export const MCP_UPSTREAM_TRANSPORTS = ["streamable_http", "sse", "stdio"] as const;

export function McpCoverage({ servers }: { servers: McpServer[] }) {
  const settings = useQuery({ queryKey: ["admin", "org-settings"], queryFn: () => api.get<OrgSettingsResponse>("/v1/org/settings") });
  return <>
    <Card title="MCP protocol coverage">
      <p>Tool calls use their existing tool grants. Other protocol methods need both organisation enablement and a separate per-user protocol grant. A read-only server grant includes no protocol methods.</p>
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
/**
 * PUT /v1/org/settings is a partial update: send only the lists this admin
 * changed, so saving one cannot revert another admin's concurrent change to
 * the other. `adds` is true when a sent list enables something that is not
 * enabled in `current` — the settings re-read just before saving — or when
 * that read failed (null).
 */
export function coverageChanges(settings: Record<string, unknown>, methods: string[], transports: string[], current: Record<string, unknown> | null): { body: CoverageBody; adds: boolean } {
  const before = (key: string) => (Array.isArray(settings[key]) ? settings[key] : []) as string[];
  const changed = (key: string, next: string[]) => next.length !== before(key).length || next.some((value) => !before(key).includes(value));
  const body: CoverageBody = {
    ...(changed("mcpProtocolMethods", methods) ? { mcpProtocolMethods: methods } : {}),
    ...(changed("mcpUpstreamTransports", transports) ? { mcpUpstreamTransports: transports } : {}),
  };
  // what is enabled NOW (null = unknown: anything sent may enable something)
  const stored = (key: string) => (current && Array.isArray(current[key]) ? (current[key] as string[]) : null);
  const enables = (key: string, next: string[] | undefined) => (next ?? []).some((value) => !(stored(key)?.includes(value) ?? false));
  const adds = enables("mcpProtocolMethods", body.mcpProtocolMethods) || enables("mcpUpstreamTransports", body.mcpUpstreamTransports);
  return { body, adds };
}

function CoverageSettings({ settings }: { settings: Record<string, unknown> }) {
  const act = useAction();
  const [methods, setMethods] = useState<string[]>(Array.isArray(settings.mcpProtocolMethods) ? settings.mcpProtocolMethods : []);
  const [transports, setTransports] = useState<string[]>(Array.isArray(settings.mcpUpstreamTransports) ? settings.mcpUpstreamTransports : []);
  const [pending, setPending] = useState<CoverageBody | null>(null);
  const unavailable = !Array.isArray(settings.mcpProtocolMethods) || !Array.isArray(settings.mcpUpstreamTransports);
  const save = (body: CoverageBody) => act.run(() => api.put("/v1/org/settings", body), "MCP coverage saved");
  const toggle = (values: string[], value: string, checked: boolean) => checked ? [...values, value] : values.filter((item) => item !== value);
  const submit = async () => {
    if (Object.keys(coverageChanges(settings, methods, transports, settings).body).length === 0) { act.setError("No MCP coverage setting changed."); return; }
    // classify against the lists stored now, not the loaded snapshot
    const change = coverageChanges(settings, methods, transports, await readCurrentOrgSettings());
    if (change.adds) setPending(change.body); else void save(change.body);
  };
  return <form className={v.stack} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    {unavailable && <p role="alert">This gateway has not reported MCP protocol coverage. Refresh before changing it.</p>}
    <fieldset disabled={act.busy || unavailable}><legend>Enabled protocol methods</legend>
      {MCP_PROTOCOL_METHODS.map((method) => <label key={method} className={v.row}><input type="checkbox" checked={methods.includes(method)} onChange={(event) => setMethods(toggle(methods, method, event.target.checked))} />{method} · {method.startsWith("logging/") ? "write" : "read"}</label>)}
    </fieldset>
    <p>The strict default refuses all these methods. Enabling one relaxes that boundary and is audited; a matching user grant is still required.</p>
    <fieldset disabled={act.busy || unavailable}><legend>Enabled upstream transports</legend>
      {MCP_UPSTREAM_TRANSPORTS.map((transport) => <label key={transport} className={v.row}><input type="checkbox" checked={transports.includes(transport)} onChange={(event) => setTransports(toggle(transports, transport, event.target.checked))} />{transport}</label>)}
    </fieldset>
    <p>Only streamable HTTP is enabled by default. Enabling SSE or stdio is an audited relaxation. Stdio also requires operator-configured executable directories, a pinned command digest and admission approval.</p>
    <Button type="submit" disabled={act.busy || unavailable}>Save MCP coverage</Button>
    {act.error && <p role="alert">{act.error}</p>}
    <ConfirmModal open={pending !== null} title="Enable more MCP coverage?" body={<p>{pending?.mcpProtocolMethods && <>Enabled methods: {pending.mcpProtocolMethods.join(", ") || "none"}. </>}{pending?.mcpUpstreamTransports && <>Transports: {pending.mcpUpstreamTransports.join(", ") || "none"}. </>}The gateway audits this relaxation; user grants and admission checks still apply.</p>}
      confirmLabel="Save audited change" onCancel={() => setPending(null)} onConfirm={() => { const body = pending; setPending(null); if (body) void save(body); }} />
  </form>;
}

function ProtocolGrantForm({ servers }: { servers: McpServer[] }) {
  const users = useUserPicker(); const act = useAction();
  const [userId, setUserId] = useState(""); const [serverId, setServerId] = useState(""); const [grant, setGrant] = useState<string>(MCP_PROTOCOL_GRANT_NAMES[0]);
  return <Card title="Per-user protocol grants"><form className={v.stack} onSubmit={(event) => {
    event.preventDefault(); void act.run(() => api.post("/v1/grants/tools", { userId, serverId, toolName: grant }), "Protocol grant added");
  }}>
    <Field label="Protocol user"><Select required value={userId} onChange={(event) => setUserId(event.target.value)}>{optionEls(userOpts(users.data?.users.filter((user) => !user.disabledAt)), "— select —")}</Select></Field>
    {users.data && !users.data.complete && <UserListTruncated count={users.data.users.length} />}
    <Field label="Protocol server"><Select required value={serverId} onChange={(event) => setServerId(event.target.value)}>{optionEls(serverOpts(servers), "— select —")}</Select></Field>
    <Field label="Protocol grant"><Select value={grant} onChange={(event) => setGrant(event.target.value)}>{MCP_PROTOCOL_GRANT_NAMES.map((name) => <option key={name} value={name}>{name}</option>)}</Select></Field>
    <p>Granting protocol access relaxes this person's default deny and is audited. The corresponding method must also be enabled above. Read-only server access does not include these grants; logging is a write operation.</p>
    <Button type="submit" disabled={act.busy || users.isLoading || !!users.error}>Add protocol grant</Button>
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
    <p>A server's transport is fixed at registration. A command or argument change is audited, pins a new digest and resets admission to unscanned; scan and approve it again before use.</p>
    <Field label="Stdio server to update"><Select value={id} onChange={(event) => setId(event.target.value)}>{optionEls(serverOpts(stdio), "— select —")}</Select></Field>
    {server?.stdio && <StdioUpdateForm key={`${server.id}:${server.stdioCommandDigest}`} server={server} />}
  </Card>;
}
/** True when the form differs from the stored command or argv. */
export function stdioSpecDirty(server: McpServer, command: string, args: string[]): boolean {
  const stored = server.stdio;
  return !stored || command !== stored.command || args.length !== stored.args.length || args.some((arg, index) => arg !== stored.args[index]);
}
/**
 * The sentence after a PATCH, from what the gateway RETURNED: an identical
 * command, argv and digest is a no-op there (no audit, admission kept), so it
 * must not be reported as "admission scan required". The same command can
 * still re-pin a new digest when the file on disk changed.
 */
export function stdioUpdateOutcome(before: McpServer, after: McpServer): string {
  const state = after.admissionState ?? "not reported";
  const changed = after.stdioCommandDigest !== before.stdioCommandDigest || (after.stdio ? stdioSpecDirty(before, after.stdio.command, after.stdio.args) : false);
  return changed
    ? `Command updated; admission is now ${state}. A new digest was pinned: scan and approve it again before use.`
    : `Nothing changed: the command, arguments and pinned digest are the same, so admission stays ${state}.`;
}
function StdioUpdateForm({ server }: { server: McpServer }) {
  const act = useAction(); const [command, setCommand] = useState(server.stdio!.command); const [args, setArgs] = useState(server.stdio!.args);
  const dirty = stdioSpecDirty(server, command, args);
  return <form className={v.stack} onSubmit={(event) => { event.preventDefault(); void act.run(async () => stdioUpdateOutcome(server, await api.patch<McpServer>(`/v1/servers/${server.id}`, { stdio: { command, args } }))); }}>
    <Field label="Updated executable path"><Input required pattern="/.*" value={command} onChange={(event) => setCommand(event.target.value)} disabled={act.busy} /></Field>
    <StdioArguments args={args} onChange={setArgs} disabled={act.busy} />
    {!dirty && <p>The command and arguments match what is stored. Submitting re-checks the file's digest: admission resets only if the executable on disk has changed.</p>}
    <Button type="submit" disabled={act.busy}>{dirty ? "Update command and reset admission" : "Re-check executable digest"}</Button>
    {act.error && <p role="alert">{act.error}</p>}
  </form>;
}
