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

const here = path.dirname(fileURLToPath(import.meta.url));
/** a gateway source as a TypeScript AST — the structural tests below read the code itself */
const parse = (file: string) =>
  ts.createSourceFile(file, readFileSync(path.join(here, file), "utf8"), ts.ScriptTarget.Latest, true);

/**
 * AER-010 — THE RETAINED NEGATIVE CONTROL FOR THE MATRIX ABOVE.
 *
 * The prime-then-tighten matrix proves that a cached answer is re-judged by
 * the live gates. What it cannot prove on its own is that it would NOTICE if
 * the serve crept back above those gates: every one of its cases is a
 * refusal-shaped assertion, it drives the compat surface only, and a refactor
 * that returned the hit early would turn its cases red only if someone ran
 * them. These tests pin the ORDERING that makes the matrix meaningful,
 * straight from the source — and they pin it by REFERENCE, not by spelling.
 *
 * "Reads the candidate" means any way the dispatch args can hand
 * `cachedResponse` to code: the field under any spelling
 * (`args.cachedResponse`, `args?.cachedResponse`, `args["cachedResponse"]`,
 * `{ cachedResponse } = args`, and therefore any alias made from those), or
 * `args` escaping whole — spread, aliased, rest-destructured, read through
 * `arguments`, or passed to a function — unless it is passed to a function
 * declared in the same file that, by this same rule, never reads it.
 *
 *  1. inside `dispatchAttempt` (the one governed-dispatch core, ADR-0066 §4)
 *     the first top-level statement that reads the candidate comes AFTER every
 *     gate the matrix tightens — after each gate's input-phase call AND after
 *     every `if (…verdict…) return { ok: false … }` refusal on that gate's
 *     verdict. The gates: virtual-key budget, MRM, attribution, use-case
 *     approval, project budget, input PII and the input guardrail phase;
 *  2. the two wrappers above the core (`executeGovernedDispatch`,
 *     `dispatchOnce`) read nothing of the candidate before they call down a
 *     layer;
 *  3. at BOTH lookup sites (compat and native invoke), between the
 *     `lookupSemanticCache` result and the `executeGovernedDispatch` call that
 *     carries it, the hit is referenced only by its `if (hit)` test and by the
 *     `cachedResponse: hit` argument; the very next statement refuses on the
 *     verdict; and nothing after it reads the hit's text — only the core's
 *     adjudicated copy reaches the wire.
 *
 * Mutation control (run, not retained; commands and counts are in the commit
 * message): an aliased serve, a compound-guard serve and a helper serve
 * planted above the virtual-key gate; MRM's refusal moved below the serve with
 * its call left above it; an early serve in `dispatchOnce`; and a
 * `hit?.outputText` serve above `if (hit)` at each lookup site. Every one
 * turns this block red. Every one passed the spelling-based tests this block
 * replaced. What this block does NOT judge is a serve-on-deny AFTER the core
 * has ruled — that is not an ordering question, it is the matrix's: planted in
 * `dispatchOnce` after its `dispatchAttempt` call, it leaves this block green
 * and turns the six matrix cases red.
 */
