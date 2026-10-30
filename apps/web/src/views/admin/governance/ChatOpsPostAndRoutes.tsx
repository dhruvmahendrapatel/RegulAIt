/**
 * ChatOps — two admin cards beside the workspaces:
 *
 *  - Post an approval to chat (`POST /v1/chatops/approvals/:id/post`): mirror
 *    one pending approval into a workspace channel. The gateway decides what
 *    the card carries: a sensitivity-fenced approval is posted as a link with
 *    its content withheld, and an approval is decidable in chat only where the
 *    workspace allows it (never by email). The answer says which.
 *  - Builder agent channel routes (`GET/PUT /v1/chatops/builder-routes`): which
 *    platform channel a builder agent answers on its connection. Empty =
 *    connection-wide. One agent per connection and channel; email channels are
 *    send-only and are not listed.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type { Approval } from "../../../api/types";
import { ago } from "../../../api/format";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table } from "../../../ui/kit";
import { OutcomePanel, QueryGate, useApiAction } from "../adminKit";
import v from "../../views.module.css";

export interface ChatConnectionOption {
  id: string;
  name: string;
  provider: string;
  defaultChannel: string;
  enabled: boolean;
}

export interface PostedApproval {
  messageId: string;
  redacted: boolean;
  decidable: boolean;
  messageRef: string | null;
}

/** the post body: only what the admin chose (an omitted field means the gateway's default) */
export function chatPostBody(connectionName: string, channel: string): { connectionName?: string; channel?: string } {
  return {
    ...(connectionName ? { connectionName } : {}),
    ...(channel.trim() ? { channel: channel.trim() } : {}),
  };
}

/** what the posted card carries, in words */
export function postedText(p: PostedApproval): string {
  const content = p.redacted ? "The approval's content was withheld (sensitivity fence): the card links to it." : "The card shows the approval.";
  const decide = p.decidable ? "Approvers can decide it in chat." : "It can be decided in the app only.";
  return `${content} ${decide}`;
}

