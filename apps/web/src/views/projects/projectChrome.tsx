/**
 * Shared chrome for the three project surfaces (spend & members, shared
 * context, version graph): one header, one tab strip, one role resolution —
 * so the pillar-4 context store reads as part of the project, not a bolt-on.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../api/client";
import type { Project, ProjectMember } from "../../api/types";
import { fmtDay, plural } from "../../api/format";
import { useSession } from "../../session/SessionContext";
import { PageHeader } from "../../shell/AppShell";
import { withStepUp } from "../../stepup/stepUp";
import { Badge, Button, ConfirmModal, IdChip, Tabs } from "../../ui/kit";
import { useToast } from "../../ui/toast";
import { ReasonModal } from "../admin/adminKit";
import a from "../admin/admin.module.css";
import v from "../views.module.css";

/** G1 (prototype): the sentence every disabled control on an archived project carries */
export const ARCHIVED_REASON = "This project is archived.";

export type ProjectTab = "overview" | "context" | "graph";

/** project row + the caller's effective role, shared by every project view */
export function useProjectChrome(projectId: string | undefined) {
  const { auth } = useSession();
  const projectsQ = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.get<{ projects: Project[] }>("/v1/projects"),
  });
  const membersQ = useQuery({
    queryKey: ["project-members", projectId],
    enabled: Boolean(projectId),
    queryFn: () => api.get<{ members: ProjectMember[] }>(`/v1/projects/${projectId}/members`),
  });
  const members = membersQ.data?.members ?? [];
  const project = (projectsQ.data?.projects ?? []).find((p) => p.id === projectId);
  const archived = Boolean(project?.archivedAt);
  const myRole: ProjectMember["role"] = auth?.isAdmin
    ? "owner"
    : (members.find((m) => m.userId === auth?.userId)?.role ?? "viewer");
  return {
    projectsQ,
    membersQ,
    members,
    project,
    myRole,
    /** G1: an archived project is read-only — no new context, no membership changes */
    archived,
    /** §9.2: a context revision needs contributor rights (admins bypass) */
    canWrite: !archived && (myRole === "owner" || myRole === "contributor"),
    isAdmin: Boolean(auth?.isAdmin),
    me: auth?.userId ?? null,
  };
}

export function ProjectChrome(props: {
  projectId: string | undefined;
  project: Project | undefined;
  fallbackName?: string | undefined;
  myRole: ProjectMember["role"];
  tab: ProjectTab;
  sub?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const navigate = useNavigate();
  const { auth } = useSession();
  const id = props.projectId;
  const archivedAt = props.project?.archivedAt;
  return (
    <>
      <div style={{ marginBottom: "var(--s1)" }}>
        <Link to="/projects">← All projects</Link>
      </div>
      <PageHeader
        title={props.project?.name ?? props.fallbackName ?? "Project"}
        sub={
          <span className={v.rowTight}>
            {archivedAt && (
              <Badge
                info={
                  <>
                    Archived on {fmtDay(archivedAt)}
                    {props.project?.archivedByName ? ` by ${props.project.archivedByName}` : ""}.
                    <br />
                    Reason: “{props.project?.archivedReason ?? "no reason recorded"}”
                    <br />
                    Spend, approvals and audit history stay visible; nothing new can be attributed to it.
                  </>
                }
                infoLabel="Why this project is archived"
              >
                Archived
              </Badge>
            )}
            {(props.project?.classifications ?? []).map((cl) => (
              <Badge key={cl} tone="info">
                {cl}
              </Badge>
            ))}
            <Badge>{props.myRole}</Badge>
            {props.sub}
            <IdChip id={id} />
          </span>
        }
        actions={
          props.actions || (auth?.isAdmin && props.project) ? (
            <span className={v.rowTight}>
              {props.actions}
              {auth?.isAdmin && props.project && <ArchiveControl project={props.project} />}
            </span>
          ) : undefined
        }
      />
      <div style={{ marginBottom: "var(--s2)" }}>
        <Tabs
          active={props.tab}
          onChange={(next) => {
            if (next === props.tab || !id) return;
            navigate(
              next === "overview"
                ? `/projects/${id}`
                : next === "context"
                  ? `/projects/${id}/context`
                  : `/projects/${id}/context/graph`,
            );
          }}
          tabs={[
            { id: "overview", label: "Spend & members" },
            { id: "context", label: "Shared context" },
            { id: "graph", label: "Version graph" },
          ]}
        />
      </div>
    </>
  );
}

interface ArchiveRefusal {
  code: string;
  message: string;
  ids: string[];
}

/** a 409 from archive, in words the admin can act on (the ids say what to go and close) */
function archiveRefusal(e: unknown): ArchiveRefusal | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const code = String(e.payload.error ?? "");
  if (code === "project_has_open_approvals") {
    const rows = (e.payload.approvals as Array<{ id: string }> | undefined) ?? [];
    return {
      code,
      message: `This project still has ${plural(rows.length, "open approval")}. Decide or withdraw ${rows.length === 1 ? "it" : "them"} first.`,
      ids: rows.map((r) => r.id),
    };
  }
  if (code === "project_has_running_work") {
    const rows = (e.payload.runs as Array<{ id: string }> | undefined) ?? [];
    return {
      code,
      message: `${plural(rows.length, "workflow")} ${rows.length === 1 ? "is" : "are"} still running. Wait for ${rows.length === 1 ? "it" : "them"} to finish or cancel ${rows.length === 1 ? "it" : "them"} first.`,
      ids: rows.map((r) => r.id),
    };
  }
  return null;
}

