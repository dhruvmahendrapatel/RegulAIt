/**
 * Agent inventory (ADR-0082, gap L7) — the standing "agent X uses tools Y,Z
 * and feeds agent W" view, computed as an aggregation over ledgers the
 * platform already writes (grants, usage, traces, orchestration run history).
 * Nothing here is a new collection, and the page's one rule is rendered in
 * its structure: GRANTED (what the entitlement rows allow) and OBSERVED
 * (what the run history recorded) are separate labelled columns and panels,
 * never blended — an unused permission and a used one are different facts,
 * and the difference IS the over-permissioning question.
 *
 * Observed agent→agent feeds render as a plain list with run counts and
 * last-seen (no graph library — the repo's standing rule).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Table, type Tone } from "../../../ui/kit";
import { QueryGate } from "../adminKit";
import v from "../../views.module.css";

interface InventoryAgent {
  id: string;
  name: string;
  provider: string;
  model: string | null;
  tier: number;
  enabled: boolean;
  credential: { source: string; platformCredential: boolean; byoUserCredentials: number };
  modelCard: { cards: number; liveApproved: boolean };
  granted: { directUsers: number; grantingRoles: string[]; revokedUsers: number; effectiveHolders: number };
  observed: { dispatchesInWindow: number; costUsdInWindow: number; lastDispatchAt: string | null; feedsOut: number; feedsIn: number };
  coverage: {
    redteamRunsInWindow: number;
    everProbed: boolean;
    latestAsr: { asr: number | null; asrTrials: number; measurementQuality: string | null } | null;
    evalRunsInWindow: number;
    groundednessRunsInWindow: number;
  };
  links: { useCases: number; risks: number; openRisks: number };
}

interface FeedEdgeView {
  agentId: string;
  agentName: string | null;
  observedRuns: number;
  lastSeenAt: string | null;
}

interface InventoryDetail {
  agent: { id: string; name: string; provider: string; model: string | null };
  window: { days: number };
  granted: {
    note: string;
    users: Array<{ id: string; name: string | null; via: string[] }>;
    revokedUsers: Array<{ id: string; name: string | null }>;
    grantingRoles: string[];
    tools: Array<{ serverId: string; serverName: string | null; toolName: string; holders: number }>;
    serverWideReadGrants: Array<{ serverId: string; serverName: string | null }>;
    connectors: Array<{ connectorId: string; connectorName: string | null; modes: string[]; holders: number }>;
  };
  observed: {
    note: string;
    dispatchesInWindow: number;
    lastDispatchAt: string | null;
    mcpTools: Array<{ serverName: string | null; toolName: string; calls: number; lastSeenAt: string }>;
    connectors: Array<{ connectorName: string | null; calls: number; lastSeenAt: string }>;
    feeds: { out: FeedEdgeView[]; in: FeedEdgeView[]; note: string };
  };
  links: {
    useCases: Array<{ id: string; name: string; status: string }>;
    risks: Array<{ id: string; title: string; status: string; category: string }>;
  };
}

const asrTone = (quality: string | null): Tone => (quality === "measured" ? "info" : "warn");

function FeedList(props: { title: string; edges: FeedEdgeView[]; direction: "out" | "in" }) {
  return (
    <div>
      <div className={v.sectionTitle}>{props.title}</div>
      {props.edges.length === 0 ? (
        <div className={v.faint}>none observed in any governed run</div>
      ) : (
        <div className={v.stackTight}>
          {props.edges.map((e) => (
            <div key={e.agentId} className={v.listRow}>
              <span className={v.grow}>
                {props.direction === "out" ? "→ feeds " : "← fed by "}
                <strong>{e.agentName ?? e.agentId}</strong>
              </span>
              <span className={v.faint}>
                {e.observedRuns} run(s){e.lastSeenAt ? `, last ${ago(e.lastSeenAt)}` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function InventoryPage() {
  const list = useQuery({
    queryKey: ["admin", "inventory"],
    queryFn: () =>
      api.get<{ agents: InventoryAgent[]; window: { days: number }; notes: { granted: string; observed: string } }>(
        "/v1/inventory/agents",
      ),
  });
  const [openId, setOpenId] = useState<string | null>(null);
  const detail = useQuery({
    queryKey: ["admin", "inventory", openId],
    queryFn: () => api.get<InventoryDetail>(`/v1/inventory/agents/${openId}`),
    enabled: Boolean(openId),
  });
  const d = detail.data;
  const days = list.data?.window.days ?? 90;

  return (
    <>
      <PageHeader
        title="Agent inventory"
        sub={`The standing dependency view: per registered agent, who holds a grant on it, what its runs actually touched, and which agents feed which — aggregated live from the grant tables and the run/usage/trace history (last ${days} days for windowed figures). GRANTED and OBSERVED are kept apart on purpose: one is what the entitlement rows allow, the other is what the ledgers recorded, and an unused permission is exactly the fact this page exists to make visible.`}
      />
      <div className={v.stack}>
        <QueryGate loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}>
          <Card title="Registered agents">
            {(list.data?.agents ?? []).length === 0 ? (
              <EmptyState title="No agents registered" body="The inventory fills in as agents are registered and used." />
            ) : (
              <Table
                rows={list.data?.agents ?? []}
                rowKey={(r) => r.id}
                onRowClick={(r) => setOpenId(openId === r.id ? null : r.id)}
                columns={[
                  {
                    key: "agent",
                    header: "Agent",
                    render: (r) => (
                      <>
                        {r.name} {!r.enabled && <Badge tone="neutral">disabled</Badge>}
                      </>
                    ),
                  },
                  {
                    key: "model",
                    header: "Model / credential",
                    render: (r) => (
                      <span className={v.faint}>
                        {r.provider}
                        {r.model ? ` · ${r.model}` : ""} · {r.credential.source}
                      </span>
                    ),
                  },
                  {
                    key: "card",
                    header: "Model card",
                    render: (r) =>
                      r.modelCard.cards === 0 ? (
                        <Badge tone="warn">none</Badge>
                      ) : r.modelCard.liveApproved ? (
                        <Badge tone="ok">live sign-off</Badge>
                      ) : (
                        <Badge tone="warn">no live sign-off</Badge>
                      ),
                  },
                  {
                    key: "granted",
                    header: "Granted (may)",
                    render: (r) => (
                      <span className={v.num}>
                        {r.granted.effectiveHolders} holder(s)
                        {r.granted.grantingRoles.length > 0 && (
                          <span className={v.faint}> · roles: {r.granted.grantingRoles.join(", ")}</span>
                        )}
                        {r.granted.revokedUsers > 0 && <span className={v.faint}> · {r.granted.revokedUsers} revoked</span>}
                      </span>
                    ),
                  },
                  {
                    key: "observed",
                    header: "Observed (did)",
                    render: (r) => (
                      <span className={v.num}>
                        {r.observed.dispatchesInWindow} dispatch(es)
                        {r.observed.lastDispatchAt ? (
                          <span className={v.faint}> · last {ago(r.observed.lastDispatchAt)}</span>
                        ) : (
                          <span className={v.faint}> · never observed</span>
                        )}
                      </span>
                    ),
                  },
                  {
                    key: "feeds",
                    header: "Feeds",
                    render: (r) => (
                      <span className={v.faint}>
                        {r.observed.feedsOut} out · {r.observed.feedsIn} in
                      </span>
                    ),
                  },
                  {
                    key: "coverage",
                    header: "Probed / evaled",
                    render: (r) =>
                      r.coverage.everProbed ? (
                        <span>
                          {r.coverage.latestAsr && (
                            <Badge tone={asrTone(r.coverage.latestAsr.measurementQuality)}>
                              ASR {r.coverage.latestAsr.asr == null ? "—" : `${Math.round(r.coverage.latestAsr.asr * 100)}%`} /{" "}
                              {r.coverage.latestAsr.asrTrials} trials
                            </Badge>
                          )}{" "}
                          <span className={v.faint}>{r.coverage.evalRunsInWindow} eval(s)</span>
                        </span>
                      ) : (
                        <Badge tone="warn">never probed</Badge>
                      ),
                  },
                  {
                    key: "links",
                    header: "Use cases / risks",
                    render: (r) => (
                      <span className={v.faint}>
                        {r.links.useCases} · {r.links.risks}
                        {r.links.openRisks > 0 ? ` (${r.links.openRisks} open)` : ""}
                      </span>
                    ),
                  },
                ]}
              />
            )}
          </Card>
        </QueryGate>

        {openId && (
          <QueryGate loading={detail.isLoading} error={detail.error} onRetry={() => void detail.refetch()}>
            {d && (
              <Card
                title={`Dependencies: ${d.agent.name}`}
                actions={<Button variant="ghost" onClick={() => setOpenId(null)}>Close</Button>}
              >
                <div className={v.grid2}>
                  {/* -------- GRANTED — what the entitlement rows allow -------- */}
                  <Card title="Granted — what the entitlement rows allow">
                    <div className={v.stack}>
                      <div className={v.faint}>{d.granted.note}</div>
                      <div>
                        <div className={v.sectionTitle}>Grant holders</div>
                        {d.granted.users.length === 0 ? (
                          <div className={v.faint}>nobody holds a grant on this agent</div>
                        ) : (
                          d.granted.users.map((u) => (
                            <div key={u.id} className={v.listRow}>
                              <span className={v.grow}>{u.name ?? u.id}</span>
                              <span className={v.faint}>{u.via.join(", ")}</span>
                            </div>
                          ))
                        )}
                        {d.granted.revokedUsers.length > 0 && (
                          <div className={v.faint}>
                            revoked: {d.granted.revokedUsers.map((u) => u.name ?? u.id).join(", ")}
                          </div>
                        )}
                      </div>
                      <div>
                        <div className={v.sectionTitle}>MCP tools reachable under some holder's grants</div>
                        {d.granted.tools.length === 0 ? (
                          <div className={v.faint}>no explicit tool grant among the holders</div>
                        ) : (
                          d.granted.tools.map((t) => (
                            <div key={`${t.serverId}:${t.toolName}`} className={v.listRow}>
                              <span className={v.grow}>
                                {t.serverName ?? t.serverId} · <strong>{t.toolName}</strong>
                              </span>
                              <span className={v.faint}>{t.holders} holder(s)</span>
                            </div>
                          ))
                        )}
                        {d.granted.serverWideReadGrants.length > 0 && (
                          <div className={v.faint}>
                            plus server-wide read-only grants on:{" "}
                            {d.granted.serverWideReadGrants.map((s) => s.serverName ?? s.serverId).join(", ")}
                          </div>
                        )}
                      </div>
                      <div>
                        <div className={v.sectionTitle}>Connectors reachable under some holder's grants</div>
                        {d.granted.connectors.length === 0 ? (
                          <div className={v.faint}>no connector grant among the holders</div>
                        ) : (
                          d.granted.connectors.map((c) => (
                            <div key={c.connectorId} className={v.listRow}>
                              <span className={v.grow}>{c.connectorName ?? c.connectorId}</span>
                              <span className={v.faint}>
                                {c.modes.join("/")} · {c.holders} holder(s)
                              </span>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  </Card>

                  {/* -------- OBSERVED — what the run history recorded -------- */}
                  <Card title="Observed — what the run history recorded">
                    <div className={v.stack}>
                      <div className={v.faint}>{d.observed.note}</div>
                      <div className={v.dim}>
                        {d.observed.dispatchesInWindow} governed dispatch(es) in the last {d.window.days} days
                        {d.observed.lastDispatchAt ? `, last ${ago(d.observed.lastDispatchAt)}` : ""}
                      </div>
                      <div>
                        <div className={v.sectionTitle}>MCP tools its dispatches actually touched</div>
                        {d.observed.mcpTools.length === 0 ? (
                          <div className={v.faint}>
                            none observed — no traced dispatch of this agent called an MCP tool in the window
                          </div>
                        ) : (
                          d.observed.mcpTools.map((t) => (
                            <div key={`${t.serverName}:${t.toolName}`} className={v.listRow}>
                              <span className={v.grow}>
                                {t.serverName ?? "(unknown server)"} · <strong>{t.toolName}</strong>
                              </span>
                              <span className={v.faint}>
                                {t.calls} call(s), last {ago(t.lastSeenAt)}
                              </span>
                            </div>
                          ))
                        )}
                      </div>
                      <div>
                        <div className={v.sectionTitle}>Connectors its dispatches actually touched</div>
                        {d.observed.connectors.length === 0 ? (
                          <div className={v.faint}>none observed</div>
                        ) : (
                          d.observed.connectors.map((c, i) => (
                            <div key={i} className={v.listRow}>
                              <span className={v.grow}>{c.connectorName ?? "(unknown)"}</span>
                              <span className={v.faint}>
                                {c.calls} call(s), last {ago(c.lastSeenAt)}
                              </span>
                            </div>
                          ))
                        )}
                      </div>
                      <FeedList title="Feeds (this agent's output consumed by)" edges={d.observed.feeds.out} direction="out" />
                      <FeedList title="Fed by (consumes output of)" edges={d.observed.feeds.in} direction="in" />
                      <div className={v.faint}>{d.observed.feeds.note}</div>
                    </div>
                  </Card>
                </div>

                {/* -------- linked governance objects -------- */}
                <div className={v.grid2}>
                  <Card title="Linked use cases">
                    {d.links.useCases.length === 0 ? (
                      <div className={v.faint}>no use case names this agent</div>
                    ) : (
                      d.links.useCases.map((u) => (
                        <div key={u.id} className={v.listRow}>
                          <span className={v.grow}>{u.name}</span>
                          <Badge tone="neutral">{u.status.replace(/_/g, " ")}</Badge>
                        </div>
                      ))
                    )}
                  </Card>
                  <Card title="Linked risks">
                    {d.links.risks.length === 0 ? (
                      <div className={v.faint}>no risk is scoped to this agent</div>
                    ) : (
                      d.links.risks.map((r) => (
                        <div key={r.id} className={v.listRow}>
                          <span className={v.grow}>{r.title}</span>
                          <Badge tone="neutral">{r.category.replace(/_/g, " ")}</Badge>{" "}
                          <Badge tone={r.status === "open" ? "danger" : "neutral"}>{r.status}</Badge>
                        </div>
                      ))
                    )}
                  </Card>
                </div>
              </Card>
            )}
          </QueryGate>
        )}
      </div>
    </>
  );
}
