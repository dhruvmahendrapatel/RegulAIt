/**
 * Projects — shared, governed workspaces: budget vs spend at a glance,
 * classifications, and a click through to the detail (costs + membership).
 */
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import type { Project } from "../../api/types";
import { fmtUsd } from "../../api/format";
import { PageHeader } from "../../shell/AppShell";
import { Badge, Card, EmptyState, ErrorState, Meter, SkeletonBlock } from "../../ui/kit";
import v from "../views.module.css";

export default function ProjectsPage() {
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.get<{ projects: Project[] }>("/v1/projects"),
  });

  if (q.isLoading) {
    return (
      <>
        <PageHeader title="Projects" />
        <Card>
          <SkeletonBlock lines={4} />
        </Card>
      </>
    );
  }
  if (q.isError) {
    return (
      <>
        <PageHeader title="Projects" />
        <Card>
          <ErrorState message={(q.error as Error).message} onRetry={() => void q.refetch()} />
        </Card>
      </>
    );
  }

  const projects = q.data?.projects ?? [];
  return (
    <>
      <PageHeader
        title="Projects"
        sub="Shared, governed workspaces — context every member sees, spend every member shares."
      />
      {projects.length === 0 ? (
        <Card>
          <EmptyState
            title="You are not a member of any project yet"
            body="Projects carry budgets, cost attribution and shared context. An admin (or a project owner) can add you."
          />
        </Card>
      ) : (
        <div className={v.grid2}>
          {projects.map((p) => {
            const spent = p.spentUsd ?? 0;
            const cap = p.budgetUsd;
            return (
              <Card key={p.id}>
                <button
                  style={{ all: "unset", cursor: "pointer", display: "block", width: "100%" }}
                  onClick={() => navigate(`/projects/${p.id}`)}
                  aria-label={`Open project ${p.name}`}
                >
                  <div className={v.row}>
                    <span style={{ fontWeight: 650, fontSize: "var(--text-md)" }}>{p.name}</span>
                    {(p.classifications ?? []).map((c) => (
                      <Badge key={c} tone="info">
                        {c}
                      </Badge>
                    ))}
                    <span className={v.grow} />
                    <span className={`${v.num} ${v.dim}`}>
                      {fmtUsd(spent)}
                      {cap != null ? ` / ${fmtUsd(cap)}` : ""}
                    </span>
                  </div>
                  {cap != null ? (
                    <div style={{ marginTop: "var(--s1)" }}>
                      <Meter value={spent} max={cap} over={spent > cap} label={`${p.name} budget`} />
                    </div>
                  ) : (
                    <div className={v.faint} style={{ marginTop: "var(--s1)" }}>
                      no budget set — spend is attributed but unenforced
                    </div>
                  )}
                </button>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
