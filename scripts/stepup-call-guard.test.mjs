/**
 * The step-up call guard (R3 on #1205): a web call to a route whose handler can
 * demand step-up must go through withStepUp, or be on ALLOWED with a reason.
 * CI runs every scripts/*.test.mjs, so the last test is the guard itself.
 */
import { describe, expect, it } from "vitest";
import { ALLOWED, check, scanRepo, stepUpRoutes, unwrappedCalls } from "./stepup-call-guard.mjs";

const gateway = (src) => [{ src, fileName: "apps/gateway/src/fixture.ts" }];
const web = (src, fileName = "apps/web/src/views/fixture.tsx") => [{ src, fileName }];

const GATEWAY = `
  app.post("/v1/things/:id/relax", async (req, reply) => {
    if (!(await requireStepUp(db, req, reply, { kind: "settings_relax", facts: {} })).ok) return reply;
    return { ok: true };
  });
  async function liftCheck(db, req, reply) {
    return requireStepUp(db, req, reply, { kind: "settings_relax", facts: {} });
  }
  app.delete("/v1/things/:id/lock", async (req, reply) => {
    if (!(await liftCheck(db, req, reply)).ok) return reply;
    return { removed: true };
  });
  app.get("/v1/things", async () => ({ things: [] }));
  app.patch("/v1/things/:id", async (req) => ({ id: req.params.id }));
`;

describe("stepUpRoutes: which gateway routes can demand step-up", () => {
  it("finds a handler that calls requireStepUp, directly or through a same-file helper", () => {
    expect([...stepUpRoutes(GATEWAY, "fixture.ts")].sort()).toEqual(["DELETE /v1/things/:x/lock", "POST /v1/things/:x/relax"]);
  });
  it("does not list a route whose handler never asks for step-up", () => {
    const routes = stepUpRoutes(GATEWAY, "fixture.ts");
    expect(routes.has("GET /v1/things")).toBe(false);
    expect(routes.has("PATCH /v1/things/:x")).toBe(false);
  });
});

describe("unwrappedCalls: which web calls run outside the step-up retry", () => {
  it("counts a plain client call", () => {
    expect(unwrappedCalls("api.post(`/v1/things/${id}/relax`, {});").map((c) => c.route)).toEqual(["POST /v1/things/:x/relax"]);
  });
  it("does not count a call inside withStepUp or putOrgSettings", () => {
    expect(unwrappedCalls("withStepUp((h) => stepUpApi.post(`/v1/things/${id}/relax`, {}, h));")).toEqual([]);
    expect(unwrappedCalls("act.run(() => withStepUp((h) => api.delWithHeaders(`/v1/things/${id}/lock`, h)));")).toEqual([]);
  });
  it("does not count a step-up call factory, (h) => stepUpApi.<verb>(…, h), handed to a component that wraps it", () => {
    expect(unwrappedCalls("<Card save={(body, h) => stepUpApi.put(`/v1/things/${id}/relax`, body, h)} />")).toEqual([]);
  });
  it("does not count a path handed to a helper that runs it through withStepUp", () => {
    const src = "const lift = (path, msg) => void act.run(() => withStepUp((h) => api.delWithHeaders(path, h)), msg);\nlift(`/v1/things/${id}/lock`, 'ok');";
    expect(unwrappedCalls(src)).toEqual([]);
  });
});

describe("check: the guard fires on an unwrapped call to a step-up route", () => {
  it("fails on api.post to a step-up route, and names the file and line", () => {
    const out = check({ gateway: gateway(GATEWAY), web: web("\napi.post(`/v1/things/${id}/relax`, { on: true });"), allowed: new Map() });
    expect(out.findings).toEqual([{ route: "POST /v1/things/:x/relax", file: "apps/web/src/views/fixture.tsx", line: 2 }]);
  });
  it("fails on a step-up route whose handler asks through a same-file helper", () => {
    const out = check({ gateway: gateway(GATEWAY), web: web("api.del(`/v1/things/${id}/lock`);"), allowed: new Map() });
    expect(out.findings.map((f) => f.route)).toEqual(["DELETE /v1/things/:x/lock"]);
  });
  it("passes the same call once it is wrapped", () => {
    const out = check({ gateway: gateway(GATEWAY), web: web("withStepUp((h) => stepUpApi.post(`/v1/things/${id}/relax`, {}, h));"), allowed: new Map() });
    expect(out.findings).toEqual([]);
  });
  it("ignores plain calls to routes that never demand step-up", () => {
    const out = check({ gateway: gateway(GATEWAY), web: web("api.patch(`/v1/things/${id}`, {}); api.get('/v1/things');"), allowed: new Map() });
    expect(out.findings).toEqual([]);
  });
  it("an allow-list entry covers its route in its file only, and an unused one is reported stale", () => {
    const allowed = new Map([
      ["POST /v1/things/:x/relax  apps/web/src/views/fixture.tsx", "fixture"],
      ["DELETE /v1/things/:x/lock  apps/web/src/views/elsewhere.tsx", "fixture"],
    ]);
    const out = check({ gateway: gateway(GATEWAY), web: web("api.post(`/v1/things/${id}/relax`, {}); api.del(`/v1/things/${id}/lock`);"), allowed });
    expect(out.findings.map((f) => f.route)).toEqual(["DELETE /v1/things/:x/lock"]);
    expect(out.stale).toEqual(["DELETE /v1/things/:x/lock  apps/web/src/views/elsewhere.tsx"]);
  });
});

describe("the repository", () => {
  it("every ALLOWED entry gives a reason", () => {
    for (const [key, why] of ALLOWED) {
      expect(key).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \/\S+ {2}apps\/web\/src\/\S+\.tsx?$/);
      expect(why.length, key).toBeGreaterThan(30);
    }
  });
  it("has no web call to a step-up route outside withStepUp, and no stale allow-list entry", () => {
    const { routes, findings, stale } = scanRepo();
    expect(routes.size).toBeGreaterThan(100); // the gateway scan works
    expect(findings).toEqual([]);
    expect(stale).toEqual([]);
  }, 120_000);
});
