/**
 * Workflows — governed change requests. The intake form resolves its route
 * LIVE beside the type select (never a silent match), exactly like the legacy
 * intake; only routable change types are offered.
 */
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../api/client";
import type { Project, WorkflowInstanceSummary, WorkflowListResponse } from "../../api/types";
import { ago, humanize } from "../../api/format";
import { PageHeader } from "../../shell/AppShell";
import {
  Button,
  Card,
  EmptyState,
  Field,
  IdChip,
  Input,
  RowActions,
  Select,
  StatusBadge,
} from "../../ui/kit";
import { DataList, type DataColumn } from "../../ui/DataList";
import { useToast } from "../../ui/toast";
import { useSession } from "../../session/SessionContext";
import { AbortWorkflowDialog, canAbort } from "./workflowAbort";
import v from "../views.module.css";

/** ADR-0219: the change-requests list's columns; the ids and sortable ones match the gateway's WORKFLOWS_LIST */
export const WORKFLOW_COLUMNS: Array<DataColumn<WorkflowInstanceSummary>> = [
  { key: "change", header: "Change", main: true, sortable: true, render: (i) => <span style={{ fontWeight: 550 }}>{i.change?.description ?? ""}</span> },
  { key: "status", header: "Status", main: true, sortable: true, required: "Status is always shown", render: (i) => <StatusBadge status={i.status} /> },
  { key: "type", header: "Type", main: true, sortable: true, render: (i) => (i.change?.changeType ? humanize(i.change.changeType) : "") },
  { key: "created", header: "Created", main: true, sortable: true, render: (i) => <span className={v.faint}>{ago(i.createdAt)}</span> },
  { key: "updated", header: "Last change", main: true, sortable: true, render: (i) => <span className={v.faint}>{i.updatedAt ? ago(i.updatedAt) : "—"}</span> },
  { key: "environment", header: "Environment", sortable: true, render: (i) => i.change?.environment ?? <span className={v.faint}>—</span> },
  { key: "target", header: "Target system", sortable: true, render: (i) => i.change?.targetSystem ?? <span className={v.faint}>—</span> },
  { key: "project", header: "Project", sortable: true, render: (i) => (i.projectId ? <IdChip id={i.projectId} /> : <span className={v.faint}>—</span>) },
  { key: "id", header: "Workflow id", sortable: true, render: (i) => <IdChip id={i.id} /> },
];

