/**
 * Spend & savings — pillars 5 and 6 for the person who GENERATES the spend.
 *
 * Scoped to the SIGNED-IN USER, never the org. `/v1/usage-events` and
 * `/v1/cost-events` are both in the gateway's NON_ADMIN_ROUTES and both force
 * `userId` to `req.authCtx.userId` for a non-admin — the query string is not
 * trusted, so a developer cannot widen this page to the org even by hand. An
 * ADMIN is the case that needs care: for them those endpoints default to
 * ORG-WIDE, so this page always sends `?userId=<me>` and says so on the page.
 * Org-wide rollups live in the admin Cost dashboard, deliberately elsewhere.
 *
 * Everything shown here is the same ledger the admin dashboard rolls up —
 * measured actuals from `usage_events`, estimated savings from `cost_events` —
 * so the two surfaces can never disagree about a number.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import type { CostEventsResponse } from "../../api/adminTypes";
import type { MyAgentsResponse, Project, UsageEventsResponse } from "../../api/types";
import { ago, fmtUsd } from "../../api/format";
import { useSession } from "../../session/SessionContext";
import { PageHeader } from "../../shell/AppShell";
import {
  Badge,
  BarList,
  Button,
  Card,
  EmptyState,
  ErrorState,
  SkeletonBlock,
  Table,
  Tabs,
} from "../../ui/kit";
import { useToast } from "../../ui/toast";
import v from "../views.module.css";
import s from "./spend.module.css";

interface MyConnector {
  connectorId: string;
  name: string;
}

/** an agent-object usage row, decorated for the invocations table */
interface Row {
  rowKey: string;
  at: string;
  agentId?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  measuredCostSavedUsd?: number;
  refusal?: boolean;
  projectId?: string | null;
  detail?: { credentialSource?: string } | null;
}

const DAYS = 14;

