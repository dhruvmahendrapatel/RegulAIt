/**
 * Cost dashboard (pillar 5) — fleet budget-vs-actual with meters, per-project
 * rollup (measured spend, month-end forecast, showback by user/team/agent,
 * measured savings, CSV export), the explicit Unattributed bucket, project
 * create/edit, and initiatives (reporting-only rollup).
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type { AdminProject, Initiative, UnattributedCosts } from "../../../api/adminTypes";
import type { ProjectCosts } from "../../../api/types";
import { fmtUsd } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Input, Meter, Select, Table } from "../../../ui/kit";
import { useToast } from "../../../ui/toast";
import {
  BarChart,
  RemoveButton,
  Stat,
  downloadCsv,
  optionEls,
  useAction,
  useComplianceProfiles,
  useNameMaps,
  useProjects,
  useUsers,
  userOpts,
} from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

const CLEAR = "__clear__";

export default function CostDashboardPage() {
  const projects = useProjects();
  const [rollupId, setRollupId] = useState<string | null>(null);
  const initiatives = useQuery({
    queryKey: ["admin", "initiatives"],
    queryFn: () => api.get<{ initiatives: Initiative[] }>("/v1/initiatives"),
  });
  const iname = useMemo(
    () => new Map((initiatives.data?.initiatives ?? []).map((x) => [x.id, x.name])),
    [initiatives.data],
  );

  return (
    <>
      <PageHeader
        title="Cost dashboard"
        sub="Per-project AI spend, attributed at the point of every gateway call."
        info={<p>Real-time per-project AI spend attribution applied at the point of every gateway call — budget-vs-actual, forecast, showback, chargeback. Built into the gateway, not bolted on.</p>}
      />
      <div className={v.stack}>
        <Card flush title="Projects — fleet spend">
          <Table<AdminProject>
            columns={[
              { key: "name", header: "Project", sort: (p) => p.name, render: (p) => p.name },
              { key: "costCenter", header: "Cost center", render: (p) => p.costCenter ?? "—" },
              { key: "initiative", header: "Initiative", render: (p) => iname.get(p.initiativeId ?? "") ?? "—" },
              {
                key: "budget",
                header: "Budget vs actual",
                width: "260px",
                render: (p) =>
                  p.budgetUsd == null ? (
                    <span className={v.faint}>no budget set</span>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <span className={v.faint}>
                        {fmtUsd(p.spentUsd)} of {fmtUsd(p.budgetUsd)}
                        {p.budgetPeriod === "monthly" ? " this month" : ""}
                      </span>
                      <Meter
                        value={p.spentUsd}
                        max={p.budgetUsd}
                        warn={
                          p.alertThresholdPct != null &&
                          p.alertThresholdPct < 100 &&
                          p.spentUsd >= (p.budgetUsd * p.alertThresholdPct) / 100
                        }
                        over={p.spentUsd > p.budgetUsd}
                        markPct={p.alertThresholdPct ?? undefined}
                        label={`${p.name} budget`}
                      />
                    </div>
                  ),
              },
              {
                key: "spent",
                header: "Spent",
                align: "right",
                sort: (p) => p.spentUsd,
                render: (p) => <span className={v.num}>{fmtUsd(p.spentUsd)}</span>,
              },
              {
                key: "classifications",
                header: "Classifications",
                render: (p) => (
                  <span className={v.rowTight}>
                    {(p.classifications ?? []).map((c) => (
                      <Badge key={c} tone="info">
                        {c}
                      </Badge>
                    ))}
                  </span>
                ),
              },
            ]}
            rows={projects.data?.projects ?? []}
            rowKey={(p) => p.id}
            loading={projects.isLoading}
            error={projects.error}
            onRetry={() => void projects.refetch()}
            onRowClick={(p) => setRollupId(p.id === rollupId ? null : p.id)}
            rowLabel={(p) => `Open cost rollup for ${p.name}`}
            empty={
              <EmptyState
                title="No projects yet"
                body="Budgets and cost attribution hang off projects; calls without one land in the Unattributed bucket."
              />
            }
          />
        </Card>

        {rollupId && (
          <ProjectRollup
            key={rollupId}
            projectId={rollupId}
            projectName={(projects.data?.projects ?? []).find((p) => p.id === rollupId)?.name ?? "project"}
          />
        )}

        <UnattributedCard />
        <CreateProjectCard />
        <EditProjectCard
          projects={projects.data?.projects ?? []}
          initiatives={initiatives.data?.initiatives ?? []}
        />
        <InitiativesCard initiatives={initiatives.data?.initiatives ?? []} loading={initiatives.isLoading} />
      </div>
    </>
  );
}

// ---- per-project rollup ---------------------------------------------------

function ProjectRollup(props: { projectId: string; projectName: string }) {
  const { toast } = useToast();
  const names = useNameMaps();
  const q = useQuery({
    queryKey: ["admin", "project-costs", props.projectId],
    queryFn: () => api.get<ProjectCosts>(`/v1/projects/${props.projectId}/costs`),
  });
  const c = q.data;
  const m = c?.measured ?? {};
  const b = c?.budget ?? {};
  const over = (b.spentUsd ?? 0) > (b.budgetUsd ?? Infinity);
  const crossed =
    !over &&
    (b.thresholdCrossed ??
      (b.alertThresholdPct != null &&
        b.alertThresholdPct < 100 &&
        b.thresholdUsd != null &&
        (b.spentUsd ?? 0) >= b.thresholdUsd));

  return (
    <Card
      title={
        <span>
          {props.projectName}
          {c?.initiative && <span className={v.faint}> · {c.initiative.name}</span>}
        </span>
      }
      actions={
        <Button
          size="sm"
          onClick={() =>
            void downloadCsv(
              `/v1/projects/${props.projectId}/costs.csv`,
              `${props.projectName}-costs.csv`,
              (msg) => toast(msg, "error"),
            )
          }
        >
          Download CSV
        </Button>
      }
    >
      {q.isLoading && <span className={v.dim}>Loading rollup…</span>}
      {c && (
        <div className={v.stack}>
          <div className={v.grid4}>
            <Stat value={fmtUsd(m.costUsd)} label={`measured spend · ${m.events ?? 0} calls`} />
            <Stat
              value={fmtUsd(c.forecast?.projectedEomUsd)}
              label={`projected month-end · ${c.forecast?.basis ?? ""}`}
            />
            <Stat
              value={`${(m as { inputTokens?: number }).inputTokens ?? 0} → ${(m as { outputTokens?: number }).outputTokens ?? 0}`}
              label="tokens in → out"
            />
            <Stat
              value={fmtUsd((m as { measuredCostSavedUsd?: number }).measuredCostSavedUsd)}
              label="measured savings (pillar 6)"
            />
          </div>
          <div className={v.sectionTitle}>Budget vs actual</div>
          {b.budgetUsd == null ? (
            <span className={v.faint}>no budget set</span>
          ) : (
            <div className={v.stack}>
              <div className={v.row}>
                <span className={v.num}>{fmtUsd(b.spentUsd)}</span>
                <span className={v.dim}>
                  of {fmtUsd(b.budgetUsd)}
                  {b.period === "monthly" ? " this month" : ""}
                </span>
                {over && (
                  <Badge tone={b.overageApproved ? "warn" : "danger"}>
                    {b.overageApproved ? "overage approved" : "over budget"}
                  </Badge>
                )}
                {crossed && <Badge tone="warn">{b.alertThresholdPct}% threshold crossed</Badge>}
              </div>
              <Meter
                value={b.spentUsd ?? 0}
                max={b.budgetUsd}
                warn={Boolean(crossed)}
                over={over}
                markPct={b.alertThresholdPct}
                label="project budget"
              />
              <span className={v.faint}>
                budget window:{" "}
                {b.period === "monthly" ? `this calendar month (${b.periodKey ?? ""})` : "lifetime"} · alert
                at {b.alertThresholdPct ?? 100}%
              </span>
            </div>
          )}
          <div className={v.grid2}>
            <div>
              <div className={v.sectionTitle}>Showback by user</div>
              <BarChart
                items={(c.byUser ?? []) as Array<Record<string, unknown>>}
                valueKey="costUsd"
                label={(i) => names.userName.get(String(i.userId)) ?? String(i.userId)}
                title="Showback by user"
              />
            </div>
            <div>
              <div className={v.sectionTitle}>Showback by team</div>
              <BarChart
                items={(c.byTeam ?? []) as Array<Record<string, unknown>>}
                valueKey="costUsd"
                label={(i) => String(i.name ?? "(no team)")}
                title="Showback by team"
              />
            </div>
            <div>
              <div className={v.sectionTitle}>By agent / model</div>
              <BarChart
                items={(c.byAgent ?? []) as Array<Record<string, unknown>>}
                valueKey="costUsd"
                label={(i) => String(i.model ?? i.agentId ?? "agent")}
                title="Spend by agent"
              />
            </div>
            {/* ADR-0019/0024: connector and MCP-tool spend ride the SAME
                ledger and are already inside the measured total — named here
                so the agent breakdown is not an unexplained gap against it. */}
            <div>
              <div className={v.sectionTitle}>Spend by connector</div>
              <BarChart
                items={(c.byConnector ?? []) as Array<Record<string, unknown>>}
                valueKey="costUsd"
                label={(i) => `${String(i.name ?? "connector")} · ${String(i.operation ?? "")}`}
                title="Spend by connector"
              />
            </div>
            <div>
              <div className={v.sectionTitle}>Spend by MCP tool</div>
              <BarChart
                items={(c.byMcpTool ?? []) as Array<Record<string, unknown>>}
                valueKey="costUsd"
                label={(i) => String(i.toolName ?? "tool")}
                title="Spend by MCP tool"
              />
            </div>
            <div>
              <div className={v.sectionTitle}>Estimated savings by technique</div>
              <BarChart
                items={(c.estimatedSavings ?? []) as Array<Record<string, unknown>>}
                valueKey="estimatedCostSavedUsd"
                label={(i) => String(i.technique)}
                title="Estimated savings by technique"
              />
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

