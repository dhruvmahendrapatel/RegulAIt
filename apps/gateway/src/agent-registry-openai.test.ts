/**
 * ADR-0336 slice 3: the OpenAI adapter against a fake Compliance API (no real workspace; live workspaces are
 * owner-gated). Every call goes through the adapter's endpoint allow-list. The worker's own `checkRegistryAgents` is
 * then run on what the adapter produced.
 */
import { describe, expect, it } from "vitest";
import type { ScanContext, ScanSource } from "./discovery-scanners.js";
import { OPENAI_COMPLIANCE_ORIGIN, OPENAI_ENDPOINTS, OPENAI_GPT_FIELDS, OPENAI_GPT_SCANNED_FIELDS, OPENAI_SCANNER, gptComponents, gptScannedFields, openaiTargetProblem } from "./agent-registry-openai.js";
import { checkObservations } from "./discovery-worker.js";
import { allowListedFetch } from "./agent-platform-endpoints.js";
import { checkRegistryAgents } from "./agent-registry-records.js";

const WS = "0c1d2e3f-4a5b-4c6d-8e7f-000000000336";
const KEY = ["sk", "admin", "synthetic"].join("-");
const OWNER = "builder@acme.example.com";
/** a real-shaped credential (built at run time, so no scanner sees a token in this file) */
const TOKEN = ["gh", "p_", "A1b2C3d4".repeat(4), "E5f6"].join("");
/** free text a careless adapter might keep: it must never be staged; it carries a plaintext credential */
const SECRET_TEXT = `INSTRUCTIONS-never-stored: call the API with ${TOKEN} please`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const urlOf = (input: string | URL | Request) => new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

const gpt = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  object: "compliance.workspace.gpt",
  id,
  created_at: 1_760_000_000.5,
  owner_id: "user-AAAAAAAAAAAAAAAAAAAAAAAA",
  owner_email: OWNER,
  builder_name: "Community Builder",
  sharing: { visibility: "workspace", permissions: { can_read: true }, recipients: [{ id: "user-B", email: "other@acme.example.com" }] },
  latest_config: {
    object: "list",
    has_more: false,
    data: [
      {
        id: `${id}-cfg`,
        name,
        description: SECRET_TEXT,
        instructions: SECRET_TEXT,
        conversation_starters: [SECRET_TEXT],
        categories: ["hr"],
        created_at: 1_761_000_000,
        version_author: { id: "user-A", email: OWNER },
        files: { object: "list", data: [{ id: "file-abc123", name: "Handbook.pdf" }], has_more: false },
        tools: {
          object: "list",
          data: [
            { type: "browser", created_at: 1 },
            { type: "code_interpreter", created_at: 1 },
            { type: "custom_action", action_domain: "API.Workday.example.com", action_openapi_raw: SECRET_TEXT, action_privacy_policy_url: "https://x.example.com/p", auth_type: "oauth" },
            { type: "custom_action", action_domain: "crm.example.com", action_openapi_raw: SECRET_TEXT, auth_type: "api_key" },
            { type: "not_a_tool" },
          ],
        },
      },
    ],
  },
  ...extra,
});

interface FakeOpts {
  lastId?: unknown;
  page2Status?: number;
}

