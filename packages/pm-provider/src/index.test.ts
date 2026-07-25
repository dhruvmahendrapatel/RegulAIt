import { describe, expect, it } from "vitest";
import {
  AzureDevOpsProvider,
  MockPmProvider,
  PmProviderError,
  mappingFor,
  resolvePmProvider,
  resolveStatus,
  resolveTaskFields,
  validateMapping,
} from "./index.js";

describe("field mapping (§6/§7)", () => {
  it("adapter defaults resolve RegulAIt concepts to provider-native paths", () => {
    const mapping = mappingFor("azure_devops");
    const fields = resolveTaskFields(mapping, { title: "Build API", description: "initial" });
    expect(fields["System.Title"]).toBe("Build API");
    expect(fields["System.Description"]).toBe("initial");
    expect(resolveStatus(mapping, "in_progress")).toBe("Doing");
  });

  it("an unmapped status resolves to null — skipped, never invented", () => {
    const mapping = validateMapping({
      task: { workItemType: "Task", fields: { title: "t" }, statusMap: { done: "Closed" } },
    });
    expect(resolveStatus(mapping, "in_progress")).toBeNull();
    expect(resolveStatus(mapping, "done")).toBe("Closed");
  });

  it("admin overrides replace the default mapping and are validated", () => {
    const mapping = mappingFor("azure_devops", {
      task: { workItemType: "User Story", fields: { title: "Custom.Title" } },
    });
    expect(resolveTaskFields(mapping, { title: "x" })).toEqual({ "Custom.Title": "x" });
    expect(() => mappingFor("azure_devops", { task: { fields: {} } })).toThrow();
    expect(() => mappingFor("jira")).toThrow(PmProviderError); // no default shipped yet
  });
});

describe("mock adapter", () => {
  it("creates, transitions, comments, and reads back work items", async () => {
    const pm = new MockPmProvider();
    const ref = await pm.createWorkItem("proj", "Task", { title: "n1" });
    await pm.transitionState("proj", ref.id, "Doing");
    await pm.addComment("proj", ref.id, "approved by lena");
    const item = await pm.getWorkItem("proj", ref.id);
    expect(item.state).toBe("Doing");
    expect(item.fields.title).toBe("n1");
    expect(item.comments).toEqual(["approved by lena"]);
    await expect(pm.transitionState("proj", "999", "Done")).rejects.toThrow(PmProviderError);
  });
});

describe("azure devops adapter (stubbed fetch)", () => {
  it("creates work items via json-patch and surfaces provider errors", async () => {
    const calls: Array<{ url: string; init: { method?: string; body?: string; headers?: Record<string, string> } }> = [];
    const pm = new AzureDevOpsProvider({
      token: "pat",
      baseUrl: "https://dev.azure.com/acme/",
      fetchImpl: async (url, init) => {
        calls.push({ url, init: init ?? {} });
        return {
          status: 200,
          json: async () => ({ id: 42, _links: { html: { href: "https://ado/42" } } }),
          text: async () => "",
        };
      },
    });
    const ref = await pm.createWorkItem("proj", "Task", { "System.Title": "Build API" });
    expect(ref).toEqual({ id: "42", url: "https://ado/42" });
    expect(calls[0]!.url).toBe("https://dev.azure.com/acme/proj/_apis/wit/workitems/$Task?api-version=7.1");
    expect(calls[0]!.init.headers!["content-type"]).toBe("application/json-patch+json");
    expect(JSON.parse(calls[0]!.init.body!)).toEqual([
      { op: "add", path: "/fields/System.Title", value: "Build API" },
    ]);

    const failing = new AzureDevOpsProvider({
      token: "pat",
      baseUrl: "https://dev.azure.com/acme",
      fetchImpl: async () => ({
        status: 401,
        json: async () => ({}),
        text: async () => "unauthorized",
      }),
    });
    await expect(failing.getWorkItem("proj", "1")).rejects.toThrow(/unauthorized/);
  });
});

describe("registry", () => {
  it("returns a shared mock, requires baseUrl for ado, rejects unimplemented adapters", () => {
    const a = resolvePmProvider({ provider: "mock", token: "" });
    const b = resolvePmProvider({ provider: "mock", token: "" });
    expect(a).toBe(b);
    expect(() => resolvePmProvider({ provider: "azure_devops", token: "t" })).toThrow(/baseUrl/);
    for (const provider of ["jira", "linear", "asana", "monday", "generic_webhook"] as const) {
      expect(() => resolvePmProvider({ provider, token: "t" })).toThrow(/not implemented/);
    }
  });
});
