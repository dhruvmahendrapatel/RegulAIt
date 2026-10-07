/**
 * Roles — the ADR-0014 provisioning bundle: create roles, assign holders, and
 * define WHAT a role grants (agents, connectors, MCP servers, MCP tools).
 * Deleting a held role answers 409 with the holders named; force-delete
 * requires a recorded, audited reason.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../../../api/client";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import type { Role, RoleAssignment, RoleGrants } from "../../../api/adminTypes";
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
} from "../../../ui/kit";
import {
  QueryGate,
  ReasonModal,
  agentOpts,
  connectorOpts,
  optionEls,
  roleOpts,
  serverOpts,
  useAction,
  useAgents,
  useConnectors,
  useRoles,
  useServerTools,
  useServers,
  useUsers,
  userOpts,
} from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

export default function RolesPage() {
  const roles = useRoles();
  const users = useUsers();
  const act = useAction();
  const create = useAction();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [assignUser, setAssignUser] = useState("");
  const [assignRole, setAssignRole] = useState("");
  const [activeRoleId, setActiveRoleId] = useState("");

  const [confirmDelete, setConfirmDelete] = useState<Role | null>(null);
  const [forceDelete, setForceDelete] = useState<{ role: Role; holders: string[] } | null>(null);

  const deleteRole = async (role: Role) => {
    try {
      await api.del(`/v1/roles/${role.id}`);
      await act.run(async () => {}, "Role deleted");
      if (activeRoleId === role.id) setActiveRoleId("");
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.payload.error === "role_held") {
        setForceDelete({ role, holders: (e.payload.holders as string[]) ?? [] });
      } else {
        void act.run(() => Promise.reject(e), null);
      }
    }
  };

  return (
    <>
      <PageHeader
        title="Roles"
        sub="A role is a provisioning bundle, not a permission."
        info={<p>A role is a provisioning bundle: assigning it hands the holder every grant listed on it. Deleting a role that is still held is refused with the holders named.</p>}
      />
      <div className={v.stack}>
        <Card title="Create & assign">
          <form
            className={a.formRow}
            onSubmit={(e) => {
              e.preventDefault();
              void create
                .run(
                  () => api.post("/v1/roles", { name, ...(description ? { description } : {}) }),
                  "Role created",
                )
                .then((ok) => {
                  if (ok) {
                    setName("");
                    setDescription("");
                  }
                });
            }}
          >
            <Field label="Role name">
              <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. data-analyst" />
            </Field>
            <Field label="Description (optional)" grow>
              <Input value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
            <Button type="submit" variant="primary" disabled={create.busy}>
              Create role
            </Button>
          </form>
          <hr className={v.divider} />
          <form
            className={a.formRow}
            onSubmit={(e) => {
              e.preventDefault();
              void act.run(
                // B4S-02: adding someone to an approver role widens an approver pool
                () => withStepUp((h) => stepUpApi.post(`/v1/users/${assignUser}/roles`, { roleId: assignRole }, h)),
                "Role assigned",
              );
            }}
          >
            <Field label="User">
              <Select required value={assignUser} onChange={(e) => setAssignUser(e.target.value)}>
                {optionEls(userOpts(users.data?.users), "— select a user —")}
              </Select>
            </Field>
            <Field label="Role">
              <Select required value={assignRole} onChange={(e) => setAssignRole(e.target.value)}>
                {optionEls(roleOpts(roles.data?.roles), "— select a role —")}
              </Select>
            </Field>
            <Button type="submit" disabled={act.busy}>
              Assign role
            </Button>
          </form>
          {(create.error || act.error) && (
            <div className={v.errLine} role="alert">
              {create.error ?? act.error}
            </div>
          )}
        </Card>

        <Card flush>
          <Table<Role>
            columns={[
              { key: "name", header: "Name", sort: (r) => r.name, render: (r) => r.name },
              { key: "description", header: "Description", render: (r) => r.description ?? "—" },
              {
                key: "actions",
                header: "",
                align: "right",
                render: (r) => (
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmDelete(r);
                    }}
                  >
                    delete
                  </Button>
                ),
              },
            ]}
            rows={roles.data?.roles ?? []}
            rowKey={(r) => r.id}
            loading={roles.isLoading}
            error={roles.error}
            onRetry={() => void roles.refetch()}
            onRowClick={(r) => setActiveRoleId(r.id === activeRoleId ? "" : r.id)}
            rowLabel={(r) => `Open grants for ${r.name}`}
            empty={<EmptyState title="No roles yet" body="Create the first provisioning bundle above." />}
          />
        </Card>

        {activeRoleId ? (
          <RoleGrantsPanel key={activeRoleId} roleId={activeRoleId} />
        ) : (
          <Card>
            <EmptyState
              title="Select a role to view and edit its grants and holders"
              body="Click a role row above — its holders and bundled grants load here."
            />
          </Card>
        )}
      </div>

      <ConfirmModal
        open={confirmDelete !== null}
        title={`Delete role “${confirmDelete?.name}”?`}
        body="If the role is still held, deletion is refused with the holders named and you can force-delete with a recorded reason."
        danger
        confirmLabel="Delete role"
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          const r = confirmDelete;
          setConfirmDelete(null);
          if (r) void deleteRole(r);
        }}
      />
      <ReasonModal
        open={forceDelete !== null}
        title={`Role “${forceDelete?.role.name}” is still held`}
        body={
          <span className={v.dim}>
            Held by {forceDelete?.holders.join(", ") || "unknown"}. Force-deleting unassigns everyone and
            removes its bundled grants — the reason is audited.
          </span>
        }
        confirmLabel="Force delete"
        danger
        onCancel={() => setForceDelete(null)}
        onConfirm={(reason) => {
          const r = forceDelete?.role;
          setForceDelete(null);
          if (r)
            void act
              .run(
                () =>
                  fetchDeleteWithBody(`/v1/roles/${r.id}`, { force: true, reason }),
                "Role force-deleted — holders unassigned, reason audited",
              )
              .then((ok) => {
                if (ok && activeRoleId === r.id) setActiveRoleId("");
              });
        }}
      />
    </>
  );
}

/** DELETE with a JSON body (the force-delete contract) */
async function fetchDeleteWithBody(path: string, body: unknown): Promise<void> {
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

// ---- grants + holders for the active role ---------------------------------

function RoleGrantsPanel(props: { roleId: string }) {
  const agents = useAgents();
  const connectors = useConnectors();
  const servers = useServers();
  const act = useAction();

  const grants = useQuery({
    queryKey: ["admin", "role-grants", props.roleId],
    queryFn: () => api.get<RoleGrants>(`/v1/roles/${props.roleId}/grants`),
  });
  const assignments = useQuery({
    queryKey: ["admin", "role-assignments", props.roleId],
    queryFn: () => api.get<{ assignments: RoleAssignment[] }>(`/v1/roles/${props.roleId}/assignments`),
  });

  const [agentId, setAgentId] = useState("");
  const [connectorId, setConnectorId] = useState("");
  const [connMode, setConnMode] = useState("read");
  const [connObjects, setConnObjects] = useState("");
  const [toolServerId, setToolServerId] = useState("");
  const [toolName, setToolName] = useState("");
  const [srvId, setSrvId] = useState("");
  const serverTools = useServerTools(toolServerId || null);
  const [unassign, setUnassign] = useState<RoleAssignment | null>(null);
  const [removeGrant, setRemoveGrant] = useState<{ kind: string; id: string; label: string } | null>(null);

  const rmButton = (kind: string, id: string, label: string) => (
    <Button size="sm" variant="ghost" onClick={() => setRemoveGrant({ kind, id, label })}>
      remove
    </Button>
  );

  return (
    <QueryGate
      loading={grants.isLoading || assignments.isLoading}
      error={grants.error ?? assignments.error}
      onRetry={() => {
        void grants.refetch();
        void assignments.refetch();
      }}
    >
      <Card title="Held by">
        <Table<RoleAssignment>
          columns={[
            {
              key: "user",
              header: "User",
              render: (x) => (
                <span>
                  {x.displayName || x.email}
                  {x.disabledAt && <Badge tone="danger"> disabled</Badge>}
                </span>
              ),
            },
            { key: "email", header: "Email", render: (x) => x.email },
            { key: "assigned", header: "Assigned", render: (x) => ago(x.assignedAt) },
            {
              key: "actions",
              header: "",
              align: "right",
              render: (x) => (
                <Button size="sm" variant="ghost" onClick={() => setUnassign(x)}>
                  unassign
                </Button>
              ),
            },
          ]}
          rows={assignments.data?.assignments ?? []}
          rowKey={(x) => x.userId}
          empty={<EmptyState title="Nobody holds this role yet" />}
        />
      </Card>

      <Card title="Add a grant to this bundle">
        <div className={v.grid2}>
          <form
            className={a.formRow}
            onSubmit={(e) => {
              e.preventDefault();
              void act.run(
                () => api.post(`/v1/roles/${props.roleId}/grants/agents`, { agentId }),
                "Agent granted",
              );
            }}
          >
            <Field label="Agent" grow>
              <Select required value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                {optionEls(agentOpts(agents.data?.agents), "— select —")}
              </Select>
            </Field>
            <Button type="submit" size="sm" disabled={act.busy}>
              Grant agent
            </Button>
          </form>
          <form
            className={a.formRow}
            onSubmit={(e) => {
              e.preventDefault();
              void act.run(
                () =>
                  api.post(`/v1/roles/${props.roleId}/grants/connectors`, {
                    connectorId,
                    mode: connMode,
                    ...(connObjects
                      ? { allowedObjects: connObjects.split(",").map((s) => s.trim()).filter(Boolean) }
                      : {}),
                  }),
                "Connector granted",
              );
            }}
          >
            <Field label="Connector" grow>
              <Select required value={connectorId} onChange={(e) => setConnectorId(e.target.value)}>
                {optionEls(connectorOpts(connectors.data?.connectors), "— select —")}
              </Select>
            </Field>
            <Field label="Mode">
              <Select value={connMode} onChange={(e) => setConnMode(e.target.value)}>
                <option value="read">read</option>
                <option value="readwrite">readwrite</option>
              </Select>
            </Field>
            <Field label="Object scope (blank = all)">
              <Input value={connObjects} onChange={(e) => setConnObjects(e.target.value)} placeholder="comma,separated" />
            </Field>
            <Button type="submit" size="sm" disabled={act.busy}>
              Grant connector
            </Button>
          </form>
          <form
            className={a.formRow}
            onSubmit={(e) => {
              e.preventDefault();
              void act.run(
                () =>
                  api.post(`/v1/roles/${props.roleId}/grants/tools`, { serverId: toolServerId, toolName }),
                "Tool granted",
              );
            }}
          >
            <Field label="Server">
              <Select required value={toolServerId} onChange={(e) => setToolServerId(e.target.value)}>
                {optionEls(serverOpts(servers.data?.servers), "— select —")}
              </Select>
            </Field>
            <Field label="Tool">
              <Select required value={toolName} onChange={(e) => setToolName(e.target.value)}>
                {optionEls(
                  (serverTools.data?.tools ?? []).map((t) => ({ v: t.name, l: t.name })),
                  "— select —",
                )}
              </Select>
            </Field>
            <Button type="submit" size="sm" disabled={act.busy}>
              Grant MCP tool
            </Button>
          </form>
          <form
            className={a.formRow}
            onSubmit={(e) => {
              e.preventDefault();
              void act.run(
                () =>
                  api.post(`/v1/roles/${props.roleId}/grants/servers`, {
                    serverId: srvId,
                    // A server grant IS a read-all grant: the kernel only ever
                    // matches one for read-kind tools. readOnlyAll:false is
                    // refused by the gateway because it would store a row that
                    // lists as a grant while granting nothing.
                    readOnlyAll: true,
                  }),
                "Server granted",
              );
            }}
          >
            <Field label="Server">
              <Select required value={srvId} onChange={(e) => setSrvId(e.target.value)}>
                {optionEls(serverOpts(servers.data?.servers), "— select —")}
              </Select>
            </Field>
            <span className={v.hint}>
              Grants every <strong>read</strong> tool on the server. Write tools still need an
              individual tool grant.
            </span>
            <Button type="submit" size="sm" disabled={act.busy}>
              Grant MCP server
            </Button>
          </form>
        </div>
        {act.error && (
          <div className={v.errLine} role="alert">
            {act.error}
          </div>
        )}
      </Card>

      <Card title="What this role provisions">
        <div className={v.sectionTitle}>Agents</div>
        <Table
          columns={[
            { key: "agent", header: "Agent", render: (x: NonNullable<RoleGrants["agents"]>[number]) => x.agentName ?? x.agentId },
            { key: "modes", header: "Modes", render: (x) => (x.allowedModes ?? []).join(", ") || "all" },
            { key: "actions", header: "", align: "right", render: (x) => rmButton("agents", x.grantId, x.agentName ?? "agent") },
          ]}
          rows={grants.data?.agents ?? []}
          rowKey={(x) => x.grantId}
          empty={<EmptyState title="No agent grants" />}
        />
        <div className={v.sectionTitle}>Connectors</div>
        <Table
          columns={[
            { key: "connector", header: "Connector", render: (x: NonNullable<RoleGrants["connectors"]>[number]) => x.connectorName ?? x.connectorId },
            { key: "mode", header: "Mode", render: (x) => x.mode },
            { key: "objects", header: "Objects", render: (x) => (x.allowedObjects ?? []).join(", ") || "all" },
            { key: "actions", header: "", align: "right", render: (x) => rmButton("connectors", x.grantId, x.connectorName ?? "connector") },
          ]}
          rows={grants.data?.connectors ?? []}
          rowKey={(x) => x.grantId}
          empty={<EmptyState title="No connector grants" />}
        />
        <div className={v.sectionTitle}>MCP servers</div>
        <Table
          columns={[
            { key: "server", header: "Server", render: (x: NonNullable<RoleGrants["servers"]>[number]) => x.serverName ?? x.serverId },
            { key: "readOnlyAll", header: "Read-only all", render: (x) => String(x.readOnlyAll) },
            { key: "actions", header: "", align: "right", render: (x) => rmButton("servers", x.grantId, x.serverName ?? "server") },
          ]}
          rows={grants.data?.servers ?? []}
          rowKey={(x) => x.grantId}
          empty={<EmptyState title="No server grants" />}
        />
        <div className={v.sectionTitle}>MCP tools</div>
        <Table
          columns={[
            { key: "server", header: "Server", render: (x: NonNullable<RoleGrants["tools"]>[number]) => x.serverName ?? x.serverId },
            { key: "tool", header: "Tool", render: (x) => x.toolName },
            { key: "actions", header: "", align: "right", render: (x) => rmButton("tools", x.grantId, x.toolName) },
          ]}
          rows={grants.data?.tools ?? []}
          rowKey={(x) => x.grantId}
          empty={<EmptyState title="No tool grants" />}
        />
      </Card>

      <ConfirmModal
        open={unassign !== null}
        title={`Unassign ${unassign?.displayName || unassign?.email}?`}
        body="They lose everything this bundle grants the moment you confirm (their direct grants are untouched)."
        danger
        confirmLabel="Unassign"
        onCancel={() => setUnassign(null)}
        onConfirm={() => {
          const x = unassign;
          setUnassign(null);
          if (x)
            void act.run(
              () => api.del(`/v1/users/${x.userId}/roles/${props.roleId}`),
              "Role unassigned",
            );
        }}
      />
      <ConfirmModal
        open={removeGrant !== null}
        title={`Remove ${removeGrant?.label} from this role?`}
        body="Every holder loses this grant through the role (direct grants are untouched)."
        danger
        confirmLabel="Remove grant"
        onCancel={() => setRemoveGrant(null)}
        onConfirm={() => {
          const g = removeGrant;
          setRemoveGrant(null);
          if (g)
            void act.run(
              () => api.del(`/v1/roles/${props.roleId}/grants/${g.kind}/${g.id}`),
              "Grant removed from the role",
            );
        }}
      />
    </QueryGate>
  );
}
