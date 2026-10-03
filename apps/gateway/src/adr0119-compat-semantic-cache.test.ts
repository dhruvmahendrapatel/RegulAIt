import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  and,
  costEvents,
  createDb,
  eq,
  guardrailConfigs,
  runMigrations,
  semanticCache,
  usageEvents,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { AGENT_HEADER, PROJECT_HEADER } from "./compat-core.js";
import { lookupSemanticCache, semanticCacheRequestKey, storeSemanticCache } from "./semantic-cache-shared.js";

/**
 * ADR-0119 — THE SEMANTIC CACHE ON THE COMPAT / IDE PATH.
 *
 * THE LOAD-BEARING EVIDENCE IS "NO PROVIDER CALL", not "the answer matched".
 * Two identical requests return the same text whether or not a cache exists,
 * so asserting equality proves nothing. Every hit assertion below is paired
 * with a `usage_events` delta of ZERO — measured spend is what distinguishes a
 * cache hit from a fast model — and every MISS assertion is paired with a
 * delta of one, so "no new usage row" can never be the zero of a request that
 * failed for an unrelated reason (M-033).
 *
 * Fixtures are resolved by ids created here, and the compat calls NAME their
 * agent rather than relying on the model string, which in a shared database
 * resolves to whatever another file happened to register (M-037).
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `adr0119-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let userA: string;
let authA: { authorization: string };
let userB: string;
let authB: { authorization: string };
let agentId: string;

const usageCount = async (userId: string) =>
  (await db.select().from(usageEvents).where(eq(usageEvents.userId, userId))).length;

const cacheSavingsCount = async (userId: string) =>
  (
    await db
      .select()
      .from(costEvents)
      .where(and(eq(costEvents.userId, userId), eq(costEvents.technique, "semantic_caching")))
  ).length;

async function setPolicy(policy: "off" | "opt_in" | "always") {
  const r = await app.inject({
    method: "PUT",
    url: "/v1/org/settings",
    headers: AUTH,
    payload: { semanticCachePolicy: policy },
  });
  expect(r.statusCode).toBe(200);
}

async function putOrg(patch: Record<string, unknown>) {
  const res = await app.inject({ method: "PUT", url: "/v1/org/settings", headers: AUTH, payload: patch });
  expect(res.statusCode).toBe(200);
}

async function setMrm(enforced: boolean) {
  const res = await app.inject({ method: "POST", url: "/v1/mrm/enforcement", headers: AUTH, payload: { enforced } });
  expect(res.statusCode).toBe(200);
}

async function setDlp(mode: "log" | "block") {
  const res = await app.inject({
    method: "PUT", url: "/v1/guardrails/config", headers: AUTH,
    payload: { modes: { semantic_dlp: mode } },
  });
  expect(res.statusCode).toBe(200);
}

async function primeCompat(prompt: string, projectId?: string) {
  await setPolicy("always");
  const first = await ask(authA, prompt, {}, projectId);
  expect(first.statusCode).toBe(200);
  const usage = await usageCount(userA);
  const savings = await cacheSavingsCount(userA);
  const hit = await ask(authA, prompt, {}, projectId);
  expect(hit.statusCode).toBe(200);
  expect(await usageCount(userA)).toBe(usage);
  expect(await cacheSavingsCount(userA)).toBe(savings + 1);
  return hit.json().content[0].text as string;
}

async function expectCompatCacheDenied(
  prompt: string,
  error: string,
  priorText: string,
  projectId?: string,
  auth = authA,
) {
  const usage = await usageCount(userA);
  const savings = await cacheSavingsCount(userA);
  const res = await ask(auth, prompt, {}, projectId);
  expect(res.statusCode).toBeGreaterThanOrEqual(400);
  expect(res.json().error.regulait_code).toBe(error);
  expect(res.body).not.toContain(priorText);
  expect(await usageCount(userA)).toBe(usage);
  expect(await cacheSavingsCount(userA)).toBe(savings);
}

/** One Anthropic-shaped call, naming the agent so resolution is unambiguous. */
function ask(auth: { authorization: string }, text: string, extra: Record<string, unknown> = {}, projectId?: string) {
  return app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { ...auth, [AGENT_HEADER]: agentId, ...(projectId ? { [PROJECT_HEADER]: projectId } : {}) },
    payload: {
      model: `adr0119-model-${RUN}`,
      max_tokens: 64,
      messages: [{ role: "user", content: text }],
      ...extra,
    },
  });
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "e".repeat(64) });

  const mk = async (tag: string) => {
    const u = await app.inject({
      method: "POST",
      url: "/v1/users",
      headers: AUTH,
      payload: { email: `adr0119-${tag}-${RUN}@example.com`, displayName: `ADR119 ${tag}` },
    });
    const id = u.json().id;
    const k = await app.inject({
      method: "POST",
      url: `/v1/users/${id}/keys`,
      headers: AUTH,
      payload: { name: `adr0119-${tag}` },
    });
    return { id, auth: { authorization: `Bearer ${k.json().token}` } };
  };
  const a = await mk("a");
  userA = a.id;
  authA = a.auth;
  const b = await mk("b");
  userB = b.id;
  authB = b.auth;

  // ADR-0020 ships both compat surfaces OFF — turn the Anthropic one on, since
  // this file is mostly about that surface, and the OpenAI one for the single
  // identity field (`response_format`) that only its dialect can express.
  const ic = await app.inject({
    method: "PUT",
    url: "/v1/interception/settings",
    headers: AUTH,
    payload: { anthropicCompatEnabled: true, openaiCompatEnabled: true },
  });
  expect(ic.statusCode).toBe(200);

  const ag = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: AUTH,
    payload: {
      name: `adr0119-mock-${RUN}`,
      provider: "mock",
      tier: 1,
      costPerMTokIn: 3,
      costPerMTokOut: 15,
      model: `adr0119-model-${RUN}`,
    },
  });
  agentId = ag.json().id;
  for (const uid of [userA, userB]) {
    await app.inject({
      method: "POST",
      url: "/v1/grants/agents",
      headers: AUTH,
      payload: { userId: uid, agentId },
    });
  }
});

