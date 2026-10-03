import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api } from "../../../api/client";
import type { DirectoryUser, UseCaseCondition, UseCaseLifecycleDetail, UseCaseResubmission, UseCaseReview, UseCaseRiskAcceptance } from "../../../api/types";
import { ago, frameworkLabel, humanize, plural, providerLabel } from "../../../api/format";
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select, Table, Tabs, Textarea, type Tone } from "../../../ui/kit";
import { QueryGate, RemoveButton, useAction } from "../adminKit";
import v from "../../views.module.css";
import s from "./demoGovernance.module.css";
import rec from "./record.module.css";
import rr from "./recordRound.module.css";
import { resubmitPath } from "./registryModel";
import { DependencyGraphPanel } from "./DependencyGraphPanel";
import { RiskLibraryPicker } from "./RiskLibraryPicker";
import { AgentStewardshipLine } from "../integrations/AgentStewardship";
import type { AgentStewardship } from "../integrations/agentStewardship";
import {
  ACTIVITY_STATUS,
  PHASES,
  STATUS_TONE,
  canMarkMet,
  conditionState,
  deriveActivities,
  phaseFor,
  reReviewText,
  shortDate,
  statusLabel,
  type Activity,
  type OverviewResponse,
  type OverviewRisk,
} from "./useCaseLifecycle";

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
  stewardship?: AgentStewardship;
  purpose: { intendedUses: string[]; limitations: string[]; source: string };
  dataSources: { declared: Array<{ cardId: string; claims: string[] }>; note: string };
  guardrails: { modes: Record<string, string>; blocksInput: boolean; blocksOutput: boolean; provenance: string[] };
  oversight: { modelCards: number; modelCardApproved: boolean; note: string };
}

const TABS = ["overview", "frameworks", "risks", "stack", "dependencies", "approvals", "audit"].map((id) => ({ id, label: id[0]!.toUpperCase() + id.slice(1) }));

