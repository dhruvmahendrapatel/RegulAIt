/**
 * Workflow detail — the stage rail, the action the current stage wants
 * (artifact submit / sign-off wait / trigger / failed checks / deploy hold),
 * artifacts, recorded check results, and the delivery card (branch, PR,
 * merge, deploy — dry-run badged honestly).
 */
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";
import type { CheckResult, WorkflowDetailResponse } from "../../api/types";
import { ago, humanize } from "../../api/format";
import { QuestionnaireView } from "../admin/governance/UseCaseQuestionnaire";
import { PageHeader } from "../../shell/AppShell";
import {
  Badge,
  Button,
  Card,
  CodeBlock,
  RecordError,
  IdChip,
  SkeletonBlock,
  StatusBadge,
} from "../../ui/kit";
import { useToast } from "../../ui/toast";
import { useSession } from "../../session/SessionContext";
import { DecisionLedgerCard, PmLinksCard } from "../pm/PmAndDecisions";
import v from "../views.module.css";
import s from "./workflows.module.css";

export default function WorkflowDetailPage() {
  const { instanceId } = useParams<{ instanceId: string }>();
  const { toast } = useToast();
  const { me } = useSession();
  const queryClient = useQueryClient();
  const [artifactText, setArtifactText] = useState("");
  const [deployReason, setDeployReason] = useState("");
  // ADR-0167 (AUTHZ-06): the initiator marking their own failed check as
  // passing is a self-attestation — the gateway refuses it without a reason
  const [checkReason, setCheckReason] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["workflow", instanceId],
    enabled: Boolean(instanceId),
    queryFn: () => api.get<WorkflowDetailResponse>(`/v1/workflows/instances/${instanceId}`),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["workflow", instanceId] });

  if (q.isLoading) {
    return (
      <>
        <PageHeader title="Workflow" />
        <Card>
          <SkeletonBlock lines={6} />
        </Card>
      </>
    );
  }
  if (q.isError || !q.data) {
    return (
      <>
        <PageHeader title="Workflow" />
        <Card>
          <RecordError
            noun="workflow"
            error={q.error}
            onRetry={() => void q.refetch()}
            action={<Link to="/workflows">← All workflows</Link>}
          />
        </Card>
      </>
    );
  }

  const { instance: inst, artifacts, pendingApprovals } = q.data;
  const def = inst.definition;
  const state = inst.state;
  const current = def.stages[state.currentStageIndex];
  const ctx = inst.context ?? {};
  const terminal = ["completed", "denied", "aborted"].includes(inst.status);

  const act = async (fn: () => Promise<unknown>, label: string) => {
    setActionError(null);
    try {
      await fn();
      toast(label, "success");
      void refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  const failedChecks: CheckResult[] =
    current && inst.status === "blocked_on_check"
      ? ((ctx[`checks:${current.id}`] as CheckResult[] | undefined) ?? []).filter(
          (c) => c.status === "failed",
        )
      : [];

  // AER-047: a check stage waiting on results it was never sent rests at
  // awaiting_execution — name the missing checks instead of "in flight"
  const pendingChecks: CheckResult[] =
    current && current.type === "automated_check" && inst.status === "awaiting_execution"
      ? ((ctx[`checks:${current.id}`] as CheckResult[] | undefined) ?? []).filter(
          (c) => c.status === "pending",
        )
      : [];

  const checkCards = def.stages
    .filter((st) => st.type === "automated_check" && ctx[`checks:${st.id}`])
    .map((st) => ({
      stage: st,
      results: (ctx[`checks:${st.id}`] as CheckResult[] | undefined) ?? [],
    }));

  const deployRow = Object.keys(ctx)
    .filter((k) => k.startsWith("deploy:"))
    .map((k) => ctx[k] as { target?: string; environment?: string; dryRun?: boolean })[0];
  const rollbackRow = Object.keys(ctx)
    .filter((k) => k.startsWith("rollback:"))
    .map((k) => ctx[k] as { reverted?: string })[0];
  const hasDelivery = Boolean(ctx.branch || ctx.prUrl || ctx.mergeSha || deployRow);

  return (
    <>
      <div style={{ marginBottom: "var(--s1)" }}>
        <Link to="/workflows">← All workflows</Link>
      </div>
      <PageHeader
        title={inst.change?.description ?? "untitled change"}
        sub={
          <span className={v.rowTight}>
            <StatusBadge status={inst.status} />
            <span>
              {inst.change?.changeType ?? ""} · {inst.change?.environment ?? ""} · created{" "}
              {ago(inst.createdAt)}
            </span>
            <IdChip id={inst.id} />
          </span>
        }
      />

      <div className={v.stack}>
        <Card title="Pipeline">
          <div className={s.stageRail}>
            {def.stages.map((stage, i) => {
              const st = String(state.stageStatuses[i] ?? "");
              const cls =
                i === state.currentStageIndex && !terminal
                  ? s.stageActive
                  : st === "completed" || st === "done"
                    ? s.stageDone
                    : st === "failed"
                      ? s.stageFailed
                      : s.stage;
              return (
                <span key={stage.id} className={cls} title={`${stage.id} · ${stage.type}`}>
                  {humanize(stage.id)}
                  <span className={s.stageType}>{humanize(stage.type)}</span>
                </span>
              );
            })}
          </div>
        </Card>

        {/* PILLAR 2 §2 stage 2 (ADR-0079): the plan-only stage, made visible.
            The card says what the stage forbids, what it still allows, and the
            one action that leaves it — the same shape as the deploy-hold and
            failed-check cards below. */}
        {inst.status === "blocked_on_plan" && current && (
          <Card title="Plan only">
            <span className={v.rowTight}>
              <Badge tone="warn">planning</Badge>
              <span className={v.dim}>
                this change is in forced planning — nothing builds from it yet.
              </span>
            </span>
            <div className={v.dim} style={{ marginTop: "var(--s2)" }}>
              While it rests at <span className={v.mono}>{current.id}</span>, an agent call that
              names this workflow (<span className={v.mono}>instanceId</span>) is <strong>refused
              in a mutating mode</strong> — <span className={v.mono}>execute</span>, or any mode
              not on the plan-safe list. <span className={v.mono}>plan</span>,{" "}
              <span className={v.mono}>review</span>, <span className={v.mono}>chat</span>,{" "}
              <span className={v.mono}>ask</span> and <span className={v.mono}>read</span> go
              through. A call that names no workflow is not constrained by this stage.
            </div>
            <div className={v.row} style={{ marginTop: "var(--s2)" }}>
              <Button
                variant="primary"
                title="Record that planning is finished and move to the next stage — build work attributed to this change stops being refused"
                onClick={() =>
                  void act(
                    () =>
                      api.post(`/v1/workflows/instances/${inst.id}/advance`, {
                        stageId: current.id,
                      }),
                    "Planning finished — plan-only lifted",
                  )
                }
              >
                Finish planning
              </Button>
            </div>
          </Card>
        )}

        {inst.status === "blocked_on_artifact" && current && (
          <Card title={`Submit ${current.output ?? "artifact"}`}>
            <textarea
              className={v.grow}
              style={{
                width: "100%",
                minHeight: 130,
                padding: "var(--s1)",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--border)",
                background: "var(--surface-1)",
                color: "var(--text)",
                font: "inherit",
                fontSize: "var(--text-sm)",
              }}
              placeholder={`Write the ${current.output ?? "artifact"} content…`}
              value={artifactText}
              onChange={(e) => setArtifactText(e.target.value)}
              aria-label="Artifact content"
            />
            <div className={v.row} style={{ marginTop: "var(--s1)" }}>
              <Button
                variant="primary"
                onClick={() =>
                  void act(
                    () =>
                      api.post(`/v1/workflows/instances/${inst.id}/artifacts`, {
                        stageId: current.id,
                        content: artifactText,
                      }),
                    "Artifact submitted — sign-off requested",
                  )
                }
              >
                Submit for sign-off
              </Button>
            </div>
          </Card>
        )}

        {inst.status === "blocked_on_approval" && (
          <Card>
            <span className={v.rowTight}>
              <Badge tone="warn">waiting for sign-off</Badge>
              <span className={v.dim}>
                awaiting{" "}
                {[...new Set((pendingApprovals ?? []).map((a) => a.approverName ?? "the named approver"))].join(
                  ", ",
                ) || "the named approver"}{" "}
                — it is in their inbox
              </span>
            </span>
          </Card>
        )}

        {inst.status === "awaiting_trigger" && current && (
          <Card>
            <Button
              variant="primary"
              onClick={() =>
                void act(
                  () => api.post(`/v1/workflows/instances/${inst.id}/advance`, { stageId: current.id }),
                  "Stage advanced",
                )
              }
            >
              Run {current.id}
            </Button>
          </Card>
        )}

        {inst.status === "awaiting_execution" && (
          <Card>
            <span className={v.rowTight}>
              {pendingChecks.length > 0 ? (
                <>
                  <Badge tone="warn">waiting on check results</Badge>
                  <span className={v.dim}>
                    no result has been reported for {pendingChecks.map((c) => c.check).join(", ")} — a check
                    nobody reported never passes; this stage continues when CI posts its results
                  </span>
                </>
              ) : (
                <>
                  <Badge tone="info">executing</Badge>
                  <span className={v.dim}>a nested run or git operation is in flight</span>
                </>
              )}
              {current && typeof ctx[`runId:${current.id}`] === "string" && (
                <Link to={`/runs/${ctx[`runId:${current.id}`]}`}>watch the run</Link>
              )}
            </span>
            {typeof ctx.lastError === "string" && ctx.lastError && (
              <div className={v.errLine} style={{ marginTop: "var(--s0)" }}>
                {ctx.lastError}
              </div>
            )}
          </Card>
        )}

        {inst.status === "blocked_on_check" &&
          current &&
          (() => {
            // ADR-0167 (AUTHZ-06): when the person marking a check passing is
            // the one who asked for the change, that is a self-attestation —
            // the gateway requires a recorded reason, stamps the result as
            // self-reported, and writes an audit row. An arm's-length admin
            // keeps the one-click action.
            const selfReporting = Boolean(me?.userId && me.userId === inst.initiatorUserId);
            const checkReasonMissing = selfReporting && !checkReason.trim();
            return (
              <Card>
                <span className={v.rowTight}>
                  <Badge tone="danger">checks failed</Badge>
                  <span className={v.dim}>
                    {failedChecks.map((c) => c.check).join(", ") || "a required check"} must pass before
                    this can proceed.
                  </span>
                </span>
                {selfReporting && (
                  <label className={v.dim} style={{ display: "block", marginTop: "var(--s2)" }}>
                    You initiated this change, so marking one of its own checks passing is a self-attestation
                    — record why it now passes (required, shown to approvers as “self-reported”):
                    <textarea
                      value={checkReason}
                      onChange={(e) => setCheckReason(e.target.value)}
                      rows={2}
                      style={{ display: "block", width: "100%", marginTop: "var(--s1)" }}
                      placeholder="e.g. re-ran the scan after upgrading lodash; CI run #412 is green"
                    />
                  </label>
                )}
                {failedChecks.map((c) => (
                  <div key={c.check} className={v.row} style={{ marginTop: "var(--s1)" }}>
                    <span className={v.mono}>{c.check}</span>
                    {c.severity && <Badge tone="warn">{c.severity}</Badge>}
                    <Button
                      size="sm"
                      disabled={checkReasonMissing}
                      title={
                        checkReasonMissing
                          ? "A recorded reason is required when the initiator marks their own check passing"
                          : "Record this check as remediated (reports a passing result)"
                      }
                      onClick={() =>
                        void act(
                          () =>
                            api.post(`/v1/workflows/instances/${inst.id}/checks`, {
                              stageId: current.id,
                              results: [{ check: c.check, status: "passed", detail: "remediated" }],
                              ...(checkReason.trim() ? { reason: checkReason.trim() } : {}),
                              // AER-048: bind the result to the round on screen —
                              // if the change was re-opened meanwhile, the
                              // gateway refuses it (409) instead of applying it
                              ...(typeof inst.round === "number" ? { round: inst.round } : {}),
                            }),
                          `Marked ${c.check} passing — re-run checks to proceed`,
                        )
                      }
                    >
                      mark passing
                    </Button>
                  </div>
                ))}
                <div className={v.row} style={{ marginTop: "var(--s2)" }}>
                  <Button
                    variant="primary"
                    onClick={() =>
                      void act(
                        () => api.post(`/v1/workflows/instances/${inst.id}/recheck`, { stageId: current.id }),
                        "Re-ran checks",
                      )
                    }
                  >
                    Re-run checks
                  </Button>
                </div>
              </Card>
            );
          })()}

        {inst.status === "blocked_on_deploy" &&
          current &&
          (() => {
            // Separation of duties (ADR-0022 amendment): clearing a parked
            // deploy is an ATTESTATION that it happened some other way. When
            // the person attesting also initiated the change, the gateway
            // refuses without a recorded reason — so the field is required
            // here for exactly that case, optional for an arm's-length
            // operator, and always recorded when given.
            const selfAttested = Boolean(me?.userId && me.userId === inst.initiatorUserId);
            const reasonMissing = selfAttested && !deployReason.trim();
            return (
              <Card>
                <span className={v.rowTight}>
                  <Badge tone="warn">deploy on hold</Badge>
                  <span className={v.dim}>
                    {typeof ctx.lastError === "string" && ctx.lastError
                      ? ctx.lastError
                      : "this deploy needs a manual handoff before it can proceed."}
                  </span>
                </span>
                <label className={v.dim} style={{ display: "block", marginTop: "var(--s2)" }}>
                  {selfAttested
                    ? "You initiated this change, so clearing its own deploy gate is a self-attestation — record how it was actually deployed (required):"
                    : "How was it deployed? (optional — recorded in the audit trail)"}
                  <textarea
                    value={deployReason}
                    onChange={(e) => setDeployReason(e.target.value)}
                    rows={2}
                    style={{ display: "block", width: "100%", marginTop: "var(--s1)" }}
                    placeholder="e.g. shipped by hand from the ops runbook; ticket OPS-411"
                  />
                </label>
                <div className={v.row} style={{ marginTop: "var(--s2)" }}>
                  <Button
                    variant="primary"
                    disabled={reasonMissing}
                    title={
                      reasonMissing
                        ? "A recorded reason is required when the initiator clears their own deploy gate"
                        : "Confirm the deploy was handled out-of-band (or the condition is acceptable) and advance"
                    }
                    onClick={() =>
                      void act(
                        () =>
                          api.post(`/v1/workflows/instances/${inst.id}/deploy-override`, {
                            stageId: current.id,
                            ...(deployReason.trim() ? { reason: deployReason.trim() } : {}),
                          }),
                        "Deploy handed off — continuing",
                      )
                    }
                  >
                    Mark deployed &amp; continue
                  </Button>
                </div>
              </Card>
            );
          })()}

        {inst.status === "rolled_back" && (
          <Card>
            <span className={v.rowTight}>
              <Badge tone="danger">rolled back</Badge>
              <span className={v.dim}>
                a post-deploy check failed and the deployment was reversed
                {rollbackRow?.reverted ? ` (${rollbackRow.reverted})` : ""}. This run is closed.
              </span>
            </span>
          </Card>
        )}

        {actionError && (
          <div className={v.errLine} role="alert">
            {actionError}
          </div>
        )}

        {(artifacts?.length ?? 0) > 0 && (
          <Card title="Artifacts">
            {artifacts!.map((a) => (
              <details key={a.id} style={{ marginBottom: "var(--s1)" }}>
                <summary className={v.dim} style={{ cursor: "pointer" }}>
                  {humanize(a.output)} (v{a.version})
                </summary>
                <div style={{ marginTop: "var(--s0)" }}>
                  {a.output === "use_case_questionnaire" ? (
                    <QuestionnaireView content={a.content} />
                  ) : (
                    <CodeBlock maxHeight="260px">{a.content}</CodeBlock>
                  )}
                </div>
              </details>
            ))}
          </Card>
        )}

        {checkCards.map(({ stage, results }) => (
          <Card key={stage.id} title={`Checks · ${stage.id}`}>
            {results.map((c) => (
              <div key={c.check} className={v.listRow} style={{ alignItems: "center" }}>
                <span className={v.mono}>{c.check}</span>
                {c.severity && <Badge tone="warn">{c.severity}</Badge>}
                {c.selfReported && (
                  <Badge
                    tone="warn"
                    title={
                      c.reason
                        ? `Reported by the change's own initiator, not by CI — their recorded reason: ${c.reason}`
                        : "Reported by the change's own initiator, not by CI"
                    }
                  >
                    self-reported
                  </Badge>
                )}
                {c.autoPassed && (
                  <Badge
                    tone="warn"
                    title="Nothing reported a result for this check — the template's offline mode passed it (offlineAutoPass)"
                  >
                    auto-passed · no report
                  </Badge>
                )}
                <span className={v.faint}>{c.detail ?? ""}</span>
                <span className={v.grow} />
                <StatusBadge status={c.status} />
              </div>
            ))}
          </Card>
        ))}

        {hasDelivery && (
          <Card title="Delivery">
            {typeof ctx.branch === "string" && ctx.branch && (
              <div className={v.row}>
                <span className={s.deliveryKey}>branch</span>
                <span className={v.mono}>{ctx.branch}</span>
              </div>
            )}
            {typeof ctx.prUrl === "string" && ctx.prUrl && (
              <div className={v.row} style={{ marginTop: "var(--s0)" }}>
                <span className={s.deliveryKey}>pull request</span>
                <a className={v.mono} href={ctx.prUrl} target="_blank" rel="noopener noreferrer">
                  {ctx.prUrl}
                </a>
                {ctx.prId != null && <Badge>#{String(ctx.prId)}</Badge>}
              </div>
            )}
            {typeof ctx.mergeSha === "string" && ctx.mergeSha && (
              <div className={v.row} style={{ marginTop: "var(--s0)" }}>
                <span className={s.deliveryKey}>merged</span>
                <span className={v.mono}>{ctx.mergeSha}</span>
                <Badge tone="ok">merged</Badge>
              </div>
            )}
            {deployRow && (
              <div className={v.row} style={{ marginTop: "var(--s0)" }}>
                <span className={s.deliveryKey}>deployed</span>
                <span className={v.mono}>
                  {deployRow.target}
                  {deployRow.environment ? ` · ${deployRow.environment}` : ""}
                </span>
                {deployRow.dryRun && (
                  <Badge
                    tone="warn"
                    title="The deploy adapter ran in dry-run mode — nothing was actually mutated on the target. A dry-run never satisfies a production deploy gate."
                  >
                    dry-run
                  </Badge>
                )}
                {rollbackRow ? (
                  <Badge tone="danger">rolled back</Badge>
                ) : deployRow.dryRun ? null : (
                  <Badge tone="ok">live</Badge>
                )}
              </div>
            )}
          </Card>
        )}

        {/* PILLAR 8: this instance mapped onto the customer's own work item,
            and PILLAR 4's decision ledger for it. Same components the run
            detail uses — one backend contract, one implementation. */}
        <PmLinksCard parent={{ objectType: "workflow_instance", objectId: instanceId! }} />
        <DecisionLedgerCard parent={{ objectType: "workflow_instance", objectId: instanceId! }} />
      </div>
    </>
  );
}
