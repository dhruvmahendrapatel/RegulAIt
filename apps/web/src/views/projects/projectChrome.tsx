/**
 * Shared chrome for the three project surfaces (spend & members, shared
 * context, version graph): one header, one tab strip, one role resolution —
 * so the pillar-4 context store reads as part of the project, not a bolt-on.
 */
import { useNavigate } from "react-router-dom";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import type { Project, ProjectMember } from "../../api/types";
import { useSession } from "../../session/SessionContext";
import { PageHeader } from "../../shell/AppShell";
import { Badge, IdChip, Tabs } from "../../ui/kit";
import v from "../views.module.css";

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
  const myRole: ProjectMember["role"] = auth?.isAdmin
    ? "owner"
    : (members.find((m) => m.userId === auth?.userId)?.role ?? "viewer");
  return {
    projectsQ,
    membersQ,
    members,
    project: (projectsQ.data?.projects ?? []).find((p) => p.id === projectId),
    myRole,
    /** §9.2: a context revision needs contributor rights (admins bypass) */
    canWrite: myRole === "owner" || myRole === "contributor",
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
  const id = props.projectId;
  return (
    <>
      <div style={{ marginBottom: "var(--s1)" }}>
        <Link to="/projects">← All projects</Link>
      </div>
      <PageHeader
        title={props.project?.name ?? props.fallbackName ?? "Project"}
        sub={
          <span className={v.rowTight}>
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
        actions={props.actions}
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