afterAll(async () => {
  await setPolicy("opt_in");
  // restore ADR-0020's shipped posture (shared database, M-040)
  await app.inject({
    method: "PUT", url: "/v1/interception/settings", headers: AUTH,
    payload: { anthropicCompatEnabled: false, openaiCompatEnabled: false },
  });
  await app.close();
});

describe("the technique the IDE path was missing", () => {
  it("a repeat question is served from cache — no provider call, and the saving is recorded", async () => {
    await setPolicy("always");
    const prompt = `what does adr0119-${RUN} do`;

    const beforeUsage = await usageCount(userA);
    const beforeSavings = await cacheSavingsCount(userA);

    const first = await ask(authA, prompt);
    expect(first.statusCode).toBe(200);
    // MISS: exactly one new usage row — the provider really was called, which
    // is what makes the zero below meaningful rather than incidental.
    expect(await usageCount(userA)).toBe(beforeUsage + 1);
    expect(await cacheSavingsCount(userA)).toBe(beforeSavings);

    const second = await ask(authA, prompt);
    expect(second.statusCode).toBe(200);
    // HIT: no NEW usage row at all, and one savings row
    expect(await usageCount(userA)).toBe(beforeUsage + 1);
    expect(await cacheSavingsCount(userA)).toBe(beforeSavings + 1);

    // and the wire contract is untouched — an IDE cannot tell a hit from a
    // very fast model
    const body = second.json();
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(Array.isArray(body.content)).toBe(true);
    expect(body.content[0].text).toBe(first.json().content[0].text);
  });

  it("case and whitespace changes miss because they can change model behavior", async () => {
    await setPolicy("always");
    const prompt = `normalised question ${RUN}`;
    await ask(authA, prompt);

    const beforeUsage = await usageCount(userA);
    const res = await ask(authA, `   ${prompt.toUpperCase()}   `);
    expect(res.statusCode).toBe(200);
    expect(await usageCount(userA)).toBe(beforeUsage + 1);
  });

  it("does not reuse an answer when system, role, boundary, or output contract changes", async () => {
    await setPolicy("always");
    const prompt = `identity question ${RUN}`;
    await ask(authA, prompt);
    const variants = [
      { system: "Answer in French" },
      { max_tokens: 65 },
      { messages: [{ role: "assistant", content: prompt }] },
      { messages: [{ role: "user", content: "identity" }, { role: "user", content: `question ${RUN}` }] },
    ];
    for (const extra of variants) {
      const before = await usageCount(userA);
      const res = await ask(authA, prompt, extra);
      expect(res.statusCode).toBe(200);
      expect(await usageCount(userA)).toBe(before + 1);
    }
  });
});

