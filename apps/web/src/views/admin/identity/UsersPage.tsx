/**
 * Users — the ADR-0022/0025 identity lifecycle: create, rename,
 * deactivate/reactivate (with last-admin guards), promote/demote, one-time
 * password issue/reset (one-time reveal), MFA clear (reason required,
 * audited), live sessions (list + revoke), API keys (issue with one-time
 * reveal, revoke), and the per-user overrides (MCP / agent / connector
 * revocations) that beat every grant.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type {
  AdminUser,
  ApiKey,
  McpRevocation,
  ObjectRevocation,
  RevocationScope,
  RevocationScopeKind,
  UserSession,
} from "../../../api/adminTypes";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import {
  Badge,
  Button,
  Card,
  ConfirmModal,
  EmptyState,
  Field,
  Input,
  Select,
  Table,
  Tabs,
} from "../../../ui/kit";
import {
  QueryGate,
  ReasonModal,
  RevealCard,
  agentOpts,
  connectorOpts,
  optionEls,
  serverOpts,
  useAction,
  useAgents,
  useConnectors,
  useServerTools,
  useServers,
  useUsers,
  type RevealedSecret,
} from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

export default function UsersPage() {
  const users = useUsers();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reveal, setReveal] = useState<RevealedSecret | null>(null);
  const create = useAction();
  const act = useAction();

  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [isAdmin, setIsAdmin] = useState("false");

  const [confirm, setConfirm] = useState<{
    title: string;
    body: string;
    danger?: boolean;
    onConfirm: () => void;
  } | null>(null);
  const [mfaClearFor, setMfaClearFor] = useState<AdminUser | null>(null);

  const rows = users.data?.users ?? [];
  const activeAdmins = rows.filter((u) => u.isAdmin && !u.disabledAt).length;
  const selected = rows.find((u) => u.id === selectedId) ?? null;

  const issuePassword = async (u: AdminUser, force: boolean) => {
    await act.run(async () => {
      const issued = await api.post<{ password: string }>(
        `/v1/users/${u.id}/set-initial-password`,
        force ? { force: true } : {},
      );
      setReveal({
        title: `One-time password for ${u.email}`,
        secret: issued.password,
        note: "Hand it to them over a channel you trust. They must replace it at first sign-in; every prior session was signed out.",
      });
    }, "One-time password issued");
  };

  const issueKey = async (u: AdminUser) => {
    await act.run(async () => {
      const issued = await api.post<{ token: string }>(`/v1/users/${u.id}/keys`, { name: "portal" });
      setReveal({
        title: `API key for ${u.email}`,
        secret: issued.token,
        note: "Hand it to them over a channel you trust; if it is lost, revoke it and issue another.",
      });
    }, "API key issued");
  };

  return (
    <>
      <PageHeader
        title="Users"
        sub="Accounts, activation state, and the last-admin protection."
        info={<p>Deactivate is not delete: audit history, grants and keys survive; authentication stops until an admin reactivates. The last active admin can be neither deactivated nor demoted.</p>}
      />
      <div className={v.stack}>
        {reveal && <RevealCard reveal={reveal} onDismiss={() => setReveal(null)} />}

        <Card title="Create a user">
          <form
            className={a.formRow}
            onSubmit={(e) => {
              e.preventDefault();
              void create
                .run(
                  () => api.post("/v1/users", { email, displayName, isAdmin: isAdmin === "true" }),
                  "User created — issue them a one-time password or an API key below",
                )
                .then((ok) => {
                  if (ok) {
                    setEmail("");
                    setDisplayName("");
                    setIsAdmin("false");
                  }
                });
            }}
          >
            <Field label="Email">
              <Input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="dev@example.com"
              />
            </Field>
            <Field label="Display name">
              <Input required value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </Field>
            <Field label="Admin">
              <Select value={isAdmin} onChange={(e) => setIsAdmin(e.target.value)}>
                <option value="false">member</option>
                <option value="true">admin</option>
              </Select>
            </Field>
            <Button type="submit" variant="primary" disabled={create.busy}>
              Create user
            </Button>
          </form>
          {create.error && (
            <div className={v.errLine} role="alert">
              {create.error}
            </div>
          )}
        </Card>

        <Card flush>
          <Table<AdminUser>
            columns={[
              {
                key: "name",
                header: "Name",
                sort: (u) => u.displayName || u.email,
                render: (u) => (
                  <span className={u.disabledAt ? v.faint : undefined}>{u.displayName || "—"}</span>
                ),
              },
              { key: "email", header: "Email", sort: (u) => u.email, render: (u) => u.email },
              {
                key: "role",
                header: "Role",
                sort: (u) => (u.isAdmin ? 0 : 1),
                render: (u) =>
                  u.isAdmin ? <Badge tone="primary">admin</Badge> : <Badge>member</Badge>,
              },
              {
                key: "signIn",
                header: "Sign-in",
                render: (u) =>
                  u.hasPassword ? (u.mustChangePassword ? "one-time pw" : "password") : "no password",
              },
              { key: "mfa", header: "MFA", render: (u) => (u.totpEnabled ? "TOTP" : "—") },
              {
                key: "status",
                header: "Status",
                sort: (u) => (u.disabledAt ? 1 : 0),
                render: (u) =>
                  u.disabledAt ? <Badge tone="danger">disabled</Badge> : <Badge tone="ok">active</Badge>,
              },
              { key: "created", header: "Created", sort: (u) => u.createdAt, render: (u) => ago(u.createdAt) },
            ]}
            rows={rows}
            rowKey={(u) => u.id}
            loading={users.isLoading}
            onRowClick={(u) => setSelectedId(u.id === selectedId ? null : u.id)}
            rowLabel={(u) => `Manage ${u.displayName || u.email}`}
            empty={<EmptyState title="No users yet" body="Create the first developer account above." />}
          />
        </Card>

        {users.isError && (
          <Card>
            <div className={v.errLine} role="alert">
              {(users.error as Error).message}
            </div>
            <Button size="sm" onClick={() => void users.refetch()}>
              Retry
            </Button>
          </Card>
        )}

        {selected && (
          <UserDetail
            key={selected.id}
            user={selected}
            activeAdmins={activeAdmins}
            onIssueKey={() => void issueKey(selected)}
            onIssuePassword={(force) => void issuePassword(selected, force)}
            onPromote={() =>
              void act.run(
                () => api.post(`/v1/users/${selected.id}/admin`, { isAdmin: true }),
                "Promoted to admin",
              )
            }
            onDemote={() =>
              setConfirm({
                title: "Demote to member?",
                body: `${selected.displayName || selected.email} loses the admin console and every admin-only endpoint immediately.`,
                onConfirm: () =>
                  void act.run(
                    () => api.post(`/v1/users/${selected.id}/admin`, { isAdmin: false }),
                    "Demoted to member",
                  ),
              })
            }
            onDeactivate={() =>
              setConfirm({
                title: "Deactivate this user?",
                body: "Their keys and browser sessions stop authenticating (a distinct 401) until an admin reactivates. Nothing is deleted.",
                danger: true,
                onConfirm: () =>
                  void act.run(
                    () => api.post(`/v1/users/${selected.id}/deactivate`, {}),
                    "User deactivated — their keys stop authenticating until reactivated",
                  ),
              })
            }
            onReactivate={() =>
              void act.run(
                () => api.post(`/v1/users/${selected.id}/reactivate`, {}),
                "User reactivated — their existing keys work again",
              )
            }
            onClearMfa={() => setMfaClearFor(selected)}
          />
        )}

        <ApiKeysCard />
      </div>

      <ConfirmModal
        open={confirm !== null}
        title={confirm?.title ?? ""}
        body={confirm?.body}
        danger={confirm?.danger}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          confirm?.onConfirm();
          setConfirm(null);
        }}
      />
      <ReasonModal
        open={mfaClearFor !== null}
        title="Clear MFA (lost authenticator)"
        body={
          <span className={v.dim}>
            Clearing MFA is the lost-authenticator recovery path — {mfaClearFor?.email} signs in with just
            their password and re-enrolls. The reason is audited.
          </span>
        }
        confirmLabel="Clear MFA"
        danger
        onCancel={() => setMfaClearFor(null)}
        onConfirm={(reason) => {
          const u = mfaClearFor;
          setMfaClearFor(null);
          if (u)
            void act.run(
              () => api.post(`/v1/users/${u.id}/mfa/clear`, { reason }),
              "MFA cleared — they can sign in with their password and re-enroll",
            );
        }}
      />
    </>
  );
}

// ---- per-user detail: lifecycle actions, rename, sessions, overrides -------

function UserDetail(props: {
  user: AdminUser;
  activeAdmins: number;
  onIssueKey: () => void;
  onIssuePassword: (force: boolean) => void;
  onPromote: () => void;
  onDemote: () => void;
  onDeactivate: () => void;
  onReactivate: () => void;
  onClearMfa: () => void;
}) {
  const { user } = props;
  const lastAdmin = user.isAdmin && !user.disabledAt && props.activeAdmins <= 1;
  const [tab, setTab] = useState("lifecycle");
  return (
    <Card
      title={
        <span>
          {user.displayName || user.email} <span className={v.faint}>· {user.email}</span>
        </span>
      }
    >
      <Tabs
        tabs={[
          { id: "lifecycle", label: "Lifecycle" },
          { id: "sessions", label: "Sessions" },
          { id: "overrides", label: "Overrides" },
        ]}
        active={tab}
        onChange={setTab}
      />
      <div style={{ marginTop: "var(--s2)" }}>
        {tab === "lifecycle" && (
          <div className={v.stack}>
            <div className={v.row}>
              {!user.disabledAt && (
                <>
                  <Button size="sm" onClick={props.onIssueKey}>
                    Issue API key
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => props.onIssuePassword(user.hasPassword)}
                    title={
                      user.hasPassword
                        ? "Overwrites their password with a fresh one-time one (audited reset)"
                        : "Issues a generated password shown once — they must replace it at first sign-in"
                    }
                  >
                    {user.hasPassword ? "Reset password" : "Set one-time password"}
                  </Button>
                  {user.totpEnabled && (
                    <Button size="sm" onClick={props.onClearMfa}>
                      Clear MFA
                    </Button>
                  )}
                  {user.isAdmin ? (
                    <Button
                      size="sm"
                      onClick={props.onDemote}
                      disabled={lastAdmin}
                      title={lastAdmin ? "last active admin — promote another admin first" : undefined}
                    >
                      Demote
                    </Button>
                  ) : (
                    <Button size="sm" onClick={props.onPromote}>
                      Make admin
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={props.onDeactivate}
                    disabled={lastAdmin}
                    title={lastAdmin ? "last active admin — promote another admin first" : undefined}
                  >
                    Deactivate
                  </Button>
                </>
              )}
              {user.disabledAt && (
                <Button size="sm" variant="primary" onClick={props.onReactivate}>
                  Reactivate
                </Button>
              )}
            </div>
            <RenameForm user={user} />
          </div>
        )}
        {tab === "sessions" && <SessionsPanel userId={user.id} />}
        {tab === "overrides" && <OverridesPanel userId={user.id} />}
      </div>
    </Card>
  );
}

function RenameForm(props: { user: AdminUser }) {
  const [name, setName] = useState(props.user.displayName ?? "");
  const act = useAction();
  return (
    <form
      className={a.formRow}
      onSubmit={(e) => {
        e.preventDefault();
        void act.run(
          () => api.patch(`/v1/users/${props.user.id}`, { displayName: name }),
          "Display name updated",
        );
      }}
    >
      <Field label="Display name" grow>
        <Input required value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Button type="submit" size="sm" disabled={act.busy}>
        Rename
      </Button>
      {act.error && (
        <span className={v.errLine} role="alert">
          {act.error}
        </span>
      )}
    </form>
  );
}

// ---- live sessions --------------------------------------------------------

function SessionsPanel(props: { userId: string }) {
  const q = useQuery({
    queryKey: ["admin", "sessions", props.userId],
    queryFn: () => api.get<{ sessions: UserSession[] }>(`/v1/users/${props.userId}/sessions`),
  });
  const act = useAction();
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const sessions = q.data?.sessions ?? [];
  const live = sessions.filter((s) => !s.revokedAt && new Date(s.expiresAt).getTime() > Date.now());
  return (
    <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
      <div className={v.stack}>
        <div className={v.row}>
          <span className={v.dim}>
            {live.length} live session(s) · {sessions.length} recorded
          </span>
          <span className={v.grow} />
          <Button size="sm" variant="danger" disabled={live.length === 0} onClick={() => setConfirmRevoke(true)}>
            Revoke all live sessions
          </Button>
        </div>
        <Table<UserSession>
          columns={[
            { key: "created", header: "Signed in", sort: (s) => s.createdAt, render: (s) => ago(s.createdAt) },
            { key: "seen", header: "Last seen", render: (s) => ago(s.lastSeenAt) },
            {
              key: "ip",
              header: "IP (current · at sign-in)",
              render: (s) => (
                <span className={v.mono}>
                  {s.lastSeenIp ?? s.ip ?? "—"}
                  {s.lastSeenIp && s.ip && s.lastSeenIp !== s.ip ? ` · ${s.ip}` : ""}
                </span>
              ),
            },
            {
              key: "device",
              header: "Device",
              // ADR-0039: the derived browser+OS family — display only, never
              // a security control; the raw UA stays in the hover title
              render: (s) => (
                <span className={v.faint} title={s.userAgent ?? undefined}>
                  {s.deviceLabel}
                </span>
              ),
            },
            { key: "origin", header: "Origin", render: (s) => <span className={v.mono}>{s.origin}</span> },
            {
              key: "status",
              header: "Status",
              render: (s) =>
                s.revokedAt ? (
                  <Badge tone="danger">revoked</Badge>
                ) : new Date(s.expiresAt).getTime() < Date.now() ? (
                  <Badge>expired</Badge>
                ) : (
                  <Badge tone="ok">live</Badge>
                ),
            },
            {
              key: "actions",
              header: "",
              render: (s) =>
                !s.revokedAt && new Date(s.expiresAt).getTime() > Date.now() ? (
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={act.busy}
                    onClick={() =>
                      void act.run(
                        () => api.post(`/v1/users/${props.userId}/sessions/${s.id}/revoke`, {}),
                        "Session revoked (audited)",
                      )
                    }
                  >
                    Revoke
                  </Button>
                ) : null,
            },
          ]}
          rows={sessions}
          rowKey={(s) => s.id}
          empty={<EmptyState title="No browser sessions" body="This user has never signed in with a password." />}
        />
      </div>
      <ConfirmModal
        open={confirmRevoke}
        title="Revoke all live sessions?"
        body="Every live browser session for this user stops authenticating immediately (audited). Their API keys are unaffected."
        danger
        confirmLabel="Revoke sessions"
        onCancel={() => setConfirmRevoke(false)}
        onConfirm={() => {
          setConfirmRevoke(false);
          void act.run(
            () => api.post(`/v1/users/${props.userId}/sessions/revoke`, {}),
            "Live sessions revoked",
          );
        }}
      />
    </QueryGate>
  );
}

// ---- per-user overrides (revocations) -------------------------------------

/**
 * O9 (ADR-0027) — PATCH /v1/revocations/:kind/:revocationId/scope.
 *
 * A revocation is CREATED full (the unambiguous ADR-0019 total). Narrowing it
 * to read_only keeps write-classified tools/operations denied while letting
 * reads through; a full revocation always beats everything else. Scope is an
 * EDIT of an existing subtractive override, never part of creation — so this
 * lives on the row, not on the add form. Agent revocations carry no scope
 * (agents have no read/write operation classification to scope by), which is
 * why only the MCP and connector tables get this column. Every change is
 * audited.
 */
