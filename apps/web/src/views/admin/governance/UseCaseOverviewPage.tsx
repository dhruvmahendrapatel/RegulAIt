import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api } from "../../../api/client";
import { ago, frameworkLabel, humanize, plural, providerLabel } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table, Tabs, type Tone } from "../../../ui/kit";
import { QueryGate, RemoveButton, useAction } from "../adminKit";
import v from "../../views.module.css";
import s from "./demoGovernance.module.css";
import { DependencyGraphPanel } from "./DependencyGraphPanel";
import { RiskLibraryPicker } from "./RiskLibraryPicker";

interface RiskControl { controlRef: string; title: string; linkedAt: string }
interface OverviewRisk {
  id: string;
  title: string;
  category: string;
  dimension: string;
  status: string;
  inherent: { likelihood: string; impact: string };
  residual: { likelihood: string; impact: string } | null;
  controls: RiskControl[];
}
interface OverviewResponse {
  useCase: { id: string; name: string; description?: string | null; businessContext?: string | null; status: string; euAiActTier?: string | null; ownerName?: string | null; ownerUserId?: string; projectId?: string | null; complianceTags?: string[]; [key: string]: unknown };
  screening: { tier: string | null; reasons: Array<{ ref?: string; reason?: string }>; rulesetVersion: number | null; screened: boolean };
  questionnaire: { submitted: boolean; artifactId: string | null; version: number | null; submittedAt: string | null };
  stack: {
    agents: Array<{ id: string; name: string; provider: string; model: string | null; lifecycleStatus: string; halted: boolean; modelCards: Array<{ id: string; intendedUse: string; signOff: string }>; modelCardApproved: boolean }>;
    vendors: Array<{ id: string; name: string; category: string; status: string; linkedVia: string[] }>;
  };
  risks: OverviewRisk[];
  summary: { risks: number; liveRisks: number; liveWithoutControls: number; agentsWithoutApprovedModelCard: number; pendingApprovals: number };
  approvals: Array<{ id: string; status: string; stageId: string; approverUserId: string | null; requestedAt: string; decidedAt: string | null; decisionReason: string | null }>;
  audit: Array<{ id: string | number; at: string; userId: string | null; ruleId: string; effect: string; reason: string }>;
}
interface FrameworksResponse {
  evidenceScope: { kind: string; projectId: string | null; period: string; periodLabel: string; note: string };
  frameworks: Array<{
    id: string; framework: string; version: number; title: string; cascadeTag: string | null; profileExists: boolean; carriedByUseCase: boolean;
    controls: Array<{ controlRef: string; title: string; coverage: string; attestationRequired: boolean; [key: string]: unknown }>;
    scorecard?: { coveragePct?: number | null; [key: string]: unknown } | null;
  }>;
  disclaimer: string;
}
interface AgentCardResponse {
  agent: { id: string; name: string; provider: string; model: string | null; tier: string; modes: string[]; enabled: boolean; lifecycleStatus: string; halted: boolean; haltedReason: string | null; hasSystemPrompt: boolean };
  owner: { id: string | null; name: string | null; state: string };
  purpose: { intendedUses: string[]; limitations: string[]; source: string };
  dataSources: { declared: Array<{ cardId: string; claims: string[] }>; note: string };
  guardrails: { modes: Record<string, string>; blocksInput: boolean; blocksOutput: boolean; provenance: string[] };
  oversight: { modelCards: number; modelCardApproved: boolean; note: string };
}

const TABS = ["overview", "frameworks", "risks", "stack", "dependencies", "approvals", "audit"].map((id) => ({ id, label: id[0]!.toUpperCase() + id.slice(1) }));
const statusTone = (status: string): Tone => status === "approved" ? "ok" : status === "rejected" ? "danger" : status === "under_review" ? "info" : status === "retired" ? "warn" : "neutral";