describe("the governance boundary the shared module exists to protect", () => {
  it("rechecks a virtual key's live budget before serving its cached answer", async () => {
    await setPolicy("always");
    const issued = await app.inject({
      method: "POST", url: "/v1/virtual-keys", headers: authA,
      payload: { name: `aer010-key-${RUN}`, budgetUsd: 1 },
    });
    expect(issued.statusCode).toBe(201);
    const keyAuth = { authorization: `Bearer ${issued.json().token as string}` };
    const prompt = `aer010 virtual key ${RUN}`;
    const first = await ask(keyAuth, prompt);
    expect(first.statusCode).toBe(200);
    const hit = await ask(keyAuth, prompt);
    expect(hit.statusCode).toBe(200);
    const changed = await app.inject({
      method: "PATCH", url: `/v1/virtual-keys/${issued.json().id as string}`,
      headers: authA, payload: { budgetUsd: 0 },
    });
    expect(changed.statusCode).toBe(200);
    await expectCompatCacheDenied(prompt, "virtual_key_budget_exhausted", hit.json().content[0].text, undefined, keyAuth);
  });

  it("rechecks a project-linked use case and a project's live budget before a hit", async () => {
    const prior = (await app.inject({ method: "GET", url: "/v1/org/settings", headers: AUTH })).json().settings.useCaseGateMode as string;
    const project = await app.inject({
      method: "POST", url: "/v1/projects", headers: AUTH,
      payload: { name: `aer010-project-${RUN}`, budgetUsd: 0.01, budgetApproverUserId: userB },
    });
    expect(project.statusCode).toBe(201);
    const projectId = project.json().id as string;
    const member = await app.inject({
      method: "POST", url: `/v1/projects/${projectId}/members`, headers: AUTH,
      payload: { userId: userA, role: "contributor" },
    });
    expect(member.statusCode).toBe(201);
    const prompt = `aer010 project ${RUN}`;
    try {
      const text = await primeCompat(prompt, projectId);
      const useCase = await app.inject({
        method: "POST", url: "/v1/use-cases", headers: authA,
        payload: {
          name: `aer010-use-case-${RUN}`, description: "cache governance verification",
          businessContext: "verify approval changes on cache hits", dataSensitivity: "internal", projectId,
        },
      });
      expect(useCase.statusCode).toBe(201);
      await putOrg({ useCaseGateMode: "enforce" });
      await expectCompatCacheDenied(prompt, "use_case_approval_required", text, projectId);
      await putOrg({ useCaseGateMode: "off" });
      await db.insert(usageEvents).values({ userId: userA, objectType: "agent", projectId, costUsd: 0.02 });
      await expectCompatCacheDenied(prompt, "project_budget_exceeded", text, projectId);
    } finally {
      await putOrg({ useCaseGateMode: prior });
    }
  });

  it("rechecks MRM and mandatory attribution before a primed compat hit", async () => {
    const mrmPrompt = `aer010 mrm ${RUN}`;
    const mrmText = await primeCompat(mrmPrompt);
    const priorMrm = (await app.inject({ method: "GET", url: "/v1/mrm/status", headers: AUTH })).json().enforced as boolean;
    try {
      await setMrm(true);
      await expectCompatCacheDenied(mrmPrompt, "mrm_approval_required", mrmText);
    } finally {
      await setMrm(priorMrm);
    }

    const attributionPrompt = `aer010 attribution ${RUN}`;
    const attributionText = await primeCompat(attributionPrompt);
    const prior = (await app.inject({ method: "GET", url: "/v1/org/settings", headers: AUTH })).json().settings.dispatchAttributionRequired as boolean;
    try {
      await putOrg({ dispatchAttributionRequired: true });
      await expectCompatCacheDenied(attributionPrompt, "attribution_required", attributionText);
    } finally {
      await putOrg({ dispatchAttributionRequired: prior });
    }
  });

  it("rechecks input PII and the current input guardrail before a primed compat hit", async () => {
    const prior = (await app.inject({ method: "GET", url: "/v1/org/settings", headers: AUTH })).json().settings.defaultPiiMode as string;
    const piiPrompt = `aer010-${RUN}@example.com`;
    try {
      await putOrg({ defaultPiiMode: "none" });
      const piiText = await primeCompat(piiPrompt);
      await putOrg({ defaultPiiMode: "block" });
      await expectCompatCacheDenied(piiPrompt, "pii_blocked", piiText);
    } finally {
      await putOrg({ defaultPiiMode: prior });
    }

    const beforeConfig = (await db.select().from(guardrailConfigs).where(eq(guardrailConfigs.scope, "org")))[0] ?? null;
    const guardrailPrompt = `COMPANY CONFIDENTIAL aer010 ${RUN}`;
    try {
      await setDlp("log");
      const text = await primeCompat(guardrailPrompt);
      await setDlp("block");
      await expectCompatCacheDenied(guardrailPrompt, "guardrail_blocked", text);
    } finally {
      if (beforeConfig) {
        await db.update(guardrailConfigs).set({
          promptInjectionMode: beforeConfig.promptInjectionMode,
          jailbreakMode: beforeConfig.jailbreakMode,
          toxicityMode: beforeConfig.toxicityMode,
          semanticDlpMode: beforeConfig.semanticDlpMode,
          customTerms: beforeConfig.customTerms,
        }).where(eq(guardrailConfigs.id, beforeConfig.id));
      } else {
        await db.delete(guardrailConfigs).where(eq(guardrailConfigs.scope, "org"));
      }
    }
  });

  it("rechecks a cached completion against newly blocked output guardrails", async () => {
    const beforeConfig = (await db.select().from(guardrailConfigs).where(eq(guardrailConfigs.scope, "org")))[0] ?? null;
    try {
      await setDlp("log");
      const rowsBefore = new Set((await db.select({ hash: semanticCache.promptHash }).from(semanticCache).where(eq(semanticCache.userId, userA))).map((r) => r.hash));
      const freshPrompt = `aer010 output fresh ${RUN}`;
      await primeCompat(freshPrompt);
      const row = (await db.select().from(semanticCache).where(eq(semanticCache.userId, userA))).find((r) => !rowsBefore.has(r.promptHash));
      expect(row).toBeDefined();
      await db.update(semanticCache).set({ outputText: "COMPANY CONFIDENTIAL synthetic cached answer" }).where(eq(semanticCache.id, row!.id));
      await setDlp("block");
      await expectCompatCacheDenied(freshPrompt, "guardrail_blocked", "COMPANY CONFIDENTIAL synthetic cached answer");
    } finally {
      if (beforeConfig) {
        await db.update(guardrailConfigs).set({
          promptInjectionMode: beforeConfig.promptInjectionMode,
          jailbreakMode: beforeConfig.jailbreakMode,
          toxicityMode: beforeConfig.toxicityMode,
          semanticDlpMode: beforeConfig.semanticDlpMode,
          customTerms: beforeConfig.customTerms,
        }).where(eq(guardrailConfigs.id, beforeConfig.id));
      } else {
        await db.delete(guardrailConfigs).where(eq(guardrailConfigs.scope, "org"));
      }
    }
  });

  it("withholds a cached completion when output PII becomes blocked", async () => {
    const prior = (await app.inject({ method: "GET", url: "/v1/org/settings", headers: AUTH })).json().settings.defaultPiiMode as string;
    try {
      await putOrg({ defaultPiiMode: "none" });
      const rowsBefore = new Set((await db.select({ hash: semanticCache.promptHash }).from(semanticCache).where(eq(semanticCache.userId, userA))).map((r) => r.hash));
      const prompt = `aer010 output pii ${RUN}`;
      await primeCompat(prompt);
      const row = (await db.select().from(semanticCache).where(eq(semanticCache.userId, userA))).find((r) => !rowsBefore.has(r.promptHash));
      expect(row).toBeDefined();
      const cachedText = `sensitive-${RUN}@example.com`;
      await db.update(semanticCache).set({ outputText: cachedText }).where(eq(semanticCache.id, row!.id));
      await putOrg({ defaultPiiMode: "block" });
      await expectCompatCacheDenied(prompt, "pii_blocked", cachedText);
    } finally {
      await putOrg({ defaultPiiMode: prior });
    }
  });

  it("stores no plaintext request and rejects a matching index hash with different request identity", async () => {
    const key = semanticCacheRequestKey({ messages: [{ role: "user", content: "private value" }] });
    expect(key.norm).not.toContain("private value");
    await storeSemanticCache(db, {
      userId: userA,
      agentId,
      key,
      outputText: "synthetic cached answer",
      model: "mock",
      inputTokens: 1,
      outputTokens: 1,
    });
    const forged = await lookupSemanticCache(db, {
      userId: userA,
      agentId,
      key: { hash: key.hash, norm: `${key.norm}changed` },
      ttlSeconds: 3600,
    });
    expect(forged).toBeNull();
  });

  it("one user's cached answer is NEVER served to another", async () => {
    await setPolicy("always");
    const prompt = `cross user secret ${RUN}`;

    await ask(authA, prompt);
    // prove A is now cached, so B's miss below is about SCOPE and not about an
    // empty cache
    const aUsage = await usageCount(userA);
    await ask(authA, prompt);
    expect(await usageCount(userA)).toBe(aUsage);

    const beforeB = await usageCount(userB);
    const res = await ask(authB, prompt);
    expect(res.statusCode).toBe(200);
    // B paid for a real provider call — it did not read A's row
    expect(await usageCount(userB)).toBe(beforeB + 1);
  });
});

