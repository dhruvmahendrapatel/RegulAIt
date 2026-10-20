/**
 * ADR-0055 §4 — a shadow-AI finding's remediation plan, and the two ways to
 * act on it: start a workflow through the ONE instantiation route (so the
 * assignment rules and the compliance cascade still apply) and link the
 * finding to it, or link a workflow that already exists. Linking marks the
 * finding confirmed, so it is confirmed first.
 *
 * ADR-0195 A4: a workflow that started but whose link failed is held by the
 * SERVER (the plan's `pendingLink`), not the browser, so after a reload the
 * screen still offers only to link that workflow: starting another and linking
 * a different one both stay disabled until it is linked.
 *
 * R3: while the finding's link stands, both stay disabled too. A link to a
 * workflow that ended denied, aborted or rolled back does not stand: a new
 * workflow may replace it, and the server audits the replace.
 */
import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type { WorkflowListResponse } from "../../../api/types";
import { ago } from "../../../api/format";
import { Badge, Button, ConfirmModal, Field, InfoButton, Input, Select, SeverityBadge } from "../../../ui/kit";
import { DrawerActions } from "../../../ui/DetailDrawer";
import { QueryGate, optionEls, projectOpts, useAction, useProjects } from "../adminKit";
import { withRefusalCopy } from "./refusalCopy";
import {
  SHADOW_REMEDIATION_REFUSALS,
  linkStands,
  linkableInstances,
  startFormFrom,
  startInstanceBody,
  startWillMatch,
  type RemediationPlan,
  type StartForm,
  type StartInstanceBody,
} from "./shadowRemediationModel";
import a from "../admin.module.css";
import v from "../../views.module.css";
import rm from "./shadowAi.module.css";

type Pending = { kind: "start"; body: StartInstanceBody } | { kind: "link"; instanceId: string };

/** `inDrawer` (A1): the shared DetailDrawer supplies the title, the (i), Close and the test id, and pins the Start and
 * Link buttons in its footer (L2), so the panel shows only its body */
export function ShadowRemediationPanel(props: { findingId: string; onClose: () => void; onLinked: () => void; inDrawer?: boolean }) {
  const plan = useQuery({
    queryKey: ["admin", "shadow-ai-remediation-plan", props.findingId],
    queryFn: () =>
      withRefusalCopy(
        () => api.get<RemediationPlan>(`/v1/shadow-ai/findings/${props.findingId}/remediation-plan`),
        SHADOW_REMEDIATION_REFUSALS,
      ),
  });
  // SH4: the plan opens below the findings table, so it is brought into view when it opens
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!props.inDrawer) section.current?.scrollIntoView({ block: "nearest" });
  }, [props.inDrawer]);
  return (
    <section ref={section} className={props.inDrawer ? undefined : a.subSection} aria-label="Remediation plan" data-testid={props.inDrawer ? undefined : "shadow-remediation"}>
      {props.inDrawer ? null : <div className={v.row}>
        <div className={v.sectionTitle} style={{ flex: 1 }}>
          Remediation plan
          <InfoButton label="a remediation plan">
            A remediation plan turns a finding into tracked work: a governed workflow with a separate approver. The
            workflow tracks the change and its sign-off. It does not change systems by itself.
          </InfoButton>
        </div>
        <Button size="sm" variant="ghost" onClick={props.onClose}>
          Close plan
        </Button>
      </div>}
      <QueryGate loading={plan.isLoading} error={plan.error} onRetry={() => void plan.refetch()}>
        {plan.data ? <PlanBody key={plan.data.findingId} plan={plan.data} onLinked={props.onLinked} /> : null}
      </QueryGate>
    </section>
  );
}

