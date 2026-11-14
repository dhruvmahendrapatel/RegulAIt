/**
 * Optimization (pillar 6) — the savings ledger: estimated savings by
 * technique (cost events), measured actuals from the usage ledger, and the
 * raw event streams with a per-user filter and CSV export.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type { CostEvent, CostEventsResponse } from "../../../api/adminTypes";
import { DataList, type DataColumn } from "../../../ui/DataList";
import type { UsageEventsResponse } from "../../../api/types";
import { fmtUsd } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Select, Table } from "../../../ui/kit";
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
      // only the totals are read here (the events are the list below), and they cover every row whatever the limit
      api.get<UsageEventsResponse>(`/v1/usage-events?limit=1${userId ? `&userId=${userId}` : ""}`),
  });

  const totals = cost.data?.totals ?? [];
  const totalSaved = totals.reduce((acc, t) => acc + (t.estimatedCostSavedUsd ?? 0), 0);
  const totalTokensSaved = totals.reduce((acc, t) => acc + (t.estimatedTokensSaved ?? 0), 0);
  const measured = usage.data?.totals ?? {};

  const costFilters = useMemo(() => ({ userId: userId || undefined }), [userId]);
  const usageFilters = useMemo(() => ({ userId: userId || undefined }), [userId]);
  const unattributed = usage.data?.totals?.unattributed ?? 0;
  const refused = usage.data?.totals?.refused ?? 0;
  const usageAttention =
    unattributed > 0 || refused > 0 ? (
      <>
        {unattributed > 0 && <Badge tone="warn">{unattributed} unattributed</Badge>}
        {refused > 0 && <Badge tone="danger">{refused} refused</Badge>}
      </>
    ) : undefined;

  return (
    <>
      <PageHeader
        title="Optimization"
        sub="The savings ledger."
        info={<p>The savings ledger: every technique the backend applied on a user's behalf writes an event with its estimated savings; the usage ledger carries the measured actuals.</p>}
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
            error={cost.error}
            onRetry={() => void cost.refetch()}
            empty={
              <EmptyState
                title="No savings recorded yet"
                body="Techniques write events as dispatches flow — routing, compaction, caching, edit-vs-rewrite, lazy tool loading, batching."
              />
            }
          />
        </Card>

        <Card title="Cost events — the raw optimization ledger" contain>
          <DataList<CostEvent & { userName?: string | null }>
            listId="cost-events"
            noun="cost events"
            endpoint="/v1/cost-events"
            exportPath="/v1/cost-events/export.xlsx"
            queryKey={["admin", "cost-events", "list"]}
            legacyKey="events"
            count="estimate"
            filters={costFilters}
            defaultSort={{ key: "at", dir: "desc" }}
            rowKey={(e) => String(e.id)}
            empty={<EmptyState title="No cost events" />}
            columns={[
              { key: "at", header: "At", main: true, sortable: true, render: (e) => <span className={v.mono}>{String(e.at).slice(0, 19).replace("T", " ")}</span> },
              { key: "user", header: "User", main: true, sortable: true, render: (e) => e.userName ?? names.userName.get(String(e.userId)) ?? "—" },
              { key: "technique", header: "Technique", main: true, sortable: true, render: (e) => <Badge tone="info">{e.technique}</Badge> },
              { key: "tokens", header: "Tokens saved", main: true, sortable: true, align: "right", render: (e) => e.estimatedTokensSaved?.toLocaleString() ?? "—" },
              { key: "usd", header: "Est. saved", main: true, sortable: true, align: "right", render: (e) => <span className={v.num}>{fmtUsd(e.estimatedCostSavedUsd)}</span> },
              { key: "object", header: "Object", sortable: true, render: (e) => String((e as { objectType?: string }).objectType ?? "—") },
              { key: "basis", header: "Estimation basis", sortable: true, render: (e) => String((e as { estimationBasis?: string }).estimationBasis ?? "—") },
            ]}
          />
        </Card>

        {/* the folded header cannot count what the totals read could not see: the failure is said outside the fold */}
        {usage.isError && (
          <ErrorState
            title="Couldn't load the usage totals"
            message="Unattributed and refused calls are not counted while the totals are unavailable. Open the usage events to see each event."
            onRetry={() => void usage.refetch()}
          />
        )}

        {/* A secondary section, so it starts folded (X6b) with the Inbox's "Recently decided" opt-in: `listControl` lets
            it fold over the list's own controls, and the list is read only once the section is opened. The count and
            the flags come from the totals read above, which covers every row, so the header never says 0 for unknown
            and unattributed or refused calls stay in view while it is folded. A failed list read shows the list's
            ErrorState with Retry, which keeps the section open */}
        <Card
          title="Usage events — measured actuals"
          contain
          foldable
          listControl
          startCollapsed
          count={usage.data?.totals?.events ?? null}
          countNoun={["event", "events"]}
          attention={usageAttention}
        >
          {/* ADR-0226: every event, paged, sorted and exported by the server under the same per-user filter */}
          <DataList<UsageRow>
            listId="usage-events"
            noun="usage events"
            endpoint="/v1/usage-events"
            exportPath="/v1/usage-events/export.xlsx"
            queryKey={["admin", "usage-events", "list"]}
            legacyKey="events"
            count="estimate"
            filters={usageFilters}
            defaultSort={{ key: "at", dir: "desc" }}
            rowKey={(e) => e.id}
            columns={USAGE_COLUMNS}
            empty={<EmptyState title="No usage events" body="Real dispatches write the measured ledger." />}
          />
        </Card>
      </div>
    </>
  );
}

type UsageRow = NonNullable<UsageEventsResponse["events"]>[number] & { id: string; userName?: string | null; agentName?: string | null; projectName?: string | null };
/** ADR-0226: the usage ledger's columns; the ids and sortable ones match the gateway's USAGE_EVENTS_LIST */
const USAGE_COLUMNS: Array<DataColumn<UsageRow>> = [
  { key: "at", header: "At", main: true, sortable: true, render: (e) => <span className={v.mono}>{String(e.at).slice(0, 19).replace("T", " ")}</span> },
  { key: "object", header: "Object", main: true, sortable: true, render: (e) => e.objectType ?? "—" },
  { key: "model", header: "Model", main: true, sortable: true, render: (e) => (e.model ? <span className={v.mono}>{e.model}</span> : "—") },
  { key: "tokens", header: "Tokens in → out", main: true, sortable: true, align: "right", render: (e) => `${e.inputTokens ?? 0} → ${e.outputTokens ?? 0}` },
  { key: "cost", header: "Cost", main: true, sortable: true, align: "right", render: (e) => <span className={v.num}>{fmtUsd(e.costUsd)}</span> },
  { key: "saved", header: "Saved", main: true, sortable: true, align: "right", render: (e) => <span className={v.num}>{fmtUsd(e.measuredCostSavedUsd)}</span> },
  {
    key: "project",
    header: "Project",
    main: true,
    sortable: true,
    required: "Unattributed spend is always shown",
    // the column sorts by project name, so the cell shows the name; unattributed spend keeps its warning badge
    render: (e) => (e.projectId ? (e.projectName ?? e.projectId) : <Badge tone="warn">unattributed</Badge>),
  },
  { key: "user", header: "User", sortable: true, render: (e) => e.userName ?? "—" },
  { key: "agent", header: "Agent", sortable: true, render: (e) => e.agentName ?? "—" },
  { key: "refusal", header: "Refused", render: (e) => (e.refusal ? <Badge tone="danger">refused</Badge> : "—") },
];
