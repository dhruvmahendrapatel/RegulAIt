/**
 * ADR-0172 — a stateful, in-test mock of the Builder API (/v1/builder/*) for
 * the builder-*.mock.spec.ts files. It follows the shared contract exactly so
 * the specs exercise the same shapes the gateway returns; every call is
 * recorded so a spec can assert what the page sent. Not a spec itself.
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
    description: null,
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
    tools: [{ kind: "mcp_tool", refId: `${SERVER}:search_policies`, name: "search_policies", provider: "policy-docs", requiresApproval: false, entitledForYou: false }],
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
      id: "tpl-intake",
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
      id: "tpl-vendor",
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

const TOOL_NAMES: Record<string, { name: string; provider: string }> = {
  [CONN_JIRA]: { name: "Jira (governance)", provider: "jira" },
  [CONN_DRIVE]: { name: "Policy drive", provider: "gdrive" },
  [`${SERVER}:search_policies`]: { name: "search_policies", provider: "policy-docs" },
  [`${SERVER}:update_policy`]: { name: "update_policy", provider: "policy-docs" },
};

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
    if (p === `/v1/users/${ME}/connectors`)
      return json(route, {
        connectors: [
          { connectorId: CONN_JIRA, name: "Jira (governance)", kind: "jira", revoked: false },
          { connectorId: CONN_DRIVE, name: "Policy drive", kind: "gdrive", revoked: false },
        ],
      });
    if (p === `/v1/users/${ME}/servers/${SERVER}/tools`)
      return json(route, { tools: [{ serverId: SERVER, name: "search_policies", kind: "read" }, { serverId: SERVER, name: "update_policy", kind: "write" }] });

    if (!p.startsWith("/v1/builder")) return json(route, {});
    const b = p.slice("/v1/builder".length);
    if (st.opts.fail?.some((f) => b === f || b.startsWith(f + "/") || b.startsWith(f + "?")) && method === "GET")
      return json(route, { error: "internal", detail: "builder store unavailable" }, 500);

    let m: RegExpExecArray | null;
    // ---- agents
    if (b === "/agents" && method === "GET") return json(route, { agents: st.agents.map(summaryOf) });
    if (b === "/agents" && method === "POST") {
      const tpl = body.templateId ? st.templates.find((t: Json) => t.id === body.templateId) : null;
      const a = agent({
        name: body.name,
        description: body.description ?? null,
        connectionFormat: body.connectionFormat,
        computerUse: body.computerUse,
        templateId: body.templateId ?? null,
        updatedAt: new Date().toISOString(),
        instructions: tpl ? tpl.instructions : `# Purpose\n${body.description ?? body.name}`,
        skills: tpl ? tpl.skills.map((k: Json, i: number) => ({ id: `sk-t${i}`, name: k.name, description: k.description })) : [],
        schedules: tpl
          ? tpl.schedules.map((x: Json, i: number) => ({ id: `sch-t${i}`, ...x, enabled: true, nextRunAt: iso(-60), lastRunAt: null }))
          : [],
        ...(body.modelAgentId === MODEL_B ? { modelAgent: { id: MODEL_B, name: "gpt-review", provider: "openai", model: "gpt-4.1" } } : {}),
      });
      st.agents.unshift(a);
      return json(route, { agent: a }, 201);
    }
    if (b === "/agents/import" && method === "POST") {
      const a = agent({ name: body.bundle.agent.name, description: body.bundle.agent.description ?? null });
      st.agents.unshift(a);
      return json(route, { agent: a, dropped: [{ kind: "connector", name: "Payroll export" }] }, 201);
    }
    if ((m = /^\/agents\/([^/]+)$/.exec(b))) {
      const a = find(m[1]!);
      if (!a) return json(route, { error: "not_found" }, 404);
      if (method === "GET") return json(route, { agent: a });
      if (method === "DELETE") {
        st.agents = st.agents.filter((x) => x.id !== a.id);
        return route.fulfill({ status: 204, body: "" });
      }
      if (method === "PATCH") {
        if ("connectionFormat" in body) return json(route, { error: "connection_format_locked" }, 409);
        Object.assign(a, body);
        if (body.sharedUserIds) a.sharedUsers = body.sharedUserIds.map((id: string) => ({ id, name: id === DREW ? "Drew Reviewer" : id === CORA ? "Cora Analyst" : "Avery Admin" }));
        if (body.modelAgentId) a.modelAgent = body.modelAgentId === MODEL_B ? { id: MODEL_B, name: "gpt-review", provider: "openai", model: "gpt-4.1" } : { id: MODEL_A, name: "claude-default", provider: "anthropic", model: "claude-sonnet" };
        a.updatedAt = new Date().toISOString();
        return json(route, { agent: a });
      }
    }
    if ((m = /^\/agents\/([^/]+)\/(tools|subagents|skills|memory|schedules|channels|export|chat)(?:\/([^/]+))?$/.exec(b))) {
      const a = find(m[1]!);
      if (!a) return json(route, { error: "not_found" }, 404);
      const [, , what, sub] = m;
      if (what === "tools" && method === "PUT") {
        a.tools = body.tools.map((t: Json) => ({ ...t, ...(TOOL_NAMES[t.refId] ?? { name: t.refId, provider: null }), entitledForYou: true }));
        return json(route, { agent: a });
      }
      if (what === "subagents" && method === "PUT") {
        for (const s of body.subagents) {
          const child = find(s.childId);
          if (child?.subagents.some((x: Json) => x.childId === a.id)) return json(route, { error: "subagent_cycle", detail: `${child.name} already hands work to ${a.name}` }, 422);
        }
        a.subagents = body.subagents.map((s: Json) => ({ ...s, childName: find(s.childId)?.name ?? "Agent" }));
        return json(route, { agent: a });
      }
      if (what === "skills" && method === "PUT") {
        a.skills = body.skillIds.map((id: string) => {
          const k = st.skills.find((x: Json) => x.id === id) ?? a.skills.find((x: Json) => x.id === id);
          return { id, name: k?.name ?? id, description: k?.description ?? "" };
        });
        return json(route, { agent: a });
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
        const sc = { id: uid("sch"), ...body, nextRunAt: iso(-120), lastRunAt: null };
        a.schedules.push(sc);
        return json(route, sc, 201);
      }
      if (what === "schedules" && method === "PATCH") {
        const sc = a.schedules.find((x: Json) => x.id === sub);
        Object.assign(sc, body);
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
        return json(route, { bundle: { version: 1, agent: { name: a.name, description: a.description, instructions: a.instructions }, skills: [] } });
      }
      if (what === "chat" && method === "POST") {
        if (a.monthlyLimitUsd != null && a.spentThisMonthUsd >= a.monthlyLimitUsd) return json(route, { error: "agent_spend_limit_reached" }, 402);
        let th = body.threadId ? st.threads.find((t) => t.id === body.threadId) : null;
        if (!th) {
          th = { id: uid("th"), agentId: a.id, agentName: a.name, agentColor: a.color, title: body.message.slice(0, 40), status: "active", source: "chat", lastMessagePreview: null, updatedAt: "" };
          st.threads.unshift(th);
          st.messages[th.id] = [];
        }
        const now = new Date().toISOString();
        const reply = `Here is what I found about: ${body.message}`;
        const msgs = [
          { id: uid("msg"), role: "user", content: body.message, model: null, costUsd: null, latencyMs: null, createdAt: now },
          { id: uid("msg"), role: "agent", content: reply, model: a.modelAgent?.model ?? null, costUsd: 0.0042, latencyMs: 1800, createdAt: now },
        ];
        st.messages[th.id]!.push(...msgs);
        th.lastMessagePreview = reply;
        th.updatedAt = now;
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
      if (!th) return json(route, { error: "not_found" }, 404);
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
      if (!k) return json(route, { error: "not_found" }, 404);
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
      return t ? json(route, { template: t }) : json(route, { error: "not_found" }, 404);
    }
    if (b === "/integrations") return json(route, st.integrations);
    if (b === "/usage") {
      const days = Number(url.searchParams.get("days") ?? 7);
      if (st.opts.empty)
        return json(route, { totals: { spendUsd: 0, messages: 0, agents: 0, activeUsers: 0 }, byAgent: [], byUser: [], byModel: [], daily: [] });
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
        daily: [
          { date: day(0), spendUsd: 2.5, messages: 40 },
          { date: day(1), spendUsd: 4.1, messages: 70 },
          { date: day(3), spendUsd: 5.74, messages: 100 },
        ],
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
