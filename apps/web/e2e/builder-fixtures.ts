/**
 * ADR-0172 — a stateful, in-test mock of the Builder API (/v1/builder/*) for
 * the builder-*.mock.spec.ts files. It mirrors the gateway's real responses
 * (apps/gateway/src/builder.ts / builder-runtime.ts) — shapes, status codes and
 * error codes — so the specs exercise what the page will really get; every call
 * is recorded so a spec can assert what the page sent. Not a spec itself.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page, type Route } from "@playwright/test";

export const ME = "11111111-0000-4000-8000-000000000001";
export const DREW = "11111111-0000-4000-8000-000000000002";
export const CORA = "11111111-0000-4000-8000-000000000003";
export const MODEL_A = "22222222-0000-4000-8000-000000000001";
export const MODEL_B = "22222222-0000-4000-8000-000000000002";
export const SERVER = "33333333-0000-4000-8000-000000000001";
export const CONN_JIRA = "44444444-0000-4000-8000-000000000001";
export const CONN_DRIVE = "44444444-0000-4000-8000-000000000002";
/** MCP tools are referred to by THEIR OWN id (never server:name) — as the gateway does */
export const TOOL_SEARCH = "55555555-0000-4000-8000-000000000001";
export const TOOL_UPDATE = "55555555-0000-4000-8000-000000000002";
/** the gateway's avatar palette (shared BUILDER_AGENT_COLORS); anything else is a 400 */
const PALETTE = ["#2563eb", "#7c3aed", "#0e7490", "#047857", "#b45309", "#be185d", "#4338ca", "#0f766e"];

const iso = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();
const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
let seq = 0;
const uid = (p: string) => `${p}-${(++seq).toString().padStart(4, "0")}-4000-8000-000000000000`;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export interface MockOptions {
  isAdmin?: boolean;
  /** start with no agents, threads or skills */
  empty?: boolean;
  /** answer these paths (prefix match, after /v1/builder) with a 500 */
  fail?: string[];
  /** the caller is no longer entitled to the agent's model: chat refuses AFTER
   * recording the thread (403 agent_denied + threadId), like the gateway */
  denyModel?: boolean;
}

export interface Recorded {
  method: string;
  path: string;
  body: Json;
}

function agent(over: Partial<Json>): Json {
  return {
    id: uid("aaaaaaaa"),
    name: "Agent",
    description: "",
    color: "#2563eb",
    ownerUserId: ME,
    ownerName: "Avery Admin",
    sharing: "private",
    modelAgent: { id: MODEL_A, name: "claude-default", provider: "anthropic", model: "claude-sonnet" },
    templateId: null,
    monthlyLimitUsd: null,
    spentThisMonthUsd: 0,
    updatedAt: iso(30),
    canEdit: true,
    instructions: "",
    connectionFormat: "shared",
    computerUse: false,
    sharedUserIds: [],
    sharedUsers: [],
    tools: [],
    subagents: [],
    skills: [],
    memory: [],
    schedules: [],
    channels: [],
    ...over,
  };
}

const summaryOf = (a: Json) => {
  const { instructions, connectionFormat, computerUse, sharedUserIds, sharedUsers, tools, subagents, skills, memory, schedules, channels, ...rest } = a;
  void instructions, connectionFormat, computerUse, sharedUserIds, sharedUsers, subagents, memory, channels;
  return { ...rest, toolCount: tools.length, skillCount: skills.length, scheduleCount: schedules.length };
};

/** AgentDetail = AgentSummary (with its counts) + the detail fields, as the gateway sends it */
const detailOf = (a: Json) => ({ ...a, toolCount: a.tools.length, skillCount: a.skills.length, scheduleCount: a.schedules.length });

