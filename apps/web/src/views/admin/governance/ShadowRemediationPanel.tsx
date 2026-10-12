/**
 * ADR-0055 §4 — a shadow-AI finding's remediation plan, and the two ways to
 * act on it: start a workflow through the ONE instantiation route (so the
 * assignment rules and the compliance cascade still apply) and link the
 * finding to it, or link a workflow that already exists. Linking marks the
 * finding confirmed, so it is confirmed first.
 */
import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type { WorkflowListResponse } from "../../../api/types";
import { ago } from "../../../api/format";
import { Badge, Button, ConfirmModal, Field, Input, Select } from "../../../ui/kit";
import { QueryGate, optionEls, projectOpts, useAction, useProjects } from "../adminKit";
import { withRefusalCopy } from "./refusalCopy";
import {
  SHADOW_REMEDIATION_REFUSALS,
  startFormFrom,
  startInstanceBody,
  type RemediationPlan,
  type StartForm,
  type StartInstanceBody,
} from "./shadowRemediationModel";
import a from "../admin.module.css";
import v from "../../views.module.css";

type Pending = { kind: "start"; body: StartInstanceBody } | { kind: "link"; instanceId: string };

export function ShadowRemediationPanel(props: { findingId: string; onClose: () => void; onLinked: () => void }) {
  const plan = useQuery({
    queryKey: ["admin", "shadow-ai-remediation-plan", props.findingId],
    queryFn: () =>
      withRefusalCopy(
        () => api.get<RemediationPlan>(`/v1/shadow-ai/findings/${props.findingId}/remediation-plan`),
        SHADOW_REMEDIATION_REFUSALS,
      ),
  });
  return (
    <section className={a.subSection} aria-label="Remediation plan" data-testid="shadow-remediation">
      <div className={v.row}>
        <div className={v.sectionTitle} style={{ flex: 1 }}>
          Remediation plan
        </div>
        <Button size="sm" variant="ghost" onClick={props.onClose}>
          Close plan
        </Button>
      </div>
      <QueryGate loading={plan.isLoading} error={plan.error} onRetry={() => void plan.refetch()}>
        {plan.data ? <PlanBody key={plan.data.findingId} plan={plan.data} onLinked={props.onLinked} /> : null}
      </QueryGate>
    </section>
  );
}

