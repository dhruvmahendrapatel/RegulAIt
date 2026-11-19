/**
 * D1 (ADR-0337 §6, lane E18; owner-approved on #453): the apps one SaaS entitlement source holds and the registered
 * agent each belongs to, at `/admin/shadow-ai/discovery-sources/apps?source=<id>`, reached from the source's row on
 * Discovery sources. An app whose vendor id exactly equals an identifier declared for an agent is linked
 * automatically; an admin links a near match by hand, or unlinks one, and an unlinked app is never linked
 * automatically again. Only the transitions the gateway's declared machine says are allowed next are offered. The
 * declared identifiers are listed, declared and removed below; removing one keeps the links it made. Every change is
 * audited by the gateway. Admin-only like the parent page. Lazy: its own chunk, loaded only when opened.
 */
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { fmtDateTime, humanize } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, ConfirmModal, EmptyState, ErrorState, Field, Input, Modal, RowActions, Select, SkeletonBlock, Table } from "../../../ui/kit";
import { Stat, useAction, useAgents } from "../adminKit";
import type { AdminAgent } from "../../../api/adminTypes";
import { Crumbs } from "./DiscoveryListPages";
import type { DiscoverySourceView } from "./discoverySourcesModel";
import {
  appName,
  appsUrl,
  canDo,
  entitlementPlatformOf,
  identifiersUrl,
  IDENTIFIER_PATTERN,
  LINK_STATE_LABEL,
  LINK_STATE_TONE,
  linkCounts,
  SAAS_PLATFORM_LABEL,
  SAAS_PLATFORMS,
  type AgentIdentifierView,
  type AgentIdentifiersPage,
  type AgentLinkState,
  type DeclaredIdentifier,
  type EntitlementAppsPage,
  type EntitlementAppView,
  type SaasPlatform,
} from "./discoverySubpagesModel";
import a from "../admin.module.css";
import v from "../../views.module.css";

const linkable = (ag: AdminAgent) => ag.lifecycleStatus !== "retired";