/**
 * AER-010 — THE RETAINED NEGATIVE CONTROL FOR THE MATRIX ABOVE.
 *
 * The prime-then-tighten matrix proves that a cached answer is re-judged by
 * the live gates. What it cannot prove on its own is that it would NOTICE if
 * the serve crept back above those gates: every one of its cases is a
 * refusal-shaped assertion, and a refactor that returned the hit early would
 * turn six passing tests into six failing ones only if someone ran them. These
 * two tests pin the SHAPE that makes the matrix meaningful, straight from the
 * source, so the ordering is a property of the suite rather than of a commit
 * message:
 *
 *  1. inside `dispatchAttempt` (the one governed-dispatch core, ADR-0066 §4),
 *     the `if (args.cachedResponse)` serve is a top-level statement that sits
 *     BELOW every gate the matrix tightens — virtual-key budget, MRM,
 *     attribution, use-case approval, project budget, input PII and the input
 *     guardrail phase;
 *  2. at BOTH lookup sites (compat and native invoke) the row that
 *     `lookupSemanticCache` returns is handed to `executeGovernedDispatch` as
 *     `cachedResponse` before any byte of it is read, and only the core's
 *     adjudicated `governed.result.outputText` reaches the wire.
 *
 * Mutation control (run, not retained): an early
 * `if (args.cachedResponse) return {...}` planted above the virtual-key gate
 * turns test 1 red, and replacing the compat site's governed call with a
 * direct serve turns test 2 red — each together with all six matrix cases.
 */
