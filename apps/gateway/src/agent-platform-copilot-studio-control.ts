/**
 * ADR-0338 slice 1b: the Copilot Studio adapter's `control` member. Quarantine and its reverse through the three
 * documented Power Platform API calls (https://learn.microsoft.com/microsoft-copilot-studio/admin-api-quarantine):
 *
 *   GET  /copilotstudio/environments/{environmentId}/bots/{botId}/api/botQuarantine?api-version=1
 *   POST /copilotstudio/environments/{environmentId}/bots/{botId}/api/botQuarantine/SetAsQuarantined?api-version=1
 *   POST /copilotstudio/environments/{environmentId}/bots/{botId}/api/botQuarantine/SetAsUnquarantined?api-version=1
 *
 * No disable: the Dataverse `bot.statecode` is not documented as taking an agent out of service (ADR-0338 §3a).
 *
 * Both ids come from a discovered record (an admin never types one): the bot id is the last segment of E17's external
 * id (`<dataverse host>/<botid>`) and the environment id is the record's `environmentId` vendor attribute (the locator).
 * Each is reported by the vendor, so untrusted: shape-checked as a GUID before anything is sent, then path-encoded, and
 * every call passes `allowListedFetch` (these three (method, path) pairs on this one origin) inside the guarded fetch.
 * Responses are parsed as closed shapes and never stored. No REST client: Microsoft ships no maintained JavaScript
 * Power Platform API client (ADR-0338 §8), so these are three fetches.
 */
import { allowListedFetch, type EndpointRule } from "./agent-platform-endpoints.js";
import type { ControlResult, VendorAgentControlAction, VendorAgentState } from "@regulait/shared";
import type { ControlContext, VendorAgentControl, VendorAgentRef } from "./vendor-agent-control-contract.js";

export const POWER_PLATFORM_API_ORIGIN = "https://api.powerplatform.com";
/** the app-only token scope for the Power Platform API (a delegated token carries CopilotStudio.AdminActions.Invoke) */
export const POWER_PLATFORM_API_SCOPE = "https://api.powerplatform.com/.default";
/** ADR-0338 slice 1c: the one delegated permission the quarantine calls document */
export const POWER_PLATFORM_DELEGATED_SCOPE = "https://api.powerplatform.com/CopilotStudio.AdminActions.Invoke";
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const GUID_PATH = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const BASE = `^/copilotstudio/environments/${GUID_PATH}/bots/${GUID_PATH}/api/botQuarantine`;

/** the only calls the control makes (ADR-0336 decision 5, applied to the write side) */
export const COPILOT_STUDIO_CONTROL_ENDPOINTS: readonly EndpointRule[] = Object.freeze([
  { method: "GET", path: new RegExp(`${BASE}$`) },
  { method: "POST", path: new RegExp(`${BASE}/SetAsQuarantined$`) },
  { method: "POST", path: new RegExp(`${BASE}/SetAsUnquarantined$`) },
]);

/** the two ids, shape-checked and lower-cased; null when either is not a GUID (nothing is then sent) */
export function copilotStudioIds(ref: VendorAgentRef): { environmentId: string; botId: string } | null {
  const botId = ref.externalId.slice(ref.externalId.lastIndexOf("/") + 1);
  if (!GUID.test(botId) || !ref.locator || !GUID.test(ref.locator)) return null;
  return { environmentId: ref.locator.toLowerCase(), botId: botId.toLowerCase() };
}

/** the URL of one call, every vendor-supplied segment path-encoded (#1096 security review, nit 1) */
export function copilotStudioControlUrl(ids: { environmentId: string; botId: string }, call: "status" | "quarantine" | "unquarantine"): string {
  const suffix = call === "status" ? "" : call === "quarantine" ? "/SetAsQuarantined" : "/SetAsUnquarantined";
  return `${POWER_PLATFORM_API_ORIGIN}/copilotstudio/environments/${encodeURIComponent(ids.environmentId)}/bots/${encodeURIComponent(ids.botId)}/api/botQuarantine${suffix}?api-version=1`;
}

