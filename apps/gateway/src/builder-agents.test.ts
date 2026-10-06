/**
 * ADR-0172 — the agent builder: agents, sharing, edit authz, toolbox
 * entitlement, sub-agents, templates, memory, schedules, channels.
 *
 * Every authorization rule here is asserted on BOTH sides (the allowed actor
 * succeeds, the disallowed one is refused by name), so a test cannot pass
 * because a route simply refuses everything.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  and,
  auditLog,
  builderAgentSchedules,
  chatopsConnections,
  connectors,
  eq,
  mcpServers,
  mcpTools,
} from "@regulait/db";
import { BUILDER_AGENT_COLORS } from "@regulait/shared";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import { BUILDER_TEMPLATES } from "./builder-catalog.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";

// ADR-0181: this file pins behaviour against a LOCAL MCP double (127.0.0.1, registered
// seconds ago), not the strict admission defaults — relaxed explicitly, restored after.
let restoreStrictAdmission: (() => Promise<void>) | undefined;

let k: BuilderKit;
let owner: Person;
let colleague: Person;
let named: Person;
let outsider: Person;
let admin: Person;
let modelA = "";
let modelB = "";

const newAgent = async (who: Person, extra: Record<string, unknown> = {}) => {
  const r = await k.req("POST", "/v1/builder/agents", who.auth, {
    name: `Agent ${Math.random().toString(36).slice(2, 7)}`,
    connectionFormat: "shared",
    computerUse: false,
    projectId: who.projectId,
    ...extra,
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().agent as Record<string, any>;
};
const auditRows = (objectId: string, ruleId: string) =>
  k.db.select().from(auditLog).where(and(eq(auditLog.objectId, objectId), eq(auditLog.ruleId, ruleId)));

beforeAll(async () => {
  k = await builderKit("bld-agents");
  restoreStrictAdmission = await relaxStrictAdmissionForTest(k.db);
  [owner, colleague, named, outsider] = await Promise.all([
    k.person("owner"),
    k.person("colleague"),
    k.person("named"),
    k.person("outsider"),
  ]);
  admin = await k.person("admin", { admin: true });
  modelA = await k.model("model-a");
  modelB = await k.model("model-b");
  await k.grantModel(owner.id, modelA);
  await k.grantModel(admin.id, modelA);
}, 120_000);

/** ChatOps connections this file inserts. They are org-visible (an enabled
 * one older than another suite's becomes that suite's default destination —
 * chatops.test's un-named post picked this file's outlook connection and got
 * 501), so they are removed even when a test fails. */
const chatopsRows: Array<{ connectionId: string; connectorId: string }> = [];

afterAll(async () => {
  await restoreStrictAdmission?.();
  for (const r of chatopsRows) {
    await k.db.delete(chatopsConnections).where(eq(chatopsConnections.id, r.connectionId));
    await k.db.delete(connectors).where(eq(connectors.id, r.connectorId));
  }
  await k.close();
});

describe("identity", () => {
  it("refuses an identity-less token on every builder route family", async () => {
    for (const [m, url] of [
      ["GET", "/v1/builder/agents"],
      ["GET", "/v1/builder/threads"],
      ["GET", "/v1/builder/skills"],
      ["GET", "/v1/builder/templates"],
      ["GET", "/v1/builder/integrations"],
      ["GET", "/v1/builder/usage"],
    ] as const) {
      const r = await k.req(m, url, k.BOOT);
      expect(r.statusCode, url).toBe(403);
      expect(r.json().error).toBe("builder_requires_identity");
    }
    const create = await k.req("POST", "/v1/builder/agents", k.BOOT, { name: "x", connectionFormat: "shared", computerUse: false });
    expect(create.json().error).toBe("builder_requires_identity");
    // positive control: a signed-in person passes the same gate
    expect((await k.req("GET", "/v1/builder/agents", owner.auth)).statusCode).toBe(200);
  });
});