describe("AER-010 — the cached serve cannot move above the shared dispatch gates", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const parse = (file: string) =>
    ts.createSourceFile(file, readFileSync(path.join(here, file), "utf8"), ts.ScriptTarget.Latest, true);
  /** every identifier called anywhere inside `node` */
  const callsIn = (node: ts.Node): Set<string> => {
    const names = new Set<string>();
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) names.add(n.expression.text);
      ts.forEachChild(n, visit);
    };
    visit(node);
    return names;
  };
  /** every `if (<text>)` statement anywhere in the tree, in source order */
  const ifsTesting = (root: ts.Node, text: string): ts.IfStatement[] => {
    const found: ts.IfStatement[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isIfStatement(n) && n.expression.getText() === text) found.push(n);
      ts.forEachChild(n, visit);
    };
    visit(root);
    return found;
  };

  it("in the dispatch core, the cached serve is a top-level statement below every gate the matrix tightens", () => {
    // gate function -> the refusal the matrix asserts for it
    const GATES: Record<string, string> = {
      virtualKeyBudgetRefusal: "virtual_key_budget_exhausted",
      mrmDispatchGate: "mrm_approval_required",
      attributionDispatchGate: "attribution_required",
      useCaseDispatchGate: "use_case_approval_required",
      preDispatchProjectGate: "project_budget_exceeded",
      enforcePII: "pii_blocked (input phase)",
      runGuardrails: "guardrail_blocked (input phase)",
    };
    const source = parse("agents-connectors.ts");
    const core = source.statements.find(
      (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === "dispatchAttempt",
    );
    expect(core?.body, "agents-connectors.ts must declare the dispatchAttempt core").toBeDefined();
    const statements = core!.body!.statements;
    // the FIRST top-level serve: an early one planted above the gates is the
    // one this must see
    const serveIdx = statements.findIndex(
      (s) => ts.isIfStatement(s) && s.expression.getText() === "args.cachedResponse",
    );
    expect(serveIdx, "dispatchAttempt must serve args.cachedResponse in a top-level if").toBeGreaterThanOrEqual(0);
    for (const [gate, refusal] of Object.entries(GATES)) {
      // `enforcePII` and `runGuardrails` are called AGAIN inside the serve (the
      // output phase on the cached text), so "first statement that calls it"
      // is the serve itself whenever the serve has moved above the input gate.
      const gateIdx = statements.findIndex((s) => callsIn(s).has(gate));
      expect(gateIdx, `${gate} (${refusal}) must be reachable from a top-level statement of dispatchAttempt`)
        .toBeGreaterThanOrEqual(0);
      expect(gateIdx, `${gate} (${refusal}) must run before the cached serve`).toBeLessThan(serveIdx);
    }
  });

  it("both lookup sites hand the hit to executeGovernedDispatch before a byte of it is read", () => {
    for (const file of ["compat-core.ts", "agents-connectors.ts"]) {
      const serves = ifsTesting(parse(file), "hit");
      expect(serves.length, `${file}: the lookupSemanticCache site must branch on \`if (hit)\``).toBe(1);
      const branch = serves[0]!.thenStatement;
      expect(ts.isBlock(branch), `${file}: the hit branch must be a block`).toBe(true);
      const [first, second] = (branch as ts.Block).statements;
      // 1st statement: `const governed = await executeGovernedDispatch(db, …, { …, cachedResponse: hit })`
      expect(first && ts.isVariableStatement(first), `${file}: the hit branch must open by calling the core`).toBe(true);
      const decl = (first as ts.VariableStatement).declarationList.declarations[0]!;
      expect(decl.name.getText(), `${file}: the core's verdict must be what the branch holds`).toBe("governed");
      const init = decl.initializer;
      expect(init && ts.isAwaitExpression(init) && ts.isCallExpression(init.expression), `${file}: must await the core`).toBe(true);
      const call = (init as ts.AwaitExpression).expression as ts.CallExpression;
      expect(call.expression.getText(), `${file}: the hit must go through executeGovernedDispatch`).toBe("executeGovernedDispatch");
      const argsLiteral = call.arguments[call.arguments.length - 1];
      expect(argsLiteral && ts.isObjectLiteralExpression(argsLiteral), `${file}: the core takes an args literal`).toBe(true);
      const cached = (argsLiteral as ts.ObjectLiteralExpression).properties.find(
        (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === "cachedResponse",
      );
      expect(cached?.initializer.getText(), `${file}: the hit must ride in as cachedResponse`).toBe("hit");
      // 2nd statement: the verdict is honoured before anything else happens
      expect(second && ts.isIfStatement(second) && second.expression.getText() === "!governed.ok",
        `${file}: the statement after the core call must be \`if (!governed.ok)\``).toBe(true);
      // and the cached TEXT is never read at the site — only the core's
      // adjudicated copy is
      const reads: string[] = [];
      const visit = (n: ts.Node) => {
        if (ts.isPropertyAccessExpression(n) && n.expression.getText() === "hit" && n.name.text === "outputText") {
          reads.push(n.getText());
        }
        ts.forEachChild(n, visit);
      };
      visit(branch);
      expect(reads, `${file}: the hit branch must not read hit.outputText`).toEqual([]);
    }
  });
});

