/**
 * ADR-0172 — builder Agents: every agent the person can see (their own, shared
 * with the workspace or with them by name), as cards or a list, with a New
 * agent dialog, "start from a template" and import of an exported bundle.
 */
import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ago, fmtUsd, plural } from "../../api/format";
import type { BuilderAgentSummary, BuilderSharing } from "../../api/types";
import { PageHeader } from "../../shell/AppShell";
import { Badge, Button, EmptyState, ErrorState, Input, Meter, SkeletonBlock, Table, type Tone } from "../../ui/kit";
import { useAgents } from "./builderApi";
import { spendState } from "./builderLogic";
import { AgentAvatar, Icon, ModelChip, NewAgentDialog, Segmented, useImportBundle } from "./BuilderUi";
import s from "./builder.module.css";

const SHARING: Record<BuilderSharing, { label: string; tone: Tone }> = {
  private: { label: "Private", tone: "neutral" },
  workspace: { label: "Workspace", tone: "primary" },
  people: { label: "Shared", tone: "info" },
};

export function SharingBadge(props: { sharing: BuilderSharing }) {
  const v = SHARING[props.sharing] ?? SHARING.private;
  return <Badge tone={v.tone}>{v.label}</Badge>;
}

function SpendLine(props: { agent: BuilderAgentSummary }) {
  const { agent } = props;
  const state = spendState(agent.spentThisMonthUsd, agent.monthlyLimitUsd);
  return (
    <>
      <div className={s.spendRow}>
        <span>This month</span>
        <span>
          {fmtUsd(agent.spentThisMonthUsd)}
          {agent.monthlyLimitUsd != null ? ` of ${fmtUsd(agent.monthlyLimitUsd)}` : " · no limit"}
        </span>
      </div>
      {agent.monthlyLimitUsd != null && (
        <Meter value={agent.spentThisMonthUsd} max={agent.monthlyLimitUsd} warn={state === "warn"} over={state === "over"} label={`${agent.name} spend against its monthly limit`} />
      )}
    </>
  );
}

export default function BuilderAgentsPage() {
  const agents = useAgents();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  // local state answers the radio at once; the URL keeps the choice for a reload
  const [view, setView] = useState<"grid" | "list">(params.get("view") === "list" ? "list" : "grid");
  const [query, setQuery] = useState("");
  const [newOpen, setNewOpen] = useState(params.get("new") === "1");
  const closeNew = useCallback(() => setNewOpen(false), []);
  const importer = useImportBundle();

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = agents.data?.agents ?? [];
    return q ? all.filter((a) => a.name.toLowerCase().includes(q) || (a.description ?? "").toLowerCase().includes(q)) : all;
  }, [agents.data, query]);

  return (
    <>
      <PageHeader
        title="Your agents"
        crumbs={["Agent builder"]}
        sub="Agents you own, and agents shared with you."
        actions={
          <div className={s.toolbar} style={{ margin: 0 }}>
            <Button onClick={importer.open} disabled={importer.busy}>
              {Icon.upload()} {importer.busy ? "Importing…" : "Import"}
            </Button>
            <Button onClick={() => navigate("/builder/templates")}>Start from a template</Button>
            <Button variant="primary" onClick={() => setNewOpen(true)}>
              {Icon.plus()} New agent
            </Button>
          </div>
        }
      />
      {importer.input}
      <div className={s.toolbar}>
        <Input className={s.search} type="search" aria-label="Search agents" placeholder="Search agents" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span style={{ flex: 1 }} />
        <Segmented
          label="Layout"
          value={view}
          onChange={(v) => {
            setView(v);
            const p = new URLSearchParams(params);
            if (v === "list") p.set("view", "list");
            else p.delete("view");
            setParams(p, { replace: true });
          }}
          options={[
            { value: "grid", label: <>{Icon.grid(14)} Cards</> },
            { value: "list", label: <>{Icon.list(14)} List</> },
          ]}
        />
      </div>

      {agents.isLoading ? (
        <div className={s.glass} style={{ padding: 24 }}>
          <SkeletonBlock lines={4} />
        </div>
      ) : agents.isError ? (
        <div className={s.glass}>
          <ErrorState title="Couldn't load agents" message={(agents.error as Error).message} onRetry={() => void agents.refetch()} />
        </div>
      ) : list.length === 0 ? (
        <div className={s.glass}>
          {query ? (
            <EmptyState title="No matching agents" body="Try a different search." />
          ) : (
            <EmptyState
              title="No agents yet"
              body="Create an agent from scratch, start from a template, or import one someone exported."
              action={
                <Button variant="primary" onClick={() => setNewOpen(true)}>
                  New agent
                </Button>
              }
            />
          )}
        </div>
      ) : view === "grid" ? (
        <ul className={s.agentGrid} aria-label="Agents" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {list.map((a) => (
            <li key={a.id} style={{ display: "flex" }}>
              <Link to={`/builder/agents/${a.id}`} className={`${s.glass} ${s.agentCard}`} style={{ flex: 1 }} aria-label={`Open ${a.name}`}>
                <div className={s.agentHead}>
                  <AgentAvatar name={a.name} color={a.color} size={40} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h2 className={s.agentName}>{a.name}</h2>
                    <div className={s.small}>
                      {a.ownerName ?? "Unknown owner"} · updated {ago(a.updatedAt)}
                    </div>
                  </div>
                  <SharingBadge sharing={a.sharing} />
                </div>
                <p className={`${s.muted} ${s.clamp2}`} style={{ margin: 0, minHeight: "3em" }}>
                  {a.description || "No description yet."}
                </p>
                <div className={s.agentFacts}>
                  <ModelChip model={a.modelAgent} />
                  <span className={s.dot} aria-hidden />
                  <span>{plural(a.toolCount, "tool")}</span>
                  <span className={s.dot} aria-hidden />
                  <span>{plural(a.skillCount, "skill")}</span>
                  {a.scheduleCount > 0 && (
                    <>
                      <span className={s.dot} aria-hidden />
                      <span>{a.scheduleCount} scheduled</span>
                    </>
                  )}
                </div>
                <div className={s.agentFoot}>
                  <SpendLine agent={a} />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className={s.glass} style={{ overflow: "hidden" }}>
          <Table<BuilderAgentSummary>
            rows={list}
            rowKey={(a) => a.id}
            onRowClick={(a) => navigate(`/builder/agents/${a.id}`)}
            rowLabel={(a) => `Open ${a.name}`}
            columns={[
              {
                key: "name",
                header: "Agent",
                sort: (a) => a.name.toLowerCase(),
                render: (a) => (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                    <AgentAvatar name={a.name} color={a.color} size={28} />
                    <strong>{a.name}</strong>
                  </span>
                ),
              },
              { key: "model", header: "Model", render: (a) => <ModelChip model={a.modelAgent} /> },
              { key: "sharing", header: "Sharing", render: (a) => <SharingBadge sharing={a.sharing} /> },
              { key: "owner", header: "Owner", render: (a) => a.ownerName ?? "—" },
              {
                key: "spend",
                header: "This month",
                align: "right",
                sort: (a) => a.spentThisMonthUsd,
                render: (a) => `${fmtUsd(a.spentThisMonthUsd)}${a.monthlyLimitUsd != null ? ` / ${fmtUsd(a.monthlyLimitUsd)}` : ""}`,
              },
              { key: "updated", header: "Updated", sort: (a) => a.updatedAt, render: (a) => ago(a.updatedAt) },
            ]}
          />
        </div>
      )}
      <NewAgentDialog open={newOpen} onClose={closeNew} />
    </>
  );
}
