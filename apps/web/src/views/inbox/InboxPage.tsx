/**
 * Inbox — everything that pauses for the signed-in human: workflow sign-offs
 * (with the merge-gate evidence: submitted artifacts, PR link, recorded check
 * results, dry-run honesty), run escalations, budget overages, context
 * conflicts (both texts side by side), and delegated items. Approve/deny with
 * reasons; admin overrides and self-reviews require one.
 */
import { useMemo, useState } from "react";
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
  Input,
  SkeletonBlock,
  StatusBadge,
} from "../../ui/kit";
import { useToast } from "../../ui/toast";
import { McpActionReview } from "../approvals/McpActionReview";
import { inspectApprovalAction, isBoundAction } from "../approvals/approvalReview";
import { ReviewPanel } from "../approvals/ReviewPanel";
import { intakeUseCaseName, isIntakeSignoff } from "../approvals/reviewDecision";
import { QuorumProgress } from "../approvals/QuorumProgress";
import { decideApproval, isToolCallApproval, signatureModeOf, signedDecisionErrorText } from "../approvals/signedDecision";
import { shortDate } from "../admin/governance/useCaseLifecycle";
import v from "../views.module.css";

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
      toast(decision === "approved" ? "Approved" : "Denied", "success");
      void queryClient.invalidateQueries({ queryKey: ["approvals"] });
    } catch (e) {
      setRowErrors((er) => ({ ...er, [a.id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setDeciding(null);
    }
  };

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
      />
      <div className={v.stack}>
        <Card>
          {pending.length === 0 ? (
            <EmptyState
              title={annotationItems.length > 0 ? "No sign-offs waiting on you" : "Nothing waiting on you"}
              body="When a governed action needs your decision it appears here — and the requester is unblocked the moment you decide."
            />
          ) : (
            pending.map((a) => {
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
              const controls = (blockedReason: string | null) => <div className={v.row} style={{ flexWrap: "wrap" }}>
                {toolCall && signatureModeOf(a) === "passkey" && (
                  <span className={v.faint} title="Your browser asks for your passkey: the signature covers this exact call">
                    signs with your passkey
                  </span>
                )}
                <Input style={{ maxWidth: 260 }}
                  placeholder={named || delegated || toolCall ? "reason (optional)" : "reason (required - admin override)"}
                  aria-label="Decision reason" value={reasons[a.id] ?? ""}
                  onChange={(e) => setReasons((r) => ({ ...r, [a.id]: e.target.value }))} />
                <Button size="sm" disabled={deciding === a.id || !!blockedReason} onClick={() => void decide(a, "approved")}>Approve</Button>
                <Button size="sm" variant="ghost" disabled={deciding === a.id} onClick={() => void decide(a, "denied")}>Deny</Button>
                {rowErrors[a.id] && <div className={v.errLine} role="alert">{rowErrors[a.id]}</div>}
              </div>;
              return (
                <div key={a.id} className={v.listRow} style={{ flexDirection: "column", alignItems: "stretch", gap: "var(--s1)" }}>
                  <div className={v.row}>
                    <span className={v.grow} style={{ fontWeight: 550, fontSize: "var(--text-sm)" }}>
                      {approvalLabel(a)}
                      {a.objectLabel && (
                        <>
                          {" · "}
                          {intake ? intakeUseCaseName(a) : target ? <Link to={target}>{a.objectLabel}</Link> : a.objectLabel}
                        </>
                      )}
                      {!a.objectLabel && target && (
                        <>
                          {" · "}
                          <Link to={target}>view {a.objectType}</Link>
                        </>
                      )}
                    </span>
                    {!toolCall && a.selfReview && (
                      <Badge tone="warn" title="Deciding this would approve your own request — whether you are the named approver or received it through a delegation, a recorded reason is required">
                        self-review
                      </Badge>
                    )}
                    {delegated && (
                      <Badge tone="info" title={`Delegated to you — your decision is recorded on behalf of ${a.delegatedFrom}`}>
                        for {a.delegatedFrom}
                      </Badge>
                    )}
                    {!toolCall && !named && !delegated && auth?.isAdmin && (
                      <Badge tone="warn" title="You are not the named approver — a reason is required">
                        override
                      </Badge>
                    )}
                  </div>
                  <div className={v.faint}>
                    {intake ? "Use case" : a.objectType} · requested by {a.requestedByName ?? "unknown"} · {ago(a.requestedAt)}
                    {a.assignment?.dueAt ? ` · due ${shortDate(a.assignment.dueAt)}` : ""}
                  </div>
                  {intake ? (
                    <div className={v.row}>
                      <ReviewPanel approval={a} />
                      {!canDecide && <span className={v.faint}>awaiting {a.approverName ?? "the named approver"}</span>}
                    </div>
                  ) : <>
                  {toolCall && <QuorumProgress approval={a} />}
                  {inst && <MergeGateEvidence inst={inst} />}
                  {a.contextConflict && <ConflictPreview conflict={a.contextConflict} />}
                  {canDecide ? (
                    isBoundAction(a) ? <McpActionReview approval={a} controls={controls} /> : controls(null)
                  ) : (
                    <>
                      {isBoundAction(a) && <McpActionReview approval={a} />}
                      <span className={v.faint}>
                        {toolCall && a.myDecision
                          ? `you ${a.myDecision} this — waiting for another approver`
                          : toolCall && a.userId === me
                            ? "your own call — someone else in the approver pool decides it"
                            : `awaiting ${a.approverName ?? "the named approver"}`}
                      </span>
                    </>
                  )}
                  </>}
                </div>
              );
            })
          )}
        </Card>

        {annotationItems.length > 0 && <AnnotationsCard items={annotationItems} />}

        {decided.length > 0 && (
          <Card title="Recently decided">
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
          <Badge tone="warn" title="The recorded deploy was a dry-run — nothing was actually mutated">
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