const fetchOf = (ctx: ControlContext) => allowListedFetch(ctx.fetch, new Set([POWER_PLATFORM_API_ORIGIN]), COPILOT_STUDIO_CONTROL_ENDPOINTS);
const headers = (ctx: ControlContext) => ({ authorization: `Bearer ${ctx.token}`, accept: "application/json" });

/** the status call's closed shape: `isBotQuarantined` must be a boolean, anything else is unreadable */
async function readQuarantine(ctx: ControlContext, ref: VendorAgentRef): Promise<VendorAgentState> {
  const ids = copilotStudioIds(ref);
  if (!ids) throw new Error("the record has no valid environment or agent id");
  const res = await fetchOf(ctx)(copilotStudioControlUrl(ids, "status"), { method: "GET", headers: headers(ctx), signal: ctx.signal });
  if (!res.ok) throw new Error(`the quarantine status read answered ${res.status}`);
  const body: unknown = await res.json();
  const q = body && typeof body === "object" && Object.hasOwn(body, "isBotQuarantined") ? (body as Record<string, unknown>).isBotQuarantined : undefined;
  if (typeof q !== "boolean") throw new Error("the quarantine status was not readable");
  return { state: q ? "quarantined" : "active" };
}

/**
 * One quarantine call. A definite vendor answer (401/403 credential, 404 agent, 405 a classic chatbot the API does
 * not support, another 4xx) ends the action `failed` and changes nothing; a 5xx or 429 may or may not have acted, so it
 * throws and the action moves to `unknown`, settled by a read and never retried.
 */
async function setQuarantine(ctx: ControlContext, ref: VendorAgentRef, quarantined: boolean): Promise<ControlResult> {
  const ids = copilotStudioIds(ref);
  if (!ids) return { outcome: "refused", code: "vendor_id_invalid" };
  const res = await fetchOf(ctx)(copilotStudioControlUrl(ids, quarantined ? "quarantine" : "unquarantine"), { method: "POST", headers: headers(ctx), signal: ctx.signal });
  // the body is never kept; drained so the connection is released
  await res.body?.cancel().catch(() => undefined);
  if (res.ok) return { outcome: "applied", code: "applied", httpStatus: res.status };
  if (res.status === 401 || res.status === 403) return { outcome: "refused", code: "vendor_refused_credential", httpStatus: res.status };
  if (res.status === 404) return { outcome: "refused", code: "vendor_agent_not_found", httpStatus: res.status };
  if (res.status === 405) return { outcome: "refused", code: "vendor_action_unsupported", httpStatus: res.status };
  if (res.status >= 400 && res.status < 500 && res.status !== 429) return { outcome: "failed", code: "vendor_rejected", httpStatus: res.status };
  throw new Error(`the quarantine call answered ${res.status}`);
}

const only = (action: VendorAgentControlAction) => {
  if (action !== "quarantine") throw new Error(`Copilot Studio documents no ${action} control`);
};

export const COPILOT_STUDIO_CONTROL: VendorAgentControl = Object.freeze({
  kind: "vendor_agent_control" as const,
  actions: Object.freeze(["quarantine"] as const),
  // §3a: a federated service principal is preferred; a stored secret is a step-up; delegated only by admin opt-in
  acceptedModes: Object.freeze(["federated", "static", "delegated"] as const),
  token: Object.freeze({ provider: "entra" as const, scope: POWER_PLATFORM_API_SCOPE, delegatedScope: POWER_PLATFORM_DELEGATED_SCOPE }),
  locatorOf(vendorAttributes: Readonly<Record<string, unknown>>): string | null {
    const v = Object.hasOwn(vendorAttributes, "environmentId") ? vendorAttributes.environmentId : undefined;
    return typeof v === "string" && GUID.test(v) ? v.toLowerCase() : null;
  },
  readState: (ctx: ControlContext, ref: VendorAgentRef) => readQuarantine(ctx, ref),
  apply: (ctx: ControlContext, ref: VendorAgentRef, action: VendorAgentControlAction) => {
    only(action);
    return setQuarantine(ctx, ref, true);
  },
  reverse: (ctx: ControlContext, ref: VendorAgentRef, action: VendorAgentControlAction) => {
    only(action);
    return setQuarantine(ctx, ref, false);
  },
});
