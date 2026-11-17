import { describe, expect, it } from "vitest";
import {
  allowedOperationEvents,
  importOpenApiToolSourceSchema,
  nextOperationState,
  OPENAPI_OPERATION_MACHINE,
  openApiDefinitionDigest,
  planOpenApiReimport,
  restEndpointSchema,
  restEndpointsToOpenApi,
  type OpenApiOperationDefinition,
} from "./openapi-tools.js";

const def = (description: string): OpenApiOperationDefinition => ({
  tool: { name: "getOrder", description, inputSchema: { type: "object", properties: { id: { type: "string" } } } },
  request: { method: "GET", path: "/orders/{id}", mapper: [{ inputKey: "id", type: "path", key: "id", required: true }] },
});

describe("ADR-0353: the operation machine (ADR-0348 defineMachine)", () => {
  it("serves only through an approval, and an approved operation can only be revoked by an admin", () => {
    const m = OPENAPI_OPERATION_MACHINE;
    const toApproved = m.events.filter((e) => m.def.transitions[e].to === "approved").flatMap((e) => m.sourcesOf(e).map((f) => `${f}:${e}`));
    expect(toApproved.sort()).toEqual(["drifted:approve", "drifted:reimport_reverted", "staged:approve"]);
    expect(allowedOperationEvents("approved")).toEqual(["revoke"]);
    expect(allowedOperationEvents("staged")).toEqual(["approve", "reject"]);
    expect(allowedOperationEvents("withdrawn")).toEqual([]);
    expect(nextOperationState("rejected", "approve")).toBeNull();
    expect(nextOperationState("withdrawn", "approve")).toBeNull();
    expect(nextOperationState("approved", "reimport_changed")).toBe("drifted");
    expect(m.describe("staged").transitions.find((t) => t.event === "revoke")?.allowed).toBe(false);
  });
});

describe("planOpenApiReimport", () => {
  const D1 = openApiDefinitionDigest(def("v1"));
  const D2 = openApiDefinitionDigest(def("v2"));
  it("withholds a changed approved operation, withdraws a missing one, stages a new one, leaves an unchanged one", () => {
    const plan = planOpenApiReimport(
      [
        { id: "a", operationKey: "GET /a", state: "approved", importedDigest: D1, approvedDigest: D1 },
        { id: "b", operationKey: "GET /b", state: "approved", importedDigest: D1, approvedDigest: D1 },
        { id: "c", operationKey: "GET /c", state: "staged", importedDigest: D1, approvedDigest: null },
        { id: "r", operationKey: "GET /r", state: "rejected", importedDigest: D1, approvedDigest: null },
        { id: "d", operationKey: "GET /d", state: "withdrawn", importedDigest: D1, approvedDigest: D1 },
      ],
      [
        { operationKey: "GET /a", digest: D2 },
        { operationKey: "GET /c", digest: D1 },
        { operationKey: "GET /d", digest: D1 },
        { operationKey: "GET /e", digest: D1 },
        { operationKey: "GET /r", digest: D2 },
      ],
    );
    expect(plan.added.map((a) => a.operationKey)).toEqual(["GET /e"]);
    expect(plan.unchanged).toEqual(["c"]);
    expect(plan.moved.map((m) => [m.id, m.event, m.to])).toEqual([
      ["a", "reimport_changed", "drifted"],
      ["b", "reimport_missing", "withdrawn"],
      ["r", "reimport_restaged", "staged"],
      ["d", "reimport_present", "staged"],
    ]);
  });

  it("serves a drifted operation again only when it is back to exactly the approved digest", () => {
    const drifted = { id: "a", operationKey: "GET /a", state: "drifted" as const, importedDigest: D2, approvedDigest: D1 };
    expect(planOpenApiReimport([drifted], [{ operationKey: "GET /a", digest: D1 }]).moved[0]).toMatchObject({ event: "reimport_reverted", to: "approved" });
    const D3 = openApiDefinitionDigest(def("v3"));
    expect(planOpenApiReimport([drifted], [{ operationKey: "GET /a", digest: D3 }]).moved[0]).toMatchObject({ event: "reimport_changed", to: "drifted" });
  });
});

describe("openApiDefinitionDigest", () => {
  it("is independent of key order and moves with any change", () => {
    const a = def("v1");
    const reordered = { request: a.request, tool: { inputSchema: a.tool.inputSchema, description: "v1", name: "getOrder" } } as OpenApiOperationDefinition;
    expect(openApiDefinitionDigest(reordered)).toBe(openApiDefinitionDigest(a));
    expect(openApiDefinitionDigest(def("v1 "))).not.toBe(openApiDefinitionDigest(a));
  });
});

describe("REST endpoint lists", () => {
  it("refuse a dot segment, a query string and a relative path", () => {
    for (const path of ["/a/../b", "/a/./b", "/a?x=1", "a/b", "/a#f"]) {
      expect(restEndpointSchema.safeParse({ method: "GET", path, description: "d" }).success, path).toBe(false);
    }
  });

  it("become an OpenAPI 3.1 document with path, query and body parameters", () => {
    const doc = restEndpointsToOpenApi("t", [
      { method: "GET", path: "/orders/{id}", description: "read", query: [{ name: "expand", required: false }] },
      { method: "POST", path: "/orders", description: "create", bodySchema: { type: "object" } },
    ]) as { openapi: string; paths: Record<string, Record<string, { operationId: string; parameters: unknown[]; requestBody?: unknown }>> };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths["/orders/{id}"]!.get!.operationId).toBe("get_orders_id");
    expect(doc.paths["/orders/{id}"]!.get!.parameters).toHaveLength(2);
    expect(doc.paths["/orders"]!.post!.requestBody).toBeDefined();
  });

  it("an import names exactly one input", () => {
    const base = { name: "orders-api", baseUrl: "https://api.example.test" };
    expect(importOpenApiToolSourceSchema.safeParse(base).success).toBe(false);
    expect(importOpenApiToolSourceSchema.safeParse({ ...base, spec: "{}", endpoints: [{ method: "GET", path: "/a", description: "d" }] }).success).toBe(false);
    expect(importOpenApiToolSourceSchema.safeParse({ ...base, spec: "{}" }).success).toBe(true);
  });
});
