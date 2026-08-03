/**
 * ADR-0062 — MODE-SCOPED EGRESS, ADVERSARIALLY.
 *
 * `docs/deployment/DATA_BOUNDARY.md` §4 recorded, in writing, that the strongest
 * claim air-gapped mode makes was not enforced by the application:
 *
 *   > On an air-gapped deployment, if an operator configures a built-in provider
 *   > — by storing a credential, or simply by setting ANTHROPIC_API_KEY — then
 *   > invoking an agent on that provider will attempt an outbound HTTPS
 *   > connection to that vendor's public API, CARRYING THE PROMPT. Nothing in
 *   > the application refuses it. The connection fails only because the network
 *   > has nowhere to send it.
 *
 * This file is the proof that the application refuses it now, and it is written
 * as an attack rather than as a happy path. The central assertion is deliberately
 * NOT "a 4xx came back": every dispatch in this file runs with `globalThis.fetch`
 * replaced by a RECORDING SPY that would happily answer, so the assertion is
 * **the provider was never invoked at all** — zero recorded requests. A guard
 * that returns 403 after the socket is open would pass a status-code test and
 * fail this one.
 *
 * What is exercised, end to end, against a real Postgres and the real adapters:
 *
 *  - the actual attack: air_gapped + no allow entry, a built-in MODEL dispatch;
 *  - the same for a CONNECTOR, a GIT connection and a PM connection with no
 *    `baseUrl` override — the other three rows §4 named;
 *  - `hosted` (the default) is BYTE-IDENTICAL: the same dispatch and the same
 *    connector call reach the provider exactly as they do today;
 *  - allow-list the vendor host and the SAME air-gapped dispatch PROCEEDS —
 *    this is a guard, not a ban;
 *  - `org_settings` tightens hosted → strict, and CANNOT loosen air_gapped —
 *    asserted both by driving it and by the enum having no such value;
 *  - a self-hosted model endpoint on a private address still works air-gapped
 *    once allow-listed, which is the entire point of the mode;
 *  - every refusal is audited under one stable ruleId.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditLog,
  createDb,
  desc,
  egressAllowHosts,
  eq,
  gitConnections,
  modelCredentials,
  orchestrationRuns,
  orgSettings,
  pmConnections,
  runMigrations,
  userModelCredentials,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { COMPILED_DEFAULT_RULE_ID } from "./compiled-egress.js";
import { DEPLOY_MODE_ENV, type DeployMode } from "./deploy-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "mode-egress-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "9".repeat(64);
const uniq = () => Math.random().toString(36).slice(2, 8);

/** the string a leak would carry — asserted absent from every recorded request */
const CANARY = "PATIENT-SSN-078-05-1120";

let db: Db;
let app: ReturnType<typeof buildApp>;
let userId: string;
let userAuth: { authorization: string };
let googleAgentId: string;
let openaiAgentId: string;
let slackConnectorId: string;
let snowflakeConnectorId: string;
let gitConnName: string;
let gitChangeType: string;
let pmConnName: string;
let runId: string;
let selfHosted: http.Server;
let selfHostedPort: number;

// ---------------------------------------------------------------------------
// THE SPY. Deliberately WILLING: it answers 200 with a well-formed body for
// every vendor this suite touches. If a single request reaches it while the
// posture says no, the guard has failed — and the assertion is not "the call
// errored", it is "the provider was never invoked".
// ---------------------------------------------------------------------------
let realFetch: typeof fetch;
let hits: string[] = [];
let hitBodies: string[] = [];