export default function WorkflowsPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // the list holds only what the reader may drive (their own, or every one for an admin); a bootstrap credential drives none
  const { auth } = useSession();
  const [aborting, setAborting] = useState<WorkflowInstanceSummary | null>(null);

  // the intake form's routable change types arrive with each page of the list (one read, not two)
  const [intake, setIntake] = useState<Pick<WorkflowListResponse, "changeTypes" | "routes">>({});
  const onRows = useCallback((_rows: WorkflowInstanceSummary[], raw: Record<string, unknown>) => {
    const body = raw as Pick<WorkflowListResponse, "changeTypes" | "routes">;
    setIntake({ changeTypes: body.changeTypes ?? [], routes: body.routes ?? [] });
  }, []);
  const projectsQ = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.get<{ projects: Project[] }>("/v1/projects"),
  });
  const projects = projectsQ.data?.projects ?? [];
  const changeTypes = intake.changeTypes ?? [];
  const routes = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const r of intake.routes ?? []) out[r.changeType] = r.templates ?? [];
    return out;
  }, [intake]);

  const [description, setDescription] = useState("");
  const [changeType, setChangeType] = useState("");
  const [targetSystem, setTargetSystem] = useState("");
  const [projectId, setProjectId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const effectiveType = changeType || changeTypes[0] || "";
  const resolved = routes[effectiveType] ?? [];

  const start = async () => {
    setError(null);
    if (!description.trim()) {
      setError("Describe the change before starting the workflow.");
      return;
    }
    setBusy(true);
    try {
      const r = await api.post<{ id: string }>("/v1/workflows/instances", {
        ...(projectId ? { projectId } : {}),
        change: {
          description: description.trim(),
          paths: ["src/"],
          changeType: effectiveType || "feature",
          environment: "staging",
          ...(targetSystem.trim() ? { targetSystem: targetSystem.trim() } : {}),
        },
      });
      toast("Workflow started", "success");
      void queryClient.invalidateQueries({ queryKey: ["workflows"] });
      navigate(`/workflows/${r.id}`);
    } catch (e) {
      const suffix =
        e instanceof ApiError && e.payload.error === "no_workflow_matches_change"
          ? " — no assignment rule matches this change type"
          : "";
      setError((e instanceof Error ? e.message : String(e)) + suffix);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Workflows"
        info={<p>Governed change requests — intake to sign-off to build, checks, PR and merge.</p>}
      />
      <div className={v.stack}>
        <Card title="Start a change">
          <div className={v.row}>
            <Field label="Describe the change" grow>
              <Input
                placeholder="Add rate limiting to the public API"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
            {changeTypes.length > 0 ? (
              <Field label="Type">
                <Select value={effectiveType} onChange={(e) => setChangeType(e.target.value)}>
                  {changeTypes.map((t) => (
                    <option key={t} value={t}>
                      {humanize(t)}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              <Field label="Type">
                <span className={v.dim}>
                  no routable change types — an admin must add an assignment rule
                </span>
              </Field>
            )}
            <Field label="Target system" help="The target system this change lands on — an assignment rule can route on it">
              <Input
                placeholder="optional"
                style={{ width: 130 }}
                value={targetSystem}
                onChange={(e) => setTargetSystem(e.target.value)}
              />
            </Field>
            <Field label="Bill to">
              <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">no project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div style={{ alignSelf: "flex-end" }}>
              <Button
                variant="primary"
                disabled={busy || changeTypes.length === 0 || !description.trim()}
                onClick={() => void start()}
              >
                {busy ? "Starting…" : "Start workflow"}
              </Button>
            </div>
          </div>
          <div className={v.faint} style={{ marginTop: "var(--s0)" }} aria-live="polite">
            {resolved.length > 0
              ? `→ runs the “${resolved.map(humanize).join("” + “")}” workflow${resolved.length > 1 ? "s (merged)" : ""}`
              : " "}
          </div>
          {error && (
            <div className={v.errLine} role="alert" style={{ marginTop: "var(--s0)" }}>
              {error}
            </div>
          )}
        </Card>

        <Card title="Your change requests" flush>
          <DataList<WorkflowInstanceSummary>
            listId="workflows"
            noun="change requests"
            endpoint="/v1/workflows/instances"
            exportPath="/v1/workflows/instances/export.xlsx"
            queryKey={["workflows", "list"]}
            legacyKey="instances"
            count="estimate"
            defaultSort={{ key: "created", dir: "desc" }}
            onRows={onRows}
            columns={[
              ...WORKFLOW_COLUMNS,
              {
                key: "actions",
                header: "",
                srHeader: "Actions",
                align: "right",
                action: true,
                render: (i) => (
                  <RowActions
                    slot="5rem"
                    secondary={
                      auth?.userId && canAbort(i.status) && (
                        <Button
                          size="sm"
                          variant="danger"
                          aria-label={`Abort ${i.change?.description ?? i.id}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setAborting(i);
                          }}
                        >
                          Abort
                        </Button>
                      )
                    }
                  />
                ),
              },
            ]}
            rowKey={(i) => i.id}
            onRowClick={(i) => navigate(`/workflows/${i.id}`)}
            rowLabel={(i) => `Open workflow ${i.change?.description ?? i.id}`}
            empty={
              <EmptyState
                title="No workflow instances yet"
                body="Start a governed change above — every stage is tracked, every sign-off recorded."
              />
            }
          />
        </Card>
      </div>
      {aborting && (
        <AbortWorkflowDialog
          id={aborting.id}
          name={aborting.change?.description || "this workflow"}
          onClose={() => setAborting(null)}
          onAborted={() => {
            setAborting(null);
            void queryClient.invalidateQueries({ queryKey: ["workflows"] });
          }}
        />
      )}
    </>
  );
}
