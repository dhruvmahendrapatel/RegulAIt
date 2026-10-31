/**
 * A federated registry's catalogue on its own page (P3, #453 c6527514889): every entry with the shared list control,
 * the catalogue's search and kind filter, and Import. The registries tab keeps a five-row preview.
 */
import { Route, Routes, useParams } from "react-router-dom";
import McpServersPage from "./McpServersPage";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { PageHeader } from "../../../shell/AppShell";
import { Card, EmptyState } from "../../../ui/kit";
import { SubpageTrail } from "../../../ui/ListPreview";
import { QueryGate } from "../adminKit";
import { RegistryEntriesCard, mcpRegistryKeys } from "./McpRegistriesPanel";
import type { McpRegistryList } from "./mcpRegistryModel";
import v from "../../views.module.css";

export function McpRegistryEntriesPage() {
  const registryId = useParams().registryId ?? "";
  const list = useQuery({ queryKey: mcpRegistryKeys.list, queryFn: () => api.get<McpRegistryList>("/v1/mcp-registries") });
  const registry = list.data?.registries.find((r) => r.id === registryId) ?? null;
  return (
    <>
      <SubpageTrail parent="MCP servers: federated registries" parentTo="/admin/mcp-servers?tab=registries" current={registry ? `Catalogue: ${registry.name}` : "Catalogue"} />
      <PageHeader title={registry ? `Catalogue: ${registry.name}` : "Registry catalogue"} sub="What an upstream registry says exists. A row here is not a server until an admin imports it." />
      <div className={v.stack}>
        {list.data?.federationRefused && (
          <p role="note" className={v.errLine}>
            Federation is refused in this deployment ({list.data.deployMode}): {list.data.federationRefusedReason ?? "registries cannot be pulled"}.
          </p>
        )}
        <QueryGate loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}>
          {registry ? (
            <RegistryEntriesCard registry={registry} />
          ) : (
            <Card>
              <EmptyState title="No such registry" body="It may have been removed. The registries tab on the MCP servers page lists every one." />
            </Card>
          )}
        </QueryGate>
      </div>
    </>
  );
}

/**
 * The MCP servers area: the MCP servers page (servers, tools and the registries tab with its five-row preview) at the
 * index, a registry's full catalogue on its own nested route. One lazy chunk mounted at `mcp-servers/*` so it adds
 * nothing to the entry bundle (ADR-0196 U4; the SPA route census follows this module — scripts/ui-spa-routes.mjs).
 */
export function McpServersArea() {
  return (
    <Routes>
      <Route index element={<McpServersPage />} />
      <Route path="registries/:registryId/entries" element={<McpRegistryEntriesPage />} />
    </Routes>
  );
}