describe("create, read, update, delete", () => {
  it("creates with the caller's first allowed model by default and audits it", async () => {
    const a = await newAgent(owner, { description: "triage helper" });
    expect(a.modelAgent?.id).toBe(modelA);
    expect(a.ownerUserId).toBe(owner.id);
    expect(a.sharing).toBe("private");
    expect(a.connectionFormat).toBe("shared");
    expect(a.canEdit).toBe(true);
    expect(a.spentThisMonthUsd).toBe(0);
    expect(await auditRows(a.id, "builder-agent-created")).toHaveLength(1);
  });

  it("refuses a model the caller may not use (model_not_entitled), accepts one they may", async () => {
    const r = await k.req("POST", "/v1/builder/agents", owner.auth, {
      name: "Nope", connectionFormat: "shared", computerUse: false, modelAgentId: modelB, projectId: owner.projectId,
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("model_not_entitled");
    const ok = await newAgent(owner, { modelAgentId: modelA });
    expect(ok.modelAgent.id).toBe(modelA);
    const patch = await k.req("PATCH", `/v1/builder/agents/${ok.id}`, owner.auth, { modelAgentId: modelB });
    expect(patch.statusCode).toBe(403);
    expect(patch.json().error).toBe("model_not_entitled");
  });

  it("validates input (name length, limit range)", async () => {
    const r = await k.req("POST", "/v1/builder/agents", owner.auth, { name: "x".repeat(81), connectionFormat: "shared", computerUse: false });
    expect(r.statusCode).toBe(400);
    const a = await newAgent(owner);
    expect((await k.req("PATCH", `/v1/builder/agents/${a.id}`, owner.auth, { monthlyLimitUsd: 0 })).statusCode).toBe(400);
    expect((await k.req("PATCH", `/v1/builder/agents/${a.id}`, owner.auth, { monthlyLimitUsd: 100001 })).statusCode).toBe(400);
  });

  it("updates fields, audits a limit change separately, and locks the connection format (409)", async () => {
    const a = await newAgent(owner, { connectionFormat: "per_user" });
    const r = await k.req("PATCH", `/v1/builder/agents/${a.id}`, owner.auth, {
      name: "Renamed", instructions: "# Do things", color: "#7C3AED", monthlyLimitUsd: 12.5, computerUse: true,
    });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json().agent;
    expect(b.name).toBe("Renamed");
    expect(b.color).toBe("#7c3aed"); // stored lower case
    expect(b.instructions).toBe("# Do things");
    expect(b.monthlyLimitUsd).toBe(12.5);
    expect(b.computerUse).toBe(true);
    expect(await auditRows(a.id, "builder-agent-limit-changed")).toHaveLength(1);
    expect(await auditRows(a.id, "builder-agent-updated")).toHaveLength(1);

    const lock = await k.req("PATCH", `/v1/builder/agents/${a.id}`, owner.auth, { connectionFormat: "shared" });
    expect(lock.statusCode).toBe(409);
    expect(lock.json().error).toBe("connection_format_locked");
    expect((await k.req("GET", `/v1/builder/agents/${a.id}`, owner.auth)).json().agent.connectionFormat).toBe("per_user");
  });

  it("colours come from the shared palette only (white initials keep AA), and the web mirrors it", async () => {
    const a = await newAgent(owner);
    expect(BUILDER_AGENT_COLORS as readonly string[]).toContain(a.color);
    const off = await k.req("PATCH", `/v1/builder/agents/${a.id}`, owner.auth, { color: "#5b6cff" });
    expect(off.statusCode).toBe(400);
    const on = await k.req("PATCH", `/v1/builder/agents/${a.id}`, owner.auth, { color: BUILDER_AGENT_COLORS[3] });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().agent.color).toBe(BUILDER_AGENT_COLORS[3]);
    // the SPA's AGENT_COLORS must be this exact list, in order (drift guard)
    const webLogic = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/src/views/builder/builderLogic.ts"),
      "utf8",
    );
    const m = /export const AGENT_COLORS = \[([^\]]*)\]/.exec(webLogic);
    expect(m, "AGENT_COLORS not found in builderLogic.ts").not.toBeNull();
    expect([...m![1]!.matchAll(/"(#[0-9a-f]{6})"/g)].map((x) => x[1])).toEqual([...BUILDER_AGENT_COLORS]);
  });

  it("delete archives: 204, then hidden from list and detail", async () => {
    const a = await newAgent(owner);
    expect((await k.req("DELETE", `/v1/builder/agents/${a.id}`, owner.auth)).statusCode).toBe(204);
    expect((await k.req("GET", `/v1/builder/agents/${a.id}`, owner.auth)).statusCode).toBe(404);
    const list = (await k.req("GET", "/v1/builder/agents", owner.auth)).json().agents as Array<{ id: string }>;
    expect(list.some((x) => x.id === a.id)).toBe(false);
    expect(await auditRows(a.id, "builder-agent-deleted")).toHaveLength(1);
  });
});

