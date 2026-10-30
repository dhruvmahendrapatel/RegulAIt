/**
 * Batch U4 — the spend monitor's records past the overview's newest 25:
 *
 *  - every anomaly signal, filtered by project and status and paged by the
 *    shared list control (`GET /v1/spend/anomalies?projectId=&status=`); a
 *    non-admin gets only their projects' signals, narrowed by the gateway;
 *  - every decided future change, filtered by project (`GET /v1/spend/scheduled-changes?projectId=`).
 *
 * Both load when opened ("Show all"), not with the page. Acting on a signal or
 * a change stays on the cards above.
 */
import { useMemo, useState } from "react";
import { DataList } from "../../../ui/DataList";
import { ago, fmtAt, fmtUsd } from "../../../api/format";
import { Badge, Button, EmptyState, Field, Select } from "../../../ui/kit";
import { optionEls, projectOpts, useProjects } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

interface Anomaly {
  id: string;
  projectId: string;
  signal: string;
  method: string;
  observed: number;
  score: number | null;
  threshold: number | null;
  explanation: string;
  approvalId: string | null;
  status: "open" | "acknowledged" | "dismissed";
  decisionReason: string | null;
  detectedAt: string;
}
interface ScheduledChange {
  id: string;
  projectId: string;
  deltaUsd: number;
  effectiveAt: string;
  reason: string;
}

function useProjectName() {
  const projects = useProjects();
  const names = new Map((projects.data?.projects ?? []).map((p) => [p.id, p.name]));
  return { projects, name: (id: string) => names.get(id) ?? "unknown project" };
}

export function AnomalyHistory() {
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [status, setStatus] = useState("");
  const { projects, name } = useProjectName();
  const filters = useMemo(() => ({ projectId: projectId || undefined, status: status || undefined }), [projectId, status]);
  const [note, setNote] = useState<string | null>(null);
  if (!open)
    return (
      <div>
        <Button size="sm" onClick={() => setOpen(true)}>
          Show all signals
        </Button>
      </div>
    );
  return (
    <section className={v.stack} aria-label="All anomaly signals">
      <div className={v.sectionTitle}>All anomaly signals</div>
      <div className={a.formRow}>
        <Field label="Signal project">
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {optionEls(projectOpts(projects.data?.projects), "every project")}
          </Select>
        </Field>
        <Field label="Signal status">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            {optionEls(["open", "acknowledged", "dismissed"].map((s) => ({ v: s, l: s })), "every status")}
          </Select>
        </Field>
      </div>
      <DataList<Anomaly & { projectName?: string | null }>
        listId="spend-anomalies"
        noun="anomaly signals"
        endpoint="/v1/spend/anomalies"
        exportPath="/v1/spend/anomalies/export.xlsx"
        queryKey={["admin", "spend-anomalies-all", "list"]}
        legacyKey="anomalies"
        filters={filters}
        defaultSort={{ key: "d", dir: "desc" }}
        onRows={(_rows, raw) => setNote(typeof raw.note === "string" ? raw.note : null)}
        rowKey={(r) => r.id}
        empty={<EmptyState title="No signals match" />}
        columns={[
          { key: "p", header: "Project", main: true, sortable: true, render: (r) => r.projectName ?? name(r.projectId) },
          { key: "s", header: "Signal", main: true, sortable: true, render: (r) => r.signal },
          { key: "o", header: "Observed", main: true, sortable: true, render: (r) => r.observed },
          { key: "sc", header: "Score vs threshold", main: true, sortable: true, render: (r) => (r.score == null ? "—" : `${r.score} vs ${r.threshold}`) },
          { key: "a", header: "Action", main: true, sortable: true, required: "Whether an approval was raised is always shown", render: (r) => (r.approvalId ? <Badge tone="warn">approval raised</Badge> : <Badge tone="info">alert only</Badge>) },
          { key: "st", header: "Status", main: true, sortable: true, required: "Status is always shown", render: (r) => <span title={r.decisionReason ?? undefined}>{r.status}</span> },
          { key: "d", header: "Detected", main: true, sortable: true, render: (r) => ago(r.detectedAt) },
          { key: "m", header: "Method", sortable: true, render: (r) => r.method },
          { key: "x", header: "Explanation", render: (r) => r.explanation },
        ]}
      />
      {note && <p className={v.faint}>{note}</p>}
    </section>
  );
}

export function ScheduledChangeHistory() {
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState("");
  const { projects, name } = useProjectName();
  const changeFilters = useMemo(() => ({ projectId: projectId || undefined }), [projectId]);
  if (!open)
    return (
      <div>
        <Button size="sm" onClick={() => setOpen(true)}>
          Show all changes
        </Button>
      </div>
    );
  return (
    <section className={v.stack} aria-label="All decided changes">
      <div className={v.sectionTitle}>All decided changes</div>
      <div className={a.formRow}>
        <Field label="Change project">
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {optionEls(projectOpts(projects.data?.projects), "every project")}
          </Select>
        </Field>
      </div>
      <DataList<ScheduledChange & { projectName?: string | null; createdAt?: string }>
        listId="spend-scheduled-changes"
        noun="decided changes"
        endpoint="/v1/spend/scheduled-changes"
        exportPath="/v1/spend/scheduled-changes/export.xlsx"
        queryKey={["admin", "spend-scheduled-changes-all", "list"]}
        legacyKey="scheduledChanges"
        filters={changeFilters}
        defaultSort={{ key: "e", dir: "desc" }}
        rowKey={(c) => c.id}
        empty={<EmptyState title="No decided changes match" />}
        columns={[
          { key: "p", header: "Project", main: true, sortable: true, render: (c) => c.projectName ?? name(c.projectId) },
          { key: "d", header: "Delta", main: true, sortable: true, align: "right", render: (c) => fmtUsd(c.deltaUsd) },
          { key: "e", header: "Effective", main: true, sortable: true, render: (c) => fmtAt(c.effectiveAt) },
          { key: "r", header: "Reason", main: true, sortable: true, render: (c) => c.reason },
          { key: "c", header: "Decided", sortable: true, render: (c) => (c.createdAt ? ago(c.createdAt) : "—") },
        ]}
      />
    </section>
  );
}
