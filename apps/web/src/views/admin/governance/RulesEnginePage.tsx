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
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table } from "../../../ui/kit";
import {
  optionEls,
  roleOpts,
  serverOpts,
  teamOpts,
  useAction,
  RemoveButton,
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
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";

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
  // ADR-0074: `deployMode` is a VERSIONED field. On a rule somebody has
  // versioned, this PATCH mints and activates a new version rather than writing
  // the row — before ADR-0074 it wrote the row and the change was silently
  // discarded at dispatch. The operator is told which of the two happened,
  // because "your edit is live" and "your edit is live AS VERSION 4, and is
  // rollback-able" are different facts and only one of them used to be true.
  const [minted, setMinted] = useState<number | null>(null);
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
          setMinted(null);
          void act.run(
            async () => {
              const r = await withStepUp((h) =>
                stepUpApi.patch<{ versionMinted: number | null }>(
                  `/v1/rules/${props.kind}/${props.rule.id}/deploy-mode`,
                  { deployMode: next },
                  h,
                ),
              );
              setMinted(r.versionMinted ?? null);
            },
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
      {minted != null && (
        <span className={v.faint} data-testid={`deploy-mode-version-${props.rule.id}`}>
          This rule is versioned — the change was minted and activated as <strong>v{minted}</strong>, and
          can be rolled back.
        </span>
      )}
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

  // Every rule table reads one of three queries; a removal from any of them
  // should leave all three honest, since a rule can be retargeted between kinds.
  const refetchAll = async () => {
    await Promise.all([approvals.refetch(), dataScopes.refetch(), rateLimits.refetch()]);
  };

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

  /**
   * Rules could be created here and never deleted — `DELETE /v1/rules/:kind/:id`
   * was served the whole time and no screen called it. For a rules engine that
   * is worse than for most objects: a rule you cannot delete is one you have to
   * work AROUND, and the usual way to work around a rule is another rule.
   * Precedence then decides an outcome nobody chose.
   */
  const removeColumn = <T extends RuleBase>(kind: RuleKind, describe: (r: T) => string) => ({
    key: "actions",
    header: "" as ReactNode,
    align: "right" as const,
    render: (r: T) => (
      <RemoveButton
        what={describe(r)}
        consequence={
          <p>
            The rule is deleted and stops being evaluated on the next governed call. Decisions it
            already made stay in the audit trail with this rule id on them — removing a rule never
            rewrites what it did. If another rule also matches these calls, that one now decides:
            check the Simulation view before and after if the outcome matters.
          </p>
        }
        onRemove={() => api.del(`/v1/rules/${kind}/${r.id}`)}
        onDone={() => void refetchAll()}
      />
    ),
  });

  return (
    <>
      <PageHeader
        title="Rules engine"
        sub="Rules targeting a user, a role, a team, or the whole fleet."
        info={<p>A rule targets one user, an assigned role, a team, or the whole fleet — on one server or all of them. Every governed call evaluates them in the same fixed precedence the Simulation view visualizes.</p>}
      />
      <div className={v.stack}>
        <ShadowCanaryCard />

        <Card title="Deploy-mode scoping (ADR-0027 A4)">
          <div className={v.faint}>
            Every rule below carries a <strong>deploy-mode scope</strong>, editable inline on its row. A
            mode-scoped restriction applies only to calls whose attributed project has in-flight workflow
            instances landing on a deploy target of that mode. The context is derived server-side — never
            client-asserted — and an unattributed call (or one with no in-flight deploy-bound work) never
            matches a mode-scoped rule. Mode scoping only narrows WHICH restrictions apply; it can never
            mint an allow. Every change here is audited.
          </div>
          <div className={v.faint} style={{ marginTop: "var(--s1)" }} data-testid="deploy-mode-versioning-note">
            <strong>ADR-0074:</strong> deploy-mode is an <em>enforcing</em> field. If a rule has been
            versioned, changing it here <strong>mints a new version and activates it</strong> — writing the
            row alone would have shown you the new scope while dispatch went on serving the old one. If the
            rule has no versions, nothing is minted and the write behaves exactly as it always did. If the
            rule has versions but none is active, the edit is <strong>refused</strong> with a 409 naming the
            activate endpoint, rather than guessing which version your change applies to.
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
              removeColumn<ApprovalRule>("approvals", (r) => `this approval rule`),
            ]}
            rows={approvals.data?.rules ?? []}
            rowKey={(r) => r.id}
            loading={approvals.isLoading}
            error={approvals.error}
            onRetry={() => void approvals.refetch()}
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
              removeColumn<DataScopeRule>("data-scopes", (r) => `the data-scope rule on ${r.argPath}`),
            ]}
            rows={dataScopes.data?.rules ?? []}
            rowKey={(r) => r.id}
            loading={dataScopes.isLoading}
            error={dataScopes.error}
            onRetry={() => void dataScopes.refetch()}
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
              removeColumn<RateLimitRule>("rate-limits", (r) => `this rate limit (${r.maxCalls}/${r.windowSeconds}s)`),
            ]}
            rows={rateLimits.data?.rules ?? []}
            rowKey={(r) => r.id}
            loading={rateLimits.isLoading}
            error={rateLimits.error}
            onRetry={() => void rateLimits.refetch()}
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
        if (act.busy) return;
        void act.run(() => props.onSubmit(s, extra), "Rule added");
      }}
    >
      <SubjectFields s={s} set={set} users={props.users} roles={props.roles} teams={props.teams} servers={props.servers} />
      {props.extra(s, extra, setExtra)}
      <Button type="submit" size="sm" variant="primary" aria-disabled={act.busy}>
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


