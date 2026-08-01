/**
 * Rules Engine — pillar-1 rule CRUD across all four scopes (user / role /
 * team / fleet) on one server or all: approval rules, data-scope rules, and
 * rate limits. The scope select drives which target select is live, so the
 * posted body always matches the chosen discriminant.
 */
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type {
  ApprovalRule,
  DataScopeRule,
  RateLimitRule,
  RuleBase,
  RuleDeployMode,
  RuleKind,
} from "../../../api/adminTypes";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Button, Card, EmptyState, Field, Input, Select, Table } from "../../../ui/kit";
import {
  optionEls,
  roleOpts,
  serverOpts,
  teamOpts,
  useAction,
  useNameMaps,
  useRoles,
  useServerTools,
  useServers,
  useTeams,
  useUsers,
  userOpts,
  type Opt,
} from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

interface Subject {
  scope: "user" | "role" | "team" | "fleet";
  userId: string;
  roleId: string;
  teamId: string;
  serverScope: "server" | "all";
  serverId: string;
  toolName: string;
}
const emptySubject: Subject = {
  scope: "user",
  userId: "",
  roleId: "",
  teamId: "",
  serverScope: "server",
  serverId: "",
  toolName: "",
};

/** the discriminant-safe body: only the target matching the scope is posted */
function subjectBody(s: Subject): Record<string, unknown> {
  return {
    scope: s.scope,
    ...(s.scope === "user" ? { userId: s.userId } : {}),
    ...(s.scope === "role" ? { roleId: s.roleId } : {}),
    ...(s.scope === "team" ? { teamId: s.teamId } : {}),
    serverScope: s.serverScope,
    ...(s.serverScope === "server" ? { serverId: s.serverId } : {}),
    ...(s.serverScope === "server" && s.toolName ? { toolName: s.toolName } : {}),
  };
}

function SubjectFields(props: {
  s: Subject;
  set: (patch: Partial<Subject>) => void;
  users: Opt[];
  roles: Opt[];
  teams: Opt[];
  servers: Opt[];
}) {
  const { s, set } = props;
  const tools = useServerTools(s.serverScope === "server" && s.serverId ? s.serverId : null);
  return (
    <>
      <Field label="Scope">
        <Select
          value={s.scope}
          onChange={(e) => set({ scope: e.target.value as Subject["scope"] })}
        >
          <option value="user">user</option>
          <option value="role">role</option>
          <option value="team">team</option>
          <option value="fleet">fleet</option>
        </Select>
      </Field>
      {s.scope === "user" && (
        <Field label="User">
          <Select required value={s.userId} onChange={(e) => set({ userId: e.target.value })}>
            {optionEls(props.users, "— select —")}
          </Select>
        </Field>
      )}
      {s.scope === "role" && (
        <Field label="Role">
          <Select required value={s.roleId} onChange={(e) => set({ roleId: e.target.value })}>
            {optionEls(props.roles, "— select —")}
          </Select>
        </Field>
      )}
      {s.scope === "team" && (
        <Field label="Team">
          <Select required value={s.teamId} onChange={(e) => set({ teamId: e.target.value })}>
            {optionEls(props.teams, "— select —")}
          </Select>
        </Field>
      )}
      <Field label="Servers">
        <Select
          value={s.serverScope}
          onChange={(e) => set({ serverScope: e.target.value as Subject["serverScope"] })}
        >
          <option value="server">this server</option>
          <option value="all">all servers</option>
        </Select>
      </Field>
      {s.serverScope === "server" && (
        <>
          <Field label="Server">
            <Select required value={s.serverId} onChange={(e) => set({ serverId: e.target.value, toolName: "" })}>
              {optionEls(props.servers, "— select —")}
            </Select>
          </Field>
          <Field label="Tool">
            <Select value={s.toolName} onChange={(e) => set({ toolName: e.target.value })}>
              {optionEls(
                (tools.data?.tools ?? []).map((t) => ({ v: t.name, l: t.name })),
                "— any tool —",
              )}
            </Select>
          </Field>
        </>
      )}
    </>
  );
}

const DEPLOY_MODES: RuleDeployMode[] = ["hosted", "byoc", "air_gapped"];

/**
 * A4 (ADR-0027) — PATCH /v1/rules/:kind/:ruleId/deploy-mode.
 *
 * Mode scoping only ever NARROWS which restrictions apply; it can never mint
 * an allow. The deploy-mode context is derived server-side from the attributed
 * project's in-flight workflow instances — never client-asserted — so an
 * unattributed call (or one with no in-flight deploy-bound work) never matches
 * a mode-scoped rule. Every change is audited. Rendered inline per row rather
 * than as a paste-the-rule-id form: the rule you are scoping is the row you
 * are looking at.
 */