function RevocationScopeCell(props: {
  kind: RevocationScopeKind;
  revocationId: string;
  scope: RevocationScope | undefined;
}) {
  const act = useAction();
  return (
    <span className={v.stackTight}>
      <Select
        aria-label={`Scope for revocation ${props.revocationId}`}
        data-testid={`revocation-scope-${props.revocationId}`}
        value={props.scope ?? "full"}
        disabled={act.busy}
        onChange={(e) => {
          const next = e.target.value as RevocationScope;
          void act.run(
            () =>
              api.patch(`/v1/revocations/${props.kind}/${props.revocationId}/scope`, { scope: next }),
            next === "read_only"
              ? "Narrowed to read_only — writes stay denied, reads are allowed again"
              : "Restored to full — every tool/operation denied",
          );
        }}
      >
        <option value="full">full — everything denied</option>
        <option value="read_only">read_only — writes denied, reads allowed</option>
      </Select>
      {act.error && (
        <span className={v.errLine} role="alert">
          {act.error}
        </span>
      )}
    </span>
  );
}

function OverridesPanel(props: { userId: string }) {
  const servers = useServers();
  const agents = useAgents();
  const connectors = useConnectors();
  const act = useAction();

  const mcpRevs = useQuery({
    queryKey: ["admin", "revocations"],
    queryFn: () => api.get<{ revocations: McpRevocation[] }>("/v1/revocations"),
  });
  const agentRevs = useQuery({
    queryKey: ["admin", "agent-revocations", props.userId],
    queryFn: () =>
      api.get<{ revocations: ObjectRevocation[] }>(`/v1/users/${props.userId}/revocations/agents`),
  });
  const connRevs = useQuery({
    queryKey: ["admin", "connector-revocations", props.userId],
    queryFn: () =>
      api.get<{ revocations: ObjectRevocation[] }>(`/v1/users/${props.userId}/revocations/connectors`),
  });

  const [serverId, setServerId] = useState("");
  const tools = useServerTools(serverId || null);
  const [toolName, setToolName] = useState("");
  const [agentId, setAgentId] = useState("");
  const [agentReason, setAgentReason] = useState("");
  const [connectorId, setConnectorId] = useState("");
  const [connReason, setConnReason] = useState("");

  const serverName = useMemo(
    () => new Map((servers.data?.servers ?? []).map((s) => [s.id, s.name])),
    [servers.data],
  );
  const mine = (mcpRevs.data?.revocations ?? []).filter((r) => r.userId === props.userId);

  return (
    <div className={v.stack}>
      <div className={v.dim}>
        A revocation takes ONE object away from THIS user without touching their roles — it beats both a
        direct grant and every role-derived grant, and it can only ever deny. Lifting it restores whatever
        the grants already said. Every revocation is CREATED full (the unambiguous ADR-0019 total); the
        <strong> Scope</strong> column narrows an existing MCP or connector revocation to read_only —
        write-classified tools/operations stay denied while reads are allowed again — or restores it to
        full. Agent revocations carry no scope: agents have no read/write operation classification to
        scope by. Every scope change is audited.
      </div>
      <div className={v.sectionTitle}>MCP revocations</div>
      <form
        className={a.formRow}
        onSubmit={(e) => {
          e.preventDefault();
          void act.run(
            () =>
              api.post("/v1/revocations", {
                userId: props.userId,
                serverId,
                toolName: toolName || null,
              }),
            "MCP revocation added",
          );
        }}
      >
        <Field label="Server">
          <Select required value={serverId} onChange={(e) => setServerId(e.target.value)}>
            {optionEls(serverOpts(servers.data?.servers), "— select a server —")}
          </Select>
        </Field>
        <Field label="Tool (blank = all role-derived)">
          <Select value={toolName} onChange={(e) => setToolName(e.target.value)}>
            {optionEls(
              (tools.data?.tools ?? []).map((t) => ({ v: t.name, l: t.name })),
              "— all role-derived —",
            )}
          </Select>
        </Field>
        <Button type="submit" size="sm" disabled={act.busy}>
          Add revocation
        </Button>
      </form>
      <Table<McpRevocation>
        columns={[
          { key: "server", header: "Server", render: (r) => serverName.get(r.serverId) ?? r.serverId },
          { key: "tool", header: "Tool", render: (r) => r.toolName ?? "— all role-derived —" },
          {
            key: "scope",
            header: "Scope",
            render: (r) => <RevocationScopeCell kind="mcp" revocationId={r.id} scope={r.scope} />,
          },
          { key: "created", header: "Created", render: (r) => ago(r.createdAt) },
          {
            key: "actions",
            header: "",
            align: "right",
            render: (r) => (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void act.run(() => api.del(`/v1/revocations/${r.id}`), "Revocation lifted")}
              >
                lift
              </Button>
            ),
          },
        ]}
        rows={mine}
        rowKey={(r) => r.id}
        loading={mcpRevs.isLoading}
        empty={<EmptyState title="No MCP revocations for this user" />}
      />

      <div className={v.grid2}>
        <div>
          <div className={v.sectionTitle}>Revoked agents</div>
          <form
            className={a.formRow}
            onSubmit={(e) => {
              e.preventDefault();
              void act
                .run(
                  () =>
                    api.post(`/v1/users/${props.userId}/revocations/agents`, {
                      agentId,
                      ...(agentReason ? { reason: agentReason } : {}),
                    }),
                  "Agent revoked for this user",
                )
                .then((ok) => ok && setAgentReason(""));
            }}
          >
            <Field label="Agent" grow>
              <Select required value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                {optionEls(agentOpts(agents.data?.agents), "— select —")}
              </Select>
            </Field>
            <Field label="Reason (optional, recorded)" grow>
              <Input value={agentReason} onChange={(e) => setAgentReason(e.target.value)} />
            </Field>
            <Button type="submit" size="sm" disabled={act.busy}>
              Revoke agent
            </Button>
          </form>
          <Table<ObjectRevocation>
            columns={[
              { key: "agent", header: "Agent", render: (r) => r.agentName ?? "—" },
              { key: "reason", header: "Reason", render: (r) => r.reason ?? "—" },
              {
                key: "actions",
                header: "",
                align: "right",
                render: (r) => (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void act.run(
                        () => api.del(`/v1/users/${props.userId}/revocations/agents/${r.id}`),
                        "Agent revocation lifted",
                      )
                    }
                  >
                    lift
                  </Button>
                ),
              },
            ]}
            rows={agentRevs.data?.revocations ?? []}
            rowKey={(r) => r.id}
            loading={agentRevs.isLoading}
            empty={<EmptyState title="No agent revocations" />}
          />
        </div>
        <div>
          <div className={v.sectionTitle}>Revoked connectors</div>
          <form
            className={a.formRow}
            onSubmit={(e) => {
              e.preventDefault();
              void act
                .run(
                  () =>
                    api.post(`/v1/users/${props.userId}/revocations/connectors`, {
                      connectorId,
                      ...(connReason ? { reason: connReason } : {}),
                    }),
                  "Connector revoked for this user",
                )
                .then((ok) => ok && setConnReason(""));
            }}
          >
            <Field label="Connector" grow>
              <Select required value={connectorId} onChange={(e) => setConnectorId(e.target.value)}>
                {optionEls(connectorOpts(connectors.data?.connectors), "— select —")}
              </Select>
            </Field>
            <Field label="Reason (optional, recorded)" grow>
              <Input value={connReason} onChange={(e) => setConnReason(e.target.value)} />
            </Field>
            <Button type="submit" size="sm" disabled={act.busy}>
              Revoke connector
            </Button>
          </form>
          <Table<ObjectRevocation>
            columns={[
              { key: "connector", header: "Connector", render: (r) => r.connectorName ?? "—" },
              { key: "reason", header: "Reason", render: (r) => r.reason ?? "—" },
              {
                key: "scope",
                header: "Scope",
                render: (r) => (
                  <RevocationScopeCell kind="connectors" revocationId={r.id} scope={r.scope} />
                ),
              },
              {
                key: "actions",
                header: "",
                align: "right",
                render: (r) => (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void act.run(
                        () => api.del(`/v1/users/${props.userId}/revocations/connectors/${r.id}`),
                        "Connector revocation lifted",
                      )
                    }
                  >
                    lift
                  </Button>
                ),
              },
            ]}
            rows={connRevs.data?.revocations ?? []}
            rowKey={(r) => r.id}
            loading={connRevs.isLoading}
            empty={<EmptyState title="No connector revocations" />}
          />
        </div>
      </div>
    </div>
  );
}