// ---------------------------------------------------------------------------
// ADR-0073 — WHAT WOULD CHANGE IF I PROMOTED THIS.
//
// A rule canary never serves: the ACTIVE version alone enforces, and the
// candidate is evaluated in parallel purely to record what it WOULD have
// decided. That measurement is worthless if the operator deciding whether to
// promote cannot see it, which is what this card is for. Every number here is
// read from stored observations, never recomputed in the browser.
// ---------------------------------------------------------------------------

interface CanaryRow {
  artifactType: string;
  artifactId: string;
  version: number;
  label: string | null;
  canaryPct: number | null;
  canaryMode: "live" | "shadow" | "inert";
  observed: number;
  diverged: number;
  failed: number;
  /** ADR-0074 — observations measured against a baseline that has since moved.
   * Reported beside the totals, never folded into them. */
  staleBaselineObservations: number;
  baselineMoved: boolean;
  /** ADR-0074 — the artifact this canary points at no longer exists */
  artifactDeleted: boolean;
}

interface ObservationRow {
  id: string;
  at: string;
  userId: string | null;
  toolName: string | null;
  bucket: number | null;
  servedEffect: string | null;
  servedRuleId: string | null;
  servedReason: string | null;
  candidateEffect: string | null;
  candidateReason: string | null;
  diverged: boolean;
  failed: boolean;
  failureReason: string | null;
}

