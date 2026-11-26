/**
 * ADR-0351 slice 2 — the EU AI Act deployer-obligation register over the active `eu-ai-act-deployer` pack.
 *
 * The pack row is shared with other runs on the same database (seeded once, idempotently), so assertions read the
 * state before an action and check the transition, never a fixed starting state.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, auditLog, compliancePackAttestations, compliancePacks, createDb, desc, eq, runMigrations, sql, type Db } from "@regulait/db";
import { DEPLOYER_ITEM_TRANSITIONS, EU_AI_ACT_DEPLOYER_FRAMEWORK } from "@regulait/shared";
import { buildApp } from "./app.js";
import { installLicenseFixture, removeLicenseFixture } from "./testing/license-fixture.js";
import { DEPLOYER_REGISTER_RULE_IDS } from "./deployer-register.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "adr0351-register-bootstrap";
const ADMIN = { authorization: `Bearer ${BOOT}` };
const RUN = Date.now();
const ATTESTED = `${EU_AI_ACT_DEPLOYER_FRAMEWORK}:art-26-9-dpia`;
const OBSERVED = `${EU_AI_ACT_DEPLOYER_FRAMEWORK}:art-26-6-keep-logs`;
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

let db: Db;
let app: ReturnType<typeof buildApp>;
let packId: string;
/** a NAMED admin: an attestation is a person's statement, so the bootstrap token cannot make one */
let attesterId: string;
let attesterKey: { authorization: string };
const restores: Array<() => Promise<void>> = [];

const get = async () => {
  const res = await app.inject({ method: "GET", url: "/v1/compliance/deployer-register", headers: ADMIN });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
};
const item = (reg: { items: Array<{ controlRef: string }> }, ref: string) => reg.items.find((i) => i.controlRef === ref) as Record<string, any>;
const attest = (payload: Record<string, unknown>, headers: Record<string, string> = attesterKey) =>
  app.inject({ method: "POST", url: "/v1/compliance/deployer-register/attest", headers, payload });

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  await app.ready();
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  await installLicenseFixture(app, { features: ["compliance_packs"], auth: ADMIN });
  const u = await app.inject({ method: "POST", url: "/v1/users", headers: ADMIN, payload: { email: `adr0351-attester-${RUN}@example.com`, displayName: "adr0351 attester", isAdmin: true } });
  expect(u.statusCode, u.body).toBe(201);
  attesterId = u.json().id as string;
  const k = await app.inject({ method: "POST", url: `/v1/users/${attesterId}/keys`, headers: ADMIN, payload: { name: "attester" } });
  expect(k.statusCode, k.body).toBe(201);
  attesterKey = { authorization: `Bearer ${k.json().token}` };
  const seeded = await app.inject({ method: "POST", url: "/v1/compliance/packs/seed", headers: ADMIN, payload: {} });
  expect(seeded.statusCode, seeded.body).toBe(201);
  const [pack] = await db
    .select()
    .from(compliancePacks)
    .where(and(eq(compliancePacks.framework, EU_AI_ACT_DEPLOYER_FRAMEWORK), eq(compliancePacks.version, 1)));
  packId = pack!.id;
  if (pack!.status !== "active") {
    const act = await app.inject({ method: "POST", url: `/v1/compliance/packs/${packId}/activate`, headers: ADMIN, payload: {} });
    expect(act.statusCode, act.body).toBe(200);
  }
});

afterAll(async () => {
  await removeLicenseFixture(db);
  for (const r of restores.reverse()) await r();
  await app?.close();
});

describe("the register view", () => {
  it("lists every duty with one basis, a declared state, and the lifecycle table", async () => {
    const reg = await get();
    expect(reg.pack).toMatchObject({ id: packId, framework: EU_AI_ACT_DEPLOYER_FRAMEWORK, version: 1 });
    expect(reg.lifecycle.transitions).toEqual(DEPLOYER_ITEM_TRANSITIONS);
    expect(reg.totals.items).toBe(reg.items.length);
    expect(reg.totals.observedBasis + reg.totals.attestedBasis).toBe(reg.items.length);
    expect(reg.disclaimer).toMatch(/not a compliance certification/);
    const obs = item(reg, OBSERVED);
    expect(obs).toMatchObject({ basis: "observed", attestation: null });
    expect(["open", "observed"]).toContain(obs.state);
    expect(obs.evidence).toMatchObject({ collector: "compliance_profile_cascade", minEvidenceCount: 1 });
    expect(obs.evidence.links.recount).toBe(`/v1/compliance/packs/${packId}/evaluate`);
    expect(obs.allowedEvents.every((e: { event: string }) => e.event !== "attest")).toBe(true);
    const att = item(reg, ATTESTED);
    expect(att).toMatchObject({ basis: "attested", evidence: null });
    expect(["open", "attested", "review_due"]).toContain(att.state);
    expect(att.allowedEvents.some((e: { event: string }) => e.event === "attest")).toBe(true);
  });

  it("refuses a period it does not know", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/compliance/deployer-register?period=forever", headers: ADMIN });
    expect(res.statusCode).toBe(400);
  });
});