// ---- API keys (fleet-wide) ------------------------------------------------

function ApiKeysCard() {
  const users = useUsers();
  const q = useQuery({
    queryKey: ["admin", "keys"],
    queryFn: () => api.get<{ keys: ApiKey[] }>("/v1/keys"),
  });
  const act = useAction();
  const [revokeKey, setRevokeKey] = useState<ApiKey | null>(null);
  const email = useMemo(
    () => new Map((users.data?.users ?? []).map((u) => [u.id, u.email])),
    [users.data],
  );
  return (
    <Card title="API keys — plaintext returned exactly once, sha256 at rest">
      <Table<ApiKey>
        columns={[
          { key: "name", header: "Name", render: (k) => k.name },
          { key: "user", header: "User", sort: (k) => email.get(k.userId) ?? "", render: (k) => email.get(k.userId) ?? "—" },
          { key: "created", header: "Created", sort: (k) => k.createdAt, render: (k) => ago(k.createdAt) },
          { key: "used", header: "Last used", render: (k) => (k.lastUsedAt ? ago(k.lastUsedAt) : "never") },
          {
            key: "status",
            header: "Status",
            sort: (k) => (k.revokedAt ? 1 : 0),
            render: (k) => (k.revokedAt ? <Badge tone="danger">revoked</Badge> : <Badge tone="ok">active</Badge>),
          },
          {
            key: "actions",
            header: "",
            align: "right",
            render: (k) =>
              k.revokedAt ? null : (
                <Button size="sm" variant="danger" onClick={() => setRevokeKey(k)}>
                  revoke
                </Button>
              ),
          },
        ]}
        rows={q.data?.keys ?? []}
        rowKey={(k) => k.id}
        loading={q.isLoading}
        empty={
          <EmptyState
            title="No API keys yet"
            body="Issue one from a user's Lifecycle tab — the plaintext is revealed exactly once."
          />
        }
      />
      <ConfirmModal
        open={revokeKey !== null}
        title="Revoke this key for good?"
        body={`The holder of “${revokeKey?.name}” (${email.get(revokeKey?.userId ?? "") ?? "unknown"}) can no longer authenticate with it. This cannot be undone — issue a new key instead.`}
        danger
        confirmLabel="Revoke key"
        onCancel={() => setRevokeKey(null)}
        onConfirm={() => {
          const k = revokeKey;
          setRevokeKey(null);
          if (k)
            void act.run(
              () => api.post(`/v1/keys/${k.id}/revoke`, {}),
              "Key revoked — the holder can no longer authenticate with it",
            );
        }}
      />
    </Card>
  );
}
