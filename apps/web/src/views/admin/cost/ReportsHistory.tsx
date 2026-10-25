/**
 * Batch U4 — report definitions and runs one at a time, and the run history
 * (ADR-0047):
 *
 *  - a definition with its resolved scope and schedules (`GET /v1/reports/definitions/:id`);
 *  - one generated run, scope-checked by the gateway (`GET /v1/reports/runs/:id`);
 *  - run history, filterable by definition, with the route's own limit
 *    (`GET /v1/reports/runs?definitionId=&limit=`). A non-admin gets only the
 *    runs they could have generated themselves; the page says so.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago, fmtAt, fmtUsd } from "../../../api/format";
import { Badge, Button, Card, EmptyState, Field, Select, Table } from "../../../ui/kit";
import { KV, useProjects } from "../adminKit";
import { DetailDialog } from "../DetailDialog";
import a from "../admin.module.css";
import v from "../../views.module.css";

const REPORT_REFUSALS: Readonly<Record<string, string>> = {
  unknown_report_definition: "This report definition no longer exists. It may have been deleted; reload the page.",
  unknown_report_run: "There is no report run with this ID. Reload the page.",
  report_scope_not_entitled: "This report covers projects outside what you can see, so it is not shown. The refused read is recorded in the audit log.",
};

const obj = (x: unknown): Record<string, unknown> => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

/** the figures a stored report payload carries, read defensively (nothing is invented) */
function ReportPayloadView(props: { payload: unknown }) {
  const p = obj(props.payload);
  const spend = obj(p.spend);
  const gov = obj(p.governance);
  const controls = obj(p.controls);
  const lines = Array.isArray(spend.lines) ? spend.lines.map(obj) : [];
  const controlRows = Array.isArray(controls.controls) ? controls.controls.map(obj) : [];
  const rows: Array<[string, string]> = [];
  if (num(spend.totalCostUsd) !== null) rows.push(["Total spend (estimate)", fmtUsd(num(spend.totalCostUsd))]);
  if (num(spend.totalEvents) !== null) rows.push(["Metered calls", String(num(spend.totalEvents))]);
  if (num(gov.totalDecisions) !== null) rows.push(["Governed decisions", `${num(gov.totalDecisions)} (${num(gov.deny) ?? 0} denied)`]);
  if (num(controls.met) !== null) rows.push(["Controls", `${num(controls.met)} met, ${num(controls.gaps) ?? 0} gaps`]);
  return (
    <div className={v.stack}>
      {typeof p.disclaimer === "string" && <p className={v.faint}>{p.disclaimer}</p>}
      {rows.length > 0 ? <KV rows={rows} /> : <p className={v.faint}>This run's stored report carries no summary figures.</p>}
      {lines.length > 0 && (
        <Table
          rows={lines}
          rowKey={(l) => String(l.projectId ?? "(unattributed)")}
          columns={[
            { key: "p", header: "Project", render: (l) => (typeof l.projectName === "string" ? l.projectName : <span className={v.faint}>(unattributed)</span>) },
            { key: "c", header: "Spend", align: "right", render: (l) => fmtUsd(num(l.costUsd)) },
            { key: "e", header: "Calls", align: "right", render: (l) => num(l.events) ?? "—" },
          ]}
        />
      )}
      {controlRows.length > 0 && (
        <Table
          rows={controlRows}
          rowKey={(c) => String(c.id)}
          columns={[
            { key: "t", header: "Control", render: (c) => String(c.title ?? c.id ?? "") },
            { key: "s", header: "Status", render: (c) => <Badge tone={c.status === "met" ? "ok" : "danger"}>{String(c.status ?? "unknown")}</Badge> },
          ]}
        />
      )}
    </div>
  );
}

interface RunRecord {
  id: string;
  definitionId: string;
  trigger: string;
  period: string;
  periodStart: string;
  periodEnd: string;
  entitlementScope: string;
  effectiveProjectIds: string[] | null;
  format: string;
  rowCount: number;
  generatedAt: string;
  payload?: unknown;
}

export function ReportRunDetail(props: { id: string; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["admin", "report-run", props.id],
    retry: false,
    queryFn: () => api.get<{ run: RunRecord }>(`/v1/reports/runs/${encodeURIComponent(props.id)}`),
  });
  return (
    <DetailDialog title="Report run" noun="report run" query={q} refusals={REPORT_REFUSALS} onClose={props.onClose}>
      {({ run }) => (
        <div className={v.stack}>
          <KV
            rows={[
              ["Generated", fmtAt(run.generatedAt)],
              ["Trigger", run.trigger],
              ["Period", `${run.period}: ${fmtAt(run.periodStart)} – ${fmtAt(run.periodEnd)}`],
              ["Entitlement", run.effectiveProjectIds === null ? `${run.entitlementScope}, org-wide` : `${run.entitlementScope}, ${run.effectiveProjectIds.length} project(s)`],
              ["Rows", run.rowCount],
            ]}
          />
          <ReportPayloadView payload={run.payload} />
          <div className={v.row}>
            <a href={`/v1/reports/runs/${run.id}/export?format=csv`} target="_blank" rel="noreferrer">
              Export CSV
            </a>
            <a href={`/v1/reports/runs/${run.id}/export?format=json&signed=1`} target="_blank" rel="noreferrer">
              Signed JSON bundle
            </a>
          </div>
        </div>
      )}
    </DetailDialog>
  );
}

interface DefinitionDetail {
  definition: {
    id: string;
    name: string;
    kind: string;
    scopeKind: string;
    scopeId: string | null;
    period: string;
    sections: string[] | null;
    format: string;
    entitlementScope: string;
    description: string | null;
    createdAt: string;
  };
  scopeProjectIds: string[] | null;
  schedules: Array<{ id: string; cadence: string; enabled: boolean; lastGeneratedAt: string | null; lastRunId: string | null }>;
}

