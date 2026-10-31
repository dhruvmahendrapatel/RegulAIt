/**
 * The agent catalog on its own page (P3, #453 c6527514889): every registered agent with the shared list control, a
 * name or model search, enable and disable, each agent's AI BOM, and `#agent-<id>` deep links (narrowed to that agent
 * on the server). The agents overview keeps a five-row preview with the disabled count in its heading.
 */
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import AgentsPage from "./AgentsPage";
import AgentStewardshipPage from "./AgentStewardshipPage";
import type { AdminAgent } from "../../../api/adminTypes";
import { fmtUsd } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Input } from "../../../ui/kit";
import { DataList } from "../../../ui/DataList";
import { SubpageTrail } from "../../../ui/ListPreview";
import { adminKeys, useAction, useAgents, useCustomProviders } from "../adminKit";
import { ProviderMark } from "../../../ui/ModelPicker";
import { providerLabel } from "../../models/modelBindings";
import a from "../admin.module.css";
import v from "../../views.module.css";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AiBomPanel = lazy(() => import("../governance/BomEvidencePanel").then((m) => ({ default: m.AiBomPanel })));

export default function AgentCatalogPage() {
  const agents = useAgents();
  const customProviders = useCustomProviders();
  const act = useAction();
  // ADR-0189 B6: the agent whose AI BOM is open below the catalog
  const [bomAgentId, setBomAgentId] = useState<string | null>(null);

  // `#agent-<id>` deep links (dependency graph, governance alerts): once the
  // list has loaded, scroll that agent's row into view and mark it, so the
  // link lands on the agent rather than at the top of the catalog
  //
  // ADR-0219: the catalog pages on the server, so a deep link narrows it to that agent (the server's own `id`
  // filter) until the reader asks for the whole catalog again
  const { hash } = useLocation();
  const linkedAgentId = hash.startsWith("#agent-") ? hash.slice("#agent-".length) : null;
  const [showAll, setShowAll] = useState(false);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setQ(search.trim()), 300);
    return () => window.clearTimeout(t);
  }, [search]);
  const narrowed = linkedAgentId && UUID.test(linkedAgentId) && !showAll ? linkedAgentId : null;
  const catalogFilters = useMemo(() => (narrowed ? { id: narrowed } : { q: q || undefined }), [narrowed, q]);
  const [catalogRows, setCatalogRows] = useState<AdminAgent[] | null>(null);
  const bomAgent =
    (catalogRows ?? []).find((x) => x.id === bomAgentId) ?? (agents.data?.agents ?? []).find((x) => x.id === bomAgentId) ?? null;
  useEffect(() => {
    if (!linkedAgentId || !catalogRows) return;
    document.getElementById(`agent-${linkedAgentId}`)?.scrollIntoView({ block: "center" });
  }, [linkedAgentId, catalogRows]);

  // ADR-0034: an agent bound to a custom endpoint shows WHICH endpoint, not
  // just the word "custom" — two agents can both be provider 'custom' and go
  // to two different hosts.
  const endpointName = new Map(
    (customProviders.data?.providers ?? []).map((p) => [p.id, p.name] as const),
  );

  return (
    <>
      <SubpageTrail parent="Agents" parentTo="/admin/agents" current="Catalog" />
      <PageHeader title="Agent catalog" sub="Every registered agent; registering one grants nobody anything." />
      <div className={v.stack}>
        <Card flush title="Catalog">
          <div className={a.formRow} style={{ padding: "var(--s1) var(--s2) 0" }}>
            {narrowed ? (
              <>
                <span className={v.dim}>Showing the linked agent only.</span>
                <Button size="sm" onClick={() => setShowAll(true)}>
                  Show the whole catalog
                </Button>
              </>
            ) : (
              <Field label="Search agents">
                <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or model" />
              </Field>
            )}
          </div>
          <DataList<AdminAgent>
            listId="agents"
            noun="agents"
            endpoint="/v1/agents"
            exportPath="/v1/agents/export.xlsx"
            queryKey={[...adminKeys.agents, "catalog"]}
            legacyKey="agents"
            filters={catalogFilters}
            defaultSort={{ key: "name", dir: "asc" }}
            onRows={(rows) => setCatalogRows(rows)}
            columns={[
              { key: "name", header: "Name", main: true, sortable: true, render: (x) => (
                  <span id={`agent-${x.id}`}>
                    {x.name}
                    {x.id === linkedAgentId ? <> <Badge tone="info">linked</Badge></> : null}
                  </span>
                ) },
              {
                key: "provider",
                header: "Provider",
                main: true,
                sortable: true,
                render: (x) => (
                  <ProviderMark provider={x.provider} label={providerLabel(x.provider)}>
                    {x.provider === "custom" ? (
                      <span>
                        custom ·{" "}
                        <span className={v.mono}>
                          {x.customProviderId ? (endpointName.get(x.customProviderId) ?? x.customProviderId) : "—"}
                        </span>
                      </span>
                    ) : (
                      x.provider
                    )}
                  </ProviderMark>
                ),
              },
              { key: "tier", header: "Tier", align: "right", main: true, sortable: true, render: (x) => x.tier },
              {
                key: "model",
                header: "Model",
                main: true,
                sortable: true,
                render: (x) => (x.model ? <span className={v.mono}>{x.model}</span> : "—"),
              },
              {
                key: "price",
                header: "$/MTok in → out",
                main: true,
                sortable: true,
                align: "right",
                render: (x) =>
                  x.costPerMTokIn == null && x.costPerMTokOut == null ? (
                    <span
                      className={v.faint}
                      title="No price is recorded. Spend is metered in real tokens with costUsd null, and the optimizer neither routes toward this agent nor claims savings against it."
                    >
                      unpriced
                    </span>
                  ) : (
                    `${fmtUsd(x.costPerMTokIn)} → ${fmtUsd(x.costPerMTokOut)}`
                  ),
              },
              {
                key: "prompt",
                header: "System prompt",
                render: (x) => (x.systemPrompt ? `set (${x.systemPrompt.length} chars)` : "—"),
              },
              {
                key: "enabled",
                header: "Status",
                main: true,
                sortable: true,
                required: "Status is always shown",
                render: (x) => (x.enabled ? <Badge tone="ok">enabled</Badge> : <Badge tone="danger">disabled</Badge>),
              },
              {
                // ADR-0189 B6: the agent's signed AI BOM snapshots, drift and gaps
                key: "ai-bom",
                header: "Evidence",
                action: true,
                render: (x) => (
                  <Button size="sm" variant="ghost" aria-label={`AI BOM for ${x.name}`} aria-pressed={bomAgentId === x.id} onClick={() => setBomAgentId(bomAgentId === x.id ? null : x.id)}>
                    AI BOM
                  </Button>
                ),
              },
              {
                key: "actions",
                header: "",
                srHeader: "Actions",
                action: true,
                align: "right",
                render: (x) => (
                  <Button
                    size="sm"
                    onClick={() =>
                      void act.run(
                        () => withStepUp((h) => stepUpApi.post(`/v1/agents/${x.id}/enabled`, { enabled: !x.enabled }, h)),
                        x.enabled ? "Agent disabled" : "Agent enabled",
                      )
                    }
                  >
                    {x.enabled ? "disable" : "enable"}
                  </Button>
                ),
              },
            ]}
            rowKey={(x) => x.id}
            empty={<EmptyState title="No agents registered" body="Register the first agent below." />}
          />
        </Card>

        {bomAgent && (
          <section aria-label={`AI BOM for ${bomAgent.name}`} className={v.stack}>
            <div className={v.row}>
              <span className={v.sectionTitle}>AI BOM: {bomAgent.name}</span>
              <Button size="sm" variant="ghost" onClick={() => setBomAgentId(null)}>
                Close
              </Button>
            </div>
            <Suspense fallback={<p role="status">Loading the AI BOM…</p>}>
              <AiBomPanel key={bomAgent.id} subject={{ kind: "agent", id: bomAgent.id }} />
            </Suspense>
          </section>
        )}


      </div>
    </>
  );
}

/**
 * The agents area: the Agents page (with its catalogue and stewardship previews, and the `#agent-<id>` deep-link
 * redirect into the full catalogue) at the index, the full catalogue and the stewardship list each on their own nested
 * route. One lazy chunk mounted at `agents/*`, reached through the integrations screen barrel, so the sub-pages add
 * nothing to the entry bundle (ADR-0196 U4; the SPA route census follows this module — scripts/ui-spa-routes.mjs).
 */
export function AgentsArea() {
  return (
    <Routes>
      <Route index element={<AgentsPage />} />
      <Route path="catalog" element={<AgentCatalogPage />} />
      <Route path="stewardship" element={<AgentStewardshipPage />} />
    </Routes>
  );
}
