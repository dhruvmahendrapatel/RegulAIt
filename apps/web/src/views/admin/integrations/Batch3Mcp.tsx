import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type { McpServer, OrgSettingsResponse } from "../../../api/adminTypes";
import { Button, Card, ConfirmModal, Field, Input, Select } from "../../../ui/kit";
import { optionEls, QueryGate, serverOpts, useAction, useUserPicker, userOpts } from "../adminKit";
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
 * the other. `adds` is true when a sent list enables something new.
 */
export function coverageChanges(settings: Record<string, unknown>, methods: string[], transports: string[]): { body: CoverageBody; adds: boolean } {
  const before = (key: string) => (Array.isArray(settings[key]) ? settings[key] : []) as string[];
  const changed = (key: string, next: string[]) => next.length !== before(key).length || next.some((value) => !before(key).includes(value));
  const body: CoverageBody = {
    ...(changed("mcpProtocolMethods", methods) ? { mcpProtocolMethods: methods } : {}),
    ...(changed("mcpUpstreamTransports", transports) ? { mcpUpstreamTransports: transports } : {}),
  };
  const adds = (body.mcpProtocolMethods ?? []).some((value) => !before("mcpProtocolMethods").includes(value)) || (body.mcpUpstreamTransports ?? []).some((value) => !before("mcpUpstreamTransports").includes(value));
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
  return <form className={v.stack} onSubmit={(event) => {
    event.preventDefault();
    const change = coverageChanges(settings, methods, transports);
    if (Object.keys(change.body).length === 0) { act.setError("No MCP coverage setting changed."); return; }
    if (change.adds) setPending(change.body); else void save(change.body);
  }}>
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
function StdioUpdateForm({ server }: { server: McpServer }) {
  const act = useAction(); const [command, setCommand] = useState(server.stdio!.command); const [args, setArgs] = useState(server.stdio!.args);
  return <form className={v.stack} onSubmit={(event) => { event.preventDefault(); void act.run(() => api.patch(`/v1/servers/${server.id}`, { stdio: { command, args } }), "Command updated; admission scan required"); }}>
    <Field label="Updated executable path"><Input required pattern="/.*" value={command} onChange={(event) => setCommand(event.target.value)} disabled={act.busy} /></Field>
    <StdioArguments args={args} onChange={setArgs} disabled={act.busy} />
    <Button type="submit" disabled={act.busy}>Update command and reset admission</Button>
    {act.error && <p role="alert">{act.error}</p>}
  </form>;
}