function DeployModeCell(props: { kind: RuleKind; rule: RuleBase }) {
  const act = useAction();
  const current = props.rule.deployMode ?? "";
  return (
    <span className={v.stackTight}>
      <Select
        aria-label={`Deploy-mode scope for rule ${props.rule.id}`}
        data-testid={`deploy-mode-${props.rule.id}`}
        value={current}
        disabled={act.busy}
        onChange={(e) => {
          const next = e.target.value === "" ? null : (e.target.value as RuleDeployMode);
          void act.run(
            () =>
              api.patch(`/v1/rules/${props.kind}/${props.rule.id}/deploy-mode`, { deployMode: next }),
            next === null
              ? "Scope cleared — this rule applies to every call"
              : `Rule scoped to ${next} deploy targets`,
          );
        }}
      >
        <option value="">— every call —</option>
        {DEPLOY_MODES.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </Select>
      {act.error && (
        <span className={v.errLine} role="alert">
          {act.error}
        </span>
      )}
    </span>
  );
}

export default function RulesEnginePage() {
  const users = useUsers();
  const roles = useRoles();
  const teams = useTeams();
  const servers = useServers();
  const names = useNameMaps();

  const approvals = useQuery({
    queryKey: ["admin", "rules-approvals"],
    queryFn: () => api.get<{ rules: ApprovalRule[] }>("/v1/rules/approvals"),
  });
  const dataScopes = useQuery({
    queryKey: ["admin", "rules-data-scopes"],
    queryFn: () => api.get<{ rules: DataScopeRule[] }>("/v1/rules/data-scopes"),
  });
  const rateLimits = useQuery({
    queryKey: ["admin", "rules-rate-limits"],
    queryFn: () => api.get<{ rules: RateLimitRule[] }>("/v1/rules/rate-limits"),
  });

  const uOpts = userOpts(users.data?.users);
  const rOpts = roleOpts(roles.data?.roles);
  const tOpts = teamOpts(teams.data?.teams);
  const sOpts = serverOpts(servers.data?.servers);

  const targetOf = (r: RuleBase) =>
    r.scope === "fleet"
      ? "fleet"
      : r.scope === "role"
        ? `role: ${names.roleName.get(r.roleId ?? "") ?? r.roleId}`
        : r.scope === "team"
          ? `team: ${names.teamName.get(r.teamId ?? "") ?? r.teamId}`
          : `user: ${names.userName.get(r.userId ?? "") ?? r.userId}`;
  const serverOf = (r: RuleBase) =>
    r.serverScope === "all" ? "all servers" : (names.serverName.get(r.serverId ?? "") ?? r.serverId);

  const baseColumns = <T extends RuleBase>(): Array<{
    key: string;
    header: ReactNode;
    render: (r: T) => ReactNode;
  }> => [
    { key: "target", header: "Target", render: (r) => targetOf(r) },
    { key: "server", header: "Server", render: (r) => serverOf(r) },
    { key: "tool", header: "Tool", render: (r) => r.toolName ?? "— any —" },
  ];
  /** A4 — the mode-scope editor, the same trailing column on all three tables */
  const modeColumn = <T extends RuleBase>(kind: RuleKind) => ({
    key: "deployMode",
    header: "Deploy-mode scope" as ReactNode,
    render: (r: T) => <DeployModeCell kind={kind} rule={r} />,
  });

  return (
    <>
      <PageHeader
        title="Rules engine"
        sub="A rule targets one user, an assigned role, a team, or the whole fleet — on one server or all of them. Every governed call evaluates them in the same fixed precedence the Simulation view visualizes."
      />
      <div className={v.stack}>
        <Card title="Deploy-mode scoping (ADR-0027 A4)">
          <div className={v.faint}>
            Every rule below carries a <strong>deploy-mode scope</strong>, editable inline on its row. A
            mode-scoped restriction applies only to calls whose attributed project has in-flight workflow
            instances landing on a deploy target of that mode. The context is derived server-side — never
            client-asserted — and an unattributed call (or one with no in-flight deploy-bound work) never
            matches a mode-scoped rule. Mode scoping only narrows WHICH restrictions apply; it can never
            mint an allow. Every change here is audited.
          </div>
        </Card>

        <Card title="Approval rules — pause the call for a named approver">
          <RuleForm
            users={uOpts}
            roles={rOpts}
            teams={tOpts}
            servers={sOpts}
            submitLabel="Add approval rule"
            extra={(s, extraState, setExtra) => (
              <Field label="Approver">
                <Select
                  required
                  value={extraState.approverUserId ?? ""}
                  onChange={(e) => setExtra({ approverUserId: e.target.value })}
                >
                  {optionEls(uOpts, "— select —")}
                </Select>
              </Field>
            )}
            onSubmit={(s, extra) =>
              api.post("/v1/rules/approvals", { ...subjectBody(s), approverUserId: extra.approverUserId })
            }
          />
          <Table<ApprovalRule>
            columns={[
              ...baseColumns<ApprovalRule>(),
              {
                key: "approver",
                header: "Approver",
                render: (r) => names.userName.get(r.approverUserId) ?? r.approverUserId,
              },
              { key: "created", header: "Created", render: (r) => ago(r.createdAt) },
              modeColumn<ApprovalRule>("approvals"),
            ]}
            rows={approvals.data?.rules ?? []}
            rowKey={(r) => r.id}
            loading={approvals.isLoading}
            empty={<EmptyState title="No approval rules" />}
          />
        </Card>

        <Card title="Data-scope rules — constrain an argument to allowed values">
          <RuleForm
            users={uOpts}
            roles={rOpts}
            teams={tOpts}
            servers={sOpts}
            submitLabel="Add data-scope rule"
            extra={(s, extraState, setExtra) => (
              <>
                <Field label="Arg path">
                  <Input
                    required
                    value={extraState.argPath ?? ""}
                    onChange={(e) => setExtra({ argPath: e.target.value })}
                    placeholder="e.g. database"
                  />
                </Field>
                <Field label="Allowed values">
                  <Input
                    required
                    value={extraState.allowedValues ?? ""}
                    onChange={(e) => setExtra({ allowedValues: e.target.value })}
                    placeholder="comma,separated"
                  />
                </Field>
              </>
            )}
            onSubmit={(s, extra) =>
              api.post("/v1/rules/data-scopes", {
                ...subjectBody(s),
                argPath: extra.argPath,
                allowedValues: String(extra.allowedValues ?? "").split(","),
              })
            }
          />
          <Table<DataScopeRule>
            columns={[
              ...baseColumns<DataScopeRule>(),
              { key: "argPath", header: "Arg path", render: (r) => <span className={v.mono}>{r.argPath}</span> },
              {
                key: "allowed",
                header: "Allowed values",
                render: (r) => (r.allowedValues ?? []).join(", "),
              },
              { key: "created", header: "Created", render: (r) => ago(r.createdAt) },
              modeColumn<DataScopeRule>("data-scopes"),
            ]}
            rows={dataScopes.data?.rules ?? []}
            rowKey={(r) => r.id}
            loading={dataScopes.isLoading}
            empty={<EmptyState title="No data-scope rules" />}
          />
        </Card>

        <Card title="Rate limits — max calls per window">
          <RuleForm
            users={uOpts}
            roles={rOpts}
            teams={tOpts}
            servers={sOpts}
            submitLabel="Add rate limit"
            extra={(s, extraState, setExtra) => (
              <>
                <Field label="Max calls">
                  <Input
                    required
                    type="number"
                    value={extraState.maxCalls ?? ""}
                    onChange={(e) => setExtra({ maxCalls: e.target.value })}
                  />
                </Field>
                <Field label="Window seconds">
                  <Input
                    required
                    type="number"
                    value={extraState.windowSeconds ?? ""}
                    onChange={(e) => setExtra({ windowSeconds: e.target.value })}
                  />
                </Field>
              </>
            )}
            onSubmit={(s, extra) =>
              api.post("/v1/rules/rate-limits", {
                ...subjectBody(s),
                maxCalls: Number(extra.maxCalls),
                windowSeconds: Number(extra.windowSeconds),
              })
            }
          />
          <Table<RateLimitRule>
            columns={[
              ...baseColumns<RateLimitRule>(),
              { key: "maxCalls", header: "Max calls", align: "right", render: (r) => r.maxCalls },
              { key: "window", header: "Window (s)", align: "right", render: (r) => r.windowSeconds },
              { key: "created", header: "Created", render: (r) => ago(r.createdAt) },
              modeColumn<RateLimitRule>("rate-limits"),
            ]}
            rows={rateLimits.data?.rules ?? []}
            rowKey={(r) => r.id}
            loading={rateLimits.isLoading}
            empty={<EmptyState title="No rate limits" />}
          />
        </Card>
      </div>
    </>
  );
}

function RuleForm(props: {
  users: Opt[];
  roles: Opt[];
  teams: Opt[];
  servers: Opt[];
  submitLabel: string;
  extra: (
    s: Subject,
    extraState: Record<string, string>,
    setExtra: (patch: Record<string, string>) => void,
  ) => ReactNode;
  onSubmit: (s: Subject, extra: Record<string, string>) => Promise<unknown>;
}) {
  const act = useAction();
  const [s, setS] = useState<Subject>(emptySubject);
  const [extra, setExtraState] = useState<Record<string, string>>({});
  const set = (patch: Partial<Subject>) => setS((cur) => ({ ...cur, ...patch }));
  const setExtra = (patch: Record<string, string>) => setExtraState((cur) => ({ ...cur, ...patch }));
  return (
    <form
      className={a.formRow}
      style={{ marginBottom: "var(--s2)" }}
      onSubmit={(e) => {
        e.preventDefault();
        void act.run(() => props.onSubmit(s, extra), "Rule added");
      }}
    >
      <SubjectFields s={s} set={set} users={props.users} roles={props.roles} teams={props.teams} servers={props.servers} />
      {props.extra(s, extra, setExtra)}
      <Button type="submit" size="sm" variant="primary" disabled={act.busy}>
        {props.submitLabel}
      </Button>
      {act.error && (
        <span className={v.errLine} role="alert">
          {act.error}
        </span>
      )}
    </form>
  );
}
