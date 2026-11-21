/**
 * The MCP servers named in MCP host configs on enrolled employee machines, read-only through the endpoint agent,
 * with each one's registry state: linked by an admin, registered (its host is a registry server's host) or
 * unregistered. An admin may link an unregistered identity to an approved server, or remove that link; both are
 * audited. The list is keyset-paginated ("Load more"), with a bounded page size.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type { McpServer } from "../../../api/adminTypes";
import { fmtDateTime, humanize, providerLabel } from "../../../api/format";
import { Badge, Button, Card, ConfirmModal, EmptyState, Field, IdChip, RowActions, Select, SkeletonBlock, Table } from "../../../ui/kit";
import { adminKeys, useAction } from "../adminKit";
import v from "../../views.module.css";
import {
  endpointMcpUrl,
  isLinkable,
  launches,
  linkIdentity,
  linkScope,
  NO_FILTERS,
  REGISTRY_TONE,
  type EndpointMcpFilters,
  type EndpointMcpServerView,
  type EndpointMcpServersPage,
} from "./endpointMcpModel";

export function EndpointMcpServersCard() {
  const act = useAction();
  const [f, setF] = useState<EndpointMcpFilters>(NO_FILTERS);
  const [linking, setLinking] = useState<EndpointMcpServerView | null>(null);
  const [unlinking, setUnlinking] = useState<EndpointMcpServerView | null>(null);
  // never pre-selected: the admin names the approved server
  const [target, setTarget] = useState("");
  const list = useInfiniteQuery({
    queryKey: ["admin", "discovery", "endpoint-mcp-servers", f],
    queryFn: ({ pageParam }) => api.get<EndpointMcpServersPage>(endpointMcpUrl(f, pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  // the registry, read only once a link is being chosen; only admitted (scanned clean or cleared) servers are offered
  const servers = useQuery({ queryKey: adminKeys.servers, queryFn: () => api.get<{ servers: McpServer[] }>("/v1/servers"), enabled: !!linking });
  const approved = (servers.data?.servers ?? []).filter(isLinkable);
  const first = list.data?.pages[0];
  const rows = list.data?.pages.flatMap((p) => p.items ?? []);
  const filtered = f.status !== "" || f.risky || f.secrets || !!f.deviceId;

  const link = () => {
    const id = linking && linkIdentity(linking);
    if (!id) return;
    if (!target) return act.setError("Choose the approved server to link it to.");
    void act.run(async () => {
      const out = await api.post<{ mcpServerName: string }>("/v1/discovery/endpoint-mcp-server-links", { ...id, mcpServerId: target });
      setLinking(null);
      return `Linked to ${out.mcpServerName}`;
    });
  };
  const unlink = () => {
    const id = unlinking && linkIdentity(unlinking);
    if (!id) return;
    setUnlinking(null);
    void act.run(() => api.post("/v1/discovery/endpoint-mcp-server-links/remove", id), "Link removed");
  };
  const scope = (r: EndpointMcpServerView | null) => {
    const id = r && linkIdentity(r);
    return id ? <p role="note">{id.identityKind === "command" ? <Badge tone="warn">Wide link</Badge> : null} {linkScope(id.identityKind, id.identity)}</p> : null;
  };

  return (
    <Card title="MCP servers on employee machines" actions={<Badge tone="info">Links audited</Badge>} contain>
      <div className={v.stack} data-testid="endpoint-mcp-card">
        {first ? <p data-testid="endpoint-mcp-posture">{first.posture}</p> : list.isPending ? <SkeletonBlock lines={1} /> : null}
        <div className={v.row}>
          <Field label="Registry state">
            <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as EndpointMcpFilters["status"] })}>
              <option value="">All</option>
              <option value="unregistered">Unregistered</option>
              <option value="registered">Registered</option>
              <option value="linked">Linked</option>
            </Select>
          </Field>
          <label className={v.row}><input type="checkbox" checked={f.risky} onChange={(e) => setF({ ...f, risky: e.target.checked })} /> With risk flags</label>
          <label className={v.row}><input type="checkbox" checked={f.secrets} onChange={(e) => setF({ ...f, secrets: e.target.checked })} /> With secrets</label>
          {f.deviceId && <Button size="sm" onClick={() => setF({ ...f, deviceId: null })}>Show every device</Button>}
        </div>
        <Table<EndpointMcpServerView>
          rows={rows}
          rowKey={(r) => r.id}
          loading={list.isPending}
          error={list.error}
          onRetry={() => void list.refetch()}
          empty={
            filtered ? (
              <EmptyState title="No server matches these filters" />
            ) : first && !first.enabled ? (
              <EmptyState title="MCP config discovery is off" body="Turn it on under Settings at the foot of this page." />
            ) : (
              <EmptyState title="No MCP server reported yet" body="Servers appear here once an enrolled device reports its MCP host configs." />
            )
          }
          columns={[
            {
              key: "server",
              header: "Server",
              render: (r) => (
                <>
                  <strong>{r.serverName}</strong> {r.disabled && <Badge>Disabled</Badge>}
                  <div className={v.faint}>{humanize(r.transport)}</div>
                  <div className={v.mono}>{launches(r)}</div>
                </>
              ),
            },
            {
              key: "device",
              header: "Device",
              render: (r) => (
                <>
                  <span className={v.mono}>{r.devicePseudonym}</span>
                  <div className={v.faint}>{providerLabel(r.hostApp.provider)} · seen {fmtDateTime(r.lastSeenAt)}</div>
                  {!f.deviceId && (
                    <Button size="sm" aria-label={`Only this device, ${r.devicePseudonym}`} onClick={() => setF({ ...f, deviceId: r.deviceId })}>Only this device</Button>
                  )}
                </>
              ),
            },
            {
              key: "risk",
              header: "Risk",
              render: (r) =>
                r.risks.length + r.riskyTools.length + r.secretTypes.length === 0 ? (
                  <span className={v.faint}>none</span>
                ) : (
                  <div className={v.stackTight}>
                    {r.risks.length > 0 && <span>{r.risks.map((k) => <Badge key={k} tone="warn">{humanize(k)}</Badge>)}</span>}
                    {r.riskyTools.length > 0 && <span>Risky tools: <span className={v.mono}>{r.riskyTools.join(", ")}</span></span>}
                    {r.secretTypes.length > 0 && <span>Secrets: <span className={v.mono}>{r.secretTypes.join(", ")}</span></span>}
                  </div>
                ),
            },
            {
              key: "registry",
              header: "Registry",
              render: (r) => (
                <>
                  <Badge tone={REGISTRY_TONE[r.registry.status]} info={r.verdict} infoLabel={`${r.serverName}: registry verdict`}>{humanize(r.registry.status)}</Badge>
                  {r.registry.mcpServerName && <div className={v.faint}>{r.registry.mcpServerName}</div>}
                  {r.findingId && (
                    <div>
                      <Link to="/admin/shadow-ai?tab=findings" aria-label={`Finding, for ${r.serverName} on ${r.devicePseudonym}`}>Finding</Link> <IdChip id={r.findingId} />
                    </div>
                  )}
                </>
              ),
            },
            {
              key: "actions",
              header: "",
              srHeader: "Actions",
              render: (r) =>
                !linkIdentity(r) ? null : (
                  <RowActions
                    slot="7rem"
                    primary={
                      r.registry.status === "unregistered" ? (
                        <Button size="sm" disabled={act.busy} aria-label={`Link to an approved server, ${r.serverName}`} onClick={() => { setTarget(""); act.setError(null); setLinking(r); }}>
                          Link to an approved server
                        </Button>
                      ) : null
                    }
                    secondary={
                      r.registry.status === "linked" ? (
                        <Button size="sm" disabled={act.busy} aria-label={`Unlink, ${r.serverName}`} onClick={() => setUnlinking(r)}>Unlink</Button>
                      ) : null
                    }
                  />
                ),
            },
          ]}
        />
        {list.hasNextPage && (
          <div>
            <Button disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>{list.isFetchingNextPage ? "Loading…" : "Load more"}</Button>
          </div>
        )}
        {act.error && !linking && <div className={v.errLine} role="alert">{act.error}</div>}
      </div>
      <ConfirmModal
        open={!!linking}
        title={`Link ${linking?.serverName ?? ""} to an approved server`}
        confirmLabel="Link"
        onCancel={() => setLinking(null)}
        onConfirm={link}
        body={
          <div className={v.stack}>
            {scope(linking)}
            <Field label="Approved server" error={act.error}>
              <Select value={target} disabled={servers.isPending} onChange={(e) => setTarget(e.target.value)}>
                <option value="">{servers.isPending ? "Loading…" : servers.error ? "Could not read the registry" : "Choose a server"}</option>
                {approved.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
            <p className={v.faint}>The link is audited.</p>
          </div>
        }
      />
      <ConfirmModal
        open={!!unlinking}
        danger
        title={`Unlink ${unlinking?.serverName ?? ""}?`}
        confirmLabel="Unlink"
        onCancel={() => setUnlinking(null)}
        onConfirm={unlink}
        body={<>{scope(unlinking)}<p className={v.faint}>It shows as unregistered again. The unlink is audited.</p></>}
      />
    </Card>
  );
}
