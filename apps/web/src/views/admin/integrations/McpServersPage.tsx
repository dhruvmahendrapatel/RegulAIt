/**
 * MCP servers — the server registry, the tool inventory (registered here or
 * auto-discovered on first proxy use), per-tool call pricing, and the
 * tool-level / server-level allow-list grants. Every policy rule hard-references
 * a tool by name, so the inventory has to be buildable here.
 *
 * PRICING (O10, ADR-0027). The server carries a FLAT price per allowed call;
 * each inventory row may carry an override. Metering resolves TOOL-FIRST with
 * the server flat price as fallback, so the tool table names which state each
 * row is in — override / inherited / unpriced — and lets an admin set or clear
 * the override in place (PATCH …/tools/:toolName/price, audited server-side).
 * The server flat rate is read-only here: there is no API to set it (creation
 * takes name+url only), so it is shown rather than pretended to be editable.
 */
import { useState } from "react";
import { api } from "../../../api/client";
import type { McpServer, McpTool } from "../../../api/adminTypes";
import { fmtUsd } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, IdChip, Input, Select, Table } from "../../../ui/kit";
import {
  RemoveButton,
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

/** One row of `GET /v1/users/:userId/servers/:serverId/entitlements`. */
interface McpEntitlementRow {
  /** a named tool, or the server-wide read-all grant which names none */
  kind: "tool" | "server-read-only";
  toolName: string | null;
  source: "direct" | "role";
  role?: string | null;
  grantId: string;
  revoked?: boolean;
}

export default function McpServersPage() {
  const servers = useServers();
  const users = useUsers();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <>
      <PageHeader
        title="MCP servers"
        sub="The servers the governed MCP proxy fronts, and their tool inventory."
        info={<p>Register the servers the governed MCP proxy fronts, build their tool inventory (with per-tool call pricing), and hand out tool-level allow-list grants — default-deny has nothing to govern until a server exists.</p>}
      />
      <div className={v.stack}>
        <Card title="Server registry">
          <RegisterServerForm />
          <Table<McpServer>
            columns={[
              { key: "name", header: "Name", sort: (s) => s.name, render: (s) => s.name },
              { key: "url", header: "URL", render: (s) => <span className={v.mono}>{s.url}</span> },
              {
                key: "flat",
                header: "Flat rate / call",
                sort: (s) => s.pricePerCallUsd ?? -1,
                render: (s) =>
                  s.pricePerCallUsd == null ? (
                    <span className={v.dim} title="unpriced — tools here meter at a null cost unless they carry a per-tool override">
                      unpriced
                    </span>
                  ) : (
                    <span className={v.mono}>{fmtUsd(s.pricePerCallUsd)}</span>
                  ),
              },
              {
                key: "privateRanges",
                header: "Private ranges",
                render: (s) => <PrivateRangesCell key={s.id} server={s} />,
              },
              { key: "id", header: "Proxy id", render: (s) => <IdChip id={s.id} /> },
            ]}
            rows={servers.data?.servers ?? []}
            rowKey={(s) => s.id}
            loading={servers.isLoading}
            error={servers.error}
            onRetry={() => void servers.refetch()}
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

        <McpEntitlementCard users={users} servers={servers.data?.servers ?? []} />
      </div>
    </>
  );
}

/**
 * WHAT IS THIS USER ACTUALLY ALLOWED ON THIS SERVER?
 *
 * Per-user, tool-level allow-listing is the product's headline capability, and
 * until this card there was no screen that answered that question. Tools could
 * be granted one at a time, from the form above, and the resulting set was
 * visible nowhere — not to check, not to correct. `GET /v1/users/:userId/
 * servers/:serverId/entitlements` had existed and served exactly this, with
 * `source` and `grantId` on every row, and no view had ever called it.
 *
 * A grant you cannot enumerate is a grant you cannot audit, and an allow-list
 * nobody can read is not much of an allow-list.
 */
