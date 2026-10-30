import { describe, expect, it } from "vitest";
import {
  DELIBERATELY_API_ONLY,
  expandLiteralUnions,
  findAddGaps,
  findRemoveGaps,
  KNOWN_REMOVE_GAPS,
  NO_REMOVE_BY_DESIGN,
  fiveOhOneResponders,
  literalUnionOf,
  notBuiltRoutes,
  segmentMatch,
  uiCallPaths,
} from "./preflight-ui-affordances.mjs";

describe("affordance census: which web calls count as reaching a route", () => {
  it("counts the shared client in every shape it is written in", () => {
    const src = [
      "api.del(`/v1/a/${id}`);",
      "api.del<Thing>(`/v1/b/${id}`);",
      "api.delWithHeaders(`/v1/c/${id}`, h);",
      "api.del(cond ? `/v1/d/${x}` : `/v1/e/${y}`);",
    ].join("\n");
    expect([...uiCallPaths(src, "del")].sort()).toEqual(["/v1/a/:x", "/v1/b/:x", "/v1/c/:x", "/v1/d/:x", "/v1/e/:x"]);
  });

  it("counts the step-up client (stepUpApi), which every relaxing or owner-changing write goes through", () => {
    expect([...uiCallPaths("stepUpApi.del('/v1/x/:id')", "del")]).toEqual(["/v1/x/:x"]);
    expect([...uiCallPaths("withStepUp((h) => stepUpApi.post(`/v1/users/${u}/reactivate`, {}, h))", "post")]).toEqual([
      "/v1/users/:x/reactivate",
    ]);
    expect([...uiCallPaths("stepUpApi.get<T>(\"/v1/y\")", "get")]).toEqual(["/v1/y"]);
  });

  it("counts the shared client under its alias and the approval-decision seam", () => {
    expect([...uiCallPaths("sharedApi.delWithHeaders(`/v1/s/${id}`, h)", "del")]).toEqual(["/v1/s/:x"]);
    expect([...uiCallPaths("deps.post<T>(`/v1/approvals/${row.id}/signing-options`, {})", "post")]).toEqual([
      "/v1/approvals/:x/signing-options",
    ]);
  });

  it("does not count a lookalike: a Map's .get, another object's .del, or a client nested in some other object", () => {
    expect([...uiCallPaths("cache.get('/v1/x'); byPath.delete(`/v1/y`); foo.api.del('/v1/z'); myapi.del('/v1/w')", "del")]).toEqual([]);
    expect([...uiCallPaths("cache.get('/v1/x'); headers.get(\"/v1/y\"); foo.api.get('/v1/z')", "get")]).toEqual([]);
  });
});

describe("affordance census: the add side skips routes that are still 501 stubs", () => {
  it("reads the notBuilt registrations, verb and normalized path, and nothing else", () => {
    const src = [
      "const notBuilt = async (_req: unknown, reply: FastifyReply) => reply.status(501).send(NOT_BUILT);",
      'app.post("/v1/things", notBuilt);',
      'app.delete("/v1/things/:thingId/parts/:partId", notBuilt);',
      'app.get("/v1/things", s4.list);',
      'app.post("/v1/other", async (req, reply) => notBuilt);',
    ].join("\n");
    expect([...notBuiltRoutes(src)].sort()).toEqual(["DELETE /v1/things/:x/parts/:x", "POST /v1/things"]);
  });

  it("a listed collection whose POST is a stub is not a gap; once the stub is a real handler it is", () => {
    const sets = { posted: new Set(["/v1/things"]), gotten: new Set(["/v1/things"]), uiPost: new Set(), uiGet: new Set(["/v1/things"]) };
    expect(findAddGaps({ ...sets, notBuilt: new Set(["POST /v1/things"]) })).toEqual([]);
    expect(findAddGaps(sets)).toEqual(["/v1/things"]);
    // a stub on another verb does not excuse the POST
    expect(findAddGaps({ ...sets, notBuilt: new Set(["GET /v1/things"]) })).toEqual(["/v1/things"]);
  });

  it("a POST the UI calls, or a collection the UI does not list, is never a gap", () => {
    const base = { posted: new Set(["/v1/a/:x/b"]), gotten: new Set(["/v1/a/:x/b"]) };
    expect(findAddGaps({ ...base, uiPost: new Set(["/v1/a/:x/b"]), uiGet: new Set(["/v1/a/:x/b"]) })).toEqual([]);
    expect(findAddGaps({ ...base, uiPost: new Set(), uiGet: new Set() })).toEqual([]);
  });
});

describe("affordance census: a notBuilt route counts only when the file defines it as a 501 responder", () => {
  const regs = 'app.post("/v1/things", notBuilt);\napp.delete("/v1/things/:id", notBuilt);';

  it("a `notBuilt` that is imported, or that answers anything but 501, makes no stub", () => {
    expect([...notBuiltRoutes(regs)]).toEqual([]);
    expect([...notBuiltRoutes(`import { notBuilt } from "./elsewhere.js";\n${regs}`)]).toEqual([]);
    expect([...notBuiltRoutes(`const notBuilt = async (_req, reply) => reply.status(200).send({});\n${regs}`)]).toEqual([]);
    expect([...notBuiltRoutes(`const notBuilt = async (_req, reply) => reply.status(501).send(X);\n${regs}`)].sort()).toEqual([
      "DELETE /v1/things/:x",
      "POST /v1/things",
    ]);
  });

  it("finds the 501 responders by name, one-line handlers only", () => {
    const src = [
      "  const notBuilt = async (_req: unknown, reply: FastifyReply) => reply.status(501).send(IDENTITY_NOT_BUILT);",
      "  const ok = async (_req: unknown, reply: FastifyReply) => reply.status(200).send({});",
      "  const later = reply.status(501);",
    ].join("\n");
    expect([...fiveOhOneResponders(src)]).toEqual(["notBuilt"]);
  });

  it("no exemption names a stub: a stub is skipped already, so an entry for one is stale", () => {
    expect(DELIBERATELY_API_ONLY.size).toBe(0);
  });
});

