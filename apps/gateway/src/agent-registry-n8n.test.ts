/**
 * ADR-0336 slice 3: the n8n adapter against a fake n8n instance (no real instance; live instances are owner-gated).
 * Every call goes through the adapter's endpoint allow-list. The worker's own `checkRegistryAgents` is then run on
 * what the adapter produced.
 */
import { describe, expect, it } from "vitest";
import type { ScanContext, ScanSource } from "./discovery-scanners.js";
import { N8N_ENDPOINTS, N8N_SCANNER, endpointOrigin, n8nBase, n8nEndpoints, n8nTargetProblem, workflowAgents } from "./agent-registry-n8n.js";
import { allowListedFetch } from "./agent-platform-endpoints.js";
import { checkRegistryAgents } from "./agent-registry-records.js";

const BASE = "https://acme.app.n8n.cloud";
const KEY = ["n8n", "api", "synthetic", "key"].join("_");
/** free text a careless adapter might keep: it must never be staged */
const SECRET_TEXT = "SYSTEM-PROMPT-never-stored-sk_live_example";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const urlOf = (input: string | URL | Request) => new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

/** an agent workflow: chat trigger -> agent, fed by a model, an MCP client tool, a vector store and an HTTP tool */
const AGENT_WF = {
  id: "wfAgentAAAAAAAAA1",
  name: "Support agent",
  activeVersionId: "v1",
  isArchived: false,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  tags: [{ id: "t1", name: "support" }],
  nodes: [
    { id: "n1", name: "When chat message received", type: "@n8n/n8n-nodes-langchain.chatTrigger", parameters: {} },
    { id: "n2", name: "AI Agent", type: "@n8n/n8n-nodes-langchain.agent", parameters: { options: { systemMessage: SECRET_TEXT } } },
    { id: "n3", name: "OpenAI Chat Model", type: "@n8n/n8n-nodes-langchain.lmChatOpenAi", parameters: { model: { __rl: true, value: "gpt-4o-mini", mode: "list" } }, credentials: { openAiApi: { id: "credOpenAi01", name: "OpenAI prod" } } },
    { id: "n4", name: "MCP Client", type: "@n8n/n8n-nodes-langchain.mcpClientTool", parameters: { endpointUrl: `https://user:pw@mcp.example.com:8443/sse?token=${SECRET_TEXT}#x` } },
    { id: "n5", name: "Docs store", type: "@n8n/n8n-nodes-langchain.vectorStorePinecone", parameters: { mode: "retrieve-as-tool" }, disabled: true },
    { id: "n6", name: "Call CRM", type: "@n8n/n8n-nodes-langchain.toolHttpRequest", parameters: { url: "https://crm.example.com", headerValue: SECRET_TEXT }, credentials: { httpHeaderAuth: { id: "credCrm00001", name: "CRM header" } } },
    { id: "n7", name: "Memory", type: "@n8n/n8n-nodes-langchain.memoryBufferWindow", parameters: {} },
  ],
  connections: {
    "When chat message received": { main: [[{ node: "AI Agent", type: "main", index: 0 }]] },
    "OpenAI Chat Model": { ai_languageModel: [[{ node: "AI Agent", type: "ai_languageModel", index: 0 }]] },
    "MCP Client": { ai_tool: [[{ node: "AI Agent", type: "ai_tool", index: 0 }]] },
    "Docs store": { ai_tool: [[{ node: "AI Agent", type: "ai_tool", index: 0 }]] },
    "Call CRM": { ai_tool: [[{ node: "AI Agent", type: "ai_tool", index: 0 }]] },
    Memory: { ai_memory: [[{ node: "AI Agent", type: "ai_memory", index: 0 }]] },
  },
  pinData: { "AI Agent": [{ json: { secret: SECRET_TEXT } }] },
};
/** a plain workflow (no AI agent): not staged */
const PLAIN_WF = { id: "wfPlainBBBBBBBBB2", name: "Nightly export", active: true, nodes: [{ id: "p1", name: "Cron", type: "n8n-nodes-base.scheduleTrigger", parameters: {} }], connections: {} };
/** a second agent workflow on the next page, inactive, using the deprecated `active` flag */
const AGENT_WF_2 = {
  id: "wfAgentCCCCCCCCC3",
  name: "Triage",
  active: false,
  nodes: [
    { id: "m1", name: "Agent", type: "@n8n/n8n-nodes-langchain.agent", parameters: {} },
    { id: "m2", name: "Claude", type: "@n8n/n8n-nodes-langchain.lmChatAnthropic", parameters: { model: "claude-sonnet-4-5" } },
  ],
  connections: { Claude: { ai_languageModel: [[{ node: "Agent", type: "ai_languageModel", index: 0 }]] } },
};

