/**
 * Inbox — everything that pauses for the signed-in human: workflow sign-offs
 * (with the merge-gate evidence: submitted artifacts, PR link, recorded check
 * results, dry-run honesty), run escalations, budget overages, context
 * conflicts (both texts side by side), and delegated items. Approve/deny with
 * reasons; admin overrides and self-reviews require one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";
import type { Approval, CheckResult, WorkflowDetailResponse } from "../../api/types";
import { ago, approvalStageLabel, humanize } from "../../api/format";
import { QuestionnaireView } from "../admin/governance/UseCaseQuestionnaire";
import { useSession } from "../../session/SessionContext";
import { PageHeader } from "../../shell/AppShell";
import {
  Badge,
  Button,
  Card,
  CodeBlock,
  EmptyState,
  ErrorState,
  InfoButton,
  Input,
  SkeletonBlock,
  StatusBadge,
} from "../../ui/kit";
import { DetailDrawer, DrawerActions } from "../../ui/DetailDrawer";
import { useToast } from "../../ui/toast";
import { McpActionReview } from "../approvals/McpActionReview";
import { inspectApprovalAction, isBoundAction } from "../approvals/approvalReview";
import { ReviewPanel } from "../approvals/ReviewPanel";
import { intakeUseCaseName, isIntakeSignoff } from "../approvals/reviewDecision";
import { QuorumProgress } from "../approvals/QuorumProgress";
import { decideApproval, isToolCallApproval, signatureModeOf, signedDecisionErrorText } from "../approvals/signedDecision";
import { shortDate, type OverviewResponse } from "../admin/governance/useCaseLifecycle";
import v from "../views.module.css";
import ib from "./inbox.module.css";

const approvalLabel = (a: Approval): string => {
  if (isIntakeSignoff(a)) return "AI use case sign-off";
  if (a.objectType === "mcp_tool") return `MCP action: ${a.toolName ?? "unknown tool"}`;
  if (a.objectType === "connector_call") return `Connector write: ${a.toolName ?? "unknown connector"}`;
  const sentinel = approvalStageLabel(a);
  if (sentinel) return sentinel;
  if (a.objectType === "infra_operation")
    return "Infra remediation" + (a.objectLabel ? ` · ${a.objectLabel}` : "");
  const stage = humanize(a.stageId);
  if (a.objectType === "workflow") return /sign-off$/i.test(stage) ? stage : `Sign-off · ${stage}`;
  if (a.objectType === "run") return `Run escalation · ${stage}`;
  return stage;
};

const approvalTarget = (a: Approval): string | null => {
  if (a.instanceId) return `/workflows/${a.instanceId}`;
  if (a.runId) return `/runs/${a.runId}`;
  if (a.projectId) return `/projects/${a.projectId}`;
  return null;
};

export default function InboxPage() {
  const { auth } = useSession();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const me = auth?.userId ?? null;
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [deciding, setDeciding] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const closeItem = useCallback(() => setOpenId(null), []);
  // L1 (WCAG 2.4.3): the item just decided, and where it sat in the list
  const decidedFrom = useRef<{ id: string; index: number } | null>(null);
  const list = useRef<HTMLDivElement>(null);

  const q = useQuery({
    queryKey: ["approvals"],
    queryFn: () => api.get<{ approvals: Approval[] }>("/v1/approvals"),
  });
  // ADR-0173 batch 2c (Q): annotation items waiting on me as a named reviewer.
  // Content-free; the card shows only when there is something to review.
  const annotations = useQuery({
    queryKey: ["annotation-inbox"],
    queryFn: () => api.get<{ items?: AnnotationInboxItem[] }>("/v1/annotations/inbox"),
    retry: false,
  });
  const annotationItems = Array.isArray(annotations.data?.items) ? annotations.data.items : [];
  const approvals = q.data?.approvals ?? [];
  const pending = approvals.filter((a) => a.status === "pending");
  const decided = approvals.filter((a) => a.status !== "pending").slice(0, 12);
  // L1: a decided item leaves the list, taking its drawer and the Review button that opened it, so focus moves to
  // the next item's Review button (the one before it when it was last), or to the page heading when none is left
  useEffect(() => {
    const from = decidedFrom.current;
    if (!from || pending.some((a) => a.id === from.id)) return;
    decidedFrom.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const reviews = [...(list.current?.querySelectorAll<HTMLElement>("[data-inbox-row]") ?? [])].map((row) => row.querySelector<HTMLElement>("[data-inbox-review]"));
    const next = reviews.slice(from.index).find(Boolean) ?? reviews.slice(0, from.index).reverse().find(Boolean);
    (next ?? document.querySelector<HTMLElement>("h1"))?.focus();
  });

  // merge-gate evidence: fetch each governed workflow instance once (the read
  // endpoint admits the named approver)
  const instanceIds = useMemo(
    () => [
      ...new Set(
        pending
          .filter((a) => a.objectType === "workflow" && a.instanceId)
          .map((a) => a.instanceId!),
      ),
    ],
    [pending],
  );
  const instanceQueries = useQueries({
    queries: instanceIds.map((id) => ({
      queryKey: ["workflow", id],
      queryFn: () => api.get<WorkflowDetailResponse>(`/v1/workflows/instances/${id}`),
      retry: false,
    })),
  });
  const instances: Record<string, WorkflowDetailResponse> = {};
  instanceIds.forEach((id, i) => {
    const data = instanceQueries[i]?.data;
    if (data) instances[id] = data;
  });

  const decide = async (a: Approval, decision: "approved" | "denied") => {
    if (decision === "approved" && isBoundAction(a)) {
      const blocked = inspectApprovalAction(a).blockedReason;
      if (blocked) { setRowErrors((errors) => ({ ...errors, [a.id]: blocked })); return; }
    }
    const reason = (reasons[a.id] ?? "").trim();
    const named = me === a.approverUserId;
    const delegated = Boolean(a.delegatedFrom);
    setRowErrors((e) => ({ ...e, [a.id]: "" }));
    // ADR-0186: a tool-call approval is signed over the exact call (or stepped
    // up), may need several approvers, and has no admin override
    if (isToolCallApproval(a)) {
      setDeciding(a.id);
      try {
        const out = await decideApproval<{ status?: string; approvals?: number; quorum?: number }>(a, decision, reason || undefined);
        if (out?.status !== "pending") decidedFrom.current = { id: a.id, index: pending.indexOf(a) };
        toast(
          out?.status === "pending"
            ? `Recorded — ${out.approvals ?? 1} of ${out.quorum ?? 2} approvals, waiting for another approver`
            : decision === "approved" ? "Approved" : "Denied",
          "success",
        );
        void queryClient.invalidateQueries({ queryKey: ["approvals"] });
      } catch (e) {
        setRowErrors((er) => ({ ...er, [a.id]: signedDecisionErrorText(e) }));
      } finally {
        setDeciding(null);
      }
      return;
    }
    if (!named && !delegated && auth?.isAdmin && !reason) {
      setRowErrors((e) => ({
        ...e,
        [a.id]: "You are not the named approver — an admin override requires a recorded reason.",
      }));
      return;
    }
    if (a.selfReview && !reason) {
      setRowErrors((e) => ({
        ...e,
        [a.id]: "This is a self-review (you would be deciding your own request) — a reason is required.",
      }));
      return;
    }
    setDeciding(a.id);
    try {
      await api.post(`/v1/approvals/${a.id}/decide`, {
        decision,
        ...(reason ? { reason } : {}),
      });
      decidedFrom.current = { id: a.id, index: pending.indexOf(a) };
      toast(decision === "approved" ? "Approved" : "Denied", "success");
      void queryClient.invalidateQueries({ queryKey: ["approvals"] });
    } catch (e) {
      setRowErrors((er) => ({ ...er, [a.id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setDeciding(null);
    }
  };

  const itemView = (a: Approval): ItemView => {
    const named = me === a.approverUserId;
    const delegated = Boolean(a.delegatedFrom);
    const toolCall = isToolCallApproval(a);
    // a tool-call row reaches this inbox only for its approver pool; the
    // caller never decides it, and nobody decides it twice
    const canDecide = toolCall
      ? a.userId !== me && !a.myDecision
      : named || delegated || Boolean(auth?.isAdmin);
    const target = approvalTarget(a);
    const inst = a.instanceId ? instances[a.instanceId] : undefined;
    const intake = isIntakeSignoff(a);
    // an intake sign-off is decided in ReviewPanel, which owns its rules and copy (a proposer never decides
    // their own use case; a role member is a named reviewer), so none of the override or own-request text here
    const ownRules = !toolCall && !intake;
    const override = ownRules && !named && !delegated && Boolean(auth?.isAdmin);
    // G2: where the server requires a reason (an override, or approving your own request), the field says so
    // and Approve waits for one. Stricter than before, never looser: the server still checks it
    const reasonRequired = override || (ownRules && Boolean(a.selfReview));
    const missingReason = reasonRequired && !(reasons[a.id] ?? "").trim();
    const controls = (blockedReason: string | null) => <div className={ib.decide}>
      <Input style={{ maxWidth: 260 }}
        placeholder={reasonRequired ? "Reason (required)" : "Reason (optional)"}
        aria-label="Decision reason" aria-required={reasonRequired || undefined} value={reasons[a.id] ?? ""}
        onChange={(e) => setReasons((r) => ({ ...r, [a.id]: e.target.value }))} />
      <div className={v.row}>
        <Button size="sm" disabled={deciding === a.id} onClick={() => void decide(a, "denied")}>Deny</Button>
        <Button size="sm" variant="primary" disabled={deciding === a.id || !!blockedReason || missingReason} onClick={() => void decide(a, "approved")}>Approve</Button>
      </div>
      {missingReason && <span className={v.faint}>Approve unlocks once a reason is entered</span>}
      {toolCall && signatureModeOf(a) === "passkey" && (
        <span className={v.faint}>
          Signs with your passkey
          <InfoButton label="passkey signing" align="end">Your browser asks for your passkey. The signature covers this exact call.</InfoButton>
        </span>
      )}
      {rowErrors[a.id] && <div className={v.errLine} role="alert">{rowErrors[a.id]}</div>}
    </div>;
    const awaiting = toolCall && a.myDecision
      ? `you ${a.myDecision} this — waiting for another approver`
      : toolCall && a.userId === me
        ? "your own call — someone else in the approver pool decides it"
        : `awaiting ${a.approverName ?? "the named approver"}`;
    const name = a.objectLabel ? (intake ? intakeUseCaseName(a) : a.objectLabel) : approvalLabel(a);
    return { delegated, toolCall, canDecide, target, inst, intake, ownRules, override, reasonRequired, controls, awaiting, name, bound: isBoundAction(a) };
  };
  // owner decision on #453 (A1): a pending item's evidence and decision open in the shared detail drawer.
  // An intake sign-off and an MCP action keep their own review dialogs. A decided item leaves the pending
  // list, so its drawer closes with it
  const open = pending.find((a) => a.id === openId && !isIntakeSignoff(a) && !isBoundAction(a)) ?? null;
  const openView = open ? itemView(open) : null;

  if (q.isLoading) {
    return (
      <>
        <PageHeader title="Inbox" />
        <Card>
          <SkeletonBlock lines={5} />
        </Card>
      </>
    );
  }
  if (q.isError) {
    return (
      <>
        <PageHeader title="Inbox" />
        <Card>
          <ErrorState message={(q.error as Error).message} onRetry={() => void q.refetch()} />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Inbox"
        sub="Everything that pauses for you: sign-offs, escalations, budget overages, context conflicts."
        actions={pending.length > 0 ? <Badge tone="info">{`${pending.length} waiting on you`}</Badge> : undefined}
      />
      <div className={v.stack}>
        <Card>
          <div ref={list}>
          {pending.length === 0 ? (
            <EmptyState
              title={annotationItems.length > 0 ? "No sign-offs waiting on you" : "Nothing waiting on you"}
              body="When a governed action needs your decision it appears here — and the requester is unblocked the moment you decide."
            />
          ) : (
            pending.map((a) => {
              const it = itemView(a);
              return (
                <div key={a.id} data-inbox-row className={v.listRow} style={{ flexDirection: "column", alignItems: "stretch", gap: "var(--s1)" }}>
                  {/* G2: the same order on every item: what kind, what, who asked and when, then any warning */}
                  <ItemBadges a={a} it={it} />
                  {(a.objectLabel || it.target) && <strong className={ib.title}><ItemTitle a={a} it={it} /></strong>}
                  <div className={v.faint}>
                    {it.intake ? "Use case" : humanize(a.objectType)} · requested by {a.requestedByName ?? "unknown"} · {ago(a.requestedAt)}
                  </div>
                  <ReasonWarning it={it} />
                  {it.intake ? (
                    <div className={v.row}>
                      <ReviewPanel approval={a} />
                      {!it.canDecide && <span className={v.faint}>awaiting {a.approverName ?? "the named approver"}</span>}
                    </div>
                  ) : it.bound ? <>
                    {/* an MCP action keeps its own review dialog, which already opens from the row */}
                    {it.toolCall && <QuorumProgress approval={a} />}
                    {it.inst && <MergeGateEvidence inst={it.inst} />}
                    {a.contextConflict && <ConflictPreview conflict={a.contextConflict} />}
                    {it.canDecide ? <McpActionReview approval={a} controls={it.controls} /> : <>
                      <McpActionReview approval={a} />
                      <span className={v.faint}>{it.awaiting}</span>
                    </>}
                  </> : (
                    <div className={v.row}>
                      <Button size="sm" data-inbox-review aria-current={openId === a.id ? "true" : undefined} aria-label={`Review ${it.name}`} onClick={() => setOpenId(a.id)}>
                        Review
                      </Button>
                      {!it.canDecide && <span className={v.faint}>{it.awaiting}</span>}
                    </div>
                  )}
                </div>
              );
            })
          )}
          </div>
        </Card>

        {open && openView ? (
          <DetailDrawer
            type={approvalLabel(open)}
            title={<ItemTitle a={open} it={openView} />}
            subjectKey={open.id}
            closeLabel="Close review"
            data-testid="inbox-item"
            meta={<ItemBadges a={open} it={openView} withKind={false} />}
            onClose={closeItem}
          >
            <p className={v.faint}>
              {humanize(open.objectType)} · requested by {open.requestedByName ?? "unknown"} · {ago(open.requestedAt)}
            </p>
            {openView.toolCall && <QuorumProgress approval={open} />}
            {openView.inst && <MergeGateEvidence inst={openView.inst} />}
            {open.contextConflict && <ConflictPreview conflict={open.contextConflict} />}
            {/* owner decision on #453: say so when the request carries no evidence, rather than leave the body blank.
                A workflow item whose evidence is still loading is not "no evidence", so it waits for the load */}
            {!openView.toolCall && !open.instanceId && !open.contextConflict ? (
              <p className={v.faint} data-testid="inbox-no-evidence">No evidence attached to this request.</p>
            ) : null}
            {/* L2 (ADR-0180): the reason warning, the reason and the decision stay together in the pinned footer */}
            {openView.canDecide ? (
              <DrawerActions>
                <div className={ib.pinned} data-testid="inbox-decision">
                  <ReasonWarning it={openView} />
                  {openView.controls(null)}
                </div>
              </DrawerActions>
            ) : <span className={v.faint}>{openView.awaiting}</span>}
          </DetailDrawer>
        ) : null}

        {annotationItems.length > 0 && <AnnotationsCard items={annotationItems} />}

        {decided.length > 0 && (
          <Card title="Recently decided" contain>
            {decided.map((a) => (
              <div key={a.id} className={v.listRow} style={{ alignItems: "center" }}>
                <div className={v.grow}>
                  <div style={{ fontSize: "var(--text-sm)" }}>
                    {approvalLabel(a)}
                    {a.objectLabel && <span className={v.faint}> · {isIntakeSignoff(a) ? intakeUseCaseName(a) : a.objectLabel}</span>}
                  </div>
                  <div className={v.faint}>
                    requested by {a.requestedByName ?? "unknown"} · decided by {a.decidedByName ?? "—"}
                    {a.decidedAt ? ` ${ago(a.decidedAt)}` : ""}
                    {a.decisionReason ? ` · “${a.decisionReason}”` : ""}
                  </div>
                </div>
                {a.status === "returned" ? <Badge tone="warn">sent back</Badge> : <StatusBadge status={a.status} />}
                {isBoundAction(a) && <McpActionReview approval={a} />}
              </div>
            ))}
          </Card>
        )}
      </div>
    </>
  );
}