function McpEntitlementCard(props: { users: ReturnType<typeof useUsers>; servers: McpServer[] }) {
  const act = useAction();
  const [userId, setUserId] = useState("");
  const [serverId, setServerId] = useState("");
  const [rows, setRows] = useState<McpEntitlementRow[] | null>(null);

  const load = () =>
    act.run(async () => {
      const r = await api.get<{ entitlements: McpEntitlementRow[] }>(
        `/v1/users/${userId}/servers/${serverId}/entitlements`,
      );
      setRows(r.entitlements);
    }, null);

  return (
    <Card title="Per-user entitlement">
      <form
        className={a.formRow}
        onSubmit={(e) => {
          e.preventDefault();
          void load();
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
        <Button type="submit" size="sm" disabled={act.busy}>
          View
        </Button>
      </form>
      {act.error && (
        <div className={v.errLine} role="alert">
          {act.error}
        </div>
      )}
      {rows && (
        <Table
          columns={[
            {
              key: "tool",
              header: "Grants",
              // A server-read-only grant has no toolName: it is every READ tool
              // on the server, present and future. Rendering it as "—" would
              // make the broadest grant on the page look like the emptiest row.
              render: (r: McpEntitlementRow) =>
                r.toolName ?? <em>every read tool on this server</em>,
            },
            {
              key: "source",
              header: "Via",
              render: (r) =>
                r.source === "role" ? (
                  <Badge tone="info">role{r.role ? `: ${r.role}` : ""}</Badge>
                ) : (
                  <Badge tone="ok">direct</Badge>
                ),
            },
            {
              key: "revoked",
              header: "",
              render: (r) => (r.revoked ? <Badge tone="danger">revoked</Badge> : null),
            },
            {
              key: "actions",
              header: "",
              align: "right",
              render: (r) => (
                <RemoveButton
                  what={`${r.toolName ?? "the server-wide read grant"} from this user`}
                  disabledReason={
                    r.source === "role"
                      ? `granted by role ${r.role ?? ""} — remove it there, or revoke it for this user alone on the Users page`
                      : undefined
                  }
                  consequence={
                    <p>
                      The direct grant is deleted. The next call this user makes to{" "}
                      <strong>{r.toolName ?? "any read tool on this server"}</strong> is refused by
                      default-deny, and the tool stops appearing in their <code>tools/list</code> —
                      discovery is entitlement-filtered, so it disappears rather than failing on
                      use. Nothing already audited changes.
                    </p>
                  }
                  onRemove={() =>
                    api.del(
                      r.kind === "server-read-only"
                        ? `/v1/grants/servers/${r.grantId}`
                        : `/v1/grants/tools/${r.grantId}`,
                    )
                  }
                  onDone={() => void load()}
                />
              ),
            },
          ]}
          rows={rows}
          rowKey={(r) => r.grantId}
          empty={
            <EmptyState
              title="Nothing granted on this server"
              body="Default-deny: with no grant, every tool on this server is refused for this user and none of them appear in their tools/list."
            />
          }
        />
      )}
      <p className={v.faint}>
        This is the effective allow-list the MCP proxy enforces, including grants that arrive
        through a role. A role-granted row cannot be deleted here — it is not this user's grant —
        so the row says where it comes from instead of offering a control that would fail.
      </p>
    </Card>
  );
}

/** ADR-0043: the per-server private-range flag as the SPA offers it — the
 * tri-state maps to boolean|null on the wire (null = inherit the org default,
 * mcpPrivateRangesDefault). */
const PRIVATE_RANGE_OPTS = (
  <>
    <option value="inherit">inherit org default</option>
    <option value="true">allow private ranges</option>
    <option value="false">deny private ranges</option>
  </>
);
const privateRangeValue = (s: string): boolean | null => (s === "inherit" ? null : s === "true");

function RegisterServerForm() {
  const act = useAction();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [privateRanges, setPrivateRanges] = useState("inherit");
  return (
    <form
      className={a.formRow}
      style={{ marginBottom: "var(--s2)" }}
      onSubmit={(e) => {
        e.preventDefault();
        void act
          .run(
            () =>
              api.post("/v1/servers", {
                name,
                url,
                allowPrivateRanges: privateRangeValue(privateRanges),
              }),
            "Server registered",
          )
          .then((ok) => {
            if (ok) {
              setName("");
              setUrl("");
              setPrivateRanges("inherit");
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
      <Field label="Private ranges (ADR-0043)">
        <Select
          value={privateRanges}
          onChange={(e) => setPrivateRanges(e.target.value)}
          title="May this server's URL resolve into private LAN space (RFC1918 / loopback)? 'inherit' follows the org default. Link-local / instance metadata is never opened; a public-internet URL always needs an egress allow entry."
        >
          {PRIVATE_RANGE_OPTS}
        </Select>
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

/** ADR-0043: edit one server's private-range posture in place — the PATCH
 * re-runs the write-time egress check server-side, so an edit that would make
 * the stored URL unreachable is an honest 400 here, not a surprise at the next
 * tool call. */
function PrivateRangesCell(props: { server: McpServer }) {
  const act = useAction();
  const stored =
    props.server.allowPrivateRanges == null ? "inherit" : String(props.server.allowPrivateRanges);
  const [value, setValue] = useState(stored);
  return (
    <form
      className={v.row}
      // the registry rows are clickable (they toggle the tools card) — editing
      // the posture must not also toggle the row (the IdChip precedent)
      onClick={(e) => e.stopPropagation()}
      onSubmit={(e) => {
        e.preventDefault();
        void act.run(
          () =>
            api.patch(`/v1/servers/${props.server.id}`, {
              allowPrivateRanges: privateRangeValue(value),
            }),
          `Private-range posture for ${props.server.name} saved`,
        );
      }}
    >
      <Select
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label={`Private-range posture for ${props.server.name}`}
      >
        {PRIVATE_RANGE_OPTS}
      </Select>
      <Button type="submit" size="sm" disabled={act.busy || value === stored}>
        Save
      </Button>
      {act.error && (
        <span className={v.errLine} role="alert">
          {act.error}
        </span>
      )}
    </form>
  );
}

/**
 * The tool inventory for one server, with O10 (ADR-0027) per-tool pricing.
 *
 * Resolution at the single metering site in `executeGovernedToolCall` is
 * TOOL-FIRST with the server's flat price as the fallback, so this table shows
 * both halves per row: whether the tool OVERRIDES, or INHERITS the server rate,
 * or is unpriced everywhere (an honest null cost — never invented). Saving
 * writes PATCH /v1/servers/:serverId/tools/:toolName/price
 * ({ pricePerCallUsd: number | null }); a blank field clears the override back
 * to the server's flat price. The write lands on the INVENTORY row, so a
 * manifest re-sync (kind/description only) can never clobber it.
 */
function ToolsCard(props: { server: McpServer }) {
  const tools = useServerTools(props.server.id);
  const flat = props.server.pricePerCallUsd ?? null;
  return (
    <Card title={`Tools on ${props.server.name}`}>
      <p className={v.faint} style={{ marginTop: 0 }}>
        Server flat rate:{" "}
        {flat == null ? (
          <strong>unpriced</strong>
        ) : (
          <strong>{fmtUsd(flat)} / call</strong>
        )}
        . A per-tool price <strong>overrides</strong> it for that tool only (tool-first, server-flat
        fallback); clearing the field restores inheritance. A tool with no override and no server rate
        stays unpriced — its calls are metered at a null cost rather than a guessed one.
      </p>
      <Table<McpTool>
        columns={[
          { key: "name", header: "Tool", sort: (t) => t.name, render: (t) => <span className={v.mono}>{t.name}</span> },
          {
            key: "kind",
            header: "Kind",
            sort: (t) => t.kind,
            render: (t) => <Badge tone={t.kind === "write" ? "warn" : "info"}>{t.kind}</Badge>,
          },
          {
            key: "pricing",
            header: "Price / call",
            sort: (t) => (t.pricePerCallUsd ?? flat ?? -1),
            render: (t) =>
              t.pricePerCallUsd != null ? (
                <Badge tone="primary" title="per-tool override — this price wins over the server flat rate">
                  {fmtUsd(t.pricePerCallUsd)} override
                </Badge>
              ) : flat != null ? (
                <Badge tone="neutral" title="no per-tool override — this tool inherits the server flat rate">
                  {fmtUsd(flat)} inherited
                </Badge>
              ) : (
                <span className={v.dim} title="no per-tool override and no server flat rate — calls meter at a null cost">
                  unpriced
                </span>
              ),
          },
          {
            key: "setPrice",
            header: "Set price",
            render: (t) => <ToolPriceCell serverId={props.server.id} tool={t} />,
          },
          { key: "description", header: "Description", render: (t) => t.description ?? "—" },
        ]}
        rows={tools.data?.tools ?? []}
        rowKey={(t) => t.name}
        loading={tools.isLoading}
        error={tools.error}
        onRetry={() => void tools.refetch()}
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

/** one row's price editor: blank = clear the override (inherit again). */
function ToolPriceCell(props: { serverId: string; tool: McpTool }) {
  const act = useAction();
  const [value, setValue] = useState(
    props.tool.pricePerCallUsd == null ? "" : String(props.tool.pricePerCallUsd),
  );
  const dirty = value !== (props.tool.pricePerCallUsd == null ? "" : String(props.tool.pricePerCallUsd));
  return (
    <form
      className={v.row}
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = value.trim();
        void act.run(
          () =>
            api.patch(
              `/v1/servers/${props.serverId}/tools/${encodeURIComponent(props.tool.name)}/price`,
              { pricePerCallUsd: trimmed === "" ? null : Number(trimmed) },
            ),
          trimmed === ""
            ? `Override cleared for ${props.tool.name} — the server flat rate applies again`
            : `Price for ${props.tool.name} set to ${fmtUsd(Number(trimmed))} / call`,
        );
      }}
    >
      <Input
        type="number"
        step="0.0001"
        min="0"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="inherit"
        aria-label={`Price per call for ${props.tool.name}`}
        style={{ width: "8.5rem" }}
      />
      <Button type="submit" size="sm" disabled={act.busy || !dirty}>
        Save
      </Button>
      {act.error && (
        <span className={v.errLine} role="alert">
          {act.error}
        </span>
      )}
    </form>
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
  return (
    <form
      className={a.formRow}
      onSubmit={(e) => {
        e.preventDefault();
        void act.run(
          // readOnlyAll is always true: a server grant IS a read-all grant, and
          // the gateway refuses `false` rather than store a grant that grants
          // nothing. Scope below read-all is expressed with tool grants.
          () => api.post("/v1/grants/servers", { userId, serverId, readOnlyAll: true }),
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
      <span className={v.hint}>
        Grants every <strong>read</strong> tool on the server. Write tools still need an individual
        tool grant.
      </span>
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
