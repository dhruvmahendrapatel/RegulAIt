/**
 * Governed MCP bundles (#453): a named, versioned set of exact MCP tools an admin grants to a user, a role or a team
 * as one unit. The list and a new-bundle form at `mcp-servers/bundles`, one bundle (its tools, its immutable version
 * history and who holds it) at `mcp-servers/bundles/:bundleId`. The gateway is authoritative: adding a tool, naming an
 * approver and clearing a tool's dangerous flag each ask for a step-up there, and every write is audited.
 */
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../../../api/client";
import { fmtAt, plural } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { Badge, Button, Card, ConfirmModal, EmptyState, Field, IdChip, Input, RowActions, Select, Table, type Tone } from "../../../ui/kit";
import { SubpageTrail } from "../../../ui/ListPreview";
import { optionEls, QueryGate, roleOpts, serverOpts, teamOpts, useAction, useRoles, useServers, useServerTools, useTeams, useUsers, userOpts } from "../adminKit";
import { OrgSettingsCard } from "../settings/OrgSettingsCard";
import {
  MAX_ITEMS,
  REFUSAL_HINT,
  TIERS,
  diffItems,
  grantBody,
  holderOf,
  itemKey,
  refusalCode,
  tierLabel,
  toggleItem,
  type BundleDetail,
  type BundleGrant,
  type BundleItem,
  type BundleList,
  type BundleVersion,
  type InventoryTool,
  type SubjectKind,
  type Tier,
} from "./mcpBundlesModel";
import a from "../admin.module.css";
import v from "../../views.module.css";

const LIST = "/admin/mcp-servers/bundles";
const KEY = ["admin", "mcp-bundles"] as const;
const KIND: Record<SubjectKind, string> = { user: "Person", role: "Role", team: "Team" };
const TIER_TONE: Record<Tier, Tone> = { read: "info", write: "warn", dangerous: "danger" };
type Names = ReturnType<typeof useNames>;

/** useAction plus the refusal code of the last failure, for the next step shown beside it */
function useCodedAction() {
  const act = useAction();
  const [code, setCode] = useState<string | null>(null);
  const run = (fn: () => Promise<unknown>, ok: string) => {
    setCode(null);
    return act.run(() => fn().catch((e: unknown) => (setCode(refusalCode(e)), Promise.reject(e))), ok);
  };
  return { ...act, code, run };
}

function Refused(props: { act: { error: string | null; code?: string | null }; children?: ReactNode }) {
  if (!props.act.error) return null;
  return (
    <div className={v.errLine} role="alert">
      {props.act.error} {props.act.code && REFUSAL_HINT[props.act.code]}
      {props.children}
    </div>
  );
}

function useNames() {
  const users = useUsers();
  const servers = useServers();
  const user = (id: string | null) => {
    const u = users.data?.users.find((x) => x.id === id);
    return u ? u.displayName || u.email : id ? <IdChip id={id} /> : "Not recorded";
  };
  const server = (id: string, fallback?: string | null) => servers.data?.servers.find((s) => s.id === id)?.name ?? fallback ?? id;
  return { users, servers, user, server };
}

function Confirm(props: { label: string; title: string; body: string; onConfirm: () => Promise<unknown> }) {
  const act = useAction();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="ghost" aria-label={props.title.slice(0, -1)} disabled={act.busy} onClick={() => setOpen(true)}>
        {props.label}
      </Button>
      <Refused act={act} />
      <ConfirmModal
        open={open}
        danger
        title={props.title}
        confirmLabel={props.label}
        body={<p>{props.body}</p>}
        onCancel={() => setOpen(false)}
        onConfirm={() => void act.run(props.onConfirm, `${props.label}d`) /* "Archived", "Revoked" */.then(() => setOpen(false))}
      />
    </>
  );
}

// ---- the list ----------------------------------------------------------------