export function ReportDefinitionDetail(props: { id: string; onClose: () => void; onOpenRun: (id: string) => void }) {
  const projects = useProjects();
  const projectName = new Map((projects.data?.projects ?? []).map((p) => [p.id, p.name]));
  const q = useQuery({
    queryKey: ["admin", "report-definition", props.id],
    retry: false,
    queryFn: () => api.get<DefinitionDetail>(`/v1/reports/definitions/${encodeURIComponent(props.id)}`),
  });
  return (
    <DetailDialog
      title={q.data ? `Report definition — ${q.data.definition.name}` : "Report definition"}
      noun="report definition"
      query={q}
      refusals={REPORT_REFUSALS}
      onClose={props.onClose}
    >
      {(d) => (
        <div className={v.stack}>
          <KV
            rows={[
              ["Kind", d.definition.kind],
              ["Scope", d.definition.scopeKind],
              ["Grant", d.definition.entitlementScope],
              ["Period", d.definition.period],
              ["Sections", d.definition.sections?.length ? d.definition.sections.join(", ") : "all"],
              ["Format", d.definition.format],
              ["Description", d.definition.description ?? "none"],
              ["Created", fmtAt(d.definition.createdAt)],
            ]}
          />
          <div className={v.sectionTitle}>Resolved scope</div>
          {d.scopeProjectIds === null ? (
            <p>Org-wide: every project, and spend attributed to no project.</p>
          ) : d.scopeProjectIds.length === 0 ? (
            <p>The scope resolves to no project today, so a generation would report nothing.</p>
          ) : (
            <ul aria-label="Projects in scope">
              {d.scopeProjectIds.map((id) => (
                <li key={id}>{projectName.get(id) ?? <code>{id}</code>}</li>
              ))}
            </ul>
          )}
          <p className={v.faint}>A generation is still narrowed to what the person generating it can see.</p>
          <div className={v.sectionTitle}>Schedules</div>
          <Table
            rows={d.schedules}
            rowKey={(s) => s.id}
            empty={<EmptyState title="No schedules" />}
            columns={[
              { key: "c", header: "Cadence", render: (s) => s.cadence },
              { key: "e", header: "Enabled", render: (s) => (s.enabled ? "yes" : "no") },
              { key: "l", header: "Last generated", render: (s) => (s.lastGeneratedAt ? ago(s.lastGeneratedAt) : "never") },
              {
                key: "o",
                header: "",
                srHeader: "Actions",
                align: "right",
                render: (s) =>
                  s.lastRunId ? (
                    <Button size="sm" aria-label={`Open last run (${s.cadence})`} onClick={() => props.onOpenRun(s.lastRunId!)}>
                      Open last run
                    </Button>
                  ) : null,
              },
            ]}
          />
        </div>
      )}
    </DetailDialog>
  );
}

const RUN_LIMITS = [50, 100, 200] as const;

export function ReportRunsCard(props: { definitions: Array<{ id: string; name: string }>; onOpenRun: (id: string) => void }) {
  const [definitionId, setDefinitionId] = useState("");
  const [limit, setLimit] = useState<number>(RUN_LIMITS[0]);
  const q = useQuery({
    queryKey: ["admin", "report-runs", definitionId, limit],
    queryFn: () =>
      api.get<{ runs: RunRecord[] }>(`/v1/reports/runs?limit=${limit}${definitionId ? `&definitionId=${encodeURIComponent(definitionId)}` : ""}`),
  });
  const defName = new Map(props.definitions.map((d) => [d.id, d.name]));
  return (
    <Card title="Run history">
      <div className={v.stack}>
        <div className={a.formRow}>
          <Field label="Definition">
            <Select value={definitionId} onChange={(e) => setDefinitionId(e.target.value)}>
              <option value="">every definition</option>
              {props.definitions.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Show at most">
            <Select value={String(limit)} onChange={(e) => setLimit(Number(e.target.value))}>
              {RUN_LIMITS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Table<RunRecord>
          rows={q.data?.runs}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => void q.refetch()}
          rowKey={(r) => r.id}
          empty={<EmptyState title="No runs" body="No report matching this filter has been generated, or none is within what you can see." />}
          columns={[
            { key: "d", header: "Definition", render: (r) => defName.get(r.definitionId) ?? "deleted definition" },
            { key: "g", header: "Generated", render: (r) => ago(r.generatedAt) },
            { key: "t", header: "Trigger", render: (r) => r.trigger },
            { key: "p", header: "Period", render: (r) => `${r.periodStart.slice(0, 10)} – ${r.periodEnd.slice(0, 10)}` },
            { key: "s", header: "Entitlement", render: (r) => (r.effectiveProjectIds === null ? "org-wide" : `${r.effectiveProjectIds.length} project(s)`) },
            { key: "n", header: "Rows", align: "right", render: (r) => r.rowCount },
            {
              key: "o",
              header: "",
              srHeader: "Actions",
              align: "right",
              render: (r) => (
                <Button size="sm" aria-label={`Open the ${defName.get(r.definitionId) ?? "report"} run from ${ago(r.generatedAt)}`} onClick={() => props.onOpenRun(r.id)}>
                  Open
                </Button>
              ),
            },
          ]}
        />
        {(q.data?.runs?.length ?? 0) >= limit && <p className={v.faint}>Showing the newest {limit}. Choose a definition, or raise the limit, for older runs.</p>}
        <p className={v.faint}>Only runs you could generate yourself are listed; an administrator sees every run.</p>
      </div>
    </Card>
  );
}
