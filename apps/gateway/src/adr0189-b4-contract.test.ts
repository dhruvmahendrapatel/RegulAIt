/**
 * ADR-0189 slice B4 — the frozen contract is bound into the OpenAPI document.
 * Pure (no database): builds the document from the BOM route inventory.
 * `zz-adr0189-b1-foundation.test.ts` still pins that the routes answer 501.
 *
 * Reads `@regulait/shared` through its dist: run `pnpm -r build` first.
 */
import { describe, expect, it } from "vitest";
import { BOM_B4_ROUTE_CONTRACT, BOM_B4_ROUTES, BOM_ROUTES } from "@regulait/shared";
import { buildOpenApiDocument, openApiPath, ROUTE_DOCS, ROUTE_STABILITY } from "./openapi.js";

const inventory = BOM_ROUTES.map((r) => {
  const [method, url] = r.split(" ") as [string, string];
  return { method, url };
});
type Operation = {
  summary: string;
  parameters?: Array<{ name: string; in: string; required: boolean }>;
  requestBody?: { content: Record<string, { schema: Record<string, unknown> }> };
  responses: Record<string, { content?: Record<string, { schema: Record<string, unknown> }>; headers?: Record<string, unknown>; "x-regulait-error-codes"?: string[] }>;
};
const operation = (doc: Record<string, unknown>, route: string): Operation => {
  const [method, url] = route.split(" ") as [string, string];
  return (doc.paths as Record<string, Record<string, Operation>>)[openApiPath(url)]![method.toLowerCase()]!;
};

describe("ADR-0189 B4 contract in the OpenAPI document", () => {
  const all = buildOpenApiDocument(inventory, { includeInternal: true });

  it("the B4 routes stay internal and are absent from the published document", () => {
    for (const r of BOM_B4_ROUTES) expect(ROUTE_STABILITY[r], r).toBe("internal");
    const published = buildOpenApiDocument(inventory);
    expect(Object.keys(published.paths as object)).toEqual([]);
  });

  it("every B4 route states it is not built yet and binds the frozen schemas", () => {
    for (const r of BOM_B4_ROUTES) {
      expect(ROUTE_DOCS[r], r).toBeDefined();
      const op = operation(all, r);
      expect(op.summary, r).toContain("501 `not_built`");
      const c = BOM_B4_ROUTE_CONTRACT[r];
      const ok = op.responses["2XX"]!;
      if (c.response.kind === "json") {
        expect(ok.content?.["application/json"]?.schema.type, r).toBe("object");
        expect(Object.keys((ok.content!["application/json"]!.schema.properties ?? {}) as object), r).toContain("capabilities");
      } else {
        expect(ok.content?.["application/gzip"]?.schema, r).toEqual({ type: "string", format: "binary" });
        expect(Object.keys(ok.headers ?? {}), r).toContain("x-regulait-bundle-schema");
      }
      for (const [status, codes] of Object.entries(c.errors)) {
        expect(op.responses[status]?.["x-regulait-error-codes"], `${r} ${status}`).toEqual(codes);
        if (codes.length) expect(op.responses[status]!.content?.["application/json"]?.schema, `${r} ${status}`).toBeDefined();
      }
    }
  });

  it("the verify route documents its request body; the reads document their query", () => {
    const verify = operation(all, "POST /v1/boms/verify");
    expect(JSON.stringify(verify.requestBody?.content["application/json"]?.schema)).toContain("bundleBase64");
    expect(JSON.stringify(verify.responses["2XX"]!.content!["application/json"]!.schema)).toContain("cannotProve");
    expect(operation(all, "GET /v1/decisions/:auditId/bom").parameters?.map((p) => `${p.in}:${p.name}`)).toEqual(["path:auditId", "query:version"]);
    expect(operation(all, "GET /v1/ai-bom/snapshots/:snapshotId").parameters?.map((p) => `${p.in}:${p.name}`)).toEqual(["path:snapshotId", "query:format"]);
  });

  it("review item 3: the 403 keeps the generic admin and MFA text and adds the contract's codes", () => {
    for (const r of BOM_B4_ROUTES) {
      const forbidden = operation(all, r).responses["403"] as { description: string; "x-regulait-error-codes"?: string[] };
      expect(forbidden.description, r).toContain("ADR-0181");
      expect(forbidden.description, r).toContain("`admin_only`");
      expect(forbidden["x-regulait-error-codes"], r).toEqual(["bom_export_forbidden", "admin_only", "mfa_enrollment_required"]);
    }
  });

  it("review item 7: the path parameters carry the contract's lower-case uuid schema", () => {
    const schemaOf = (route: string, name: string) =>
      JSON.stringify((operation(all, route).parameters as Array<{ name: string; in: string; schema?: unknown }>).find((p) => p.in === "path" && p.name === name)?.schema);
    for (const r of ["GET /v1/decisions/:auditId/bom", "GET /v1/decisions/:auditId/bom/bundle"]) expect(schemaOf(r, "auditId"), r).toContain("[0-9a-f]{8}-");
    for (const r of ["GET /v1/ai-bom/snapshots/:snapshotId", "GET /v1/ai-bom/snapshots/:snapshotId/bundle"]) expect(schemaOf(r, "snapshotId"), r).toContain("[0-9a-f]{8}-");
    // a route with no params schema keeps the plain string
    expect(schemaOf("GET /v1/ai-bom/:subjectKind/:subjectId/drift", "subjectId")).toBe(JSON.stringify({ type: "string" }));
  });

  it("the B3 routes are untouched by the B4 binding", () => {
    const list = operation(all, "GET /v1/ai-bom/:subjectKind/:subjectId/snapshots");
    expect(list.responses["2XX"]!.content).toBeUndefined();
    expect(list.responses["409"]).toBeUndefined();
  });
});
