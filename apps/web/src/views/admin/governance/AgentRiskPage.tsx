/**
 * ADR-0339 — Agent risk: every agent ranked by its newest risk score, and the agents whose owner is missing, gone or
 * inactive.
 *
 *  - The ranked list reads the stored scores (newest per agent). Agents not scored yet are counted, never shown as low.
 *  - "Recompute now" runs the same sweep the scheduler runs, for every agent waiting to be scored; audited per score.
 *  - Ownership findings use the shared list control (server-side sort, filter, paging and Excel download).
 *  - Each agent opens its own page: the live score with every factor, combination and fix, its history, and who wrote,
 *    owns and runs it.
 *
 * The score is an estimate for ranking, not a certification; the page says so where it shows a number.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago, plural } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { DataList } from "../../../ui/DataList";
import { Badge, Button, Card, EmptyState, Field, Select, TabPanel, Tabs, Table } from "../../../ui/kit";
import { RefusalNotice } from "../../../ui/RefusalNotice";
import { useAction, useUsers } from "../adminKit";
import {
  BAND_LABEL,
  BAND_TONE,
  detailPath,
  FLAG_LABEL,
  FLAG_TONE,
  KIND_LABEL,
  rankedUrl,
  sweepSentence,
  type OwnershipFinding,
  type OwnershipFlag,
  type RankedAgent,
  type RankedPage,
  type SubjectKind,
  type SweepResult,
} from "./agentRiskModel";
import v from "../../views.module.css";

const TABS = (Object.keys(KIND_LABEL) as SubjectKind[]).map((id) => ({ id, label: KIND_LABEL[id] }));

export default function AgentRiskPage() {
  const [kind, setKind] = useState<SubjectKind>("agent");
  const act = useAction();
  // the sweep's own counts become the toast ("Recompute finished: 12 scored, 2 changed band or score.")
  const recompute = () => void act.run(async () => sweepSentence(await api.post<SweepResult>("/v1/agent-risk/recompute", {})));

  return (
    <>
      <PageHeader
        title="Agent risk"
        sub="Every agent ranked by how much harm it could do, and the agents nobody answers for."
        info={
          <p>
            Each agent is scored from 0 to 100 from what it can reach, how it is guarded and tested, and who owns it. A
            score is recalculated whenever any of that changes. It is an estimate for deciding what to fix first, not a
            certification. Open an agent to see every factor, the dangerous combinations it holds and the fixes ranked.
          </p>
        }
        actions={
          <Button variant="primary" aria-disabled={act.busy || undefined} onClick={() => !act.busy && recompute()}>
            {act.busy ? "Recomputing…" : "Recompute now"}
          </Button>
        }
      />
      <div className={v.stack}>
        {act.error && (
          <div className={v.errLine} role="alert">
            {act.error}
          </div>
        )}
        <RefusalNotice guidance={act.guidance} />
        <Tabs tabs={TABS} active={kind} onChange={(id) => setKind(id as SubjectKind)} idPrefix="agent-risk" label="Agent kind" />
        {TABS.map((t) => (
          <TabPanel key={t.id} idPrefix="agent-risk" id={t.id} active={kind} lazy className={v.stack}>
            <RankedCard kind={t.id} />
            <FindingsCard kind={t.id} />
          </TabPanel>
        ))}
      </div>
    </>
  );
}

function RankedCard({ kind }: { kind: SubjectKind }) {
  const list = useInfiniteQuery({
    queryKey: ["admin", "agent-risk", "ranked", kind],
    queryFn: ({ pageParam }) => api.get<RankedPage>(rankedUrl(kind, pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items);
  const unscored = list.data?.pages[0]?.unscored ?? 0;
  return (
    <Card title="Ranked by risk" count={rows?.length}>
      {unscored > 0 ? (
        <p className={v.hint}>
          {plural(unscored, "agent is", "agents are")} not scored yet, so {unscored === 1 ? "it is" : "they are"} not listed. Recompute to score{" "}
          {unscored === 1 ? "it" : "them"}.
        </p>
      ) : null}
      <Table<RankedAgent>
        rows={rows}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => void list.refetch()}
        rowKey={(r) => r.id}
        empty={<EmptyState title="No agent scored yet" body="Recompute now to score every agent of this kind." />}
        columns={[
          { key: "name", header: "Agent", render: (r) => <Link to={detailPath(kind, r.id)}>{r.name}</Link> },
          {
            key: "score",
            header: "Risk",
            render: (r) => (
              <>
                <Badge tone={BAND_TONE[r.band]}>{BAND_LABEL[r.band]}</Badge> <span className={v.num}>{r.score}</span>
                <span className={v.faint}> / 100</span>
              </>
            ),
          },
          { key: "at", header: "Scored", render: (r) => ago(r.computedAt) },
        ]}
      />
      {list.hasNextPage ? (
        <div className={v.row}>
          <Button aria-disabled={list.isFetchingNextPage || undefined} onClick={() => !list.isFetchingNextPage && void list.fetchNextPage()}>
            {list.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function FindingsCard({ kind }: { kind: SubjectKind }) {
  const [flag, setFlag] = useState<"" | Exclude<OwnershipFlag, "owned">>("");
  const users = useUsers();
  const userName = (id: string | null) => (id ? (users.data?.users.find((u) => u.id === id)?.displayName ?? "A former user") : "—");
  return (
    <Card
      title="Ownership findings"
      info={<p>Agents with no owner, whose owner's account is gone or disabled, or whose owner has not been active for 90 days. Give each one a current owner.</p>}
    >
      <div className={v.row}>
        <Field label="Show">
          <Select value={flag} onChange={(e) => setFlag(e.target.value as typeof flag)}>
            <option value="">Every finding</option>
            <option value="unowned">{FLAG_LABEL.unowned}</option>
            <option value="orphaned">{FLAG_LABEL.orphaned}</option>
            <option value="inactive">{FLAG_LABEL.inactive}</option>
          </Select>
        </Field>
      </div>
      <DataList<OwnershipFinding>
        listId={`agent-ownership-findings-${kind}`}
        noun="findings"
        endpoint="/v1/agent-identity/ownership-findings"
        exportPath="/v1/agent-identity/ownership-findings/export.xlsx"
        queryKey={["admin", "agent-identity", "ownership-findings", kind]}
        legacyKey="items"
        filters={{ kind, flag: flag || undefined }}
        defaultSort={{ key: "name", dir: "asc" }}
        rowKey={(r) => r.id}
        empty={<EmptyState title="Every agent has an active owner" body="Nothing to follow up here." />}
        columns={[
          { key: "name", header: "Agent", sortable: true, main: true, render: (r) => <Link to={detailPath(kind, r.id)}>{r.name}</Link> },
          { key: "flag", header: "Ownership", sortable: true, main: true, required: "the finding itself", render: (r) => <Badge tone={FLAG_TONE[r.flag]}>{FLAG_LABEL[r.flag]}</Badge> },
          { key: "owner", header: "Owner", main: true, render: (r) => userName(r.ownerUserId) },
          { key: "lastActive", header: "Owner last active", main: true, render: (r) => ago(r.ownerLastActiveAt) },
        ]}
      />
    </Card>
  );
}