export default function UseCaseOverviewPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((item) => item.id === params.get("tab")) ? params.get("tab")! : "overview";
  const overview = useQuery({ queryKey: ["governance", "use-case-overview", id], queryFn: () => api.get<OverviewResponse>(`/v1/use-cases/${id}/overview`), enabled: Boolean(id) });
  const frameworks = useQuery({ queryKey: ["governance", "use-case-frameworks", id], queryFn: () => api.get<FrameworksResponse>(`/v1/use-cases/${id}/frameworks`), enabled: Boolean(id) && tab === "frameworks" });
  const refresh = async () => { await overview.refetch(); };
  const data = overview.data;

  return (
    <>
      <PageHeader title={data?.useCase.name ?? "Use-case workspace"} sub="One governed view of purpose, frameworks, risks, stack, approvals, and audit evidence." />
      <QueryGate loading={overview.isLoading} error={overview.error} onRetry={() => void overview.refetch()}>
        {data ? (
          <div className={v.stack}>
            <Card>
              <div className={s.workspaceHeader}>
                <div><div className={v.row}><Badge tone={statusTone(data.useCase.status)}>{data.useCase.status.replace(/_/g, " ")}</Badge><Badge tone={data.screening.tier === "prohibited" ? "danger" : data.screening.tier === "high" ? "warn" : "info"}>{data.screening.screened ? `${humanize(data.screening.tier)} tier` : "Tier unmeasured"}</Badge></div><p className={v.dim}>{data.useCase.description || "No description recorded."}</p></div>
                <div className={s.workspaceMeta}><span><strong>Owner</strong><br />{data.useCase.ownerName ?? "Unassigned"}</span><span><strong>Questionnaire</strong><br />{data.questionnaire.submitted ? `v${data.questionnaire.version} submitted` : "not submitted"}</span></div>
              </div>
              <div className={v.row}>
                {data.summary.liveRisks === 0
                  ? <Badge tone="neutral">No live risks recorded</Badge>
                  : data.summary.liveWithoutControls > 0
                    ? <Badge tone="danger">{plural(data.summary.liveWithoutControls, "live risk")} without controls</Badge>
                    : <Badge tone="ok">{data.summary.liveRisks === 1 ? "The live risk has controls" : `All ${data.summary.liveRisks} live risks have controls`}</Badge>}
                {data.summary.agentsWithoutApprovedModelCard > 0 ? <Badge tone="warn">{data.summary.agentsWithoutApprovedModelCard === 1 ? "1 agent lacks an approved model card" : `${data.summary.agentsWithoutApprovedModelCard} agents lack approved model cards`}</Badge> : null}
                {data.summary.pendingApprovals > 0 ? <Badge tone="info">{plural(data.summary.pendingApprovals, "pending approval")}</Badge> : null}
              </div>
            </Card>
            <Tabs tabs={TABS} active={tab} onChange={(next) => setParams({ tab: next })} />
            {tab === "overview" ? <OverviewTab data={data} /> : null}
            {tab === "frameworks" ? <FrameworksTab query={frameworks} /> : null}
            {tab === "risks" ? <RisksTab useCaseId={id} risks={data.risks} onRefresh={refresh} /> : null}
            {tab === "stack" ? <StackTab data={data.stack} /> : null}
            {tab === "dependencies" ? <Card title="Dependencies and inherited risk"><DependencyGraphPanel useCaseId={id} /></Card> : null}
            {tab === "approvals" ? <ApprovalsTab approvals={data.approvals} /> : null}
            {tab === "audit" ? <AuditTab rows={data.audit} /> : null}
          </div>
        ) : null}
      </QueryGate>
    </>
  );
}

function OverviewTab({ data }: { data: OverviewResponse }) {
  return (
    <div className={s.dashboardGrid}>
      <Card title="Purpose and context"><div className={v.stack}><p>{String(data.useCase.businessContext || data.useCase.description || "No business context recorded.")}</p><div><strong>Compliance tags</strong><p className={v.row}>{(data.useCase.complianceTags ?? []).length ? (data.useCase.complianceTags ?? []).map((tag) => <Badge key={tag} tone="info">{frameworkLabel(tag)}</Badge>) : <span className={v.dim}>None recorded</span>}</p></div></div></Card>
      <Card title="EU AI Act screening"><div className={v.stack}><p><strong>{data.screening.screened ? `${humanize(data.screening.tier)} risk` : "Unmeasured"}</strong></p>{data.screening.reasons.length ? <ul>{data.screening.reasons.map((reason, index) => <li key={index}>{reason.reason ?? reason.ref}</li>)}</ul> : <p className={v.dim}>No screening reasons recorded.</p>}<p className={v.faint}>{data.screening.rulesetVersion ? `Ruleset v${data.screening.rulesetVersion}` : "No ruleset result"}</p></div></Card>
      <Card title="Governance summary"><div className={v.grid3}><Metric label="Risks" value={data.summary.risks} /><Metric label="Live risks" value={data.summary.liveRisks} /><Metric label="Pending approvals" value={data.summary.pendingApprovals} /></div></Card>
    </div>
  );
}

