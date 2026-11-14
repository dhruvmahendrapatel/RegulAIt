/**
 * The use-case DECISION SUMMARY tab (owner, #453, 2026-11-07; design thread #743): the record's first tab, so the
 * person who opens a use case sees where its decision stands before the twelve detailed tabs.
 *
 * Status only. Nothing here decides: decisions stay in the approval flow. The one Next action is picked from the
 * server's own flags (see `nextAction`), and the only control it can open is the existing "Mark condition met" flow.
 * Every figure comes from the overview or the lifecycle detail the page already reads; a failed read says so.
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { UseCaseCondition, UseCaseRiskAcceptance } from "../../../api/types";
import { frameworkLabel, humanize } from "../../../api/format";
import { Button, Card, InfoButton, Meter, SkeletonBlock } from "../../../ui/kit";
import k from "../../../ui/kit.module.css";
import v from "../../views.module.css";
import rec from "./record.module.css";
import u from "./useCaseSummary.module.css";
import { useMarkMetFlow } from "./markMetFlow";
import { resubmitPath } from "./registryModel";
import { phaseFor, shortDate, statusLabel, type OverviewResponse } from "./useCaseLifecycle";
import {
  approvalChecklist,
  approvalReason,
  conditionsFigure,
  evidenceFigure,
  recertificationFigure,
  riskFigure,
  type Figure,
  type LifecycleDates,
  type NextAction,
  type Read,
} from "./useCaseSummaryModel";

export const tabHref = (tab: string) => ({ search: `?tab=${tab}` });

function FigureCard({ figure }: { figure: Figure }) {
  return (
    <li className={u.figure} data-testid={`figure-${figure.key}`} data-state={figure.state}>
      <div className={u.figureHead}>
        <span>{figure.label}</span>
        <InfoButton label={`what ${figure.label.toLowerCase()} covers`} align="end">
          <p>{figure.scope}</p>
        </InfoButton>
      </div>
      {figure.state === "loading" ? (
        <SkeletonBlock lines={2} />
      ) : (
        <>
          <p className={`${u.figureValue} ${figure.state === "ok" ? "" : u.figureMuted}`}>{figure.value}</p>
          {figure.meter ? <Meter value={figure.meter.value} max={figure.meter.max} warn={figure.meter.warn} label={figure.meter.label} /> : null}
          {figure.detail ? <p className={u.figureDetail}>{figure.detail}</p> : null}
          <p className={u.figureDetail}>Scope: {figure.scope}</p>
          {figure.link && figure.state !== "ok" ? <Link to={tabHref(figure.link.tab)}>{figure.link.label}</Link> : null}
        </>
      )}
    </li>
  );
}

function NextBanner(props: { next: NextAction; useCaseId: string; onRefresh: () => Promise<void> }) {
  const flow = useMarkMetFlow(props.useCaseId, props.onRefresh);
  const { next } = props;
  if (!next) return null;
  let title: string;
  let body: string;
  let act: ReactNode;
  if (next.kind === "mark-met") {
    const c = next.condition;
    title = `Next: ${c.text}`;
    body = `Before go-live, due ${shortDate(c.dueAt)}${c.ownerName ? `, owner ${c.ownerName}` : ""}. Marking it met records who did it and when.`;
    act = (
      <Button variant="primary" disabled={flow.busy} aria-label={`Mark condition met: ${c.text}`} onClick={() => flow.start(c)}>
        Mark condition met…
      </Button>
    );
  } else if (next.kind === "resubmit") {
    title = "Next: update the use case and send it back for review";
    body = `A reviewer sent this use case back for information.${next.reason ? ` ${next.reason}` : ""}`;
    act = next.reachable ? (
      <Link className={k.btnPrimary} to={resubmitPath(props.useCaseId)}>Open the update form</Link>
    ) : (
      <span className={u.nextBody}>The update form is in the administration area; ask an administrator to open it with you.</span>
    );
  } else {
    title = "Next: the review is in progress";
    body = "The named reviewers decide in the approval flow. The approvals tab shows who has the review and since when.";
    act = <Link to={tabHref("approvals")}>Open the approvals</Link>;
  }
  return (
    <section className={u.next} aria-label="Next action" data-testid="next-action" data-kind={next.kind}>
      <div className={u.nextText}>
        <p className={u.nextTitle}>{title}</p>
        <p className={u.nextBody}>{body}</p>
      </div>
      {act}
      {flow.dialog}
    </section>
  );
}

function ConditionList(props: { conditions: Read<UseCaseCondition[]>; onRetry: () => void }) {
  if (props.conditions.state === "loading") return <SkeletonBlock lines={3} />;
  if (props.conditions.state === "error") {
    return (
      <div className={v.stack} role="alert">
        <p className={v.dim}>The conditions could not be loaded, so they are not shown. Nothing here means there are none.</p>
        <div><Button size="sm" aria-label="Retry loading the conditions" onClick={props.onRetry}>Retry</Button></div>
      </div>
    );
  }
  const rows = props.conditions.value;
  if (rows.length === 0) return <p className={v.dim}>No conditions are attached to this use case.</p>;
  const group = (blocking: boolean) => rows.filter((c) => c.blocking === blocking);
  const item = (c: UseCaseCondition) => (
    <li key={c.id} className={u.cond}>
      <span>{c.text}</span>
      <span className={u.condMeta}>
        {c.status === "met"
          ? `Met${c.metByName ? ` by ${c.metByName}` : ""}${c.metAt ? `, ${shortDate(c.metAt)}` : ""}`
          : c.status === "waived"
            ? "Waived"
            : `${c.overdue ? "Overdue" : "Open"} · ${c.ownerName ?? "No owner assigned"} · due ${shortDate(c.dueAt)}`}
      </span>
    </li>
  );
  return (
    <div>
      {[true, false].map((blocking) => {
        const list = group(blocking);
        if (!list.length) return null;
        return (
          <div key={String(blocking)}>
            <h3 className={u.condGroup}>{blocking ? "Before go-live" : "After go-live"}</h3>
            <ul className={u.list}>{list.map(item)}</ul>
          </div>
        );
      })}
    </div>
  );
}

export function UseCaseSummaryTab(props: {
  data: OverviewResponse;
  status: string;
  conditions: Read<UseCaseCondition[]>;
  acceptance: Read<UseCaseRiskAcceptance[]>;
  lifecycle: Read<LifecycleDates>;
  next: NextAction;
  foundByDiscovery: boolean;
  onRetryDetail: () => void;
  onRefresh: () => Promise<void>;
}) {
  const { data } = props;
  const figures = [
    riskFigure(data.risks, props.acceptance),
    // no read the page makes counts the required evidence items: "Not measured", never an invented number
    evidenceFigure(null),
    conditionsFigure(props.conditions),
    recertificationFigure(props.lifecycle),
  ];
  const reason = approvalReason(data.approvals);
  const checks = approvalChecklist(data, props.conditions);
  const openBlocking = props.conditions.state === "ok" ? props.conditions.value.filter((c) => c.status === "open" && c.blocking).length : 0;
  const phase = phaseFor(props.status, { openBlocking });
  const conditionsTitle =
    props.conditions.state === "ok" ? `Conditions (${props.conditions.value.filter((c) => c.status === "open").length} open)` : "Conditions";
  const answers = (data.useCase.intakeAnswers ?? null) as { dataCategories?: unknown } | null;
  const categories = Array.isArray(answers?.dataCategories) ? (answers.dataCategories as string[]) : [];
  const sensitivity = typeof data.useCase.dataSensitivity === "string" ? data.useCase.dataSensitivity : null;
  const registered = typeof data.useCase.createdAt === "string" ? data.useCase.createdAt : null;
  const tags = data.useCase.complianceTags ?? [];
  return (
    <div className={v.stack}>
      <ul className={u.figures} aria-label="Decision figures">
        {figures.map((f) => <FigureCard key={f.key} figure={f} />)}
      </ul>
      <NextBanner next={props.next} useCaseId={data.useCase.id} onRefresh={props.onRefresh} />
      <div className={u.layout}>
        <div className={u.main}>
          <Card title={props.status === "approved" ? "Why it was approved" : "What the decision rests on"}>
            {props.status === "approved" ? (
              reason ? <p className={u.reason}>The reviewer&apos;s recorded reason: {reason}</p> : <p className={`${u.reason} ${v.dim}`}>No reason was recorded with the approval.</p>
            ) : null}
            <ul className={u.checks} aria-label="What the record holds">
              {checks.map((c) => (
                <li key={c.key}>
                  <span className={`${u.mark} ${c.ok ? u.markOk : u.markOpen}`} aria-hidden>{c.ok ? "✓" : "!"}</span>
                  <span>
                    <span className={rec.srOnly}>{c.ok ? "Done: " : "Open: "}</span>
                    {c.text}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
          <Card title="At a glance">
            <dl className={u.facts}>
              <dt>Owner</dt>
              <dd>{data.useCase.ownerName ?? "Unassigned"}</dd>
              <dt>Lifecycle</dt>
              <dd>{statusLabel(props.status)}{phase.flag ? ` · ${phase.flag.text}` : props.status === "approved" ? " · in monitoring" : ""}</dd>
              <dt>Agents</dt>
              <dd>{data.stack.agents.length ? data.stack.agents.map((a) => a.name).join(", ") : "None linked"}</dd>
              <dt>Frameworks</dt>
              <dd>{tags.length ? tags.map(frameworkLabel).join(", ") : "None recorded"}</dd>
              <dt>Data</dt>
              <dd>
                {sensitivity ? humanize(sensitivity) : "Sensitivity not recorded"}
                {categories.length ? ` · ${categories.map(humanize).join(", ")}` : ""}
              </dd>
              <dt>Registered</dt>
              <dd>{registered ? shortDate(registered) : "Not recorded"}{props.foundByDiscovery ? ", from a discovery finding" : ""}</dd>
            </dl>
          </Card>
        </div>
        <div className={u.side}>
          <Card title={conditionsTitle}>
            <ConditionList conditions={props.conditions} onRetry={props.onRetryDetail} />
          </Card>
          <Card title="Related">
            <ul className={`${u.list} ${u.related}`}>
              <li><Link to={tabHref("risks")}>Risks ({data.risks.length})</Link></li>
              <li><Link to={tabHref("audit")}>Evidence and audit trail ({(data.auditTotal ?? data.audit.length).toLocaleString("en-GB")}{data.auditTotal === undefined && data.audit.length >= 20 ? "+" : ""})</Link></li>
              <li><Link to={tabHref("approvals")}>Approvals and reviews ({data.approvals.length})</Link></li>
              <li><Link to={tabHref("decisions")}>Decision records</Link></li>
              <li><Link to={tabHref("overview")}>Lifecycle and conditions</Link></li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