export function seedState(opts: MockOptions = {}) {
  const intake = agent({
    name: "Intake reviewer",
    description: "Reads new AI intake requests and flags missing details.",
    color: "#7c3aed",
    sharing: "workspace",
    instructions: "# Purpose\n- Review each new AI intake request.\n- Flag missing data-handling details.\n- Never approve anything yourself.",
    monthlyLimitUsd: 50,
    spentThisMonthUsd: 42.5,
    tools: [{ kind: "connector", refId: CONN_JIRA, name: "Jira (governance)", provider: "jira", requiresApproval: false, entitledForYou: true }],
    skills: [{ id: "sk-0001", name: "Assess an AI use case", description: "Use when a new AI use case needs a first review." }],
    memory: [{ id: "mem-0001", content: "The review board meets on Thursdays.", createdByName: "Avery Admin", createdAt: iso(600) }],
    schedules: [{ id: "sch-0001", name: "Morning sweep", cadence: "weekdays", timeUtc: "08:30", prompt: "List new intake requests.", enabled: true, nextRunAt: iso(-600), lastRunAt: iso(800) }],
  });
  const risk = agent({
    name: "Vendor risk assessor",
    description: "Scores third-party AI vendors against the vendor policy.",
    color: "#0e7490",
    modelAgent: { id: MODEL_B, name: "gpt-review", provider: "openai", model: "gpt-4.1" },
    updatedAt: iso(300),
  });
  const shared = agent({
    name: "Policy Q&A",
    description: "Answers questions about the AI policy.",
    color: "#047857",
    ownerUserId: DREW,
    ownerName: "Drew Reviewer",
    sharing: "people",
    sharedUserIds: [ME],
    sharedUsers: [{ id: ME, name: "Avery Admin" }],
    canEdit: false,
    tools: [{ kind: "mcp_tool", refId: TOOL_SEARCH, name: "search_policies", provider: "policy-docs", requiresApproval: false, entitledForYou: false }],
  });
  const agents: Json[] = opts.empty ? [] : [intake, risk, shared];
  const threads: Json[] = opts.empty
    ? []
    : [
        { id: "th-0001", agentId: intake.id, agentName: intake.name, agentColor: intake.color, title: "Morning sweep — 3 new requests", status: "needs_attention", source: "schedule", lastMessagePreview: "Two requests are missing a data owner.", updatedAt: iso(20) },
        { id: "th-0002", agentId: risk.id, agentName: risk.name, agentColor: risk.color, title: "Q3 vendor review", status: "completed", source: "chat", lastMessagePreview: "All four vendors scored.", updatedAt: iso(2000) },
        { id: "th-0003", agentId: intake.id, agentName: intake.name, agentColor: intake.color, title: "Chatbot pilot questions", status: "active", source: "chat", lastMessagePreview: "Here's what's missing…", updatedAt: iso(90) },
      ];
  const messages: Record<string, Json[]> = {
    "th-0001": [
      { id: "m1", role: "system", content: "Scheduled run: Morning sweep", model: null, costUsd: null, latencyMs: null, createdAt: iso(21) },
      { id: "m2", role: "agent", content: "Three new requests. Two are missing a data owner: Chatbot pilot and Resume screener.", model: "claude-sonnet", costUsd: 0.012, latencyMs: 2300, createdAt: iso(20) },
    ],
    "th-0002": [
      { id: "m3", role: "user", content: "Score the Q3 vendors.", model: null, costUsd: null, latencyMs: null, createdAt: iso(2001) },
      { id: "m4", role: "agent", content: "All four vendors scored. One is high risk.", model: "gpt-4.1", costUsd: 0.03, latencyMs: 4100, createdAt: iso(2000) },
    ],
    "th-0003": [{ id: "m5", role: "user", content: "What is missing for the chatbot pilot?", model: null, costUsd: null, latencyMs: null, createdAt: iso(91) }],
  };
  const skills: Json[] = opts.empty
    ? []
    : [
        { id: "sk-0001", name: "Assess an AI use case", description: "Use when a new AI use case needs a first review.", visibility: "workspace", ownerName: "Avery Admin", usedBy: 1, updatedAt: iso(5000), canEdit: true, body: "---\nname: Assess an AI use case\ndescription: Use when a new AI use case needs a first review.\n---\n# Steps\n1. Read the request." },
        { id: "sk-0002", name: "Draft an audit finding", description: "Use when a control gap needs writing up.", visibility: "workspace", ownerName: "Drew Reviewer", usedBy: 0, updatedAt: iso(9000), canEdit: false, body: "---\nname: Draft an audit finding\n---\n# Steps" },
        { id: "sk-0003", name: "Map to EU AI Act", description: "Use when asked which EU AI Act tier applies.", visibility: "private", ownerName: "Avery Admin", usedBy: 0, updatedAt: iso(12000), canEdit: true, body: "---\nname: Map to EU AI Act\n---\n" },
      ];
  const templates: Json[] = [
    {
      id: "ai-intake-reviewer",
      name: "AI intake reviewer",
      tagline: "Checks new AI requests for missing details",
      description: "Reads each new AI intake request, flags gaps in data handling and ownership, and suggests a risk tier for a human to confirm.",
      category: "Intake",
      integrations: ["jira", "slack", "gdrive"],
      instructions: "# Purpose\nReview new AI intake requests.\n\n# Rules\n- Never approve or reject.",
      skills: [{ name: "Assess an AI use case", description: "Use when a new AI use case needs a first review.", body: "# Steps" }],
      subagents: [{ name: "Evidence collector", description: "Gathers the documents a request refers to." }],
      schedules: [{ name: "Morning sweep", cadence: "weekdays", timeUtc: "08:30", prompt: "Review new requests." }],
      steps: ["Reads every new intake request", "Flags missing data-handling and ownership details", "Suggests a risk tier for a reviewer to confirm"],
    },
    {
      id: "vendor-ai-risk-assessor",
      name: "Vendor AI risk assessor",
      tagline: "Scores AI vendors against your policy",
      description: "Collects vendor answers and scores them against the vendor policy.",
      category: "Risk",
      integrations: ["salesforce", "box"],
      instructions: "# Purpose\nScore vendors.",
      skills: [],
      subagents: [],
      schedules: [],
      steps: ["Collects vendor questionnaires", "Scores each answer against the policy"],
    },
  ];
  const integrations: Json = {
    groups: [
      {
        name: "Atlassian",
        items: [
          { key: "jira", name: "Jira", description: "Read and create issues", category: "productivity", status: "connected", connectHref: "/admin/connectors", kind: "connector" },
          { key: "confluence", name: "Confluence", description: "Read team pages", category: "productivity", status: "available", connectHref: "/admin/connectors", kind: "connector" },
        ],
      },
      {
        name: "Google",
        items: [
          { key: "gdrive", name: "Google Drive", description: "Find and read documents", category: "data", status: "connected", connectHref: "/admin/connectors", kind: "connector" },
          { key: "gmail", name: "Gmail", description: "Read and draft email", category: "communication", status: "available", connectHref: "/admin/connectors", kind: "connector" },
        ],
      },
      {
        name: "Chat",
        items: [{ key: "slack", name: "Slack", description: "Talk to agents in Slack", category: "communication", status: "connected", connectHref: "/admin/chatops", kind: "chatops" }],
      },
      {
        name: "Security",
        items: [{ key: "okta", name: "Okta", description: "Look up people and groups", category: "security", status: "available", connectHref: "/admin/connectors", kind: "connector" }],
      },
    ],
    custom: { mcpServers: [{ id: SERVER, name: "policy-docs", toolCount: 2 }] },
  };
  return {
    opts,
    isAdmin: opts.isAdmin ?? true,
    agents,
    threads,
    messages,
    skills,
    templates,
    integrations,
    calls: [] as Recorded[],
  };
}
export type MockState = ReturnType<typeof seedState>;

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: body === undefined ? "" : JSON.stringify(body) });

