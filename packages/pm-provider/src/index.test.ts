import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AsanaProvider,
  AzureDevOpsProvider,
  GenericWebhookProvider,
  JiraProvider,
  LinearProvider,
  MockPmProvider,
  MondayProvider,
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
    // every kind ships a default now — generic_webhook's is the identity mapping
    expect(mappingFor("generic_webhook").task.statusMap?.blocked).toBe("blocked");
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
  });

  it("writes against an unknown id auto-create the item (upsert across restarts); reads stay strict", async () => {
    const pm = new MockPmProvider();
    // a link minted by a previous process still mirrors after a "restart"
    await pm.transitionState("proj", "7", "Done");
    await pm.addComment("proj", "7", "mirrored after restart");
    const revived = await pm.getWorkItem("proj", "7");
    expect(revived.state).toBe("Done");
    expect(revived.comments).toEqual(["mirrored after restart"]);
    // upsert bumped the id counter — a fresh create never collides with "7"
    const fresh = await pm.createWorkItem("proj", "Task", { title: "n2" });
    expect(fresh.id).not.toBe("7");
    // reads on a genuinely unknown id still 404 (link verification depends on it)
    await expect(pm.getWorkItem("proj", "999")).rejects.toThrow(PmProviderError);
    // genuinely invalid input still fails loudly
    await expect(pm.transitionState("proj", "  ", "Done")).rejects.toThrow(PmProviderError);
    await expect(pm.transitionState("proj", "7", " ")).rejects.toThrow(PmProviderError);
    await expect(pm.updateFields(" ", "7", {})).rejects.toThrow(PmProviderError);
  });

  it("deleteWorkItem tombstones the id — no upsert resurrects it; reset() simulates a restart", async () => {
    const pm = new MockPmProvider();
    const ref = await pm.createWorkItem("proj", "Task", { title: "doomed" });
    await pm.deleteWorkItem("proj", ref.id);
    await expect(pm.getWorkItem("proj", ref.id)).rejects.toThrow(/deleted/);
    await expect(pm.addComment("proj", ref.id, "zombie")).rejects.toThrow(/deleted/);
    await expect(pm.updateFields("proj", ref.id, { title: "back?" })).rejects.toThrow(/deleted/);
    // new creates skip the tombstoned id
    const next = await pm.createWorkItem("proj", "Task", { title: "next" });
    expect(next.id).not.toBe(ref.id);
    // reset wipes items AND tombstones — a fresh process starts clean
    pm.reset();
    await pm.addComment("proj", ref.id, "new life in a new process");
    expect((await pm.getWorkItem("proj", ref.id)).comments).toEqual(["new life in a new process"]);
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
  it("returns a shared mock and requires baseUrl for ado and generic_webhook", () => {
    const a = resolvePmProvider({ provider: "mock", token: "" });
    const b = resolvePmProvider({ provider: "mock", token: "" });
    expect(a).toBe(b);
    expect(() => resolvePmProvider({ provider: "azure_devops", token: "t" })).toThrow(/baseUrl/);
    // the adapter matrix is complete — the last kind resolves with a baseUrl
    // and only ever fails without one, never as "not implemented"
    expect(() => resolvePmProvider({ provider: "generic_webhook", token: "t" })).toThrow(/baseUrl/);
    expect(
      resolvePmProvider({ provider: "generic_webhook", token: "t", baseUrl: "https://recv.example" }).kind,
    ).toBe("generic_webhook");
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
    // generic_webhook needs its baseUrl the same way — no kind is rejected anymore
    expect(() => resolvePmProvider({ provider: "generic_webhook", token: "t" })).toThrowError(/baseUrl/);
  });
});