interface ItemView {
  delegated: boolean;
  toolCall: boolean;
  canDecide: boolean;
  target: string | null;
  inst: WorkflowDetailResponse | undefined;
  intake: boolean;
  /** the Inbox's own reason rules apply (not a tool call, not an intake sign-off, which ReviewPanel decides) */
  ownRules: boolean;
  override: boolean;
  reasonRequired: boolean;
  controls: (blockedReason: string | null) => JSX.Element;
  awaiting: string;
  name: string;
  bound: boolean;
}

/** what kind of item, then the warnings that change how it is decided */
function ItemBadges(props: { a: Approval; it: ItemView; withKind?: boolean }) {
  const { a, it } = props;
  return (
    <div className={v.row}>
      {props.withKind === false ? null : <Badge>{approvalLabel(a)}</Badge>}
      {it.intake && <IntakeTier approval={a} />}
      {it.ownRules && a.selfReview && (
        <Badge tone="warn" infoLabel="Your own request" info="Deciding this would approve your own request, whether you are the named approver or received it through a delegation. A recorded reason is required.">
          Your own request
        </Badge>
      )}
      {it.delegated && (
        <Badge tone="info" infoLabel="a delegated decision" info={`Delegated to you: your decision is recorded on behalf of ${a.delegatedFrom}.`}>
          for {a.delegatedFrom}
        </Badge>
      )}
      {it.override && (
        <Badge tone="warn" infoLabel="Admin override" info="You are not the named approver, so a reason is required.">
          Admin override
        </Badge>
      )}
      {a.assignment?.dueAt ? <Badge tone="warn">{`Due ${shortDate(a.assignment.dueAt)}`}</Badge> : null}
    </div>
  );
}