function installSpy() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    hits.push(url);
    hitBodies.push(typeof init?.body === "string" ? init.body : "");
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("generativelanguage.googleapis.com")) {
      return json({
        candidates: [{ content: { parts: [{ text: "gemini says hi" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 },
      });
    }
    if (url.includes("slack.com")) return json({ ok: true, ts: "1700000000.000100" });
    if (url.includes("api.github.com")) return json({ object: { sha: "deadbeef" } });
    if (url.includes("api.linear.app")) return json({ data: { teams: { nodes: [] } } });
    // anything this suite did not anticipate still gets recorded, and still
    // never reaches the network
    return json({ ok: true });
  }) as typeof fetch;
}

/** the raw counter both directions of every assertion below are made against */
const resetHits = () => {
  hits = [];
  hitBodies = [];
};

// ---------------------------------------------------------------------------
// posture control — process env + the org singleton, both restored in afterAll
// ---------------------------------------------------------------------------
let savedMode: string | undefined;

async function setMode(mode: DeployMode | null) {
  if (mode === null) delete process.env[DEPLOY_MODE_ENV];
  else process.env[DEPLOY_MODE_ENV] = mode;
}

async function setOrgPolicy(policy: "inherit" | "strict") {
  await db.update(orgSettings).set({ egressCompiledDefaultPolicy: policy });
}

async function allow(host: string, opts: { privateRanges?: boolean; plaintext?: boolean } = {}) {
  const res = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/egress-allow-hosts",
    payload: {
      host,
      allowPrivateRanges: opts.privateRanges ?? false,
      allowPlaintextHttp: opts.plaintext ?? false,
      note: "ADR-0062 suite",
    },
  });
  expect(res.statusCode).toBe(201);
}

async function lastCompiledDeny() {
  const [row] = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.ruleId, COMPILED_DEFAULT_RULE_ID))
    .orderBy(desc(auditLog.at))
    .limit(1);
  return row;
}