describe("what this surface deliberately does NOT do", () => {
  it("`opt_in` cannot engage here — the vendor wire format has no opt-in field", async () => {
    await setPolicy("opt_in");
    const prompt = `opt in question ${RUN}`;

    await ask(authA, prompt);
    const afterFirst = await usageCount(userA);
    await ask(authA, prompt);
    // still billed: under opt_in this surface behaves exactly as it did before
    expect(await usageCount(userA)).toBe(afterFirst + 1);

    // positive control on the SAME prompt: under `always` it does hit, so the
    // assertion above is about the policy and not about an unrelated failure
    await setPolicy("always");
    await ask(authA, prompt);
    const primed = await usageCount(userA);
    await ask(authA, prompt);
    expect(await usageCount(userA)).toBe(primed);
  });

  it("a tool-bearing turn is never cached", async () => {
    await setPolicy("always");
    const prompt = `tool question ${RUN}`;
    const tools = [
      {
        name: "lookup",
        description: "look something up",
        input_schema: { type: "object", properties: {} },
      },
    ];

    const first = await ask(authA, prompt, { tools });
    expect(first.statusCode).toBe(200);
    const afterFirst = await usageCount(userA);

    const second = await ask(authA, prompt, { tools });
    expect(second.statusCode).toBe(200);
    // billed again: the answer to a tool-bearing turn is not a pure function
    // of the prompt, so serving a previous one would be wrong, not just stale
    expect(await usageCount(userA)).toBe(afterFirst + 1);
  });

  it("`off` disables it entirely", async () => {
    await setPolicy("off");
    const prompt = `disabled question ${RUN}`;
    await ask(authA, prompt);
    const afterFirst = await usageCount(userA);
    await ask(authA, prompt);
    expect(await usageCount(userA)).toBe(afterFirst + 1);
  });
});

