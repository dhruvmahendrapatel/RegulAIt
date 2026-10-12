/**
 * Batch U4 — the spend monitor's records past the overview's newest 25:
 *
 *  - every anomaly signal, filtered by project and status with the route's own
 *    limit (`GET /v1/spend/anomalies?projectId=&status=&limit=`); a non-admin
 *    gets only their projects' signals, narrowed by the gateway;
 *  - every decided future change, filtered by project (`GET /v1/spend/scheduled-changes?projectId=`).
 *
 * Both load when opened ("Show all"), not with the page. Acting on a signal or
 * a change stays on the cards above.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago, fmtAt, fmtUsd } from "../../../api/format";
import { Badge, Button, EmptyState, Field, Select, Table } from "../../../ui/kit";
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

const LIMITS = [50, 100, 200] as const;

function useProjectName() {
  const projects = useProjects();
  const names = new Map((projects.data?.projects ?? []).map((p) => [p.id, p.name]));
  return { projects, name: (id: string) => names.get(id) ?? "unknown project" };
}

export function AnomalyHistory() {
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [status, setStatus] = useState("");
  const [limit, setLimit] = useState<number>(LIMITS[0]);
  const { projects, name } = useProjectName();
  const params = new URLSearchParams({ limit: String(limit), ...(projectId ? { projectId } : {}), ...(status ? { status } : {}) });
  const q = useQuery({
    queryKey: ["admin", "spend-anomalies-all", projectId, status, limit],
    enabled: open,
    queryFn: () => api.get<{ anomalies: Anomaly[]; note: string }>(`/v1/spend/anomalies?${params.toString()}`),
  });
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
        <Field label="Show at most">
          <Select value={String(limit)} onChange={(e) => setLimit(Number(e.target.value))}>
            {LIMITS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Table<Anomaly>
        rows={q.data?.anomalies}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        rowKey={(r) => r.id}
        empty={<EmptyState title="No signals match" />}
        columns={[
          { key: "p", header: "Project", render: (r) => name(r.projectId) },
          { key: "s", header: "Signal", render: (r) => r.signal },
          { key: "o", header: "Observed", render: (r) => r.observed },
          { key: "sc", header: "Score vs threshold", render: (r) => (r.score == null ? "—" : `${r.score} vs ${r.threshold}`) },
          { key: "a", header: "Action", render: (r) => (r.approvalId ? <Badge tone="warn">approval raised</Badge> : <Badge tone="info">alert only</Badge>) },
          { key: "st", header: "Status", render: (r) => <span title={r.decisionReason ?? undefined}>{r.status}</span> },
          { key: "d", header: "Detected", render: (r) => ago(r.detectedAt) },
        ]}
      />
      {(q.data?.anomalies?.length ?? 0) >= limit && <p className={v.faint}>Showing the newest {limit}. Narrow by project or status, or raise the limit.</p>}
      {q.data && <p className={v.faint}>{q.data.note}</p>}
    </section>
  );
}

export function ScheduledChangeHistory() {
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState("");
  const { projects, name } = useProjectName();
  const q = useQuery({
    queryKey: ["admin", "spend-scheduled-changes-all", projectId],
    enabled: open,
    queryFn: () =>
      api.get<{ scheduledChanges: ScheduledChange[] }>(`/v1/spend/scheduled-changes${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  });
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
      <Table<ScheduledChange>
        rows={q.data?.scheduledChanges}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        rowKey={(c) => c.id}
        empty={<EmptyState title="No decided changes match" />}
        columns={[
          { key: "p", header: "Project", render: (c) => name(c.projectId) },
          { key: "d", header: "Delta", align: "right", render: (c) => fmtUsd(c.deltaUsd) },
          { key: "e", header: "Effective", render: (c) => fmtAt(c.effectiveAt) },
          { key: "r", header: "Reason", render: (c) => c.reason },
        ]}
      />
    </section>
  );
}