const COVERAGE_TONE: Record<string, Tone> = { enforced: "ok", evidenced: "info", partial: "warn", unaddressed: "neutral" };

/** a pack title carries its version note after " — v2 …": the card shows the name, the note goes underneath */
const packTitle = (title: string) => title.split(/ — v\d/)[0]!;
const packNote = (title: string) => {
  const m = / — (v\d.*)$/.exec(title);
  return m ? m[1]! : "";
};

/** whether the pack's cascade tag is on the use case — the tag that turns the mapping into enforced workflow consequences */
function CascadeBadge({ framework }: { framework: FrameworksResponse["frameworks"][number] }) {
  if (!framework.cascadeTag) return <Badge tone="neutral" title="This pack maps controls only; it has no cascade tag">Mapping only</Badge>;
  return framework.carriedByUseCase
    ? <Badge tone="ok" title={`The use case carries ${framework.cascadeTag}, so its workflow consequences apply`}>Cascade applied</Badge>
    : <Badge tone="warn" title={`Add the ${framework.cascadeTag} tag to apply this pack's workflow consequences${framework.profileExists ? "" : " (no compliance profile exists for it yet)"}`}>Cascade not applied</Badge>;
}

function FrameworksTab({ query }: { query: ReturnType<typeof useQuery<FrameworksResponse>> }) {
  return <QueryGate loading={query.isLoading} error={query.error} onRetry={() => void query.refetch()}>{query.data ? <div className={v.stack}><p className={s.callout}>{query.data.evidenceScope.note}</p>{query.data.frameworks.length === 0 ? <EmptyState title="No active framework mappings" /> : query.data.frameworks.map((framework) => <Card key={framework.id} title={`${packTitle(framework.title)} · v${framework.version}`} actions={<CascadeBadge framework={framework} />}><div className={v.stack}><p className={v.faint}>{plural(framework.controls.length, "mapped control")}{packNote(framework.title) ? ` · ${packNote(framework.title)}` : ""}</p><Table rows={framework.controls} rowKey={(control) => control.controlRef} columns={[{ key: "control", header: "Control", render: (control) => <code style={{ whiteSpace: "nowrap" }}>{control.controlRef}</code> }, { key: "title", header: "Title", render: (control) => control.title }, { key: "coverage", header: "Platform coverage", render: (control) => <Badge tone={COVERAGE_TONE[control.coverage] ?? "neutral"}>{humanize(control.coverage)}</Badge> }]} /></div></Card>)}<p className={v.faint}>{query.data.disclaimer}</p></div> : null}</QueryGate>;
}

