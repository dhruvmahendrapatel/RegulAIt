/**
 * Rate limits keyed on a model — shown inside the existing Rate limits card on the
 * Rules page, beside the server/tool limits. A limit caps how many calls one subject
 * (user, role, team or the whole fleet) may make to one model in a window. Limits
 * bind only while enforcement is on; turning it on or off, and removing a limit,
 * ask the admin to confirm their identity again.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type { ModelRateLimitRule } from "../../../api/adminTypes";
import { ago } from "../../../api/format";
import { Badge, Button, EmptyState, Field, Input, Select, Table } from "../../../ui/kit";
import { agentOpts, optionEls, RemoveButton, useAction, useAgents, type Opt } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";
import { withStepUp } from "../../../stepup/stepUp";

type Scope = ModelRateLimitRule["scope"];

/** the discriminant-safe create body: only the target matching the scope is posted */
export function modelRateLimitBody(f: {
  scope: Scope;
  userId: string;
  roleId: string;
  teamId: string;
  agentId: string;
  maxCalls: string;
  windowSeconds: string;
}): Record<string, unknown> {
  return {
    scope: f.scope,
    ...(f.scope === "user" ? { userId: f.userId } : {}),
    ...(f.scope === "role" ? { roleId: f.roleId } : {}),
    ...(f.scope === "team" ? { teamId: f.teamId } : {}),
    agentId: f.agentId,
    maxCalls: Number(f.maxCalls),
    windowSeconds: Number(f.windowSeconds),
  };
}

export function ModelRateLimits(props: {
  users: Opt[];
  roles: Opt[];
  teams: Opt[];
  targetName: (r: { scope: Scope; userId: string | null; roleId: string | null; teamId: string | null }) => string;
}) {
  const agents = useAgents();
  const limits = useQuery({
    queryKey: ["admin", "rules-model-rate-limits"],
    queryFn: () =>
      api.get<{ enforcementEnabled: boolean; rules: ModelRateLimitRule[] }>("/v1/rules/model-rate-limits"),
  });
  const toggle = useAction();
  const create = useAction();
  const [f, setF] = useState({
    scope: "user" as Scope,
    userId: "",
    roleId: "",
    teamId: "",
    agentId: "",
    maxCalls: "",
    windowSeconds: "",
  });
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }));
  const enabled = limits.data?.enforcementEnabled ?? false;
  const agentName = new Map((agents.data?.agents ?? []).map((x) => [x.id, x.name]));

  return (
    <section aria-labelledby="model-rate-limits-heading" data-testid="model-rate-limits">
      <h3 id="model-rate-limits-heading">Per-model limits — max calls to one model per window</h3>
      <p className={v.hint}>
        A per-model limit caps how many calls a person makes to one model inside the window. A role, team or fleet
        limit still counts each person separately. A call over the limit is refused and recorded in the audit trail.
      </p>
      <div className={a.formRow}>
        <Badge tone={enabled ? "ok" : "neutral"}>{enabled ? "Enforced" : "Not enforced"}</Badge>
        <span className={v.hint}>
          {enabled
            ? "Per-model limits below are enforced on every model call."
            : "Off by default. Limits can be added now; none is enforced until you turn enforcement on."}
        </span>
        <Button
          variant={enabled ? "default" : "primary"}
          disabled={toggle.busy || limits.isLoading}
          data-testid="model-rate-limits-toggle"
          onClick={() =>
            void toggle.run(
              () =>
                withStepUp((h) =>
                  api.putWithHeaders("/v1/rules/model-rate-limits/enforcement", { enabled: !enabled }, h),
                ).then(() => limits.refetch()),
              enabled ? "Per-model limits turned off" : "Per-model limits turned on",
            )
          }
        >
          {enabled ? "Turn enforcement off" : "Turn enforcement on"}
        </Button>
        {toggle.error && (
          <span className={v.errLine} role="alert">
            {toggle.error}
          </span>
        )}
      </div>
      <form
        className={a.formRow}
        onSubmit={(e) => {
          e.preventDefault();
          void create
            .run(() => api.post("/v1/rules/model-rate-limits", modelRateLimitBody(f)), "Per-model limit added")
            .then((ok) => {
              if (ok) void limits.refetch();
            });
        }}
      >
        <Field label="Scope">
          <Select value={f.scope} onChange={(e) => set({ scope: e.target.value as Scope })}>
            <option value="user">User</option>
            <option value="role">Role</option>
            <option value="team">Team</option>
            <option value="fleet">Fleet</option>
          </Select>
        </Field>
        {f.scope === "user" && (
          <Field label="User" grow>
            <Select required value={f.userId} onChange={(e) => set({ userId: e.target.value })}>
              {optionEls(props.users, "— select a user —")}
            </Select>
          </Field>
        )}
        {f.scope === "role" && (
          <Field label="Role" grow>
            <Select required value={f.roleId} onChange={(e) => set({ roleId: e.target.value })}>
              {optionEls(props.roles, "— select a role —")}
            </Select>
          </Field>
        )}
        {f.scope === "team" && (
          <Field label="Team" grow>
            <Select required value={f.teamId} onChange={(e) => set({ teamId: e.target.value })}>
              {optionEls(props.teams, "— select a team —")}
            </Select>
          </Field>
        )}
        <Field label="Model" grow>
          <Select
            required
            value={f.agentId}
            onChange={(e) => set({ agentId: e.target.value })}
            data-testid="model-rate-limit-agent"
          >
            {optionEls(agentOpts(agents.data?.agents), "— select a model —")}
          </Select>
        </Field>
        <Field label="Max calls (1 to 1,000,000)">
          <Input required type="number" min={1} max={1_000_000} value={f.maxCalls} onChange={(e) => set({ maxCalls: e.target.value })} />
        </Field>
        <Field label="Window seconds (up to 30 days)">
          <Input
            required
            type="number"
            min={1}
            max={2_592_000}
            value={f.windowSeconds}
            onChange={(e) => set({ windowSeconds: e.target.value })}
          />
        </Field>
        <Button type="submit" disabled={create.busy}>
          Add per-model limit
        </Button>
        {create.error && (
          <span className={v.errLine} role="alert">
            {create.error}
          </span>
        )}
      </form>
      <Table<ModelRateLimitRule>
        columns={[
          { key: "target", header: "Target", render: (r) => props.targetName(r) },
          { key: "model", header: "Model", render: (r) => agentName.get(r.agentId) ?? "— removed model —" },
          { key: "maxCalls", header: "Max calls", align: "right", render: (r) => r.maxCalls },
          { key: "window", header: "Window (s)", align: "right", render: (r) => r.windowSeconds },
          { key: "created", header: "Created", render: (r) => ago(r.createdAt) },
          {
            key: "actions",
            header: "",
            srHeader: "Actions",
            align: "right",
            render: (r) => (
              <RemoveButton
                what={`this per-model limit (${r.maxCalls}/${r.windowSeconds}s)`}
                consequence={
                  <p>
                    The limit is deleted and stops being checked on the next call to this model. Calls it already
                    refused stay in the audit trail.
                  </p>
                }
                onRemove={() => withStepUp((h) => api.delWithHeaders(`/v1/rules/model-rate-limits/${r.id}`, h))}
                onDone={() => void limits.refetch()}
              />
            ),
          },
        ]}
        rows={limits.data?.rules ?? []}
        rowKey={(r) => r.id}
        loading={limits.isLoading}
        error={limits.error}
        onRetry={() => void limits.refetch()}
        empty={<EmptyState title="No per-model limits" />}
      />
    </section>
  );
}
