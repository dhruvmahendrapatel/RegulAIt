/**
 * ADR-0179 security review of the AER-050 batch, items 2, 3 and 6, through the
 * real routes on a real database.
 *
 *  item 2  A replayed questionnaire submission (same Idempotency-Key) re-runs
 *          the dependent-object mirror, so a use case left behind its instance
 *          by a crash between the commit and the mirror catches up on the
 *          retry. The mirror is a compare-and-swap: syncs racing for one move
 *          move and audit it once.
 *  item 3  A claim keeps a reference to the record it wrote (`{ replayOf }`),
 *          not the record's text; the replay is rebuilt from the record under
 *          its read rule. A claim stored before the change (the full body)
 *          still replays verbatim. Claims past the 30-day window are deleted
 *          from both claim tables by the `idempotency-key-sweep` job.
 *  item 6  A draft write naming a different person than the caller (the exit
 *          save of a person who signed out, arriving under the next person's
 *          cookie) is refused and stores nothing.
 *
 * Shared-database discipline: every fixture carries a run-unique token and is
 * resolved by id; nothing asserts a global count.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aiRisks,
  aiUseCases,
  and,
  auditLog,
  createDb,
  eq,
  inArray,
  requestIdempotencyKeys,
  runMigrations,
  sql,
  useCaseDrafts,
  useCaseIdempotencyKeys,
  type Db,
} from "@regulait/db";
import type { EuAiActAnswers } from "@regulait/shared";
import { buildApp } from "./app.js";
import { requestDigestOf, runIdempotencyKeySweep } from "./request-idempotency.js";
import { SCHEDULER_JOB_NAMES, schedulerJobRegistry } from "./scheduler-jobs.js";
import { syncUseCaseForInstance } from "./use-cases.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `a050r-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
type Who = "admin" | "owner" | "other";
const users = {} as Record<Who, { id: string; auth: { authorization: string } }>;
let db: Db;
let app: ReturnType<typeof buildApp>;

const minimal: EuAiActAnswers = {
  purposeDomain: "general-business",
  affectedPersons: [],
  decisionAutonomy: "informs-human",
  biometricUse: "none",
  emotionRecognition: false,
  socialScoring: false,
  manipulativeTechniques: false,
  profilesNaturalPersons: false,
  safetyComponent: false,
  interactsWithHumans: false,
  generatesSyntheticContent: false,
};
const context = {
  sectors: [],
  dataCategories: ["proprietary"],
  deployment: "internal",
  euNexus: false,
  usesExternalVendor: false,
  generative: false,
  autonomousActions: false,
  toolsUsed: [],
};

const inject = (method: "GET" | "PUT" | "DELETE" | "POST", url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const proposal = (label: string, extra: Record<string, unknown> = {}) => ({
  name: `a050r ${label} ${RUN}`,
  description: `synthetic private description ${label} ${RUN}`,
  businessContext: "replay retention",
  dataSensitivity: "internal",
  ...extra,
});
const create = (label: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  inject("POST", "/v1/use-cases", { ...users.owner.auth, ...headers }, proposal(label, extra));
const useCaseStatus = async (id: string) =>
  (await db.select({ status: aiUseCases.status }).from(aiUseCases).where(eq(aiUseCases.id, id)))[0]!.status;
const lifecycleAudits = (useCaseId: string) =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.objectId, useCaseId), eq(auditLog.ruleId, "use-case-under_review")));

const createdRiskIds: string[] = [];

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  for (const [k, isAdmin] of [["admin", true], ["owner", false], ["other", false]] as Array<[Who, boolean]>) {
    const u = await inject("POST", "/v1/users", AUTH, { email: `a050r-${k}-${RUN}@example.com`, displayName: `a050r ${k}`, isAdmin });
    expect(u.statusCode, u.body).toBe(201);
    const id = u.json().id as string;
    const token = (await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "a050r" })).json().token as string;
    users[k] = { id, auth: { authorization: `Bearer ${token}` } };
  }
}, 120_000);

afterAll(async () => {
  if (createdRiskIds.length) await db.delete(aiRisks).where(inArray(aiRisks.id, createdRiskIds));
  const mine = Object.values(users).map((u) => u.id);
  if (mine.length) {
    await db.delete(requestIdempotencyKeys).where(inArray(requestIdempotencyKeys.userId, mine));
    await db.delete(useCaseIdempotencyKeys).where(inArray(useCaseIdempotencyKeys.userId, mine));
    await db.delete(useCaseDrafts).where(inArray(useCaseDrafts.userId, mine));
  }
  app.server.closeAllConnections();
  await app.close();
});

// ===========================================================================
// item 2 — a replay re-runs the mirror the original may never have run
// ===========================================================================

describe("ADR-0179 review item 2: a replayed questionnaire submission re-runs the use-case mirror", () => {
  const questionnaire = (label: string) =>
    `# AI use-case intake questionnaire\n\n## 1. Purpose\n\n${label} ${RUN}\n\n## 9. EU AI Act risk screening\n\n` +
    "```eu-ai-act-answers\n" + JSON.stringify(minimal, null, 2) + "\n```";
  const started = async (label: string) => {
    const c = await create(label, { screeningAnswers: { ...minimal, ...context } });
    expect(c.statusCode, c.body).toBe(201);
    const instanceId = c.json().instance.id as string;
    const adv = await inject("POST", `/v1/workflows/instances/${instanceId}/advance`, users.owner.auth, { stageId: "plan" });
    expect(adv.statusCode, adv.body).toBe(200);
    return { useCaseId: c.json().id as string, instanceId };
  };

  it("a use case left behind its instance (the mirror never ran) catches up when the retry replays", async () => {
    const { useCaseId, instanceId } = await started("mirror");
    const key = { "idempotency-key": `mirror-${RUN}` };
    const submit = () =>
      inject("POST", `/v1/workflows/instances/${instanceId}/artifacts`, { ...users.owner.auth, ...key }, {
        stageId: "questionnaire",
        content: questionnaire("mirror"),
      });
    const first = await submit();
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().status).toBe("blocked_on_approval");
    expect(await useCaseStatus(useCaseId)).toBe("under_review");

    // the artifact and the transition committed, then the process died before
    // the post-commit mirror: the use case still reads as it did before
    await db.update(aiUseCases).set({ status: "proposed" }).where(eq(aiUseCases.id, useCaseId));
    const auditsBefore = (await lifecycleAudits(useCaseId)).length;

    const again = await submit();
    expect(again.statusCode, again.body).toBe(200);
    expect(again.headers["idempotent-replay"]).toBe("true");
    expect(again.json()).toEqual(first.json());
    expect(await useCaseStatus(useCaseId)).toBe("under_review");
    expect((await lifecycleAudits(useCaseId)).length).toBe(auditsBefore + 1);

    // a replay with nothing left to mirror changes nothing and audits nothing
    const third = await submit();
    expect(third.statusCode, third.body).toBe(200);
    expect((await lifecycleAudits(useCaseId)).length).toBe(auditsBefore + 1);
  });

  it("syncs racing for the same move move the use case and audit it once", async () => {
    const { useCaseId, instanceId } = await started("race");
    const first = await inject("POST", `/v1/workflows/instances/${instanceId}/artifacts`, users.owner.auth, {
      stageId: "questionnaire",
      content: questionnaire("race"),
    });
    expect(first.statusCode, first.body).toBe(201);
    await db.update(aiUseCases).set({ status: "proposed" }).where(eq(aiUseCases.id, useCaseId));
    const before = (await lifecycleAudits(useCaseId)).length;
    // open enough pooled connections first, so the syncs really run side by side
    await Promise.all(Array.from({ length: 8 }, () => db.execute(sql`select pg_sleep(0.05)`)));
    await Promise.all(Array.from({ length: 6 }, () => syncUseCaseForInstance(db, instanceId, users.owner.id)));
    expect(await useCaseStatus(useCaseId)).toBe("under_review");
    expect((await lifecycleAudits(useCaseId)).length).toBe(before + 1);
  });
});

// ===========================================================================
// item 3 — what a claim keeps, and the 30-day sweep
// ===========================================================================

describe("ADR-0179 review item 3: a claim keeps a reference, not the record", () => {
  const riskBody = (useCaseId: string) => ({
    title: `a050r risk ${RUN}`,
    description: `synthetic sensitive risk narrative ${RUN}`,
    category: "bias_fairness",
    likelihood: "medium",
    impact: "high",
    useCaseId,
  });
  const postRisk = (body: unknown, headers: Record<string, string>, who: Who = "owner") =>
    inject("POST", "/v1/risks", { ...users[who].auth, ...headers }, body);
  const requestClaim = async (scope: string, key: string) =>
    (
      await db
        .select()
        .from(requestIdempotencyKeys)
        .where(
          and(
            eq(requestIdempotencyKeys.userId, users.owner.id),
            eq(requestIdempotencyKeys.scope, scope),
            eq(requestIdempotencyKeys.key, key),
          ),
        )
    )[0]!;
  const useCaseClaim = async (key: string) =>
    (
      await db
        .select()
        .from(useCaseIdempotencyKeys)
        .where(and(eq(useCaseIdempotencyKeys.userId, users.owner.id), eq(useCaseIdempotencyKeys.key, key)))
    )[0]!;

  it("a risk claim keeps only the risk's id; the replay is the same body, rebuilt", async () => {
    const uc = (await create("risk-ref")).json().id as string;
    const key = `risk-ref-${RUN}`;
    const first = await postRisk(riskBody(uc), { "idempotency-key": key });
    expect(first.statusCode, first.body).toBe(201);
    createdRiskIds.push(first.json().id as string);
    const claim = await requestClaim("risk", key);
    expect(claim.response).toEqual({ replayOf: first.json().id });
    expect(JSON.stringify(claim.response)).not.toContain("sensitive risk narrative");

    const again = await postRisk(riskBody(uc), { "idempotency-key": key });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.headers["idempotent-replay"]).toBe("true");
    expect(again.json()).toEqual(first.json());

    // the risk moved to someone else: the replay no longer shows its text
    await db.update(aiRisks).set({ ownerUserId: users.admin.id }).where(eq(aiRisks.id, first.json().id as string));
    const moved = await postRisk(riskBody(uc), { "idempotency-key": key });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json()).toEqual({ id: first.json().id });
  });

  it("a risk claim stored before the change (the full body) still replays verbatim", async () => {
    const uc = (await create("risk-legacy")).json().id as string;
    const key = `risk-legacy-${RUN}`;
    const body = riskBody(uc);
    const legacy = { id: "00000000-0000-4000-8000-00000000a050", title: body.title, description: body.description, status: "open" };
    await db.insert(requestIdempotencyKeys).values({
      userId: users.owner.id,
      scope: "risk",
      key,
      requestDigest: requestDigestOf(body),
      response: legacy,
    });
    const replay = await postRisk(body, { "idempotency-key": key });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.headers["idempotent-replay"]).toBe("true");
    expect(replay.json()).toEqual(legacy);
    expect(await db.select().from(aiRisks).where(eq(aiRisks.useCaseId, uc))).toHaveLength(0);
  });

  it("a use-case claim keeps only the use case's id; the replay is the same 201 body, rebuilt", async () => {
    const key = `uc-ref-${RUN}`;
    const first = await create("uc-ref", {}, { "idempotency-key": key });
    expect(first.statusCode, first.body).toBe(201);
    const claim = await useCaseClaim(key);
    expect(claim.response).toEqual({ replayOf: first.json().id });
    expect(JSON.stringify(claim.response)).not.toContain("private description");

    const again = await create("uc-ref", {}, { "idempotency-key": key });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.headers["idempotent-replay"]).toBe("true");
    expect(again.json()).toEqual(first.json());

    // concurrent duplicates replay the rebuilt body too
    const raceKey = { "idempotency-key": `uc-ref-race-${RUN}` };
    const results = await Promise.all(Array.from({ length: 4 }, () => create("uc-ref-race", {}, raceKey)));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 200, 201]);
    const created = results.find((r) => r.statusCode === 201)!.json();
    for (const r of results) expect(r.json()).toEqual(created);
  });

  it("a use-case claim stored before the change (the full body) still replays verbatim", async () => {
    const key = `uc-legacy-${RUN}`;
    const legacy = { id: "00000000-0000-4000-8000-00000000a051", name: `legacy ${RUN}`, note: "the original body" };
    await db.insert(useCaseIdempotencyKeys).values({ userId: users.owner.id, key, response: legacy });
    const replay = await create("uc-legacy", {}, { "idempotency-key": key });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual(legacy);
    expect(await db.select().from(aiUseCases).where(eq(aiUseCases.name, `a050r uc-legacy ${RUN}`))).toHaveLength(0);
  });

  it("the idempotency-key-sweep job deletes claims past the 30-day window from both tables, and only those", async () => {
    const old = new Date(Date.now() - 31 * 24 * 3_600_000);
    const recent = new Date(Date.now() - 29 * 24 * 3_600_000);
    const [oldReq, newReq] = await db
      .insert(requestIdempotencyKeys)
      .values([
        { userId: users.owner.id, scope: "risk", key: `sweep-old-${RUN}`, requestDigest: "x", response: { replayOf: "a" }, createdAt: old },
        { userId: users.owner.id, scope: "risk", key: `sweep-new-${RUN}`, requestDigest: "x", response: { replayOf: "b" }, createdAt: recent },
      ])
      .returning({ id: requestIdempotencyKeys.id });
    const [oldUc, newUc] = await db
      .insert(useCaseIdempotencyKeys)
      .values([
        { userId: users.owner.id, key: `sweep-old-${RUN}`, response: { replayOf: "c" }, createdAt: old },
        { userId: users.owner.id, key: `sweep-new-${RUN}`, response: { replayOf: "d" }, createdAt: recent },
      ])
      .returning({ id: useCaseIdempotencyKeys.id });

    const job = schedulerJobRegistry().get(SCHEDULER_JOB_NAMES.idempotencyKeySweep);
    expect(job).toBeDefined();
    const out = await job!.run({ db, actorUserId: null, now: new Date(), runId: "00000000-0000-4000-8000-000000000000" });
    expect(out.itemsProcessed).toBeGreaterThanOrEqual(2);

    const reqLeft = await db
      .select({ id: requestIdempotencyKeys.id })
      .from(requestIdempotencyKeys)
      .where(inArray(requestIdempotencyKeys.id, [oldReq!.id, newReq!.id]));
    expect(reqLeft.map((r) => r.id)).toEqual([newReq!.id]);
    const ucLeft = await db
      .select({ id: useCaseIdempotencyKeys.id })
      .from(useCaseIdempotencyKeys)
      .where(inArray(useCaseIdempotencyKeys.id, [oldUc!.id, newUc!.id]));
    expect(ucLeft.map((r) => r.id)).toEqual([newUc!.id]);
  });

  it("a pass is bounded and reports when it stopped short", async () => {
    const old = new Date(Date.now() - 40 * 24 * 3_600_000);
    await db.insert(requestIdempotencyKeys).values(
      [1, 2, 3].map((n) => ({ userId: users.owner.id, scope: "risk", key: `cap-${n}-${RUN}`, requestDigest: "x", createdAt: old })),
    );
    const out = await runIdempotencyKeySweep(db, { batch: 2 });
    expect(out.requestKeys).toBe(2);
    expect(out.capped).toBe(true);
    const rest = await runIdempotencyKeySweep(db, { batch: 1000 });
    expect(rest.capped).toBe(false);
    const left = await db
      .select()
      .from(requestIdempotencyKeys)
      .where(and(eq(requestIdempotencyKeys.userId, users.owner.id), inArray(requestIdempotencyKeys.key, [1, 2, 3].map((n) => `cap-${n}-${RUN}`))));
    expect(left).toHaveLength(0);
  });
});

// ===========================================================================
// item 6 — a draft write is the named person's, or nothing
// ===========================================================================

describe("ADR-0179 review item 6: a draft write naming another person is refused", () => {
  const OWNER_HEADER = "x-regulait-draft-owner";
  const draftOf = async (who: Who) =>
    (
      await db
        .select()
        .from(useCaseDrafts)
        .where(and(eq(useCaseDrafts.userId, users[who].id), eq(useCaseDrafts.scope, "new")))
    )[0] ?? null;

  it("the exit save of a person who signed out, arriving under the next person's credential, stores nothing", async () => {
    const mine = { kind: "registration", step: 2, form: { title: `owner's private draft ${RUN}` } };
    const own = await inject("PUT", "/v1/use-cases/draft?scope=new", { ...users.owner.auth, [OWNER_HEADER]: users.owner.id }, { state: mine });
    expect(own.statusCode, own.body).toBe(200);

    // the queued save names the owner, but the cookie is now the other person's
    const late = await inject(
      "PUT",
      "/v1/use-cases/draft?scope=new",
      { ...users.other.auth, [OWNER_HEADER]: users.owner.id },
      { state: { ...mine, step: 3 } },
    );
    expect(late.statusCode, late.body).toBe(409);
    expect(late.json().error).toBe("draft_owner_changed");
    expect(await draftOf("other")).toBeNull();
    expect((await draftOf("owner"))!.state).toEqual(mine);

    // a delete naming someone else is refused the same way
    await inject("PUT", "/v1/use-cases/draft?scope=new", users.other.auth, { state: { kind: "registration", step: 0 } });
    const del = await inject("DELETE", "/v1/use-cases/draft?scope=new", { ...users.other.auth, [OWNER_HEADER]: users.owner.id });
    expect(del.statusCode, del.body).toBe(409);
    expect(await draftOf("other")).not.toBeNull();

    // no header: unchanged behaviour
    expect((await inject("DELETE", "/v1/use-cases/draft?scope=new", users.other.auth)).statusCode).toBe(204);
    expect((await inject("DELETE", "/v1/use-cases/draft?scope=new", { ...users.owner.auth, [OWNER_HEADER]: users.owner.id })).statusCode).toBe(204);
  });
});