/** GET /v1/builder/toolbox-options — what the signed-in person may add */
const TOOLBOX_OPTIONS = [
  { kind: "connector", refId: CONN_JIRA, name: "Jira (governance)", provider: "jira" },
  { kind: "connector", refId: CONN_DRIVE, name: "Policy drive", provider: "gdrive" },
  { kind: "mcp_tool", refId: TOOL_SEARCH, name: "search_policies", provider: "policy-docs", access: "read" },
  { kind: "mcp_tool", refId: TOOL_UPDATE, name: "update_policy", provider: "policy-docs", access: "write", description: "Edit a policy page" },
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** the next run of a schedule, roughly (the gateway computes it exactly) */
const nextRun = (enabled: boolean) => (enabled ? iso(-120) : null);

export async function installBuilderMock(page: Page, opts: MockOptions = {}): Promise<MockState> {
  const st = seedState(opts);
  const find = (id: string) => st.agents.find((a) => a.id === id);
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = req.method();
    let body: Json = undefined;
    try {
      body = req.postDataJSON();
    } catch {
      body = undefined;
    }
    st.calls.push({ method, path: p + url.search, body });

    if (p === "/auth/me")
      return json(route, { userId: ME, isAdmin: st.isAdmin, via: "session", user: { id: ME, email: "avery@example.test", displayName: "Avery Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: ME, isAdmin: st.isAdmin, user: { id: ME, email: "avery@example.test", displayName: "Avery Admin" } });
    if (p === `/v1/users/${ME}/agents`)
      return json(route, {
        agents: [
          { agentId: MODEL_A, name: "claude-default", provider: "anthropic", model: "claude-sonnet", tier: 1 },
          { agentId: MODEL_B, name: "gpt-review", provider: "openai", model: "gpt-4.1", tier: 2 },
        ],
        defaultAgentId: MODEL_A,
      });
    if (p === "/v1/users/directory")
      return json(route, { users: [{ id: ME, name: "Avery Admin" }, { id: DREW, name: "Drew Reviewer" }, { id: CORA, name: "Cora Analyst" }] });
    if (p === "/v1/model-providers/status") return json(route, { providers: { anthropic: { configured: true }, openai: { configured: true } } });
    if (p === `/v1/users/${ME}/model-credentials`) return json(route, { credentials: [] });

    if (!p.startsWith("/v1/builder")) return json(route, {});
    const b = p.slice("/v1/builder".length);
    if (st.opts.fail?.some((f) => b === f || b.startsWith(f + "/") || b.startsWith(f + "?")) && method === "GET")
      return json(route, { error: "internal", detail: "builder store unavailable" }, 500);

    let m: RegExpExecArray | null;
    // ---- agents
    if (b === "/agents" && method === "GET") return json(route, { agents: st.agents.map(summaryOf) });
    if (b === "/agents" && method === "POST") {
      const tpl = body.templateId ? st.templates.find((t: Json) => t.id === body.templateId) : null;
      if (body.templateId && !tpl) return json(route, { error: "unknown_template" }, 404);
      // a template's sub-agents become private child agents on the same model
      const children = (tpl?.subagents ?? []).map((sub: Json) => agent({ name: sub.name, description: sub.description, instructions: `# ${sub.name}\n\n${sub.description}` }));
      st.agents.push(...children);
      const a = agent({
        name: body.name,
        description: body.description ?? (tpl ? tpl.description : ""),
        connectionFormat: body.connectionFormat,
        computerUse: body.computerUse,
        templateId: body.templateId ?? null,
        updatedAt: new Date().toISOString(),
        instructions: tpl ? tpl.instructions : "",
        skills: tpl ? tpl.skills.map((k: Json) => ({ id: uid("skkkkkkk"), name: k.name, description: k.description })) : [],
        subagents: children.map((c: Json) => ({ childId: c.id, name: c.name, description: c.description, childName: c.name })),
        // seeded schedules start OFF: nothing spends until the owner turns one on
        schedules: tpl ? tpl.schedules.map((x: Json) => ({ id: uid("scheeeee"), ...x, enabled: false, nextRunAt: null, lastRunAt: null })) : [],
        ...(body.modelAgentId === MODEL_B ? { modelAgent: { id: MODEL_B, name: "gpt-review", provider: "openai", model: "gpt-4.1" } } : {}),
      });
      st.agents.unshift(a);
      return json(route, { agent: detailOf(a) }, 201);
    }
    if (b === "/agents/import" && method === "POST") {
      const a = agent({ name: body.bundle.agent.name, description: body.bundle.agent.description ?? "" });
      st.agents.unshift(a);
      return json(route, { agent: detailOf(a), dropped: [{ kind: "connector", name: "Payroll export", reason: "not_entitled" }] }, 201);
    }
    if ((m = /^\/agents\/([^/]+)$/.exec(b))) {
      const a = find(m[1]!);
      if (!a) return json(route, { error: "unknown_builder_agent" }, 404);
      if (method === "GET") return json(route, { agent: detailOf(a) });
      if (method === "DELETE") {
        st.agents = st.agents.filter((x) => x.id !== a.id);
        return route.fulfill({ status: 204, body: "" });
      }
      if (method === "PATCH") {
        if (!a.canEdit) return json(route, { error: "not_agent_editor", detail: "only the agent's owner or an admin can change it" }, 403);
        if ("connectionFormat" in body)
          return json(route, { error: "connection_format_locked", detail: "the connection format is fixed when an agent is created; create a new agent to change it" }, 409);
        if (body.color !== undefined && !PALETTE.includes(String(body.color).toLowerCase()))
          return json(route, { error: "validation", issues: [{ path: "color", message: `color must be one of ${PALETTE.join(", ")}` }] }, 400);
        Object.assign(a, body, body.color ? { color: String(body.color).toLowerCase() } : {});
        if (body.sharedUserIds) a.sharedUsers = body.sharedUserIds.map((id: string) => ({ id, name: id === DREW ? "Drew Reviewer" : id === CORA ? "Cora Analyst" : "Avery Admin" }));
        if (body.modelAgentId) a.modelAgent = body.modelAgentId === MODEL_B ? { id: MODEL_B, name: "gpt-review", provider: "openai", model: "gpt-4.1" } : { id: MODEL_A, name: "claude-default", provider: "anthropic", model: "claude-sonnet" };
        a.updatedAt = new Date().toISOString();
        return json(route, { agent: detailOf(a) });
      }
    }
    if ((m = /^\/agents\/([^/]+)\/(tools|subagents|skills|memory|schedules|channels|export|chat)(?:\/([^/]+))?$/.exec(b))) {
      const a = find(m[1]!);
      if (!a) return json(route, { error: "unknown_builder_agent" }, 404);
      const [, , what, sub] = m;
      if (what === "tools" && method === "PUT") {
        // the gateway's schema: refId is a uuid (an MCP tool's own id) — else 400
        const bad = body.tools.find((t: Json) => !UUID.test(t.refId));
        if (bad) return json(route, { error: "validation", issues: [{ path: "tools.refId", message: "Invalid uuid" }] }, 400);
        const unknown = body.tools.find((t: Json) => !TOOLBOX_OPTIONS.some((o) => o.refId === t.refId));
        if (unknown) return json(route, { error: "unknown_tool", refId: unknown.refId }, 404);
        a.tools = body.tools.map((t: Json) => {
          const o = TOOLBOX_OPTIONS.find((x) => x.refId === t.refId)!;
          return { kind: t.kind, refId: t.refId, name: o.name, provider: o.provider, requiresApproval: t.requiresApproval, entitledForYou: true };
        });
        return json(route, { agent: detailOf(a) });
      }
      if (what === "subagents" && method === "PUT") {
        for (const s of body.subagents) {
          const child = find(s.childId);
          if (child?.subagents.some((x: Json) => x.childId === a.id)) return json(route, { error: "subagent_cycle", detail: `${child.name} already hands work to ${a.name}` }, 422);
        }
        a.subagents = body.subagents.map((s: Json) => ({ ...s, childName: find(s.childId)?.name ?? "Agent" }));
        return json(route, { agent: detailOf(a) });
      }
      if (what === "skills" && method === "PUT") {
        a.skills = body.skillIds.map((id: string) => {
          const k = st.skills.find((x: Json) => x.id === id) ?? a.skills.find((x: Json) => x.id === id);
          return { id, name: k?.name ?? id, description: k?.description ?? "" };
        });
        return json(route, { agent: detailOf(a) });
      }
      if (what === "memory" && method === "POST") {
        const item = { id: uid("mem"), content: body.content, createdByName: "Avery Admin", createdAt: new Date().toISOString() };
        a.memory.unshift(item);
        return json(route, item, 201);
      }
      if (what === "memory" && method === "DELETE") {
        a.memory = a.memory.filter((x: Json) => x.id !== sub);
        return route.fulfill({ status: 204, body: "" });
      }
      if (what === "schedules" && method === "POST") {
        const sc = { id: uid("sch"), ...body, nextRunAt: nextRun(body.enabled), lastRunAt: null };
        a.schedules.push(sc);
        return json(route, sc, 201);
      }
      if (what === "schedules" && method === "PATCH") {
        const sc = a.schedules.find((x: Json) => x.id === sub);
        if (!sc) return json(route, { error: "unknown_schedule" }, 404);
        Object.assign(sc, body);
        // enabling computes the next run; disabling clears it (gateway rule)
        sc.nextRunAt = sc.enabled ? (sc.nextRunAt ?? nextRun(true)) : null;
        return json(route, sc);
      }
      if (what === "schedules" && method === "DELETE") {
        a.schedules = a.schedules.filter((x: Json) => x.id !== sub);
        return route.fulfill({ status: 204, body: "" });
      }
      if (what === "channels" && method === "POST") {
        const ch = { id: uid("ch"), provider: body.provider, status: body.provider === "slack" ? "connected" : "needs_setup", connectionName: body.provider === "slack" ? "Governance Slack" : null };
        a.channels.push(ch);
        return json(route, ch, 201);
      }
      if (what === "channels" && method === "DELETE") {
        a.channels = a.channels.filter((x: Json) => x.id !== sub);
        return route.fulfill({ status: 204, body: "" });
      }
      if (what === "export" && method === "GET") {
        // portable: no ids and no owners; tools by name, re-resolved on import
        return json(route, {
          bundle: {
            version: 1,
            agent: {
              name: a.name,
              description: a.description,
              color: a.color,
              instructions: a.instructions,
              connectionFormat: a.connectionFormat,
              computerUse: a.computerUse,
              monthlyLimitUsd: a.monthlyLimitUsd,
              model: a.modelAgent ? { name: a.modelAgent.name, provider: a.modelAgent.provider, model: a.modelAgent.model } : null,
              tools: a.tools.map((t: Json) => ({ kind: t.kind, name: t.name, server: t.kind === "mcp_tool" ? t.provider : null, requiresApproval: t.requiresApproval })),
              subagents: a.subagents.map((x: Json) => ({ name: x.name, description: x.description })),
              skills: a.skills.map((k: Json) => k.name),
              schedules: a.schedules.map((x: Json) => ({ name: x.name, cadence: x.cadence, timeUtc: x.timeUtc, prompt: x.prompt })),
            },
            skills: a.skills.map((k: Json) => ({ name: k.name, description: k.description, body: st.skills.find((x: Json) => x.id === k.id)?.body ?? "" })),
          },
        });
      }
      if (what === "chat" && method === "POST") {
        // the gateway's order: the thread, then the monthly limit (nothing recorded), then the model
        let th = body.threadId ? st.threads.find((t) => t.id === body.threadId) : null;
        if (body.threadId && (!th || th.agentId !== a.id)) return json(route, { error: "unknown_thread" }, 404);
        if (th?.foreign) return json(route, { error: "not_your_thread" }, 403);
        if (a.monthlyLimitUsd != null && a.spentThisMonthUsd >= a.monthlyLimitUsd)
          return json(
            route,
            {
              error: "agent_spend_limit_reached",
              detail: `builder agent '${a.name}' has spent $${a.spentThisMonthUsd.toFixed(4)} of its $${a.monthlyLimitUsd.toFixed(2)} monthly limit; the owner can raise the limit or wait for next month`,
            },
            402,
          );
        if (!a.modelAgent) return json(route, { error: "builder_agent_has_no_model", detail: "choose a model for this agent first" }, 409);
        if (!th) {
          th = { id: uid("th"), agentId: a.id, agentName: a.name, agentColor: a.color, title: body.message.replace(/\s+/g, " ").trim().slice(0, 80), status: "active", source: "chat", lastMessagePreview: "", updatedAt: "" };
          st.threads.unshift(th);
          st.messages[th.id] = [];
        }
        const now = new Date().toISOString();
        if (st.opts.denyModel) {
          const reason = `no grant for agent '${a.modelAgent.name}'`;
          const note = `Refused (agent_denied): ${reason}`;
          st.messages[th.id]!.push(
            { id: uid("msg"), role: "user", content: body.message, model: null, costUsd: null, latencyMs: null, createdAt: now },
            { id: uid("msg"), role: "system", content: note, model: null, costUsd: null, latencyMs: null, createdAt: now },
          );
          Object.assign(th, { status: "needs_attention", lastMessagePreview: note, updatedAt: now });
          return json(route, { error: "agent_denied", detail: reason, threadId: th.id }, 403);
        }
        const reply = `Here is what I found about: ${body.message}`;
        const msgs = [
          { id: uid("msg"), role: "user", content: body.message, model: null, costUsd: null, latencyMs: null, createdAt: now },
          { id: uid("msg"), role: "agent", content: reply, model: a.modelAgent?.model ?? null, costUsd: 0.0042, latencyMs: 1800, createdAt: now },
        ];
        st.messages[th.id]!.push(...msgs);
        th.lastMessagePreview = reply.slice(0, 160);
        th.updatedAt = now;
        a.spentThisMonthUsd = Number((a.spentThisMonthUsd + 0.0042).toFixed(6));
        return json(route, { thread: th, messages: msgs });
      }
    }
    // ---- threads
    if (b === "/threads" && method === "GET") {
      const status = url.searchParams.get("status") ?? "all";
      const agentId = url.searchParams.get("agentId");
      return json(route, {
        threads: st.threads.filter((t) => (status === "all" || t.status === status) && (!agentId || t.agentId === agentId)),
      });
    }
    if ((m = /^\/threads\/([^/]+)$/.exec(b))) {
      const th = st.threads.find((t) => t.id === m![1]);
      // someone else's thread reads as unknown (404), like the gateway
      if (!th || th.foreign) return json(route, { error: "unknown_thread" }, 404);
      if (method === "PATCH") th.status = body.status;
      return json(route, method === "PATCH" ? { thread: th } : { thread: th, messages: st.messages[th.id] ?? [] });
    }
    // ---- skills
    if (b === "/skills" && method === "GET") return json(route, { skills: st.skills.map(({ body: _b, ...k }: Json) => k) });
    if (b === "/skills" && method === "POST") {
      const k = { id: uid("sk"), ...body, ownerName: "Avery Admin", usedBy: 0, updatedAt: new Date().toISOString(), canEdit: true };
      st.skills.unshift(k);
      return json(route, { skill: k }, 201);
    }
    if (b === "/skills/import" && method === "POST") {
      const name = /name:\s*(.+)/.exec(body.markdown)?.[1]?.trim() ?? "Imported";
      const description = /description:\s*(.+)/.exec(body.markdown)?.[1]?.trim() ?? "";
      const k = { id: uid("sk"), name, description, body: body.markdown, visibility: "private", ownerName: "Avery Admin", usedBy: 0, updatedAt: new Date().toISOString(), canEdit: true };
      st.skills.unshift(k);
      return json(route, { skill: k }, 201);
    }
    if ((m = /^\/skills\/([^/]+)$/.exec(b))) {
      const k = st.skills.find((x: Json) => x.id === m![1]);
      if (!k) return json(route, { error: "unknown_skill" }, 404);
      if (method === "GET") return json(route, { skill: k });
      if (method === "PATCH") {
        Object.assign(k, body);
        return json(route, { skill: k });
      }
      if (method === "DELETE") {
        st.skills = st.skills.filter((x: Json) => x.id !== k.id);
        return route.fulfill({ status: 204, body: "" });
      }
    }
    // ---- catalog
    if (b === "/templates") return json(route, { templates: st.templates });
    if ((m = /^\/templates\/([^/]+)$/.exec(b))) {
      const t = st.templates.find((x: Json) => x.id === m![1]);
      return t ? json(route, { template: t }) : json(route, { error: "unknown_template" }, 404);
    }
    if (b === "/integrations") return json(route, st.integrations);
    if (b === "/toolbox-options" && method === "GET") return json(route, { options: TOOLBOX_OPTIONS });
    if (b === "/usage") {
      const days = Number(url.searchParams.get("days") ?? 7);
      // the gateway always returns one row per day in the window, zeros included
      const series = (spend: Record<number, [number, number]>) =>
        Array.from({ length: days }, (_, i) => {
          const ago = days - 1 - i;
          const [spendUsd, messages] = spend[ago] ?? [0, 0];
          return { date: day(ago), spendUsd, messages };
        });
      if (st.opts.empty)
        return json(route, { totals: { spendUsd: 0, messages: 0, agents: 0, activeUsers: 0 }, byAgent: [], byUser: [], byModel: [], daily: series({}) });
      const scale = days === 30 ? 4 : 1;
      return json(route, {
        totals: { spendUsd: 12.34 * scale, messages: 210 * scale, agents: 3, activeUsers: days === 30 ? 9 : 4 },
        byAgent: [
          { agentId: st.agents[0]?.id ?? "x", name: "Intake reviewer", spendUsd: 9.1 * scale, messages: 150 * scale, limitUsd: 50 },
          { agentId: st.agents[1]?.id ?? "y", name: "Vendor risk assessor", spendUsd: 3.24 * scale, messages: 60 * scale, limitUsd: null },
        ],
        byUser: [
          { userId: ME, name: "Avery Admin", spendUsd: 8 * scale, messages: 120 * scale },
          { userId: DREW, name: "Drew Reviewer", spendUsd: 4.34 * scale, messages: 90 * scale },
        ],
        byModel: [
          { provider: "anthropic", model: "claude-sonnet", spendUsd: 10 * scale, messages: 170 * scale },
          { provider: "openai", model: "gpt-4.1", spendUsd: 2.34 * scale, messages: 40 * scale },
        ],
        daily: series({ 0: [2.5, 40], 1: [4.1, 70], 3: [5.74, 100] }),
      });
    }
    return json(route, { error: "not_found", detail: `mock has no ${method} ${p}` }, 404);
  });
  return st;
}

/** the request bodies the page sent to a path (method + exact path) */
export const sent = (st: MockState, method: string, path: string) => st.calls.filter((c) => c.method === method && c.path === path).map((c) => c.body);

const THEMES = ["light", "dark"] as const;
async function setTheme(page: Page, theme: (typeof THEMES)[number]) {
  await page.evaluate(async (next) => {
    document.documentElement.dataset.theme = next;
    localStorage.setItem("regulait.theme", next);
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
  }, theme);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

/** axe (WCAG 2.x A/AA) in light AND dark */
export async function expectAxeClean(page: Page, label: string) {
  for (const theme of THEMES) {
    await setTheme(page, theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    const summary = results.violations.map(
      (v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => `${n.target.join(" ")} :: ${n.failureSummary?.split("\n")[1] ?? ""}`).join("\n    ")}`,
    );
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
  await setTheme(page, "light");
}
