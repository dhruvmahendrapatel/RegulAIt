/**
 * ADR-0172 — builder Usage: spend and messages across agents, people and
 * models, with each agent's monthly limit. Admins see the whole workspace;
 * everyone else sees their own agents and their own use.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { fmtUsd } from "../../api/format";
import { useSession } from "../../session/SessionContext";
import { PageHeader } from "../../shell/AppShell";
import { Button, Card, EmptyState, ErrorState, Meter, Select, SkeletonBlock, Table, Tabs } from "../../ui/kit";
import { Logo } from "../../ui/logos/Logo";
import { providerLogoKey } from "../../ui/logos/providerLogo";
import { bk, builderApi } from "./builderApi";
import { shapeDaily, shortDate, spendState, withShare } from "./builderLogic";
import s from "./builder.module.css";

const pct = (x: number) => `${Math.round(x * 100)}%`;

function DailyChart(props: { daily: Array<{ date: string; spendUsd: number; messages: number }> }) {
  const [asTable, setAsTable] = useState(false);
  const max = Math.max(...props.daily.map((d) => d.spendUsd), 0);
  const total = props.daily.reduce((a, d) => a + d.spendUsd, 0);
  return (
    <Card
      title="Spend over time"
      actions={
        <Button size="sm" variant="ghost" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>
          {asTable ? "Show chart" : "Show as table"}
        </Button>
      }
    >
      {total === 0 && !asTable ? (
        <EmptyState title="No spend in this period" body="Agent activity appears here as it happens." />
      ) : asTable ? (
        <Table
          rows={props.daily}
          rowKey={(d) => d.date}
          columns={[
            { key: "date", header: "Day", render: (d) => shortDate(d.date) },
            { key: "spend", header: "Spend", align: "right", render: (d) => fmtUsd(d.spendUsd) },
            { key: "messages", header: "Messages", align: "right", render: (d) => d.messages.toLocaleString() },
          ]}
        />
      ) : (
        <>
          <div className={s.chart} role="list" aria-label="Daily spend">
            {props.daily.map((d) => {
              const label = `${shortDate(d.date)}: ${fmtUsd(d.spendUsd)}, ${d.messages} message${d.messages === 1 ? "" : "s"}`;
              return (
                <div key={d.date} className={s.col} role="listitem" tabIndex={0} aria-label={label}>
                  <div className={d.spendUsd > 0 ? s.colBar : s.colZero} style={{ height: d.spendUsd > 0 && max > 0 ? `${Math.max(3, (d.spendUsd / max) * 100)}%` : "2px" }} />
                  <span className={s.colTip} aria-hidden>
                    {label}
                  </span>
                </div>
              );
            })}
          </div>
          <div className={s.axis} aria-hidden>
            <span>{props.daily[0] ? shortDate(props.daily[0].date) : ""}</span>
            <span>Peak {fmtUsd(max)}</span>
            <span>{props.daily.length ? shortDate(props.daily[props.daily.length - 1]!.date) : ""}</span>
          </div>
        </>
      )}
    </Card>
  );
}

export default function BuilderUsagePage() {
  const [days, setDays] = useState<7 | 30>(7);
  const [tab, setTab] = useState("agent");
  const { auth } = useSession();
  const q = useQuery({ queryKey: bk.usage(days), queryFn: () => builderApi.usage(days) });
  const daily = useMemo(() => shapeDaily(q.data?.daily ?? [], days), [q.data, days]);
  const byAgent = useMemo(() => withShare(q.data?.byAgent ?? []), [q.data]);
  const byUser = useMemo(() => withShare(q.data?.byUser ?? []), [q.data]);
  const byModel = useMemo(() => withShare(q.data?.byModel ?? []), [q.data]);
  const t = q.data?.totals;

  return (
    <>
      <PageHeader
        title="Agent usage"
        crumbs={["Agent builder"]}
        sub={auth?.isAdmin ? "Spend and activity across every agent in the workspace." : "Spend and activity for your agents and your own use."}
        actions={
          <Select aria-label="Period" value={String(days)} onChange={(e) => setDays(e.target.value === "30" ? 30 : 7)} style={{ width: "auto" }}>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
          </Select>
        }
      />
      {q.isLoading ? (
        <Card>
          <SkeletonBlock lines={6} />
        </Card>
      ) : q.isError || !t ? (
        <Card>
          <ErrorState title="Couldn't load usage" message={q.error instanceof Error ? q.error.message : "No usage data"} onRetry={() => void q.refetch()} />
        </Card>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <section className={`${s.glass} ${s.kpis}`} aria-label="Totals">
            {[
              ["Spend", fmtUsd(t.spendUsd)],
              ["Messages", t.messages.toLocaleString()],
              ["Agents", t.agents.toLocaleString()],
              ["Active people", t.activeUsers.toLocaleString()],
            ].map(([label, value]) => (
              <div key={label} className={s.kpi}>
                <span className={s.kpiLabel}>{label}</span>
                <span className={s.kpiValue}>{value}</span>
              </div>
            ))}
          </section>

          <DailyChart daily={daily} />

          <Card title="Breakdown" flush>
            <div style={{ padding: "0 16px" }}>
              <Tabs
                tabs={[
                  { id: "agent", label: "By agent" },
                  { id: "user", label: "By person" },
                  { id: "model", label: "By model" },
                ]}
                active={tab}
                onChange={setTab}
              />
            </div>
            {tab === "agent" ? (
              <Table
                rows={byAgent}
                rowKey={(r) => r.agentId}
                empty={<EmptyState title="No agent activity in this period" />}
                columns={[
                  { key: "name", header: "Agent", sort: (r) => r.name.toLowerCase(), render: (r) => <Link className={s.helpLink} to={`/builder/agents/${r.agentId}`}>{r.name}</Link> },
                  { key: "messages", header: "Messages", align: "right", sort: (r) => r.messages, render: (r) => r.messages.toLocaleString() },
                  { key: "spend", header: "Spend", align: "right", sort: (r) => r.spendUsd, render: (r) => `${fmtUsd(r.spendUsd)} · ${pct(r.share)}` },
                  {
                    key: "limit",
                    header: "Monthly limit",
                    width: "220px",
                    render: (r) => {
                      if (r.limitUsd == null) return <span className={s.small}>No limit</span>;
                      const st = spendState(r.spendUsd, r.limitUsd);
                      return (
                        <span style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 160 }}>
                          <span className={s.small}>{fmtUsd(r.limitUsd)}</span>
                          <Meter value={r.spendUsd} max={r.limitUsd} warn={st === "warn"} over={st === "over"} label={`${r.name} spend against its limit`} />
                        </span>
                      );
                    },
                  },
                ]}
              />
            ) : tab === "user" ? (
              <Table
                rows={byUser}
                rowKey={(r) => r.userId}
                empty={<EmptyState title="No activity in this period" />}
                columns={[
                  { key: "name", header: "Person", sort: (r) => r.name.toLowerCase(), render: (r) => r.name },
                  { key: "messages", header: "Messages", align: "right", sort: (r) => r.messages, render: (r) => r.messages.toLocaleString() },
                  { key: "spend", header: "Spend", align: "right", sort: (r) => r.spendUsd, render: (r) => `${fmtUsd(r.spendUsd)} · ${pct(r.share)}` },
                ]}
              />
            ) : (
              <Table
                rows={byModel}
                rowKey={(r) => `${r.provider}/${r.model}`}
                empty={<EmptyState title="No model activity in this period" />}
                columns={[
                  {
                    key: "model",
                    header: "Model",
                    sort: (r) => r.model,
                    render: (r) => (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                        <Logo name={providerLogoKey(r.provider)} label={r.provider} size={18} />
                        <span>{r.model}</span>
                      </span>
                    ),
                  },
                  { key: "messages", header: "Messages", align: "right", sort: (r) => r.messages, render: (r) => r.messages.toLocaleString() },
                  { key: "spend", header: "Spend", align: "right", sort: (r) => r.spendUsd, render: (r) => `${fmtUsd(r.spendUsd)} · ${pct(r.share)}` },
                ]}
              />
            )}
          </Card>
        </div>
      )}
    </>
  );
}