describe("JiraProvider (REST v3 + ADF mode, injectable fetch, no network)", () => {
  // The v2 describe above IS the regression suite for the default: apiVersion
  // omitted must keep every /rest/api/2 path and plain-string body unchanged.
  const json = (body: unknown, status = 200) => ({
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

  it("creates against /rest/api/3 with the description converted to an ADF document", async () => {
    let captured: { url: string; body: Record<string, unknown> } | null = null;
    const jira = new JiraProvider({
      token: "bot@example.com:api-token",
      baseUrl: "https://acme.atlassian.net",
      apiVersion: 3,
      fetchImpl: async (url, init) => {
        captured = { url, body: JSON.parse(String(init?.body)) };
        return json({ id: "10042", key: "REG-7", self: "..." });
      },
    });
    await jira.createWorkItem("REG", "Task", {
      summary: "Build API",
      description: "# Goal\n\nShip the governed endpoint.",
    });
    expect(captured!.url).toBe("https://acme.atlassian.net/rest/api/3/issue");
    const fields = captured!.body.fields as Record<string, unknown>;
    expect(fields.summary).toBe("Build API"); // non-description fields stay plain
    const desc = fields.description as { version: number; type: string; content: unknown[] };
    expect(desc.version).toBe(1);
    expect(desc.type).toBe("doc");
    expect(desc.content.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(desc)).toContain("Ship the governed endpoint.");
  });

  it("addComment sends an ADF body to the v3 comment endpoint", async () => {
    let captured: { url: string; body: Record<string, unknown> } | null = null;
    const jira = new JiraProvider({
      token: "b:t",
      baseUrl: "https://acme.atlassian.net",
      apiVersion: 3,
      fetchImpl: async (url, init) => {
        captured = { url, body: JSON.parse(String(init?.body)) };
        return json({ id: "c1" });
      },
    });
    await jira.addComment("REG", "10042", "approved by dana");
    expect(captured!.url).toBe("https://acme.atlassian.net/rest/api/3/issue/10042/comment");
    const body = captured!.body.body as { version: number; type: string };
    expect(body.version).toBe(1);
    expect(body.type).toBe("doc");
    expect(JSON.stringify(body)).toContain("approved by dana");
  });

  it("getWorkItem converts an ADF description and ADF comment bodies back to readable text", async () => {
    const jira = new JiraProvider({
      token: "b:t",
      baseUrl: "https://acme.atlassian.net",
      apiVersion: 3,
      fetchImpl: async () =>
        json({
          id: "10042",
          key: "REG-7",
          fields: {
            summary: "Build API",
            issuetype: { name: "Task" },
            status: { name: "In Progress" },
            description: {
              version: 1,
              type: "doc",
              content: [
                { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Goal" }] },
                { type: "paragraph", content: [{ type: "text", text: "Ship it." }] },
              ],
            },
            comment: {
              comments: [
                {
                  body: {
                    version: 1,
                    type: "doc",
                    content: [{ type: "paragraph", content: [{ type: "text", text: "looks good" }] }],
                  },
                },
              ],
            },
          },
        }),
    });
    const item = await jira.getWorkItem("REG", "10042");
    expect(item.fields.description).toBe("# Goal\n\nShip it.");
    expect(item.comments).toEqual(["looks good"]);
    expect(item.state).toBe("In Progress");
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

describe("AsanaProvider (REST + data envelope, injectable fetch, no network)", () => {
  const envelope = (data: unknown, status = 200) => ({
    status,
    json: async () => ({ data }),
    text: async () => JSON.stringify({ data }),
  });

  it("creates tasks with Bearer auth, the {data} envelope, and the project in `projects`", async () => {
    let captured: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null = null;
    const asana = new AsanaProvider({
      token: "asana-pat",
      fetchImpl: async (url, init) => {
        captured = { url, headers: init?.headers ?? {}, body: JSON.parse(String(init?.body)) };
        return envelope({ gid: "1201", permalink_url: "https://app.asana.com/0/999/1201" });
      },
    });
    const ref = await asana.createWorkItem("999", "Task", { name: "Build API", notes: "initial" });
    expect(captured!.url).toBe("https://app.asana.com/api/1.0/tasks");
    expect(captured!.headers.authorization).toBe("Bearer asana-pat");
    expect(captured!.body).toEqual({
      data: { name: "Build API", notes: "initial", projects: ["999"] },
    });
    expect(ref).toEqual({ id: "1201", url: "https://app.asana.com/0/999/1201" });
  });

  it("transitions by moving the task into the section named like the state — explicit failure otherwise", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const asana = new AsanaProvider({
      token: "t",
      baseUrl: "https://fake.asana.local",
      fetchImpl: async (url, init) => {
        calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (/\/sections$/.test(url)) {
          return envelope([
            { gid: "sec-1", name: "To do" },
            { gid: "sec-2", name: "In progress" },
            { gid: "sec-3", name: "Done" },
          ]);
        }
        return envelope({});
      },
    });
    await asana.transitionState("999", "1201", "In progress");
    expect(calls[0]!.url).toBe("https://fake.asana.local/projects/999/sections");
    expect(calls[1]).toMatchObject({
      method: "POST",
      url: "https://fake.asana.local/sections/sec-2/addTask",
      body: { data: { task: "1201" } },
    });

    await expect(asana.transitionState("999", "1201", "Blocked")).rejects.toThrowError(
      /no section 'Blocked'.*To do, In progress, Done/,
    );
  });

  it("updates (data envelope), comments via stories, and reads section-as-state with filtered comments", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const asana = new AsanaProvider({
      token: "t",
      fetchImpl: async (url, init) => {
        calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (/\/stories$/.test(url) && init?.method === "POST") return envelope({ gid: "story-1" });
        if (/\/stories$/.test(url)) {
          return envelope([
            { resource_subtype: "comment_added", text: "first" },
            { resource_subtype: "added_to_project", text: "system noise" },
            { type: "comment", text: "second" },
          ]);
        }
        return envelope({
          gid: "1201",
          name: "Build API",
          notes: "initial",
          completed: false,
          permalink_url: "https://app.asana.com/0/999/1201",
          memberships: [
            { project: { gid: "888" }, section: { name: "Elsewhere" } },
            { project: { gid: "999" }, section: { name: "In progress" } },
          ],
        });
      },
    });
    await asana.updateFields("999", "1201", { name: "Renamed" });
    expect(calls[0]).toMatchObject({
      method: "PUT",
      url: "https://app.asana.com/api/1.0/tasks/1201",
      body: { data: { name: "Renamed" } },
    });
    await asana.addComment("999", "1201", "note");
    expect(calls[1]).toMatchObject({
      method: "POST",
      url: "https://app.asana.com/api/1.0/tasks/1201/stories",
      body: { data: { text: "note" } },
    });
    const item = await asana.getWorkItem("999", "1201");
    // state is the section of the membership matching THIS project, not the first
    expect(item.state).toBe("In progress");
    expect(item.fields).toEqual({ name: "Build API", notes: "initial", completed: false });
    expect(item.comments).toEqual(["first", "second"]); // system stories filtered out
    expect(item.url).toBe("https://app.asana.com/0/999/1201");
  });

  it("default mapping exists (no priority/blocked — Asana has neither) and the registry resolves asana", () => {
    const mapping = mappingFor("asana");
    expect(resolveTaskFields(mapping, { title: "T", description: "D" })).toEqual({
      name: "T",
      notes: "D",
    });
    expect(resolveStatus(mapping, "in_progress")).toBe("In progress");
    // no built-in priority field and no Blocked section — skipped, never invented
    expect(mapping.task.fields.priority).toBeUndefined();
    expect(resolveStatus(mapping, "blocked")).toBeNull();
    // baseUrl is optional like linear's — the default is app.asana.com
    expect(resolvePmProvider({ provider: "asana", token: "pat" }).kind).toBe("asana");
  });
});

describe("MondayProvider (GraphQL, injectable fetch, no network)", () => {
  type Call = { query: string; variables: Record<string, unknown>; auth: string };
  function fakeMonday(handler: (call: Call) => unknown) {
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

  it("creates items with raw-token auth and builds pulse urls from the board url, resolved once", async () => {
    let itemSeq = 0;
    const { calls, fetchImpl } = fakeMonday((call) => {
      if (call.query.includes("create_item")) {
        itemSeq += 1;
        return { create_item: { id: String(100 + itemSeq) } };
      }
      return { boards: [{ url: "https://acme.monday.com/boards/777" }] };
    });
    const monday = new MondayProvider({ token: "monday-api-token", fetchImpl });
    const ref = await monday.createWorkItem("777", "Item", { name: "Build API" });
    expect(calls[0]!.auth).toBe("monday-api-token");
    expect(calls[0]!.query).toContain("create_item(board_id: $board, item_name: $name)");
    expect(calls[0]!.variables).toEqual({ board: "777", name: "Build API" });
    // no permalink in the create response — the board url makes the pulse link
    expect(ref).toEqual({ id: "101", url: "https://acme.monday.com/boards/777/pulses/101" });

    // the board url is cached — a second create resolves no board again
    await monday.createWorkItem("777", "Item", { name: "Second" });
    expect(calls.filter((c) => c.query.includes("boards(ids"))).toHaveLength(1);
  });

  it("transitions via the Status column's settings_str labels — explicit failure when the label is missing", async () => {
    const { calls, fetchImpl } = fakeMonday((call) => {
      if (call.query.includes("columns")) {
        return { boards: [{ columns: [
          { id: "name", type: "name", settings_str: "{}" },
          { id: "status", type: "status", settings_str: JSON.stringify({ labels: { "0": "Working on it", "1": "Done", "2": "Stuck" } }) },
        ] }] };
      }
      return { change_simple_column_value: { id: "101" } };
    });
    const monday = new MondayProvider({ token: "t", fetchImpl });
    await monday.transitionState("777", "101", "Working on it");
    const move = calls.find((c) => c.query.includes("change_simple_column_value"))!;
    expect(move.variables).toEqual({ board: "777", item: "101", column: "status", value: "Working on it" });

    await expect(monday.transitionState("777", "101", "Blocked")).rejects.toThrowError(
      /no label 'Blocked'.*Working on it, Done, Stuck/,
    );
  });

  it("updates via stringified column_values, comments via create_update, and reads status text as state", async () => {
    const { calls, fetchImpl } = fakeMonday((call) => {
      if (call.query.includes("change_multiple_column_values")) {
        return { change_multiple_column_values: { id: "101" } };
      }
      if (call.query.includes("create_update")) return { create_update: { id: "u1" } };
      return { items: [{
        name: "Build API",
        url: "https://acme.monday.com/boards/777/pulses/101",
        column_values: [
          { id: "status", type: "status", text: "Working on it" },
          { id: "person", type: "people", text: "Mia" },
        ],
        updates: [{ text_body: "first" }, { text_body: "second" }],
      }] };
    });
    const monday = new MondayProvider({ token: "t", fetchImpl });
    await monday.updateFields("777", "101", { name: "Renamed" });
    expect(calls[0]!.variables).toEqual({
      board: "777", item: "101", values: JSON.stringify({ name: "Renamed" }),
    });
    await monday.addComment("777", "101", "note");
    expect(calls[1]!.variables).toEqual({ item: "101", body: "note" });
    const item = await monday.getWorkItem("777", "101");
    expect(item).toMatchObject({
      id: "101",
      type: "Item",
      state: "Working on it",
      comments: ["first", "second"],
    });
    // the item's own url is used — no board lookup happened on read
    expect(item.url).toBe("https://acme.monday.com/boards/777/pulses/101");
    expect(calls.some((c) => c.query.includes("boards(ids"))).toBe(false);
    expect(item.fields).toEqual({ name: "Build API", status: "Working on it", person: "Mia" });

    // failures surface from errors[] AND monday's top-level error_message
    const erroring = new MondayProvider({
      token: "t",
      fetchImpl: async () => ({
        status: 200,
        json: async () => ({ errors: [{ message: "not authorized" }] }),
        text: async () => "",
      }),
    });
    await expect(erroring.getWorkItem("777", "x")).rejects.toThrowError(/not authorized/);
    const topLevel = new MondayProvider({
      token: "t",
      fetchImpl: async () => ({
        status: 200,
        json: async () => ({ error_message: "Invalid token" }),
        text: async () => "",
      }),
    });
    await expect(topLevel.getWorkItem("777", "x")).rejects.toThrowError(/Invalid token/);
  });

  it("default mapping exists (blocked → Stuck; no not_started/in_review/description/priority) and the registry resolves monday", () => {
    const mapping = mappingFor("monday");
    // no native description field — only the title maps
    expect(resolveTaskFields(mapping, { title: "T", description: "D" })).toEqual({ name: "T" });
    expect(resolveStatus(mapping, "in_progress")).toBe("Working on it");
    expect(resolveStatus(mapping, "done")).toBe("Done");
    // monday's default Status column ships a "Stuck" label — blocked IS mapped
    expect(resolveStatus(mapping, "blocked")).toBe("Stuck");
    // no default labels for these — skipped, never invented
    expect(resolveStatus(mapping, "not_started")).toBeNull();
    expect(resolveStatus(mapping, "in_review")).toBeNull();
    expect(mapping.task.fields.description).toBeUndefined();
    expect(mapping.task.fields.priority).toBeUndefined();
    // baseUrl is optional like linear's — the default is api.monday.com
    expect(resolvePmProvider({ provider: "monday", token: "tok" }).kind).toBe("monday");
  });
});

describe("GenericWebhookProvider (signed normalized envelopes, injectable fetch, no network)", () => {
  type Envelope = {
    event?: string;
    timestamp?: unknown;
    project?: string;
    payload?: Record<string, unknown>;
  };
  type Captured = { url: string; headers: Record<string, string>; raw: string; body: Envelope };
  function fakeReceiver(handler: (body: Envelope) => { status?: number; body?: unknown }) {
    const calls: Captured[] = [];
    const fetchImpl = async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
      const raw = String(init?.body);
      const body = JSON.parse(raw) as Envelope;
      calls.push({ url, headers: init?.headers ?? {}, raw, body });
      const out = handler(body);
      return {
        status: out.status ?? 200,
        json: async () => out.body,
        text: async () => (out.body === undefined ? "" : JSON.stringify(out.body)),
      };
    };
    return { calls, fetchImpl };
  }

  it("create POSTs the envelope with a valid HMAC signature and uses the receiver's {id,url}; no id fails explicit", async () => {
    const { calls, fetchImpl } = fakeReceiver(() => ({
      body: { id: 7, url: "https://pm-bridge.example/items/7" },
    }));
    const hook = new GenericWebhookProvider({
      token: "shared-secret",
      baseUrl: "https://recv.example/regulait",
      fetchImpl,
    });
    const ref = await hook.createWorkItem("proj-1", "task", { title: "Build API", description: "initial" });
    expect(calls[0]!.url).toBe("https://recv.example/regulait");
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    // the signature is a deterministic HMAC-SHA256 of the EXACT body under the
    // connection token — recomputed here from the captured body
    expect(calls[0]!.headers["x-regulait-signature"]).toBe(
      "sha256=" + createHmac("sha256", "shared-secret").update(calls[0]!.raw).digest("hex"),
    );
    expect(calls[0]!.body).toMatchObject({
      event: "work_item.create",
      project: "proj-1",
      payload: { type: "task", fields: { title: "Build API", description: "initial" } },
    });
    expect(typeof calls[0]!.body.timestamp).toBe("string"); // ISO timestamp present; value not asserted
    expect(ref).toEqual({ id: "7", url: "https://pm-bridge.example/items/7" });

    // a receiver answering without an id fails explicit — links must be real, never invented
    const { fetchImpl: noId } = fakeReceiver(() => ({ body: { ok: true } }));
    const bad = new GenericWebhookProvider({ token: "s", baseUrl: "https://recv.example", fetchImpl: noId });
    await expect(bad.createWorkItem("p", "task", { title: "x" })).rejects.toThrowError(
      /did not return an id for work_item\.create/,
    );
  });

  it("update/transition/comment send the right events and payloads; non-2xx surfaces with status", async () => {
    const { calls, fetchImpl } = fakeReceiver(() => ({ body: {} }));
    const hook = new GenericWebhookProvider({ token: "s", baseUrl: "https://recv.example", fetchImpl });
    await hook.updateFields("p", "7", { title: "Renamed" });
    await hook.transitionState("p", "7", "in_progress");
    await hook.addComment("p", "7", "note");
    expect(calls.map((c) => c.body.event)).toEqual([
      "work_item.update",
      "work_item.transition",
      "comment.add",
    ]);
    expect(calls[0]!.body.payload).toEqual({ id: "7", fields: { title: "Renamed" } });
    expect(calls[1]!.body.payload).toEqual({ id: "7", state: "in_progress" });
    expect(calls[2]!.body.payload).toEqual({ id: "7", text: "note" });

    const failing = new GenericWebhookProvider({
      token: "s",
      baseUrl: "https://recv.example",
      fetchImpl: async () => ({ status: 503, json: async () => ({}), text: async () => "receiver down" }),
    });
    await expect(failing.transitionState("p", "7", "done")).rejects.toThrowError(
      /generic_webhook POST work_item\.transition failed: receiver down/,
    );
    const err = (await failing.addComment("p", "7", "x").catch((e: unknown) => e)) as PmProviderError;
    expect(err).toBeInstanceOf(PmProviderError);
    expect(err.status).toBe(503);
  });

  it("getWorkItem round-trips the receiver's work item; malformed responses fail explicit", async () => {
    const { calls, fetchImpl } = fakeReceiver(() => ({
      body: {
        id: "7",
        url: "https://pm-bridge.example/items/7",
        type: "task",
        state: "in_review",
        fields: { title: "Build API" },
        comments: ["first"],
      },
    }));
    const hook = new GenericWebhookProvider({ token: "s", baseUrl: "https://recv.example", fetchImpl });
    const item = await hook.getWorkItem("p", "7");
    expect(calls[0]!.body).toMatchObject({ event: "work_item.get", project: "p", payload: { id: "7" } });
    expect(item).toEqual({
      id: "7",
      url: "https://pm-bridge.example/items/7",
      type: "task",
      state: "in_review",
      fields: { title: "Build API" },
      comments: ["first"],
    });

    // a receiver without read-back (or a broken one) fails loud, never fakes an item
    const { fetchImpl: malformed } = fakeReceiver(() => ({ body: { nothing: "useful" } }));
    const broken = new GenericWebhookProvider({ token: "s", baseUrl: "https://recv.example", fetchImpl: malformed });
    await expect(broken.getWorkItem("p", "7")).rejects.toThrowError(/malformed work item/);
  });

  it("default mapping is the full identity map (all five states incl. blocked) and the registry needs a baseUrl", () => {
    const mapping = mappingFor("generic_webhook");
    expect(mapping.task.workItemType).toBe("task");
    expect(mapping.task.fields).toEqual({
      title: "title",
      status: "status",
      description: "description",
      priority: "priority",
    });
    expect(resolveTaskFields(mapping, { title: "T", description: "D" })).toEqual({ title: "T", description: "D" });
    // identity over ALL five statuses — blocked included; the receiver speaks
    // OUR vocabulary, so nothing is skipped and nothing is invented
    expect(mapping.task.statusMap).toEqual({
      not_started: "not_started",
      in_progress: "in_progress",
      in_review: "in_review",
      blocked: "blocked",
      done: "done",
    });
    expect(
      resolvePmProvider({ provider: "generic_webhook", token: "s", baseUrl: "https://recv.example" }).kind,
    ).toBe("generic_webhook");
    expect(() => resolvePmProvider({ provider: "generic_webhook", token: "s" })).toThrowError(/baseUrl/);
  });
});
