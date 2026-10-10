/**
 * ADR-0187 (batch 5, X27) — sidecar engine runs on the Red-teaming and
 * Evaluations pages (AgentCoordination §4.10, ADR-0177 §3: run surfaces live on
 * the existing pages, the Engines page only administers engines).
 *
 * Three parts: a run form (an enabled engine against an agent target), the run
 * list, and the run detail (status, live heartbeat and cancel, the summary, the
 * items, the not-run list with reasons, and the engine provenance chip).
 *
 * What it keeps honest:
 *  - **Approval is the server's decision, shown, never bypassed.** A run that
 *    uses an agentic, offensive or unlisted set, or a budget over the approval
 *    threshold, comes back `awaiting_approval`; the page says so and points at
 *    the Approvals Queue. Nothing here approves or re-submits around it.
 *  - **`not_run` and `unknown` are never a pass** (engineRuns.ts).
 *  - **No raw model text.** Only the structured fields `engineRunItemView`
 *    copies are rendered; the raw report is never fetched (no route serves it).
 */
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { ApiError, api } from "../../../api/client";
import { UUID_RE, ago, fmtUsd } from "../../../api/format";
import { Badge, Button, Card, ConfirmModal, EmptyState, Field, IdChip, Input, Meter, Select, SeverityBadge, Table } from "../../../ui/kit";
import {
  KV,
  OutcomePanel,
  agentOpts,
  optionEls,
  projectOpts,
  useAgents,
  useApiAction,
  useProjects,
  useUserPicker,
  userOpts,
} from "../adminKit";
import { EngineProvenanceChip, EngineRunStatusBadge, EngineVerdictBadge } from "./EngineRunBadges";
import {
  RUN_END_TEXT,
  engineRunItemView,
  heartbeatState,
  isLiveStatus,
  notRunReasonText,
  runFormProblem,
  runProvenance,
  runRequestBody,
  ENGINE_RUN_PARAM,
  runCoverage,
  runVerdict,
  withEngineRun,
  until,
  type EngineInfo,
  type EngineRun,
  type EngineRunItem,
  type RunFormInput,
} from "./engineRuns";
import a from "../admin.module.css";
import er from "./engineRuns.module.css";
import v from "../../views.module.css";

export type EngineSurface = "redteam" | "evals";

/** query keys (the ["admin", …] prefix so a write's invalidate refreshes them) */
export const engineRunKeys = {
  engines: ["admin", "engines"] as const,
  runs: ["admin", "engine-runs"] as const,
  run: (id: string) => ["admin", "engine-run", id] as const,
};

/** polling while something is live: the detail every 5 s, the list every 10 s */
const DETAIL_POLL_MS = 5_000;
const LIST_POLL_MS = 10_000;

const EMPTY_FORM: RunFormInput = {
  engineId: "",
  agentId: "",
  judgeAgentId: "",
  projectId: "",
  sets: "",
  trials: "3",
  budgetUsd: "",
  approverUserId: "",
};

