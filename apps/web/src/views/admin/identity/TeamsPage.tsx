/**
 * Teams — flat membership groups (per-user project roles live on Shared
 * Projects, not here). Default classifications come from the compliance
 * profiles. Deleting a team that is the recorded contributor of shared
 * context answers 409 with what blocks; force-delete requires a recorded
 * reason and provenance survives.
 */
import { useState } from "react";
import { api, ApiError } from "../../../api/client";
import type { Team } from "../../../api/adminTypes";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, ConfirmModal, EmptyState, Field, Input, Select } from "../../../ui/kit";
import {
  ReasonModal,
  optionEls,
  teamOpts,
  useAction,
  useComplianceProfiles,
  useTeams,
  useUsers,
  userOpts,
} from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

async function deleteWithBody(path: string, body: unknown): Promise<void> {
  const res = await fetch(path, {
    method: "DELETE",
    credentials: "include",
    headers: { "x-regulait-csrf": "1", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      payload = { raw: text };
    }
    throw new ApiError(res.status, payload);
  }
}

export default function TeamsPage() {
  const teams = useTeams();
  const users = useUsers();
  const profiles = useComplianceProfiles();
  const act = useAction();

  const [name, setName] = useState("");
  const [classifications, setClassifications] = useState<string[]>([]);
  const [memberTeam, setMemberTeam] = useState("");
  const [memberUser, setMemberUser] = useState("");
  const [removeMember, setRemoveMember] = useState<{ team: Team; userId: string; name: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Team | null>(null);
  const [forceDelete, setForceDelete] = useState<{
    team: Team;
    contextItems: number;
    projects: string[];
  } | null>(null);

  const tagList = (profiles.data?.profiles ?? []).map((p) => p.tag);

  const deleteTeam = async (team: Team) => {
    try {
      await api.del(`/v1/teams/${team.id}`);
      await act.run(async () => {}, "Team deleted");
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.payload.error === "team_owns_shared_context") {
        setForceDelete({
          team,
          contextItems: Number(e.payload.contextItems ?? 0),
          projects: (e.payload.projects as string[]) ?? [],
        });
      } else {
        void act.run(() => Promise.reject(e), null);
      }
    }
  };

  return (
    <>
      <PageHeader
        title="Teams"
        sub="Flat membership; per-user roles live on Shared-Project membership."
        info={<p>Flat membership — per-user roles (owner/contributor/viewer) live on Shared-Project membership. Default classifications are surfaced (never silently resolved) when a member joins a project whose tags don't cover them.</p>}
      />
      <div className={v.stack}>
        <Card title="Create a team">
          <form
            className={a.formRow}
            onSubmit={(e) => {
              e.preventDefault();
              void act
                .run(
                  () =>
                    api.post("/v1/teams", {
                      name,
                      ...(classifications.length ? { defaultClassifications: classifications } : {}),
                    }),
                  "Team created",
                )
                .then((ok) => {
                  if (ok) {
                    setName("");
                    setClassifications([]);
                  }
                });
            }}
          >
            <Field label="Team name">
              <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. platform" />
            </Field>
            <Field label="Default classifications (ctrl/cmd-click for several)">
              <Select
                multiple
                size={Math.min(4, Math.max(2, tagList.length || 2))}
                value={classifications}
                onChange={(e) =>
                  setClassifications(Array.from(e.target.selectedOptions).map((o) => o.value))
                }
              >
                {tagList.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            </Field>
            <Button type="submit" variant="primary" disabled={act.busy}>
              Create team
            </Button>
          </form>
          <hr className={v.divider} />
          <form
            className={a.formRow}
            onSubmit={(e) => {
              e.preventDefault();
              void act.run(
                () => api.post(`/v1/teams/${memberTeam}/members`, { userId: memberUser }),
                "Member added",
              );
            }}
          >
            <Field label="Team">
              <Select required value={memberTeam} onChange={(e) => setMemberTeam(e.target.value)}>
                {optionEls(teamOpts(teams.data?.teams), "— select a team —")}
              </Select>
            </Field>
            <Field label="User">
              <Select required value={memberUser} onChange={(e) => setMemberUser(e.target.value)}>
                {optionEls(userOpts(users.data?.users), "— select a user —")}
              </Select>
            </Field>
            <Button type="submit" disabled={act.busy}>
              Add member
            </Button>
          </form>
          {act.error && (
            <div className={v.errLine} role="alert">
              {act.error}
            </div>
          )}
        </Card>

        <Card title="Teams & members">
          {(teams.data?.teams ?? []).length === 0 && !teams.isLoading ? (
            <EmptyState title="No teams yet" body="Create the first team above." />
          ) : (
            (teams.data?.teams ?? []).map((team) => (
              <div key={team.id} className={v.listRow}>
                <div className={v.grow}>
                  <div className={v.row}>
                    <strong>{team.name}</strong>
                    {(team.defaultClassifications ?? []).map((c) => (
                      <Badge key={c} tone="info">
                        {c}
                      </Badge>
                    ))}
                  </div>
                  <div className={v.rowTight} style={{ marginTop: "var(--s0)" }}>
                    {(team.members ?? []).length === 0 && (
                      <span className={v.faint}>no members</span>
                    )}
                    {(team.members ?? []).map((m) => (
                      <span key={m.userId} className={a.pill}>
                        {m.name}
                        <button
                          className={a.pillX}
                          title={`Remove ${m.name} from ${team.name}`}
                          aria-label={`Remove ${m.name} from ${team.name}`}
                          onClick={() => setRemoveMember({ team, userId: m.userId, name: m.name })}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
                <Button size="sm" variant="danger" onClick={() => setConfirmDelete(team)}>
                  delete team
                </Button>
              </div>
            ))
          )}
          <div className={v.faint} style={{ marginTop: "var(--s2)" }}>
            Deleting a team that is the recorded contributor of shared context is refused with what blocks;
            provenance history survives even a forced deletion.
          </div>
        </Card>
      </div>

      <ConfirmModal
        open={removeMember !== null}
        title={`Remove ${removeMember?.name} from ${removeMember?.team.name}?`}
        danger
        confirmLabel="Remove member"
        onCancel={() => setRemoveMember(null)}
        onConfirm={() => {
          const r = removeMember;
          setRemoveMember(null);
          if (r)
            void act.run(
              () => api.del(`/v1/teams/${r.team.id}/members/${r.userId}`),
              "Member removed from the team",
            );
        }}
      />
      <ConfirmModal
        open={confirmDelete !== null}
        title={`Delete team “${confirmDelete?.name}”?`}
        body="If the team is the recorded contributor of shared context, deletion is refused and you can force-delete with a recorded reason."
        danger
        confirmLabel="Delete team"
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          const t = confirmDelete;
          setConfirmDelete(null);
          if (t) void deleteTeam(t);
        }}
      />
      <ReasonModal
        open={forceDelete !== null}
        title={`Team “${forceDelete?.team.name}” owns shared context`}
        body={
          <span className={v.dim}>
            {forceDelete?.contextItems} context revision(s) in{" "}
            {forceDelete?.projects.join(", ") || "shared projects"} name this team as contributor.
            Provenance survives deletion, but confirm deliberately.
          </span>
        }
        confirmLabel="Force delete"
        danger
        onCancel={() => setForceDelete(null)}
        onConfirm={(reason) => {
          const t = forceDelete?.team;
          setForceDelete(null);
          if (t)
            void act.run(
              () => deleteWithBody(`/v1/teams/${t.id}`, { force: true, reason }),
              "Team force-deleted — reason audited; context provenance retained",
            );
        }}
      />
    </>
  );
}