describe("attesting", () => {
  it("refuses an observed duty, audited: a person cannot attest what the system observes", async () => {
    const res = await attest({ controlRef: OBSERVED, statement: "we keep logs", evidenceRef: `doc-${RUN}`, reviewDate: inDays(90) });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("transition_not_allowed");
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, DEPLOYER_REGISTER_RULE_IDS.attestRefused), sql`${auditLog.detail} ->> 'controlRef' = ${OBSERVED}`))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect(row?.effect).toBe("deny");
  });

  it("needs an evidence reference and a review date in the future, at most a year ahead", async () => {
    expect((await attest({ controlRef: ATTESTED, statement: "s", reviewDate: inDays(30) })).statusCode).toBe(400);
    expect((await attest({ controlRef: ATTESTED, statement: "s", evidenceRef: "d" })).statusCode).toBe(400);
    const past = await attest({ controlRef: ATTESTED, statement: "s", evidenceRef: "d", reviewDate: inDays(-1) });
    expect(past.statusCode).toBe(400);
    expect(past.json().error).toBe("review_date_not_future");
    const far = await attest({ controlRef: ATTESTED, statement: "s", evidenceRef: "d", reviewDate: inDays(400) });
    expect(far.statusCode).toBe(400);
    expect(far.json().error).toBe("review_date_too_far");
    expect((await attest({ controlRef: `${EU_AI_ACT_DEPLOYER_FRAMEWORK}:nope`, statement: "s", evidenceRef: "d", reviewDate: inDays(30) })).statusCode).toBe(404);
  });

  it("refuses an attestation with no named person behind it (the bootstrap token), audited, and writes nothing", async () => {
    const before = await db.select().from(compliancePackAttestations).where(eq(compliancePackAttestations.packId, packId));
    const res = await attest({ controlRef: ATTESTED, statement: `nobody ${RUN}`, evidenceRef: `doc-${RUN}`, reviewDate: inDays(90) }, ADMIN);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error).toBe("attestation_needs_a_person");
    const after = await db.select().from(compliancePackAttestations).where(eq(compliancePackAttestations.packId, packId));
    expect(after).toHaveLength(before.length);
    const [refusal] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, DEPLOYER_REGISTER_RULE_IDS.attestRefused), sql`${auditLog.detail} ->> 'error' = 'attestation_needs_a_person'`))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect(refusal).toMatchObject({ effect: "deny" });
  });

  it("records who and when, moves the item to attested, and shows it in the register", async () => {
    const before = item(await get(), ATTESTED).state;
    const res = await attest({ controlRef: ATTESTED, statement: `DPIA done ${RUN}`, evidenceRef: `dpia-${RUN}`, reviewDate: inDays(180) });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().item).toMatchObject({ basis: "attested", state: "attested", previousState: before });
    const reg = await get();
    const att = item(reg, ATTESTED);
    expect(att.state).toBe("attested");
    expect(att.attestation).toMatchObject({ statement: `DPIA done ${RUN}`, evidenceRef: `dpia-${RUN}` });
    expect(res.json().attestation.attestedBy).toBe(attesterId);
    expect(att.attestation.attestedBy).toBe(attesterId);
    expect(att.attestation.attestedAt).toBeTruthy();
    expect(att.attestation.reviewDate).toBeTruthy();
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "compliance-pack-attestation-recorded"), sql`${auditLog.detail} ->> 'controlRef' = ${ATTESTED}`))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect(audit?.detail).toMatchObject({ register: "eu-ai-act-deployer", transition: { from: before, event: "attest", to: "attested" } });
    expect(audit?.userId).toBe(attesterId);
  });

  it("a passed review date makes the item review_due, and attesting again returns it to attested", async () => {
    const [latest] = await db
      .select()
      .from(compliancePackAttestations)
      .where(and(eq(compliancePackAttestations.packId, packId), eq(compliancePackAttestations.controlRef, ATTESTED)))
      .orderBy(desc(compliancePackAttestations.attestedAt))
      .limit(1);
    // the clock, simulated: the review date of the newest attestation has passed
    await db.update(compliancePackAttestations).set({ validUntil: sql`now() - interval '1 day'` }).where(eq(compliancePackAttestations.id, latest!.id));
    expect(item(await get(), ATTESTED).state).toBe("review_due");
    const res = await attest({ controlRef: ATTESTED, statement: `reviewed ${RUN}`, evidenceRef: `dpia-${RUN}-v2`, reviewDate: inDays(365) });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().item).toMatchObject({ previousState: "review_due", state: "attested" });
  });
});
