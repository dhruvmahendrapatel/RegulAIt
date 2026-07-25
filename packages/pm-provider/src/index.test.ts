import { describe, expect, it } from "vitest";
import {
  AzureDevOpsProvider,
  JiraProvider,
  LinearProvider,
  MockPmProvider,
  PmProviderError,
  mappingFor,
  resolveApprovalAction,
  resolveDecisionAction,
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
    expect(() => mappingFor("asana")).toThrow(PmProviderError); // no default shipped yet
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
    for (const provider of ["asana", "monday", "generic_webhook"] as const) {
      expect(() => resolvePmProvider({ provider, token: "t" })).toThrow(/not implemented/);
    }
  });
});

describe("approval mirroring resolution (§5)", () => {
  it("a mapped stage under status_transition transitions; everything else comments", () => {
    const mapping = validateMapping({
      task: { workItemType: "Task", fields: { title: "t" } },
      approval: {
        target: "status_transition",
        stageMap: { requirements_signoff: "Approved" },
      },
    });
    expect(resolveApprovalAction(mapping, "requirements_signoff")).toEqual({
      kind: "transition",
      state: "Approved",
    });
    // unmapped stage → comment fallback, never a silent drop
    expect(resolveApprovalAction(mapping, "deploy_approval")).toEqual({ kind: "comment" });
  });

  it("absent approval config or comment target always degrades to a comment", () => {
    const bare = validateMapping({ task: { workItemType: "Task", fields: { title: "t" } } });
    expect(resolveApprovalAction(bare, "any")).toEqual({ kind: "comment" });
    const commentCfg = validateMapping({
      task: { workItemType: "Task", fields: { title: "t" } },
      approval: { target: "comment", stageMap: { x: "Done" } },
    });
    expect(resolveApprovalAction(commentCfg, "x")).toEqual({ kind: "comment" });
  });
});

describe("decision record resolution (§4)", () => {
  it("a mapped Decision-like type yields a real work item with the minimum fields", () => {
    const mapping = validateMapping({
      task: { workItemType: "Task", fields: { title: "t" } },
      decision: {
        workItemType: "Risk",
        fields: { title: "System.Title", rationale: "Custom.Rationale", decisionMaker: "Custom.Maker" },
      },
    });
    const action = resolveDecisionAction(mapping, {
      decision: "use Postgres",
      rationale: "operational familiarity",
      decisionMaker: "mia@example.com",
    });
    expect(action).toEqual({
      kind: "work_item",
      type: "Risk",
      fields: {
        "System.Title": "use Postgres",
        "Custom.Rationale": "operational familiarity",
        "Custom.Maker": "mia@example.com",
      },
    });
    // a null rationale simply omits the mapped field
    const noRationale = resolveDecisionAction(mapping, {
      decision: "d",
      rationale: null,
      decisionMaker: "m",
    });
    expect(noRationale.kind).toBe("work_item");
    expect((noRationale as { fields: Record<string, unknown> }).fields["Custom.Rationale"]).toBeUndefined();
  });

  it("no decision mapping degrades to a comment — never a silent drop", () => {
    const bare = validateMapping({ task: { workItemType: "Task", fields: { title: "t" } } });
    expect(resolveDecisionAction(bare, { decision: "d", rationale: null, decisionMaker: "m" })).toEqual({
      kind: "comment",
    });
  });
});