export function McpBundlesPage() {
  const list = useQuery({ queryKey: KEY, queryFn: () => api.get<BundleList>("/v1/mcp-bundles") });
  return (
    <>
      <SubpageTrail parent="MCP servers" parentTo="/admin/mcp-servers" current="MCP bundles" />
      <PageHeader title="MCP bundles" sub="Exact tools granted to a person, role or team as one unit." />
      <div className={v.stack}>
        <QueryGate loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}>
          {list.data && !list.data.enabled && (
            <p role="note" className={v.errLine} data-testid="bundles-off">
              MCP bundles are off: nothing can be created or granted, and no bundle grant gives a tool.
            </p>
          )}
          <Card title="Bundles">
            <Table
              columns={[
                { key: "name", header: "Name", sort: (b) => b.name, render: (b) => <Link to={`${LIST}/${b.id}`}>{b.name}</Link> },
                { key: "description", header: "Description", render: (b) => b.description ?? "None" },
                { key: "version", header: "Version", render: (b) => b.currentVersion },
                { key: "holders", header: "Held by", render: (b) => plural(b.grantCount ?? 0, "grant") },
                { key: "state", header: "State", render: (b) => <State at={b.archivedAt} /> },
                { key: "updated", header: "Last changed", render: (b) => fmtAt(b.updatedAt) },
              ]}
              rows={list.data?.bundles}
              rowKey={(b) => b.id}
              empty={<EmptyState title="No bundles yet" />}
            />
          </Card>
          {list.data?.enabled && <NewBundleCard />}
        </QueryGate>
        <OrgSettingsCard title="MCP bundles setting" keys={["mcpBundlesEnabled"]} testId="mcp-bundles-setting" />
      </div>
    </>
  );
}

const State = (p: { at: string | null }) => (p.at ? <Badge>Archived {fmtAt(p.at)}</Badge> : <Badge tone="ok">Active</Badge>);

function NewBundleCard() {
  const act = useCodedAction();
  const nav = useNavigate();
  const names = useNames();
  const [name, setName] = useState("");
  const [approver, setApprover] = useState("");
  const [items, setItems] = useState<BundleItem[]>([]);
  return (
    <Card title="New bundle">
      <form
        aria-label="New bundle"
        className={v.stack}
        onSubmit={(e) => {
          e.preventDefault();
          let id = "";
          void act
            .run(async () => {
              id = (await api.post<{ id: string }>("/v1/mcp-bundles", { name, approverUserId: approver || null, items })).id;
            }, `Bundle ${name} created; nobody holds it yet`)
            .then((ok) => ok && nav(`${LIST}/${id}`));
        }}
     >
        <div className={a.formRow}>
          <Field label="Name" help="Lower-case letters, digits and hyphens.">
            <Input required pattern="[a-z0-9][a-z0-9\-]{0,62}" value={name} onChange={(e) => setName(e.target.value)} placeholder="for example repo-readers" />
          </Field>
          <ApproverField value={approver} onChange={setApprover} names={names} />
        </div>
        <ToolPicker items={items} onChange={setItems} names={names} />
        <div className={v.row}>
          <Button type="submit" variant="primary" disabled={act.busy}>
            Create bundle
          </Button>
          <Refused act={act} />
        </div>
      </form>
    </Card>
  );
}

function ApproverField(props: { value: string; onChange: (v: string) => void; names: Names }) {
  return (
    <Field label="Approver for dangerous tools" help="Each dangerous tool call through this bundle waits for this person.">
      <Select value={props.value} onChange={(e) => props.onChange(e.target.value)}>
        {optionEls(userOpts(props.names.users.data?.users), "No approver")}
      </Select>
    </Field>
  );
}

