import { describe, expect, it } from "vitest";
import { uiCallPaths } from "./preflight-ui-affordances.mjs";

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
