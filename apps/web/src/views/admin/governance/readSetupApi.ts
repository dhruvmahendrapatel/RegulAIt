/**
 * The read-setup screen's calls (ADR-0337 §4a, §5a). The read is `GET …/read-setup`. The two keys it explains are the
 * existing routes: a source's `target` (`activityLogs`, `orgTokens`) through `PATCH /v1/discovery/sources/:id`, and the
 * org switch `salesforceOrgTokens` through `PUT /v1/discovery/settings`. Widening either goes through `withStepUp`;
 * the gateway asks for the step-up and audits the change, and narrowing simply succeeds.
 */
import { api } from "../../../api/client";
import { api as stepUpApi, promptStepUp, withStepUp } from "../../../stepup/stepUp";
import type { DiscoverySettingsView, DiscoverySourceView } from "./discoverySourcesModel";
import { normaliseReadSetup, type ReadSetup } from "./readSetupModel";

export const SOURCES_KEY = ["admin", "discovery", "sources"] as const;
export const SETTINGS_KEY = ["admin", "discovery", "settings"] as const;
export const readSetupKey = (sourceId: string) => ["admin", "discovery", "read-setup", sourceId] as const;

export async function fetchReadSetup(sourceId: string): Promise<ReadSetup> {
  return normaliseReadSetup(await api.get<unknown>(`/v1/discovery/entitlements/sources/${encodeURIComponent(sourceId)}/read-setup`));
}

/** the target with one key set to on or off; every other key is kept as the source has it */
export function targetWith(source: DiscoverySourceView, key: "activityLogs" | "orgTokens", on: boolean): Record<string, string> {
  const target = Object.fromEntries(Object.entries(source.target).map(([k, v]) => [k, String(v)]));
  target[key] = on ? "on" : "off";
  return target;
}

export async function setSourceKey(source: DiscoverySourceView, key: "activityLogs" | "orgTokens", on: boolean, onStepUp: () => void): Promise<void> {
  await withStepUp(
    (h) => stepUpApi.patch(`/v1/discovery/sources/${encodeURIComponent(source.id)}`, { version: source.version, target: targetWith(source, key, on) }, h),
    (action, methods) => {
      onStepUp();
      return promptStepUp(action, methods);
    },
  );
}

export async function setOrgTokensSwitch(settings: DiscoverySettingsView, on: boolean, onStepUp: () => void): Promise<void> {
  await withStepUp(
    (h) => stepUpApi.put("/v1/discovery/settings", { version: settings.version, salesforceOrgTokens: on }, h),
    (action, methods) => {
      onStepUp();
      return promptStepUp(action, methods);
    },
  );
}
