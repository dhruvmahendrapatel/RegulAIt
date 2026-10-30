/**
 * Shared chrome for the three project surfaces (spend & members, shared
 * context, version graph): one header, one tab strip, one role resolution —
 * so the pillar-4 context store reads as part of the project, not a bolt-on.
 */
import { lazy, Suspense, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import type { Project, ProjectMember } from "../../api/types";
import { fmtDay } from "../../api/format";
import { useSession } from "../../session/SessionContext";
import { PageHeader } from "../../shell/AppShell";
import { Badge, Button, IdChip, Tabs } from "../../ui/kit";
import v from "../views.module.css";

/** G1 (ADR-0206): the sentence every disabled control on an archived project carries */
export const ARCHIVED_REASON = "This project is archived.";

export type ProjectTab = "overview" | "context" | "graph";

/**
 * G1 (ADR-0206): the gateway leaves archived projects out of GET /v1/projects unless asked, so every picker offers
 * only projects that can take work. The projects list and the project pages ask, under their own key (an
 * invalidation of ["projects"] still reaches it).
 */
export const projectsWithArchivedQuery = {
  queryKey: ["projects", "with-archived"],
  queryFn: () => api.get<{ projects: Project[] }>("/v1/projects?archived=include"),
};

/** project row + the caller's effective role, shared by every project view */
export function useProjectChrome(projectId: string | undefined) {
  const { auth } = useSession();
  const projectsQ = useQuery(projectsWithArchivedQuery);
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

const ArchiveProjectDialog = lazy(() => import("./ProjectArchiveDialogs").then((m) => ({ default: m.ArchiveProjectDialog })));
const UnarchiveProjectDialog = lazy(() => import("./ProjectArchiveDialogs").then((m) => ({ default: m.UnarchiveProjectDialog })));

/** G1 (ADR-0206): Archive (danger, reason recorded) / Unarchive (secondary, step-up) in the project header */
function ArchiveControl(props: { project: Project }) {
  const p = props.project;
  const [open, setOpen] = useState(false);
  const archived = Boolean(p.archivedAt);
  return (
    <>
      {archived ? (
        <Button size="sm" onClick={() => setOpen(true)}>
          Unarchive
        </Button>
      ) : (
        <Button size="sm" variant="danger" onClick={() => setOpen(true)}>
          Archive project
        </Button>
      )}
      {open && (
        <Suspense fallback={null}>
          {archived ? (
            <UnarchiveProjectDialog project={p} onClose={() => setOpen(false)} />
          ) : (
            <ArchiveProjectDialog project={p} onClose={() => setOpen(false)} />
          )}
        </Suspense>
      )}
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