describe("affordance census: a templated collection segment does not reach unrelated routes", () => {
  const owner = [
    'function OwnerForm({ kind, row }: { kind: "servers" | "connectors"; row: OwnedIntegration }) {',
    "  return api.put(`/v1/${kind}/${row.id}/owner`, { ownerUserId: null });",
    "}",
  ].join("\n");

  it("expands a template variable the file types as a string-literal union", () => {
    expect(literalUnionOf("kind", owner)).toEqual(["servers", "connectors"]);
    expect(literalUnionOf("row", owner)).toBeNull();
    expect(expandLiteralUnions("/v1/${kind}/${row.id}/owner", owner)).toEqual([
      "/v1/servers/${row.id}/owner",
      "/v1/connectors/${row.id}/owner",
    ]);
    expect([...uiCallPaths(owner, "put")].sort()).toEqual(["/v1/connectors/:x/owner", "/v1/servers/:x/owner"]);
  });

  it("IntegrationOwnership's call reaches the server and connector owner routes, and NOT the agent or alert ones", () => {
    const ui = uiCallPaths(owner, "put");
    expect(segmentMatch("/v1/servers/:x/owner", ui)).toBe(true);
    expect(segmentMatch("/v1/connectors/:x/owner", ui)).toBe(true);
    expect(segmentMatch("/v1/agents/:x/owner", ui)).toBe(false);
    expect(segmentMatch("/v1/governance/alerts/:x/owner", ui)).toBe(false);
  });

  it("an unexpandable collection wildcard reaches nothing; a wildcard further along still matches", () => {
    const untyped = uiCallPaths("api.put(`/v1/${kind}/${id}/owner`, {})", "put");
    expect([...untyped]).toEqual(["/v1/:x/:x/owner"]);
    expect(segmentMatch("/v1/agents/:x/owner", untyped)).toBe(false);
    // `/v1/grants/${kind}/${id}`: the collection is literal, the kind segment is a wildcard
    expect(segmentMatch("/v1/grants/agents/:x", new Set(["/v1/grants/:x/:x"]))).toBe(true);
  });
});

describe("remove parity (#453 G12): a collection the API can create into must have a way out", () => {
  const base = {
    posted: new Set(["/v1/things"]),
    gotten: new Set(["/v1/things"]),
    served: new Set(),
    mutations: new Set(["/v1/things"]),
  };

  it("flags a listed, creatable collection with no delete and no retire route (the Projects shape)", () => {
    expect(findRemoveGaps(base)).toEqual(["/v1/things"]);
  });

  it("accepts a DELETE on the item, including one written with a different parameter name", () => {
    expect(findRemoveGaps({ ...base, served: new Set(["/v1/things/:x"]) })).toEqual([]);
  });

  it("accepts a retire-style verb on the item, and only those verbs", () => {
    for (const verb of ["retire", "archive", "disable", "lifecycle", "abort"]) {
      expect(findRemoveGaps({ ...base, mutations: new Set([...base.mutations, `/v1/things/:x/${verb}`]) })).toEqual([]);
    }
    for (const verb of ["sync", "halt", "invoke", "rename"]) {
      expect(findRemoveGaps({ ...base, mutations: new Set([...base.mutations, `/v1/things/:x/${verb}`]) })).toEqual(["/v1/things"]);
    }
  });

  it("accepts a singleton cleared by a DELETE on its own path (a credential)", () => {
    const one = { ...base, posted: new Set(["/v1/c/:x/credential"]), gotten: new Set(["/v1/c/:x/credential"]) };
    expect(findRemoveGaps({ ...one, served: new Set(["/v1/c/:x/credential"]) })).toEqual([]);
  });

  it("ignores item actions (POST on an id), unlisted POSTs, and 501 stubs", () => {
    expect(findRemoveGaps({ ...base, posted: new Set(["/v1/things/:x"]) })).toEqual([]);
    expect(findRemoveGaps({ ...base, gotten: new Set() })).toEqual([]);
    expect(findRemoveGaps({ ...base, notBuilt: new Set(["POST /v1/things"]) })).toEqual([]);
  });

  it("gives every exemption a reason, and never lists a route in both maps", () => {
    for (const m of [NO_REMOVE_BY_DESIGN, KNOWN_REMOVE_GAPS]) {
      for (const [route, why] of m) {
        expect(route).toMatch(/^\/v1\//);
        expect(why.length).toBeGreaterThan(20);
      }
    }
    for (const r of KNOWN_REMOVE_GAPS.keys()) expect(NO_REMOVE_BY_DESIGN.has(r)).toBe(false);
  });

  it("ties every known gap to the #453 gap that tracks it, or says it is not yet proposed", () => {
    for (const why of KNOWN_REMOVE_GAPS.values()) expect(why).toMatch(/^(G\d+ |not yet proposed)/);
  });
});
