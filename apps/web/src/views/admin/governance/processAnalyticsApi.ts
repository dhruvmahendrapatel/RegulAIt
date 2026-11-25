/**
 * The process analytics calls (ADR-0342). Each query sends only what its route accepts, because every query schema is
 * strict and answers an unknown parameter with 400 `invalid_query`: the org scope is the default and is not sent,
 * `templateId` only when one is chosen, `limit`/`offset` on the two tables, and `bucket` on the heatmap and throughput.
 */
import { api } from "../../../api/client";
import {
  HEATMAP_STAGES,
  PAGE_SIZE,
  normaliseHeatmap,
  normaliseRefresh,
  normaliseStages,
  normaliseTemplates,
  normaliseThroughput,
  windowOf,
  type AnalyticsState,
  type Heatmap,
  type RefreshResult,
  type StagesPage,
  type TemplatesPage,
  type Throughput,
} from "./processAnalyticsModel";

export const ANALYTICS_KEY = ["admin", "process-analytics"] as const;
const BASE = "/v1/process-analytics";

type Filters = Pick<AnalyticsState, "days" | "anchor" | "templateId">;

export function analyticsQuery(f: Filters, extra: Record<string, string | number>): string {
  const qs = new URLSearchParams(windowOf(f));
  if (f.templateId) qs.set("templateId", f.templateId);
  for (const [k, val] of Object.entries(extra)) qs.set(k, String(val));
  return qs.toString();
}

export async function fetchTemplates(f: Filters, offset: number): Promise<TemplatesPage> {
  return normaliseTemplates(await api.get<unknown>(`${BASE}/templates?${analyticsQuery(f, { limit: PAGE_SIZE, offset })}`));
}

export async function fetchStages(f: Filters, offset: number): Promise<StagesPage> {
  return normaliseStages(await api.get<unknown>(`${BASE}/stages?${analyticsQuery(f, { limit: PAGE_SIZE, offset })}`));
}

export async function fetchHeatmap(f: Filters, bucket: AnalyticsState["bucket"]): Promise<Heatmap> {
  return normaliseHeatmap(await api.get<unknown>(`${BASE}/heatmap?${analyticsQuery(f, { bucket, limit: HEATMAP_STAGES })}`));
}

export async function fetchThroughput(f: Filters, bucket: AnalyticsState["bucket"]): Promise<Throughput> {
  return normaliseThroughput(await api.get<unknown>(`${BASE}/throughput?${analyticsQuery(f, { bucket })}`));
}

/** one bounded projection pass now (admin, audited by the gateway); the route takes no body */
export async function refreshAnalytics(): Promise<RefreshResult> {
  return normaliseRefresh(await api.post<unknown>(`${BASE}/refresh`));
}