function RisksTab({ useCaseId, risks, onRefresh }: { useCaseId: string; risks: OverviewRisk[]; onRefresh: () => Promise<void> }) {
  const action = useAction();
  const [controlRefs, setControlRefs] = useState<Record<string, string>>({});
  const [residuals, setResiduals] = useState<Record<string, { likelihood: string; impact: string }>>({});
  return (
    <div className={v.stack}>
      <RiskLibraryPicker useCaseId={useCaseId} onAdded={() => void onRefresh()} />
      {risks.length === 0 ? <EmptyState title="No risks linked to this use case" body="Add a scenario from the library to make the inherent and residual position explicit." /> : risks.map((risk) => {
        const draft = residuals[risk.id] ?? { likelihood: risk.residual?.likelihood ?? "", impact: risk.residual?.impact ?? "" };
        return <Card key={risk.id} title={risk.title} actions={<div className={v.row}><Badge tone="neutral">{risk.dimension}</Badge><Badge tone={risk.status === "closed" ? "ok" : "warn"}>{risk.status}</Badge></div>}><div className={v.stack}>
          <div className={s.riskFlow}><span><strong>Inherent</strong><br />{risk.inherent.likelihood} × {risk.inherent.impact}</span><span aria-hidden>→</span><span><strong>Residual</strong><br />{risk.residual ? `${risk.residual.likelihood} × ${risk.residual.impact}` : "unmeasured"}</span></div>
          <div><strong>Linked controls</strong>{risk.controls.length === 0 ? <p className={v.dim}>No controls linked.</p> : risk.controls.map((control) => <div key={control.controlRef} className={v.listRow}><span className={v.grow}><code>{control.controlRef}</code><br /><span className={v.faint}>{control.title}</span></span><RemoveButton what={`control ${control.controlRef}`} consequence={<>The control link is removed from this risk. The risk and its audit history remain.</>} onRemove={() => api.del(`/v1/risks/${risk.id}/controls/${encodeURIComponent(control.controlRef)}`)} onDone={() => void onRefresh()} /></div>)}</div>
          <div className={s.libraryFilters}><Field label="Control reference"><Input value={controlRefs[risk.id] ?? ""} onChange={(event) => setControlRefs((current) => ({ ...current, [risk.id]: event.target.value }))} placeholder="eu-ai-act:art-14-human-oversight" /></Field><Field label=" "><Button disabled={action.busy || !(controlRefs[risk.id] ?? "").trim()} onClick={() => void action.run(async () => { await api.post(`/v1/risks/${risk.id}/controls`, { controlRef: controlRefs[risk.id]!.trim() }); setControlRefs((current) => ({ ...current, [risk.id]: "" })); await onRefresh(); }, "Control linked")}>Link control</Button></Field></div>
          <div className={s.libraryFilters}><Field label="Residual likelihood"><Select value={draft.likelihood} onChange={(event) => setResiduals((current) => ({ ...current, [risk.id]: { ...draft, likelihood: event.target.value } }))}><option value="">Choose likelihood</option><option>low</option><option>medium</option><option>high</option></Select></Field><Field label="Residual impact"><Select value={draft.impact} onChange={(event) => setResiduals((current) => ({ ...current, [risk.id]: { ...draft, impact: event.target.value } }))}><option value="">Choose impact</option><option>low</option><option>medium</option><option>high</option></Select></Field><Field label=" "><Button disabled={action.busy || !draft.likelihood || !draft.impact} onClick={() => void action.run(async () => { await api.put(`/v1/risks/${risk.id}/residual`, draft); await onRefresh(); }, "Residual position updated")}>Save residual</Button></Field></div>
        </div></Card>;
      })}
    </div>
  );
}

function StackTab({ data }: { data: OverviewResponse["stack"] }) {
  return <div className={v.stack}><Card title="Agents">{data.agents.length === 0 ? <EmptyState title="No intended agents linked" body="The intake records the agent this use case will run on. Choose one at the stack step of the intake, or link it from the agent inventory." /> : data.agents.map((agent) => <AgentCard key={agent.id} id={agent.id} fallback={agent} />)}</Card><Card title="Vendors">{data.vendors.length === 0 ? <EmptyState title="No vendors resolved from this stack" /> : data.vendors.map((vendor) => <div key={vendor.id} className={v.listRow}><span className={v.grow}><strong>{vendor.name}</strong><br /><span className={v.faint}>{humanize(vendor.category)} · via {vendor.linkedVia.join(", ")}</span></span><Badge tone={vendor.status === "approved" ? "ok" : "warn"}>{vendor.status}</Badge></div>)}</Card></div>;
}