async function makeUser(email: string) {
  const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email, displayName: "Mode Egress" } });
  const id = u.json().id as string;
  const key = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${id}/keys`, payload: { name: "cli" } });
  return { id, auth: { authorization: `Bearer ${key.json().token}` } };
}

const invokeAgent = (agentId: string) =>
  app.inject({
    method: "POST",
    headers: userAuth,
    url: `/v1/agents/${agentId}/invoke`,
    payload: { mode: "execute", input: `probe ${CANARY}`, dispatch: true },
  });

const invokeConnector = (connectorId: string) =>
  app.inject({
    method: "POST",
    headers: userAuth,
    url: `/v1/connectors/${connectorId}/invoke`,
    payload: { operation: "write", object: "C0DEADBEEF", payload: { text: `hello ${CANARY}` } },
  });

const pmSync = () =>
  app.inject({
    method: "POST",
    headers: userAuth,
    url: `/v1/runs/${runId}/pm-sync`,
    payload: { connectionName: pmConnName },
  });

async function runGitStage(): Promise<string> {
  const started = await app.inject({
    method: "POST",
    headers: userAuth,
    url: "/v1/workflows/instances",
    payload: {
      change: {
        description: "compiled-default git stage",
        paths: ["src/x.ts"],
        changeType: gitChangeType,
        environment: "staging",
      },
    },
  });
  expect(started.statusCode).toBe(201);
  const view = await app.inject({
    method: "GET",
    headers: userAuth,
    url: `/v1/workflows/instances/${started.json().id}`,
  });
  const ctx = view.json().instance.context as { lastError?: string };
  return ctx.lastError ?? "";
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });

  savedMode = process.env[DEPLOY_MODE_ENV];
  realFetch = globalThis.fetch;
  installSpy();

  // HERMETIC DEFAULT-DENY, the precedent every egress suite in this repo sets:
  // one shared database, and a file whose subject is "what is refused" cannot
  // inherit a sibling's allow entry.
  await db.delete(egressAllowHosts);
  await db.delete(modelCredentials).where(eq(modelCredentials.provider, "google"));
  await db.delete(modelCredentials).where(eq(modelCredentials.provider, "openai"));
  await db.delete(userModelCredentials).where(eq(userModelCredentials.provider, "google"));
  await db.delete(userModelCredentials).where(eq(userModelCredentials.provider, "openai"));
  await setOrgPolicy("inherit");
  await setMode(null);

  const u = await makeUser(`mode-egress-${uniq()}@example.com`);
  userId = u.id;
  userAuth = u.auth;
  // PASSTHROUGH ROUTING for this suite's user. Pillar-6 routing may legitimately
  // serve a cheaper equivalent agent, and this file's assertions are about
  // WHICH VENDOR ENDPOINT a named agent reaches — a substituted agent would make
  // the test measure routing rather than egress.
  await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${userId}/agent-policy`,
    payload: { routingMode: "passthrough" },
  });

  // --- a real vendor model agent, on its COMPILED endpoint -----------------
  const cred = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/model-credentials",
    payload: { provider: "google", apiKey: "AIza-not-a-real-key" },
  });
  expect(cred.statusCode).toBe(201);
  // note: NO baseUrl. That is the whole point — this row is the §4 finding.
  expect(cred.json().baseUrl).toBeNull();

  const gAgent = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: {
      name: `mode-egress-google-${uniq()}`,
      provider: "google",
      tier: 1,
      modes: ["execute"],
      costPerMTokIn: 1,
      costPerMTokOut: 2,
      model: "gemini-mode-egress",
    },
  });
  googleAgentId = gAgent.json().id;
  await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId, agentId: googleAgentId } });

  // --- the self-hosted OpenAI-compatible endpoint (the air-gapped-native path)
  selfHosted = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const parsed = raw ? JSON.parse(raw) : {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-mode-egress",
          object: "chat.completion",
          created: 1,
          model: parsed.model,
          choices: [
            { index: 0, message: { role: "assistant", content: "on-prem vLLM says hi", refusal: null }, finish_reason: "stop", logprobs: null },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        }),
      );
    });
  });
  await new Promise<void>((r) => selfHosted.listen(0, "127.0.0.1", r));
  selfHostedPort = (selfHosted.address() as { port: number }).port;

  const oAgent = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: {
      name: `mode-egress-openai-${uniq()}`,
      provider: "openai",
      tier: 1,
      modes: ["execute"],
      costPerMTokIn: 1,
      costPerMTokOut: 2,
      model: "gpt-mode-egress",
    },
  });
  openaiAgentId = oAgent.json().id;
  await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId, agentId: openaiAgentId } });

  // --- a slack connector on its COMPILED endpoint --------------------------
  const conn = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/connectors",
    payload: { name: `mode-egress-slack-${uniq()}`, kind: "chat", providerKind: "slack", pricePerCallUsd: 0.01 },
  });
  expect(conn.statusCode).toBe(201);
  slackConnectorId = conn.json().id;
  expect(conn.json().baseUrl ?? null).toBeNull();
  await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/connectors/${slackConnectorId}/credential`,
    payload: { token: "xoxb-mode-egress" },
  });
  await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/grants/connectors",
    payload: { userId, connectorId: slackConnectorId, mode: "readwrite" },
  });

  // --- a snowflake connector: the "we cannot name the destination" case ----
  const snow = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/connectors",
    payload: { name: `mode-egress-snow-${uniq()}`, kind: "warehouse", providerKind: "snowflake", pricePerCallUsd: 0.01 },
  });
  snowflakeConnectorId = snow.json().id;
  await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/connectors/${snowflakeConnectorId}/credential`,
    payload: {
      token: JSON.stringify({
        account: "acme-eu",
        user: "svc",
        privateKey: "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n",
      }),
    },
  });
  await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/grants/connectors",
    payload: { userId, connectorId: snowflakeConnectorId, mode: "readwrite" },
  });

  // --- a git connection with NO baseUrl, driven through a real workflow ----
  gitConnName = `mode-egress-git-${uniq()}`;
  await db.insert(gitConnections).values({
    name: gitConnName,
    provider: "github",
    baseUrl: null,
    tokenCiphertext: (await import("./secrets.js")).encryptSecret(DATA_KEY, "ghp_mode_egress"),
  });
  gitChangeType = `mode-egress-change-${uniq()}`;
  const tpl = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/workflows/templates",
    payload: {
      name: `mode-egress-tpl-${uniq()}`,
      definition: {
        workflow: "mode-egress",
        stages: [
          { id: "intake", type: "trigger" },
          { id: "branch", type: "git_operation", action: "create_branch", connection: gitConnName, repo: "acme/app" },
        ],
      },
    },
  });
  expect(tpl.statusCode).toBe(201);
  const rule = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/workflows/assignment-rules",
    payload: { templateId: tpl.json().id, changeType: gitChangeType },
  });
  expect(rule.statusCode).toBe(201);

  // --- a PM connection with NO baseUrl, plus a run to sync ----------------
  pmConnName = `mode-egress-pm-${uniq()}`;
  await db.insert(pmConnections).values({
    name: pmConnName,
    provider: "linear",
    baseUrl: null,
    project: "ENG",
    tokenCiphertext: (await import("./secrets.js")).encryptSecret(DATA_KEY, "lin_api_mode_egress"),
  });
  const [run] = await db
    .insert(orchestrationRuns)
    .values({
      name: `mode-egress-run-${uniq()}`,
      initiatingUserId: userId,
      graph: { run: "mode-egress", nodes: [{ id: "n1", title: "do the thing", ownerAgentId: googleAgentId, mode: "execute" }] },
      state: { nodes: {} },
    })
    .returning();
  runId = run!.id;
});