export default function SpendPage() {
  const { auth } = useSession();
  const { toast } = useToast();
  const userId = auth?.userId ?? null;
  const [tab, setTab] = useState("spend");

  // Always self-scoped. For a non-admin the gateway forces this anyway; for an
  // admin it is the difference between "my spend" and the whole organisation's.
  const mine = userId ? `&userId=${userId}` : "";

  const usageQ = useQuery({
    queryKey: ["my-usage-events", userId],
    enabled: Boolean(userId),
    queryFn: () => api.get<UsageEventsResponse>(`/v1/usage-events?limit=200${mine}`),
  });
  const costQ = useQuery({
    queryKey: ["my-cost-events", userId],
    enabled: Boolean(userId),
    queryFn: () => api.get<CostEventsResponse>(`/v1/cost-events?limit=200${mine}`),
  });
  const projectsQ = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.get<{ projects: Project[] }>("/v1/projects"),
  });
  // the caller's OWN granted agents/connectors — non-admin-safe name lookups
  // (the admin catalogs are 403 for a developer, so they are never used here)
  const agentsQ = useQuery({
    queryKey: ["my-agents", userId],
    enabled: Boolean(userId),
    queryFn: () => api.get<MyAgentsResponse>(`/v1/users/${userId}/agents`),
  });
  const connectorsQ = useQuery({
    queryKey: ["my-connectors", userId],
    enabled: Boolean(userId),
    queryFn: () => api.get<{ connectors: MyConnector[] }>(`/v1/users/${userId}/connectors`),
  });

  const agentName = useMemo(
    () => new Map((agentsQ.data?.agents ?? []).map((a) => [a.agentId, a.name])),
    [agentsQ.data],
  );
  const connectorName = useMemo(
    () => new Map((connectorsQ.data?.connectors ?? []).map((c) => [c.connectorId, c.name])),
    [connectorsQ.data],
  );
  const projectName = useMemo(
    () => new Map((projectsQ.data?.projects ?? []).map((p) => [p.id, p.name])),
    [projectsQ.data],
  );

  const events = useMemo(() => usageQ.data?.events ?? [], [usageQ.data]);
  const totals = usageQ.data?.totals ?? {};
  const techniques = useMemo(() => costQ.data?.totals ?? [], [costQ.data]);
  const estimatedSaved = techniques.reduce((acc, t) => acc + (t.estimatedCostSavedUsd ?? 0), 0);

  // one ledger, two object types — an agent row is never shown as a connector
  // row and vice versa (they have different, non-comparable price models).
  const byAgent = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of events) {
      if (e.objectType === "connector") continue;
      const key = e.agentId ?? e.model ?? "unknown";
      m.set(key, (m.get(key) ?? 0) + (e.costUsd ?? 0));
    }
    return [...m].map(([k, value]) => ({ key: k, label: agentName.get(k) ?? k, value }))
      .sort((a, b) => b.value - a.value);
  }, [events, agentName]);

  const byConnector = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of events) {
      if (e.objectType !== "connector") continue;
      const key = `${e.connectorId ?? "?"}:${e.operation ?? ""}`;
      m.set(key, (m.get(key) ?? 0) + (e.costUsd ?? 0));
    }
    return [...m]
      .map(([k, value]) => {
        const [cid, op] = k.split(":");
        return {
          key: k,
          label: `${connectorName.get(cid ?? "") ?? "connector"} · ${op ?? ""}`,
          value,
        };
      })
      .sort((a, b) => b.value - a.value);
  }, [events, connectorName]);

  const byProject = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of events) {
      m.set(e.projectId ?? "", (m.get(e.projectId ?? "") ?? 0) + (e.costUsd ?? 0));
    }
    return [...m].map(([k, value]) => ({ key: k || "unattributed", id: k, value }))
      .sort((a, b) => b.value - a.value);
  }, [events]);

  // spend per calendar day, last 14 days — empty days render as empty, never
  // dropped, so a gap in your activity reads as a gap and not as a shorter axis
  const byDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of events) {
      const day = String(e.at).slice(0, 10);
      m.set(day, (m.get(day) ?? 0) + (e.costUsd ?? 0));
    }
    const out: Array<{ day: string; value: number }> = [];
    for (let i = DAYS - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      out.push({ day: d, value: m.get(d) ?? 0 });
    }
    return out;
  }, [events]);

  const rows: Row[] = useMemo(
    () =>
      events
        .filter((e) => e.objectType !== "connector")
        .map((e, i) => ({ ...(e as Row), rowKey: `${e.at}-${i}` })),
    [events],
  );

  // A bootstrap-token operator has no user identity, so there is no personal
  // ledger to show — and the gateway answers those calls with a 403 saying so.
  if (auth && !userId) {
    return (
      <>
        <PageHeader title="Spend & savings" />
        <Card>
          <EmptyState
            title="This session has no personal ledger"
            body="You are signed in with the bootstrap token rather than as a user, and spend is attributed per user. Sign in as a user to see your own spend, or open the admin Cost dashboard for the organisation's."
          />
        </Card>
      </>
    );
  }

  if (usageQ.isLoading || costQ.isLoading) {
    return (
      <>
        <PageHeader title="Spend & savings" />
        <Card>
          <SkeletonBlock lines={6} />
        </Card>
      </>
    );
  }
  if (usageQ.isError || costQ.isError) {
    const err = (usageQ.error ?? costQ.error) as { status?: number; message?: string };
    return (
      <>
        <PageHeader title="Spend & savings" />
        <Card>
          <ErrorState
            message={err?.message ?? "unknown error"}
            access={err?.status === 403}
            onRetry={() => {
              void usageQ.refetch();
              void costQ.refetch();
            }}
          />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Spend & savings"
        sub={
          <>
            Your own measured spend, and what the optimization layer saved on your behalf — the
            same ledgers the admin dashboard rolls up, scoped to you.
            {auth?.isAdmin && (
              <>
                {" "}
                <Badge tone="info">your own numbers only</Badge> You are an admin, so this page
                asks for your user id explicitly; the organisation-wide rollup is the{" "}
                <Link to="/admin/cost">Cost dashboard</Link>.
              </>
            )}
          </>
        }
        actions={
          <Button
            size="sm"
            onClick={() => {
              void downloadMyUsageCsv(mine, (m) => toast(m, "error"));
            }}
          >
            Download CSV
          </Button>
        }
      />

      <div className={v.stack}>
        <div className={v.grid4}>
          <Card>
            <div className={v.stat}>
              <span className={v.statValue}>{fmtUsd(totals.costUsd)}</span>
              <span className={v.statLabel}>measured spend · {totals.events ?? 0} calls</span>
            </div>
          </Card>
          <Card>
            <div className={v.stat}>
              <span className={v.statValue}>
                {(totals.inputTokens ?? 0).toLocaleString()} →{" "}
                {(totals.outputTokens ?? 0).toLocaleString()}
              </span>
              <span className={v.statLabel}>tokens in → out</span>
            </div>
          </Card>
          <Card>
            <div className={v.stat}>
              <span className={v.statValue}>{fmtUsd(totals.measuredCostSavedUsd)}</span>
              <span className={v.statLabel}>measured savings — routing actuals</span>
            </div>
          </Card>
          <Card>
            <div className={v.stat}>
              <span className={v.statValue}>{fmtUsd(estimatedSaved)}</span>
              <span className={v.statLabel}>estimated savings — all techniques</span>
            </div>
          </Card>
        </div>

        <Tabs
          tabs={[
            { id: "spend", label: "Spend" },
            { id: "savings", label: "Savings" },
          ]}
          active={tab}
          onChange={setTab}
        />

        {tab === "spend" ? (
          <>
            <Card title={`Spend over the last ${DAYS} days`}>
              {totals.events ? (
                <>
                  <DayChart days={byDay} />
                  <div className={v.faint} style={{ marginTop: "var(--s1)" }}>
                    Days with no metered call render empty rather than being dropped — a quiet day
                    is a real day. Unpriced calls (no list price for the model) count as $0 here and
                    are named as unpriced in the table below.
                  </div>
                </>
              ) : (
                <EmptyState
                  title="No metered calls yet"
                  body="Say something in Chat — every dispatch is governed, metered and attributed to you."
                  action={
                    <Link to="/chat">
                      <Button size="sm">Open Chat</Button>
                    </Link>
                  }
                />
              )}
            </Card>

            <div className={v.grid2}>
              <Card title="Spend by project">
                <BarList
                  items={byProject.map((p) => ({
                    key: p.key,
                    value: p.value,
                    title: p.id ? (projectName.get(p.id) ?? p.id) : "unattributed",
                    label: p.id ? (
                      <Link to={`/projects/${p.id}`}>{projectName.get(p.id) ?? p.id.slice(0, 8) + "…"}</Link>
                    ) : (
                      "unattributed"
                    ),
                  }))}
                  format={fmtUsd}
                  empty={
                    <EmptyState
                      title="Nothing attributed yet"
                      body="Pick a project in Chat and your spend lands against its budget."
                    />
                  }
                />
                <div className={v.faint} style={{ marginTop: "var(--s1)" }}>
                  “unattributed” is a real bucket, not a rounding error — calls that arrived
                  without a project id. Open a project for its budget, forecast and showback.
                </div>
              </Card>
              <Card title="Spend by agent">
                <BarList items={byAgent} format={fmtUsd} />
              </Card>
            </div>

            <Card title="Spend by connector">
              <BarList
                items={byConnector}
                format={fmtUsd}
                empty={
                  <EmptyState
                    title="No metered connector calls"
                    body="Connector spend appears here once you invoke a connector that has a provider adapter and a per-call price."
                  />
                }
              />
            </Card>

            <Card title="Recent invocations" flush>
              <Table<Row>
                columns={[
                  {
                    key: "at",
                    header: "When",
                    sort: (e) => e.at,
                    render: (e) => <span className={v.faint}>{ago(e.at)}</span>,
                  },
                  {
                    key: "agent",
                    header: "Agent",
                    render: (e) => (e.agentId ? (agentName.get(e.agentId) ?? "agent") : "agent"),
                  },
                  {
                    key: "model",
                    header: "Model served",
                    render: (e) => (
                      <span className={v.rowTight}>
                        <span className={v.mono}>{e.model ?? "—"}</span>
                        {e.refusal && <Badge tone="danger">refused</Badge>}
                      </span>
                    ),
                  },
                  {
                    key: "key",
                    header: "Key used",
                    render: (e) => <CredentialSource source={e.detail?.credentialSource} />,
                  },
                  {
                    key: "tokens",
                    header: "Tokens",
                    align: "right",
                    render: (e) => `${e.inputTokens ?? 0} → ${e.outputTokens ?? 0}`,
                  },
                  {
                    key: "cost",
                    header: "Cost",
                    align: "right",
                    sort: (e) => e.costUsd ?? 0,
                    render: (e) =>
                      e.costUsd == null ? (
                        <span className={v.faint}>unpriced</span>
                      ) : (
                        <span className={v.num}>{fmtUsd(e.costUsd)}</span>
                      ),
                  },
                  {
                    key: "saved",
                    header: "Saved",
                    align: "right",
                    render: (e) =>
                      e.measuredCostSavedUsd ? (
                        <span className={v.num}>{fmtUsd(e.measuredCostSavedUsd)}</span>
                      ) : (
                        <span className={v.faint}>—</span>
                      ),
                  },
                  {
                    key: "project",
                    header: "Project",
                    render: (e) =>
                      e.projectId ? (
                        <Link to={`/projects/${e.projectId}`}>
                          {projectName.get(e.projectId) ?? e.projectId.slice(0, 8) + "…"}
                        </Link>
                      ) : (
                        <Badge tone="warn">unattributed</Badge>
                      ),
                  },
                ]}
                rows={rows.slice(0, 50)}
                rowKey={(e) => e.rowKey}
                empty={
                  <EmptyState
                    title="No metered invocations yet"
                    body="Every governed dispatch you make writes one row here, priced at the served model's list price."
                  />
                }
              />
            </Card>
          </>
        ) : (
          <>
            <Card title="Savings by technique — estimated, full history">
              <BarList
                items={techniques.map((t) => ({
                  key: t.technique,
                  label: t.technique,
                  value: t.estimatedCostSavedUsd ?? 0,
                }))}
                format={fmtUsd}
                empty={
                  <EmptyState
                    title="No savings recorded yet"
                    body="The optimization layer writes an event as it works on your behalf — right-sized routing, context compaction, caching, edit-vs-rewrite, lazy tool loading and batching."
                  />
                }
              />
            </Card>

            <Card title="What the optimizer did for you" flush>
              <Table<(typeof techniques)[number]>
                columns={[
                  { key: "technique", header: "Technique", render: (t) => <Badge tone="info">{t.technique}</Badge> },
                  { key: "events", header: "Times applied", align: "right", render: (t) => t.events },
                  {
                    key: "tokens",
                    header: "Tokens saved",
                    align: "right",
                    render: (t) => (t.estimatedTokensSaved ?? 0).toLocaleString(),
                  },
                  {
                    key: "usd",
                    header: "Est. saved",
                    align: "right",
                    sort: (t) => t.estimatedCostSavedUsd ?? 0,
                    render: (t) => <span className={v.num}>{fmtUsd(t.estimatedCostSavedUsd)}</span>,
                  },
                ]}
                rows={techniques}
                rowKey={(t) => t.technique}
                empty={<EmptyState title="Nothing to report yet" />}
              />
            </Card>

            <Card title="Estimated vs measured">
              <div className={v.dim}>
                <strong>Estimated</strong> savings come from the optimization ledger: each
                technique records what it believes it avoided at the moment it fired.{" "}
                <strong>Measured</strong> savings are computed after the fact from the usage
                ledger — what the routing baseline would have cost at the same measured token
                volumes, minus what you were actually charged. The two are different numbers on
                purpose and are never added together.
              </div>
              <div className={v.grid2} style={{ marginTop: "var(--s2)" }}>
                <div className={v.stat}>
                  <span className={v.statValue}>{fmtUsd(estimatedSaved)}</span>
                  <span className={v.statLabel}>estimated · {techniques.length} techniques</span>
                </div>
                <div className={v.stat}>
                  <span className={v.statValue}>{fmtUsd(totals.measuredCostSavedUsd)}</span>
                  <span className={v.statLabel}>measured · routing only</span>
                </div>
              </div>
            </Card>
          </>
        )}
      </div>
    </>
  );
}

