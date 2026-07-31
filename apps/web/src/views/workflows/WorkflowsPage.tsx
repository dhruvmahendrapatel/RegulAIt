/**
 * Workflows — governed change requests. The intake form resolves its route
 * LIVE beside the type select (never a silent match), exactly like the legacy
 * intake; only routable change types are offered.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../api/client";
import type { Project, WorkflowListResponse } from "../../api/types";
import { ago } from "../../api/format";
import { PageHeader } from "../../shell/AppShell";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Select,
  StatusBadge,
  Table,
} from "../../ui/kit";
import { useToast } from "../../ui/toast";
import v from "../views.module.css";

export default function WorkflowsPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const q = useQuery({
    queryKey: ["workflows"],
    queryFn: () => api.get<WorkflowListResponse>("/v1/workflows/instances"),
  });
  const projectsQ = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.get<{ projects: Project[] }>("/v1/projects"),
  });
  const projects = projectsQ.data?.projects ?? [];
  const changeTypes = q.data?.changeTypes ?? [];
  const routes = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const r of q.data?.routes ?? []) out[r.changeType] = r.templates ?? [];
    return out;
  }, [q.data]);

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
    setBusy(true);
    try {
      const r = await api.post<{ id: string }>("/v1/workflows/instances", {
        ...(projectId ? { projectId } : {}),
        change: {
          description: description.trim() || "untitled change",
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
        sub="Governed change requests — intake to sign-off to build, checks, PR and merge."
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
                      {t}
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
            <Field label="Target system">
              <Input
                placeholder="optional"
                style={{ width: 130 }}
                title="The target system this change lands on — an assignment rule can route on it"
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
                disabled={busy || changeTypes.length === 0}
                onClick={() => void start()}
              >
                {busy ? "Starting…" : "Start workflow"}
              </Button>
            </div>
          </div>
          <div className={v.faint} style={{ marginTop: "var(--s0)" }} aria-live="polite">
            {resolved.length > 0
              ? `→ runs the “${resolved.join("” + “")}” workflow${resolved.length > 1 ? "s (merged)" : ""}`
              : " "}
          </div>
          {error && (
            <div className={v.errLine} role="alert" style={{ marginTop: "var(--s0)" }}>
              {error}
            </div>
          )}
        </Card>

        <Card title="Your change requests" flush>
          {q.isError ? (
            <ErrorState message={(q.error as Error).message} onRetry={() => void q.refetch()} />
          ) : (
            <Table
              columns={[
                {
                  key: "change",
                  header: "Change",
                  render: (i) => <span style={{ fontWeight: 550 }}>{i.change?.description ?? ""}</span>,
                  sort: (i) => i.change?.description ?? "",
                },
                {
                  key: "status",
                  header: "Status",
                  render: (i) => <StatusBadge status={i.status} />,
                  sort: (i) => i.status,
                },
                {
                  key: "type",
                  header: "Type",
                  render: (i) => <span className={v.mono}>{i.change?.changeType ?? ""}</span>,
                  sort: (i) => i.change?.changeType ?? "",
                },
                {
                  key: "created",
                  header: "Created",
                  render: (i) => <span className={v.faint}>{ago(i.createdAt)}</span>,
                  sort: (i) => i.createdAt,
                },
              ]}
              rows={q.data?.instances}
              rowKey={(i) => i.id}
              loading={q.isLoading}
              onRowClick={(i) => navigate(`/workflows/${i.id}`)}
              rowLabel={(i) => `Open workflow ${i.change?.description ?? i.id}`}
              empty={
                <EmptyState
                  title="No workflow instances yet"
                  body="Start a governed change above — every stage is tracked, every sign-off recorded."
                />
              }
            />
          )}
        </Card>
      </div>
    </>
  );
}
