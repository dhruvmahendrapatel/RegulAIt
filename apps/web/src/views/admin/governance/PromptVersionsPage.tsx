/**
 * Agent prompt versions — canary and rollback (ADR-0048).
 *
 * Four things this screen exists to keep honest, rendered rather than merely
 * documented:
 *
 *  - **An edit is an append.** The versions table shows every version that has
 *    ever existed, including the ones that were rolled back. Nothing on this
 *    page can destroy a version body.
 *  - **Rollback is one click and needs no version number.** In an incident the
 *    admin should not have to work out which number to type.
 *  - **The split is deterministic, and traffic proves it.** The traffic panel is
 *    read straight off `usage_events` — the one spend ledger — so "which version
 *    served how much, and how did it do" is the same data the cost dashboard
 *    reports, not a parallel metric.
 *  - **Promotion is gated, and an override is not free.** Promoting without a
 *    passing ADR-0044 eval run requires a written reason, and that reason lands
 *    in the append-only activation ledger and the audit trail.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago, fmtUsd } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table, Textarea } from "../../../ui/kit";
import { QueryGate, agentOpts, optionEls, useAction, useAgents } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

interface VersionRow {
  id: string;
  version: number;
  body: { systemPrompt?: string | null };
  label: string | null;
  parentVersion: number | null;
  status: "draft" | "canary" | "active" | "rolled_back" | "superseded";
  canaryPct: number | null;
  createdAt: string;
}
interface ActivationEvent {
  id: string;
  version: number;
  fromVersion: number | null;
  action: string;
  canaryPct: number | null;
  reason: string | null;
  evalRunId: string | null;
  override: boolean;
  at: string;
}
interface Lineage {
  versions: VersionRow[];
  active: VersionRow | null;
  canary: VersionRow | null;
  history: ActivationEvent[];
  canaryMode: "live" | "shadow";
  note: string;
}
interface TrafficRow {
  version: number | null;
  canary: boolean;
  dispatches: number;
  costUsd: number;
  refusals: number;
}

const statusTone = (s: VersionRow["status"]) =>
  s === "active" ? "ok" : s === "canary" ? "warn" : s === "rolled_back" ? "danger" : "neutral";

export default function PromptVersionsPage() {
  const act = useAction();
  const agents = useAgents();
  const [agentId, setAgentId] = useState("");
  const [draft, setDraft] = useState("");
  const [label, setLabel] = useState("");
  const [pct, setPct] = useState("5");
  const [canaryVersion, setCanaryVersion] = useState("");
  const [evalRunId, setEvalRunId] = useState("");
  const [override, setOverride] = useState(false);
  const [reason, setReason] = useState("");

  const lineage = useQuery({
    queryKey: ["admin", "config-versions", agentId],
    enabled: !!agentId,
    queryFn: () => api.get<Lineage>(`/v1/config-versions/agent_system_prompt/${agentId}`),
  });
  const traffic = useQuery({
    queryKey: ["admin", "config-traffic", agentId],
    enabled: !!agentId,
    queryFn: () =>
      api.get<{ byVersion: TrafficRow[]; note: string }>(
        `/v1/config-versions/agent_system_prompt/${agentId}/traffic`,
      ),
  });

  const refresh = async () => {
    await Promise.all([lineage.refetch(), traffic.refetch()]);
  };

  return (
    <>
      <PageHeader
        title="Prompt versions, canary & rollback"
        sub="An agent's base system prompt is a governance artifact, so changing it is versioned like the code that reads it: an edit INSERTS a new immutable version, activation is a pointer move, and rollback re-points at a body that was never overwritten. A canary routes a deterministic slice of traffic — sticky per run, so a multi-turn conversation cannot flip mid-conversation — and every dispatch records which version served it, so a regression is attributable to a version rather than to a time window."
      />
      <div className={v.stack}>
        <Card title="Agent">
          <div className={a.formRow}>
            <Field label="Agent">
              <Select
                value={agentId}
                onChange={(e) => {
                  setAgentId(e.target.value);
                  setDraft("");
                }}
              >
                {optionEls(agentOpts(agents.data?.agents), "select an agent…")}
              </Select>
            </Field>
          </div>
        </Card>

        {!agentId ? (
          <EmptyState title="Pick an agent" body="Its version lineage, canary state and per-version traffic appear here." />
        ) : (
          <QueryGate loading={lineage.isLoading} error={lineage.error} onRetry={() => void refresh()}>
            <Card title="Current state">
              <div className={a.formRow}>
                <Field label="Active version">
                  <Input readOnly value={lineage.data?.active ? `v${lineage.data.active.version}` : "none"} />
                </Field>
                <Field label="Canary">
                  <Input
                    readOnly
                    value={
                      lineage.data?.canary
                        ? `v${lineage.data.canary.version} @ ${lineage.data.canary.canaryPct}%`
                        : "none"
                    }
                  />
                </Field>
                <Field label="Canary mode">
                  <Input readOnly value={lineage.data?.canaryMode ?? "—"} />
                </Field>
                <Field label="&nbsp;">
                  <Button
                    variant="danger"
                    disabled={act.busy || !lineage.data?.active}
                    onClick={() =>
                      void act.run(async () => {
                        const r = await api.post<{ activeVersion: number; rolledBackFrom: number | null }>(
                          `/v1/config-versions/agent_system_prompt/${agentId}/rollback`,
                          { reason: reason || "rollback from the admin console" },
                        );
                        await refresh();
                        return `rolled back to v${r.activeVersion}`;
                      })
                    }
                  >
                    Roll back one version
                  </Button>
                </Field>
              </div>
              <div className={v.faint}>{lineage.data?.note}</div>
            </Card>

            <Card title="New version">
              <div className={v.stack}>
                <Field label="Base system prompt (this INSERTS a version — the current one is not overwritten)">
                  <Textarea rows={6} value={draft} onChange={(e) => setDraft(e.target.value)} />
                </Field>
                <div className={a.formRow}>
                  <Field label="Label">
                    <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="v7 — tightened PII instruction" />
                  </Field>
                  <Field label="&nbsp;">
                    <Button
                      disabled={act.busy || !draft}
                      onClick={() =>
                        void act.run(async () => {
                          await api.post(`/v1/config-versions/agent_system_prompt/${agentId}`, {
                            body: { systemPrompt: draft },
                            label: label || null,
                            activate: false,
                          });
                          setDraft("");
                          setLabel("");
                          await refresh();
                        }, "Version created as a draft — it serves nothing until activated or canaried")
                      }
                    >
                      Create draft version
                    </Button>
                  </Field>
                  <Field label="Canary version">
                    <Input value={canaryVersion} onChange={(e) => setCanaryVersion(e.target.value)} placeholder="2" />
                  </Field>
                  <Field label="Percent">
                    <Input value={pct} onChange={(e) => setPct(e.target.value)} />
                  </Field>
                  <Field label="&nbsp;">
                    <Button
                      disabled={act.busy || !canaryVersion}
                      onClick={() =>
                        void act.run(async () => {
                          await api.post(`/v1/config-versions/agent_system_prompt/${agentId}/canary`, {
                            version: Number(canaryVersion),
                            pct: Number(pct),
                          });
                          await refresh();
                        }, "Canary started")
                      }
                    >
                      Start / ramp canary
                    </Button>
                  </Field>
                </div>
              </div>
            </Card>

            <Card title="Promote the canary">
              <div className={v.stack}>
                <div className={v.faint}>
                  Promotion is gated on an ADR-0044 evaluation run that post-dates the canary version and passed its
                  regression thresholds. Without one, promotion is possible only as an explicit override <em>with a
                  reason</em> — audited as <code>canary-promote-override</code>, and recorded on the append-only
                  activation ledger.
                </div>
                <div className={a.formRow}>
                  <Field label="Eval run id">
                    <Input value={evalRunId} onChange={(e) => setEvalRunId(e.target.value)} />
                  </Field>
                  <Field label="Override the gate">
                    <Select value={override ? "yes" : "no"} onChange={(e) => setOverride(e.target.value === "yes")}>
                      <option value="no">no — require a passing eval</option>
                      <option value="yes">yes — override, with a reason</option>
                    </Select>
                  </Field>
                  <Field label="Reason">
                    <Input value={reason} onChange={(e) => setReason(e.target.value)} />
                  </Field>
                  <Field label="&nbsp;">
                    <Button
                      disabled={act.busy || !lineage.data?.canary}
                      onClick={() =>
                        void act.run(async () => {
                          const r = await api.post<{ activeVersion: number; gate: string }>(
                            `/v1/config-versions/agent_system_prompt/${agentId}/promote`,
                            {
                              ...(evalRunId ? { evalRunId } : {}),
                              override,
                              ...(reason ? { reason } : {}),
                            },
                          );
                          await refresh();
                          return `v${r.activeVersion} promoted (${r.gate})`;
                        })
                      }
                    >
                      Promote
                    </Button>
                  </Field>
                  <Field label="&nbsp;">
                    <Button
                      variant="danger"
                      disabled={act.busy || !lineage.data?.canary}
                      onClick={() =>
                        void act.run(async () => {
                          await api.del(`/v1/config-versions/agent_system_prompt/${agentId}/canary`);
                          await refresh();
                        }, "Canary abandoned — the active version is untouched")
                      }
                    >
                      Abandon canary
                    </Button>
                  </Field>
                </div>
              </div>
            </Card>

            <Card title="Versions">
              <Table
                rows={lineage.data?.versions ?? []}
                rowKey={(r) => r.id}
                columns={[
                  { key: "v", header: "Version", render: (r) => `v${r.version}` },
                  {
                    key: "s",
                    header: "Status",
                    render: (r) => (
                      <Badge tone={statusTone(r.status)}>
                        {r.status}
                        {r.canaryPct != null ? ` @ ${r.canaryPct}%` : ""}
                      </Badge>
                    ),
                  },
                  { key: "l", header: "Label", render: (r) => r.label ?? <span className={v.faint}>—</span> },
                  {
                    key: "p",
                    header: "Prompt",
                    render: (r) => (
                      <span className={v.faint}>{(r.body.systemPrompt ?? "(cleared)").slice(0, 90)}</span>
                    ),
                  },
                  { key: "c", header: "Created", render: (r) => ago(r.createdAt) },
                  {
                    key: "act",
                    header: "",
                    render: (r) =>
                      r.status === "active" ? null : (
                        <Button
                          size="sm"
                          onClick={() =>
                            void act.run(async () => {
                              await api.post(`/v1/config-versions/agent_system_prompt/${agentId}/activate`, {
                                version: r.version,
                              });
                              await refresh();
                            }, `v${r.version} activated`)
                          }
                        >
                          Activate
                        </Button>
                      ),
                  },
                ]}
              />
            </Card>

            <Card title="Traffic by version">
              <div className={v.stack}>
                <div className={v.faint}>{traffic.data?.note}</div>
                <Table
                  rows={traffic.data?.byVersion ?? []}
                  rowKey={(r) => `${r.version}-${r.canary}`}
                  columns={[
                    { key: "v", header: "Version", render: (r) => (r.version == null ? "—" : `v${r.version}`) },
                    {
                      key: "c",
                      header: "Served as",
                      render: (r) => <Badge tone={r.canary ? "warn" : "ok"}>{r.canary ? "canary" : "active"}</Badge>,
                    },
                    { key: "d", header: "Dispatches", render: (r) => r.dispatches },
                    { key: "u", header: "Spend", render: (r) => fmtUsd(r.costUsd) },
                    { key: "r", header: "Refusals", render: (r) => r.refusals },
                  ]}
                />
              </div>
            </Card>

            <Card title="Activation history (append-only)">
              <Table
                rows={lineage.data?.history ?? []}
                rowKey={(r) => r.id}
                columns={[
                  { key: "a", header: "Action", render: (r) => <Badge tone={r.action === "rolled_back" ? "danger" : "info"}>{r.action}</Badge> },
                  {
                    key: "v",
                    header: "Version",
                    render: (r) => (r.fromVersion ? `v${r.fromVersion} → v${r.version}` : `v${r.version}`),
                  },
                  { key: "g", header: "Gate", render: (r) => (r.override ? <Badge tone="danger">override</Badge> : r.evalRunId ? <Badge tone="ok">eval-gated</Badge> : <span className={v.faint}>—</span>) },
                  { key: "r", header: "Reason", render: (r) => <span className={v.faint}>{r.reason ?? "—"}</span> },
                  { key: "t", header: "When", render: (r) => ago(r.at) },
                ]}
              />
            </Card>
          </QueryGate>
        )}
      </div>
    </>
  );
}
