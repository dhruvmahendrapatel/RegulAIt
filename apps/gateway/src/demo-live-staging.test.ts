/**
 * `demo:prepare --live` (finding #4 of the #522 deep scan): the mock `staging` deploy target, through the admin route,
 * created once and never duplicated, and a same-named target that is not the mock refused. Stub answers (no Postgres);
 * the demo.yml `demo-live` job asserts the one audited row on a real database.
 */
import { describe, expect, it } from "vitest";
import { DEMO_SHADOW_DISCOVERY } from "@regulait/shared";
import { fictionalDatasetMarkers } from "./demo-check-lib.js";
import { DEMO_LIVE_STAGING_TARGET, ensureLiveStagingTarget } from "./demo-live-staging.js";

type Json = Record<string, any>;

function api(targets: Json[]) {
  const posts: Json[] = [];
  const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
    if (method === "GET" && url === "/v1/deploy/targets") return { status: 200, body: { targets } };
    if (method === "POST" && url === "/v1/deploy/targets") {
      posts.push(payload as Json);
      targets.push({ id: `t${targets.length}`, ...(payload as Json) });
      return { status: 201, body: targets.at(-1)! };
    }
    return { status: 404, body: {} };
  };
  return { call, posts, targets };
}

describe("ensureLiveStagingTarget", () => {
  it("creates the mock staging target through the route, once", async () => {
    const a = api([{ id: "t0", name: "demo-deploy", provider: "mock", environment: "production" }]);
    const first = await ensureLiveStagingTarget(a.call);
    expect(first).toEqual({ ok: true, note: "deploy target 'demo-staging' (mock, staging) created" });
    expect(a.posts).toEqual([{ name: "demo-staging", provider: "mock", mode: "hosted", environment: "staging" }]);
    const again = await ensureLiveStagingTarget(a.call);
    expect(again).toEqual({ ok: true, note: "deploy target 'demo-staging' (mock, staging) already present" });
    expect(a.posts).toHaveLength(1);
  });

  it("refuses a same-named target that is not the mock: it is never reused", async () => {
    const a = api([{ id: "t0", name: "demo-staging", provider: "aws", environment: "staging" }]);
    const r = await ensureLiveStagingTarget(a.call);
    expect(r.ok).toBe(false);
    expect(a.posts).toEqual([]);
  });

  it("a refused create is an error, not a note", async () => {
    const r = await ensureLiveStagingTarget(async (method) => (method === "GET" ? { status: 200, body: { targets: [] } } : { status: 403, body: { error: "forbidden" } }));
    expect(r).toEqual({ ok: false, error: "deploy target 'demo-staging': 403 forbidden" });
  });

  it("is a mock, and its name is not a marker of the fictional dataset", () => {
    expect(DEMO_LIVE_STAGING_TARGET.provider).toBe("mock");
    expect(fictionalDatasetMarkers(DEMO_SHADOW_DISCOVERY)).not.toContain(DEMO_LIVE_STAGING_TARGET.name);
  });
});
