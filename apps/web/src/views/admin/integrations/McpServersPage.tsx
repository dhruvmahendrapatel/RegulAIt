/**
 * MCP servers — the server registry, the tool inventory (registered here or
 * auto-discovered on first proxy use), and the tool-level / server-level
 * allow-list grants. Every policy rule hard-references a tool by name, so the
 * inventory has to be buildable here.
 */
import { useState } from "react";
import { api } from "../../../api/client";
import type { McpServer, McpTool } from "../../../api/adminTypes";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, IdChip, Input, Select, Table } from "../../../ui/kit";
import {
  optionEls,
  serverOpts,
  useAction,
  useServerTools,
  useServers,
  useUsers,
  userOpts,
} from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

export default function McpServersPage() {
  const servers = useServers();
  const users = useUsers();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <>
      <PageHeader
        title="MCP servers"
        sub="Register the servers the governed MCP proxy fronts, build their tool inventory, and hand out tool-level allow-list grants — default-deny has nothing to govern until a server exists."
      />
      <div className={v.stack}>
        <Card title="Server registry">
          <RegisterServerForm />
          <Table<McpServer>
            columns={[
              { key: "name", header: "Name", sort: (s) => s.name, render: (s) => s.name },
              { key: "url", header: "URL", render: (s) => <span className={v.mono}>{s.url}</span> },
              { key: "id", header: "Proxy id", render: (s) => <IdChip id={s.id} /> },
            ]}
            rows={servers.data?.servers ?? []}
            rowKey={(s) => s.id}
            loading={servers.isLoading}
            onRowClick={(s) => setSelectedId(s.id === selectedId ? null : s.id)}
            rowLabel={(s) => `Show tools on ${s.name}`}
            empty={<EmptyState title="No servers registered" body="Register the first MCP server above." />}
          />
        </Card>

        {selectedId && (
          <ToolsCard
            key={selectedId}
            server={(servers.data?.servers ?? []).find((s) => s.id === selectedId)!}
          />
        )}

        <RegisterToolCard servers={servers.data?.servers ?? []} />

        <Card title="Tool-level allow-list grants">
          <ToolGrantForm users={users} servers={servers.data?.servers ?? []} />
          <hr className={v.divider} />
          <ServerGrantForm users={users} servers={servers.data?.servers ?? []} />
        </Card>
      </div>
    </>
  );
}

function RegisterServerForm() {
  const act = useAction();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  return (
    <form
      className={a.formRow}
      style={{ marginBottom: "var(--s2)" }}
      onSubmit={(e) => {
        e.preventDefault();
        void act
          .run(() => api.post("/v1/servers", { name, url }), "Server registered")
          .then((ok) => {
            if (ok) {
              setName("");
              setUrl("");
            }
          });
      }}
    >
      <Field label="Name">
        <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. repo-tools" />
      </Field>
      <Field label="URL" grow>
        <Input required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.internal/repo" />
      </Field>
      <Button type="submit" variant="primary" disabled={act.busy}>
        Register
      </Button>
      {act.error && (
        <span className={v.errLine} role="alert">
          {act.error}
        </span>
      )}
    </form>
  );
}

function ToolsCard(props: { server: McpServer }) {
  const tools = useServerTools(props.server.id);
  return (
    <Card title={`Tools on ${props.server.name}`}>
      <Table<McpTool>
        columns={[
          { key: "name", header: "Tool", sort: (t) => t.name, render: (t) => <span className={v.mono}>{t.name}</span> },
          {
            key: "kind",
            header: "Kind",
            sort: (t) => t.kind,
            render: (t) => <Badge tone={t.kind === "write" ? "warn" : "info"}>{t.kind}</Badge>,
          },
          { key: "description", header: "Description", render: (t) => t.description ?? "—" },
        ]}
        rows={tools.data?.tools ?? []}
        rowKey={(t) => t.name}
        loading={tools.isLoading}
        empty={
          <EmptyState
            title="No tools registered on this server"
            body="Register them below, or let the proxy auto-discover them on first use."
          />
        }
      />
    </Card>
  );
}

