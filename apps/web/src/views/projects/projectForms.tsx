/**
 * The project create and edit forms, shared by the Cost dashboard and the Projects
 * screens (G2, owner decision on #453): an admin creates a project from Projects and
 * edits one from its own page, with the same fields and the same budget-approver rule.
 * Also the overage state both screens show beside a project's budget (CXR-CST-002): it lives here, in the module the
 * two screens already share, so it adds no chunk of its own.
 */
import { useState } from "react";
import { api } from "../../api/client";
import type { Initiative } from "../../api/adminTypes";
import type { ProjectCosts } from "../../api/types";
import { Badge, Button, Field, Input, Select } from "../../ui/kit";
import { optionEls, useAction, useComplianceProfiles, useUsers, userOpts } from "../admin/adminKit";
import a from "../admin/admin.module.css";
import v from "../views.module.css";

const CLEAR = "__clear__";

export function ProjectCreateForm(props: { onDone?: () => void }) {
  const users = useUsers();
  const profiles = useComplianceProfiles();
  const act = useAction();
  const [f, setF] = useState({
    name: "",
    costCenter: "",
    budgetUsd: "",
    budgetApproverUserId: "",
    budgetPeriod: "",
    alertThresholdPct: "",
    arbiterUserId: "",
    classifications: [] as string[],
  });
  const set = (k: keyof typeof f, val: string | string[]) => setF((s) => ({ ...s, [k]: val }));
  const tagList = (profiles.data?.profiles ?? []).map((p) => p.tag);
  return (
    <>
      <form
        className={a.formRow}
        onSubmit={(e) => {
          e.preventDefault();
          if (f.budgetUsd && !f.budgetApproverUserId) {
            act.setError("a project budget requires a named budget approver — pick one or clear the budget");
            return;
          }
          void act
            .run(
              () =>
                api.post("/v1/projects", {
                  name: f.name,
                  ...(f.costCenter ? { costCenter: f.costCenter } : {}),
                  ...(f.budgetUsd ? { budgetUsd: Number(f.budgetUsd) } : {}),
                  ...(f.budgetApproverUserId ? { budgetApproverUserId: f.budgetApproverUserId } : {}),
                  ...(f.budgetPeriod ? { budgetPeriod: f.budgetPeriod } : {}),
                  ...(f.alertThresholdPct ? { alertThresholdPct: Number(f.alertThresholdPct) } : {}),
                  ...(f.arbiterUserId ? { arbiterUserId: f.arbiterUserId } : {}),
                  ...(f.classifications.length ? { classifications: f.classifications } : {}),
                }),
              "Project created",
            )
            .then((ok) => {
              if (!ok) return;
              setF({ name: "", costCenter: "", budgetUsd: "", budgetApproverUserId: "", budgetPeriod: "", alertThresholdPct: "", arbiterUserId: "", classifications: [] });
              props.onDone?.();
            });
        }}
      >
        <Field label="Name">
          <Input required value={f.name} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field label="Cost centre">
          <Input value={f.costCenter} onChange={(e) => set("costCenter", e.target.value)} placeholder="for example CC-0042" />
        </Field>
        <Field label="Budget USD">
          <Input type="number" step="any" value={f.budgetUsd} onChange={(e) => set("budgetUsd", e.target.value)} placeholder="for example 25" />
        </Field>
        <Field label="Budget approver">
          <Select value={f.budgetApproverUserId} onChange={(e) => set("budgetApproverUserId", e.target.value)}>
            {optionEls(userOpts(users.data?.users), "— none —")}
          </Select>
        </Field>
        <Field label="Budget period">
          <Select value={f.budgetPeriod} onChange={(e) => set("budgetPeriod", e.target.value)}>
            <option value="">none (lifetime)</option>
            <option value="monthly">monthly (calendar month)</option>
          </Select>
        </Field>
        <Field label="Alert threshold %">
          <Input type="number" value={f.alertThresholdPct} onChange={(e) => set("alertThresholdPct", e.target.value)} placeholder="default 80" />
        </Field>
        <Field label="Context arbiter">
          <Select value={f.arbiterUserId} onChange={(e) => set("arbiterUserId", e.target.value)}>
            {optionEls(userOpts(users.data?.users), "— none —")}
          </Select>
        </Field>
        <Field label="Classifications">
          <Select
            multiple
            size={Math.min(4, Math.max(2, tagList.length || 2))}
            value={f.classifications}
            onChange={(e) => set("classifications", Array.from(e.target.selectedOptions).map((o) => o.value))}
          >
            {tagList.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" variant="primary" disabled={act.busy}>
          Create project
        </Button>
        {act.error && (
          <span className={v.errLine} role="alert">
            {act.error}
          </span>
        )}
      </form>
      <p className={v.faint}>A budget only exists together with its named budget approver — set both or neither.</p>
    </>
  );
}

export function ProjectEditForm(props: {
  projects: Array<{ id: string; name: string }>;
  initiatives: Initiative[];
  /** opened from one project: that project, with no picker, and what it holds now as the placeholders */
  projectId?: string;
  current?: { name: string; budgetUsd?: number | null };
  onDone?: () => void;
}) {
  const users = useUsers();
  const act = useAction();
  const [f, setF] = useState({
    projectId: props.projectId ?? "",
    name: "",
    costCenter: "",
    budgetUsd: "",
    budgetApproverUserId: "",
    budgetPeriod: "",
    alertThresholdPct: "",
    arbiterUserId: "",
    initiativeId: "",
  });
  const set = (k: keyof typeof f, val: string) => setF((s) => ({ ...s, [k]: val }));
  const uOpts = userOpts(users.data?.users);
  const clearableU = [{ v: CLEAR, l: "— clear —" }, ...uOpts];
  const clearableI = [
    { v: CLEAR, l: "— clear —" },
    ...props.initiatives.map((i) => ({ v: i.id, l: i.name })),
  ];
  return (
    <>
      <form
        className={a.formRow}
        onSubmit={(e) => {
          e.preventDefault();
          const body: Record<string, unknown> = {};
          if (f.name) body.name = f.name;
          if (f.costCenter) body.costCenter = f.costCenter;
          if (f.budgetUsd !== "") body.budgetUsd = Number(f.budgetUsd);
          if (f.budgetPeriod) body.budgetPeriod = f.budgetPeriod;
          if (f.alertThresholdPct !== "") body.alertThresholdPct = Number(f.alertThresholdPct);
          for (const k of ["budgetApproverUserId", "arbiterUserId", "initiativeId"] as const) {
            if (f[k]) body[k] = f[k] === CLEAR ? null : f[k];
          }
          void act.run(() => api.patch(`/v1/projects/${f.projectId}`, body), "Project updated").then((ok) => {
            if (ok) props.onDone?.();
          });
        }}
      >
        {props.projectId ? null : (
          <Field label="Project">
            <Select required value={f.projectId} onChange={(e) => set("projectId", e.target.value)}>
              {optionEls(
                props.projects.map((p) => ({ v: p.id, l: p.name })),
                "— select —",
              )}
            </Select>
          </Field>
        )}
        <Field label="New name">
          <Input value={f.name} onChange={(e) => set("name", e.target.value)} placeholder={props.current?.name ?? "leave unchanged"} />
        </Field>
        <Field label="Cost centre">
          <Input value={f.costCenter} onChange={(e) => set("costCenter", e.target.value)} placeholder="leave unchanged" />
        </Field>
        <Field label="Budget USD">
          <Input
            type="number"
            step="any"
            value={f.budgetUsd}
            onChange={(e) => set("budgetUsd", e.target.value)}
            placeholder={props.current ? (props.current.budgetUsd != null ? `now ${props.current.budgetUsd}` : "now none") : "leave unchanged"}
          />
        </Field>
        <Field label="Budget approver">
          <Select value={f.budgetApproverUserId} onChange={(e) => set("budgetApproverUserId", e.target.value)}>
            {optionEls(clearableU, "— leave unchanged —")}
          </Select>
        </Field>
        <Field label="Budget period">
          <Select value={f.budgetPeriod} onChange={(e) => set("budgetPeriod", e.target.value)}>
            <option value="">— leave unchanged —</option>
            <option value="none">none (lifetime)</option>
            <option value="monthly">monthly (calendar month)</option>
          </Select>
        </Field>
        <Field label="Alert threshold %">
          <Input type="number" value={f.alertThresholdPct} onChange={(e) => set("alertThresholdPct", e.target.value)} placeholder="leave unchanged" />
        </Field>
        <Field label="Arbiter">
          <Select value={f.arbiterUserId} onChange={(e) => set("arbiterUserId", e.target.value)}>
            {optionEls(clearableU, "— leave unchanged —")}
          </Select>
        </Field>
        <Field label="Initiative">
          <Select value={f.initiativeId} onChange={(e) => set("initiativeId", e.target.value)}>
            {optionEls(clearableI, "— leave unchanged —")}
          </Select>
        </Field>
        <Button type="submit" size="sm" disabled={act.busy}>
          Save changes
        </Button>
        {act.error && (
          <span className={v.errLine} role="alert">
            {act.error}
          </span>
        )}
      </form>
      <p className={v.faint}>Only the fields you fill in change. A budget still requires a named approver after the edit.</p>
    </>
  );
}

// ---- CXR-CST-002: the overage state the server ENFORCES, not the raw latch -----------------------------------
// The gateway suppresses budget enforcement only while `overageActive` is true (a monthly budget's approval covers only
// the period it was granted in), so a latch left over from an earlier month is history, not "approved now".

type Budget = NonNullable<ProjectCosts["budget"]>;

/** the badge for an over-budget project: warn while an approved overage is in force, danger otherwise */
export function OverageBadge(props: { budget: Budget }) {
  return props.budget.overageActive ? (
    <Badge tone="warn">overage approved</Badge>
  ) : (
    <Badge tone="danger">over budget</Badge>
  );
}

/** a line naming an approval that no longer covers this period; nothing when there is none */
export function OverageHistory(props: { budget: Budget }) {
  const b = props.budget;
  if (!b.overageApproved || b.overageActive) return null;
  return (
    <span className={v.faint} data-testid="overage-history">
      An overage was approved {b.overageApprovedPeriod ? `for ${b.overageApprovedPeriod}` : "in an earlier period"}; it
      does not cover this period, so the budget is enforced again.
    </span>
  );
}