export function EngineRunsPanel(props: { surface: EngineSurface }) {
  const agents = useAgents();
  const projects = useProjects();
  const users = useUserPicker();
  const start = useApiAction();
  const cancel = useApiAction();

  const engines = useQuery({
    queryKey: engineRunKeys.engines,
    queryFn: () => api.get<{ engines: EngineInfo[]; taxonomyVersion: number }>("/v1/engines"),
  });
  const runs = useQuery({
    queryKey: engineRunKeys.runs,
    queryFn: () => api.get<{ runs: EngineRun[] }>("/v1/engine-runs?limit=100"),
    refetchInterval: (q) => ((q.state.data?.runs ?? []).some((r) => isLiveStatus(r.status)) ? LIST_POLL_MS : false),
  });
  // B5W-05: the open run lives in the URL (`?run=<id>`), so it can be linked,
  // reloaded and walked with Back/Forward; other query fields are kept
  const [params, setParams] = useSearchParams();
  const selectedRun = params.get(ENGINE_RUN_PARAM) ?? "";
  const selectedValid = UUID_RE.test(selectedRun);
  const setSelectedRun = (id: string) => setParams((prev) => withEngineRun(prev, id, props.surface));
  const detail = useQuery({
    queryKey: engineRunKeys.run(selectedRun),
    enabled: selectedValid,
    queryFn: () => api.get<{ run: EngineRun; items: unknown[] }>(`/v1/engine-runs/${selectedRun}`),
    refetchInterval: (q) => (q.state.data && isLiveStatus(q.state.data.run.status) ? DETAIL_POLL_MS : false),
  });

  const [form, setForm] = useState<RunFormInput>(EMPTY_FORM);
  const set = (k: keyof RunFormInput) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const [started, setStarted] = useState<{ run: EngineRun; approvalId: string | null } | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelReason, setCancelReason] = useState("");

  // the run surfaces take agent-target engines; a model scan lives in Admission review (X28)
  const agentEngines = (engines.data?.engines ?? []).filter((e) => e.kind !== "model_scan");
  const enabledEngines = agentEngines.filter((e) => e.enabled);
  const offEngines = agentEngines.filter((e) => !e.enabled);
  const engineById = new Map((engines.data?.engines ?? []).map((e) => [e.id, e]));
  const agentName = new Map((agents.data?.agents ?? []).map((x) => [x.id, x.name]));
  const projectName = new Map((projects.data?.projects ?? []).map((p) => [p.id, p.name]));
  const agentRuns = (runs.data?.runs ?? []).filter((r) => r.targetKind !== "artifact");
  const problem = runFormProblem(form);
  const chosen = engineById.get(form.engineId);

  const startRun = async () => {
    const out = await start.run(
      () => api.post<{ run: EngineRun; approvalId: string | null }>("/v1/engine-runs", runRequestBody(form)),
      "Engine run requested",
    );
    if (out) {
      setStarted(out);
      setSelectedRun(out.run.id);
      await runs.refetch();
    }
  };

  const detailRun = detail.data?.run;
  const items = (detail.data?.items ?? []).map(engineRunItemView);

  return (
    <>
      <Card title="Run an engine">
        <p className={v.faint}>
          A sidecar engine runs its sets against an agent through the same governed path as real traffic, on a run-scoped
          key billed to the project you choose. A run that uses an agentic, offensive or unlisted set, or a budget over the
          organisation&apos;s approval threshold, waits in the <Link className={er.inlineLink} to="/admin/approvals">Approvals Queue</Link> and does
          not start until an approver decides.
        </p>
        {engines.isLoading ? (
          <p className={v.faint}>Loading engines…</p>
        ) : engines.error ? (
          <div className={v.errLine} role="alert">
            Couldn&apos;t load the engines: {engines.error instanceof Error ? engines.error.message : String(engines.error)}{" "}
            <Button size="sm" onClick={() => void engines.refetch()}>
              Retry
            </Button>
          </div>
        ) : enabledEngines.length === 0 ? (
          <EmptyState
            title="No engine is enabled"
            body={
              <>
                An admin enables an engine on the <Link className={er.inlineLink} to="/admin/engines">Engines page</Link> once its runner&apos;s
                self-test passes. Every engine is off until then.
              </>
            }
          />
        ) : (
          <form
            className={a.formRow}
            data-testid="engine-run-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!problem) void startRun();
            }}
          >
            <Field label="Engine">
              <Select value={form.engineId} onChange={set("engineId")} required>
                {optionEls(
                  enabledEngines.map((e) => ({ v: e.id, l: `${e.displayName} ${e.version}` })),
                  "Select an engine",
                )}
              </Select>
            </Field>
            <Field label="Agent under test">
              <Select value={form.agentId} onChange={set("agentId")} required>
                {optionEls(agentOpts(agents.data?.agents), "Select an agent")}
              </Select>
            </Field>
            <Field label="Judge agent" help="Engines that grade with a judge (promptfoo) refuse a run without one. The judge runs on the same run-scoped key.">
              <Select value={form.judgeAgentId} onChange={set("judgeAgentId")}>
                {optionEls(agentOpts(agents.data?.agents), "No judge")}
              </Select>
            </Field>
            <Field label="Bill to project">
              <Select value={form.projectId} onChange={set("projectId")} required>
                {optionEls(projectOpts(projects.data?.projects), "Select a project")}
              </Select>
            </Field>
            <Field
              label="Sets"
              grow
              help="The engine's named plugin or probe sets, separated by commas. The server classes each one: any agentic, offensive or unlisted set sends the run for approval."
            >
              <Input value={form.sets} onChange={set("sets")} placeholder="e.g. basic" required />
            </Field>
            <Field label="Trials">
              <Input type="number" min={1} max={25} step={1} value={form.trials} onChange={set("trials")} required />
            </Field>
            <Field label="Budget (USD)" help={chosen ? `Blank uses the organisation default. This engine's ceiling is ${fmtUsd(chosen.maxBudgetUsd)}; a budget over the approval threshold waits for approval.` : "Blank uses the organisation default."}>
              <Input type="number" min={0.01} step={0.01} value={form.budgetUsd} onChange={set("budgetUsd")} placeholder="org default" />
            </Field>
            <Field label="Approver (if approval is needed)" help="Blank uses the organisation's infrastructure approver. You cannot approve your own run.">
              <Select value={form.approverUserId} onChange={set("approverUserId")}>
                {optionEls(userOpts(users.data?.users), "Organisation default")}
              </Select>
            </Field>
            <Button type="submit" variant="primary" disabled={start.busy || problem !== null}>
              Start engine run
            </Button>
          </form>
        )}
        {enabledEngines.length > 0 && problem && (
          <p className={v.faint} data-testid="engine-run-problem">
            {problem}
          </p>
        )}
        {offEngines.length > 0 && (
          <p className={v.faint} data-testid="engines-off">
            Off: {offEngines.map((e) => `${e.displayName} ${e.version}`).join(", ")}. An admin enables an engine on the{" "}
            <Link className={er.inlineLink} to="/admin/engines">Engines page</Link>.
          </p>
        )}
        {start.outcome && !start.outcome.ok && <OutcomePanel outcome={start.outcome} testId="engine-run-refusal" />}
        {started && start.outcome?.ok && <StartedNotice run={started.run} approvalId={started.approvalId} />}
      </Card>

      <Card title="Engine runs">
        <Table
          rows={agentRuns}
          loading={runs.isLoading}
          error={runs.error}
          onRetry={() => void runs.refetch()}
          rowKey={(r) => r.id}
          onRowClick={(r) => setSelectedRun(r.id)}
          rowLabel={(r) => `Engine run ${r.engineId}, ${r.status.replaceAll("_", " ")}, id ${r.id}`}
          empty={<EmptyState title="No engine runs yet" body="Start one above once an engine is enabled." />}
          columns={[
            { key: "engine", header: "Engine", render: (r) => `${engineById.get(r.engineId)?.displayName ?? r.engineId} ${r.engineVersion}` },
            { key: "status", header: "Status", render: (r) => <EngineRunStatusBadge status={r.status} /> },
            {
              key: "verdict",
              header: "Verdict",
              render: (r) => {
                const vd = runVerdict(r);
                return vd ? <EngineVerdictBadge verdict={vd} /> : <span className={v.faint}>no result yet</span>;
              },
            },
            { key: "target", header: "Target", render: (r) => (r.targetAgentId ? (agentName.get(r.targetAgentId) ?? r.targetAgentId.slice(0, 8)) : "—") },
            { key: "sets", header: "Sets", render: (r) => (r.config?.sets ?? []).join(", ") || "—" },
            { key: "trigger", header: "Trigger", render: (r) => r.trigger },
            { key: "cost", header: "Cost", render: (r) => fmtUsd(r.costUsd) },
            { key: "when", header: "Created", render: (r) => ago(r.createdAt) },
          ]}
        />
      </Card>

      {selectedRun && (
        <Card
          title={
            <span className={v.row}>
              Engine run detail <IdChip id={selectedRun} />
            </span>
          }
        >
          {!selectedValid || (detail.error instanceof ApiError && (detail.error.status === 404 || detail.error.status === 403)) ? (
            <div className={v.errLine} role="alert" data-testid="engine-run-unavailable">
              This engine run is unavailable: {selectedValid ? "it does not exist or you cannot see it" : "the link does not name a valid run"}.{" "}
              <Button size="sm" onClick={() => setParams((prev) => withEngineRun(prev, null, props.surface))}>
                Close
              </Button>
            </div>
          ) : detail.isLoading ? (
            <p className={v.faint}>Loading the run…</p>
          ) : detail.error ? (
            <div className={v.errLine} role="alert">
              Couldn&apos;t load this run: {detail.error instanceof Error ? detail.error.message : String(detail.error)}{" "}
              <Button size="sm" onClick={() => void detail.refetch()}>
                Retry
              </Button>
            </div>
          ) : detailRun ? (
            <>
              <EngineRunDetailView
                surface={props.surface}
                run={detailRun}
                items={items}
                engine={engineById.get(detailRun.engineId)}
                agentName={agentName}
                projectName={projectName}
                onCancel={() => setConfirmCancel(true)}
                cancelBusy={cancel.busy}
              />
              {cancel.outcome && !cancel.outcome.ok && <OutcomePanel outcome={cancel.outcome} testId="engine-cancel-refusal" />}
            </>
          ) : null}
        </Card>
      )}

      <ConfirmModal
        open={confirmCancel}
        title="Cancel this engine run?"
        danger
        confirmLabel="Cancel the run"
        body={
          <div className={v.stack}>
            <p>
              The run ends as cancelled at once and its run-scoped key is revoked: any call the engine makes after this is
              refused. The runner learns on its next heartbeat. A pending approval is superseded. This cannot be undone.
            </p>
            <Field label="Reason (optional, audited)">
              <Input value={cancelReason} maxLength={500} onChange={(e) => setCancelReason(e.target.value)} />
            </Field>
          </div>
        }
        onCancel={() => setConfirmCancel(false)}
        onConfirm={() => {
          setConfirmCancel(false);
          const reason = cancelReason.trim();
          setCancelReason("");
          void cancel
            .run(() => api.post(`/v1/engine-runs/${selectedRun}/cancel`, reason ? { reason } : {}), "Engine run cancelled; its key is revoked")
            .then(async () => {
              await detail.refetch();
              await runs.refetch();
            });
        }}
      />
    </>
  );
}