/** pick exact tools from the inventory, a server at a time; a tool's dangerous flag is set or cleared here too */
function ToolPicker(props: { items: BundleItem[]; onChange: (items: BundleItem[]) => void; names: Names }) {
  const [serverId, setServerId] = useState("");
  const tools = useServerTools(serverId || null);
  const has = new Set(props.items.map(itemKey));
  return (
    <>
      <Field label="Add tools from server">
        <Select value={serverId} onChange={(e) => setServerId(e.target.value)}>
          {optionEls(serverOpts(props.names.servers.data?.servers), "— select —")}
        </Select>
      </Field>
      {serverId && (
        <Table<InventoryTool>
          columns={[
            {
              key: "pick",
              header: "In bundle",
              render: (t) => {
                const item = { serverId, toolName: t.name };
                const on = has.has(itemKey(item));
                return (
                  <input
                    type="checkbox"
                    aria-label={`Include ${t.name}`}
                    checked={on}
                    disabled={!on && props.items.length >= MAX_ITEMS}
                    onChange={() => props.onChange(toggleItem(props.items, item))}
                  />
                );
              },
            },
            { key: "name", header: "Tool", render: (t) => <span className={v.mono}>{t.name}</span> },
            { key: "tier", header: "Scope tier", render: (t) => <DangerCell tool={t} /> },
          ]}
          rows={tools.data?.tools as InventoryTool[] | undefined}
          rowKey={(t) => t.name}
          loading={tools.isLoading}
          error={tools.error}
          onRetry={() => void tools.refetch()}
          empty={<EmptyState title="No tools on this server" />}
        />
      )}
      <ItemsTable items={props.items} names={props.names} onRemove={(i) => props.onChange(toggleItem(props.items, i))} />
      <p className={v.hint}>
        {plural(props.items.length, "tool")} chosen, at most {MAX_ITEMS}.
      </p>
    </>
  );
}

function DangerCell(props: { tool: InventoryTool }) {
  const act = useAction();
  const d = Boolean(props.tool.dangerous);
  return (
    <span className={v.row}>
      {d ? (
        <Badge tone="danger" info="Needs a dangerous grant; each call waits for the approver." infoLabel={`dangerous: ${props.tool.name}`}>
          Dangerous
        </Badge>
      ) : (
        "Standard"
      )}
      <Button
        size="sm"
        variant="ghost"
        type="button"
        disabled={act.busy}
        aria-label={`${d ? "Clear dangerous flag" : "Flag dangerous"}: ${props.tool.name}`}
        // flagging tightens; clearing relaxes, so the gateway asks for a step-up
        onClick={() => void act.run(() => withStepUp((h) => stepUpApi.put(`/v1/mcp-tools/${props.tool.id}/dangerous`, { dangerous: !d }, h)), `${props.tool.name} saved`)}
     >
        {d ? "Clear flag" : "Flag dangerous"}
      </Button>
      <Refused act={act} />
    </span>
  );
}

function ItemsTable(props: { items: Array<BundleItem & { serverName?: string | null }>; names: Names; onRemove?: (i: BundleItem) => void }) {
  const rm = props.onRemove;
  return (
    <Table
      columns={[
        { key: "server", header: "Server", render: (i) => props.names.server(i.serverId, i.serverName) },
        { key: "tool", header: "Tool", render: (i) => <span className={v.mono}>{i.toolName}</span> },
        {
          key: "actions",
          header: "",
          srHeader: "Actions",
          render: (i) =>
            rm && (
              <Button size="sm" variant="ghost" type="button" aria-label={`Take out ${i.toolName}`} onClick={() => rm(i)}>
                Take out
              </Button>
            ),
        },
      ]}
      rows={props.items}
      rowKey={itemKey}
      empty={<EmptyState title="No tools" />}
    />
  );
}

// ---- one bundle ----------------------------------------------------------------