export function PostApprovalCard(props: { connections: ChatConnectionOption[] }) {
  const pending = useQuery({
    queryKey: ["admin", "approvals", "pending", "chatops"],
    queryFn: () => api.get<{ approvals: Approval[] }>("/v1/approvals?status=pending"),
  });
  const act = useApiAction();
  const [approvalId, setApprovalId] = useState("");
  const [connectionName, setConnectionName] = useState("");
  const [channel, setChannel] = useState("");
  const [posted, setPosted] = useState<PostedApproval | null>(null);
  const enabled = props.connections.filter((c) => c.enabled);
  const chosen = enabled.find((c) => c.name === connectionName) ?? null;
  const rows = pending.data?.approvals ?? [];
  const label = (a: Approval) => `${a.toolName ?? a.objectType}${a.projectName ? ` · ${a.projectName}` : ""} · requested ${ago(a.requestedAt)}`;
  return (
    <Card
      title="Post an approval to chat"
      info={
        <p>
          Mirror one pending approval into a workspace channel. With no workspace chosen, the oldest enabled workspace is used.
          A fenced approval is posted as a link only, and email is never decidable.
        </p>
      }
    >
      <div className={v.stack} data-testid="chatops-post-approval">
        <QueryGate loading={pending.isLoading} error={pending.error} onRetry={() => void pending.refetch()}>
          {rows.length === 0 ? (
            <EmptyState title="No pending approvals" body="An approval waiting for a decision can be posted here." />
          ) : (
            <>
              <div className={v.row} style={{ alignItems: "flex-end" }}>
                <Field label="Approval">
                  <Select value={approvalId} onChange={(e) => setApprovalId(e.target.value)}>
                    <option value="">select…</option>
                    {rows.map((a) => (
                      <option key={a.id} value={a.id}>
                        {label(a)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Workspace">
                  <Select value={connectionName} onChange={(e) => setConnectionName(e.target.value)}>
                    <option value="">Default (oldest enabled)</option>
                    {enabled.map((c) => (
                      <option key={c.id} value={c.name}>
                        {c.name} ({c.provider})
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Channel (empty = the workspace default)">
                  <Input value={channel} maxLength={200} placeholder={chosen?.defaultChannel ?? ""} onChange={(e) => setChannel(e.target.value)} />
                </Field>
                <Button
                  variant="primary"
                  disabled={!approvalId || act.busy || enabled.length === 0}
                  onClick={() =>
                    void act
                      .run(() => api.post<PostedApproval>(`/v1/chatops/approvals/${encodeURIComponent(approvalId)}/post`, chatPostBody(connectionName, channel)), "Approval posted")
                      .then((r) => setPosted(r))
                  }
                >
                  Post to chat
                </Button>
              </div>
              {enabled.length === 0 ? <p className={v.faint}>No workspace is enabled, so there is nowhere to post.</p> : null}
            </>
          )}
        </QueryGate>
        <OutcomePanel outcome={act.outcome} testId="chatops-post-outcome">
          {act.outcome?.ok && posted ? <p>{postedText(posted)}</p> : null}
        </OutcomePanel>
      </div>
    </Card>
  );
}

export interface BuilderRoute {
  channelId: string;
  agentId: string;
  agentName: string;
  provider: string;
  connectionId: string;
  connectionName: string;
  externalChannelId: string | null;
}

export function BuilderRoutesCard() {
  const q = useQuery({
    queryKey: ["admin", "chatops", "builder-routes"],
    queryFn: () => api.get<{ routes: BuilderRoute[]; posture: string }>("/v1/chatops/builder-routes"),
  });
  const act = useApiAction();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const routes = q.data?.routes ?? [];
  return (
    <Card title="Builder agent channel routes" info={q.data?.posture ? <p>{q.data.posture}</p> : undefined}>
      <div className={v.stack} data-testid="chatops-builder-routes">
        <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
          <Table<BuilderRoute>
            rows={routes}
            rowKey={(r) => r.channelId}
            columns={[
              { key: "agent", header: "Agent", render: (r) => r.agentName },
              { key: "ws", header: "Workspace", render: (r) => `${r.connectionName} (${r.provider})` },
              {
                key: "channel",
                header: "Answers on",
                render: (r) => (r.externalChannelId ? <code>{r.externalChannelId}</code> : <Badge tone="neutral">connection-wide</Badge>),
              },
              {
                key: "edit",
                header: "Change",
                render: (r) => {
                  const draft = drafts[r.channelId] ?? r.externalChannelId ?? "";
                  const next = draft.trim() === "" ? null : draft.trim();
                  return (
                    <div className={v.row}>
                      <Field label={`Channel for ${r.agentName} (empty = connection-wide)`}>
                        <Input value={draft} maxLength={200} onChange={(e) => setDrafts((d) => ({ ...d, [r.channelId]: e.target.value }))} />
                      </Field>
                      <Button
                        size="sm"
                        disabled={act.busy || next === r.externalChannelId}
                        onClick={() =>
                          void act
                            .run(
                              () => api.put(`/v1/chatops/builder-routes/${encodeURIComponent(r.channelId)}`, { externalChannelId: next }),
                              next ? `${r.agentName} now answers on ${next}` : `${r.agentName} now answers connection-wide`,
                            )
                            .then((ok) => {
                              if (ok) {
                                setDrafts((d) => {
                                  const { [r.channelId]: _drop, ...rest } = d;
                                  return rest;
                                });
                                void q.refetch();
                              }
                            })
                        }
                      >
                        Save route
                      </Button>
                    </div>
                  );
                },
              },
            ]}
            empty={<EmptyState title="No builder agent is bound to a chat workspace" body="Bind a builder agent's Slack or Teams channel to a workspace first." />}
          />
        </QueryGate>
        <OutcomePanel outcome={act.outcome} testId="chatops-route-outcome" />
      </div>
    </Card>
  );
}