export function PlanBody(props: { plan: RemediationPlan; onLinked: () => void }) {
  const p = props.plan;
  const projects = useProjects();
  const act = useAction();
  const [form, setForm] = useState<StartForm>(() => startFormFrom(p));
  const [existing, setExisting] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [linked, setLinked] = useState<string | null>(null);
  // a workflow that started but whose link failed: a retry links THIS one and never starts or links another.
  // Seeded from the server, so it survives a reload
  const [startedUnlinked, setStartedUnlinked] = useState<string | null>(p.pendingLink?.instanceId ?? null);
  const ids = { note: useId(), env: useId(), problem: useId(), start: useId(), link: useId() };
  // linked to a workflow that is still live (or completed): nothing here may start or link another
  const locked = startedUnlinked !== null || linkStands(p);
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
        <SeverityBadge severity={p.severity} />
        {p.replacementAgent ? (
          <Badge tone="ok">governed replacement: {p.replacementAgent.name}</Badge>
        ) : (
          <Badge tone="warn">no governed replacement registered</Badge>
        )}
      </div>
      {/* SH5: the plan as a stepper. The plan reports what blocks a step, not which steps are done, so a step shows
          its number or "Blocked" and never claims progress the server did not report */}
      <ol className={rm.steps} aria-label="Remediation steps">
        {p.steps.map((s, i) => (
          <li key={s.step} className={s.blocked ? rm.stepBlocked : rm.step}>
            <span className={rm.stepMark} aria-hidden="true">{i + 1}</span>
            <strong>{s.step.charAt(0).toUpperCase() + s.step.slice(1)}</strong>
            {s.blocked ? (
              <span>
                <Badge tone="danger">Blocked</Badge> <span className={v.dim}>{s.blocked}</span>
              </span>
            ) : null}
            <span className={v.dim}>{s.why}</span>
          </li>
        ))}
      </ol>
      <aside className={rm.whoNext} aria-label="Who acts next">
        <strong>Who acts next</strong>
        <span>By default, a plan-only stage runs first and changes nothing. Then a human sign-off.</span>
        <span className={v.row}>
          <Badge tone="info">Separate approver</Badge>
          <InfoButton label="the second approver">
            By default, a different admin must sign off: you cannot approve your own remediation.
          </InfoButton>
        </span>
      </aside>
      <p className={v.faint} id={ids.note}>
        {p.note}
      </p>
      {p.assignment && !startWillMatch(p) ? (
        <p role="note" data-testid="shadow-no-assignment-rule">
          <Badge tone="warn">no workflow assigned</Badge>{" "}
          <span className={v.dim}>
            No workflow is assigned to the change type <code>{p.assignment.changeType}</code>
            {p.assignment.defaultTemplate?.state === "retired" ? ", and its default workflow was retired" : ""}. An admin must add an
            assignment rule for it under Workflow templates before a remediation workflow can start; until then, link a workflow started
            another way.
          </span>
        </p>
      ) : null}
      {p.assignment?.defaultTemplate?.state === "not_installed" && !p.assignment.ruleConfigured ? (
        <p className={v.faint} data-testid="shadow-default-workflow">
          The default remediation workflow (a plan-only stage, then a human sign-off) is set up when the first one starts.
        </p>
      ) : null}

      {p.currentLink && !linked ? (
        <p role="note" data-testid="shadow-current-link">
          <Badge tone={p.currentLink.replaceable ? "warn" : "ok"}>linked</Badge>{" "}
          <span className={v.dim}>
            This finding is linked to workflow <code>{p.currentLink.instanceId}</code>
            {p.currentLink.status ? ` (${p.currentLink.status.replaceAll("_", " ")})` : ""}.
            {p.currentLink.replaceable
              ? " That workflow ended without remediating the finding, so a new one can be started or linked; it replaces the old link, and the replace is recorded in the audit log."
              : " A new workflow can replace it only if that one is denied, aborted or rolled back."}
          </span>
        </p>
      ) : null}

      <form
        id={ids.start}
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
          <Field
            label="Environment"
            help="Where the change will be made. Workflow assignment rules may give some environments extra stages."
          >
            <Input required value={form.environment} placeholder="for example production" aria-describedby={ids.env} onChange={(e) => set("environment", e.target.value)} />
          </Field>
          <Field label="Bill to project (optional)" help="Charges the workflow's AI spend to this project's budget.">
            <Select value={form.projectId} onChange={(e) => set("projectId", e.target.value)}>
              {optionEls(projectOpts(projects.data?.projects), "— no project —")}
            </Select>
          </Field>
        </div>
        <p className={v.faint}>
          Linked to <Badge>Finding {p.findingId.slice(0, 8)}</Badge> automatically: the reference is added to the workflow
          for you.
        </p>
        <p className={v.faint} id={ids.env}>
          Where the ungoverned usage runs today. Workflow assignment rules and a project's compliance requirements decide
          which stages the workflow has.
        </p>
        <DrawerActions className={v.row}>
          <Button
            type="submit"
            form={ids.start}
            variant="primary"
            disabled={act.busy || locked}
            aria-describedby={problem ? ids.problem : undefined}
          >
            Start remediation workflow…
          </Button>
        </DrawerActions>
      </form>

      <form
        id={ids.link}
        aria-label="Link an existing workflow"
        className={a.formRow}
        onSubmit={(e) => {
          e.preventDefault();
          if (!existing) {
            setProblem("Choose the workflow to link.");
            return;
          }
          if (locked) return;
          setPending({ kind: "link", instanceId: existing });
        }}
      >
        <Field label="Or link an existing workflow" grow>
          <Select
            value={existing}
            disabled={locked}
            onChange={(e) => { setProblem(null); setExisting(e.target.value); }}
          >
            {optionEls(
              linkableInstances(p.findingId, instances.data?.instances ?? []).map((i) => ({
                v: i.id,
                l: `${i.change?.description ?? i.id.slice(0, 8)} · ${i.status} · ${ago(i.createdAt)}`,
              })),
              "— choose a workflow —",
            )}
          </Select>
        </Field>
        <DrawerActions>
          <Button type="submit" form={ids.link} disabled={act.busy || locked}>
            Link workflow…
          </Button>
        </DrawerActions>
      </form>

      {startedUnlinked && (
        <div className={v.row} data-testid="shadow-started-unlinked">
          <p role="alert" className={`${v.errLine} ${v.flush}`}>
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