export function McpBundlePage() {
  const id = useParams().bundleId ?? "";
  const q = useQuery({ queryKey: [...KEY, id], queryFn: () => api.get<BundleDetail>(`/v1/mcp-bundles/${id}`) });
  const names = useNames();
  const [viewing, setViewing] = useState<number | null>(null);
  const b = q.data;
  return (
    <>
      <SubpageTrail parent="MCP bundles" parentTo={LIST} current={b?.name ?? "Bundle"} />
      <PageHeader
        title={b ? `Bundle: ${b.name}` : "Bundle"}
        actions={
          b &&
          !b.archivedAt && (
            <Confirm
              label="Archive"
              title={`Archive bundle ${b.name}?`}
              body="Every grant of it confers nothing from then on. This cannot be undone."
              onConfirm={() => api.del(`/v1/mcp-bundles/${id}`)}
            />
          )
        }
      />
      <div className={v.stack}>
        <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
          {b && (
            <>
              <DetailsCard key={b.updatedAt} b={b} names={names} />
              <ToolsCard key={b.currentVersion} b={b} names={names} onReload={() => void q.refetch()} />
              <Card title="Version history">
                <Table
                  columns={[
                    { key: "version", header: "Version", render: (r) => (r.version === b.currentVersion ? `${r.version} (current)` : r.version) },
                    { key: "by", header: "Saved by", render: (r) => names.user(r.createdBy) },
                    { key: "at", header: "Saved", render: (r) => fmtAt(r.createdAt) },
                    { key: "actions", header: "", srHeader: "Actions", render: (r) => <RowActions primary={<Button size="sm" aria-label={`View version ${r.version}`} onClick={() => setViewing(r.version)}>View</Button>} /> },
                  ]}
                  rows={b.versions}
                  rowKey={(r) => String(r.version)}
                />
                {viewing != null && <VersionView id={id} n={viewing} names={names} />}
              </Card>
              <GrantsCard b={b} names={names} />
            </>
          )}
        </QueryGate>
      </div>
    </>
  );
}

function DetailsCard(props: { b: BundleDetail; names: Names }) {
  const act = useCodedAction();
  const [description, setDescription] = useState(props.b.description ?? "");
  const [approver, setApprover] = useState(props.b.approverUserId ?? "");
  return (
    <Card title="Details">
      <p className={v.row}>
        <State at={props.b.archivedAt} />
        <span>
          Version {props.b.currentVersion}, created {fmtAt(props.b.createdAt)}
        </span>
        <Badge tone="info" info="Every change is on the audit log.">
          Audited
        </Badge>
      </p>
      <form
        aria-label="Bundle details"
        className={a.formRow}
        onSubmit={(e) => {
          e.preventDefault();
          // naming a different approver relaxes the bundle: the gateway asks for a step-up
          void act.run(
            () => withStepUp((h) => stepUpApi.patch(`/v1/mcp-bundles/${props.b.id}`, { description: description || null, approverUserId: approver || null }, h)),
            "Bundle details saved",
          );
        }}
     >
        <Field label="Description" grow>
          <Input maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <ApproverField value={approver} onChange={setApprover} names={props.names} />
        <Button type="submit" size="sm" disabled={act.busy || !!props.b.archivedAt}>
          Save details
        </Button>
        <Refused act={act} />
      </form>
    </Card>
  );
}

function ToolsCard(props: { b: BundleDetail; names: Names; onReload: () => void }) {
  const act = useCodedAction();
  const [draft, setDraft] = useState<BundleItem[] | null>(null);
  const { b } = props;
  const d = diffItems(b.items, draft ?? b.items);
  const next = b.currentVersion + 1;
  return (
    <Card
      title={`Tools in version ${b.currentVersion}`}
      actions={!draft && !b.archivedAt && <Button size="sm" onClick={() => setDraft(b.items.map(({ serverId, toolName }) => ({ serverId, toolName })))}>Change tools</Button>}
   >
      {draft ? (
        <form
          aria-label="Change tools"
          className={v.stack}
          onSubmit={(e) => {
            e.preventDefault();
            void act.run(
              () => withStepUp((h) => stepUpApi.put(`/v1/mcp-bundles/${b.id}/items`, { expectedVersion: b.currentVersion, items: draft }, h)),
              `Version ${next} saved`,
            );
          }}
       >
          <ToolPicker items={draft} onChange={setDraft} names={props.names} />
          <p className={v.hint} data-testid="bundle-diff">
            Version {next}, for every holder: {d.added} added, {d.removed} removed.
            {d.added > 0 && " Adding asks for a step-up."}
          </p>
          <div className={v.row}>
            <Button type="submit" variant="primary" disabled={act.busy || d.added + d.removed === 0}>
              Save version {next}
            </Button>
            <Button type="button" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Refused act={act}>
              {act.code === "version_conflict" && (
                <Button size="sm" type="button" onClick={props.onReload}>
                  Reload the bundle
                </Button>
              )}
            </Refused>
          </div>
        </form>
      ) : (
        <ItemsTable items={b.items} names={props.names} />
      )}
    </Card>
  );
}