function AgentCard({ id, fallback }: { id: string; fallback: OverviewResponse["stack"]["agents"][number] }) {
  const card = useQuery({ queryKey: ["governance", "agent-card", id], queryFn: () => api.get<AgentCardResponse>(`/v1/agents/${id}/card`) });
  return (
    <div id={`agent-${id}`} className={s.agentCard}>
      <div className={v.row}>
        <strong>{fallback.name}</strong>
        <Badge tone={fallback.halted ? "danger" : "ok"}>{fallback.halted ? "Halted" : humanize(fallback.lifecycleStatus)}</Badge>
        <Badge tone={fallback.modelCardApproved ? "ok" : "warn"}>{fallback.modelCardApproved ? "Model card approved" : "No approved model card"}</Badge>
      </div>
      {card.isError ? <p className={v.errLine}>Agent card could not be loaded: {(card.error as Error).message}</p> : card.data ? (
        <div className={v.stack}>
          <p className={v.dim}>
            {providerLabel(card.data.agent.provider)} · {card.data.agent.model ?? "default model"} · Owner: {card.data.owner.name ?? (card.data.owner.state === "unowned" ? "unassigned" : humanize(card.data.owner.state))}
          </p>
          <div><strong>Declared purpose</strong><ul>{card.data.purpose.intendedUses.map((use) => <li key={use}>{use}</li>)}</ul></div>
          <div>
            <strong>Model cards</strong>
            {fallback.modelCards.length ? (
              <ul>{fallback.modelCards.map((modelCard) => <li key={modelCard.id}>{modelCard.intendedUse && !card.data!.purpose.intendedUses.includes(modelCard.intendedUse) ? `${modelCard.intendedUse} · ` : ""}Sign-off: <Badge tone={modelCard.signOff === "approved" ? "ok" : "warn"}>{modelCard.signOff === "none" ? "Not signed off" : humanize(modelCard.signOff)}</Badge></li>)}</ul>
            ) : <p className={v.dim}>No model card is linked to this agent.</p>}
          </div>
          <p className={v.faint}>{sentenceCase(card.data.dataSources.note)}</p>
          <p className={v.faint}>{sentenceCase(card.data.oversight.note)}</p>
          <Link to={`/admin/agents#agent-${id}`}>Open this agent in the full inventory</Link>
        </div>
      ) : <p className={v.dim}>Loading agent card…</p>}
    </div>
  );
}

const sentenceCase = (text: string) => (text ? `${text.charAt(0).toUpperCase()}${text.slice(1).replace(/\.$/, "")}.` : text);

function ApprovalsTab({ approvals }: { approvals: OverviewResponse["approvals"] }) {
  return <Card title="Approval history">{approvals.length === 0 ? <EmptyState title="No approval records yet" body="Approval requests appear after the intake questionnaire is submitted." /> : <Table rows={approvals} rowKey={(row) => row.id} columns={[{ key: "stage", header: "Stage", render: (row) => humanize(row.stageId) }, { key: "status", header: "Status", render: (row) => <Badge tone={row.status === "approved" ? "ok" : row.status === "rejected" ? "danger" : "info"}>{row.status}</Badge> }, { key: "requested", header: "Requested", render: (row) => <span style={{ whiteSpace: "nowrap" }}>{ago(row.requestedAt)}</span> }, { key: "reason", header: "Decision reason", render: (row) => row.decisionReason ?? "—" }]} />}</Card>;
}

function AuditTab({ rows }: { rows: OverviewResponse["audit"] }) {
  return <Card title="Recent use-case audit evidence">{rows.length === 0 ? <EmptyState title="No audit rows returned" /> : <Table rows={rows} rowKey={(row) => String(row.id)} columns={[{ key: "at", header: "When", render: (row) => <span style={{ whiteSpace: "nowrap" }}>{ago(row.at)}</span> }, { key: "rule", header: "Event", render: (row) => <span style={{ whiteSpace: "nowrap" }}>{humanize(row.ruleId)}</span> }, { key: "effect", header: "Effect", render: (row) => <Badge tone={row.effect === "allow" ? "ok" : row.effect === "deny" ? "danger" : "warn"}>{row.effect}</Badge> }, { key: "reason", header: "Reason", render: (row) => row.reason }]} />}<p><Link to="/admin/audit">Open the full audit log</Link></p></Card>;
}

function Metric({ label, value }: { label: string; value: number }) { return <div className={v.stat}><span className={v.statValue}>{value}</span><span className={v.statLabel}>{label}</span></div>; }