describe("JiraProvider (REST v2, injectable fetch, no network)", () => {
  const json = (body: unknown, status = 200) => ({
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

  it("creates an issue with project/issuetype wrappers, Basic email:token auth, and a browse url", async () => {
    let captured: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null = null;
    const jira = new JiraProvider({
      token: "bot@example.com:api-token",
      baseUrl: "https://acme.atlassian.net",
      fetchImpl: async (url, init) => {
        captured = {
          url,
          headers: init?.headers ?? {},
          body: JSON.parse(String(init?.body)),
        };
        return json({ id: "10042", key: "REG-7", self: "..." });
      },
    });
    const ref = await jira.createWorkItem("REG", "Task", { summary: "Build API", description: "initial" });
    expect(captured!.url).toBe("https://acme.atlassian.net/rest/api/2/issue");
    expect(captured!.headers.authorization).toBe(
      "Basic " + Buffer.from("bot@example.com:api-token").toString("base64"),
    );
    expect(captured!.body).toEqual({
      fields: {
        project: { key: "REG" },
        issuetype: { name: "Task" },
        summary: "Build API",
        description: "initial",
      },
    });
    expect(ref).toEqual({ id: "10042", url: "https://acme.atlassian.net/browse/REG-7" });
  });

  it("transitions by looking up the workflow's available transitions — explicit failure when none match", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const jira = new JiraProvider({
      token: "b:t",
      baseUrl: "https://acme.atlassian.net",
      fetchImpl: async (url, init) => {
        calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url.endsWith("/transitions") && init?.method === "GET") {
          return json({ transitions: [
            { id: "11", name: "Start progress", to: { name: "In Progress" } },
            { id: "31", name: "Done", to: { name: "Done" } },
          ] });
        }
        return { status: 204, json: async () => null, text: async () => "" };
      },
    });
    await jira.transitionState("REG", "10042", "In Progress");
    expect(calls[1]).toMatchObject({
      method: "POST",
      url: "https://acme.atlassian.net/rest/api/2/issue/10042/transitions",
      body: { transition: { id: "11" } },
    });

    await expect(jira.transitionState("REG", "10042", "Blocked")).rejects.toThrowError(
      /no transition to 'Blocked'.*In Progress, Done/,
    );
  });

  it("updates (204-empty tolerated), comments, and maps getWorkItem", async () => {
    const jira = new JiraProvider({
      token: "b:t",
      baseUrl: "https://acme.atlassian.net",
      fetchImpl: async (url, init) => {
        if (init?.method === "PUT") return { status: 204, json: async () => null, text: async () => "" };
        if (url.endsWith("/comment")) return json({ id: "c1" });
        return json({
          id: "10042",
          key: "REG-7",
          fields: {
            summary: "Build API",
            issuetype: { name: "Task" },
            status: { name: "In Progress" },
            priority: { name: "High" },
            comment: { comments: [{ body: "first" }, { body: "second" }] },
          },
        });
      },
    });
    await jira.updateFields("REG", "10042", { summary: "Renamed" });
    await jira.addComment("REG", "10042", "note");
    const item = await jira.getWorkItem("REG", "10042");
    expect(item.type).toBe("Task");
    expect(item.state).toBe("In Progress");
    expect(item.url).toBe("https://acme.atlassian.net/browse/REG-7");
    expect(item.comments).toEqual(["first", "second"]);
  });

  it("default mapping exists and the registry resolves jira (baseUrl required)", () => {
    const mapping = mappingFor("jira");
    expect(resolveTaskFields(mapping, { title: "T", description: "D" })).toEqual({
      summary: "T",
      description: "D",
    });
    expect(resolveStatus(mapping, "in_progress")).toBe("In Progress");
    // Jira's default workflow has no Blocked state — skipped, never invented
    expect(resolveStatus(mapping, "blocked")).toBeNull();

    expect(
      resolvePmProvider({ provider: "jira", token: "b:t", baseUrl: "https://a.atlassian.net" }).kind,
    ).toBe("jira");
    expect(() => resolvePmProvider({ provider: "jira", token: "b:t" })).toThrowError(/baseUrl/);
    for (const provider of ["asana", "monday", "generic_webhook"] as const) {
      expect(() => resolvePmProvider({ provider, token: "t" })).toThrowError(/not implemented/);
    }
  });
});

