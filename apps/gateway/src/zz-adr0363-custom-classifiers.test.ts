import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  createDb,
  customClassifierEdmDigests,
  customClassifierHashKey,
  customClassifierVersions,
  customClassifiers,
  desc,
  eq,
  runMigrations,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStepUpAround } from "./testing/step-up-posture.js";

/**
 * ADR-0363 slice 2 end to end: customer classifiers inside the guardrail pipeline.
 *   - a draft does nothing; it publishes only when a named reviewer (never its author) approves it;
 *   - a published regex, keyword or EDM classifier blocks a governed dispatch through the guardrail engine;
 *   - EDM values are stored only as HMAC digests (never the plaintext, never in an audit row);
 *   - a newer published version supersedes the older one; retiring is a step-up and stops enforcement;
 *   - the lifecycle refuses transitions the declared table does not allow.
 * Shares one database (fileParallelism off); everything is keyed e44c_<run>.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `e44c-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const key = (s: string) => `e44c_${RUN}_${s}`;
const SECRET_ID = `EMP${RUN.toUpperCase()}771`;

let db: Db;
let app: ReturnType<typeof buildApp>;
type Person = { id: string; auth: { authorization: string } };
let author: Person;
let reviewer: Person;
let caller: Person;
let agentId: string;
const restores: Array<() => Promise<void>> = [];
const createdKeys: string[] = [];

async function makeUser(name: string, isAdmin: boolean): Promise<Person> {
  const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email: `${name}-${RUN}@example.com`, displayName: name, isAdmin } });
  expect(u.statusCode).toBe(201);
  const k = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "e44c" } });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

const decide = (who: Person, approvalId: string, decision: "approved" | "denied", reason?: string) =>
  relaxStepUpAround(db, () =>
    app.inject({ method: "POST", headers: who.auth, url: `/v1/approvals/${approvalId}/decide`, payload: { decision, ...(reason ? { reason } : {}) } }),
  );

async function create(k: string, version: Record<string, unknown>) {
  createdKeys.push(k);
  const r = await app.inject({ method: "POST", headers: author.auth, url: "/v1/classifiers", payload: { key: k, name: k, version } });
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as { id: string; versions: Array<{ version: number; status: string; valueCount?: number }> };
}

const submit = (id: string, version: number, reviewerUserId = reviewer.id) =>
  app.inject({ method: "POST", headers: author.auth, url: `/v1/classifiers/${id}/versions/${version}/submit`, payload: { reviewerUserId } });

async function publish(id: string, version: number) {
  const s = await submit(id, version);
  expect(s.statusCode, s.body).toBe(202);
  const d = await decide(reviewer, s.json().approvalId, "approved");
  expect(d.statusCode, d.body).toBe(200);
}

const invoke = (input: string) =>
  app.inject({ method: "POST", headers: caller.auth, url: `/v1/agents/${agentId}/invoke`, payload: { mode: "chat", dispatch: true, input } });

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "c".repeat(64) });
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  restores.push(await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false }));
  author = await makeUser("e44c-author", true);
  reviewer = await makeUser("e44c-reviewer", true);
  caller = await makeUser("e44c-caller", false);
  const agent = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: { name: `e44c-agent-${RUN}`, provider: "mock", tier: 1, costPerMTokIn: 3, costPerMTokOut: 15, model: "mock-balanced" },
  });
  agentId = agent.json().id;
  await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId: caller.id, agentId } });
});

afterAll(async () => {
  // retire whatever this suite published so later suites on the shared database are unaffected
  for (const k of createdKeys) await db.delete(customClassifiers).where(eq(customClassifiers.key, k));
  for (const r of restores.reverse()) await r();
  await app.close();
});

describe("ADR-0363 slice 2: customer classifiers", () => {
  it("a draft does nothing; the author cannot review it; approval publishes it and the dispatch is blocked", async () => {
    const c = await create(key("regex"), { mode: "block", definition: { kind: "regex", pattern: `PRJ-${RUN.toUpperCase()}-[0-9]{4}`, caseInsensitive: false } });
    expect(c.versions[0]!.status).toBe("draft");
    const text = `please summarise PRJ-${RUN.toUpperCase()}-1234`;
    expect((await invoke(text)).statusCode).toBe(200);

    expect((await submit(c.id, 1, author.id)).statusCode).toBe(422); // the reviewer is never the author
    const s = await submit(c.id, 1);
    expect(s.statusCode).toBe(202);
    expect((await submit(c.id, 1)).statusCode).toBe(409); // one pending review at a time
    expect((await invoke(text)).statusCode).toBe(200); // pending is not published
    // the author cannot decide their own version, even as an admin
    const own = await decide(author, s.json().approvalId, "approved", "admin override for the test");
    expect(own.statusCode, own.body).toBe(403);
    expect(own.json().error).toBe("cannot_approve_own_classifier");
    expect((await decide(reviewer, s.json().approvalId, "approved")).statusCode).toBe(200);

    const blocked = await invoke(text);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe("guardrail_blocked");
    expect(blocked.json().guardrails.findings).toContainEqual(expect.objectContaining({ category: `classifier.${key("regex")}` }));
    const [row] = await db.select().from(auditLog).where(and(eq(auditLog.objectId, c.id), eq(auditLog.ruleId, "custom-classifier-published"))).limit(1);
    expect(row).toBeDefined();
  });

  it("EDM: only digests are stored; a matching value is blocked; no value reaches an audit row", async () => {
    const c = await create(key("edm"), {
      mode: "block",
      definition: { kind: "exact_data_match", normalisation: "casefold", maxTokens: 1 },
      values: [SECRET_ID, "  ", SECRET_ID.toLowerCase()],
    });
    expect(c.versions[0]!.valueCount).toBe(1); // normalised and de-duplicated; the blank skipped
    const [v] = await db.select().from(customClassifierVersions).where(eq(customClassifierVersions.classifierId, c.id));
    const digests = await db.select().from(customClassifierEdmDigests).where(eq(customClassifierEdmDigests.versionId, v!.id));
    expect(digests).toHaveLength(1);
    expect(digests[0]!.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(v)).not.toContain(SECRET_ID.toLowerCase());
    const [k] = await db.select().from(customClassifierHashKey);
    expect(k!.keyCiphertext).not.toMatch(/^[0-9a-f]{64}$/); // enveloped, not the raw key

    await publish(c.id, 1);
    const res = await invoke(`the employee is ${SECRET_ID.toLowerCase()}, thanks`);
    expect(res.statusCode).toBe(403);
    expect(res.json().guardrails.findings).toContainEqual(expect.objectContaining({ category: `classifier.${key("edm")}` }));
    const rows = await db.select().from(auditLog).orderBy(desc(auditLog.at)).limit(30);
    expect(JSON.stringify(rows).toLowerCase()).not.toContain(SECRET_ID.toLowerCase());
  });

  it("a newer version supersedes the published one; retiring needs a step-up and stops enforcement", async () => {
    const c = await create(key("kw"), { mode: "block", definition: { kind: "keyword", terms: [`aurora${RUN}`] } });
    await publish(c.id, 1);
    expect((await invoke(`about aurora${RUN}`)).statusCode).toBe(403);

    const v2 = await app.inject({ method: "POST", headers: author.auth, url: `/v1/classifiers/${c.id}/versions`, payload: { mode: "warn", definition: { kind: "keyword", terms: [`aurora${RUN}`] } } });
    expect(v2.statusCode).toBe(201);
    await publish(c.id, 2);
    const statuses = (await db.select().from(customClassifierVersions).where(eq(customClassifierVersions.classifierId, c.id))).map((v) => [v.version, v.status]);
    expect(statuses.sort()).toEqual([[1, "superseded"], [2, "published"]]);
    expect((await invoke(`about aurora${RUN}`)).statusCode).toBe(200); // warn proceeds

    const noStepUp = await app.inject({ method: "POST", headers: author.auth, url: `/v1/classifiers/${c.id}/retire`, payload: { reason: "obsolete" } });
    expect(noStepUp.statusCode).not.toBe(200);
    const retired = await app.inject({ method: "POST", headers: AUTH, url: `/v1/classifiers/${c.id}/retire`, payload: { reason: "obsolete" } });
    expect(retired.statusCode).toBe(200);
    expect(retired.json().versions[0]).toMatchObject({ version: 2, status: "retired" });
    // a retired version cannot be submitted or retired again (the declared machine)
    expect((await app.inject({ method: "POST", headers: AUTH, url: `/v1/classifiers/${c.id}/retire`, payload: { reason: "again" } })).statusCode).toBe(409);
    expect((await submit(c.id, 1)).statusCode).toBe(409);
  });

  it("a denied version is rejected and never published; bad definitions and non-admins are refused", async () => {
    const c = await create(key("deny"), { mode: "block", definition: { kind: "dictionary", terms: [`zz${RUN}`] } });
    const s = await submit(c.id, 1);
    expect((await decide(reviewer, s.json().approvalId, "denied")).statusCode).toBe(200);
    expect((await db.select().from(customClassifierVersions).where(eq(customClassifierVersions.classifierId, c.id)))[0]!.status).toBe("rejected");
    expect((await invoke(`zz${RUN}`)).statusCode).toBe(200);

    const bad = await app.inject({ method: "POST", headers: author.auth, url: "/v1/classifiers", payload: { key: key("bad"), name: "bad", version: { mode: "block", definition: { kind: "regex", pattern: "(a)\\1" } } } });
    expect(bad.statusCode).toBe(422);
    const noValues = await app.inject({ method: "POST", headers: author.auth, url: "/v1/classifiers", payload: { key: key("nov"), name: "nov", version: { mode: "block", definition: { kind: "exact_data_match", normalisation: "digits", maxTokens: 1 } } } });
    expect(noValues.statusCode).toBe(422);
    expect((await app.inject({ method: "GET", headers: caller.auth, url: "/v1/classifiers" })).statusCode).toBe(403);
  });

  it("the dry run counts matches and stores nothing", async () => {
    const before = (await db.select().from(customClassifierEdmDigests)).length;
    const r = await app.inject({
      method: "POST",
      headers: author.auth,
      url: "/v1/classifiers/test",
      payload: { definition: { kind: "exact_data_match", normalisation: "digits", maxTokens: 1 }, values: ["555-0100"], text: "call 5550100 or 555-0100" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ count: 2 });
    expect((await db.select().from(customClassifierEdmDigests)).length).toBe(before);
  });
});
