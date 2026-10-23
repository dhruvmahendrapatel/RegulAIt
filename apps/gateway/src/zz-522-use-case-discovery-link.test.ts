/**
 * Issue #522 finding #30 (migration 0211): a use case registered from a shadow-AI finding keeps the link.
 *
 * POST /v1/use-cases takes `discoveryFindingId`. Only an admin may name one (findings are admin-only), the finding
 * must exist in this deployment's database, and a finding is registered as one use case at most. The link is stored
 * on the use case and audited on both objects in the creation transaction. The detail read and the findings list
 * show it from either side.
 *
 * Tenant isolation: there is no tenant column on either table. A tenant is a deployment with its own database, so a
 * finding id from another tenant is simply not a row here and is refused like any unknown id.
 *
 * Break proofs (each run by hand against a real Postgres):
 *  - drop the admin check: "a non-admin cannot name a finding" fails;
 *  - drop the 400 on an unknown finding: "an unknown finding" and "another tenant" fail;
 *  - drop the holder pre-check and the route's index-conflict handler: "a second registration" fails (the app's
 *    generic unique-violation handler answers 409 `conflict`, without naming the holder). The race test holds either
 *    way: it proves the unique index, which is what makes the race safe;
 *  - drop the finding's audit insert: the four tests that count link audit rows fail.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { aiUseCases, and, auditLog, createDb, eq, inArray, runMigrations, shadowAiFindings, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { SHADOW_AI_RULE_IDS } from "./shadow-ai.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "zz-522-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const RUN = Math.random().toString(36).slice(2, 8);

let db: Db;
let app: ReturnType<typeof buildApp>;
let restoreAdminKeyMfa: (() => Promise<void>) | undefined;
let adminAuth: { authorization: string };
let memberAuth: { authorization: string };
const findingIds: string[] = [];

async function makeUser(name: string, isAdmin: boolean) {
  const user = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email: `zz522-${name}-${RUN}@example.com`, displayName: name, isAdmin },
  });
  expect(user.statusCode).toBe(201);
  const key = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${user.json().id}/keys`, payload: { name: "zz522" } });
  return { authorization: `Bearer ${key.json().token}` };
}

async function makeFinding(subject: string) {
  const now = new Date();
  const [row] = await db
    .insert(shadowAiFindings)
    .values({
      subjectKind: "repo",
      subject: `${subject}-${RUN}`,
      provider: "example-provider",
      signalSources: ["sdk_dependency"],
      signatureKinds: ["sdk"],
      firstSeenAt: now,
      lastSeenAt: now,
      observationCount: 1,
      severity: "high",
      confidence: "low",
      evidence: [],
    })
    .returning();
  findingIds.push(row!.id);
  return row!;
}

const register = (name: string, extra: Record<string, unknown>, auth = adminAuth, key?: string) =>
  app.inject({
    method: "POST",
    headers: { ...auth, ...(key ? { "idempotency-key": key } : {}) },
    url: "/v1/use-cases",
    payload: {
      name: `${name}-${RUN}`,
      description: "drafts credit memos from the case file",
      businessContext: "faster memos, every decision stays with a person",
      dataSensitivity: "confidential",
      ...extra,
    },
  });

const useCasesNamed = (name: string) => db.select().from(aiUseCases).where(eq(aiUseCases.name, `${name}-${RUN}`));
const linkAudits = (findingId: string) =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.objectId, findingId), eq(auditLog.ruleId, SHADOW_AI_RULE_IDS.findingUseCaseLinked)));

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // an admin's API key answers to mfaRequired; this suite is not about MFA (handed back strict in afterAll, M-068)
  restoreAdminKeyMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "5".repeat(64) });
  adminAuth = await makeUser("ada", true);
  memberAuth = await makeUser("avery", false);
});

afterAll(async () => {
  if (findingIds.length > 0) {
    await db.delete(auditLog).where(inArray(auditLog.objectId, findingIds));
    await db.delete(shadowAiFindings).where(inArray(shadowAiFindings.id, findingIds));
  }
  await restoreAdminKeyMfa?.();
  await app.close();
  await db.$client.end();
});

describe("a use case registered from a shadow-AI finding keeps the link", () => {
  it("stores the link and audits it on the use case and on the finding, in the creation transaction", async () => {
    const finding = await makeFinding("credit-memo");
    const res = await register("uc-linked", { discoveryFindingId: finding.id });
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;

    const [row] = await db.select().from(aiUseCases).where(eq(aiUseCases.id, id));
    expect(row!.discoveryFindingId).toBe(finding.id);

    const [proposed] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, id), eq(auditLog.ruleId, "use-case-proposed")));
    expect(proposed!.detail).toMatchObject({ discoveryFindingId: finding.id });
    expect(proposed!.reason).toContain(finding.id);

    const linked = await linkAudits(finding.id);
    expect(linked).toHaveLength(1);
    expect(linked[0]!.objectType).toBe("shadow_ai_finding");
    expect(linked[0]!.detail).toMatchObject({ useCaseId: id, subject: finding.subject });
  });

  it("the record shows where it was found (details to an admin), and the finding shows its use case", async () => {
    const finding = await makeFinding("record-shows");
    const id = (await register("uc-shows", { discoveryFindingId: finding.id })).json().id as string;

    const detail = await app.inject({ method: "GET", headers: adminAuth, url: `/v1/use-cases/${id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().discovery).toMatchObject({ findingId: finding.id, finding: { id: finding.id, subject: finding.subject, subjectKind: "repo" } });

    const list = await app.inject({ method: "GET", headers: adminAuth, url: "/v1/shadow-ai/findings" });
    const shown = (list.json().findings as Array<{ id: string; linkedUseCase: unknown }>).find((f) => f.id === finding.id);
    expect(shown!.linkedUseCase).toMatchObject({ id, name: `uc-shows-${RUN}`, status: "proposed" });

    // a use case registered any other way says nothing about discovery
    const plain = (await register("uc-plain", {})).json().id as string;
    expect((await app.inject({ method: "GET", headers: adminAuth, url: `/v1/use-cases/${plain}` })).json().discovery).toBeNull();
  });

  it("a non-admin reader of the use case sees that discovery found it, never the finding's details", async () => {
    const finding = await makeFinding("member-reads");
    // the member owns a use case; the link is set directly (a member cannot set it through the route)
    const own = await register("uc-member", {}, memberAuth);
    expect(own.statusCode).toBe(201);
    await db.update(aiUseCases).set({ discoveryFindingId: finding.id }).where(eq(aiUseCases.id, own.json().id));
    const detail = await app.inject({ method: "GET", headers: memberAuth, url: `/v1/use-cases/${own.json().id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().discovery).toEqual({ findingId: finding.id, finding: null });
  });

  it("a non-admin cannot name a finding, and the refusal does not say whether the id exists", async () => {
    const finding = await makeFinding("member-refused");
    const known = await register("uc-member-known", { discoveryFindingId: finding.id }, memberAuth);
    const unknown = await register("uc-member-unknown", { discoveryFindingId: randomUUID() }, memberAuth);
    expect(known.statusCode).toBe(403);
    expect(unknown.statusCode).toBe(403);
    expect(known.json()).toEqual(unknown.json());
    expect(known.json().error).toBe("finding_not_readable");
    expect(await useCasesNamed("uc-member-known")).toHaveLength(0);
    expect(await linkAudits(finding.id)).toHaveLength(0);
  });

  it("an unknown finding is refused 400 and nothing is created", async () => {
    const res = await register("uc-unknown", { discoveryFindingId: randomUUID() });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_reference", field: "discoveryFindingId" });
    expect(await useCasesNamed("uc-unknown")).toHaveLength(0);
  });

  it("a finding id from another tenant (not a row in this deployment's database) is refused like an unknown one", async () => {
    // another tenant's finding: it exists only in that tenant's database, which this one never reads
    const elsewhere = await makeFinding("other-tenant");
    await db.delete(shadowAiFindings).where(eq(shadowAiFindings.id, elsewhere.id));
    const res = await register("uc-cross-tenant", { discoveryFindingId: elsewhere.id });
    expect(res.statusCode).toBe(400);
    expect(res.json().field).toBe("discoveryFindingId");
    expect(await useCasesNamed("uc-cross-tenant")).toHaveLength(0);
  });

  it("a retry with the same Idempotency-Key replays the one use case and writes no second link", async () => {
    const finding = await makeFinding("idempotent");
    const key = randomUUID();
    const first = await register("uc-idem", { discoveryFindingId: finding.id }, adminAuth, key);
    expect(first.statusCode).toBe(201);
    const again = await register("uc-idem", { discoveryFindingId: finding.id }, adminAuth, key);
    expect(again.statusCode).toBe(200);
    expect(again.headers["idempotent-replay"]).toBe("true");
    expect(again.json().id).toBe(first.json().id);
    expect(await useCasesNamed("uc-idem")).toHaveLength(1);
    expect(await linkAudits(finding.id)).toHaveLength(1);
  });

  it("a second registration of a finding is refused 409, naming the use case that holds it", async () => {
    const finding = await makeFinding("twice");
    const first = await register("uc-first", { discoveryFindingId: finding.id });
    expect(first.statusCode).toBe(201);
    const second = await register("uc-second", { discoveryFindingId: finding.id });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: "finding_already_registered", useCaseId: first.json().id });
    expect(await useCasesNamed("uc-second")).toHaveLength(0);
    expect(await linkAudits(finding.id)).toHaveLength(1);
  });

  it("two concurrent registrations of one finding: exactly one wins, the other is refused 409", async () => {
    const finding = await makeFinding("race");
    const [a, b] = await Promise.all([
      register("uc-race-a", { discoveryFindingId: finding.id }),
      register("uc-race-b", { discoveryFindingId: finding.id }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    const holders = await db.select().from(aiUseCases).where(eq(aiUseCases.discoveryFindingId, finding.id));
    expect(holders).toHaveLength(1);
    expect(await linkAudits(finding.id)).toHaveLength(1);
  });
});