// ---- unattributed bucket --------------------------------------------------

function UnattributedCard() {
  const names = useNameMaps();
  const q = useQuery({
    queryKey: ["admin", "unattributed"],
    queryFn: () => api.get<UnattributedCosts>("/v1/costs/unattributed"),
  });
  const u = q.data;
  return (
    <Card title="Unattributed spend — calls with no project header">
      {q.isLoading && <span className={v.dim}>Loading…</span>}
      {q.isError && <span className={v.errLine}>Unattributed rollup unavailable.</span>}
      {u?.measured && (
        <div className={v.stack}>
          <div className={v.grid2}>
            <Stat
              value={fmtUsd(u.measured.costUsd)}
              label={`unattributed spend · ${u.measured.events} calls`}
            />
            <Stat
              value={`${u.measured.inputTokens ?? 0} → ${u.measured.outputTokens ?? 0}`}
              label="tokens in → out"
            />
          </div>
          {(u.byUser ?? []).length > 0 && (
            <>
              <div className={v.sectionTitle}>By user</div>
              <BarChart
                items={(u.byUser ?? []) as Array<Record<string, unknown>>}
                valueKey="costUsd"
                label={(i) => names.userName.get(String(i.userId)) ?? String(i.userId)}
                title="Unattributed spend by user"
              />
            </>
          )}
          {(u.byMcpTool ?? []).length > 0 && (
            <>
              <div className={v.sectionTitle}>By MCP tool</div>
              <BarChart
                items={(u.byMcpTool ?? []) as Array<Record<string, unknown>>}
                valueKey="costUsd"
                label={(i) => String(i.toolName ?? "tool")}
                title="Unattributed spend by MCP tool"
              />
            </>
          )}
          {u.measured.events === 0 ? (
            <EmptyState title="Nothing unattributed" body="Every metered call carried a project." />
          ) : (
            <p className={v.faint}>
              These calls arrived without an x-regulait-project-id header. They are metered on the same
              ledger but can never count against any project budget. Close the gap in Client access:
              “require project attribution” (compat surfaces) and “require MCP attribution” (MCP proxy).
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

// ---- create / edit projects ----------------------------------------------

function CreateProjectCard() {
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
    <Card title="Create a project">
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
              if (ok)
                setF({ name: "", costCenter: "", budgetUsd: "", budgetApproverUserId: "", budgetPeriod: "", alertThresholdPct: "", arbiterUserId: "", classifications: [] });
            });
        }}
      >
        <Field label="Name">
          <Input required value={f.name} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field label="Cost center">
          <Input value={f.costCenter} onChange={(e) => set("costCenter", e.target.value)} placeholder="e.g. CC-0042" />
        </Field>
        <Field label="Budget USD">
          <Input type="number" step="any" value={f.budgetUsd} onChange={(e) => set("budgetUsd", e.target.value)} placeholder="e.g. 25" />
        </Field>
        <Field label="Budget approver">
          <Select value={f.budgetApproverUserId} onChange={(e) => set("budgetApproverUserId", e.target.value)}>
            {optionEls(userOpts(users.data?.users), "— none —")}
          </Select>
        </Field>
        <Field label="Budget period">
          <Select value={f.budgetPeriod} onChange={(e) => set("budgetPeriod", e.target.value)}>
            <option value="">none (lifetime)</option>
            <option value="none">none (lifetime)</option>
            <option value="monthly">monthly (calendar month)</option>
          </Select>
        </Field>
        <Field label="Alert threshold %">
          <Input type="number" value={f.alertThresholdPct} onChange={(e) => set("alertThresholdPct", e.target.value)} placeholder="e.g. 80 (default 100)" />
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
      <p className={v.faint}>
        A budget only exists together with its named budget approver — set both or neither. Classifications
        come from the compliance profiles and cascade that framework's required workflows, PII mode and
        retention onto everything the project governs — changing them later goes through the
        reclassification review (Compliance profiles), never a plain edit.
      </p>
    </Card>
  );
}

function EditProjectCard(props: { projects: AdminProject[]; initiatives: Initiative[] }) {
  const users = useUsers();
  const act = useAction();
  const [f, setF] = useState({
    projectId: "",
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
    <Card title="Edit a project — budget, approver, arbiter, cost center, name">
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
          void act.run(() => api.patch(`/v1/projects/${f.projectId}`, body), "Project updated");
        }}
      >
        <Field label="Project">
          <Select required value={f.projectId} onChange={(e) => set("projectId", e.target.value)}>
            {optionEls(
              props.projects.map((p) => ({ v: p.id, l: p.name })),
              "— select —",
            )}
          </Select>
        </Field>
        <Field label="New name">
          <Input value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="leave unchanged" />
        </Field>
        <Field label="Cost center">
          <Input value={f.costCenter} onChange={(e) => set("costCenter", e.target.value)} placeholder="leave unchanged" />
        </Field>
        <Field label="Budget USD">
          <Input type="number" step="any" value={f.budgetUsd} onChange={(e) => set("budgetUsd", e.target.value)} placeholder="leave unchanged" />
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
      <p className={v.faint}>
        Only the fields you fill in change. A budget still requires a named approver after the edit — the
        API holds the invariant against the merged result. Classifications are absent on purpose:
        reclassification is a governed diff-then-approve change with its own flow.
      </p>
    </Card>
  );
}