/** G1 (prototype): Archive (danger, reason recorded) / Unarchive (secondary, step-up) in the project header */
function ArchiveControl(props: { project: Project }) {
  const p = props.project;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [unarchiveOpen, setUnarchiveOpen] = useState(false);
  const [refusal, setRefusal] = useState<ArchiveRefusal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["projects"] });

  if (p.archivedAt) {
    return (
      <>
        <Button size="sm" onClick={() => setUnarchiveOpen(true)}>
          Unarchive
        </Button>
        <ConfirmModal
          open={unarchiveOpen}
          title={`Unarchive project “${p.name}”?`}
          body="Spend can be attributed to it again and its budget is enforced again. You will be asked to confirm it's you."
          confirmLabel="Unarchive project"
          onCancel={() => setUnarchiveOpen(false)}
          onConfirm={() => {
            setUnarchiveOpen(false);
            void (async () => {
              try {
                await withStepUp((h) => api.postWithHeaders(`/v1/projects/${p.id}/unarchive`, {}, h));
                toast("Project unarchived", "success");
              } catch (e) {
                toast(e instanceof Error ? e.message : String(e), "error");
              } finally {
                void refresh();
              }
            })();
          }}
        />
      </>
    );
  }
  return (
    <>
      <Button size="sm" variant="danger" onClick={() => setArchiveOpen(true)}>
        Archive project
      </Button>
      <ReasonModal
        open={archiveOpen}
        title={`Archive project “${p.name}”?`}
        danger
        minLength={10}
        confirmLabel="Archive project"
        body={
          <>
            <span className={v.dim}>
              New spend can no longer be attributed to it, its budget stops being enforced and members can no longer
              add context. Spend, approvals and audit history are kept and stay visible. Engine keys pinned to it stop
              working. The reason is recorded in the audit log.
            </span>
            {refusal && (
              <div className={`${a.outcome} ${a.outcomeDeny}`} role="alert" data-testid="archive-refusal" data-refusal={refusal.code}>
                <strong>{refusal.message}</strong>
                <ul style={{ margin: 0, paddingLeft: "1.2em" }}>
                  {refusal.ids.map((id) => (
                    <li key={id}>
                      <span className={v.mono}>{id}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {error && (
              <div className={v.errLine} role="alert">
                {error}
              </div>
            )}
          </>
        }
        onCancel={() => {
          setArchiveOpen(false);
          setRefusal(null);
          setError(null);
        }}
        onConfirm={(reason) => {
          setRefusal(null);
          setError(null);
          void (async () => {
            try {
              await api.post(`/v1/projects/${p.id}/archive`, { reason });
              setArchiveOpen(false);
              toast("Project archived", "success");
              void refresh();
            } catch (e) {
              const r = archiveRefusal(e);
              if (r) setRefusal(r);
              else setError(e instanceof Error ? e.message : String(e));
            }
          })();
        }}
      />
    </>
  );
}

/** the line an archived project shows where its controls would be */
export function ArchivedNote() {
  return (
    <div className={v.faint} style={{ marginTop: "var(--s1)" }}>
      {ARCHIVED_REASON} Members and context can no longer be changed.
    </div>
  );
}