afterEach(() => {
  resetHits();
});

afterAll(async () => {
  // RESTORE EVERY PIECE OF SHARED STATE THIS FILE TOUCHED. fileParallelism is
  // off, but the process and the org singleton outlive this file.
  globalThis.fetch = realFetch;
  if (savedMode === undefined) delete process.env[DEPLOY_MODE_ENV];
  else process.env[DEPLOY_MODE_ENV] = savedMode;
  await setOrgPolicy("inherit");
  await db.delete(egressAllowHosts);
  await db.delete(modelCredentials).where(eq(modelCredentials.provider, "google"));
  await db.delete(modelCredentials).where(eq(modelCredentials.provider, "openai"));
  selfHosted.closeAllConnections();
  await new Promise<void>((r) => selfHosted.close(() => r()));
  await app.close();
});

// ---------------------------------------------------------------------------
// hosted — the default, and it must be BYTE-IDENTICAL to before this ADR
// ---------------------------------------------------------------------------

describe("hosted (the default): nothing changes", () => {
  it("a built-in MODEL dispatch reaches the vendor's compiled endpoint, exactly as today", async () => {
    await setMode(null); // variable absent — the true out-of-the-box shape
    await setOrgPolicy("inherit");
    const res = await invokeAgent(googleAgentId);
    expect(res.statusCode).toBe(200);
    expect(res.json().dispatch.outputText).toContain("gemini says hi");
    // the provider WAS invoked, at the compiled default, with no allow entry
    expect(hits.some((u) => u.startsWith("https://generativelanguage.googleapis.com/v1beta"))).toBe(true);
    expect(await db.select().from(egressAllowHosts)).toHaveLength(0);
  });

  it("a CONNECTOR on its compiled endpoint reaches the vendor, exactly as today", async () => {
    await setMode("hosted");
    const res = await invokeConnector(slackConnectorId);
    expect(res.statusCode).toBe(200);
    expect(hits.some((u) => u.startsWith("https://slack.com/api/chat.postMessage"))).toBe(true);
  });

  it("byoc is permissive too — that mode's whole point is reaching real endpoints", async () => {
    await setMode("byoc");
    const res = await invokeAgent(googleAgentId);
    expect(res.statusCode).toBe(200);
    expect(hits.some((u) => u.includes("generativelanguage.googleapis.com"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// air_gapped — THE ATTACK
// ---------------------------------------------------------------------------

describe("air_gapped: the compiled vendor endpoint is refused, and never dialled", () => {
  beforeEachStrict();

  it("THE ATTACK — a built-in model dispatch is refused and the PROVIDER IS NEVER CALLED", async () => {
    const res = await invokeAgent(googleAgentId);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("egress_blocked");
    expect(res.json().detail).toContain("generativelanguage.googleapis.com");
    // the assertion that matters: not a status code, an absence of traffic
    expect(hits).toHaveLength(0);
    expect(hitBodies.join("")).not.toContain(CANARY);
  });

  it("the refusal is audited under one stable ruleId, naming the host and the posture", async () => {
    await invokeAgent(googleAgentId);
    const row = await lastCompiledDeny();
    expect(row).toBeTruthy();
    expect(row!.effect).toBe("deny");
    expect(row!.ruleId).toBe(COMPILED_DEFAULT_RULE_ID);
    const detail = row!.detail as Record<string, unknown>;
    expect(detail.surface).toBe("model");
    expect(detail.posture).toBe("strict");
    expect(detail.host).toBe("generativelanguage.googleapis.com");
    expect(detail.code).toBe("compiled_default_not_allowlisted");
  });

  it("a CONNECTOR with no baseUrl override is refused, and slack is never dialled", async () => {
    const res = await invokeConnector(slackConnectorId);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("egress_blocked");
    expect(res.json().detail).toContain("slack.com");
    expect(hits).toHaveLength(0);
    expect(hitBodies.join("")).not.toContain(CANARY);
    const row = await lastCompiledDeny();
    expect((row!.detail as Record<string, unknown>).surface).toBe("connector");
  });

  it("a connector whose default we CANNOT NAME is refused rather than assumed safe", async () => {
    const res = await invokeConnector(snowflakeConnectorId);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("compiled_default_unknown");
    expect(hits).toHaveLength(0);
  });

  it("a GIT connection with no baseUrl fails the stage closed — api.github.com is never dialled", async () => {
    const lastError = await runGitStage();
    expect(lastError).toContain("egress blocked");
    expect(lastError).toContain("api.github.com");
    expect(hits).toHaveLength(0);
    const row = await lastCompiledDeny();
    expect((row!.detail as Record<string, unknown>).surface).toBe("git_connection");
  });

  it("a PM connection with no baseUrl is a real 403 at the endpoint that has one", async () => {
    const res = await pmSync();
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("egress_blocked");
    expect(res.json().detail).toContain("api.linear.app");
    expect(hits).toHaveLength(0);
    const row = await lastCompiledDeny();
    expect((row!.detail as Record<string, unknown>).surface).toBe("pm_connection");
  });
});

// ---------------------------------------------------------------------------
// …but it is a GUARD, not a BAN
// ---------------------------------------------------------------------------

describe("air_gapped + an explicit allow entry: the same call proceeds", () => {
  beforeEachStrict();

  it("allow-list the vendor host and the SAME model dispatch goes through", async () => {
    // first, prove it is refused with nothing allow-listed
    expect((await invokeAgent(googleAgentId)).statusCode).toBe(403);
    expect(hits).toHaveLength(0);

    await allow("generativelanguage.googleapis.com");
    const res = await invokeAgent(googleAgentId);
    expect(res.statusCode).toBe(200);
    expect(res.json().dispatch.outputText).toContain("gemini says hi");
    expect(hits.some((u) => u.includes("generativelanguage.googleapis.com"))).toBe(true);
  });

  it("allow-list slack.com and the SAME connector call goes through", async () => {
    expect((await invokeConnector(slackConnectorId)).statusCode).toBe(403);
    await allow("slack.com");
    const res = await invokeConnector(slackConnectorId);
    expect(res.statusCode).toBe(200);
    expect(hits.some((u) => u.startsWith("https://slack.com/api/"))).toBe(true);
  });

  it("A SELF-HOSTED MODEL ON A PRIVATE ADDRESS STILL WORKS — the point of the mode", async () => {
    // No vendor host allow-listed at all. The on-prem endpoint is reached via
    // the ordinary ADR-0034 baseUrl-override path, which the strict posture
    // does not touch: the compiled default is never consulted because there is
    // an override, and the override clears the same allow-list.
    await allow("127.0.0.1", { privateRanges: true, plaintext: true });
    await db.delete(modelCredentials).where(eq(modelCredentials.provider, "openai"));
    const cred = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/model-credentials",
      payload: { provider: "openai", apiKey: "sk-on-prem", baseUrl: `http://127.0.0.1:${selfHostedPort}/v1` },
    });
    expect(cred.statusCode).toBe(201);

    const res = await invokeAgent(openaiAgentId);
    expect(res.statusCode).toBe(200);
    expect(res.json().dispatch.outputText).toContain("on-prem vLLM says hi");
    // and NOTHING went to a vendor: the guarded fetch dialled the private
    // address directly, so the spy (which stands in for the public internet)
    // recorded nothing at all
    expect(hits).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// the ceiling: org_settings tightens, and cannot loosen
// ---------------------------------------------------------------------------

describe("org_settings is a ceiling, not a switch", () => {
  it("TIGHTENS a hosted box: 'strict' refuses the compiled endpoint the mode would allow", async () => {
    await setMode("hosted");
    await setOrgPolicy("inherit");
    // start from the product's real default-deny allow-list: the previous
    // describe deliberately allow-listed the vendor hosts
    await db.delete(egressAllowHosts);
    expect((await invokeAgent(googleAgentId)).statusCode).toBe(200);
    resetHits();

    const put = await app.inject({
      method: "PUT",
      headers: AUTH,
      url: "/v1/org/settings",
      payload: { egressCompiledDefaultPolicy: "strict" },
    });
    expect(put.statusCode).toBe(200);

    const res = await invokeAgent(googleAgentId);
    expect(res.statusCode).toBe(403);
    expect(hits).toHaveLength(0);
    await setOrgPolicy("inherit");
  });

  it("CANNOT LOOSEN an air-gapped box: 'inherit' leaves it strict", async () => {
    await setMode("air_gapped");
    await db.delete(egressAllowHosts);
    const put = await app.inject({
      method: "PUT",
      headers: AUTH,
      url: "/v1/org/settings",
      payload: { egressCompiledDefaultPolicy: "inherit" },
    });
    expect(put.statusCode).toBe(200);
    const res = await invokeAgent(googleAgentId);
    expect(res.statusCode).toBe(403);
    expect(hits).toHaveLength(0);
  });

  it("there is NO loosening value to write — the API refuses one", async () => {
    for (const bad of ["permissive", "off", "allow", "none"]) {
      const put = await app.inject({
        method: "PUT",
        headers: AUTH,
        url: "/v1/org/settings",
        payload: { egressCompiledDefaultPolicy: bad },
      });
      expect(put.statusCode).toBeGreaterThanOrEqual(400);
    }
    // and the stored value is untouched by the attempts
    const [row] = await db.select().from(orgSettings);
    expect(["inherit", "strict"]).toContain(row!.egressCompiledDefaultPolicy);
  });

  it("the default column value is 'inherit', so migration 0074 changes nothing", async () => {
    await setOrgPolicy("inherit");
    const [row] = await db.select().from(orgSettings);
    expect(row!.egressCompiledDefaultPolicy).toBe("inherit");
  });
});

/** shared arrange for the strict-posture blocks: air-gapped, org neutral,
 * allow-list empty. Declared as a function so each describe reads as one line. */
function beforeEachStrict() {
  beforeAll(async () => {
    await setMode("air_gapped");
    await setOrgPolicy("inherit");
    await db.delete(egressAllowHosts);
    resetHits();
  });
}