function RegisterToolCard(props: { servers: McpServer[] }) {
  const act = useAction();
  const [serverId, setServerId] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState("read");
  const [description, setDescription] = useState("");
  return (
    <Card title="Tool inventory">
      <form
        className={a.formRow}
        onSubmit={(e) => {
          e.preventDefault();
          void act
            .run(
              () =>
                api.post(`/v1/servers/${serverId}/tools`, {
                  name,
                  kind,
                  ...(description ? { description } : {}),
                }),
              "Tool registered",
            )
            .then((ok) => {
              if (ok) {
                setName("");
                setDescription("");
              }
            });
        }}
      >
        <Field label="Server">
          <Select required value={serverId} onChange={(e) => setServerId(e.target.value)}>
            {optionEls(serverOpts(props.servers), "— select —")}
          </Select>
        </Field>
        <Field label="Tool name">
          <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. read_file" />
        </Field>
        <Field label="Kind">
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="read">read</option>
            <option value="write">write</option>
          </Select>
        </Field>
        <Field label="Description (optional)" grow>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Button type="submit" size="sm" disabled={act.busy}>
          Register tool
        </Button>
        {act.error && (
          <span className={v.errLine} role="alert">
            {act.error}
          </span>
        )}
      </form>
      <p className={v.faint}>
        Registered here, or auto-discovered on first proxy use. Pick a server in the registry above to list
        what it already has. The read/write kind is what server-wide read-only grants and compliance
        read_only mode key on.
      </p>
    </Card>
  );
}

function ToolGrantForm(props: { users: ReturnType<typeof useUsers>; servers: McpServer[] }) {
  const act = useAction();
  const [userId, setUserId] = useState("");
  const [serverId, setServerId] = useState("");
  const [toolName, setToolName] = useState("");
  const tools = useServerTools(serverId || null);
  return (
    <form
      className={a.formRow}
      onSubmit={(e) => {
        e.preventDefault();
        void act.run(() => api.post("/v1/grants/tools", { userId, serverId, toolName }), "Tool granted");
      }}
    >
      <Field label="User">
        <Select required value={userId} onChange={(e) => setUserId(e.target.value)}>
          {optionEls(userOpts(props.users.data?.users), "— select —")}
        </Select>
      </Field>
      <Field label="Server">
        <Select
          required
          value={serverId}
          onChange={(e) => {
            setServerId(e.target.value);
            setToolName("");
          }}
        >
          {optionEls(serverOpts(props.servers), "— select —")}
        </Select>
      </Field>
      <Field label="Tool">
        <Select required value={toolName} onChange={(e) => setToolName(e.target.value)}>
          {optionEls(
            (tools.data?.tools ?? []).map((t) => ({ v: t.name, l: t.name })),
            "— select —",
          )}
        </Select>
      </Field>
      <Button type="submit" size="sm" disabled={act.busy}>
        Grant tool
      </Button>
      {act.error && (
        <span className={v.errLine} role="alert">
          {act.error}
        </span>
      )}
    </form>
  );
}

function ServerGrantForm(props: { users: ReturnType<typeof useUsers>; servers: McpServer[] }) {
  const act = useAction();
  const [userId, setUserId] = useState("");
  const [serverId, setServerId] = useState("");
  const [readOnlyAll, setReadOnlyAll] = useState("true");
  return (
    <form
      className={a.formRow}
      onSubmit={(e) => {
        e.preventDefault();
        void act.run(
          () => api.post("/v1/grants/servers", { userId, serverId, readOnlyAll: readOnlyAll === "true" }),
          "Server granted",
        );
      }}
    >
      <Field label="User">
        <Select required value={userId} onChange={(e) => setUserId(e.target.value)}>
          {optionEls(userOpts(props.users.data?.users), "— select —")}
        </Select>
      </Field>
      <Field label="Server">
        <Select required value={serverId} onChange={(e) => setServerId(e.target.value)}>
          {optionEls(serverOpts(props.servers), "— select —")}
        </Select>
      </Field>
      <Field label="Read-only all">
        <Select value={readOnlyAll} onChange={(e) => setReadOnlyAll(e.target.value)}>
          <option value="true">true</option>
          <option value="false">false</option>
        </Select>
      </Field>
      <Button type="submit" size="sm" disabled={act.busy}>
        Grant server
      </Button>
      {act.error && (
        <span className={v.errLine} role="alert">
          {act.error}
        </span>
      )}
    </form>
  );
}