function VersionView(props: { id: string; n: number; names: Names }) {
  const q = useQuery({ queryKey: [...KEY, props.id, "v", props.n], queryFn: () => api.get<BundleVersion>(`/v1/mcp-bundles/${props.id}/versions/${props.n}`) });
  return (
    <section aria-label={`Version ${props.n}`}>
      <h3>Version {props.n} (never changes)</h3>
      <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
        <ItemsTable items={q.data?.items ?? []} names={props.names} />
      </QueryGate>
    </section>
  );
}

function GrantsCard(props: { b: BundleDetail; names: Names }) {
  const id = props.b.id;
  const grants = useQuery({ queryKey: [...KEY, id, "grants"], queryFn: () => api.get<{ grants: BundleGrant[] }>(`/v1/mcp-bundles/${id}/grants`) });
  const roles = useRoles();
  const teams = useTeams();
  const act = useCodedAction();
  const [kind, setKind] = useState<SubjectKind>("user");
  const [subject, setSubject] = useState("");
  // read is the default and the narrowest; never preselect a wider tier
  const [tier, setTier] = useState<Tier>("read");
  const opts = kind === "user" ? userOpts(props.names.users.data?.users) : kind === "role" ? roleOpts(roles.data?.roles) : teamOpts(teams.data?.teams);
  return (
    <Card title="Held by" info={<p>Each person's own revocations still apply.</p>}>
      {!props.b.archivedAt && (
        <form
          aria-label="Grant this bundle"
          className={a.formRow}
          onSubmit={(e) => {
            e.preventDefault();
            void act.run(() => api.post(`/v1/mcp-bundles/${id}/grants`, grantBody(kind, subject, tier)), "Bundle granted").then((ok) => ok && setSubject(""));
          }}
       >
          <Field label="Grant to">
            <Select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as SubjectKind);
                setSubject("");
              }}
           >
              {optionEls(Object.entries(KIND).map(([k, l]) => ({ v: k, l })))}
            </Select>
          </Field>
          <Field label={KIND[kind]}>
            <Select required value={subject} onChange={(e) => setSubject(e.target.value)}>
              {optionEls(opts, "— select —")}
            </Select>
          </Field>
          <Field label="Up to">
            <Select value={tier} onChange={(e) => setTier(e.target.value as Tier)}>
              {optionEls([...TIERS])}
            </Select>
          </Field>
          <Button type="submit" size="sm" disabled={act.busy}>
            Grant
          </Button>
          <Refused act={act} />
        </form>
      )}
      <Table
        columns={[
          { key: "holder", header: "Holder", render: (g) => `${holderOf(g).label} (${KIND[holderOf(g).kind].toLowerCase()})` },
          { key: "tier", header: "Up to", render: (g) => <Badge tone={TIER_TONE[g.maxTier]}>{tierLabel(g.maxTier)}</Badge> },
          { key: "by", header: "Granted by", render: (g) => props.names.user(g.grantedBy) },
          { key: "at", header: "Granted", render: (g) => fmtAt(g.createdAt) },
          {
            key: "actions",
            header: "",
            srHeader: "Actions",
            render: (g) => (
              <RowActions
                primary={
                  <Confirm
                    label="Revoke"
                    title={`Revoke ${holderOf(g).label}'s grant of ${props.b.name}?`}
                    body={`${holderOf(g).label} loses these tools from their next call, unless another grant gives them.`}
                    onConfirm={() => api.del(`/v1/mcp-bundles/${id}/grants/${g.id}`)}
                  />
                }
              />
            ),
          },
        ]}
        rows={grants.data?.grants}
        rowKey={(g) => g.id}
        loading={grants.isLoading}
        error={grants.error}
        onRetry={() => void grants.refetch()}
        empty={<EmptyState title="Nobody holds this bundle" />}
      />
    </Card>
  );
}