describe("AER-010 — the cached serve cannot move above the shared dispatch gates", () => {
  const CACHE_FIELD = "cachedResponse";

  /** visit every node under `root` that runs — a type annotation is not a read */
  const walk = (root: ts.Node, visit: (n: ts.Node) => void) => {
    const go = (n: ts.Node) => {
      if (ts.isTypeNode(n)) return;
      visit(n);
      ts.forEachChild(n, go);
    };
    go(root);
  };
  const where = (n: ts.Node) => {
    const sf = n.getSourceFile();
    const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
    return `${path.basename(sf.fileName)}:${line} \`${n.getText().replace(/\s+/g, " ").slice(0, 80)}\``;
  };
  const topLevelFn = (sf: ts.SourceFile, name: string) =>
    sf.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name);
  const fn = (sf: ts.SourceFile, name: string): ts.FunctionDeclaration & { body: ts.Block } => {
    const f = topLevelFn(sf, name);
    expect(f?.body, `${path.basename(sf.fileName)} must declare ${name}`).toBeDefined();
    return f as ts.FunctionDeclaration & { body: ts.Block };
  };
  /** whatever the function calls its GovernedDispatchArgs parameter */
  const argsParam = (f: ts.FunctionDeclaration) => {
    const p = f.parameters.find((q) => q.type?.getText() === "GovernedDispatchArgs");
    expect(p !== undefined && ts.isIdentifier(p.name), `${f.name?.text} must take a GovernedDispatchArgs parameter`)
      .toBe(true);
    return (p!.name as ts.Identifier).text;
  };
  const callsTo = (root: ts.Node, name: string): ts.CallExpression[] => {
    const out: ts.CallExpression[] = [];
    walk(root, (n) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) out.push(n);
    });
    return out;
  };
  const contains = (outer: ts.Node, inner: ts.Node) => outer.getStart() <= inner.getStart() && inner.end <= outer.end;
  const mentions = (root: ts.Node, name: string) => {
    let found = false;
    walk(root, (n) => {
      if (ts.isIdentifier(n) && n.text === name) found = true;
    });
    return found;
  };
  /** `return …` statements under `root`, not counting nested functions */
  const returnsUnder = (root: ts.Node): ts.ReturnStatement[] => {
    const out: ts.ReturnStatement[] = [];
    const go = (n: ts.Node) => {
      if (n !== root && ts.isFunctionLike(n)) return;
      if (ts.isReturnStatement(n)) out.push(n);
      ts.forEachChild(n, go);
    };
    go(root);
    return out;
  };
  const isRefusalReturn = (r: ts.ReturnStatement) =>
    !!r.expression &&
    ts.isObjectLiteralExpression(r.expression) &&
    r.expression.properties.some(
      (p) => ts.isPropertyAssignment(p) && p.name.getText() === "ok" && p.initializer.kind === ts.SyntaxKind.FalseKeyword,
    );

  /** every node under `root` through which `param` hands the candidate to code (see the block comment) */
  const cacheReads = (
    sf: ts.SourceFile,
    root: ts.Node,
    param: string,
    memo = new Map<string, boolean>(),
  ): ts.Node[] => {
    const reads: ts.Node[] = [];
    walk(root, (n) => {
      if ((ts.isIdentifier(n) || ts.isStringLiteralLike(n)) && n.text === CACHE_FIELD) return void reads.push(n);
      if (ts.isIdentifier(n) && n.text === "arguments") return void reads.push(n);
      if (!ts.isIdentifier(n) || n.text !== param) return;
      const parent = n.parent;
      // the parameter's own declaration is not a use of it
      if (ts.isParameter(parent) && parent.name === n) return;
      // `args.x` / `args["x"]`: the field's name is judged on its own above
      if (ts.isPropertyAccessExpression(parent) && parent.expression === n) return;
      if (ts.isElementAccessExpression(parent) && parent.expression === n && ts.isStringLiteralLike(parent.argumentExpression)) return;
      // `const { a, b } = args` names each field it takes; a rest element takes them all
      if (
        ts.isVariableDeclaration(parent) && parent.initializer === n && ts.isObjectBindingPattern(parent.name) &&
        parent.name.elements.every((e) => !e.dotDotDotToken && !(e.propertyName && ts.isComputedPropertyName(e.propertyName)))
      ) return;
      // passed whole to a function declared in this file: follow it, by the same rule
      if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.arguments.some((a) => a === n)) {
        const callee = topLevelFn(sf, parent.expression.text);
        const p = callee?.parameters[parent.arguments.findIndex((a) => a === n)];
        if (callee?.body && p && ts.isIdentifier(p.name)) {
          const key = `${parent.expression.text}#${p.name.text}`;
          if (!memo.has(key)) {
            memo.set(key, false); // a cycle adds nothing new
            memo.set(key, cacheReads(sf, callee.body, p.name.text, memo).length > 0);
          }
          if (!memo.get(key)) return;
        }
      }
      reads.push(n);
    });
    return reads;
  };

  it("in the dispatch core, nothing reads the candidate until every gate the matrix tightens has been called and has had its chance to refuse", () => {
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
    const sf = parse("agents-connectors.ts");
    const core = fn(sf, "dispatchAttempt");
    const top = core.body.statements;
    const topIndex = (n: ts.Node) => top.findIndex((s) => contains(s, n));
    const reads = cacheReads(sf, core.body, argsParam(core));
    // not vacuous: a core that never read the candidate would have a dead cache
    expect(reads.length, "dispatchAttempt must read the cached candidate somewhere").toBeGreaterThan(0);
    const firstRead = Math.min(...reads.map(topIndex));
    const firstReadAt = where(top[firstRead]!);
    // `enforcePII` / `runGuardrails` run AGAIN on the cached text (and on a live
    // answer) in their OUTPUT phase; only the input phase is a gate on the ask
    const isOutputPhase = (c: ts.CallExpression) =>
      c.arguments.some(
        (a) =>
          (ts.isStringLiteralLike(a) && a.text === "output") ||
          (ts.isObjectLiteralExpression(a) && a.properties.some((p) => p.name?.getText() === "output")),
      );
    for (const [gate, refusal] of Object.entries(GATES)) {
      const calls = callsTo(core.body, gate).filter((c) => !isOutputPhase(c));
      expect(calls.length, `${gate} (${refusal}) must be called in dispatchAttempt`).toBeGreaterThan(0);
      for (const call of calls) {
        expect(topIndex(call), `${gate} at ${where(call)} must run before the candidate is first read, at ${firstReadAt}`)
          .toBeLessThan(firstRead);
        // the name the gate's verdict is bound to: `const v = …gate(…)` or `v = gate(…)`
        let verdict: string | undefined;
        let stmt: ts.Node = call;
        for (let n: ts.Node = call.parent; !ts.isBlock(n); n = n.parent) {
          if (!verdict && ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) verdict = n.name.text;
          if (!verdict && ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)) {
            verdict = n.left.text;
          }
          stmt = n;
        }
        expect(verdict, `${where(call)}: ${gate}'s verdict must be bound to a name`).toBeDefined();
        // every `if (…verdict…) { … return { ok: false … } }` after it, in the block it was bound in
        const refusals: ts.IfStatement[] = [];
        walk(stmt.parent, (n) => {
          if (
            ts.isIfStatement(n) && n.getStart() >= stmt.end && mentions(n.expression, verdict!) &&
            returnsUnder(n.thenStatement).some(isRefusalReturn)
          ) refusals.push(n);
        });
        expect(refusals.length, `${gate} (${refusal}): an \`if (…${verdict}…) return { ok: false, … }\` must follow ${where(call)}`)
          .toBeGreaterThan(0);
        for (const r of refusals) {
          expect(topIndex(r), `${gate}'s refusal at ${where(r)} must come before the candidate is first read, at ${firstReadAt}`)
            .toBeLessThan(firstRead);
        }
      }
    }
  });

  it("the two wrappers above the core read nothing of the candidate before they call down a layer", () => {
    const sf = parse("agents-connectors.ts");
    for (const [outer, inner] of [["executeGovernedDispatch", "dispatchOnce"], ["dispatchOnce", "dispatchAttempt"]] as const) {
      const f = fn(sf, outer);
      const calls = callsTo(f.body, inner);
      expect(calls.length, `${outer} must call ${inner}`).toBeGreaterThan(0);
      const boundary = Math.min(...calls.map((c) => c.getStart()));
      // a function declared inside the wrapper is hoisted: it can run before the
      // boundary wherever it is written
      const hoisted = (n: ts.Node) => {
        for (let p = n.parent; p !== f; p = p.parent) if (ts.isFunctionDeclaration(p)) return true;
        return false;
      };
      const early = cacheReads(sf, f.body, argsParam(f)).filter((n) => n.getStart() < boundary || hoisted(n));
      expect(early.map(where), `${outer} must not read the candidate before it calls ${inner}`).toEqual([]);
    }
  });

  it("at both lookup sites the hit reaches the core untouched, and only the core's verdict reaches the wire", () => {
    for (const file of ["compat-core.ts", "agents-connectors.ts"]) {
      const sf = parse(file);
      const lookups = callsTo(sf, "lookupSemanticCache");
      expect(lookups.length, `${file} must look the cache up`).toBeGreaterThan(0);
      for (const lookup of lookups) {
        // `const hit = await lookupSemanticCache(…)`, whatever it is named
        let d: ts.Node = lookup.parent;
        while (ts.isAwaitExpression(d) || ts.isParenthesizedExpression(d)) d = d.parent;
        expect(ts.isVariableDeclaration(d) && ts.isIdentifier(d.name), `${where(lookup)}: the hit must be bound to a name`)
          .toBe(true);
        const hitDecl = d as ts.VariableDeclaration;
        const hit = (hitDecl.name as ts.Identifier).text;
        // the function that owns the lookup (the compat call / the invoke route handler)
        let owner: ts.Node = hitDecl;
        while (!(ts.isFunctionDeclaration(owner) || ts.isFunctionExpression(owner) || ts.isArrowFunction(owner) ||
          ts.isMethodDeclaration(owner))) owner = owner.parent;
        // the block the hit is scoped to — a `hit` outside it is another variable
        let scope: ts.Node = hitDecl;
        while (!ts.isBlock(scope)) scope = scope.parent;
        const refs: ts.Identifier[] = [];
        walk(scope, (n) => {
          if (!ts.isIdentifier(n) || n.text !== hit || n === hitDecl.name) return;
          const p = n.parent;
          // a property NAME that happens to be spelled `hit` is not the variable
          if ((ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n)) return;
          refs.push(n);
        });

        // exactly one `if (hit)` in the owning function (not the whole file)
        const tests: ts.IfStatement[] = [];
        walk(owner, (n) => {
          if (ts.isIfStatement(n) && ts.isIdentifier(n.expression) && n.expression.text === hit) tests.push(n);
        });
        expect(tests.length, `${where(hitDecl)}: its function must branch on \`if (${hit})\` exactly once`).toBe(1);
        const branch = tests[0]!;

        // the one core call that carries the hit, inside that branch
        const handedOver = new Map<ts.CallExpression, ts.Node>();
        for (const c of callsTo(owner, "executeGovernedDispatch")) {
          for (const a of c.arguments) {
            if (!ts.isObjectLiteralExpression(a)) continue;
            for (const p of a.properties) {
              if (ts.isPropertyAssignment(p) && p.name.getText() === CACHE_FIELD && ts.isIdentifier(p.initializer) &&
                p.initializer.text === hit) handedOver.set(c, p.initializer);
              if (ts.isShorthandPropertyAssignment(p) && p.name.text === CACHE_FIELD && hit === CACHE_FIELD) handedOver.set(c, p.name);
            }
          }
        }
        expect(handedOver.size, `${where(hitDecl)}: exactly one executeGovernedDispatch call must carry \`${CACHE_FIELD}: ${hit}\``)
          .toBe(1);
        const [core, handed] = [...handedOver][0]!;
        expect(contains(branch.thenStatement, core), `${where(core)} must sit inside \`if (${hit})\``).toBe(true);

        // BEFORE the core has ruled: the test and the hand-over, nothing else
        const early = refs.filter((r) => r.getStart() < core.end && r !== branch.expression && r !== handed);
        expect(
          early.map((r) => where(r.parent)),
          `${file}: between the lookup and the core call, \`${hit}\` may only be tested by \`if (${hit})\` and handed over as \`${CACHE_FIELD}: ${hit}\``,
        ).toEqual([]);

        // the very next statement refuses on the core's verdict
        let v: ts.Node = core.parent;
        while (ts.isAwaitExpression(v) || ts.isParenthesizedExpression(v)) v = v.parent;
        expect(ts.isVariableDeclaration(v) && ts.isIdentifier(v.name), `${where(core)}: the core's verdict must be bound to a name`)
          .toBe(true);
        const verdict = ((v as ts.VariableDeclaration).name as ts.Identifier).text;
        const verdictStmt = v.parent.parent as ts.Statement;
        const siblings = (verdictStmt.parent as ts.Block).statements;
        const next = siblings[siblings.indexOf(verdictStmt) + 1];
        const notOk = (e: ts.Expression): boolean => {
          const isOk = (x: ts.Expression) =>
            ts.isPropertyAccessExpression(x) && x.name.text === "ok" && ts.isIdentifier(x.expression) && x.expression.text === verdict;
          if (ts.isParenthesizedExpression(e)) return notOk(e.expression);
          if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) return isOk(e.operand);
          return ts.isBinaryExpression(e) && isOk(e.left) && e.right.kind === ts.SyntaxKind.FalseKeyword &&
            (e.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken || e.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken);
        };
        expect(
          next !== undefined && ts.isIfStatement(next) && notOk(next.expression) && returnsUnder(next.thenStatement).length > 0,
          `${where(core)}: the statement after the core call must return when \`${verdict}\` is not ok`,
        ).toBe(true);

        // AFTER the verdict the row's metadata may price the saving, and a plain
        // helper may take the row whole to do it; its TEXT must not be read
        for (const r of refs.filter((x) => x.getStart() >= core.end)) {
          const p = r.parent;
          const allowed =
            (ts.isPropertyAccessExpression(p) && p.expression === r && p.name.text !== "outputText") ||
            (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && p.arguments.some((a) => a === r));
          expect(allowed, `${where(p)}: after the verdict only the core's adjudicated output may be served — not \`${hit}\`'s text`)
            .toBe(true);
        }
      }
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
