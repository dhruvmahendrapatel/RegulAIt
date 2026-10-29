/**
 * Projects — shared, governed workspaces: budget vs spend at a glance,
 * classifications, and a click through to the detail (costs + membership).
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import type { Project } from "../../api/types";
import { fmtDay, fmtUsd } from "../../api/format";
import { PageHeader } from "../../shell/AppShell";
import { Badge, Card, EmptyState, ErrorState, Meter, SkeletonBlock } from "../../ui/kit";
import r from "../admin/governance/registry.module.css";
import v from "../views.module.css";

type Shown = "active" | "archived";

export default function ProjectsPage() {
  const navigate = useNavigate();
  // G1 (prototype): archived projects stay listed, behind their own chip
  const [shown, setShown] = useState<Shown>("active");
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

  const all = q.data?.projects ?? [];
  const archivedCount = all.filter((p) => p.archivedAt).length;
  const projects = all.filter((p) => (shown === "archived") === Boolean(p.archivedAt));
  return (
    <>
      <PageHeader
        title="Projects"
        sub="Shared, governed workspaces — context every member sees, spend every member shares."
      />
      {all.length > 0 && (
        <div className={r.chips} role="group" aria-label="Show" style={{ marginBottom: "var(--s2)" }}>
          {(
            [
              ["active", "Active", all.length - archivedCount],
              ["archived", "Archived", archivedCount],
            ] as const
          ).map(([value, label, count]) => (
            <button key={value} type="button" className={r.chip} aria-pressed={shown === value} onClick={() => setShown(value)}>
              {label} <span className={r.chipCount}>{count}</span>
            </button>
          ))}
        </div>
      )}
      {all.length > 0 && projects.length === 0 ? (
        <Card>
          <EmptyState
            title={shown === "archived" ? "No archived projects" : "No active projects"}
            body={shown === "archived" ? "An admin can archive a project from its page; it then shows here." : "Every project you belong to is archived."}
          />
        </Card>
      ) : projects.length === 0 ? (
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
                    {p.archivedAt && <Badge>Archived</Badge>}
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
                  {p.archivedAt ? (
                    <div className={v.faint} style={{ marginTop: "var(--s1)" }}>
                      archived {fmtDay(p.archivedAt)} — read-only, budget no longer enforced
                    </div>
                  ) : cap != null ? (
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