/**
 * AER-011 / ADR-0136 — THE KEY IS THE REQUEST'S IDENTITY, FIELD BY FIELD.
 *
 * The cases under "the technique the IDE path was missing" prove that system,
 * role, message boundary and max_tokens miss. These cover the remaining
 * identity fields the compat commitment names — the response contract,
 * extended thinking, the attributed project and the prompt/config version set
 * — and each is measured THREE ways so it cannot pass vacuously (M-033): the
 * base request is primed (one usage row, then a hit with none); the variant,
 * differing in exactly that one field, must MISS against the base row (one
 * more usage row, no saving); then the variant is asked again and must HIT its
 * own row — proving the variant is cacheable, so its miss was about identity
 * and not about a field that is never cached.
 *
 * Omission control (run, not retained): dropping any one of `responseFormat`,
 * `thinking`, `projectId`, `promptVersions` or `agentConfigVersions` from the
 * commitment in `compat-core.ts` turns exactly that field's case red — the
 * variant comes back as a false hit.
 *
 * This block activates versions on the file's agent, which is why it runs
 * LAST: every later ask in the file would be served under the new version set.
 */
describe("AER-011 — identical requests that differ in one identity field miss", () => {
  type Call = () => Promise<{ statusCode: number }>;

  /** one OpenAI-shaped call, naming the agent exactly as `ask` does */
  const askOpenAi = (text: string, extra: Record<string, unknown> = {}) =>
    app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { ...authA, [AGENT_HEADER]: agentId },
      payload: {
        model: `adr0119-model-${RUN}`,
        max_tokens: 64,
        messages: [{ role: "user", content: text }],
        ...extra,
      },
    });

  /** MISS then HIT on `call`: afterwards its row exists, and the counters say so */
  async function prime(call: Call) {
    const usage = await usageCount(userA);
    const savings = await cacheSavingsCount(userA);
    expect((await call()).statusCode).toBe(200);
    expect(await usageCount(userA)).toBe(usage + 1);
    expect((await call()).statusCode).toBe(200);
    expect(await usageCount(userA)).toBe(usage + 1);
    expect(await cacheSavingsCount(userA)).toBe(savings + 1);
  }

  /** `variant` pays once (a MISS against whatever is cached), then hits its own row */
  async function expectMissThenOwnHit(variant: Call) {
    const usage = await usageCount(userA);
    const savings = await cacheSavingsCount(userA);
    expect((await variant()).statusCode).toBe(200);
    // MISS: the provider really was called, and nothing was claimed as saved
    expect(await usageCount(userA)).toBe(usage + 1);
    expect(await cacheSavingsCount(userA)).toBe(savings);
    expect((await variant()).statusCode).toBe(200);
    // HIT on its own row: the variant is cacheable, so the miss above was identity
    expect(await usageCount(userA)).toBe(usage + 1);
    expect(await cacheSavingsCount(userA)).toBe(savings + 1);
  }

  async function pairedMiss(base: Call, variant: Call) {
    await setPolicy("always");
    await prime(base);
    await expectMissThenOwnHit(variant);
  }

  it("response_format (OpenAI surface): a structured-output contract is a different request", async () => {
    const prompt = `aer011 response format ${RUN}`;
    await pairedMiss(
      () => askOpenAi(prompt),
      () => askOpenAi(prompt, { response_format: { type: "json_object" } }),
    );
  });

  it("thinking: an extended-thinking budget is a different request", async () => {
    const prompt = `aer011 thinking ${RUN}`;
    await pairedMiss(
      () => ask(authA, prompt),
      () => ask(authA, prompt, { thinking: { type: "enabled", budget_tokens: 32 } }),
    );
  });

  it("project: the same words attributed to another project are a different request", async () => {
    const mkProject = async (tag: string) => {
      const p = await app.inject({
        method: "POST", url: "/v1/projects", headers: AUTH,
        payload: { name: `aer011-${tag}-${RUN}` },
      });
      expect(p.statusCode).toBe(201);
      const id = p.json().id as string;
      const m = await app.inject({
        method: "POST", url: `/v1/projects/${id}/members`, headers: AUTH,
        payload: { userId: userA, role: "contributor" },
      });
      expect(m.statusCode).toBe(201);
      return id;
    };
    const p1 = await mkProject("p1");
    const p2 = await mkProject("p2");
    const prompt = `aer011 project ${RUN}`;
    await pairedMiss(() => ask(authA, prompt, {}, p1), () => ask(authA, prompt, {}, p2));
  });

  it("prompt version: a newly activated system-prompt version invalidates earlier rows, even with the same text", async () => {
    const activatePrompt = async (systemPrompt: string, label: string) => {
      const res = await app.inject({
        method: "POST", url: `/v1/config-versions/agent_system_prompt/${agentId}`, headers: AUTH,
        payload: { body: { systemPrompt }, label, activate: true },
      });
      expect(res.statusCode).toBe(201);
    };
    const prompt = `aer011 prompt version ${RUN}`;
    const call = () => ask(authA, prompt);
    await setPolicy("always");
    await prime(call);
    // the prompt text changed AND the version set changed
    await activatePrompt("Answer tersely.", "aer011 v2");
    await expectMissThenOwnHit(call);
    // ONLY the version set changed — still a different request (ADR-0136:
    // any promotion conservatively invalidates old entries)
    await activatePrompt("Answer tersely.", "aer011 v3 — same text, new version");
    await expectMissThenOwnHit(call);
  });

  it("config version: an activated agent_config version with the same model and prices is still a different request", async () => {
    const prompt = `aer011 config version ${RUN}`;
    const call = () => ask(authA, prompt);
    await setPolicy("always");
    await prime(call);
    const res = await app.inject({
      method: "POST", url: `/v1/config-versions/agent_config/${agentId}`, headers: AUTH,
      payload: {
        body: { model: `adr0119-model-${RUN}`, costPerMTokIn: 3, costPerMTokOut: 15 },
        label: "aer011 acfg v2",
        activate: true,
      },
    });
    expect(res.statusCode).toBe(201);
    await expectMissThenOwnHit(call);
  });
});