describe("visibility and sharing", () => {
  it("private → owner + admin; workspace → everyone; people → listed people only", async () => {
    const a = await newAgent(owner);
    const sees = async (who: Person) => {
      const list = (await k.req("GET", "/v1/builder/agents", who.auth)).json().agents as Array<{ id: string }>;
      const detail = await k.req("GET", `/v1/builder/agents/${a.id}`, who.auth);
      expect(list.some((x) => x.id === a.id)).toBe(detail.statusCode === 200);
      return detail.statusCode === 200;
    };
    expect(await sees(owner)).toBe(true);
    expect(await sees(admin)).toBe(true);
    expect(await sees(colleague)).toBe(false);
    expect(await sees(named)).toBe(false);

    const ws = await k.req("PATCH", `/v1/builder/agents/${a.id}`, owner.auth, { sharing: "workspace" });
    expect(ws.statusCode).toBe(200);
    expect(await sees(colleague)).toBe(true);
    expect(await sees(outsider)).toBe(true);

    const ppl = await k.req("PATCH", `/v1/builder/agents/${a.id}`, owner.auth, { sharing: "people", sharedUserIds: [named.id] });
    expect(ppl.statusCode).toBe(200);
    expect(ppl.json().agent.sharedUsers).toEqual([{ id: named.id, name: `named ${k.RUN}` }]);
    expect(await sees(named)).toBe(true);
    expect(await sees(colleague)).toBe(false);
    expect(await sees(outsider)).toBe(false);
    expect((await auditRows(a.id, "builder-agent-sharing-changed")).length).toBe(2);
  });

  it("edit is owner or admin: a viewer gets 403, an outsider 404", async () => {
    const a = await newAgent(owner);
    await k.req("PATCH", `/v1/builder/agents/${a.id}`, owner.auth, { sharing: "workspace" });
    const viewer = await k.req("PATCH", `/v1/builder/agents/${a.id}`, colleague.auth, { name: "hijack" });
    expect(viewer.statusCode).toBe(403);
    expect(viewer.json().error).toBe("not_agent_editor");
    expect((await k.req("DELETE", `/v1/builder/agents/${a.id}`, colleague.auth)).statusCode).toBe(403);
    expect((await k.req("GET", `/v1/builder/agents/${a.id}`, colleague.auth)).json().agent.canEdit).toBe(false);

    await k.req("PATCH", `/v1/builder/agents/${a.id}`, owner.auth, { sharing: "private" });
    expect((await k.req("PATCH", `/v1/builder/agents/${a.id}`, colleague.auth, { name: "x" })).statusCode).toBe(404);

    const byAdmin = await k.req("PATCH", `/v1/builder/agents/${a.id}`, admin.auth, { name: "Admin rename" });
    expect(byAdmin.statusCode).toBe(200);
    expect(byAdmin.json().agent.name).toBe("Admin rename");
  });
});