interface ProjectImpactRow {
  projectId: string;
  projectName: string;
  diverged: boolean;
  changed: string[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

interface Divergence {
  canaryMode: "live" | "shadow" | "inert";
  activeVersion: number | null;
  candidateVersion: number | null;
  canaryPct: number | null;
  totals: { observed: number; diverged: number; failed: number };
  staleBaseline: {
    observed: number;
    unattributed: number;
    buckets: Array<{ activeVersion: number | null; observed: number; diverged: number }>;
    note: string | null;
  };
  artifactDeleted: boolean;
  candidateInheritedFields: string[];
  observations: ObservationRow[];
  projectImpact: ProjectImpactRow[] | null;
  projectImpactNote: string | null;
  note: string;
}

const effectTone = (e: string | null | undefined) =>
  e === "allow" ? "ok" : e === "deny" ? "danger" : e === "require_approval" ? "warn" : "neutral";

function ShadowCanaryCard() {
  const [selected, setSelected] = useState<CanaryRow | null>(null);
  const names = useNameMaps();

  const canaries = useQuery({
    queryKey: ["admin", "config-canaries"],
    queryFn: () =>
      api.get<{ canaries: CanaryRow[]; note: string }>("/v1/config-versions/canaries"),
  });

  const divergence = useQuery({
    queryKey: ["admin", "config-divergence", selected?.artifactType, selected?.artifactId],
    enabled: !!selected,
    queryFn: () =>
      api.get<Divergence>(
        `/v1/config-versions/${selected!.artifactType}/${selected!.artifactId}/divergence`,
      ),
  });

  const rows = canaries.data?.canaries ?? [];

  return (
    <Card title="Rule versions — shadow canaries (ADR-0073)">
      <div className={v.faint}>
        A rule version canary <strong>never enforces</strong>. The <strong>active</strong> version alone
        decides, and the candidate is evaluated in parallel on a deterministic sample of decisions purely
        to record what it <em>would</em> have decided — because a partially-enforced deny would
        non-deterministically block real work. <code>canary %</code> is the shadow{" "}
        <strong>sampling rate</strong>, not a share of enforcement, so every count below is a count within
        the sample and never a fleet-wide total. A non-zero <strong>failed</strong> means the candidate's
        evaluation threw on that decision: the served answer was unaffected and that comparison did not
        happen, so <strong>diverged</strong> is not complete while failures exist.
      </div>
      <Table<CanaryRow>
        columns={[
          { key: "type", header: "Artifact", render: (r) => <span className={v.mono}>{r.artifactType}</span> },
          {
            key: "id",
            header: "Id",
            render: (r) => <span className={v.mono}>{r.artifactId.slice(0, 8)}…</span>,
          },
          { key: "version", header: "Candidate", render: (r) => `v${r.version}${r.label ? ` — ${r.label}` : ""}` },
          { key: "pct", header: "Sampling %", align: "right", render: (r) => r.canaryPct ?? "—" },
          {
            key: "mode",
            header: "Mode",
            render: (r) => (
              <Badge
                tone={r.canaryMode === "inert" ? "danger" : r.canaryMode === "shadow" ? "warn" : "ok"}
                title={
                  r.canaryMode === "inert"
                    ? "nothing resolves this artifact type — the canary changes nothing and measures nothing"
                    : r.canaryMode === "shadow"
                      ? "evaluated in parallel, never enforcing"
                      : "served live"
                }
              >
                {r.canaryMode}
              </Badge>
            ),
          },
          { key: "observed", header: "Sampled", align: "right", render: (r) => r.observed },
          {
            key: "diverged",
            header: "Would change",
            align: "right",
            render: (r) =>
              r.diverged > 0 ? <Badge tone="warn">{r.diverged}</Badge> : <span>{r.diverged}</span>,
          },
          {
            key: "failed",
            header: "Failed",
            align: "right",
            render: (r) => (r.failed > 0 ? <Badge tone="danger">{r.failed}</Badge> : <span>0</span>),
          },
          {
            key: "stale",
            header: "Stale baseline",
            align: "right",
            render: (r) =>
              r.artifactDeleted ? (
                <Badge tone="danger" title="the artifact these versions describe no longer exists">
                  artifact deleted
                </Badge>
              ) : r.baselineMoved ? (
                <Badge
                  tone="warn"
                  title="the active version moved while this canary was running — these observations compared against a baseline that is no longer current and are NOT in the counts to the left"
                  data-testid={`canary-stale-${r.artifactId}`}
                >
                  {r.staleBaselineObservations}
                </Badge>
              ) : (
                <span>0</span>
              ),
          },
          {
            key: "act",
            header: "",
            render: (r) => (
              <Button size="sm" onClick={() => setSelected(r)}>
                What would change
              </Button>
            ),
          },
        ]}
        rows={rows}
        rowKey={(r) => `${r.artifactType}:${r.artifactId}`}
        loading={canaries.isLoading}
        error={canaries.error}
        onRetry={() => void canaries.refetch()}
        empty={
          <EmptyState
            title="No config canaries running"
            body="Start one from the versioning API to measure what a rule change would do before it enforces anything."
          />
        }
      />

      {selected && (
        <div style={{ marginTop: "var(--s2)" }}>
          <div className={v.faint}>
            <strong>
              {selected.artifactType} {selected.artifactId.slice(0, 8)}… — active v
              {divergence.data?.activeVersion ?? "?"} vs candidate v
              {divergence.data?.candidateVersion ?? "?"}
            </strong>
            {divergence.data?.note ? ` — ${divergence.data.note}` : ""}
          </div>
          {divergence.data && divergence.data.staleBaseline.observed > 0 && (
            <div className={v.errLine} role="status" data-testid="stale-baseline-note">
              <strong>The comparison baseline moved.</strong> {divergence.data.staleBaseline.note}. The counts
              above cover only the observations measured against the version that is active now. Promoting on
              this sample is refused until you re-point the canary (which starts a fresh comparison window) or
              override with a stated reason — a mixed-baseline sample is not one comparison.
              {divergence.data.staleBaseline.buckets.length > 0 && (
                <>
                  {" "}
                  Stranded:{" "}
                  {divergence.data.staleBaseline.buckets
                    .map((b) => `${b.observed} against v${b.activeVersion ?? "?"} (${b.diverged} diverged)`)
                    .join(", ")}
                  .
                </>
              )}
            </div>
          )}
          {divergence.data?.artifactDeleted && (
            <div className={v.errLine} role="status">
              <strong>The artifact these versions describe no longer exists.</strong> The version rows and the
              activation ledger are kept deliberately — they are the record of what governed the calls made
              while it existed — but nothing here can enforce again and these counts will never move.
            </div>
          )}
          <Table<ObservationRow>
            columns={[
              { key: "at", header: "When", render: (o) => ago(o.at) },
              {
                key: "who",
                header: "Caller",
                render: (o) => names.userName.get(o.userId ?? "") ?? o.userId?.slice(0, 8) ?? "—",
              },
              { key: "tool", header: "Tool", render: (o) => o.toolName ?? "—" },
              {
                key: "served",
                header: "Served (enforced)",
                render: (o) => <Badge tone={effectTone(o.servedEffect)}>{o.servedEffect ?? "—"}</Badge>,
              },
              {
                key: "candidate",
                header: "Candidate would",
                render: (o) =>
                  o.failed ? (
                    <Badge tone="danger" title={o.failureReason ?? ""}>
                      evaluation failed
                    </Badge>
                  ) : (
                    <Badge tone={effectTone(o.candidateEffect)}>{o.candidateEffect ?? "—"}</Badge>
                  ),
              },
              {
                key: "why",
                header: "Reason it would give",
                render: (o) => (o.failed ? (o.failureReason ?? "") : (o.candidateReason ?? "")),
              },
            ]}
            rows={divergence.data?.observations ?? []}
            rowKey={(o) => o.id}
            loading={divergence.isLoading}
            error={divergence.error}
            onRetry={() => void divergence.refetch()}
            empty={
              <EmptyState
                title="Nothing sampled yet"
                body="No governed decision has been evaluated against this candidate. Nothing has changed and nothing has been measured."
              />
            }
          />
          {divergence.data?.projectImpact && (
            <>
              <div className={v.faint} style={{ marginTop: "var(--s2)" }}>
                {divergence.data.projectImpactNote}
              </div>
              <Table<ProjectImpactRow>
                columns={[
                  { key: "p", header: "Project", render: (p) => p.projectName },
                  {
                    key: "d",
                    header: "Would change",
                    render: (p) =>
                      p.diverged ? <Badge tone="warn">yes</Badge> : <Badge tone="neutral">no</Badge>,
                  },
                  { key: "f", header: "Dimensions", render: (p) => p.changed.join(", ") || "—" },
                  {
                    key: "b",
                    header: "Before → after",
                    render: (p) =>
                      p.changed
                        .map((k) => `${k}: ${JSON.stringify(p.before[k])} → ${JSON.stringify(p.after[k])}`)
                        .join("; ") || "—",
                  },
                ]}
                rows={divergence.data.projectImpact}
                rowKey={(p) => p.projectId}
                empty={<EmptyState title="No project carries this framework tag" />}
              />
            </>
          )}
        </div>
      )}
    </Card>
  );
}