function ItemTitle(props: { a: Approval; it: ItemView }) {
  const { a, it } = props;
  if (a.objectLabel) return <>{it.intake ? intakeUseCaseName(a) : it.target ? <Link to={it.target}>{a.objectLabel}</Link> : a.objectLabel}</>;
  return it.target ? <Link to={it.target}>{`View ${humanize(a.objectType)}`}</Link> : <>{approvalLabel(a)}</>;
}

function ReasonWarning(props: { it: ItemView }) {
  if (!props.it.reasonRequired) return null;
  return (
    <p className={ib.warning}>
      {props.it.override ? "You are not the named approver, so a reason is required." : "Deciding this approves your own request, so a reason is required."}
    </p>
  );
}

/**
 * G2: the EU AI Act tier pill in an intake sign-off's header. It reads the same use-case overview the review
 * drawer reads (one cache entry), and shows nothing when the reader may not open the use case record.
 */
function IntakeTier(props: { approval: Approval }) {
  const a = props.approval;
  const useCases = useQuery({
    queryKey: ["admin", "use-cases"],
    queryFn: () => api.get<{ useCases: Array<{ id: string; workflowInstanceId?: string | null }> }>("/v1/use-cases"),
    enabled: !a.useCaseId,
    retry: false,
  });
  const useCaseId = a.useCaseId ?? useCases.data?.useCases.find((u) => u.workflowInstanceId && u.workflowInstanceId === a.instanceId)?.id ?? null;
  const overview = useQuery({
    queryKey: ["governance", "use-case-overview", useCaseId],
    queryFn: () => api.get<OverviewResponse>(`/v1/use-cases/${useCaseId}/overview`),
    enabled: Boolean(useCaseId),
    retry: false,
  });
  const screening = overview.data?.screening;
  if (!screening) return null;
  if (!screening.screened || !screening.tier) return <Badge tone="warn">EU AI Act: not screened</Badge>;
  const tone = screening.tier === "prohibited" ? "danger" : screening.tier === "high" ? "warn" : "neutral";
  return <Badge tone={tone}>{`EU AI Act: ${humanize(screening.tier).toLowerCase()} tier`}</Badge>;
}