function InitiativesCard(props: { initiatives: Initiative[]; loading: boolean }) {
  const act = useAction();
  const [name, setName] = useState("");
  const [costCenter, setCostCenter] = useState("");
  return (
    <Card title="Initiatives — cross-team rollup">
      <form
        className={a.formRow}
        onSubmit={(e) => {
          e.preventDefault();
          void act
            .run(
              () => api.post("/v1/initiatives", { name, ...(costCenter ? { costCenter } : {}) }),
              "Initiative created",
            )
            .then((ok) => {
              if (ok) {
                setName("");
                setCostCenter("");
              }
            });
        }}
      >
        <Field label="Name">
          <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Platform Modernization" />
        </Field>
        <Field label="Cost center">
          <Input value={costCenter} onChange={(e) => setCostCenter(e.target.value)} placeholder="e.g. CC-PLAT" />
        </Field>
        <Button type="submit" size="sm" disabled={act.busy}>
          Create initiative
        </Button>
        {act.error && (
          <span className={v.errLine} role="alert">
            {act.error}
          </span>
        )}
      </form>
      <Table<Initiative>
        columns={[
          { key: "name", header: "Name", render: (i) => i.name },
          { key: "costCenter", header: "Cost center", render: (i) => i.costCenter ?? "—" },
          { key: "projects", header: "Projects", align: "right", render: (i) => i.projectCount ?? 0 },
          {
            key: "spend",
            header: "Rolled-up spend",
            align: "right",
            render: (i) => <span className={v.num}>{fmtUsd(i.spentUsd)}</span>,
          },
          {
            key: "actions",
            header: "",
            align: "right",
            render: (i) => (
              <RemoveButton
                what={i.name}
                // An initiative with projects under it is a live rollup. Deleting
                // it would silently change what every report over those projects
                // sums to, so the projects have to be moved off it first — which
                // is an edit somebody makes deliberately, on the card above.
                disabledReason={
                  (i.projectCount ?? 0) > 0
                    ? `${i.projectCount} project(s) roll up to this initiative — reassign them first, so no report silently changes what it totals`
                    : undefined
                }
                consequence={
                  <p>
                    The initiative is deleted. It is a reporting rollup only, so nothing about
                    spend, attribution or governance changes — every project keeps its own costs
                    and its own ledger rows. What goes is the grouping that reports could total by.
                  </p>
                }
                onRemove={() => api.del(`/v1/initiatives/${i.id}`)}
                // No onDone: RemoveButton's own run() invalidates every
                // ["admin", …] query, and this table is one of them. The manual
                // refetches elsewhere exist only where the rows are component
                // state rather than react-query.
              />
            ),
          },
        ]}
        rows={props.initiatives}
        rowKey={(i) => i.id}
        loading={props.loading}
        empty={<EmptyState title="No initiatives" />}
      />
      <p className={v.faint}>
        An initiative is a flat, reporting-only grouping of projects for cross-team cost attribution — no
        initiative-level budget or enforcement; each project keeps its own budget and governance. Group a
        project under one on the edit form above.
      </p>
    </Card>
  );
}