/** what the person sees right after starting a run: queued, or waiting for approval */
function StartedNotice(props: { run: EngineRun; approvalId: string | null }) {
  const waiting = props.run.status === "awaiting_approval";
  return (
    <div className={[a.outcome, a.outcomeOk].join(" ")} role="status" data-testid="engine-run-started">
      <div className={v.row}>
        <EngineRunStatusBadge status={props.run.status} />
        <IdChip id={props.run.id} />
      </div>
      {waiting ? (
        <p>
          This run needs approval: it uses an agentic, offensive or unlisted set, or its budget is over the approval
          threshold. It will not start until an approver decides in the <Link className={er.inlineLink} to="/admin/approvals">Approvals Queue</Link>
          {props.approvalId ? <> (approval <IdChip id={props.approvalId} />)</> : null}. A refusal ends it as not run.
        </p>
      ) : (
        <p>Queued for a runner. A run nobody leases within 24 hours ends as not run.</p>
      )}
    </div>
  );
}

/**
 * The run detail, from props only (so it renders, and is tested, without a
 * query client). Renders the allow-listed item fields and nothing else.
 */
export function EngineRunDetailView(props: {
  surface: EngineSurface;
  run: EngineRun;
  items: EngineRunItem[];
  engine: EngineInfo | undefined;
  agentName?: Map<string, string>;
  projectName?: Map<string, string>;
  onCancel?: () => void;
  cancelBusy?: boolean;
  now?: number;
}) {
  const { run, items } = props;
  const verdict = runVerdict(run);
  const hb = heartbeatState(run, props.now);
  const live = isLiveStatus(run.status);
  const counts = run.summary?.counts;
  const notRunItems = items.filter((i) => i.verdict === "not_run");
  const coverage = runCoverage(run, items);
  const name = (m: Map<string, string> | undefined, id: string | null) => (id ? (m?.get(id) ?? id.slice(0, 8)) : "—");
  const endCode = run.errorCode;
  const rows: Array<[ReactNode, ReactNode]> = [
    ["Status", <EngineRunStatusBadge key="s" status={run.status} />],
    ["Verdict", verdict ? <EngineVerdictBadge key="v" verdict={verdict} /> : <span className={v.faint}>no result yet</span>],
    ["Target agent", name(props.agentName, run.targetAgentId)],
    ["Judge agent", name(props.agentName, run.judgeAgentId)],
    ["Project", name(props.projectName, run.projectId)],
    ["Sets", (run.config?.sets ?? []).join(", ") || "—"],
    ["Trials", run.trials],
    ["Budget / spent", `${fmtUsd(run.budgetUsd)} / ${fmtUsd(run.costUsd)}`],
    ["Trigger", run.trigger],
    ["Created", ago(run.createdAt)],
    ["Finished", run.finishedAt ? ago(run.finishedAt) : "—"],
  ];
  if (endCode)
    rows.push([
      "Ended because",
      <span key="e">
        <code>{endCode}</code> {RUN_END_TEXT[endCode] ? <span className={v.faint}>{RUN_END_TEXT[endCode]}</span> : null}
      </span>,
    ]);
  if (run.configHash) rows.push(["Configuration hash", <code key="h">{run.configHash.slice(0, 16)}…</code>]);
  if (run.rawReportSha256)
    rows.push([
      "Raw report",
      <span key="r" className={v.faint}>
        sha256 <code>{run.rawReportSha256.slice(0, 16)}…</code> · {run.rawReportStored ? "stored encrypted, not shown here" : "not stored"}
      </span>,
    ]);

  return (
    <div className={v.stack} data-testid="engine-run-detail">
      <EngineProvenanceChip provenance={runProvenance(run, props.engine)} />

      {run.status === "awaiting_approval" && (
        <div className={a.outcome} role="status" data-testid="engine-run-awaiting-approval">
          Waiting for approval. This run does not start until an approver decides in the{" "}
          <Link className={er.inlineLink} to="/admin/approvals">Approvals Queue</Link>
          {run.approvalId ? <> (approval <IdChip id={run.approvalId} />)</> : null}; a refusal ends it as not run.
        </div>
      )}

      {live && (
        <div className={v.stackTight} data-testid="engine-run-live">
          {run.status === "leased" && (
            <>
              <div className={v.row}>
                <span>Phase: {run.phase ?? "—"}</span>
                {typeof run.progress === "number" && <span>{Math.round(run.progress * 100)}% done</span>}
                {hb && (
                  <span data-testid="engine-heartbeat">
                    <Badge tone={hb.tone}>{hb.label}</Badge>
                  </span>
                )}
              </div>
              {typeof run.progress === "number" && (
                <div style={{ width: "100%", maxWidth: "360px" }}>
                  <Meter value={run.progress} max={1} label="engine run progress" />
                </div>
              )}
              <span className={v.faint}>
                Lease {until(run.leaseExpiresAt, props.now)} · deadline {until(run.deadlineAt, props.now)}
              </span>
            </>
          )}
          {props.onCancel && (
            <div>
              <Button variant="danger" size="sm" onClick={props.onCancel} disabled={props.cancelBusy}>
                Cancel run
              </Button>
            </div>
          )}
        </div>
      )}

      <KV rows={rows} />

      {run.summary && (
        <div className={v.stackTight} data-testid="engine-run-summary">
          {run.summary.explanation ? <p>{run.summary.explanation}</p> : null}
          {counts && (
            <p data-testid="engine-run-counts">
              {counts.pass} pass · {counts.fail} fail · {counts.unknown} unknown · {counts.not_run} not run
              {verdict === "pass" && counts.not_run + counts.unknown > 0 ? (
                <> — the pass covers only the items that ran; the {counts.not_run + counts.unknown} others are not a pass</>
              ) : null}
            </p>
          )}
          {typeof run.summary.asr === "number" && (
            <p className={v.faint}>
              Attack success rate {(run.summary.asr * 100).toFixed(1)}%
              {run.summary.asrInterval
                ? ` (interval ${(run.summary.asrInterval.lower * 100).toFixed(1)}% – ${(run.summary.asrInterval.upper * 100).toFixed(1)}%)`
                : ""}
              {run.summary.asrTrials ? ` over ${run.summary.asrTrials} trials` : ""}
              {run.summary.measurementQuality ? ` · measurement quality: ${run.summary.measurementQuality}` : ""}
            </p>
          )}
        </div>
      )}

      {(run.redteamRunId || run.evalRunId) && (
        <p className={v.faint}>
          Recorded in the ledgers as
          {run.redteamRunId ? <> red-team run <IdChip id={run.redteamRunId} /></> : null}
          {run.redteamRunId && run.evalRunId ? " and" : null}
          {run.evalRunId ? <> evaluation run <IdChip id={run.evalRunId} /></> : null}
          {props.surface === "redteam" ? " (listed under Runs above)." : " (listed under Datasets and runs)."}
        </p>
      )}

      <div>
        <div className={v.sectionTitle}>Items</div>
        <EngineItemsTable items={items} />
      </div>

      <div data-testid="engine-not-run-list">
        <div className={v.sectionTitle}>Not run ({notRunItems.length})</div>
        {/* B5W-02: coverage is claimed only when it is established, never from an absence of rows */}
        <p className={v.faint} data-testid="engine-run-coverage" data-coverage={coverage.kind}>
          {coverage.text}
        </p>
        {notRunItems.length > 0 && (
          <Table
            rows={notRunItems}
            rowKey={(i) => i.key}
            columns={[
              { key: "key", header: "Item", render: (i) => <code>{i.key}</code> },
              { key: "src", header: "Source", render: (i) => <code>{i.sourceId || "—"}</code> },
              { key: "reason", header: "Reason", render: (i) => <code>{i.notRunReason ?? "unrecorded"}</code> },
              { key: "why", header: "What it means", render: (i) => <span className={v.dim}>{notRunReasonText(i.notRunReason)}</span> },
            ]}
          />
        )}
      </div>
    </div>
  );
}