interface FakeOpts {
  scopes?: unknown;
  discoverStatus?: number;
  nextCursor?: unknown;
  page2Status?: number;
  page1Status?: number;
}

function fakeN8n(opts: FakeOpts = {}) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = urlOf(input);
    const headers = new Headers(init?.headers);
    if (headers.get("x-n8n-api-key") !== KEY) return json({ message: "unauthorized" }, 401);
    if (url.pathname === "/api/v1/discover") {
      if (opts.discoverStatus) return json({ message: "not found" }, opts.discoverStatus);
      return json({ data: { scopes: opts.scopes ?? ["workflow:list", "workflow:read"], resources: {} } });
    }
    if (url.pathname === "/api/v1/workflows") {
      if (url.searchParams.get("excludePinnedData") !== "true") return json({ data: [AGENT_WF] });
      if (opts.page1Status) return json({ message: "down" }, opts.page1Status);
      if (url.searchParams.get("cursor") === "Y3Vyc29yMg==") {
        if (opts.page2Status) return json({ message: "boom" }, opts.page2Status);
        return json({ data: [AGENT_WF_2], nextCursor: null });
      }
      const { pinData: _drop, ...wf } = AGENT_WF;
      return json({ data: [wf, PLAIN_WF], nextCursor: opts.nextCursor === undefined ? "Y3Vyc29yMg==" : opts.nextCursor });
    }
    return json({}, 404);
  }) as typeof fetch;
}

function run(opts: FakeOpts = {}, source: Partial<ScanSource> = {}) {
  const f = fakeN8n(opts);
  const calls = { urls: [] as string[], methods: [] as string[] };
  const ctx: ScanContext = {
    source: { id: "s-n8n", name: "n8n", kind: "agent_registry_n8n", target: { baseUrl: `${BASE}/` }, scope: { orgLevel: true, include: [] }, ...source },
    credential: { mode: "static", publicConfig: {}, secret: KEY },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.urls.push(urlOf(input).href);
      calls.methods.push((init?.method ?? "GET").toUpperCase());
      return f(input, init);
    }) as typeof fetch,
    throttle: async () => undefined,
    backoff: async () => false,
    recordRaw: () => undefined,
    registerSecret: () => undefined,
    pseudonymise: async () => "psn:000000000000000000000000",
    heartbeat: async () => true,
    signal: new AbortController().signal,
    catalogue: { matches: () => true, rows: () => [] },
  };
  return { promise: N8N_SCANNER.run(ctx), calls };
}

describe("ADR-0336 agent_registry_n8n: targets", () => {
  it("names an https instance address, optionally under a path prefix; anything else is refused before a write", () => {
    expect(n8nTargetProblem({ baseUrl: BASE }, { orgLevel: true, include: [] })).toBeNull();
    expect(n8nBase("https://n8n.internal.example.com:5678/automation/")).toEqual({ origin: "https://n8n.internal.example.com:5678", prefix: "/automation" });
    for (const bad of ["http://acme.app.n8n.cloud", "https://user:pw@acme.app.n8n.cloud", "https://acme.app.n8n.cloud/api/v1", "https://acme.app.n8n.cloud/?x=1", "https://acme.app.n8n.cloud/#f", "https://acme.app.n8n.cloud/a b", "not a url", ""]) {
      expect(n8nTargetProblem({ baseUrl: bad }, { orgLevel: true, include: [] }), bad).toMatch(/baseUrl/);
    }
    expect(n8nTargetProblem({ baseUrl: BASE }, { orgLevel: false, include: ["../credentials"] })).toMatch(/workflow ids/);
  });
});

