/**
 * ADR-0172 — builder Apps & tools: the catalog of apps agents can work with,
 * grouped by vendor, with what is already connected in this workspace. The
 * connect step itself stays on the admin pages (connectors, MCP servers,
 * chat connections), where it is governed.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { BuilderIntegrationCategory } from "../../api/types";
import { useSession } from "../../session/SessionContext";
import { PageHeader } from "../../shell/AppShell";
import { Badge, Card, EmptyState, ErrorState, Input, SkeletonBlock } from "../../ui/kit";
import { Logo, hasLogo } from "../../ui/logos/Logo";
import { bk, builderApi } from "./builderApi";
import { countIntegrations, filterIntegrations, INTEGRATION_CATEGORIES } from "./builderLogic";
import { Icon, McpGlyph } from "./BuilderUi";
import s from "./builder.module.css";

export default function BuilderIntegrationsPage() {
  const q = useQuery({ queryKey: bk.integrations, queryFn: builderApi.integrations });
  const { auth } = useSession();
  const isAdmin = !!auth?.isAdmin;
  const [query, setQuery] = useState("");
  const [connectedOnly, setConnectedOnly] = useState(false);
  const [category, setCategory] = useState<BuilderIntegrationCategory | null>(null);
  const groups = q.data?.groups ?? [];
  const shown = useMemo(() => filterIntegrations(groups, { query, connectedOnly, category }), [groups, query, connectedOnly, category]);
  const counts = useMemo(() => countIntegrations(groups), [groups]);
  const custom = q.data?.custom.mcpServers ?? [];

  return (
    <>
      <PageHeader title="Apps & tools" crumbs={["Agent builder"]} sub="What your agents can connect to, and what's already connected in this workspace." />
      <div className={s.twoPane}>
        <nav aria-label="Filter apps" className={`${s.glass} ${s.sideCard}`}>
          <Input type="search" aria-label="Search apps" placeholder="Search apps" value={query} onChange={(e) => setQuery(e.target.value)} style={{ marginBottom: 10 }} />
          <div className={s.pickerNav}>
            <button type="button" className={s.navItem} aria-pressed={!connectedOnly} onClick={() => setConnectedOnly(false)}>
              {Icon.grid(15)} All
              <span className={s.navCount}>{counts.total}</span>
            </button>
            <button type="button" className={s.navItem} aria-pressed={connectedOnly} onClick={() => setConnectedOnly(true)}>
              {Icon.check(15)} Connected
              <span className={s.navCount}>{counts.connected}</span>
            </button>
          </div>
          <h2 className={s.navHeading}>Categories</h2>
          <div className={s.pickerNav}>
            <button type="button" className={s.navItem} aria-pressed={category === null} onClick={() => setCategory(null)}>
              Any category
            </button>
            {INTEGRATION_CATEGORIES.map((c) => (
              <button key={c.id} type="button" className={s.navItem} aria-pressed={category === c.id} onClick={() => setCategory(category === c.id ? null : c.id)}>
                {c.label}
              </button>
            ))}
          </div>
          <h2 className={s.navHeading}>Custom</h2>
          <div className={s.pickerNav}>
            <a className={s.navItem} href="#custom-mcp">
              {Icon.code(15)} Custom MCP servers
              <span className={s.navCount}>{custom.length}</span>
            </a>
          </div>
        </nav>

        <div style={{ display: "flex", flexDirection: "column", gap: 24, minWidth: 0 }}>
          {q.isLoading ? (
            <Card>
              <SkeletonBlock lines={6} />
            </Card>
          ) : q.isError ? (
            <Card>
              <ErrorState title="Couldn't load apps" message={(q.error as Error).message} onRetry={() => void q.refetch()} />
            </Card>
          ) : shown.length === 0 ? (
            <Card>
              <EmptyState
                title={connectedOnly && !query && !category ? "Nothing connected yet" : "No matching apps"}
                body={connectedOnly && !query && !category ? "Apps an administrator connects appear here." : "Try a different search or category."}
              />
            </Card>
          ) : (
            shown.map((g) => {
              const groupLogo = g.name.toLowerCase().replace(/[^a-z0-9]/g, "");
              return (
                <section key={g.name} aria-labelledby={`grp-${groupLogo}`} className={s.glass} style={{ padding: 20 }}>
                  <h2 id={`grp-${groupLogo}`} className={s.groupHead}>
                    {hasLogo(groupLogo) && <Logo name={groupLogo} label="" size={18} />}
                    {g.name}
                  </h2>
                  <ul className={s.catalogGrid} style={{ listStyle: "none", margin: 0, padding: 0 }}>
                    {g.items.map((i) => (
                      <li key={`${i.kind}-${i.key}`} className={s.catalogCard}>
                        <Logo name={hasLogo(i.key) ? i.key : null} label={i.name} size={28} />
                        <span className={s.catalogMain}>
                          <span className={s.catalogName}>{i.name}</span>
                          <span className={`${s.catalogDesc} ${s.clamp2}`}>{i.description}</span>
                        </span>
                        {i.status === "connected" ? (
                          <Badge tone="ok">Connected</Badge>
                        ) : isAdmin ? (
                          <Link className={s.helpLink} to={i.connectHref} aria-label={`Connect ${i.name}`} style={{ fontSize: "var(--text-sm)", whiteSpace: "nowrap" }}>
                            Connect
                          </Link>
                        ) : (
                          <Badge title="Ask an administrator to connect it">Not connected</Badge>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })
          )}

          <Card title={<span id="custom-mcp">Custom MCP servers</span>}>
            {q.isSuccess && custom.length === 0 ? (
              <p className={s.muted} style={{ margin: 0 }}>
                No custom MCP servers yet. {isAdmin ? "Register one to make its tools available to agents." : "An administrator can register one."}
              </p>
            ) : (
              <div className={s.list}>
                {custom.map((m) => (
                  <div key={m.id} className={s.listRow}>
                    <McpGlyph label="MCP server" size={20} />
                    <span className={s.listRowMain}>
                      <span className={s.listRowTitle}>{m.name}</span>
                      <span className={s.listRowSub}>
                        {m.toolCount} tool{m.toolCount === 1 ? "" : "s"}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            )}
            {isAdmin && (
              <p style={{ margin: "12px 0 0" }}>
                <Link className={s.helpLink} to="/admin/mcp-servers">
                  {Icon.plus(14)} Add a custom MCP server
                </Link>
              </p>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