function fakeCompliance(opts: FakeOpts = {}) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = urlOf(input);
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${KEY}`) return json({ error: "unauthorized" }, 401);
    if (url.origin === OPENAI_COMPLIANCE_ORIGIN && url.pathname === `/v1/compliance/workspaces/${WS}/gpts`) {
      if (url.searchParams.get("after") === "g-HRhelper01") {
        if (opts.page2Status) return json({ error: "boom" }, opts.page2Status);
        return json({ object: "list", data: [gpt("g-Triage02", "Triage", { latest_config: { object: "list", data: [{ id: "c2", name: "Triage", files: { data: [] }, tools: { data: [] } }] } })], has_more: false, last_id: "g-Triage02" });
      }
      return json({ object: "list", data: [gpt("g-HRhelper01", "HR helper")], has_more: true, last_id: opts.lastId === undefined ? "g-HRhelper01" : opts.lastId });
    }
    return json({}, 404);
  }) as typeof fetch;
}

function run(opts: FakeOpts = {}, source: Partial<ScanSource> = {}) {
  const f = fakeCompliance(opts);
  const calls = { urls: [] as string[], methods: [] as string[], pseudonymised: [] as string[] };
  const ctx: ScanContext = {
    source: { id: "s-oai", name: "openai", kind: "agent_registry_openai", target: { workspaceId: WS.toUpperCase() }, scope: { orgLevel: true, include: [] }, ...source },
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
    pseudonymise: async (kind, name) => {
      calls.pseudonymised.push(`${kind}:${name}`);
      return "psn:0123456789abcdef01234567";
    },
    heartbeat: async () => true,
    signal: new AbortController().signal,
    catalogue: { matches: () => true, rows: () => [] },
  };
  return { promise: OPENAI_SCANNER.run(ctx), calls };
}

describe("ADR-0336 agent_registry_openai: targets", () => {
  it("names the workspace id (a UUID) and GPT ids; anything else is refused before a write", () => {
    expect(openaiTargetProblem({ workspaceId: WS }, { orgLevel: true, include: [] })).toBeNull();
    expect(openaiTargetProblem({ workspaceId: WS }, { orgLevel: false, include: ["g-HRhelper01"] })).toBeNull();
    for (const bad of ["", "acme", `${WS}/../users`, "https://api.chatgpt.com"]) expect(openaiTargetProblem({ workspaceId: bad }, { orgLevel: true, include: [] }), bad).toMatch(/workspaceId/);
    expect(openaiTargetProblem({ workspaceId: WS }, { orgLevel: false, include: ["../conversations"] })).toMatch(/GPT ids/);
  });
});

describe("ADR-0336 agent_registry_openai: the read", () => {
  it("reads live workspace GPTs (paged by `after` on our own URL) with tools, custom actions and files; owner as a pseudonym; unverified; GET only", async () => {
    const { promise, calls } = run();
    const res = await promise;
    expect(res.credentialWriteScope).toBe("unverified");
    expect(res.registriesComplete).toEqual(["openai_gpts"]);
    const [hr, triage] = res.registryAgents!;
    expect(hr!.externalId).toBe(`${WS}/g-HRhelper01`);
    expect(hr!.displayName).toBe("HR helper");
    expect(hr!.description).toBeNull();
    expect(hr!.attributes).toEqual({
      workspace: WS,
      gptId: "g-HRhelper01",
      configId: "g-HRhelper01-cfg",
      createdAt: "2025-10-09T08:53:20.500Z",
      configCreatedAt: "2025-10-20T22:40:00.000Z",
      visibility: "workspace",
      owners: ["psn:0123456789abcdef01234567"],
    });
    expect(hr!.components).toEqual([
      { kind: "tool", vendorRef: "browser", displayName: "Web browsing", enabled: true, providedBy: null },
      { kind: "tool", vendorRef: "code_interpreter", displayName: "Code interpreter", enabled: true, providedBy: null },
      { kind: "connected_app", vendorRef: "custom_action:api.workday.example.com", displayName: "api.workday.example.com", enabled: true, providedBy: "end_user" },
      { kind: "connected_app", vendorRef: "custom_action:crm.example.com", displayName: "crm.example.com", enabled: true, providedBy: "maker" },
      { kind: "knowledge", vendorRef: "file-abc123", displayName: "Handbook.pdf", enabled: true, providedBy: null },
    ]);
    expect(triage!.components).toEqual([]);
    // decision 4 and people as pseudonyms: no instruction, starter, description, action schema or email is staged
    const staged = JSON.stringify(res);
    expect(staged).not.toContain(SECRET_TEXT);
    expect(staged).not.toContain("acme.example.com\"");
    expect(staged).not.toContain(OWNER);
    expect(staged).not.toContain("Community Builder");
    expect(calls.pseudonymised).toEqual([`idp_user:${OWNER}`, `idp_user:${OWNER}`]);
    // file ids only (no download URLs), our own first URL, `after` passed back, GET only
    const urls = calls.urls.map((u) => new URL(u));
    expect(urls.map((u) => u.pathname)).toEqual([`/v1/compliance/workspaces/${WS}/gpts`, `/v1/compliance/workspaces/${WS}/gpts`]);
    expect(urls.every((u) => u.searchParams.get("file_format") === "id")).toBe(true);
    expect(urls[1]!.searchParams.get("after")).toBe("g-HRhelper01");
    expect(new Set(calls.methods)).toEqual(new Set(["GET"]));
    expect(() => checkRegistryAgents("agent_registry_openai", res.registryAgents, res.registriesComplete)).not.toThrow();
  });

  it("a next-page id of the wrong shape is partial (nothing marked absent); a listing that fails outright fails the run", async () => {
    const res = await run({ lastId: "https://evil.example.com" }).promise;
    expect(res.registriesComplete).toEqual([]);
    expect(res.registryAgents!.map((r) => r.displayName)).toEqual(["HR helper"]);
    // the run's one listing failed, so nothing at all is staged or marked absent
    await expect(run({ page2Status: 500 }).promise).rejects.toThrow(/nothing could be read/);
  });

  it("include scope keeps only the named GPTs", async () => {
    const res = await run({}, { scope: { orgLevel: false, include: ["g-Triage02"] } }).promise;
    expect(res.registryAgents!.map((r) => r.displayName)).toEqual(["Triage"]);
  });

  it("a configuration whose tools or files are not readable keeps the stored components", () => {
    expect(gptComponents({ tools: { data: [] } })).toBeNull();
    expect(gptComponents({ files: { data: [] } })).toBeNull();
  });
});

describe("ADR-0336 agent_registry_openai: the endpoint allow-list and the pinned fields", () => {
  it("admits GET on the GPT listing only; a single GPT, configs, files, delete and other origins are refused before sending", async () => {
    let sent = 0;
    const base = (async () => {
      sent++;
      return json({});
    }) as typeof fetch;
    const f = allowListedFetch(base, new Set([OPENAI_COMPLIANCE_ORIGIN]), OPENAI_ENDPOINTS);
    await f(`${OPENAI_COMPLIANCE_ORIGIN}/v1/compliance/workspaces/${WS}/gpts?limit=1`);
    for (const [url, method] of [
      [`${OPENAI_COMPLIANCE_ORIGIN}/v1/compliance/workspaces/${WS}/gpts/g-HRhelper01`, "GET"],
      [`${OPENAI_COMPLIANCE_ORIGIN}/v1/compliance/workspaces/${WS}/gpts/g-HRhelper01`, "DELETE"],
      [`${OPENAI_COMPLIANCE_ORIGIN}/v1/compliance/workspaces/${WS}/gpts/g-HRhelper01/configs`, "GET"],
      [`${OPENAI_COMPLIANCE_ORIGIN}/v1/compliance/workspaces/${WS}/gpt_files/file-abc123`, "GET"],
      [`${OPENAI_COMPLIANCE_ORIGIN}/v1/compliance/workspaces/${WS}/conversations`, "GET"],
      [`${OPENAI_COMPLIANCE_ORIGIN}/v1/compliance/workspaces/${WS}/gpts`, "POST"],
      [`https://evil.example.com/v1/compliance/workspaces/${WS}/gpts`, "GET"],
    ] as const) {
      await expect(f(url, { method })).rejects.toThrow(/refused before sending/);
    }
    expect(sent).toBe(1);
  });

  it("pins the fields read: no instructions, starters, description, categories, action schema or file content", () => {
    const all = Object.values(OPENAI_GPT_FIELDS).flat() as string[];
    for (const banned of ["instructions", "conversation_starters", "description", "categories", "action_openapi_raw", "action_privacy_policy_url", "download_url", "builder_name"]) expect(all).not.toContain(banned);
  });
});

