/**
 * The six ADR-0337 §6 calls behind Apps and agents. All are admin-only and audited by the gateway; none takes a reason
 * or a step-up. Every query is strict, so each sends only what its route accepts: `sourceId`, `after` and `limit` for
 * the apps; `after` and `limit` for the identifiers.
 */
import { api } from "../../../api/client";
import { PAGE_SIZE, normaliseApps, normaliseDeclared, normaliseIdentifiers, type AgentIdentifier, type EntitlementApp, type Page, type Platform } from "./entitlementLinksModel";

export const appsKey = (sourceId: string) => ["admin", "discovery", "entitlement-apps", sourceId] as const;
export const IDENTIFIERS_KEY = ["admin", "discovery", "agent-identifiers"] as const;

export function pageQuery(p: { sourceId?: string; after: string | null }): string {
  const qs = new URLSearchParams();
  if (p.sourceId) qs.set("sourceId", p.sourceId);
  if (p.after) qs.set("after", p.after);
  qs.set("limit", String(PAGE_SIZE));
  return qs.toString();
}

export async function fetchApps(sourceId: string, after: string | null): Promise<Page<EntitlementApp>> {
  return normaliseApps(await api.get<unknown>(`/v1/discovery/entitlements/apps?${pageQuery({ sourceId, after })}`));
}

export async function fetchIdentifiers(after: string | null): Promise<Page<AgentIdentifier>> {
  return normaliseIdentifiers(await api.get<unknown>(`/v1/discovery/agent-identifiers?${pageQuery({ after })}`));
}

export async function linkApp(appId: string, agentId: string): Promise<void> {
  await api.put(`/v1/discovery/entitlements/apps/${encodeURIComponent(appId)}/agent-link`, { agentId });
}

export async function unlinkApp(appId: string): Promise<void> {
  await api.del(`/v1/discovery/entitlements/apps/${encodeURIComponent(appId)}/agent-link`);
}

/** declares an agent's app id on one platform; answers how many apps were auto-linked by it */
export async function declareIdentifier(body: { agentId: string; platform: Platform; externalId: string }): Promise<number> {
  return normaliseDeclared(await api.post<unknown>("/v1/discovery/agent-identifiers", body)).autoLinked.length;
}

export async function removeIdentifier(identifierId: string): Promise<void> {
  await api.del(`/v1/discovery/agent-identifiers/${encodeURIComponent(identifierId)}`);
}
