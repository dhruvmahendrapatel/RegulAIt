/**
 * Project detail — pillar 5 for members: budget vs actual with threshold
 * marks, forecast, showback (by member / team / agent / connector / MCP tool),
 * estimated savings, CSV export — plus membership management for owners.
 */
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../api/client";
import type { Project, ProjectCosts, ProjectMember } from "../../api/types";
import { ago, fmtUsd } from "../../api/format";
import { useSession } from "../../session/SessionContext";
import { PageHeader } from "../../shell/AppShell";
import {
  Badge,
  Button,
  Card,
  ConfirmModal,
  EmptyState,
  ErrorState,
  Field,
  Select,
  SkeletonBlock,
  Meter,
  IdChip,
} from "../../ui/kit";
import { useToast } from "../../ui/toast";
import v from "../views.module.css";

interface DirectoryUser {
  id: string;
  name: string;
  teams: Array<{ id: string; name: string }>;
}

export default function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { auth } = useSession();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const me = auth?.userId ?? null;

  const projectsQ = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.get<{ projects: Project[] }>("/v1/projects"),
  });
  const costsQ = useQuery({
    queryKey: ["project-costs", projectId],
    enabled: Boolean(projectId),
    queryFn: () => api.get<ProjectCosts>(`/v1/projects/${projectId}/costs`),
  });
  const membersQ = useQuery({
    queryKey: ["project-members", projectId],
    enabled: Boolean(projectId),
    queryFn: () => api.get<{ members: ProjectMember[] }>(`/v1/projects/${projectId}/members`),
  });
  const directoryQ = useQuery({
    queryKey: ["directory"],
    queryFn: () => api.get<{ users: DirectoryUser[] }>("/v1/users/directory"),
  });

  const project = (projectsQ.data?.projects ?? []).find((p) => p.id === projectId);
  const members = membersQ.data?.members ?? [];
  const directory = directoryQ.data?.users ?? [];
  const myRole: ProjectMember["role"] = auth?.isAdmin
    ? "owner"
    : (members.find((m) => m.userId === me)?.role ?? "viewer");
  const ownerCount = members.filter((m) => m.role === "owner").length;

  const [addUserId, setAddUserId] = useState("");
  const [addRole, setAddRole] = useState<ProjectMember["role"]>("contributor");
  const [addTeamId, setAddTeamId] = useState("");
  const [memberError, setMemberError] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ProjectMember | null>(null);

  const nonMembers = useMemo(
    () => directory.filter((u) => !members.some((m) => m.userId === u.id)),
    [directory, members],
  );
  const addUser = nonMembers.find((u) => u.id === (addUserId || nonMembers[0]?.id));

  const refreshMembers = () =>
    queryClient.invalidateQueries({ queryKey: ["project-members", projectId] });

  const lastOwnerMessage = (e: unknown, fallback: string) =>
    e instanceof ApiError && e.status === 409 && e.payload.error === "last_owner"
      ? "Can't change the sole owner — promote another owner first."
      : e instanceof Error
        ? e.message
        : fallback;

  if (projectsQ.isLoading || costsQ.isLoading) {
    return (
      <>
        <PageHeader title="Project" />
        <Card>
          <SkeletonBlock lines={6} />
        </Card>
      </>
    );
  }
  if (costsQ.isError) {
    const err = costsQ.error as { status?: number; message?: string };
    return (
      <>
        <PageHeader title={project?.name ?? "Project"} />
        <Card>
          <ErrorState
            message={err.message ?? "unknown error"}
            access={err.status === 403}
            onRetry={() => void costsQ.refetch()}
          />
        </Card>
      </>
    );
  }

  const c = costsQ.data ?? {};
  const bg = c.budget ?? {};
  const m = c.measured ?? {};
  const spent = bg.spentUsd ?? 0;
  const cap = bg.budgetUsd ?? null;
  const over = cap != null && spent > cap;
  const crossed =
    !over &&
    (bg.thresholdCrossed ??
      (bg.alertThresholdPct != null &&
        bg.alertThresholdPct < 100 &&
        bg.thresholdUsd != null &&
        spent >= bg.thresholdUsd));
  const userName = (uid: string) => directory.find((u) => u.id === uid)?.name ?? uid.slice(0, 8) + "…";

  return (
    <>
      <div style={{ marginBottom: "var(--s1)" }}>
        <Link to="/projects">← All projects</Link>
      </div>
      <PageHeader
        title={project?.name ?? c.project?.name ?? "Project"}
        sub={
          <span className={v.rowTight}>
            {(project?.classifications ?? []).map((cl) => (
              <Badge key={cl} tone="info">
                {cl}
              </Badge>
            ))}
            <Badge>{myRole}</Badge>
            {c.initiative && <span className={v.faint}>Initiative: {c.initiative.name}</span>}
            <IdChip id={projectId} />
          </span>
        }
        actions={
          <Button
            size="sm"
            onClick={() => {
              window.open(`/v1/projects/${projectId}/costs.csv`, "_blank");
            }}
          >
            Download CSV
          </Button>
        }
      />

      <div className={v.stack}>
        <div className={v.grid2}>
          <Card title="Measured spend">
            <div className={v.stat}>
              <span className={v.statValue}>{fmtUsd(m.costUsd)}</span>
              <span className={v.statLabel}>project measured spend · {m.events ?? 0} calls</span>
            </div>
          </Card>
          <Card title="Forecast">
            <div className={v.stat}>
              <span className={v.statValue}>{fmtUsd(c.forecast?.projectedEomUsd)}</span>
              <span className={v.statLabel}>projected month-end · {c.forecast?.basis ?? "—"}</span>
            </div>
          </Card>
        </div>

        <Card title="Budget vs actual">
          {cap == null ? (
            <EmptyState
              title="No budget set"
              body="Spend is attributed to this project but nothing is enforced until an admin sets a budget."
            />
          ) : (
            <>
              <div className={v.row}>
                <span className={v.num} style={{ fontWeight: 650 }}>
                  {fmtUsd(spent)}
                </span>
                <span className={v.faint}>
                  of {fmtUsd(cap)}
                  {bg.period === "monthly" ? " this month" : ""}
                </span>
                {over && (
                  <Badge tone={bg.overageApproved ? "warn" : "danger"}>
                    {bg.overageApproved ? "overage approved" : "over budget"}
                  </Badge>
                )}
                {crossed && <Badge tone="warn">{bg.alertThresholdPct}% threshold crossed</Badge>}
              </div>
              <div style={{ marginTop: "var(--s1)" }}>
                <Meter
                  value={spent}
                  max={cap}
                  over={over}
                  warn={Boolean(crossed)}
                  {...(bg.alertThresholdPct != null && bg.alertThresholdPct < 100
                    ? { markPct: bg.alertThresholdPct }
                    : {})}
                  label="budget vs actual"
                />
              </div>
              <div className={v.faint} style={{ marginTop: "var(--s1)" }}>
                budget window: {bg.period === "monthly" ? `this calendar month (${bg.periodKey ?? ""})` : "lifetime"}
              </div>
            </>
          )}
        </Card>

        <div className={v.grid2}>
          <Card title="Showback by member">
            <BarList
              items={(c.byUser ?? []).map((x) => ({ label: userName(x.userId), value: x.costUsd }))}
            />
          </Card>
          <Card title="Showback by team">
            <BarList
              items={(c.byTeam ?? []).map((x) => ({ label: x.name ?? "(no team)", value: x.costUsd }))}
            />
          </Card>
          <Card title="By agent / model">
            <BarList
              items={(c.byAgent ?? []).map((x) => ({
                label: x.model ?? x.agentId?.slice(0, 8) ?? "agent",
                value: x.costUsd,
              }))}
            />
          </Card>
          <Card title="Estimated savings by technique">
            <BarList
              items={(c.estimatedSavings ?? []).map((x) => ({
                label: x.technique,
                value: x.estimatedCostSavedUsd,
              }))}
            />
          </Card>
        </div>

        <Card title="Members">
          {membersQ.isLoading ? (
            <SkeletonBlock lines={3} />
          ) : members.length === 0 ? (
            <EmptyState
              title="No members"
              body="This project is an open cost bucket — add members to give it a real membership."
            />
          ) : (
            members.map((mem) => {
              const soleOwner = mem.role === "owner" && ownerCount <= 1;
              return (
                <div key={mem.userId} className={v.listRow} style={{ alignItems: "center" }}>
                  <div className={v.grow}>
                    <div style={{ fontSize: "var(--text-sm)", fontWeight: 550 }}>
                      {mem.userName ?? "unknown"}
                      {mem.userId === me && <span className={v.faint}> (you)</span>}
                    </div>
                    <div className={v.faint}>
                      {mem.teamName ?? "no team"} · joined {ago(mem.createdAt)}
                    </div>
                  </div>
                  {myRole === "owner" ? (
                    <>
                      <Select
                        aria-label={`Role for ${mem.userName ?? mem.userId}`}
                        style={{ width: 130 }}
                        value={mem.role}
                        disabled={soleOwner}
                        title={soleOwner ? "promote another owner before changing the sole owner" : undefined}
                        onChange={(e) => {
                          const role = e.target.value;
                          void (async () => {
                            setMemberError(null);
                            try {
                              await api.patch(`/v1/projects/${projectId}/members/${mem.userId}`, { role });
                              toast("Role updated", "success");
                            } catch (err) {
                              setMemberError(lastOwnerMessage(err, "update failed"));
                            } finally {
                              void refreshMembers();
                            }
                          })();
                        }}
                      >
                        <option value="owner">owner</option>
                        <option value="contributor">contributor</option>
                        <option value="viewer">viewer</option>
                      </Select>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={soleOwner}
                        title={soleOwner ? "promote another owner before removing the sole owner" : undefined}
                        onClick={() => setRemoveTarget(mem)}
                      >
                        Remove
                      </Button>
                    </>
                  ) : (
                    <Badge tone={mem.role === "owner" ? "primary" : mem.role === "contributor" ? "info" : "neutral"}>
                      {mem.role}
                    </Badge>
                  )}
                </div>
              );
            })
          )}
          {memberError && (
            <div className={v.errLine} role="alert" style={{ marginTop: "var(--s1)" }}>
              {memberError}
            </div>
          )}
          {myRole === "owner" &&
            (nonMembers.length === 0 ? (
              <div className={v.faint} style={{ marginTop: "var(--s1)" }}>
                everyone in the directory is already a member
              </div>
            ) : (
              <div className={v.row} style={{ marginTop: "var(--s2)" }}>
                <Field label="User">
                  <Select
                    value={addUserId || nonMembers[0]?.id || ""}
                    onChange={(e) => {
                      setAddUserId(e.target.value);
                      setAddTeamId("");
                    }}
                  >
                    {nonMembers.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Role">
                  <Select value={addRole} onChange={(e) => setAddRole(e.target.value as ProjectMember["role"])}>
                    <option value="viewer">viewer</option>
                    <option value="contributor">contributor</option>
                    <option value="owner">owner</option>
                  </Select>
                </Field>
                <Field label="Team (provenance)">
                  <Select value={addTeamId} onChange={(e) => setAddTeamId(e.target.value)}>
                    <option value="">no team</option>
                    {(addUser?.teams ?? []).map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div style={{ alignSelf: "flex-end" }}>
                  <Button
                    size="sm"
                    onClick={() => {
                      const userId = addUserId || nonMembers[0]?.id;
                      if (!userId) return;
                      void (async () => {
                        setMemberError(null);
                        try {
                          await api.post(`/v1/projects/${projectId}/members`, {
                            userId,
                            role: addRole,
                            ...(addTeamId ? { teamId: addTeamId } : {}),
                          });
                          toast("Member added", "success");
                          setAddUserId("");
                        } catch (err) {
                          setMemberError(err instanceof Error ? err.message : String(err));
                        } finally {
                          void refreshMembers();
                        }
                      })();
                    }}
                  >
                    Add member
                  </Button>
                </div>
              </div>
            ))}
          <div className={v.faint} style={{ marginTop: "var(--s2)" }}>
            Shared context editing and the context version graph stay in the{" "}
            <a href="/app#/projects">classic app</a> for now — they migrate into this shell in
            phase 2.
          </div>
        </Card>
      </div>

      <ConfirmModal
        open={Boolean(removeTarget)}
        title="Remove member?"
        body={
          removeTarget
            ? `${removeTarget.userName ?? "This member"} loses access to the project's context and spend.`
            : undefined
        }
        confirmLabel="Remove"
        danger
        onCancel={() => setRemoveTarget(null)}
        onConfirm={() => {
          const target = removeTarget;
          setRemoveTarget(null);
          if (!target) return;
          void (async () => {
            setMemberError(null);
            try {
              await api.del(`/v1/projects/${projectId}/members/${target.userId}`);
              toast("Member removed", "success");
            } catch (err) {
              setMemberError(lastOwnerMessage(err, "remove failed"));
            } finally {
              void refreshMembers();
            }
          })();
        }}
      />
    </>
  );
}

/** tiny horizontal bar list — tokens only, no chart library */
function BarList(props: { items: Array<{ label: string; value: number }> }) {
  const items = props.items.filter((i) => Number.isFinite(i.value)).slice(0, 10);
  if (!items.length) {
    return <EmptyState title="No data yet" body="Metered activity appears here as it happens." />;
  }
  const max = Math.max(...items.map((i) => i.value), 1e-9);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s1)" }}>
      {items.map((i, idx) => (
        <div key={idx} className={v.row} style={{ gap: "var(--s1)" }}>
          <span
            className={v.faint}
            style={{ width: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            title={i.label}
          >
            {i.label}
          </span>
          <div style={{ flex: 1, minWidth: 40 }}>
            <div
              style={{
                height: 10,
                width: `${Math.max(2, (i.value / max) * 100)}%`,
                background: "var(--primary)",
                opacity: 0.85,
                borderRadius: 3,
              }}
            />
          </div>
          <span className={`${v.mono} ${v.num}`}>{fmtUsd(i.value)}</span>
        </div>
      ))}
    </div>
  );
}