export default function UseCaseOverviewPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((item) => item.id === params.get("tab")) ? params.get("tab")! : "overview";
  const overview = useQuery({ queryKey: ["governance", "use-case-overview", id], queryFn: () => api.get<OverviewResponse>(`/v1/use-cases/${id}/overview`), enabled: Boolean(id) });
  // the approval's lifetime and its conditions ride on the use-case detail read
  const detail = useQuery({ queryKey: ["governance", "use-case-detail", id], queryFn: () => api.get<UseCaseLifecycleDetail>(`/v1/use-cases/${id}`), enabled: Boolean(id) });
  const frameworks = useQuery({ queryKey: ["governance", "use-case-frameworks", id], queryFn: () => api.get<FrameworksResponse>(`/v1/use-cases/${id}/frameworks`), enabled: Boolean(id) && tab === "frameworks" });
  const directory = useQuery({ queryKey: ["directory"], queryFn: () => api.get<{ users: DirectoryUser[] }>("/v1/users/directory") });
  const refresh = async () => { await Promise.all([overview.refetch(), detail.refetch()]); };
  const data = overview.data;
  const names = new Map((directory.data?.users ?? []).map((u) => [u.id, u.name ?? ""]));
  const userName = (userId: string | null) => (userId ? names.get(userId) || null : null);

  const lifecycle = detail.data?.useCase;
  const status = (lifecycle?.status as string | undefined) ?? data?.useCase.status ?? "";
  const approvedUntil = lifecycle?.approvedUntil ?? data?.useCase.approvedUntil ?? null;
  const expired = Boolean(lifecycle?.approvalExpired);
  const conditions = detail.data?.conditions ?? [];
  const openBlocking = conditions.filter((c) => c.status === "open" && c.blocking).length;
  const recertification = lifecycle?.recertification ? { dueAt: lifecycle.recertificationDueAt ?? approvedUntil } : null;
  const resubmission = status === "needs_info" && detail.data?.resubmission?.allowed ? detail.data.resubmission : null;
  const acceptance = new Map((detail.data?.risks ?? []).filter((risk) => risk.acceptedByName || risk.acceptedAt).map((risk) => [risk.id, risk]));

  return (
    <QueryGate loading={overview.isLoading} error={overview.error} onRetry={() => void overview.refetch()}>
      {data ? (
        <>
          <header className={rec.band}>
            <div className={rec.bandMain}>
              <nav aria-label="Breadcrumb">
                <ol className={rec.crumbs}>
                  <li><Link to="/admin/use-cases">AI use cases</Link></li>
                  <li aria-current="page">{data.useCase.name}</li>
                </ol>
              </nav>
              <div className={rec.titleRow}>
                <span className={rec.typeTag}>AI use case</span>
                <h1 className={rec.title} tabIndex={-1}>{data.useCase.name}</h1>
              </div>
              {data.useCase.description ? <p className={rec.sub}>{data.useCase.description}</p> : null}
              <ul className={rec.chips} aria-label="Record status">
                <li className={`${rec.chip} ${rec[`tone-${STATUS_TONE[status] ?? "neutral"}`] ?? ""}`}><span className={rec.chipLabel}>Status</span> {statusLabel(status)}</li>
                <li className={`${rec.chip} ${data.screening.tier === "prohibited" ? rec["tone-danger"] : data.screening.tier === "high" ? rec["tone-warn"] : ""}`}>
                  <span className={rec.chipLabel}>EU AI Act</span> {data.screening.screened ? `${humanize(data.screening.tier)} tier` : "Not screened"}
                </li>
                {recertification ? (
                  <li className={`${rec.chip} ${rec["tone-warn"]}`}>{reReviewText(recertification.dueAt)}</li>
                ) : approvedUntil ? (
                  expired
                    ? <li className={`${rec.chip} ${rec["tone-danger"]}`}>Approval expired {shortDate(approvedUntil)}</li>
                    : <li className={`${rec.chip} ${rec["tone-ok"]}`}><span className={rec.chipLabel}>Approval valid until</span> {shortDate(approvedUntil)}</li>
                ) : null}
                <li className={rec.chip}><span className={rec.chipLabel}>Owner</span> {data.useCase.ownerName ?? "Unassigned"}</li>
              </ul>
            </div>
            {resubmission || data.useCase.workflowInstanceId ? (
              <div className={rec.bandActions}>
                {data.useCase.workflowInstanceId ? <Link className={rec.bandAction} to={`/workflows/${data.useCase.workflowInstanceId}`}>Open intake</Link> : null}
                {resubmission ? <Link className={rr.bandPrimary} to={resubmitPath(id)}>Update and resubmit</Link> : null}
              </div>
            ) : null}
          </header>
          <div className={v.stack}>
            <Tabs tabs={TABS} active={tab} onChange={(next) => setParams({ tab: next })} />
            {tab === "overview" ? (
              <OverviewTab
                data={data}
                status={status}
                expired={expired}
                approvedUntil={approvedUntil}
                conditions={conditions}
                conditionsLoaded={detail.isSuccess}
                openBlocking={openBlocking}
                recertification={recertification}
                reviews={detail.data?.reviews ?? []}
                resubmission={resubmission}
                acceptance={acceptance}
                userName={userName}
                onTab={(next) => setParams({ tab: next })}
                onRefresh={refresh}
              />
            ) : null}
            {tab === "frameworks" ? <FrameworksTab query={frameworks} /> : null}
            {tab === "risks" ? <RisksTab useCaseId={id} risks={data.risks} acceptance={acceptance} onRefresh={refresh} /> : null}
            {tab === "stack" ? <StackTab data={data.stack} /> : null}
            {tab === "dependencies" ? <Card title="Dependencies and inherited risk"><DependencyGraphPanel useCaseId={id} /></Card> : null}
            {tab === "approvals" ? <ApprovalsTab approvals={data.approvals} userName={userName} /> : null}
            {tab === "audit" ? <AuditTab rows={data.audit} /> : null}
          </div>
        </>
      ) : null}
    </QueryGate>
  );
}