/** ADR-0173 batch 2c (Q): one row of GET /v1/annotations/inbox */
interface AnnotationInboxItem {
  id: string;
  queueName?: string;
  subjectKind: "trace" | "span" | "eval_result";
  requiredReviews: number;
  submissionCount: number;
  dueAt: string | null;
  slaBreached: boolean;
  createdAt: string;
}
const ANNOTATION_SUBJECT = { trace: "Trace", span: "Span", eval_result: "Eval result" } as const;

/** annotation items where I am a named reviewer and have not reviewed yet */
function AnnotationsCard(props: { items: AnnotationInboxItem[] }) {
  return (
    <Card title={`Annotations · ${props.items.length} to review`}>
      {props.items.map((i) => (
        <div key={i.id} className={v.listRow} style={{ alignItems: "center" }}>
          <div className={v.grow}>
            <div style={{ fontSize: "var(--text-sm)" }}>
              <Link to={`/inbox/annotations/${i.id}`}>
                {ANNOTATION_SUBJECT[i.subjectKind] ?? i.subjectKind} in {i.queueName ?? "a queue"}
              </Link>
            </div>
            <div className={v.faint}>
              {i.submissionCount} of {i.requiredReviews} review(s) · queued {ago(i.createdAt)}
              {i.dueAt ? ` · due ${shortDate(i.dueAt)}` : ""}
            </div>
          </div>
          {i.slaBreached && <Badge tone="danger">past deadline</Badge>}
        </div>
      ))}
    </Card>
  );
}