describe("ADR-0336 slice 4: plaintext credentials in a GPT's configuration, by location only", () => {
  it("reports each field with a credential as agent_config evidence: subject, field path and rule id, nothing else", async () => {
    const res = await run().promise;
    const hr = `${WS}/g-HRhelper01`;
    const base = "gpts/g-HRhelper01/configs/g-HRhelper01-cfg";
    expect(res.observations).toEqual([
      { evidenceKind: "agent_config", subjectKind: "system", subject: hr, location: { path: `${base}/instructions` }, secretRule: "pipelock.secrets.github_token" },
      { evidenceKind: "agent_config", subjectKind: "system", subject: hr, location: { path: `${base}/description` }, secretRule: "pipelock.secrets.github_token" },
      { evidenceKind: "agent_config", subjectKind: "system", subject: hr, location: { path: `${base}/conversation_starters/0` }, secretRule: "pipelock.secrets.github_token" },
      { evidenceKind: "agent_config", subjectKind: "system", subject: hr, location: { path: `${base}/tools/custom_action:api.workday.example.com/action_openapi_raw` }, secretRule: "pipelock.secrets.github_token" },
      { evidenceKind: "agent_config", subjectKind: "system", subject: hr, location: { path: `${base}/tools/custom_action:crm.example.com/action_openapi_raw` }, secretRule: "pipelock.secrets.github_token" },
    ]);
    // not one 8-character run of the credential, nor any excerpt of the text, anywhere in what the run returns
    const out = JSON.stringify(res);
    for (let i = 0; i + 8 <= TOKEN.length; i++) expect(out).not.toContain(TOKEN.slice(i, i + 8));
    expect(out).not.toContain("call the API");
    // the worker's own contract accepts exactly this, with the platform vendor set from the kind
    const checked = checkObservations("agent_registry_openai", res.observations!, "2026-11-21T00:00:00.000Z");
    expect(checked[0]).toMatchObject({ signalSource: "agent_config", subjectKind: "system", subject: hr, configSecret: { rule: "pipelock.secrets.github_token", vendor: "openai" }, location: { path: `${base}/instructions` } });
  });

  it("a clean configuration reports nothing; the scanned fields are pinned and are never kept", () => {
    expect(gptScannedFields("g-x", { id: "c", instructions: "be kind", tools: { data: [] } }).map((f) => f.path)).toEqual(["gpts/g-x/configs/c/instructions", "gpts/g-x/configs/c/description"]);
    expect(OPENAI_GPT_SCANNED_FIELDS).toEqual({ config: ["instructions", "description", "conversation_starters"], tool: ["action_openapi_raw"] });
    const kept = Object.values(OPENAI_GPT_FIELDS).flat() as string[];
    for (const f of Object.values(OPENAI_GPT_SCANNED_FIELDS).flat()) expect(kept).not.toContain(f);
    // a config id that is not a plain identifier never reaches the path
    expect(gptScannedFields("g-x", { id: "a b/../c", instructions: "x" })[0]!.path).toBe("gpts/g-x/configs/latest/instructions");
  });
});