function OverviewTab(props: {
  data: OverviewResponse;
  status: string;
  expired: boolean;
  approvedUntil: string | null;
  conditions: UseCaseCondition[];
  conditionsLoaded: boolean;
  openBlocking: number;
  recertification: { dueAt: string | null } | null;
  reviews: UseCaseReview[];
  resubmission: UseCaseResubmission | null;
  acceptance: Map<string, UseCaseRiskAcceptance>;
  userName: (userId: string | null) => string | null;
  onTab: (tab: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const { data } = props;
  const screeningRef = useRef<HTMLDivElement>(null);
  const [firstReason, ...moreReasons] = data.screening.reasons;
  const reasonText = (reason: { ref?: string; reason?: string }) => reason.reason ?? reason.ref;
  const screenedAt = data.audit.find((row) => row.ruleId === "use-case-eu-tier")?.at ?? (data.screening.screened ? data.questionnaire.submittedAt : null);
  const activities = deriveActivities({
    status: props.status,
    ownerName: data.useCase.ownerName ?? null,
    questionnaire: data.questionnaire,
    screening: data.screening,
    screenedAt,
    stack: data.stack,
    risks: data.risks,
    approvals: data.approvals,
    approverName: props.userName,
    reviews: props.reviews,
  });
  const phase = phaseFor(props.status, { approvalExpired: props.expired, openBlocking: props.openBlocking, recertification: props.recertification });
  const accepted = data.risks.filter((risk) => props.acceptance.has(risk.id));
  const act = (activity: Activity) => {
    const { tab } = activity.action;
    if (tab === "questionnaire" && props.resubmission) return <Link className={rec.actionLink} to={resubmitPath(data.useCase.id)}>{activity.action.label}</Link>;
    if (tab === "questionnaire") return data.useCase.workflowInstanceId
      ? <Link className={rec.actionLink} to={`/workflows/${data.useCase.workflowInstanceId}`}>{activity.action.label}</Link>
      : <span className={v.faint}>—</span>;
    if (tab === "screening") return <button type="button" className={rec.actionLink} onClick={() => { screeningRef.current?.scrollIntoView({ block: "center" }); screeningRef.current?.focus(); }}>{activity.action.label}</button>;
    return <button type="button" className={rec.actionLink} onClick={() => props.onTab(tab)}>{activity.action.label}</button>;
  };
  return (
    <div className={v.stack}>
      {props.resubmission ? (
        <p className={rr.returned} role="note">
          <strong>Sent back for information{props.resubmission.returnedByName ? ` by ${props.resubmission.returnedByName}` : ""}.</strong>{" "}
          {props.resubmission.returnReason ?? "No reason was recorded."}
        </p>
      ) : null}
      {props.recertification ? (
        <p className={rr.returned} role="note">
          The approval expired{props.recertification.dueAt ? ` on ${shortDate(props.recertification.dueAt)}` : ""}, so the use case is back in review. It cannot be deployed until it is approved again.
        </p>
      ) : props.expired && props.approvedUntil ? (
        <p className={rec.expired} role="note">
          The approval expired on {shortDate(props.approvedUntil)}. The use case needs a new review before it can be deployed again.
        </p>
      ) : null}
      <Card title="Lifecycle tracker">
        <ol className={rec.stepper} aria-label="Lifecycle">
          {PHASES.map((name, index) => {
            const done = index < phase.current || (index === phase.current && index === PHASES.length - 1 && !phase.flag);
            const current = index === phase.current;
            return (
              <li key={name} className={[rec.step, done ? rec.stepDone : "", current ? rec.stepCurrent : ""].join(" ")} {...(current ? { "aria-current": "step" as const } : {})}>
                <span className={rec.stepMark} aria-hidden>{done ? "✓" : index + 1}</span>
                <span className={rec.stepName}>{name}{done ? <span className={rec.srOnly}> (complete)</span> : null}</span>
              </li>
            );
          })}
        </ol>
        {phase.flag ? <p className={rec.flag}><Badge tone={phase.flag.tone}>{phase.flag.text}</Badge></p> : null}
        <p className={rec.trackerNote}>Each activity below comes from the record itself — complete them to move the use case to its next stage.</p>
        <Table<Activity>
          rows={activities}
          rowKey={(row) => row.key}
          columns={[
            { key: "status", header: "Status", render: (row) => <Badge tone={ACTIVITY_STATUS[row.status].tone}>{ACTIVITY_STATUS[row.status].label}</Badge> },
            { key: "activity", header: "Activity", render: (row) => <><span className={rec.activityName}>{row.name}</span><span className={rec.activityDetail}>{row.detail}</span></> },
            { key: "owner", header: "Assignee", render: (row) => row.owner ?? <span className={v.faint}>—</span> },
            { key: "updated", header: "Last update", render: (row) => <span className={rec.nowrap}>{row.lastUpdate ? ago(row.lastUpdate) : "—"}</span> },
            { key: "action", header: "Action", render: (row) => act(row) },
          ]}
        />
      </Card>
      {accepted.length > 0 ? (
        <Card title="Accepted risks">
          <ul className={rr.accepted}>
            {accepted.map((risk) => {
              const a = props.acceptance.get(risk.id)!;
              return (
                <li key={risk.id}>
                  <span className={rr.acceptedTitle}>{risk.title}</span>
                  <span className={rr.acceptedBy}>
                    Accepted by {a.acceptedByName ?? "a risk acceptor"}{a.acceptedAt ? ` on ${shortDate(a.acceptedAt)}` : ""}{a.acceptanceRationale ? ` · ${a.acceptanceRationale}` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}
      <ConditionsCard
        useCaseId={data.useCase.id}
        status={props.status}
        conditions={props.conditions}
        loaded={props.conditionsLoaded}
        onRefresh={props.onRefresh}
      />
      <div className={s.dashboardGrid}>
        <Card title="Purpose and context">
          <div className={v.stack}>
            <p>{data.useCase.businessContext ? String(data.useCase.businessContext) : <span className={v.dim}>No business context recorded.</span>}</p>
            <div>
              <strong>Compliance tags</strong>
              <p className={v.row}>{(data.useCase.complianceTags ?? []).length ? (data.useCase.complianceTags ?? []).map((tag) => <Badge key={tag}>{frameworkLabel(tag)}</Badge>) : <span className={v.dim}>None recorded</span>}</p>
            </div>
          </div>
        </Card>
        <div ref={screeningRef} tabIndex={-1} id="screening" aria-label="EU AI Act screening">
          <Card title="EU AI Act screening" actions={<span className={v.faint}>{data.screening.rulesetVersion ? `Rule set v${data.screening.rulesetVersion}` : "Not screened"}</span>}>
            <div className={v.stack}>
              <p><strong>{data.screening.screened ? `${humanize(data.screening.tier)} tier` : "Not screened yet"}</strong></p>
              {firstReason ? <p>{reasonText(firstReason)}</p> : <p className={v.dim}>No screening reasons recorded.</p>}
              {moreReasons.length ? (
                <details>
                  <summary>Show {plural(moreReasons.length, "more reason")}</summary>
                  <ul>{moreReasons.map((reason, index) => <li key={index}>{reasonText(reason)}</li>)}</ul>
                </details>
              ) : null}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

/** what a before-go-live condition's closing note may hold (the server's limit) */
const NOTE_MAX = 2000;

function ConditionsCard(props: {
  useCaseId: string;
  status: string;
  conditions: UseCaseCondition[];
  loaded: boolean;
  onRefresh: () => Promise<void>;
}) {
  const action = useAction();
  // a before-go-live condition is confirmed with a note saying what was done
  const [closing, setClosing] = useState<UseCaseCondition | null>(null);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const open = props.conditions.filter((c) => c.status === "open").length;
  const markMet = (row: UseCaseCondition, body: { note?: string }) =>
    action.run(async () => {
      await api.post(`/v1/use-cases/${props.useCaseId}/conditions/${row.id}/met`, body);
      await props.onRefresh();
    }, "Condition marked met");
  const closeDialog = () => {
    setClosing(null);
    setNote("");
    setNoteError(null);
  };
  const confirmClosing = async () => {
    if (!closing) return;
    const text = note.trim();
    if (!text) return setNoteError("Say what was done to meet this condition");
    if (text.length > NOTE_MAX) return setNoteError(`Keep the note to ${NOTE_MAX} characters or fewer`);
    if (await markMet(closing, { note: text })) closeDialog();
  };
  return (
    <Card title="Conditions of approval" actions={props.conditions.length ? <span className={v.faint}>{open ? `${open} open` : "All met"}</span> : undefined}>
      {props.conditions.length === 0 ? (
        <p className={v.dim}>
          {props.status === "approved"
            ? "This use case was approved without conditions."
            : props.loaded ? "No conditions yet. A reviewer can attach conditions when approving." : "Loading conditions…"}
        </p>
      ) : (
        <Table<UseCaseCondition>
          rows={props.conditions}
          rowKey={(row) => row.id}
          columns={[
            { key: "text", header: "Condition", render: (row) => <span className={rec.condText}>{row.text}</span> },
            { key: "when", header: "When", render: (row) => <span className={rec.nowrap}>{row.blocking ? "Before go-live" : "After go-live"}</span> },
            { key: "owner", header: "Owner", render: (row) => row.ownerName ?? <span className={v.faint}>Not assigned</span> },
            { key: "due", header: "Due", render: (row) => <span className={rec.nowrap}>{shortDate(row.dueAt)}</span> },
            {
              key: "status",
              header: "Status",
              render: (row) => {
                const state = conditionState(row);
                return <span className={rec.nowrap}><Badge tone={state.tone}>{state.label}</Badge>{row.status === "met" && row.metAt ? <span className={v.faint}> {shortDate(row.metAt)}{row.metByName ? ` by ${row.metByName}` : ""}</span> : null}</span>;
              },
            },
            {
              key: "act",
              header: "",
              align: "right",
              render: (row) => canMarkMet(row) ? (
                <Button
                  size="sm"
                  disabled={action.busy}
                  aria-label={`Mark met: ${row.text}`}
                  onClick={() => {
                    if (row.blocking) setClosing(row);
                    else void markMet(row, {});
                  }}
                >
                  Mark met
                </Button>
              ) : null,
            },
          ]}
        />
      )}
      {props.conditions.some((c) => c.status === "open" && c.blocking && !canMarkMet(c)) ? (
        <p className={v.faint}>
          A before-go-live condition is confirmed by someone other than the person who proposed the use case: the condition's owner, a reviewer who approved it, or an administrator.
        </p>
      ) : null}
      <Modal
        open={closing !== null}
        title="Mark condition met"
        onClose={closeDialog}
        actions={
          <>
            <Button onClick={closeDialog}>Cancel</Button>
            <Button variant="primary" disabled={action.busy} onClick={() => void confirmClosing()}>
              {action.busy ? "Saving…" : "Mark met"}
            </Button>
          </>
        }
      >
        {closing ? (
          <div className={v.stack}>
            <p className={v.dim}>{closing.text}</p>
            <p className={v.faint}>This condition must be met before go-live. Your note is kept with the record.</p>
            <Field label="What was done" error={noteError}>
              <Textarea
                rows={4}
                maxLength={NOTE_MAX}
                value={note}
                aria-invalid={noteError ? true : undefined}
                onChange={(event) => {
                  setNote(event.target.value);
                  if (noteError) setNoteError(null);
                }}
              />
            </Field>
          </div>
        ) : null}
      </Modal>
    </Card>
  );
}

const COVERAGE_TONE: Record<string, Tone> = { enforced: "ok", evidenced: "info", partial: "warn", unaddressed: "neutral" };

/** a pack title carries its version note after " — v2 …": the card shows the name, the note goes underneath */
const packTitle = (title: string) => title.split(/ — v\d/)[0]!;
const packNote = (title: string) => {
  const m = / — (v\d.*)$/.exec(title);
  return m ? m[1]! : "";
};

/** whether the pack's compliance tag is on the use case — the tag that turns the mapping into workflow requirements */
function PackAppliedBadge({ framework }: { framework: FrameworksResponse["frameworks"][number] }) {
  if (!framework.cascadeTag) return <Badge tone="neutral" title="This pack maps controls only; it adds no workflow requirements">Mapping only</Badge>;
  return framework.carriedByUseCase
    ? <Badge tone="ok" title="The use case carries this pack's compliance tag, so its workflow requirements apply">Applied</Badge>
    : <Badge tone="warn" title={`Add the ${frameworkLabel(framework.cascadeTag)} tag to apply this pack's workflow requirements${framework.profileExists ? "" : " (no compliance profile exists for it yet)"}`}>Not applied</Badge>;
}

function FrameworksTab({ query }: { query: ReturnType<typeof useQuery<FrameworksResponse>> }) {
  return <QueryGate loading={query.isLoading} error={query.error} onRetry={() => void query.refetch()}>{query.data ? <div className={v.stack}><p className={s.callout}>{query.data.evidenceScope.note}</p>{query.data.frameworks.length === 0 ? <EmptyState title="No active framework mappings" /> : query.data.frameworks.map((framework) => <Card key={framework.id} title={`${packTitle(framework.title)} · v${framework.version}`} actions={<PackAppliedBadge framework={framework} />}><div className={v.stack}><p className={v.faint}>{plural(framework.controls.length, "mapped control")}{packNote(framework.title) ? ` · ${packNote(framework.title)}` : ""}</p><Table rows={framework.controls} rowKey={(control) => control.controlRef} columns={[{ key: "control", header: "Control", render: (control) => <code style={{ whiteSpace: "nowrap" }}>{control.controlRef}</code> }, { key: "title", header: "Title", render: (control) => control.title }, { key: "coverage", header: "Platform coverage", render: (control) => <Badge tone={COVERAGE_TONE[control.coverage] ?? "neutral"}>{humanize(control.coverage)}</Badge> }]} /></div></Card>)}<p className={v.faint}>{query.data.disclaimer}</p></div> : null}</QueryGate>;
}

/** open is the state that needs attention; mitigating and accepted are decided workflow states */
const RISK_STATUS_TONE: Record<string, Tone> = { open: "warn", mitigating: "neutral", accepted: "neutral", closed: "ok" };

function RisksTab({ useCaseId, risks, acceptance, onRefresh }: { useCaseId: string; risks: OverviewRisk[]; acceptance: Map<string, UseCaseRiskAcceptance>; onRefresh: () => Promise<void> }) {
  const action = useAction();
  const [controlRefs, setControlRefs] = useState<Record<string, string>>({});
  const [residuals, setResiduals] = useState<Record<string, { likelihood: string; impact: string }>>({});
  return (
    <div className={v.stack}>
      {risks.length === 0 ? <EmptyState title="No risks linked to this use case" body="Add a scenario from the library to make the inherent and residual position explicit." /> : risks.map((risk) => {
        const draft = residuals[risk.id] ?? { likelihood: risk.residual?.likelihood ?? "", impact: risk.residual?.impact ?? "" };
        return <Card key={risk.id} title={risk.title} actions={<div className={v.row}><span className={v.faint}>{risk.dimension}</span><Badge tone={RISK_STATUS_TONE[risk.status] ?? "neutral"}>{risk.status}</Badge></div>}><div className={v.stack}>
          {acceptance.has(risk.id) ? (() => { const a = acceptance.get(risk.id)!; return <p className={rr.acceptedBy}>Accepted by {a.acceptedByName ?? "a risk acceptor"}{a.acceptedAt ? ` on ${shortDate(a.acceptedAt)}` : ""}{a.acceptanceRationale ? ` · ${a.acceptanceRationale}` : ""}</p>; })() : null}
          <p className={s.riskFlow}><span className={v.dim}>Inherent</span> <strong>{risk.inherent.likelihood} × {risk.inherent.impact}</strong> <span aria-hidden>→</span> <span className={v.dim}>Residual</span> <strong>{risk.residual ? `${risk.residual.likelihood} × ${risk.residual.impact}` : "unmeasured"}</strong></p>
          <div><strong>Linked controls</strong>{risk.controls.length === 0 ? <p className={v.dim}>No controls linked.</p> : risk.controls.map((control) => <div key={control.controlRef} className={v.listRow}><span className={v.grow}><code>{control.controlRef}</code><br /><span className={v.faint}>{control.title}</span></span><RemoveButton what={`control ${control.controlRef}`} consequence={<>The control link is removed from this risk. The risk and its audit history remain.</>} onRemove={() => api.del(`/v1/risks/${risk.id}/controls/${encodeURIComponent(control.controlRef)}`)} onDone={() => void onRefresh()} /></div>)}</div>
          <div className={s.libraryFilters}><Field label="Control reference" helpLabel="the mitigation link created here" help={<p>Enter the canonical reference of an existing control. Linking it records that this control mitigates the selected use-case risk; it does not by itself prove the control is implemented or evidenced.</p>}><Input value={controlRefs[risk.id] ?? ""} onChange={(event) => setControlRefs((current) => ({ ...current, [risk.id]: event.target.value }))} placeholder="Control reference" /></Field><Field label=" "><Button disabled={action.busy || !(controlRefs[risk.id] ?? "").trim()} onClick={() => void action.run(async () => { await api.post(`/v1/risks/${risk.id}/controls`, { controlRef: controlRefs[risk.id]!.trim() }); setControlRefs((current) => ({ ...current, [risk.id]: "" })); await onRefresh(); }, "Control linked")}>Link control</Button></Field></div>
          <div className={s.libraryFilters}><Field label="Residual likelihood"><Select value={draft.likelihood} onChange={(event) => setResiduals((current) => ({ ...current, [risk.id]: { ...draft, likelihood: event.target.value } }))}><option value="">Choose likelihood</option><option>low</option><option>medium</option><option>high</option></Select></Field><Field label="Residual impact"><Select value={draft.impact} onChange={(event) => setResiduals((current) => ({ ...current, [risk.id]: { ...draft, impact: event.target.value } }))}><option value="">Choose impact</option><option>low</option><option>medium</option><option>high</option></Select></Field><Field label=" "><Button disabled={action.busy || !draft.likelihood || !draft.impact} onClick={() => void action.run(async () => { await api.put(`/v1/risks/${risk.id}/residual`, draft); await onRefresh(); }, "Residual position updated")}>Save residual</Button></Field></div>
        </div></Card>;
      })}
      {/* this use case's own risks come first; the generic library sits below them */}
      <RiskLibraryPicker useCaseId={useCaseId} onAdded={() => void onRefresh()} />
    </div>
  );
}

function StackTab({ data }: { data: OverviewResponse["stack"] }) {
  return <div className={v.stack}><Card title="Agents">{data.agents.length === 0 ? <EmptyState title="No intended agents linked" body="The intake records the agent this use case will run on. Choose one at the stack step of the intake, or link it from the agent inventory." /> : data.agents.map((agent) => <AgentCard key={agent.id} id={agent.id} fallback={agent} />)}</Card><Card title="Vendors">{data.vendors.length === 0 ? <EmptyState title="No vendors resolved from this stack" /> : data.vendors.map((vendor) => <div key={vendor.id} className={v.listRow}><span className={v.grow}><strong>{vendor.name}</strong><br /><span className={v.faint}>{humanize(vendor.category)} · via {vendor.linkedVia.join(", ")}</span></span><Badge tone={vendor.status === "approved" ? "ok" : "warn"}>{humanize(vendor.status)}</Badge></div>)}</Card></div>;
}

function AgentCard({ id, fallback }: { id: string; fallback: OverviewResponse["stack"]["agents"][number] }) {
  const card = useQuery({ queryKey: ["governance", "agent-card", id], queryFn: () => api.get<AgentCardResponse>(`/v1/agents/${id}/card`) });
  return (
    <div id={`agent-${id}`} className={s.agentCard}>
      <div className={v.row}>
        <strong>{fallback.name}</strong>
        {/* model-card approval is stated once, in the Model cards section below */}
        {fallback.halted ? <Badge tone="danger">Halted</Badge> : <span className={v.faint}>{humanize(fallback.lifecycleStatus)}</span>}
      </div>
      {card.isError ? <p className={v.errLine}>Agent card could not be loaded: {(card.error as Error).message}</p> : card.data ? (
        <div className={v.stack}>
          <p className={v.dim}>
            {providerLabel(card.data.agent.provider)} · {card.data.agent.model ?? "default model"}
          </p>
          <AgentStewardshipLine stewardship={card.data.stewardship} />
          <div>
            <strong>Declared purpose</strong>
            {card.data.purpose.intendedUses.length
              ? <ul>{card.data.purpose.intendedUses.map((use) => <li key={use}>{use}</li>)}</ul>
              : <p className={v.dim}>No declared purpose recorded.</p>}
          </div>
          <div>
            <div className={v.row}>
              <strong>Model cards</strong>
              {fallback.modelCards.length ? <span className={v.faint}>{fallback.modelCards.filter((c) => c.signOff === "approved").length} of {fallback.modelCards.length} approved</span> : null}
            </div>
            {fallback.modelCards.length ? (
              <ul>{fallback.modelCards.map((modelCard) => (
                <li key={modelCard.id}>
                  <Badge tone={modelCard.signOff === "approved" ? "ok" : "warn"}>{modelCard.signOff === "none" ? "Not signed off" : humanize(modelCard.signOff)}</Badge>{" "}
                  {!modelCard.intendedUse ? "No intended use recorded" : card.data!.purpose.intendedUses.includes(modelCard.intendedUse) ? null : truncate(modelCard.intendedUse, 90)}
                </li>
              ))}</ul>
            ) : <p className={v.dim}>No model card is linked to this agent.</p>}
          </div>
          <p className={v.faint}>{[card.data.dataSources.note, card.data.oversight.note].filter(Boolean).map(sentenceCase).join(" ")}</p>
          <Link to={`/admin/agents#agent-${id}`}>Open this agent in the full inventory</Link>
        </div>
      ) : <p className={v.dim}>Loading agent card…</p>}
    </div>
  );
}

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

const sentenceCase = (text: string) => (text ? `${text.charAt(0).toUpperCase()}${text.slice(1).replace(/\.$/, "")}.` : text);

const OUTCOME: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "Awaiting decision", tone: "info" },
  approved: { label: "Approved", tone: "ok" },
  denied: { label: "Rejected", tone: "danger" },
  returned: { label: "Sent back", tone: "warn" },
  superseded: { label: "Superseded", tone: "neutral" },
  consumed: { label: "Used", tone: "neutral" },
};

function ApprovalsTab({ approvals, userName }: { approvals: OverviewResponse["approvals"]; userName: (userId: string | null) => string | null }) {
  return <Card title="Approval history">{approvals.length === 0 ? <EmptyState title="No approval records yet" body="A sign-off is requested when the intake questionnaire is submitted." /> : <Table rows={approvals} rowKey={(row) => row.id} columns={[
    { key: "stage", header: "Stage", render: (row) => humanize(row.stageId) },
    { key: "approver", header: "Approver", render: (row) => userName(row.approverUserId) ?? <span className={v.faint}>Not recorded</span> },
    { key: "outcome", header: "Outcome", render: (row) => { const o = OUTCOME[row.status] ?? { label: humanize(row.status), tone: "neutral" as Tone }; return <Badge tone={o.tone}>{o.label}</Badge>; } },
    { key: "requested", header: "Requested", render: (row) => <span className={rec.nowrap}>{ago(row.requestedAt)}</span> },
    { key: "decided", header: "Decided", render: (row) => <span className={rec.nowrap}>{row.decidedAt ? ago(row.decidedAt) : "—"}</span> },
    { key: "reason", header: "Reason", render: (row) => row.decisionReason ?? "—" },
  ]} />}</Card>;
}

function AuditTab({ rows }: { rows: OverviewResponse["audit"] }) {
  return <Card title="Recent use-case audit evidence">{rows.length === 0 ? <EmptyState title="No audit rows returned" /> : <Table rows={rows} rowKey={(row) => String(row.id)} columns={[{ key: "at", header: "When", render: (row) => <span style={{ whiteSpace: "nowrap" }}>{ago(row.at)}</span> }, { key: "rule", header: "Event", render: (row) => <span style={{ whiteSpace: "nowrap" }}>{humanize(row.ruleId)}</span> }, { key: "effect", header: "Effect", render: (row) => <Badge tone={row.effect === "allow" ? "ok" : row.effect === "deny" ? "danger" : "warn"}>{row.effect}</Badge> }, { key: "reason", header: "Reason", render: (row) => row.reason }]} />}<p><Link to="/admin/audit">Open the full audit log</Link></p></Card>;
}

