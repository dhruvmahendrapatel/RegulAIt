/**
 * ADR-0202 lane F — the adapter `demo:enforce` reads lane L's switch through, and the demo-gateway guard (PR #573
 * review, findings 3 and 5). Pure: the route is a stubbed `fetch`, so this needs no database.
 *
 * PASS CRITERIA, WRITTEN BEFORE THE RUN (M-023):
 *  1. 404 (L's route not deployed): live, and the guard refuses, since nothing shows this is a demo gateway.
 *  2. 200: the listed beat's mode is the answer; a 200 that does not list the beat throws.
 *  3. Any other status throws, so the beat refuses rather than assumes a mode.
 *  4. The guard passes only with the route deployed AND every demo persona present.
 */
import { describe, expect, it } from "vitest";
import { DEMO_BEATS_ROUTE, ENFORCE_IT_BEAT_ID, demoTargetRefusal, readDemoBeat } from "./demo-beat-switch.js";
import { DEMO_PERSONA_EMAILS } from "./demo-set-passwords-lib.js";

const seen: Array<{ url: string; auth: string | null }> = [];
const stub = (status: number, body?: unknown): typeof fetch =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  }) as typeof fetch;
const beats = (mode: string) => ({ beats: [{ beatId: "shadow-ai-discovery", mode: "live" }, { beatId: ENFORCE_IT_BEAT_ID, mode }] });

describe("readDemoBeat", () => {
  it("reads L's route with the bootstrap token", async () => {
    seen.length = 0;
    await readDemoBeat("http://gw.test/", "boot-token", ENFORCE_IT_BEAT_ID, stub(200, beats("live")));
    expect(seen).toEqual([{ url: `http://gw.test${DEMO_BEATS_ROUTE}`, auth: "Bearer boot-token" }]);
  });
  it("404: the route is not deployed, so the beat is live", async () => {
    expect(await readDemoBeat("http://gw.test", "t", ENFORCE_IT_BEAT_ID, stub(404, { error: "not_found" }))).toEqual({
      routeDeployed: false,
      simulated: false,
    });
  });
  it("200: the beat's mode is the answer", async () => {
    expect(await readDemoBeat("http://gw.test", "t", ENFORCE_IT_BEAT_ID, stub(200, beats("simulated")))).toEqual({
      routeDeployed: true,
      simulated: true,
    });
    expect((await readDemoBeat("http://gw.test", "t", ENFORCE_IT_BEAT_ID, stub(200, beats("live")))).simulated).toBe(false);
  });
  it("200 without the beat, or with no valid mode, throws", async () => {
    await expect(readDemoBeat("http://gw.test", "t", ENFORCE_IT_BEAT_ID, stub(200, { beats: [] }))).rejects.toThrow(/does not list beat/);
    await expect(readDemoBeat("http://gw.test", "t", ENFORCE_IT_BEAT_ID, stub(200, beats("maybe")))).rejects.toThrow(/does not list beat/);
  });
  it.each([401, 403, 500, 503])("%i throws: a switch that cannot be read is never assumed", async (status) => {
    await expect(readDemoBeat("http://gw.test", "t", ENFORCE_IT_BEAT_ID, stub(status, { error: "x" }))).rejects.toThrow(
      new RegExp(`-> ${status}`),
    );
  });
});

describe("demoTargetRefusal", () => {
  const all = [...DEMO_PERSONA_EMAILS, "someone@example.com"];
  it("refuses when L's route is not deployed, whatever the users", () => {
    expect(demoTargetRefusal({ routeDeployed: false, simulated: false }, all)).toMatch(/cannot show it is a demo gateway/);
  });
  it("refuses when a demo persona is missing", () => {
    const refusal = demoTargetRefusal({ routeDeployed: true, simulated: false }, all.filter((e) => e !== "avery@regulait.local"));
    expect(refusal).toMatch(/lacks the demo seed's personas \(avery@regulait\.local\)/);
  });
  it("passes with the route deployed and every persona present", () => {
    expect(demoTargetRefusal({ routeDeployed: true, simulated: true }, all)).toBeNull();
  });
});