describe("toolbox", () => {
  let grantedConnector = "";
  let ungrantedConnector = "";
  let grantedTool = "";
  let ungrantedTool = "";

  beforeAll(async () => {
    const mk = async (name: string, kind: string) =>
      (await k.req("POST", "/v1/connectors", k.BOOT, { name: `${name}-${k.RUN}`, kind })).json().id as string;
    grantedConnector = await mk("crm", "salesforce");
    ungrantedConnector = await mk("tracker", "jira");
    await k.req("POST", "/v1/grants/connectors", k.BOOT, { userId: owner.id, connectorId: grantedConnector, mode: "read" });
    const [server] = await k.db
      .insert(mcpServers)
      .values({ name: `docs-mcp-${k.RUN}`, url: "https://mcp.example.com/docs" })
      .returning();
    const tools = await k.db
      .insert(mcpTools)
      .values([
        { serverId: server!.id, name: "search", kind: "read" },
        { serverId: server!.id, name: "delete_page", kind: "write" },
      ])
      .returning();
    grantedTool = tools.find((t) => t.name === "search")!.id;
    ungrantedTool = tools.find((t) => t.name === "delete_page")!.id;
    await k.req("POST", "/v1/grants/tools", k.BOOT, { userId: owner.id, serverId: server!.id, toolName: "search" });
  });

  it("accepts tools the editor holds grants for, with names, providers and entitledForYou", async () => {
    const a = await newAgent(owner);
    const r = await k.req("PUT", `/v1/builder/agents/${a.id}/tools`, owner.auth, {
      tools: [
        { kind: "connector", refId: grantedConnector, requiresApproval: true },
        { kind: "mcp_tool", refId: grantedTool, requiresApproval: false },
      ],
    });
    expect(r.statusCode, r.body).toBe(200);
    const tools = r.json().agent.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ kind: "connector", name: `crm-${k.RUN}`, provider: "salesforce", requiresApproval: true, entitledForYou: true });
    expect(tools[1]).toMatchObject({ kind: "mcp_tool", name: "search", provider: `docs-mcp-${k.RUN}`, entitledForYou: true });
    expect(r.json().agent.toolCount).toBe(2);
    const [toolsAudit] = await auditRows(a.id, "builder-agent-tools-changed");
    expect(toolsAudit).toBeTruthy();
    // ADR-0181: the toolbox write is audited old -> new, keyed kind:refId (null = not in the toolbox)
    expect((toolsAudit!.detail as { transitions: Record<string, unknown> }).transitions).toEqual({
      [`connector:${grantedConnector}`]: { from: null, to: { requiresApproval: true } },
      [`mcp_tool:${grantedTool}`]: { from: null, to: { requiresApproval: false } },
    });
    // relaxing ask-first on the connector is a transition of its own
    await k.req("PUT", `/v1/builder/agents/${a.id}/tools`, owner.auth, {
      tools: [
        { kind: "connector", refId: grantedConnector, requiresApproval: false },
        { kind: "mcp_tool", refId: grantedTool, requiresApproval: false },
      ],
    });
    const relaxed = (await auditRows(a.id, "builder-agent-tools-changed")).find(
      (row) => (row.detail as { transitions: Record<string, unknown> }).transitions[`connector:${grantedConnector}`] !== undefined && row.id !== toolsAudit!.id,
    );
    expect((relaxed!.detail as { transitions: Record<string, unknown> }).transitions).toEqual({
      [`connector:${grantedConnector}`]: { from: { requiresApproval: true }, to: { requiresApproval: false } },
    });

    // the same agent, seen by a workspace viewer who holds none of the grants
    await k.req("PATCH", `/v1/builder/agents/${a.id}`, owner.auth, { sharing: "workspace" });
    const seen = (await k.req("GET", `/v1/builder/agents/${a.id}`, colleague.auth)).json().agent.tools as Array<{ entitledForYou: boolean }>;
    expect(seen.map((t) => t.entitledForYou)).toEqual([false, false]);
  });

  it("refuses a connector the editor holds no grant for — tool_not_entitled naming it — and changes nothing", async () => {
    const a = await newAgent(owner);
    await k.req("PUT", `/v1/builder/agents/${a.id}/tools`, owner.auth, { tools: [{ kind: "connector", refId: grantedConnector, requiresApproval: false }] });
    const r = await k.req("PUT", `/v1/builder/agents/${a.id}/tools`, owner.auth, {
      tools: [
        { kind: "connector", refId: grantedConnector, requiresApproval: false },
        { kind: "connector", refId: ungrantedConnector, requiresApproval: false },
      ],
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("tool_not_entitled");
    expect(r.json().tool).toEqual({ kind: "connector", refId: ungrantedConnector, name: `tracker-${k.RUN}` });
    expect((await k.req("GET", `/v1/builder/agents/${a.id}`, owner.auth)).json().agent.tools).toHaveLength(1);
    expect(await auditRows(a.id, "builder-agent-tool-not-entitled")).toHaveLength(1);
  });

  it("refuses an MCP tool the editor may not see, and an admin is bounded by their own grants too", async () => {
    const a = await newAgent(owner);
    const r = await k.req("PUT", `/v1/builder/agents/${a.id}/tools`, owner.auth, {
      tools: [{ kind: "mcp_tool", refId: ungrantedTool, requiresApproval: true }],
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().tool.name).toBe(`docs-mcp-${k.RUN}/delete_page`);
    const byAdmin = await k.req("PUT", `/v1/builder/agents/${a.id}/tools`, admin.auth, {
      tools: [{ kind: "connector", refId: grantedConnector, requiresApproval: false }],
    });
    expect(byAdmin.statusCode).toBe(403);
    expect(byAdmin.json().error).toBe("tool_not_entitled");
  });

  it("toolbox-options lists exactly what the caller may add, with the ids PUT accepts", async () => {
    const r = await k.req("GET", "/v1/builder/toolbox-options", owner.auth);
    expect(r.statusCode, r.body).toBe(200);
    const options = r.json().options as Array<Record<string, unknown>>;
    const mine = options.filter((o) => o.refId === grantedConnector || o.refId === grantedTool || o.refId === ungrantedConnector || o.refId === ungrantedTool);
    expect(mine).toEqual([
      { kind: "connector", refId: grantedConnector, name: `crm-${k.RUN}`, provider: "salesforce" },
      { kind: "mcp_tool", refId: grantedTool, name: "search", provider: `docs-mcp-${k.RUN}`, access: "read" },
    ]);
    // every listed option is accepted by the PUT check (the two cannot disagree)
    const a = await newAgent(owner);
    const put = await k.req("PUT", `/v1/builder/agents/${a.id}/tools`, owner.auth, {
      tools: options.map((o) => ({ kind: o.kind, refId: o.refId, requiresApproval: false })),
    });
    expect(put.statusCode, put.body).toBe(200);
    // someone with no grants sees none of these; an identity-less token is refused
    const none = (await k.req("GET", "/v1/builder/toolbox-options", outsider.auth)).json().options as Array<{ refId: string }>;
    expect(none.map((o) => o.refId)).not.toContain(grantedConnector);
    expect(none.map((o) => o.refId)).not.toContain(grantedTool);
    expect((await k.req("GET", "/v1/builder/toolbox-options", k.BOOT)).json().error).toBe("builder_requires_identity");
  });

  it("an MCP tool refId must be the tool's own id (not server:name)", async () => {
    const a = await newAgent(owner);
    const r = await k.req("PUT", `/v1/builder/agents/${a.id}/tools`, owner.auth, {
      tools: [{ kind: "mcp_tool", refId: `${grantedTool}:search`, requiresApproval: false }],
    });
    expect(r.statusCode).toBe(400);
  });

  it("unknown tool ids are a 404", async () => {
    const a = await newAgent(owner);
    const r = await k.req("PUT", `/v1/builder/agents/${a.id}/tools`, owner.auth, {
      tools: [{ kind: "connector", refId: "00000000-0000-4000-8000-000000000001", requiresApproval: false }],
    });
    expect(r.statusCode).toBe(404);
  });

  it("export names tools without ids; import keeps what the importer holds and reports the rest as dropped", async () => {
    const a = await newAgent(owner);
    await k.req("PATCH", `/v1/builder/agents/${a.id}`, owner.auth, { instructions: "# Exported", monthlyLimitUsd: 5 });
    await k.req("PUT", `/v1/builder/agents/${a.id}/tools`, owner.auth, {
      tools: [
        { kind: "connector", refId: grantedConnector, requiresApproval: true },
        { kind: "mcp_tool", refId: grantedTool, requiresApproval: false },
      ],
    });
    const skill = await k.req("POST", "/v1/builder/skills", owner.auth, { name: `Export skill ${k.RUN}`, description: "d", body: "# body", visibility: "private" });
    await k.req("PUT", `/v1/builder/agents/${a.id}/skills`, owner.auth, { skillIds: [skill.json().skill.id] });
    await k.req("POST", `/v1/builder/agents/${a.id}/schedules`, owner.auth, { name: "Daily", cadence: "daily", timeUtc: "09:00", prompt: "go", enabled: true });

    const ex = await k.req("GET", `/v1/builder/agents/${a.id}/export`, owner.auth);
    expect(ex.statusCode).toBe(200);
    const bundle = ex.json().bundle;
    expect(bundle.version).toBe(1);
    expect(JSON.stringify(bundle)).not.toContain(owner.id);
    expect(JSON.stringify(bundle)).not.toContain(a.id);
    expect(bundle.agent.tools).toEqual([
      { kind: "connector", name: `crm-${k.RUN}`, server: null, requiresApproval: true },
      { kind: "mcp_tool", name: "search", server: `docs-mcp-${k.RUN}`, requiresApproval: false },
    ]);
    expect(bundle.skills).toEqual([{ name: `Export skill ${k.RUN}`, description: "d", body: "# body" }]);

    // the colleague holds neither tool: both are dropped, the rest imports
    bundle.agent.tools.push({ kind: "connector", name: "no-such-connector", server: null, requiresApproval: false });
    const im = await k.req("POST", "/v1/builder/agents/import", colleague.auth, { bundle, projectId: colleague.projectId });
    expect(im.statusCode, im.body).toBe(201);
    expect(im.json().agent.ownerUserId).toBe(colleague.id);
    expect(im.json().agent.tools).toEqual([]);
    expect(im.json().agent.instructions).toBe("# Exported");
    expect(im.json().agent.monthlyLimitUsd).toBe(5);
    expect(im.json().agent.schedules).toHaveLength(1);
    expect(im.json().agent.schedules[0].enabled).toBe(false);
    expect(im.json().agent.skills.map((s: { name: string }) => s.name)).toEqual([`Export skill ${k.RUN}`]);
    expect(im.json().agent.modelAgent).toBeNull(); // the colleague holds no model
    expect(im.json().dropped).toEqual([
      { kind: "connector", name: `crm-${k.RUN}`, reason: "not_entitled" },
      { kind: "mcp_tool", name: `docs-mcp-${k.RUN}/search`, reason: "not_entitled" },
      { kind: "connector", name: "no-such-connector", reason: "not_found" },
    ]);
    // the owner re-importing keeps both
    const mine = await k.req("POST", "/v1/builder/agents/import", owner.auth, { bundle, projectId: owner.projectId });
    expect(mine.json().agent.tools).toHaveLength(2);
    expect(mine.json().agent.modelAgent.id).toBe(modelA);
    expect(await auditRows(im.json().agent.id, "builder-agent-imported")).toHaveLength(1);
  });
});

describe("sub-agents", () => {
  it("links visible children, refuses self, invisible children and cycles", async () => {
    const a = await newAgent(owner, { name: "Parent" });
    const b = await newAgent(owner, { name: "Child" });
    const c = await newAgent(owner, { name: "Grandchild" });
    const hidden = await newAgent(colleague, { name: "Theirs" });

    const self = await k.req("PUT", `/v1/builder/agents/${a.id}/subagents`, owner.auth, { subagents: [{ childId: a.id, name: "me" }] });
    expect(self.statusCode).toBe(422);
    expect(self.json().error).toBe("subagent_self");
    const inv = await k.req("PUT", `/v1/builder/agents/${a.id}/subagents`, owner.auth, { subagents: [{ childId: hidden.id, name: "x" }] });
    expect(inv.statusCode).toBe(404);

    const ab = await k.req("PUT", `/v1/builder/agents/${a.id}/subagents`, owner.auth, { subagents: [{ childId: b.id, name: "Researcher", description: "finds" }] });
    expect(ab.statusCode, ab.body).toBe(200);
    expect(ab.json().agent.subagents).toEqual([{ childId: b.id, name: "Researcher", description: "finds", childName: "Child" }]);
    expect((await k.req("PUT", `/v1/builder/agents/${b.id}/subagents`, owner.auth, { subagents: [{ childId: c.id, name: "gc" }] })).statusCode).toBe(200);

    // c -> a would close a -> b -> c -> a
    const cyc = await k.req("PUT", `/v1/builder/agents/${c.id}/subagents`, owner.auth, { subagents: [{ childId: a.id, name: "loop" }] });
    expect(cyc.statusCode).toBe(422);
    expect(cyc.json().error).toBe("subagent_cycle");
    // direct two-cycle
    const two = await k.req("PUT", `/v1/builder/agents/${b.id}/subagents`, owner.auth, { subagents: [{ childId: a.id, name: "loop" }] });
    expect(two.json().error).toBe("subagent_cycle");
    // replacing a parent's own edges is not a cycle with its old self
    expect((await k.req("PUT", `/v1/builder/agents/${a.id}/subagents`, owner.auth, { subagents: [{ childId: c.id, name: "direct" }] })).statusCode).toBe(200);
    expect(await auditRows(a.id, "builder-agent-subagents-changed")).toHaveLength(2);
  });
});

describe("templates", () => {
  it("ships at least six governance templates with complete fields", async () => {
    const r = await k.req("GET", "/v1/builder/templates", owner.auth);
    const list = r.json().templates as Array<Record<string, any>>;
    expect(list.length).toBeGreaterThanOrEqual(6);
    for (const t of list) {
      for (const f of ["id", "name", "tagline", "description", "category", "instructions"]) expect(t[f], `${t.id}.${f}`).toBeTruthy();
      expect(t.integrations.length).toBeGreaterThan(0);
      expect(t.steps.length).toBeGreaterThan(0);
      expect(Array.isArray(t.skills) && Array.isArray(t.subagents) && Array.isArray(t.schedules)).toBe(true);
    }
    const one = await k.req("GET", `/v1/builder/templates/${list[0]!.id}`, owner.auth);
    expect(one.json().template.id).toBe(list[0]!.id);
    expect((await k.req("GET", "/v1/builder/templates/nope", owner.auth)).statusCode).toBe(404);
  });

  it("instantiates instructions, skills (reusing only the creator's OWN identical skill), sub-agents and disabled schedules", async () => {
    const tpl = BUILDER_TEMPLATES.find((t) => t.id === "ai-intake-reviewer")!;
    // the creator's own copy of the first template skill, word for word: reused
    const pre = await k.req("POST", "/v1/builder/skills", owner.auth, { name: tpl.skills[0]!.name, description: "mine", body: tpl.skills[0]!.body, visibility: "private" });
    const r = await k.req("POST", "/v1/builder/agents", owner.auth, {
      name: "Intake", connectionFormat: "shared", computerUse: false, templateId: tpl.id, projectId: owner.projectId,
    });
    expect(r.statusCode, r.body).toBe(201);
    const a = r.json().agent;
    expect(a.templateId).toBe(tpl.id);
    expect(a.instructions).toBe(tpl.instructions);
    expect(a.skills.map((s: { name: string }) => s.name).sort()).toEqual(tpl.skills.map((s) => s.name).sort());
    expect(a.skills.find((s: { name: string }) => s.name === tpl.skills[0]!.name).id).toBe(pre.json().skill.id);
    expect(a.subagents.map((s: { name: string }) => s.name)).toEqual(tpl.subagents.map((s) => s.name));
    expect(a.schedules).toHaveLength(tpl.schedules.length);
    expect(a.schedules.every((s: { enabled: boolean; nextRunAt: string | null }) => !s.enabled && s.nextRunAt === null)).toBe(true);
    // the child agents exist, are the creator's and are private
    const child = await k.req("GET", `/v1/builder/agents/${a.subagents[0].childId}`, owner.auth);
    expect(child.json().agent.ownerUserId).toBe(owner.id);
    expect(child.json().agent.sharing).toBe("private");
    expect((await k.req("POST", "/v1/builder/agents", owner.auth, { name: "x", connectionFormat: "shared", computerUse: false, templateId: "nope" })).statusCode).toBe(404);
  });
});

describe("memory, schedules, channels", () => {
  it("memory: add (newest first), delete, viewer cannot add", async () => {
    const a = await newAgent(owner);
    const m1 = await k.req("POST", `/v1/builder/agents/${a.id}/memory`, owner.auth, { content: "first" });
    expect(m1.statusCode).toBe(201);
    expect(m1.json()).toMatchObject({ content: "first", createdByName: `owner ${k.RUN}` });
    await k.req("POST", `/v1/builder/agents/${a.id}/memory`, owner.auth, { content: "second" });
    let mem = (await k.req("GET", `/v1/builder/agents/${a.id}`, owner.auth)).json().agent.memory;
    expect(mem.map((m: { content: string }) => m.content)).toEqual(["second", "first"]);
    expect((await k.req("DELETE", `/v1/builder/agents/${a.id}/memory/${m1.json().id}`, owner.auth)).statusCode).toBe(204);
    mem = (await k.req("GET", `/v1/builder/agents/${a.id}`, owner.auth)).json().agent.memory;
    expect(mem).toHaveLength(1);
    expect((await k.req("POST", `/v1/builder/agents/${a.id}/memory`, owner.auth, { content: "" })).statusCode).toBe(400);
    await k.req("PATCH", `/v1/builder/agents/${a.id}`, owner.auth, { sharing: "workspace" });
    expect((await k.req("POST", `/v1/builder/agents/${a.id}/memory`, colleague.auth, { content: "x" })).statusCode).toBe(403);
  });

  it("schedules: create computes nextRunAt, disable clears it, edit and delete are audited", async () => {
    const a = await newAgent(owner);
    const r = await k.req("POST", `/v1/builder/agents/${a.id}/schedules`, owner.auth, {
      name: "Morning", cadence: "daily", timeUtc: "07:30", prompt: "brief me", enabled: true,
    });
    expect(r.statusCode, r.body).toBe(201);
    const s = r.json();
    expect(s.nextRunAt).toMatch(/T07:30:00\.000Z$/);
    expect(new Date(s.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    expect(s.lastRunAt).toBeNull();
    expect((await k.req("POST", `/v1/builder/agents/${a.id}/schedules`, owner.auth, { name: "Bad", cadence: "daily", timeUtc: "25:00", prompt: "x", enabled: true })).statusCode).toBe(400);

    const off = await k.req("PATCH", `/v1/builder/agents/${a.id}/schedules/${s.id}`, owner.auth, { enabled: false });
    expect(off.json()).toMatchObject({ enabled: false, nextRunAt: null });
    const hourly = await k.req("PATCH", `/v1/builder/agents/${a.id}/schedules/${s.id}`, owner.auth, { enabled: true, cadence: "hourly", timeUtc: "00:45" });
    expect(hourly.json().nextRunAt).toMatch(/:45:00\.000Z$/);
    expect((await k.req("GET", `/v1/builder/agents/${a.id}`, owner.auth)).json().agent.scheduleCount).toBe(1);
    expect((await k.req("DELETE", `/v1/builder/agents/${a.id}/schedules/${s.id}`, owner.auth)).statusCode).toBe(204);
    expect(await k.db.select().from(builderAgentSchedules).where(eq(builderAgentSchedules.id, s.id))).toHaveLength(0);
    for (const rule of ["builder-agent-schedule-created", "builder-agent-schedule-updated", "builder-agent-schedule-deleted"]) {
      expect((await auditRows(a.id, rule)).length, rule).toBeGreaterThan(0);
    }
  });

  it("channels: connected only with a matching ChatOps connection (bound by an admin), else needs setup", async () => {
    const a = await newAgent(owner);
    const slack = await k.req("POST", `/v1/builder/agents/${a.id}/channels`, owner.auth, { provider: "slack" });
    expect(slack.statusCode, slack.body).toBe(201);
    expect(slack.json()).toMatchObject({ provider: "slack", status: "needs_setup", connectionName: null });
    // binding a specific workspace connection is an admin act

    const [conn] = await k.db.insert(connectors).values({ name: `mail-${k.RUN}`, kind: "email", providerKind: "outlook" }).returning();
    const [chat] = await k.db
      .insert(chatopsConnections)
      .values({ name: `outlook-${k.RUN}`, provider: "outlook", connectorId: conn!.id, defaultChannel: "governance@example.com" })
      .returning();
    chatopsRows.push({ connectionId: chat!.id, connectorId: conn!.id });
    const email =await k.req("POST", `/v1/builder/agents/${a.id}/channels`, admin.auth, { provider: "email", chatopsConnectionId: chat!.id });
    expect(email.json()).toMatchObject({ provider: "email", status: "connected", connectionName: `outlook-${k.RUN}` });
    const wrong = await k.req("POST", `/v1/builder/agents/${a.id}/channels`, admin.auth, { provider: "teams", chatopsConnectionId: chat!.id });
    expect(wrong.statusCode).toBe(422);

    const chans = (await k.req("GET", `/v1/builder/agents/${a.id}`, owner.auth)).json().agent.channels;
    expect(chans).toHaveLength(2);
    expect((await k.req("DELETE", `/v1/builder/agents/${a.id}/channels/${slack.json().id}`, owner.auth)).statusCode).toBe(204);
    expect((await k.req("GET", `/v1/builder/agents/${a.id}`, owner.auth)).json().agent.channels).toHaveLength(1);
    expect(await auditRows(a.id, "builder-agent-channel-added")).toHaveLength(2);
    expect(await auditRows(a.id, "builder-agent-channel-removed")).toHaveLength(1);
  });
});

describe("integrations catalog", () => {
  it("groups vendor items and marks status from connectors, MCP servers and ChatOps", async () => {
    const r = await k.req("GET", "/v1/builder/integrations", owner.auth);
    expect(r.statusCode).toBe(200);
    const items = (r.json().groups as Array<{ name: string; items: Array<Record<string, string>> }>).flatMap((g) => g.items);
    const byKey = new Map(items.map((i) => [i.key, i]));
    expect(byKey.get("salesforce")).toMatchObject({ status: "connected", kind: "connector", connectHref: "/admin/connectors" });
    expect(byKey.get("microsoft")).toMatchObject({ status: "connected", kind: "chatops" }); // the outlook connection above
    for (const i of items) expect(["productivity", "developer", "communication", "data", "security", "ai"]).toContain(i.category);
    const custom = r.json().custom.mcpServers as Array<{ name: string; toolCount: number }>;
    expect(custom.find((s) => s.name === `docs-mcp-${k.RUN}`)?.toolCount).toBe(2);
  });
});