/** Which credential actually served the call — measured from the ledger row,
 * never inferred from what keys you happen to have stored. */
function CredentialSource(props: { source?: string }) {
  if (props.source === "user") {
    return (
      <Badge tone="primary" title="This call ran on a key you supplied">
        your key
      </Badge>
    );
  }
  if (props.source === "platform") {
    return (
      <Badge tone="neutral" title="This call ran on the organisation's platform credential">
        platform
      </Badge>
    );
  }
  return (
    <span className={v.faint} title="No vendor credential was needed — the mock provider">
      none
    </span>
  );
}

function DayChart(props: { days: Array<{ day: string; value: number }> }) {
  const max = Math.max(...props.days.map((d) => d.value), 1e-9);
  const first = props.days[0]?.day ?? "";
  const last = props.days[props.days.length - 1]?.day ?? "";
  return (
    <div>
      <div className={s.dayChart} role="img" aria-label="Daily spend, last 14 days">
        {props.days.map((d) => (
          <div key={d.day} className={s.dayCol} title={`${d.day} · ${fmtUsd(d.value)}`}>
            <div
              className={d.value > 0 ? s.dayBar : `${s.dayBar} ${s.dayBarEmpty}`}
              style={{ height: d.value > 0 ? `${Math.max(4, (d.value / max) * 100)}%` : "3px" }}
            />
          </div>
        ))}
      </div>
      <div className={s.dayAxis}>
        <span>{first}</span>
        <span>{last}</span>
      </div>
    </div>
  );
}

/** authed CSV download of YOUR usage ledger via a transient blob URL */
async function downloadMyUsageCsv(mine: string, onError: (msg: string) => void) {
  const res = await fetch(`/v1/usage-events?format=csv&limit=500${mine}`, {
    credentials: "include",
  });
  if (!res.ok) {
    onError(`CSV download failed (${res.status})`);
    return;
  }
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = "my-usage-events.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
