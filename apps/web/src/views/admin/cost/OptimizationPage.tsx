/**
 * Optimization (pillar 6) — the savings ledger: estimated savings by
 * technique (cost events), measured actuals from the usage ledger, and the
 * raw event streams with a per-user filter and CSV export.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type { CostEventsResponse } from "../../../api/adminTypes";
import type { UsageEventsResponse } from "../../../api/types";
import { fmtUsd } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Select, Table } from "../../../ui/kit";
import { useToast } from "../../../ui/toast";
import { BarChart, Stat, downloadCsv, optionEls, useNameMaps, useUsers, userOpts } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

export default function OptimizationPage() {
  const users = useUsers();
  const names = useNameMaps();
  const { toast } = useToast();
  const [userId, setUserId] = useState("");

  const cost = useQuery({
    queryKey: ["admin", "cost-events", userId],
    queryFn: () =>
      api.get<CostEventsResponse>(`/v1/cost-events?limit=200${userId ? `&userId=${userId}` : ""}`),
  });
  const usage = useQuery({
    queryKey: ["admin", "usage-events", userId],
    queryFn: () =>
      api.get<UsageEventsResponse>(`/v1/usage-events?limit=100${userId ? `&userId=${userId}` : ""}`),
  });

  const totals = cost.data?.totals ?? [];
  const totalSaved = totals.reduce((acc, t) => acc + (t.estimatedCostSavedUsd ?? 0), 0);
  const totalTokensSaved = totals.reduce((acc, t) => acc + (t.estimatedTokensSaved ?? 0), 0);
  const measured = usage.data?.totals ?? {};

  const costRows = useMemo(
    () => (cost.data?.events ?? []).map((e, i) => ({ ...e, rowKey: e.id ?? `${e.at}-${i}` })),
    [cost.data],
  );
  const usageRows = useMemo(
    () => (usage.data?.events ?? []).map((e, i) => ({ ...e, rowKey: `${e.at}-${i}` })),
    [usage.data],
  );

  return (
    <>
      <PageHeader
        title="Optimization"
        sub="The pillar-6 savings ledger."
        info={<p>The pillar-6 savings ledger: every technique the backend applied on a user's behalf writes an event with its estimated savings; the usage ledger carries the measured actuals.</p>}
      />
      <div className={v.stack}>
        <div className={a.formRow}>
          <Field label="Filter by user">
            <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
              {optionEls(userOpts(users.data?.users), "— all users —")}
            </Select>
          </Field>
          <span className={v.grow} />
          <Button
            size="sm"
            onClick={() =>
              void downloadCsv(
                `/v1/usage-events?format=csv&limit=500${userId ? `&userId=${userId}` : ""}`,
                "usage-events.csv",
                (msg) => toast(msg, "error"),
              )
            }
          >
            Download usage CSV
          </Button>
        </div>

        <div className={v.grid4}>
          <Stat value={fmtUsd(totalSaved)} label="estimated saved (all techniques)" />
          <Stat value={totalTokensSaved.toLocaleString()} label="estimated tokens saved" />
          <Stat value={fmtUsd(measured.measuredCostSavedUsd)} label="measured saved (usage ledger)" />
          <Stat value={fmtUsd(measured.costUsd)} label={`measured spend · ${measured.events ?? 0} calls`} />
        </div>

        <Card title="Savings by technique">
          <BarChart
            items={totals as unknown as Array<Record<string, unknown>>}
            valueKey="estimatedCostSavedUsd"
            label={(i) => String(i.technique)}
            title="Estimated savings by technique"
          />
          <Table
            columns={[
              { key: "technique", header: "Technique", render: (t: (typeof totals)[number]) => t.technique },
              { key: "events", header: "Events", align: "right", render: (t) => t.events },
              {
                key: "tokens",
                header: "Tokens saved",
                align: "right",
                render: (t) => t.estimatedTokensSaved.toLocaleString(),
              },
              {
                key: "usd",
                header: "Est. saved",
                align: "right",
                sort: (t) => t.estimatedCostSavedUsd,
                render: (t) => <span className={v.num}>{fmtUsd(t.estimatedCostSavedUsd)}</span>,
              },
            ]}
            rows={totals}
            rowKey={(t) => t.technique}
            loading={cost.isLoading}
            empty={
              <EmptyState
                title="No savings recorded yet"
                body="Techniques write events as dispatches flow — routing, compaction, caching, edit-vs-rewrite, lazy tool loading, batching."
              />
            }
          />
        </Card>

        <Card title="Cost events — the raw optimization ledger">
          <Table
            columns={[
              {
                key: "at",
                header: "At",
                sort: (e: (typeof costRows)[number]) => e.at,
                render: (e) => <span className={v.mono}>{String(e.at).slice(0, 19).replace("T", " ")}</span>,
              },
              {
                key: "user",
                header: "User",
                render: (e) => names.userName.get(String(e.userId)) ?? "—",
              },
              { key: "technique", header: "Technique", render: (e) => <Badge tone="info">{e.technique}</Badge> },
              {
                key: "tokens",
                header: "Tokens saved",
                align: "right",
                render: (e) => e.estimatedTokensSaved?.toLocaleString() ?? "—",
              },
              {
                key: "usd",
                header: "Est. saved",
                align: "right",
                render: (e) => <span className={v.num}>{fmtUsd(e.estimatedCostSavedUsd)}</span>,
              },
            ]}
            rows={costRows}
            rowKey={(e) => e.rowKey}
            loading={cost.isLoading}
            empty={<EmptyState title="No cost events" />}
          />
        </Card>

        <Card title="Usage events — measured actuals">
          <Table
            columns={[
              {
                key: "at",
                header: "At",
                sort: (e: (typeof usageRows)[number]) => e.at,
                render: (e) => <span className={v.mono}>{String(e.at).slice(0, 19).replace("T", " ")}</span>,
              },
              { key: "object", header: "Object", render: (e) => e.objectType ?? "—" },
              { key: "model", header: "Model", render: (e) => (e.model ? <span className={v.mono}>{e.model}</span> : "—") },
              {
                key: "tokens",
                header: "Tokens in → out",
                align: "right",
                render: (e) => `${e.inputTokens ?? 0} → ${e.outputTokens ?? 0}`,
              },
              {
                key: "cost",
                header: "Cost",
                align: "right",
                sort: (e) => e.costUsd ?? 0,
                render: (e) => <span className={v.num}>{fmtUsd(e.costUsd)}</span>,
              },
              {
                key: "saved",
                header: "Saved",
                align: "right",
                render: (e) => <span className={v.num}>{fmtUsd(e.measuredCostSavedUsd)}</span>,
              },
              {
                key: "attributed",
                header: "Project",
                render: (e) =>
                  e.projectId ? <Badge tone="ok">attributed</Badge> : <Badge tone="warn">unattributed</Badge>,
              },
            ]}
            rows={usageRows}
            rowKey={(e) => e.rowKey}
            loading={usage.isLoading}
            empty={<EmptyState title="No usage events" body="Real dispatches write the measured ledger." />}
          />
        </Card>
      </div>
    </>
  );
}