describe("ADR-0336 agent_registry_n8n: the read", () => {
  it("stages only agent workflows, with model, MCP server, tools, knowledge and credential references; read-only verified by /discover; GET only", async () => {
    const { promise, calls } = run();
    const res = await promise;
    expect(res.credentialWriteScope).toBe("read_only");
    expect(res.registriesComplete).toEqual(["n8n"]);
    expect(res.registryAgents!.map((r) => r.externalId)).toEqual(["acme.app.n8n.cloud/wfAgentAAAAAAAAA1", "acme.app.n8n.cloud/wfAgentCCCCCCCCC3"]);
    const [support, triage] = res.registryAgents!;
    expect(support!.displayName).toBe("Support agent");
    expect(support!.attributes).toMatchObject({ instance: "acme.app.n8n.cloud", workflowId: AGENT_WF.id, state: "active", archived: false, agentNodes: "1", tags: ["support"] });
    expect(triage!.attributes).toMatchObject({ state: "inactive" });
    expect(support!.components).toEqual([
      { kind: "model", vendorRef: "@n8n/n8n-nodes-langchain.lmChatOpenAi:gpt-4o-mini", displayName: "gpt-4o-mini", enabled: true, providedBy: null },
      { kind: "mcp_server", vendorRef: "https://mcp.example.com:8443", displayName: "https://mcp.example.com:8443", enabled: true, providedBy: null },
      { kind: "knowledge", vendorRef: "@n8n/n8n-nodes-langchain.vectorStorePinecone:n5", displayName: "Docs store", enabled: false, providedBy: null },
      { kind: "tool", vendorRef: "@n8n/n8n-nodes-langchain.toolHttpRequest:n6", displayName: "Call CRM", enabled: true, providedBy: null },
      { kind: "connected_app", vendorRef: "openAiApi:credOpenAi01", displayName: "OpenAI prod", enabled: null, providedBy: "maker" },
      { kind: "connected_app", vendorRef: "httpHeaderAuth:credCrm00001", displayName: "CRM header", enabled: null, providedBy: "maker" },
    ]);
    expect(triage!.components).toEqual([{ kind: "model", vendorRef: "@n8n/n8n-nodes-langchain.lmChatAnthropic:claude-sonnet-4-5", displayName: "claude-sonnet-4-5", enabled: true, providedBy: null }]);
    // decision 4: no system message, header value, URL path or query, userinfo or pinned data is staged anywhere
    const staged = JSON.stringify(res);
    expect(staged).not.toContain(SECRET_TEXT);
    expect(staged).not.toContain("user:pw");
    expect(staged).not.toContain("/sse");
    // pinned data excluded at the source; the cursor passed back on our own path; GET only, on the allow-listed paths
    const paths = calls.urls.map((u) => new URL(u));
    expect(paths.map((u) => u.pathname)).toEqual(["/api/v1/discover", "/api/v1/workflows", "/api/v1/workflows"]);
    expect(paths.slice(1).every((u) => u.searchParams.get("excludePinnedData") === "true")).toBe(true);
    expect(paths[2]!.searchParams.get("cursor")).toBe("Y3Vyc29yMg==");
    expect(new Set(calls.methods)).toEqual(new Set(["GET"]));
    // the worker's own check accepts it
    expect(() => checkRegistryAgents("agent_registry_n8n", res.registryAgents, res.registriesComplete)).not.toThrow();
  });

  it("a key with any write scope is refused before a workflow is read", async () => {
    const { promise, calls } = run({ scopes: ["workflow:read", "workflow:list", "workflow:activate"] });
    const res = await promise;
    expect(res.credentialWriteScope).toBe("write");
    expect(res.registryAgents).toBeUndefined();
    expect(res.readOutcomes![0]).toMatchObject({ status: "denied", detail: expect.stringContaining("workflow:activate") });
    expect(calls.urls.map((u) => new URL(u).pathname)).toEqual(["/api/v1/discover"]);
  });

  it("an instance without /discover (before 2.14), or one that lists no scopes, is read but stays unverified", async () => {
    for (const opts of [{ discoverStatus: 404 }, { scopes: [] }] as FakeOpts[]) {
      const res = await run(opts).promise;
      expect(res.credentialWriteScope).toBe("unverified");
      expect(res.registryAgents).toHaveLength(2);
      expect(res.readOutcomes!.some((o) => o.read.startsWith("credential scopes") && /could not be checked/.test(o.detail ?? ""))).toBe(true);
    }
  });

  it("an unreachable workflow listing reads nothing and marks nothing absent; the outcome says so", async () => {
    const res = await run({ page1Status: 503 }).promise;
    expect(res.registriesComplete).toEqual([]);
    expect(res.registryAgents).toEqual([]);
    expect(res.readOutcomes![0]).toMatchObject({ read: "workflows in acme.app.n8n.cloud", status: "error" });
  });

  it("a cursor of the wrong shape, or a failed page, is partial: nothing is marked absent", async () => {
    for (const opts of [{ nextCursor: "https://evil.example.com/next" }, { page2Status: 500 }] as FakeOpts[]) {
      const res = await run(opts).promise;
      expect(res.registriesComplete).toEqual([]);
      expect(res.registryAgents!.map((r) => r.displayName)).toEqual(["Support agent"]);
    }
  });

  it("include scope keeps only the named workflows", async () => {
    const res = await run({}, { scope: { orgLevel: false, include: ["wfAgentCCCCCCCCC3"] } }).promise;
    expect(res.registryAgents!.map((r) => r.displayName)).toEqual(["Triage"]);
  });
});

