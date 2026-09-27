/**
 * Workspace-level entry point for pillar 4: every Shared Project the caller
 * belongs to, with the shape of its context store at a glance (keys, live
 * conflicts, who arbitrates) and a direct way into the store or its version
 * graph. The store itself is project-scoped, so this page deliberately does
 * not duplicate it — it is the door, not the room.
 */
import { Link, useNavigate } from "react-router-dom";
import { useQueries, useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import type { ContextResponse, Project } from "../../api/types";
import { ago } from "../../api/format";
import { PageHeader } from "../../shell/AppShell";
import { Badge, Button, Card, EmptyState, ErrorState, SkeletonBlock } from "../../ui/kit";
import v from "../views.module.css";

export default function ContextIndexPage() {
  const navigate = useNavigate();
  const projectsQ = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.get<{ projects: Project[] }>("/v1/projects"),
  });
  const projects = projectsQ.data?.projects ?? [];

  const contextQs = useQueries({
    queries: projects.map((p) => ({
      queryKey: ["project-context", p.id],
      queryFn: () => api.get<ContextResponse>(`/v1/projects/${p.id}/context`),
    })),
  });

  return (
    <>
      <PageHeader
        title="Shared context"
        sub="Cross-team context retention, with provenance."
        info={<p>Cross-team context retention: what every member of a Shared Project reads before doing anything, with provenance on every revision and conflicts resolved by a named arbiter instead of by whoever saved last.</p>}
      />
      {projectsQ.isLoading ? (
        <Card>
          <SkeletonBlock lines={5} />
        </Card>
      ) : projectsQ.isError ? (
        <Card>
          <ErrorState
            message={(projectsQ.error as Error).message}
            onRetry={() => void projectsQ.refetch()}
          />
        </Card>
      ) : projects.length === 0 ? (
        <Card>
          <EmptyState
            title="No Shared Projects yet"
            body="A shared context store belongs to a Shared Project. Once you are a member of one, its store appears here."
          />
        </Card>
      ) : (
        <div className={v.stack}>
          {projects.map((p, i) => {
            const q = contextQs[i];
            const data = q?.data;
            const keys = data?.context?.length ?? 0;
            const pending = data?.pending?.length ?? 0;
            const newest = (data?.context ?? [])
              .map((x) => x.provenance?.at ?? null)
              .filter((x): x is string => Boolean(x))
              .sort()
              .pop();
            return (
              <Card key={p.id}>
                <div className={v.row} style={{ alignItems: "flex-start" }}>
                  <div className={v.grow}>
                    <div className={v.rowTight}>
                      <Link to={`/projects/${p.id}/context`} style={{ fontSize: "var(--text-lg)", fontWeight: 650 }}>
                        {p.name}
                      </Link>
                      {(p.classifications ?? []).map((cl) => (
                        <Badge key={cl} tone="info">
                          {cl}
                        </Badge>
                      ))}
                      {pending > 0 && (
                        <Badge tone="warn">
                          {pending} conflict{pending === 1 ? "" : "s"} awaiting the arbiter
                        </Badge>
                      )}
                    </div>
                    <div className={v.dim} style={{ marginTop: "var(--s0)" }}>
                      {q?.isLoading
                        ? "reading the store…"
                        : q?.isError
                          ? "context unavailable for this project"
                          : `${keys} key${keys === 1 ? "" : "s"}` +
                            (newest ? ` · last contribution ${ago(newest)}` : " · nothing contributed yet") +
                            (data?.arbiter ? ` · arbiter ${data.arbiter.name ?? "unnamed"}` : " · no arbiter named")}
                    </div>
                  </div>
                  <Button size="sm" onClick={() => navigate(`/projects/${p.id}/context`)}>
                    Open store
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => navigate(`/projects/${p.id}/context/graph`)}>
                    Version graph
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