function PlanBody(props: { plan: RemediationPlan; onLinked: () => void }) {
  const p = props.plan;
  const projects = useProjects();
  const act = useAction();
  const [form, setForm] = useState<StartForm>(() => startFormFrom(p));
  const [existing, setExisting] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [linked, setLinked] = useState<string | null>(null);
  // a workflow that started but whose link failed: a retry links THIS one and never starts another
  const [startedUnlinked, setStartedUnlinked] = useState<string | null>(null);
  const ids = { note: useId(), env: useId(), problem: useId() };
  const instances = useQuery({
    queryKey: ["admin", "shadow-ai-link-instances"],
    queryFn: () => api.get<WorkflowListResponse>("/v1/workflows/instances"),
  });
  const set = <K extends keyof StartForm>(k: K, value: StartForm[K]) => {
    setProblem(null);
    setForm((f) => ({ ...f, [k]: value }));
  };

  const link = (instanceId: string) =>
    api.post(`/v1/shadow-ai/findings/${p.findingId}/remediate`, { instanceId });

  const run = (what: Pending) =>
    void act
      .run(
        () =>
          withRefusalCopy(async () => {
            let instanceId: string;
            if (what.kind === "start") {
              const started = await api.post<{ id: string }>("/v1/workflows/instances", what.body);
              instanceId = started.id;
              setStartedUnlinked(instanceId);
            } else {
              instanceId = what.instanceId;
            }
            await link(instanceId);
            setStartedUnlinked(null);
            setLinked(instanceId);
            return what.kind === "start"
              ? `Workflow ${instanceId.slice(0, 8)} started and linked; the finding is now confirmed`
              : `Finding linked to workflow ${instanceId.slice(0, 8)} and confirmed`;
          }, SHADOW_REMEDIATION_REFUSALS),
      )
      .then((ok) => {
        if (ok) props.onLinked();
      });

  return (
    <div className={v.stack}>
      <div className={v.row}>
        <strong>{p.subject}</strong>
        <Badge tone="neutral">{p.provider}</Badge>
        <Badge tone={p.severity === "critical" ? "danger" : p.severity === "high" ? "warn" : "neutral"}>{p.severity}</Badge>
        {p.replacementAgent ? (
          <Badge tone="ok">governed replacement: {p.replacementAgent.name}</Badge>
        ) : (
          <Badge tone="warn">no governed replacement registered</Badge>
        )}
      </div>
      <ol className={v.stackTight}>
        {p.steps.map((s) => (
          <li key={s.step}>
            <strong>{s.step}</strong> <span className={v.faint}>— {s.why}</span>
            {s.blocked ? (
              <div>
                <Badge tone="danger">blocked</Badge> <span className={v.dim}>{s.blocked}</span>
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      <p className={v.faint} id={ids.note}>
        {p.note}
      </p>
      {p.assignment && !p.assignment.ruleConfigured ? (
        <p role="note" data-testid="shadow-no-assignment-rule">
          <Badge tone="warn">no workflow assigned</Badge>{" "}
          <span className={v.dim}>
            No workflow is assigned to the change type <code>{p.assignment.changeType}</code>, and none is by default. An admin must add an
            assignment rule for it under Workflow templates before a remediation workflow can start; until then, link a workflow started
            another way.
          </span>
        </p>
      ) : null}

      <form
        aria-label="Start a remediation workflow"
        aria-describedby={ids.note}
        className={v.stack}
        onSubmit={(e) => {
          e.preventDefault();
          const built = startInstanceBody(p, form);
          if (!built.ok) {
            setProblem(built.problem);
            return;
          }
          setPending({ kind: "start", body: built.body });
        }}
      >
        <div className={a.formRow}>
          <Field label="Change description" grow>
            <Input value={form.description} onChange={(e) => set("description", e.target.value)} />
          </Field>
          <Field label="Environment">
            <Input required value={form.environment} placeholder="for example production" aria-describedby={ids.env} onChange={(e) => set("environment", e.target.value)} />
          </Field>
          <Field label="Bill to project (optional)">
            <Select value={form.projectId} onChange={(e) => set("projectId", e.target.value)}>
              {optionEls(projectOpts(projects.data?.projects), "— no project —")}
            </Select>
          </Field>
        </div>
        <p className={v.faint} id={ids.env}>
          Where the ungoverned usage runs today. Workflow assignment rules and a project's compliance requirements decide
          which stages the workflow has.
        </p>
        <div className={v.row}>
          <Button
            type="submit"
            variant="primary"
            disabled={act.busy || startedUnlinked !== null}
            aria-describedby={problem ? ids.problem : undefined}
          >
            Start remediation workflow…
          </Button>
        </div>
      </form>

      <form
        aria-label="Link an existing workflow"
        className={a.formRow}
        onSubmit={(e) => {
          e.preventDefault();
          if (!existing) {
            setProblem("Choose the workflow to link.");
            return;
          }
          setPending({ kind: "link", instanceId: existing });
        }}
      >
        <Field label="Or link an existing workflow" grow>
          <Select value={existing} onChange={(e) => { setProblem(null); setExisting(e.target.value); }}>
            {optionEls(
              (instances.data?.instances ?? []).map((i) => ({
                v: i.id,
                l: `${i.change?.description ?? i.id.slice(0, 8)} · ${i.status} · ${ago(i.createdAt)}`,
              })),
              "— choose a workflow —",
            )}
          </Select>
        </Field>
        <Button type="submit" disabled={act.busy}>
          Link workflow…
        </Button>
      </form>

      {startedUnlinked && (
        <div className={v.row} data-testid="shadow-started-unlinked">
          <p role="alert" className={v.errLine} style={{ margin: 0 }}>
            Workflow <code>{startedUnlinked}</code> was started but is not linked to this finding yet. Retry the link; a
            second workflow will not be started.
          </p>
          <Button disabled={act.busy} onClick={() => run({ kind: "link", instanceId: startedUnlinked })}>
            Retry linking this workflow
          </Button>
        </div>
      )}
      {problem && (
        <p className={v.errLine} role="alert" id={ids.problem}>
          {problem}
        </p>
      )}
      {act.error && (
        <p className={v.errLine} role="alert">
          {act.error}
        </p>
      )}
      {linked && (
        <p role="status" className={v.dim}>
          Linked to workflow <code>{linked}</code>. The loop closes when the next call from {p.subject} appears in the audit
          log and usage ledger.
        </p>
      )}
      <ConfirmModal
        open={pending !== null}
        title={pending?.kind === "start" ? "Start a remediation workflow?" : "Link this workflow?"}
        confirmLabel={pending?.kind === "start" ? "Start and link" : "Link"}
        body={
          <p>
            {pending?.kind === "start"
              ? "A workflow is started through the normal route, so its assignment rules and compliance stages apply. "
              : ""}
            The finding is then linked to that workflow and its disposition becomes confirmed, recorded under your name.
          </p>
        }
        onCancel={() => setPending(null)}
        onConfirm={() => {
          const what = pending;
          setPending(null);
          if (what) run(what);
        }}
      />
    </div>
  );
}
