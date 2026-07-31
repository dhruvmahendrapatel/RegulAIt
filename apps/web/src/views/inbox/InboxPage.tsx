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
import { ago, approvalStageLabel } from "../../api/format";
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
import v from "../views.module.css";

const approvalLabel = (a: Approval): string => {
  const sentinel = approvalStageLabel(a);
  if (sentinel) return sentinel;
  if (a.objectType === "infra_operation")
    return "Infra remediation" + (a.objectLabel ? ` · ${a.objectLabel}` : "");
  return (
    (a.objectType === "workflow" ? "Sign-off · " : a.objectType === "run" ? "Run escalation · " : "") +
    (a.stageId ?? "")
  );
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
    const reason = (reasons[a.id] ?? "").trim();
    const named = me === a.approverUserId;
    const delegated = Boolean(a.delegatedFrom);
    setRowErrors((e) => ({ ...e, [a.id]: "" }));
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
        [a.id]: "This is a self-review (the approver is the requesting user) — a reason is required.",
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
              title="Nothing waiting on you"
              body="When a governed action needs your decision it appears here — and the requester is unblocked the moment you decide."
            />
          ) : (
            pending.map((a) => {
              const named = me === a.approverUserId;
              const delegated = Boolean(a.delegatedFrom);
              const canDecide = named || delegated || Boolean(auth?.isAdmin);
              const target = approvalTarget(a);
              const inst = a.instanceId ? instances[a.instanceId] : undefined;
              return (
                <div key={a.id} className={v.listRow} style={{ flexDirection: "column", alignItems: "stretch", gap: "var(--s1)" }}>
                  <div className={v.row}>
                    <span className={v.grow} style={{ fontWeight: 550, fontSize: "var(--text-sm)" }}>
                      {approvalLabel(a)}
                      {a.objectLabel && (
                        <>
                          {" · "}
                          {target ? <Link to={target}>{a.objectLabel}</Link> : a.objectLabel}
                        </>
                      )}
                      {!a.objectLabel && target && (
                        <>
                          {" · "}
                          <Link to={target}>view {a.objectType}</Link>
                        </>
                      )}
                    </span>
                    {a.selfReview && (
                      <Badge tone="warn" title="The approver is the user who triggered the governed action — deciding requires a recorded reason">
                        self-review
                      </Badge>
                    )}
                    {delegated && (
                      <Badge tone="info" title={`Delegated to you — your decision is recorded on behalf of ${a.delegatedFrom}`}>
                        for {a.delegatedFrom}
                      </Badge>
                    )}
                    {!named && !delegated && auth?.isAdmin && (
                      <Badge tone="warn" title="You are not the named approver — a reason is required">
                        override
                      </Badge>
                    )}
                  </div>
                  <div className={v.faint}>
                    {a.objectType} · requested by {a.requestedByName ?? "unknown"} · {ago(a.requestedAt)}
                  </div>
                  {inst && <MergeGateEvidence inst={inst} />}
                  {a.contextConflict && <ConflictPreview conflict={a.contextConflict} />}
                  {canDecide ? (
                    <div className={v.row}>
                      <Input
                        style={{ maxWidth: 260 }}
                        placeholder={
                          named || delegated ? "reason (optional)" : "reason (required — admin override)"
                        }
                        aria-label="Decision reason"
                        value={reasons[a.id] ?? ""}
                        onChange={(e) => setReasons((r) => ({ ...r, [a.id]: e.target.value }))}
                      />
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={deciding === a.id}
                        onClick={() => void decide(a, "approved")}
                      >
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={deciding === a.id}
                        onClick={() => void decide(a, "denied")}
                      >
                        Deny
                      </Button>
                    </div>
                  ) : (
                    <span className={v.faint}>awaiting {a.approverName ?? "the named approver"}</span>
                  )}
                  {rowErrors[a.id] && (
                    <div className={v.errLine} role="alert">
                      {rowErrors[a.id]}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </Card>

        {decided.length > 0 && (
          <Card title="Recently decided">
            {decided.map((a) => (
              <div key={a.id} className={v.listRow} style={{ alignItems: "center" }}>
                <div className={v.grow}>
                  <div style={{ fontSize: "var(--text-sm)" }}>
                    {approvalLabel(a)}
                    {a.objectLabel && <span className={v.faint}> · {a.objectLabel}</span>}
                  </div>
                  <div className={v.faint}>
                    requested by {a.requestedByName ?? "unknown"} · decided by {a.decidedByName ?? "—"}
                    {a.decidedAt ? ` ${ago(a.decidedAt)}` : ""}
                    {a.decisionReason ? ` · “${a.decisionReason}”` : ""}
                  </div>
                </div>
                <StatusBadge status={a.status} />
              </div>
            ))}
          </Card>
        )}
      </div>
    </>
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
            submitted {art.output} v{art.version}
          </summary>
          <div style={{ marginTop: "var(--s0)" }}>
            <CodeBlock maxHeight="200px">{art.content}</CodeBlock>
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
            <Badge key={`${c.check}-${i}`} tone={c.status === "passed" ? "ok" : "danger"} title={c.detail ?? ""}>
              {c.check} · {c.status}
            </Badge>
          ))}
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