/** the items, allow-listed fields only; every verdict through `EngineVerdictBadge` */
export function EngineItemsTable(props: { items: EngineRunItem[] }) {
  return (
    <Table
      rows={props.items}
      rowKey={(i) => i.key}
      empty={<EmptyState title="No items" body="An engine run lists its items once a result arrives." />}
      columns={[
        { key: "key", header: "Item", render: (i) => <code>{i.key}</code> },
        { key: "src", header: "Source", render: (i) => <code>{`${i.sourceSystem}/${i.sourceId}`}</code> },
        { key: "class", header: "Class", render: (i) => (i.attackClass ? <code>{i.attackClass}</code> : <span className={v.faint}>unmapped</span>) },
        { key: "sev", header: "Severity", render: (i) => (i.severity ? <SeverityBadge severity={i.severity} /> : "—") },
        { key: "att", header: "Defeated / attempts", render: (i) => `${i.defeated} / ${i.attempts}` },
        { key: "verdict", header: "Verdict", render: (i) => <EngineVerdictBadge verdict={i.verdict} /> },
        {
          key: "claimed",
          header: "Engine claimed",
          render: (i) =>
            i.claimedVerdict && i.claimedVerdict !== i.verdict ? (
              <span className={v.faint}>{i.claimedVerdict.replaceAll("_", " ")} (overridden)</span>
            ) : (
              <span className={v.faint}>—</span>
            ),
        },
        { key: "note", header: "Note", render: (i) => <span className={v.dim}>{i.verdictNote ?? i.reason ?? ""}</span> },
      ]}
    />
  );
}