export default function SaasAppLinksPage() {
  const [params, setParams] = useSearchParams();
  const sources = useQuery({
    queryKey: ["admin", "discovery", "sources"],
    queryFn: () => api.get<{ sources: DiscoverySourceView[] }>("/v1/discovery/sources"),
  });
  const entitlementSources = (sources.data?.sources ?? []).filter((s) => entitlementPlatformOf(s.kind));
  const asked = params.get("source");
  const source = entitlementSources.find((s) => s.id === asked) ?? (entitlementSources.length === 1 ? entitlementSources[0]! : null);
  const title = source ? `Apps in ${source.name}` : "SaaS app links";

  return (
    <>
      <Crumbs here="Apps" mid={source?.name} />
      <PageHeader
        title={title}
        sub="Each app this source holds, and the registered agent it belongs to. An app whose id matches a declared agent app id is linked automatically. You can link a near match by hand, or unlink one. Every change is audited."
        info={
          <>
            A linked app counts as governed by its agent: the agent&apos;s risk score, owner and approvals apply to it. regulAIt never links a
            partial or fuzzy match on its own, and an app an admin unlinked is never linked automatically again. Nothing here changes anything at the
            vendor.
          </>
        }
        actions={<a href="#declared">Declared app ids</a>}
      />
      <div className={v.stack}>
        {sources.isPending ? (
          <Card>
            <SkeletonBlock lines={4} />
          </Card>
        ) : sources.isError ? (
          <ErrorState title="Couldn't load the discovery sources" message="The SaaS entitlement sources could not be read. No source is assumed." onRetry={() => void sources.refetch()} />
        ) : entitlementSources.length === 0 ? (
          <Card>
            <EmptyState title="No SaaS entitlement source" body="Add a SaaS app grants source on Discovery sources. Its apps appear here after its first scan." action={<Link to="/admin/shadow-ai/discovery-sources">Discovery sources</Link>} />
          </Card>
        ) : (
          <>
            {(entitlementSources.length > 1 || !source) && (
              <Card>
                <div className={a.formRow}>
                  <Field label="SaaS entitlement source">
                    <Select
                      value={source?.id ?? ""}
                      onChange={(e) =>
                        setParams((p) => {
                          const n = new URLSearchParams(p);
                          n.set("source", e.target.value);
                          return n;
                        }, { replace: true })
                      }
                    >
                      <option value="">Choose a source</option>
                      {entitlementSources.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
              </Card>
            )}
            {source ? (
              <SourceApps key={source.id} source={source} />
            ) : (
              <Card>
                <EmptyState title="Choose a source" body="Choose the SaaS entitlement source whose apps to list." />
              </Card>
            )}
          </>
        )}
        <DeclaredIdentifiers defaultPlatform={source ? entitlementPlatformOf(source.kind) : null} />
      </div>
    </>
  );
}

function SourceApps(props: { source: DiscoverySourceView }) {
  const act = useAction();
  const agents = useAgents();
  const agentList = agents.data?.agents ?? [];
  const agentName = (id: string | null) => (id ? (agentList.find((x) => x.id === id)?.name ?? id) : null);
  const list = useInfiniteQuery({
    queryKey: ["admin", "discovery", "entitlement-apps", props.source.id],
    queryFn: ({ pageParam }) => api.get<EntitlementAppsPage>(appsUrl(props.source.id, pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: (p) => p.nextAfter ?? undefined,
  });
  const all = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const [search, setSearch] = useState("");
  const [state, setState] = useState<"" | AgentLinkState>("");
  const term = search.trim().toLowerCase();
  const rows = all.filter(
    (r) => (!state || r.agentLinkState === state) && (!term || appName(r).toLowerCase().includes(term) || r.externalId.toLowerCase().includes(term)),
  );
  const c = linkCounts(all);
  const more = list.hasNextPage ? "+" : "";
  const [linking, setLinking] = useState<EntitlementAppView | null>(null);
  const [agentId, setAgentId] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState<EntitlementAppView | null>(null);

  const openLink = (r: EntitlementAppView) => {
    // never pre-selected: the admin names the agent (a moved link starts from the current one)
    setAgentId(r.agentLinkState === "admin" || r.agentLinkState === "auto" ? (r.agentId ?? "") : "");
    setLinkError(null);
    setLinking(r);
  };
  const link = async () => {
    if (!linking) return;
    if (!agentId) return setLinkError("Choose the agent to link it to.");
    const target = linking;
    const ok = await act.run(async () => {
      await api.put(`/v1/discovery/entitlements/apps/${target.id}/agent-link`, { agentId });
      return `Linked ${appName(target)} to ${agentName(agentId)}`;
    });
    if (ok) setLinking(null);
  };
  const unlink = () => {
    const target = unlinking;
    if (!target) return;
    setUnlinking(null);
    void act.run(async () => {
      await api.del(`/v1/discovery/entitlements/apps/${target.id}/agent-link`);
      return `Unlinked ${appName(target)}`;
    });
  };

  return (
    <>
      <div className={v.grid4}>
        <Stat value={`${c.total}${more}`} label="Apps in this source" />
        <Stat value={c.auto} label="Linked automatically" />
        <Stat value={c.admin} label="Linked by an admin" />
        <Stat
          value={c.none}
          label="No agent yet"
          info="Apps that hold grants in this tenant and belong to no registered agent. Link one to its agent by hand, or declare the agent's app id below so exact matches link automatically."
          infoLabel="About apps with no agent"
        />
      </div>
      <Card title="Apps">
        <div className={v.stack} data-testid="entitlement-apps">
          <div className={v.row}>
            <Field label="Search apps" grow>
              <Input type="search" value={search} placeholder="Name or app id" onChange={(e) => setSearch(e.target.value)} />
            </Field>
            <Field label="Link state">
              <Select value={state} onChange={(e) => setState(e.target.value as "" | AgentLinkState)}>
                <option value="">All</option>
                {(Object.keys(LINK_STATE_LABEL) as AgentLinkState[]).map((s) => (
                  <option key={s} value={s}>
                    {LINK_STATE_LABEL[s]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Table<EntitlementAppView>
            rows={list.isPending ? undefined : rows}
            rowKey={(r) => r.id}
            loading={list.isPending}
            error={list.error}
            onRetry={() => void list.refetch()}
            empty={
              all.length > 0 ? (
                <EmptyState title="No app matches" body="No app matches this search and link state. Choose All to see every app." />
              ) : (
                <EmptyState title="No app in this source yet" body="Apps appear here once the source has been scanned." />
              )
            }
            columns={[
              {
                key: "app",
                header: "App",
                render: (r) => (
                  <>
                    <strong>{appName(r)}</strong>
                    <div className={v.faint}>
                      {humanize(r.appKind)}
                      {r.publisher ? ` · ${r.publisher}${r.publisherVerified ? " (verified publisher)" : ""}` : ""}
                    </div>
                  </>
                ),
              },
              { key: "id", header: "App id", render: (r) => <span className={v.mono}>{r.externalId}</span> },
              {
                key: "grants",
                header: "Scopes granted",
                info: "How many permissions the app holds in this tenant, each one way (delegated or as itself).",
                infoLabel: "About scopes granted",
                render: (r) => r.grants,
              },
              { key: "agent", header: "Agent", render: (r) => (r.agentId ? agentName(r.agentId) : <span className={v.faint}>—</span>) },
              {
                key: "link",
                header: "Link",
                render: (r) => <Badge tone={LINK_STATE_TONE[r.agentLinkState]}>{LINK_STATE_LABEL[r.agentLinkState]}</Badge>,
              },
              {
                key: "actions",
                header: "",
                srHeader: "Actions",
                render: (r) => (
                  <RowActions
                    slot="8rem"
                    primary={
                      canDo(r, "link") ? (
                        <Button size="sm" variant={r.agentLinkState === "none" ? "primary" : undefined} disabled={act.busy} aria-label={`Link to agent, ${appName(r)}`} onClick={() => openLink(r)}>
                          {r.agentLinkState === "none" || r.agentLinkState === "unlinked" ? "Link to agent…" : "Move link…"}
                        </Button>
                      ) : null
                    }
                    secondary={
                      canDo(r, "unlink") ? (
                        <Button size="sm" disabled={act.busy} aria-label={`Unlink, ${appName(r)}`} onClick={() => setUnlinking(r)}>
                          Unlink
                        </Button>
                      ) : null
                    }
                  />
                ),
              },
            ]}
          />
          {list.hasNextPage && (
            <div>
              <Button disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {list.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
          <p className={v.faint}>
            {list.hasNextPage ? `Counts cover the ${all.length} apps loaded so far. ` : ""}An app an admin unlinked is never linked automatically again.
          </p>
          {act.error && !linking && (
            <div className={v.errLine} role="alert">
              {act.error}
            </div>
          )}
        </div>
      </Card>
      <Modal
        open={!!linking}
        title={`Link “${linking ? appName(linking) : ""}” to an agent`}
        onClose={() => setLinking(null)}
        actions={
          <>
            <Button onClick={() => setLinking(null)}>Cancel</Button>
            <Button variant="primary" disabled={act.busy} onClick={() => void link()}>
              Link app
            </Button>
          </>
        }
      >
        <div className={v.stack}>
          <p>Use this for a partial or near match. The app then counts as governed by that agent: its risk score, owner and approvals apply. The link is audited.</p>
          <Field label="Agent" error={linkError ?? act.error}>
            <Select value={agentId} disabled={agents.isPending} onChange={(e) => setAgentId(e.target.value)}>
              <option value="">{agents.isPending ? "Loading…" : agents.error ? "Could not read the agents" : "Choose an agent"}</option>
              {agentList.filter(linkable).map((ag) => (
                <option key={ag.id} value={ag.id}>
                  {ag.name}
                </option>
              ))}
            </Select>
          </Field>
          {linking && <p className={v.faint}>App id <span className={v.mono}>{linking.externalId}</span>. A retired agent cannot be linked.</p>}
        </div>
      </Modal>
      <ConfirmModal
        open={!!unlinking}
        danger
        title={`Unlink ${unlinking ? appName(unlinking) : ""}?`}
        confirmLabel="Unlink"
        onCancel={() => setUnlinking(null)}
        onConfirm={unlink}
        body={
          <p>
            It shows as unlinked by an admin and is not linked automatically again, even if its id matches a declared one. Only an admin can link it again. The
            unlink is audited.
          </p>
        }
      />
    </>
  );
}

function DeclaredIdentifiers(props: { defaultPlatform: SaasPlatform | null }) {
  const act = useAction();
  const agents = useAgents();
  const agentList = agents.data?.agents ?? [];
  const agentName = (id: string) => agentList.find((x) => x.id === id)?.name ?? id;
  const list = useInfiniteQuery({
    queryKey: ["admin", "discovery", "agent-identifiers"],
    queryFn: ({ pageParam }) => api.get<AgentIdentifiersPage>(identifiersUrl(pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: (p) => p.nextAfter ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items);
  const [agentId, setAgentId] = useState("");
  // "" until chosen: the page's source's platform is shown (it arrives after the first render)
  const [chosenPlatform, setPlatform] = useState<SaasPlatform | "">("");
  const platform = chosenPlatform || props.defaultPlatform || "";
  const [externalId, setExternalId] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<AgentIdentifierView | null>(null);

  const declare = async () => {
    const id = externalId.trim();
    if (!agentId) return setFormError("Choose the agent.");
    if (!platform) return setFormError("Choose the platform.");
    if (!IDENTIFIER_PATTERN.test(id)) return setFormError("An app id is 1 to 255 printable characters, with no spaces.");
    setFormError(null);
    const ok = await act.run(async () => {
      const out = await api.post<DeclaredIdentifier>("/v1/discovery/agent-identifiers", { agentId, platform, externalId: id });
      const n = out.autoLinked.length;
      return n === 0 ? "App id declared. No app matched it exactly yet." : `App id declared. ${n} app${n === 1 ? "" : "s"} linked automatically.`;
    });
    if (ok) setExternalId("");
  };
  const remove = () => {
    const target = removing;
    if (!target) return;
    setRemoving(null);
    void act.run(async () => {
      await api.del(`/v1/discovery/agent-identifiers/${target.id}`);
      return "App id removed. Existing links stay.";
    });
  };

  return (
    <Card
      title={<span id="declared">Declared agent app ids</span>}
      infoLabel="About declared app ids"
      info="An agent's app id on one platform applies to every entitlement source of that platform. Apps with exactly that id (case-sensitive) are linked automatically, each link audited. A partial or fuzzy match is never linked automatically."
    >
      <div className={v.stack} data-testid="agent-identifiers">
        <p>Declare an agent&apos;s app id on a platform. Apps with exactly that id are linked automatically, each link audited. Removing an id keeps existing links until an admin unlinks them.</p>
        <div className={v.row}>
          <Field label="Agent" error={formError}>
            <Select value={agentId} disabled={agents.isPending} onChange={(e) => setAgentId(e.target.value)}>
              <option value="">{agents.isPending ? "Loading…" : agents.error ? "Could not read the agents" : "Choose an agent"}</option>
              {agentList.filter(linkable).map((ag) => (
                <option key={ag.id} value={ag.id}>
                  {ag.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Platform">
            <Select value={platform} onChange={(e) => setPlatform(e.target.value as SaasPlatform | "")}>
              <option value="">Choose a platform</option>
              {SAAS_PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {SAAS_PLATFORM_LABEL[p]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="App id" grow>
            <Input value={externalId} maxLength={255} spellCheck={false} onChange={(e) => setExternalId(e.target.value)} />
          </Field>
          <Field label="&nbsp;">
            <Button variant="primary" disabled={act.busy} onClick={() => void declare()}>
              Declare id
            </Button>
          </Field>
        </div>
        <Table<AgentIdentifierView>
          rows={rows}
          rowKey={(r) => r.id}
          loading={list.isPending}
          error={list.error}
          onRetry={() => void list.refetch()}
          empty={<EmptyState title="No app id declared" body="Declare an agent's app id above to link its exact matches automatically." />}
          columns={[
            { key: "agent", header: "Agent", render: (r) => agentName(r.agentId) },
            { key: "platform", header: "Platform", render: (r) => SAAS_PLATFORM_LABEL[r.platform] ?? r.platform },
            { key: "id", header: "App id", render: (r) => <span className={v.mono}>{r.externalId}</span> },
            { key: "declared", header: "Declared", render: (r) => fmtDateTime(r.createdAt) },
            {
              key: "actions",
              header: "",
              srHeader: "Actions",
              render: (r) => (
                <Button size="sm" disabled={act.busy} aria-label={`Remove app id ${r.externalId}`} onClick={() => setRemoving(r)}>
                  Remove
                </Button>
              ),
            },
          ]}
        />
        {list.hasNextPage && (
          <div>
            <Button disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {list.isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
        {act.error && (
          <div className={v.errLine} role="alert">
            {act.error}
          </div>
        )}
      </div>
      <ConfirmModal
        open={!!removing}
        danger
        title="Remove this app id?"
        confirmLabel="Remove"
        onCancel={() => setRemoving(null)}
        onConfirm={remove}
        body={
          <p>
            New apps with the id <span className={v.mono}>{removing?.externalId}</span> are no longer linked automatically. Apps already linked through it keep
            their link until an admin unlinks them. The removal is audited.
          </p>
        }
      />
    </Card>
  );
}