/** the merge-gate context: latest artifacts, PR/branch, recorded checks, dry-run honesty */
function MergeGateEvidence(props: { inst: WorkflowDetailResponse }) {
  const { inst } = props;
  const ctx = inst.instance.context ?? {};
  const latest: Record<string, { id: string; output: string; version: number; content: string }> = {};
  for (const art of inst.artifacts ?? []) {
    if (!latest[art.output] || art.version > latest[art.output]!.version) latest[art.output] = art;
  }
  const checkRows: CheckResult[] = Object.keys(ctx)
    .filter((k) => k.startsWith("checks:"))
    .flatMap((k) => (Array.isArray(ctx[k]) ? (ctx[k] as CheckResult[]) : []));
  const deploys = Object.keys(ctx)
    .filter((k) => k.startsWith("deploy:"))
    .map((k) => ctx[k] as { dryRun?: boolean });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s0)" }}>
      {Object.values(latest).map((art) => (
        <details key={art.id}>
          <summary className={v.faint} style={{ cursor: "pointer" }}>
            Submitted: {humanize(art.output)} (v{art.version})
          </summary>
          <div style={{ marginTop: "var(--s0)" }}>
            {art.output === "use_case_questionnaire" ? (
              <QuestionnaireView content={art.content} />
            ) : (
              <CodeBlock maxHeight="200px">{art.content}</CodeBlock>
            )}
          </div>
        </details>
      ))}
      {(typeof ctx.prUrl === "string" || typeof ctx.branch === "string") && (
        <div className={v.rowTight}>
          {typeof ctx.prUrl === "string" && ctx.prUrl && (
            <a className={v.mono} href={ctx.prUrl} target="_blank" rel="noopener noreferrer">
              {ctx.prUrl}
            </a>
          )}
          {ctx.prId != null && <Badge>#{String(ctx.prId)}</Badge>}
          {typeof ctx.branch === "string" && ctx.branch && <span className={v.mono}>{ctx.branch}</span>}
        </div>
      )}
      {checkRows.length > 0 && (
        <div className={v.rowTight}>
          {checkRows.map((c, i) => (
            <Badge
              key={`${c.check}-${i}`}
              // ADR-0167 (AUTHZ-06): a pass the initiator reported themselves is
              // not CI's colour — the approver sees that before signing off
              // AER-047: an auto-passed check was never run — nothing reported
              // it and the template's offline mode passed it; a pending one is
              // still waiting. Neither is CI's green.
              tone={
                c.selfReported || c.autoPassed || c.status === "pending"
                  ? "warn"
                  : c.status === "passed"
                    ? "ok"
                    : "danger"
              }
              title={
                c.autoPassed
                  ? "Auto-passed — no result was reported for this check (offline mode)"
                  : c.selfReported
                    ? `Reported by the change's own initiator, not by CI${c.reason ? ` — reason: ${c.reason}` : ""}${c.detail ? ` (${c.detail})` : ""}`
                    : (c.detail ?? "")
              }
            >
              {c.check} · {c.status}
              {c.autoPassed ? " · auto-passed (no report)" : ""}
              {c.selfReported ? " · self-reported" : ""}
            </Badge>
          ))}
        </div>
      )}
      {checkRows.some((c) => c.autoPassed) && (
        <div className={v.faint}>
          No result was reported for {checkRows.filter((c) => c.autoPassed).length} check(s) — the template's
          offline mode auto-passed them; nothing ran them.
        </div>
      )}
      {deploys.some((d) => d?.dryRun) && (
        <div className={v.rowTight}>
          <Badge tone="warn" infoLabel="a dry-run deploy" info="The recorded deploy was a dry run. Nothing was actually changed.">
            deploy was a dry-run
          </Badge>
        </div>
      )}
    </div>
  );
}

/** §9 arbitration is a choice between two texts — both sides visible */
function ConflictPreview(props: { conflict: NonNullable<Approval["contextConflict"]> }) {
  const c = props.conflict;
  return (
    <div>
      <div className={v.grid2}>
        <div>
          <div className={v.faint} style={{ marginBottom: "var(--s0)" }}>
            currently accepted · rev {c.current ? c.current.revision : "—"}
            {c.current?.byName ? ` · ${c.current.byName}` : ""}
          </div>
          <CodeBlock maxHeight="160px">{c.current ? c.current.content : "(none)"}</CodeBlock>
        </div>
        <div>
          <div className={v.faint} style={{ marginBottom: "var(--s0)" }}>
            proposed · rev {c.conflicting.revision}
            {c.conflicting.baseRevision != null ? ` (based on rev ${c.conflicting.baseRevision})` : ""}
            {c.conflicting.byName ? ` · ${c.conflicting.byName}` : ""}
          </div>
          <CodeBlock maxHeight="160px">{c.conflicting.content}</CodeBlock>
        </div>
      </div>
      <div className={v.faint} style={{ marginTop: "var(--s0)" }}>
        Approve makes the proposed revision the current value; deny keeps it retained in history,
        never current.
      </div>
    </div>
  );
}
