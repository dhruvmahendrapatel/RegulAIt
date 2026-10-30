/**
 * ADR-0187 — recurring engine runs, shown under the run form on the
 * Red-teaming and Evaluations pages (the run surfaces; ADR-0177 §3).
 *
 * A schedule repeats the run the form above describes, every N hours, as the
 * person who creates it. The gateway validates it now with the same checks a
 * run gets and again before every run it starts, so an engine switched off, a
 * lost entitlement or an exhausted budget skips that run with a stated reason.
 * Switching a schedule off is immediate; only its creator can switch it back
 * on, and that is confirmed because it resumes spending.
 */
import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError, api } from "../../../api/client";
import { ago, fmtAt } from "../../../api/format";
import { useSession } from "../../../session/SessionContext";
import { Badge, Button, Card, ConfirmModal, EmptyState, Field, IdChip, Input, Table } from "../../../ui/kit";
import { useAction } from "../adminKit";
import {
  SCHEDULE_INTERVAL_LIMITS,
  SCHEDULE_REFUSALS,
  scheduleBody,
  scheduleRequestSummary,
  scheduleToggle,
  type EngineSchedule,
} from "./engineScheduleModel";
import a from "../admin.module.css";
import v from "../../views.module.css";

export const engineScheduleKeys = { list: ["admin", "engine-schedules"] as const };

async function scheduleCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const code = e instanceof ApiError ? e.payload.error : undefined;
    if (typeof code === "string" && Object.hasOwn(SCHEDULE_REFUSALS, code)) throw new Error(SCHEDULE_REFUSALS[code]);
    throw e;
  }
}

export function EngineSchedulesCard(props: {
  /** the run form's request body, or null while the form is incomplete */
  request: Record<string, unknown> | null;
  /** why the form is incomplete */
  problem: string | null;
  engineName: (id: string) => string;
  agentName: (id: string) => string;
}) {
  const { auth } = useSession();
  const me = auth?.userId ?? null;
  const list = useQuery({ queryKey: engineScheduleKeys.list, queryFn: () => api.get<{ schedules: EngineSchedule[] }>("/v1/engine-schedules") });
  const create = useAction();
  const toggle = useAction();
  const [interval, setIntervalHours] = useState("24");
  const [problem, setProblem] = useState<string | null>(null);
  const [turningOn, setTurningOn] = useState<EngineSchedule | null>(null);
  const helpId = useId();

  const setEnabled = (s: EngineSchedule, enabled: boolean) =>
    void toggle.run(
      () => scheduleCall(() => api.patch(`/v1/engine-schedules/${s.id}`, { enabled })),
      enabled ? "Schedule switched on; its next run is validated again before it starts" : "Schedule switched off; no further runs start",
    );

  return (
    <Card
      title="Recurring runs"
      info={
        <p>
          Repeat the run described above every few hours. Every run it starts executes as you, is checked again first
          (engine on, your entitlement, project, budget ceiling, approver) and needs approval the same way a run started
          by hand does. A check that fails skips that run and says why; nothing runs on weaker terms.
        </p>
      }
    >
      <form
        className={a.formRow}
        aria-label="Schedule this run"
        onSubmit={(e) => {
          e.preventDefault();
          if (!props.request) return setProblem(props.problem ?? "Complete the run form above first.");
          const out = scheduleBody(props.request, interval);
          if ("error" in out) return setProblem(out.error);
          setProblem(null);
          void create.run(() => scheduleCall(() => api.post("/v1/engine-schedules", out.body)), `Scheduled every ${out.body.intervalHours} h; the first run starts then`);
        }}
      >
        <Field label="Every (hours)">
          <Input
            type="number"
            min={SCHEDULE_INTERVAL_LIMITS.min}
            max={SCHEDULE_INTERVAL_LIMITS.max}
            step={1}
            value={interval}
            onChange={(e) => setIntervalHours(e.target.value)}
          />
        </Field>
        <Button type="submit" disabled={create.busy || !props.request} aria-describedby={!props.request ? helpId : undefined}>
          Schedule this run
        </Button>
        {!props.request && (
          <span id={helpId} className={v.hint}>
            Complete the run form above first: {props.problem ?? "it is incomplete"}
          </span>
        )}
        {(problem ?? create.error) && (
          <span className={v.errLine} role="alert">
            {problem ?? create.error}
          </span>
        )}
      </form>
      <Table<EngineSchedule>
        rows={list.data?.schedules ?? []}
        rowKey={(s) => s.id}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => void list.refetch()}
        empty={<EmptyState title="No recurring runs" body="Nothing runs on a schedule until someone creates one here." />}
        columns={[
          { key: "engine", header: "Engine", render: (s) => props.engineName(s.engineId) },
          {
            key: "target",
            header: "Target · sets",
            render: (s) => {
              const r = scheduleRequestSummary(s.request);
              return `${r.agentId ? props.agentName(r.agentId) : "Not reported"} · ${r.sets.join(", ") || "no sets"}`;
            },
          },
          { key: "every", header: "Every", render: (s) => `${s.intervalHours} h` },
          {
            key: "next",
            header: "Next run",
            render: (s) => (s.enabled ? <span title={fmtAt(s.nextRunAt)}>{fmtAt(s.nextRunAt)}</span> : <span className={v.faint}>off</span>),
          },
          {
            key: "last",
            header: "Last",
            render: (s) =>
              s.lastSkip ? (
                <span>
                  <Badge tone="warn">skipped</Badge> <span className={v.faint}>{s.lastSkip}</span>
                </span>
              ) : s.lastRunId ? (
                <IdChip id={s.lastRunId} />
              ) : (
                <span className={v.faint}>not run yet</span>
              ),
          },
          { key: "state", header: "State", render: (s) => (s.enabled ? <Badge tone="ok">on</Badge> : <Badge tone="neutral">off</Badge>) },
          { key: "created", header: "Created", render: (s) => ago(s.createdAt) },
          {
            key: "toggle",
            header: "Switch",
            align: "right",
            render: (s) => <ToggleCell schedule={s} me={me} busy={toggle.busy} onOff={() => setEnabled(s, false)} onOn={() => setTurningOn(s)} />,
          },
        ]}
      />
      {toggle.error && (
        <p className={v.errLine} role="alert">
          {toggle.error}
        </p>
      )}
      <ConfirmModal
        open={turningOn !== null}
        title="Switch this schedule back on?"
        confirmLabel="Switch on"
        body={
          <p>
            It starts runs again every {turningOn?.intervalHours} h, each executing as you and billed to the project in its request. Each run is checked
            again before it starts. The change is audited.
          </p>
        }
        onCancel={() => setTurningOn(null)}
        onConfirm={() => {
          const s = turningOn;
          setTurningOn(null);
          if (s) setEnabled(s, true);
        }}
      />
    </Card>
  );
}

function ToggleCell(props: { schedule: EngineSchedule; me: string | null; busy: boolean; onOff: () => void; onOn: () => void }) {
  const t = scheduleToggle(props.schedule, props.me);
  const reasonId = useId();
  if (!t.ok)
    return (
      <span className={v.row}>
        <Button size="sm" disabled aria-describedby={reasonId}>
          Switch on
        </Button>
        <span id={reasonId} className={v.faint}>
          {t.reason}
        </span>
      </span>
    );
  return (
    <Button size="sm" variant="ghost" disabled={props.busy} onClick={t.next ? props.onOn : props.onOff}>
      {t.next ? "Switch on" : "Switch off"}
    </Button>
  );
}