describe("ADR-0336 agent_registry_n8n: the endpoint allow-list and the graph", () => {
  it("admits GET /api/v1/discover and /api/v1/workflows under the prefix only; credentials, activate and another origin are refused before sending", async () => {
    expect(N8N_ENDPOINTS.map((r) => r.method)).toEqual(["GET", "GET"]);
    expect(N8N_ENDPOINTS.map((r) => r.path.test("/api/v1/discover") || r.path.test("/api/v1/workflows"))).toEqual([true, true]);
    expect(N8N_ENDPOINTS.some((r) => r.path.test("/api/v1/credentials") || r.path.test("/api/v1/workflows/x"))).toBe(false);
    let sent = 0;
    const base = (async () => {
      sent++;
      return json({});
    }) as typeof fetch;
    const f = allowListedFetch(base, new Set(["https://n8n.example.com"]), n8nEndpoints("/automation"));
    await f("https://n8n.example.com/automation/api/v1/workflows?limit=1");
    for (const [url, method] of [
      ["https://n8n.example.com/automation/api/v1/credentials", "GET"],
      ["https://n8n.example.com/automation/api/v1/workflows/abc/deactivate", "POST"],
      ["https://n8n.example.com/automation/api/v1/workflows", "POST"],
      ["https://n8n.example.com/api/v1/workflows", "GET"],
      ["https://evil.example.com/automation/api/v1/workflows", "GET"],
      ["http://n8n.example.com/automation/api/v1/workflows", "GET"],
    ] as const) {
      await expect(f(url, { method })).rejects.toThrow(/refused before sending/);
    }
    expect(sent).toBe(1);
    expect(() => n8nEndpoints("/a(b")).toThrow();
  });

  it("an MCP endpoint is reduced to its origin; a workflow without an agent stages nothing; an unreadable graph keeps the stored components", () => {
    expect(endpointOrigin("https://u:p@mcp.example.com/sse?token=x#y")).toBe("https://mcp.example.com");
    expect(endpointOrigin("javascript:alert(1)")).toBeNull();
    expect(workflowAgents(PLAIN_WF.nodes, PLAIN_WF.connections)).toEqual({ agents: 0, components: [] });
    expect(workflowAgents(AGENT_WF.nodes, { "OpenAI Chat Model": { ai_languageModel: "not a list" }, x: { ai_languageModel: [[{ node: "AI Agent" }]] } }).components).toBeNull();
    const many = Array.from({ length: 1001 }, (_, i) => ({ id: `n${i}`, name: `n${i}`, type: "x", parameters: {} }));
    expect(workflowAgents([...AGENT_WF.nodes, ...many], AGENT_WF.connections).components).toBeNull();
  });
});
