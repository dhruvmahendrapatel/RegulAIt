/**
 * LANE-L ADAPTER (ADR-0202 lane F): how `demo:enforce` reads the beat's fallback switch, and how it proves that the
 * gateway it is pointed at is a demo one.
 *
 * Lane L owns the per-beat fallback switch (ADR-0202 decision 4). Its server-side `isBeatSimulated(db, beatId)` needs
 * a db handle, and `demo:enforce` has none: it talks to the gateway over HTTP with the bootstrap token. So this adapter
 * reads L's admin-only `GET /v1/demo/beats` with that same token, and opens no database connection.
 *
 *  - 200: the beat's `mode` is the answer. A 200 without the beat in it throws (a typo or a drifted list must never
 *    quietly run live or quietly run simulated, which is L's own rule for an unknown beat id).
 *  - 404: L's route is not deployed yet (until PR #572 merges), so the beat answers "live", the ADR's default.
 *  - anything else (401/403/5xx, a network error, a malformed body): it throws, and the beat refuses to run. "Live"
 *    still means every call is decided by the gateway, but a switch we cannot read is not a switch we may assume.
 *
 * The demo-target guard (PR #573 review, finding 5) refuses to run unless the gateway shows it is a demo one: L's beats
 * route is deployed AND the demo seed's four personas exist. An admin token pointed at a non-demo gateway that
 * happened to hold the same server and project names therefore cannot make a real write. No gateway route reports
 * the demo profile itself today; if one is added, check it here first.
 */
import { DEMO_PERSONA_EMAILS } from "./demo-set-passwords-lib.js";

export const ENFORCE_IT_BEAT_ID = "enforce-it";
export const DEMO_BEATS_ROUTE = "/v1/demo/beats";

export interface DemoBeatsProbe {
  /** false when the gateway answered 404: lane L's route is not deployed there */
  routeDeployed: boolean;
  simulated: boolean;
}

/** read the beat's mode from L's route; throws on anything but a 200 that lists the beat, or a 404 */
export async function readDemoBeat(
  baseUrl: string,
  bootstrapToken: string,
  beatId: string = ENFORCE_IT_BEAT_ID,
  fetchImpl: typeof fetch = fetch,
): Promise<DemoBeatsProbe> {
  const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}${DEMO_BEATS_ROUTE}`, {
    headers: { authorization: `Bearer ${bootstrapToken}` },
  });
  if (res.status === 404) return { routeDeployed: false, simulated: false };
  if (res.status !== 200) throw new Error(`GET ${DEMO_BEATS_ROUTE} -> ${res.status}: the beat's switch cannot be read`);
  const body = (await res.json().catch(() => null)) as { beats?: Array<{ beatId?: unknown; mode?: unknown }> } | null;
  const beat = body?.beats?.find((b) => b.beatId === beatId);
  if (!beat || (beat.mode !== "live" && beat.mode !== "simulated")) {
    throw new Error(`GET ${DEMO_BEATS_ROUTE} does not list beat '${beatId}' with a mode`);
  }
  return { routeDeployed: true, simulated: beat.mode === "simulated" };
}

/** the refusal to print, or null when the gateway shows it is a demo one */
export function demoTargetRefusal(probe: DemoBeatsProbe, userEmails: readonly string[]): string | null {
  if (!probe.routeDeployed) {
    return `this gateway has no ${DEMO_BEATS_ROUTE} route, so it cannot show it is a demo gateway (lane L, PR #572)`;
  }
  const have = new Set(userEmails);
  const missing = DEMO_PERSONA_EMAILS.filter((e) => !have.has(e));
  return missing.length ? `this gateway lacks the demo seed's personas (${missing.join(", ")}): run \`seed\` first` : null;
}
