/**
 * ADR-0173 batch 2c (K) — the Traces page's AUTOMATIONS tab: automation
 * rules over traces (a filter, a deterministic sampling rate, and up to four
 * actions: send to an annotation queue, add to a dataset, notify one webhook,
 * extend retention), with create, edit, pause/resume, an explicit backfill of
 * at most 7 days, and each rule's match log.
 *
 * What the screen says out loud, because each is a governance property:
 *  - a rule runs AS ITS AUTHOR, and is paused (with the reason shown) when the
 *    author is no longer an active admin; whoever edits or resumes it becomes
 *    the author;
 *  - a new rule only sees traces that finish after it is created; reaching
 *    back is a backfill you ask for, which is audited and marked in the log;
 *  - the retention bound (twice the floor, at most three years) is printed
 *    beside the field, and an erasure request always releases a hold.
 *
 * Mounted by TracesPage as `<TracesAutomationsTab />`: no props, default export.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table } from "../../../ui/kit";
import { QueryGate, RemoveButton, agentOpts, optionEls, useAction, useAgents } from "../adminKit";
import v from "../../views.module.css";
import m from "./monitoring.module.css";
import {
  ACTION_WORDS,
  AUTOMATION_UI_LIMITS,
  EMPTY_RULE_FORM,
  filterSentence,
  reasonWords,
  ruleFormFrom,
  ruleFormProblem,
  rulePayload,
  type AutomationMatch,
  type AutomationRule,
  type AutomationRulesResponse,
  type RuleForm,
} from "./monitoringModel";

interface Named {
  id: string;
  name: string;
}

export default function TracesAutomationsTab() {
  const rules = useQuery({
    queryKey: ["admin", "automation-rules"],
    queryFn: () => api.get<AutomationRulesResponse>("/v1/automation-rules"),
  });
  const act = useAction();
  const [editing, setEditing] = useState<AutomationRule | "new" | null>(null);
  const [logFor, setLogFor] = useState<AutomationRule | null>(null);
  const [backfillDays, setBackfillDays] = useState<Record<string, string>>({});
  const [backfillNote, setBackfillNote] = useState<string | null>(null);
  const list = rules.data?.rules ?? [];
  const maxHold = rules.data?.retention?.maxHoldDays ?? null;

  return (
    <div className={v.stack}>
      <Card
        title="Automation rules"
        actions={
          <div className={v.row}>
            <Button
              size="sm"
              variant="ghost"
              disabled={act.busy}
              onClick={() =>
                void act.run(async () => {
                  const r = await api.post<{ matched: number; examined: number }>("/v1/automation-rules/sweep", {});
                  return `${r.matched} matched over ${r.examined} traces`;
                })
              }
            >
              Run now
            </Button>
            <Button size="sm" onClick={() => setEditing("new")}>
              New rule
            </Button>
          </div>
        }
      >
        <QueryGate loading={rules.isLoading} error={rules.error} onRetry={() => void rules.refetch()}>
          <div className={v.stackTight}>
            <p className={v.faint}>
              A rule runs as its author on traces that finish after it is created, at most 500 traces and 45 seconds a
              pass and its daily cap. Reaching further back is an explicit backfill of at most{" "}
              {AUTOMATION_UI_LIMITS.maxBackfillDays} days, audited and marked in the match log.
            </p>
            {list.length === 0 ? (
              <EmptyState title="No automation rules yet" body="A rule routes matching traces to a queue, a dataset, a webhook or a retention hold." />
            ) : (
              <Table<AutomationRule>
                rows={list}
                rowKey={(r) => r.id}
                columns={[
                  {
                    key: "name",
                    header: "Rule",
                    render: (r) => (
                      <div className={v.stackTight}>
                        <strong>{r.name}</strong>
                        <span className={v.faint}>{filterSentence(r.filter)}</span>
                      </div>
                    ),
                  },
                  {
                    key: "status",
                    header: "Status",
                    render: (r) =>
                      r.status === "active" ? (
                        <Badge tone="ok">Active</Badge>
                      ) : (
                        <div className={v.stackTight}>
                          <Badge tone="warn">Paused</Badge>
                          {r.pausedReason && <span className={v.faint}>{reasonWords(r.pausedReason)}</span>}
                        </div>
                      ),
                  },
                  { key: "sampling", header: "Sampling", align: "right", render: (r) => <span className={v.num}>{Math.round(r.samplingRate * 1000) / 10}%</span> },
                  { key: "actions", header: "Actions", render: (r) => r.actions.map((a) => ACTION_WORDS[a.type] ?? a.type).join(", ") },
                  { key: "author", header: "Runs as", render: (r) => r.author.name ?? r.author.id.slice(0, 8) },
                  {
                    key: "matches",
                    header: "Matches",
                    render: (r) => (
                      <span className={v.num}>
                        {r.stats?.today ?? 0} today / {r.dailyActionCap} cap · {r.stats?.total ?? 0} total
                        {r.stats?.failed ? ` · ${r.stats.failed} failed` : ""}
                      </span>
                    ),
                  },
                  {
                    key: "do",
                    header: "",
                    render: (r) => (
                      <div className={v.row}>
                        <Button size="sm" variant="ghost" aria-label={`Edit rule ${r.name}`} onClick={() => setEditing(r)}>
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`${r.status === "active" ? "Pause" : "Resume"} rule ${r.name}`}
                          disabled={act.busy}
                          onClick={() =>
                            void act.run(
                              () => api.patch(`/v1/automation-rules/${r.id}`, { status: r.status === "active" ? "paused" : "active" }),
                              r.status === "active" ? `Paused ${r.name}` : `Resumed ${r.name}; it now runs as you`,
                            )
                          }
                        >
                          {r.status === "active" ? "Pause" : "Resume"}
                        </Button>
                        <Button size="sm" variant="ghost" aria-label={`Match log of ${r.name}`} onClick={() => setLogFor(r)}>
                          Match log
                        </Button>
                        <Input
                          type="number"
                          min={1}
                          max={AUTOMATION_UI_LIMITS.maxBackfillDays}
                          aria-label={`Backfill days for ${r.name}`}
                          style={{ width: 64 }}
                          value={backfillDays[r.id] ?? "1"}
                          onChange={(e) => setBackfillDays((d) => ({ ...d, [r.id]: e.target.value }))}
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Backfill ${r.name}`}
                          disabled={
                            act.busy ||
                            !(Number(backfillDays[r.id] ?? "1") >= 1 && Number(backfillDays[r.id] ?? "1") <= AUTOMATION_UI_LIMITS.maxBackfillDays)
                          }
                          onClick={() =>
                            void act.run(async () => {
                              const out = await api.post<{ note: string; from: string }>(`/v1/automation-rules/${r.id}/backfill`, {
                                days: Number(backfillDays[r.id] ?? "1"),
                              });
                              setBackfillNote(`${r.name}: ${out.note}`);
                              return out.note;
                            })
                          }
                        >
                          Backfill
                        </Button>
                      </div>
                    ),
                  },
                ]}
              />
            )}
            {backfillNote && (
              <p role="status" className={v.dim}>
                {backfillNote}
              </p>
            )}
          </div>
        </QueryGate>
      </Card>
      {editing && <RuleEditor rule={editing === "new" ? null : editing} maxHoldDays={maxHold} floorDays={rules.data?.retention?.floorDays ?? null} onClose={() => setEditing(null)} />}
      {logFor && <MatchLog rule={logFor} onClose={() => setLogFor(null)} />}
    </div>
  );
}

function RuleEditor(props: { rule: AutomationRule | null; maxHoldDays: number | null; floorDays: number | null; onClose: () => void }) {
  const [f, setF] = useState<RuleForm>(() => (props.rule ? ruleFormFrom(props.rule) : EMPTY_RULE_FORM));
  const set = <K extends keyof RuleForm>(k: K, value: RuleForm[K]) => setF((x) => ({ ...x, [k]: value }));
  const act = useAction();
  const agents = useAgents();
  const queues = useQuery({ queryKey: ["admin", "automation-queues"], retry: false, queryFn: () => api.get<{ queues: Named[] }>("/v1/annotation-queues") });
  const datasets = useQuery({
    queryKey: ["admin", "automation-datasets"],
    retry: false,
    queryFn: () => api.get<{ datasets: Array<Named & { version?: number; frozen?: boolean }> }>("/v1/evals/datasets"),
  });
  const hooks = useQuery({
    queryKey: ["admin", "automation-webhooks"],
    retry: false,
    queryFn: () => api.get<{ subscriptions: Array<Named & { active: boolean }> }>("/v1/webhooks"),
  });
  const problem = ruleFormProblem(f, props.maxHoldDays);
  const save = () =>
    act
      .run(
        () => (props.rule ? api.patch(`/v1/automation-rules/${props.rule.id}`, rulePayload(f)) : api.post("/v1/automation-rules", rulePayload(f))),
        props.rule ? "Rule saved; it now runs as you" : "Rule created; it runs as you",
      )
      .then((ok) => ok && props.onClose());
  return (
    <Card title={props.rule ? `Edit rule ${props.rule.name}` : "New automation rule"}>
      <div className={m.ruleForm}>
        <Field label="Rule name">
          <Input value={f.name} onChange={(e) => set("name", e.target.value)} maxLength={120} />
        </Field>
        <div className={v.sectionTitle}>Which traces</div>
        <div className={v.grid4}>
          <Field label="Rule tag key">
            <Input value={f.tagKey} onChange={(e) => set("tagKey", e.target.value)} maxLength={64} />
          </Field>
          <Field label="Rule tag value">
            <Input value={f.tagValue} onChange={(e) => set("tagValue", e.target.value)} maxLength={256} />
          </Field>
          <Field label="Rule model">
            <Input value={f.model} onChange={(e) => set("model", e.target.value)} maxLength={200} />
          </Field>
          <Field label="Rule agent">
            <Select value={f.agentId} onChange={(e) => set("agentId", e.target.value)}>
              {optionEls(agentOpts(agents.data?.agents), "Any agent")}
            </Select>
          </Field>
          <Field label="Rule status">
            <Select value={f.status} onChange={(e) => set("status", e.target.value)}>
              <option value="">Any status</option>
              <option value="ok">OK</option>
              <option value="error">Error</option>
              <option value="denied">Denied</option>
            </Select>
          </Field>
          <Field label="Rule cost at least (USD)">
            <Input type="number" min={0} value={f.minCostUsd} onChange={(e) => set("minCostUsd", e.target.value)} />
          </Field>
          <Field label="Rule latency at least (ms)">
            <Input type="number" min={0} value={f.minLatencyMs} onChange={(e) => set("minLatencyMs", e.target.value)} />
          </Field>
          <Field label="Rule score name">
            <Input value={f.scoreName} onChange={(e) => set("scoreName", e.target.value)} maxLength={128} />
          </Field>
          <Field label="Rule score at most">
            <Input type="number" value={f.scoreMax} onChange={(e) => set("scoreMax", e.target.value)} />
          </Field>
        </div>
        <div className={v.row}>
          <label className={v.row}>
            <input type="checkbox" checked={f.flagged} onChange={(e) => set("flagged", e.target.checked)} /> Flagged by trace evaluation
          </label>
          <label className={v.row}>
            <input type="checkbox" checked={f.deniedOnly} onChange={(e) => set("deniedOnly", e.target.checked)} /> Governance refused something
          </label>
        </div>
        <div className={v.grid4}>
          <Field label="Sampling (%)">
            <Input type="number" min={0} max={100} step={0.1} value={f.samplingPct} onChange={(e) => set("samplingPct", e.target.value)} />
          </Field>
          <Field label="Daily cap (matches)">
            <Input type="number" min={1} max={AUTOMATION_UI_LIMITS.maxDailyActionCap} value={f.dailyActionCap} onChange={(e) => set("dailyActionCap", e.target.value)} />
          </Field>
        </div>
        <p className={v.faint}>Sampling is decided per trace from a hash of the rule and the trace, so a trace gets the same answer on every pass.</p>
        <div className={v.sectionTitle}>What to do</div>
        <div className={m.actionsGrid}>
          <Field label="Send to annotation queue">
            {queues.isError ? (
              <Input value={f.queueId} placeholder="Queue id" onChange={(e) => set("queueId", e.target.value.trim())} />
            ) : (
              <Select value={f.queueId} onChange={(e) => set("queueId", e.target.value)}>
                {optionEls((queues.data?.queues ?? []).map((q) => ({ v: q.id, l: q.name })), "No queue")}
              </Select>
            )}
          </Field>
          <Field label="Add to dataset">
            {datasets.isError ? (
              <Input value={f.datasetId} placeholder="Dataset id" onChange={(e) => set("datasetId", e.target.value.trim())} />
            ) : (
              <Select value={f.datasetId} onChange={(e) => set("datasetId", e.target.value)}>
                <option value="">No dataset</option>
                {(datasets.data?.datasets ?? []).map((d) => (
                  <option key={d.id} value={d.id} disabled={d.frozen}>
                    {d.name}
                    {d.version !== undefined ? ` v${d.version}` : ""}
                    {d.frozen ? " (frozen)" : ""}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Notify webhook">
            <Select value={f.subscriptionId} onChange={(e) => set("subscriptionId", e.target.value)}>
              <option value="">No webhook</option>
              {(hooks.data?.subscriptions ?? []).map((s) => (
                <option key={s.id} value={s.id} disabled={!s.active}>
                  {s.name}
                  {s.active ? "" : " (inactive)"}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={props.maxHoldDays === null ? "Extend retention (no floor set)" : `Extend retention (days, at most ${props.maxHoldDays})`}>
            <Input
              type="number"
              min={1}
              max={props.maxHoldDays ?? undefined}
              disabled={props.maxHoldDays === null}
              value={f.retentionDays}
              onChange={(e) => set("retentionDays", e.target.value)}
            />
          </Field>
        </div>
        <p className={v.faint}>
          {props.floorDays === null
            ? "No retention floor is set, so traces are never pruned and a hold has nothing to extend."
            : `A hold keeps a trace for the given days from its start: at most twice the ${props.floorDays}-day floor and never more than three years. An erasure request always releases a hold.`}
        </p>
        {problem && (
          <p className={v.errLine} role="alert">
            {problem}
          </p>
        )}
        <div className={v.row}>
          <Button onClick={() => void save()} disabled={problem !== null || act.busy}>
            {props.rule ? "Save rule" : "Create rule"}
          </Button>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          {props.rule && (
            <RemoveButton
              what={`automation rule ${props.rule.name}`}
              consequence="Its match log is deleted with it; holds it placed stay until they expire or are released."
              onRemove={() => api.del(`/v1/automation-rules/${props.rule!.id}`)}
              onDone={props.onClose}
            />
          )}
        </div>
      </div>
    </Card>
  );
}

function MatchLog(props: { rule: AutomationRule; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["admin", "automation-matches", props.rule.id],
    queryFn: () => api.get<{ matches: AutomationMatch[] }>(`/v1/automation-rules/${props.rule.id}/matches?limit=100`),
  });
  return (
    <Card
      title={`Match log: ${props.rule.name}`}
      actions={
        <Button size="sm" variant="ghost" onClick={props.onClose}>
          Close
        </Button>
      }
    >
      <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
        <Table<AutomationMatch>
          rows={q.data?.matches ?? []}
          rowKey={(x) => x.id}
          empty={<EmptyState title="No matches yet" />}
          columns={[
            { key: "trace", header: "Trace", render: (x) => x.traceName ?? x.traceId.slice(0, 8) },
            { key: "at", header: "Matched", render: (x) => ago(x.matchedAt), sort: (x) => x.matchedAt },
            { key: "backfill", header: "Source", render: (x) => (x.backfill ? <Badge tone="info">Backfill</Badge> : <span className={v.faint}>Live</span>) },
            {
              key: "status",
              header: "Outcome",
              render: (x) => <Badge tone={x.status === "done" ? "ok" : x.status === "retry" ? "warn" : "danger"}>{x.status === "done" ? "Done" : x.status === "retry" ? "Retrying" : "Failed"}</Badge>,
            },
            {
              key: "actions",
              header: "Actions",
              render: (x) => (
                <ul aria-label={`Actions for ${x.traceName ?? x.traceId}`} className={v.stackTight} style={{ listStyle: "none", margin: 0, padding: 0 }}>
                  {x.actionResults.map((r) => (
                    <li key={r.type}>
                      {ACTION_WORDS[r.type] ?? r.type}: {r.status}
                      {r.reason ? ` (${reasonWords(r.reason)})` : ""}
                      {r.attempts > 1 ? `, ${r.attempts} attempts` : ""}
                    </li>
                  ))}
                </ul>
              ),
            },
          ]}
        />
      </QueryGate>
    </Card>
  );
}