describe("LinearProvider (GraphQL, injectable fetch, no network)", () => {
  type Call = { query: string; variables: Record<string, unknown>; auth: string };
  function fakeLinear(handler: (call: Call) => unknown) {
    const calls: Call[] = [];
    const fetchImpl = async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
      const parsed = JSON.parse(String(init?.body));
      const call: Call = {
        query: parsed.query,
        variables: parsed.variables,
        auth: init?.headers?.authorization ?? "",
      };
      calls.push(call);
      return {
        status: 200,
        json: async () => ({ data: handler(call) }),
        text: async () => "",
      };
    };
    return { calls, fetchImpl };
  }

  it("resolves the team key once, creates issues, and returns the Linear url", async () => {
    const { calls, fetchImpl } = fakeLinear((call) => {
      if (call.query.includes("teams(filter")) return { teams: { nodes: [{ id: "team-uuid-1" }] } };
      return { issueCreate: { success: true, issue: { id: "issue-1", url: "https://linear.app/acme/issue/REG-1" } } };
    });
    const linear = new LinearProvider({ token: "lin_api_secret", fetchImpl });
    const ref = await linear.createWorkItem("REG", "Issue", { title: "Build API", description: "initial" });
    expect(calls[0]!.auth).toBe("lin_api_secret");
    expect(calls[0]!.variables).toEqual({ key: "REG" });
    expect(calls[1]!.variables).toEqual({
      input: { teamId: "team-uuid-1", title: "Build API", description: "initial" },
    });
    expect(ref).toEqual({ id: "issue-1", url: "https://linear.app/acme/issue/REG-1" });

    // the team id is cached — a second create resolves no team again
    await linear.createWorkItem("REG", "Issue", { title: "Second" });
    expect(calls.filter((c) => c.query.includes("teams(filter"))).toHaveLength(1);
  });

  it("transitions via the team's workflow states — explicit failure when the state is missing", async () => {
    const { calls, fetchImpl } = fakeLinear((call) => {
      if (call.query.includes("teams(filter")) return { teams: { nodes: [{ id: "team-uuid-1" }] } };
      if (call.query.includes("states")) {
        return { team: { states: { nodes: [
          { id: "st-1", name: "Todo" },
          { id: "st-2", name: "In Progress" },
          { id: "st-3", name: "Done" },
        ] } } };
      }
      return { issueUpdate: { success: true } };
    });
    const linear = new LinearProvider({ token: "t", fetchImpl });
    await linear.transitionState("REG", "issue-1", "In Progress");
    const update = calls.find((c) => c.query.includes("issueUpdate"))!;
    expect(update.variables).toEqual({ id: "issue-1", input: { stateId: "st-2" } });

    await expect(linear.transitionState("REG", "issue-1", "Blocked")).rejects.toThrowError(
      /no workflow state 'Blocked'.*Todo, In Progress, Done/,
    );
  });

  it("comments, reads issues into the neutral shape, and surfaces GraphQL errors", async () => {
    const { fetchImpl } = fakeLinear((call) => {
      if (call.query.includes("commentCreate")) return { commentCreate: { success: true } };
      return {
        issue: {
          id: "issue-1",
          url: "https://linear.app/acme/issue/REG-1",
          title: "Build API",
          description: "initial",
          priority: 2,
          state: { name: "In Progress" },
          comments: { nodes: [{ body: "first" }] },
        },
      };
    });
    const linear = new LinearProvider({ token: "t", fetchImpl });
    await linear.addComment("REG", "issue-1", "note");
    const item = await linear.getWorkItem("REG", "issue-1");
    expect(item).toMatchObject({
      id: "issue-1",
      type: "Issue",
      state: "In Progress",
      comments: ["first"],
    });
    expect(item.fields.title).toBe("Build API");

    const failing = new LinearProvider({
      token: "t",
      fetchImpl: async () => ({
        status: 200,
        json: async () => ({ errors: [{ message: "not authorized" }] }),
        text: async () => "",
      }),
    });
    await expect(failing.getWorkItem("REG", "x")).rejects.toThrowError(/not authorized/);
  });

  it("default mapping exists and the registry resolves linear", () => {
    const mapping = mappingFor("linear");
    expect(resolveTaskFields(mapping, { title: "T", description: "D" })).toEqual({
      title: "T",
      description: "D",
    });
    expect(resolveStatus(mapping, "in_review")).toBe("In Review");
    expect(resolveStatus(mapping, "blocked")).toBeNull();
    expect(resolvePmProvider({ provider: "linear", token: "lin_api_x" }).kind).toBe("linear");
  });
});
