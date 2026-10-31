/**
 * ADR-0208 G8 — edit and retire infrastructure resources and policies, on a real database:
 *
 *  - create, edit and retire are each audited in the same transaction (rule ids infra-resource-created/-updated/
 *    -retired, infra-policy-created/-updated/-retired), detail carrying before/after, and for retire the reason
 *    (and, for a policy, the fleet fallback);
 *  - an edit that LOOSENS (drops a classification, slower patch cadence, a higher auto-remediate ceiling, shorter
 *    retention, a smaller cert-rotation lead) asks for a settings_relax step-up bound to the object and the new
 *    values; a tightening edit does not; retire ALWAYS asks;
 *  - a resource cannot be retired while remediations wait for approval or are approved but not applied (409 listing
 *    the finding ids, asked before any step-up);
 *  - the fleet policy is edited, never retired (409); one ACTIVE policy per resource and one active fleet policy,
 *    refused by name in the API and by the partial unique indexes in the database;
 *  - a retired row stays readable, refuses edits, and is excluded from scans, effective-policy resolution and new
 *    work (scan, remediation proposals, new policies);
 *  - admin only; bounded validation.
 *
 * Global state (M-068): the org settings it changes are put back; its resources and policies (including the fleet
 * policy it may create) and the admin's passkey, sessions and step-up grants are removed in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  authSessions,
  createDb,
  desc,
  eq,
  inArray,
  infraFindings,
  infraPolicies,
  infraResources,
  isNull,
  ORG_SETTINGS_ID,
  orgSettings,
  runMigrations,
  sql,
  stepUpGrants,
  webauthnChallenges,
  webauthnCredentials,
  type Db,
} from "@regulait/db";
import { STEP_UP_HEADER } from "@regulait/shared";
import { buildApp } from "./app.js";
import { SoftAuthenticator } from "./webauthn-soft-authenticator.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { forgetStepUpMethodsForTest } from "./testing/step-up-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
const P = `g8-${RUN}`;
const BOOT = `g8-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ORIGIN = "http://localhost";
const CSRF = { "x-regulait-csrf": "1" };
const DATA_KEY = randomBytes(32).toString("hex");
const REASON = "Moved to the new region; monitoring continues there";
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;
process.env.REGULAIT_PUBLIC_URL = ORIGIN;

let db: Db;
let app: ReturnType<typeof buildApp>;
let admin: { id: string; session: string; auth: SoftAuthenticator };
let memberKey: { authorization: string };
let prevStepUp: { mode: unknown; actions: unknown } | null = null;
let createdFleetId: string | null = null;
let fleetId: string;
const restores: Array<() => Promise<void>> = [];
const sessions: string[] = [];

type Method = "GET" | "POST" | "PATCH";
const asAdmin = (method: Method, url: string, payload?: Record<string, unknown>, extra: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...CSRF, ...extra }, cookies: { regulait_session: admin.session }, ...(payload ? { payload } : {}) });

async function grantFor(action: { kind: string; body: Record<string, unknown> }): Promise<string> {
  const o = await asAdmin("POST", "/v1/auth/step-up/options", { action });
  expect(o.statusCode, o.body).toBe(200);
  const v = await asAdmin("POST", "/v1/auth/step-up/verify", {
    stepUpId: o.json().stepUpId,
    method: "passkey",
    response: admin.auth.authenticate(o.json().passkey.options),
  });
  expect(v.statusCode, v.body).toBe(200);
  return v.json().stepUpToken as string;
}

/** a write that is refused for a settings_relax step-up bound to `facts`, then done with that grant */
async function throughStepUp(method: Method, url: string, payload: Record<string, unknown>, facts: Record<string, unknown>) {
  const asked = await asAdmin(method, url, payload);
  expect(asked.statusCode, asked.body).toBe(403);
  expect(asked.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
  expect(asked.json().action).toEqual({ kind: "settings_relax", body: facts });
  const token = await grantFor(asked.json().action);
  return asAdmin(method, url, payload, { [STEP_UP_HEADER]: token });
}

const lastAudit = async (ruleId: string, objectId: string) =>
  (
    await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, ruleId), eq(auditLog.objectId, objectId)))
      .orderBy(desc(auditLog.seq))
      .limit(1)
  )[0];

async function createResource(name: string, extra: Record<string, unknown> = {}) {
  const r = await app.inject({ method: "POST", url: "/v1/infra/resources", headers: AUTH, payload: { name: `${P}-${name}`, kind: "agent_runtime", provider: "mock", ...extra } });
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as { id: string; name: string };
}
async function createPolicy(payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/v1/infra/policies", headers: AUTH, payload });
}
async function insertFinding(resourceId: string, status: "open" | "remediation_proposed" | "approved" | "remediated", sig: string) {
  const [f] = await db
    .insert(infraFindings)
    .values({ resourceId, kind: "drift", severity: "medium", detail: { signature: `${P}-${sig}`, summary: "drift" }, status })
    .returning({ id: infraFindings.id });
  return f!.id;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxStrictAdmissionForTest(db));
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  const [os] = await db
    .select({ mode: orgSettings.stepUpMode, actions: orgSettings.stepUpActions })
    .from(orgSettings)
    .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  prevStepUp = os ? { mode: os.mode, actions: os.actions } : null;
  await db.execute(sql`UPDATE org_settings SET step_up_mode = 'required',
    step_up_actions = '["approval_decide", "settings_relax", "evidence_hold_override", "break_glass", "passkey_manage", "owner_change", "identity_manage", "pseudonym_reveal", "key_management"]'::jsonb
    WHERE id = ${ORG_SETTINGS_ID}`);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  await app.ready();
  const inject = (url: string, payload: unknown) => app.inject({ method: "POST", url, headers: AUTH, payload: payload as object });
  const adm = await inject("/v1/users", { email: `${P}-admin@example.com`, displayName: `${P} admin`, isAdmin: true });
  expect(adm.statusCode, adm.body).toBe(201);
  const adminId = adm.json().id as string;
  const mem = await inject("/v1/users", { email: `${P}-member@example.com`, displayName: `${P} member` });
  expect(mem.statusCode, mem.body).toBe(201);
  memberKey = { authorization: `Bearer ${(await inject(`/v1/users/${mem.json().id}/keys`, { name: "g8" })).json().token}` };

  const token = "rgls_" + randomBytes(32).toString("hex");
  const [sess] = await db
    .insert(authSessions)
    .values({
      tokenHash: createHash("sha256").update(token).digest("hex"),
      userId: adminId,
      origin: "password",
      expiresAt: new Date(Date.now() + 3_600_000),
      idleExpiresAt: new Date(Date.now() + 3_600_000),
      idleMinutes: 60,
    })
    .returning({ id: authSessions.id });
  sessions.push(sess!.id);
  admin = { id: adminId, session: token, auth: new SoftAuthenticator({ origin: ORIGIN }) };
  const opt = await asAdmin("POST", "/v1/auth/passkeys/registration-options", {});
  expect(opt.statusCode, opt.body).toBe(200);
  const reg = await asAdmin("POST", "/v1/auth/passkeys", { challengeId: opt.json().challengeId, response: admin.auth.register(opt.json().options), label: "g8" });
  expect(reg.statusCode, reg.body).toBe(201);

  // the fleet policy: reuse an active one if this shared database already has it, else create one (removed after)
  const [fleet] = await db.select().from(infraPolicies).where(and(isNull(infraPolicies.resourceId), eq(infraPolicies.status, "active")));
  if (fleet) fleetId = fleet.id;
  else {
    const f = await createPolicy({ patchCadenceDays: 60 });
    expect(f.statusCode, f.body).toBe(201);
    fleetId = createdFleetId = f.json().id;
  }
}, 120_000);

afterAll(async () => {
  try {
    if (admin) {
      await db.delete(stepUpGrants).where(eq(stepUpGrants.userId, admin.id));
      await db.delete(webauthnChallenges).where(eq(webauthnChallenges.userId, admin.id));
      await forgetStepUpMethodsForTest(db, [admin.id]);
      await db.delete(webauthnCredentials).where(eq(webauthnCredentials.userId, admin.id));
    }
    if (sessions.length > 0) await db.delete(authSessions).where(inArray(authSessions.id, sessions));
  } finally {
    try {
      // this suite's resources (their findings and policies cascade) and the fleet policy it created
      await db.delete(infraResources).where(sql`${infraResources.name} LIKE ${`${P}-%`}`);
      if (createdFleetId) await db.delete(infraPolicies).where(eq(infraPolicies.id, createdFleetId));
      if (prevStepUp) {
        await db.execute(sql`UPDATE org_settings SET step_up_mode = ${prevStepUp.mode as string},
          step_up_actions = ${JSON.stringify(prevStepUp.actions)}::jsonb WHERE id = ${ORG_SETTINGS_ID}`);
      }
      for (const r of restores.reverse()) await r();
    } finally {
      if (prevPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
      else process.env.REGULAIT_PUBLIC_URL = prevPublicUrl;
      app?.server.closeAllConnections();
      await app?.close();
    }
  }
});

describe("ADR-0208 G8 — create is audited, one active policy per scope", () => {
  it("a resource and its policy are each audited on creation", async () => {
    const r = await createResource("created", { classifications: ["hipaa"] });
    const a = await lastAudit("infra-resource-created", r.id);
    expect(a).toBeDefined();
    expect(a!.detail).toMatchObject({ phase: "resource-created", after: { name: r.name, classifications: ["hipaa"], status: "active" } });
    const p = await createPolicy({ resourceId: r.id, patchCadenceDays: 14 });
    expect(p.statusCode, p.body).toBe(201);
    expect(p.json().status).toBe("active");
    const pa = await lastAudit("infra-policy-created", p.json().id);
    expect(pa!.detail).toMatchObject({ phase: "policy-created", resourceId: r.id, after: { patchCadenceDays: 14 } });
  });

  it("a second active policy for one resource, or a second fleet policy, is refused by name and by the database", async () => {
    const r = await createResource("dup");
    const first = await createPolicy({ resourceId: r.id, patchCadenceDays: 14 });
    expect(first.statusCode).toBe(201);
    const second = await createPolicy({ resourceId: r.id, patchCadenceDays: 7 });
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json()).toMatchObject({ error: "infra_policy_already_active", resourceId: r.id, existingPolicyId: first.json().id });
    const fleet2 = await createPolicy({ patchCadenceDays: 7 });
    expect(fleet2.statusCode, fleet2.body).toBe(409);
    expect(fleet2.json()).toMatchObject({ error: "infra_policy_already_active", resourceId: null, existingPolicyId: fleetId });
    // the indexes hold underneath the API
    await expect(db.insert(infraPolicies).values({ resourceId: r.id, patchCadenceDays: 1 })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: "23505", constraint: "infra_policies_active_resource_uq" }),
    });
    await expect(db.insert(infraPolicies).values({ resourceId: null, patchCadenceDays: 1 })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: "23505", constraint: "infra_policies_active_fleet_uq" }),
    });
  });

  it("the database refuses a retired row without its reason, and an unknown status", async () => {
    const r = await createResource("shape");
    await expect(db.execute(sql`UPDATE infra_resources SET status = 'retired', retired_at = now() WHERE id = ${r.id}`)).rejects.toBeTruthy();
    await expect(db.execute(sql`UPDATE infra_resources SET status = 'gone' WHERE id = ${r.id}`)).rejects.toBeTruthy();
  });
});

describe("ADR-0208 G8 — editing a resource", () => {
  it("a rename or an added classification needs no step-up and is audited with before/after", async () => {
    const r = await createResource("edit", { classifications: ["hipaa"] });
    const res = await asAdmin("PATCH", `/v1/infra/resources/${r.id}`, { name: `${P}-edit-renamed`, classifications: ["hipaa", "pci-dss"] });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().resource).toMatchObject({ name: `${P}-edit-renamed`, classifications: ["hipaa", "pci-dss"] });
    const a = await lastAudit("infra-resource-updated", r.id);
    expect(a!.detail).toMatchObject({
      before: { name: r.name, classifications: ["hipaa"] },
      after: { name: `${P}-edit-renamed`, classifications: ["hipaa", "pci-dss"] },
      droppedClassifications: [],
    });
  });

  it("dropping a classification asks for a step-up bound to the resource and its new tags", async () => {
    const r = await createResource("drop", { classifications: ["hipaa", "pci-dss"] });
    const done = await throughStepUp("PATCH", `/v1/infra/resources/${r.id}`, { classifications: ["pci-dss"] }, {
      values: { infraResourceClassifications: { resourceId: r.id, classifications: ["pci-dss"] } },
    });
    expect(done.statusCode, done.body).toBe(200);
    const a = await lastAudit("infra-resource-updated", r.id);
    expect(a!.detail).toMatchObject({ droppedClassifications: ["hipaa"] });
  });

  it("a name another resource holds is a named 409", async () => {
    const a = await createResource("name-a");
    const b = await createResource("name-b");
    const res = await asAdmin("PATCH", `/v1/infra/resources/${b.id}`, { name: a.name });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toBe("infra_resource_name_taken");
  });
});

describe("ADR-0208 G8 — editing a policy", () => {
  it("tightening needs no step-up; it is audited with before/after", async () => {
    const r = await createResource("tighten");
    const p = (await createPolicy({ resourceId: r.id, patchCadenceDays: 30, autoRemediateMaxSeverity: "medium", backupRetentionDays: 30, certRotationDaysBeforeExpiry: 14 })).json();
    const res = await asAdmin("PATCH", `/v1/infra/policies/${p.id}`, {
      patchCadenceDays: 7,
      autoRemediateMaxSeverity: null,
      backupRetentionDays: 90,
      certRotationDaysBeforeExpiry: 30,
      backupSchedule: "hourly",
    });
    expect(res.statusCode, res.body).toBe(200);
    const a = await lastAudit("infra-policy-updated", p.id);
    expect(a!.detail).toMatchObject({
      loosened: [],
      before: { patchCadenceDays: 30, autoRemediateMaxSeverity: "medium" },
      after: { patchCadenceDays: 7, autoRemediateMaxSeverity: null, backupRetentionDays: 90, backupSchedule: "hourly" },
    });
  });

  const BASE = { patchCadenceDays: 30, backupRetentionDays: 30, certRotationDaysBeforeExpiry: 14, autoRemediateMaxSeverity: "medium" };
  it.each([
    ["a higher auto-remediate ceiling", BASE, { autoRemediateMaxSeverity: "high" }],
    ["setting a ceiling where there was none", { ...BASE, autoRemediateMaxSeverity: null }, { autoRemediateMaxSeverity: "low" }],
    ["a slower patch cadence", BASE, { patchCadenceDays: 90 }],
    ["clearing the patch cadence", BASE, { patchCadenceDays: null }],
    ["a shorter backup retention", BASE, { backupRetentionDays: 7 }],
    ["clearing the backup retention", BASE, { backupRetentionDays: null }],
    ["a smaller cert-rotation lead", BASE, { certRotationDaysBeforeExpiry: 3 }],
  ])("%s asks for a step-up bound to the policy and the loosened values", async (_label, base, edit) => {
    const r = await createResource(`loosen-${randomBytes(2).toString("hex")}`);
    const p = (await createPolicy({ resourceId: r.id, ...base })).json();
    // a field with no order (the backup schedule) rides along without joining the step-up's facts
    const done = await throughStepUp("PATCH", `/v1/infra/policies/${p.id}`, { ...edit, backupSchedule: "hourly" }, {
      values: { infraPolicy: { policyId: p.id, ...edit } },
    });
    expect(done.statusCode, done.body).toBe(200);
    const a = await lastAudit("infra-policy-updated", p.id);
    expect((a!.detail as { loosened: string[] }).loosened).toEqual(Object.keys(edit));
  });

  it("a step-up grant for one policy's values does not loosen another", async () => {
    const r1 = await createResource("grant-a");
    const r2 = await createResource("grant-b");
    const p1 = (await createPolicy({ resourceId: r1.id, ...BASE })).json();
    const p2 = (await createPolicy({ resourceId: r2.id, ...BASE })).json();
    const asked = await asAdmin("PATCH", `/v1/infra/policies/${p1.id}`, { autoRemediateMaxSeverity: "high" });
    expect(asked.statusCode).toBe(403);
    const token = await grantFor(asked.json().action);
    const wrong = await asAdmin("PATCH", `/v1/infra/policies/${p2.id}`, { autoRemediateMaxSeverity: "high" }, { [STEP_UP_HEADER]: token });
    expect(wrong.statusCode, wrong.body).toBe(403);
    const [still] = await db.select().from(infraPolicies).where(eq(infraPolicies.id, p2.id));
    expect(still!.autoRemediateMaxSeverity).toBe("medium");
  });

  it("the fleet policy can be edited", async () => {
    const [before] = await db.select().from(infraPolicies).where(eq(infraPolicies.id, fleetId));
    const res = await asAdmin("PATCH", `/v1/infra/policies/${fleetId}`, { backupSchedule: before!.backupSchedule ?? "daily-0200" });
    expect(res.statusCode, res.body).toBe(200);
  });
});

describe("ADR-0208 G8 — retiring a resource", () => {
  it("is refused while a remediation waits for approval or is approved but not applied, before any step-up", async () => {
    const r = await createResource("pending");
    const proposed = await insertFinding(r.id, "remediation_proposed", "p1");
    const approved = await insertFinding(r.id, "approved", "p2");
    await insertFinding(r.id, "remediated", "p3");
    const res = await asAdmin("POST", `/v1/infra/resources/${r.id}/retire`, { reason: REASON });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ error: "infra_resource_remediations_pending", pendingRemediations: 2 });
    expect([...res.json().findingIds].sort()).toEqual([proposed, approved].sort());
    const [still] = await db.select().from(infraResources).where(eq(infraResources.id, r.id));
    expect(still!.status).toBe("active");
  });

  it("asks for a step-up, retires it with its policy, audits both with the reason, and keeps history readable", async () => {
    const r = await createResource("retire");
    const p = (await createPolicy({ resourceId: r.id, patchCadenceDays: 14 })).json();
    const openFinding = await insertFinding(r.id, "open", "o1");
    const done = await throughStepUp("POST", `/v1/infra/resources/${r.id}/retire`, { reason: REASON }, {
      values: { infraResourceRetire: { resourceId: r.id } },
    });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().resource).toMatchObject({ status: "retired", retiredReason: REASON, retiredByUserId: admin.id });
    expect(done.json().resource.retiredAt).toBeTruthy();
    expect(done.json().policiesRetired).toEqual([p.id]);
    const a = await lastAudit("infra-resource-retired", r.id);
    expect(a!.userId).toBe(admin.id);
    expect(a!.reason).toBe(REASON);
    expect(a!.detail).toMatchObject({ before: { status: "active" }, after: { status: "retired" }, reason: REASON, policiesRetired: [p.id] });
    const pa = await lastAudit("infra-policy-retired", p.id);
    expect(pa!.detail).toMatchObject({ cause: "resource-retired", reason: REASON });

    // readable
    const list = await asAdmin("GET", "/v1/infra/resources");
    expect(list.json().resources.find((x: { id: string }) => x.id === r.id)).toMatchObject({ status: "retired" });
    const findings = await asAdmin("GET", "/v1/infra/findings");
    expect(findings.json().findings.some((f: { id: string }) => f.id === openFinding)).toBe(true);

    // read-only
    const edit = await asAdmin("PATCH", `/v1/infra/resources/${r.id}`, { name: `${P}-zombie` });
    expect(edit.statusCode).toBe(409);
    expect(edit.json()).toMatchObject({ error: "infra_resource_retired", resourceId: r.id });
    const again = await asAdmin("POST", `/v1/infra/resources/${r.id}/retire`, { reason: REASON });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("infra_resource_retired");
    const editPolicy = await asAdmin("PATCH", `/v1/infra/policies/${p.id}`, { patchCadenceDays: 7 });
    expect(editPolicy.statusCode).toBe(409);
    expect(editPolicy.json().error).toBe("infra_policy_retired");

    // no new work starts on it
    const scanOne = await app.inject({ method: "POST", url: "/v1/infra/scan", headers: AUTH, payload: { resourceId: r.id } });
    expect(scanOne.statusCode, scanOne.body).toBe(409);
    expect(scanOne.json().error).toBe("infra_resource_retired");
    const newPolicy = await createPolicy({ resourceId: r.id, patchCadenceDays: 7 });
    expect(newPolicy.statusCode).toBe(409);
    expect(newPolicy.json().error).toBe("infra_resource_retired");
    const remediate = await app.inject({ method: "POST", url: `/v1/infra/findings/${openFinding}/remediate`, headers: AUTH, payload: { approverUserId: admin.id } });
    expect(remediate.statusCode, remediate.body).toBe(409);
    expect(remediate.json().error).toBe("infra_resource_retired");
    const [f] = await db.select().from(infraFindings).where(eq(infraFindings.id, openFinding));
    expect(f!.status).toBe("open");

    // the fleet scan skips it: its old findings are gone and a scan raises none
    await db.delete(infraFindings).where(eq(infraFindings.resourceId, r.id));
    const scanAll = await app.inject({ method: "POST", url: "/v1/infra/scan", headers: AUTH, payload: {} });
    expect(scanAll.statusCode, scanAll.body).toBe(200);
    expect(await db.select().from(infraFindings).where(eq(infraFindings.resourceId, r.id))).toHaveLength(0);
  });
});

describe("ADR-0208 G8 — retiring a policy", () => {
  it("the fleet policy is not retirable", async () => {
    const res = await asAdmin("POST", `/v1/infra/policies/${fleetId}/retire`, { reason: REASON });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ error: "infra_fleet_policy_not_retirable", policyId: fleetId });
  });

  it("asks for a step-up, returns and audits the fleet fallback, and the resource falls back to it", async () => {
    const r = await createResource("fallback");
    const p = (await createPolicy({ resourceId: r.id, patchCadenceDays: 3, autoRemediateMaxSeverity: "low" })).json();
    const before = (await asAdmin("GET", "/v1/infra/resources")).json().resources.find((x: { id: string }) => x.id === r.id);
    expect(before.effectivePolicy.policyId).toBe(p.id);
    const done = await throughStepUp("POST", `/v1/infra/policies/${p.id}/retire`, { reason: REASON }, {
      values: { infraPolicyRetire: { policyId: p.id } },
    });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().policy).toMatchObject({ status: "retired", retiredReason: REASON });
    expect(done.json().fallback).toMatchObject({ policyId: fleetId, resourceId: null, status: "active" });
    const a = await lastAudit("infra-policy-retired", p.id);
    expect(a!.reason).toBe(REASON);
    expect(a!.detail).toMatchObject({ reason: REASON, fallback: { policyId: fleetId }, before: { patchCadenceDays: 3 } });
    const after = (await asAdmin("GET", "/v1/infra/resources")).json().resources.find((x: { id: string }) => x.id === r.id);
    expect(after.effectivePolicy.policyId).toBe(fleetId);
    // listed (readable), read-only, and a new active policy may now be created for the resource
    const listed = (await asAdmin("GET", "/v1/infra/policies")).json().policies.find((x: { id: string }) => x.id === p.id);
    expect(listed).toMatchObject({ status: "retired" });
    const again = await asAdmin("POST", `/v1/infra/policies/${p.id}/retire`, { reason: REASON });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("infra_policy_retired");
    expect((await createPolicy({ resourceId: r.id, patchCadenceDays: 7 })).statusCode).toBe(201);
  });
});

describe("ADR-0208 G8 — admin only, bounded input", () => {
  it("a non-admin is refused on every edit and retire route", async () => {
    const r = await createResource("member");
    const p = (await createPolicy({ resourceId: r.id, patchCadenceDays: 14 })).json();
    const calls: Array<[Method, string, Record<string, unknown>]> = [
      ["PATCH", `/v1/infra/resources/${r.id}`, { name: `${P}-x` }],
      ["POST", `/v1/infra/resources/${r.id}/retire`, { reason: REASON }],
      ["PATCH", `/v1/infra/policies/${p.id}`, { patchCadenceDays: 7 }],
      ["POST", `/v1/infra/policies/${p.id}/retire`, { reason: REASON }],
    ];
    for (const [method, url, payload] of calls) {
      const res = await app.inject({ method, url, headers: memberKey, payload });
      expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(403);
    }
    const [still] = await db.select().from(infraResources).where(eq(infraResources.id, r.id));
    expect(still).toMatchObject({ name: r.name, status: "active" });
  });

  it("validation: bounds, unknown fields, empty edits, short reasons, unknown ids", async () => {
    const r = await createResource("valid");
    const p = (await createPolicy({ resourceId: r.id, patchCadenceDays: 14 })).json();
    const bad: Array<[Method, string, Record<string, unknown>, number]> = [
      ["PATCH", `/v1/infra/resources/${r.id}`, {}, 400],
      ["PATCH", `/v1/infra/resources/${r.id}`, { name: "x".repeat(201) }, 400],
      ["PATCH", `/v1/infra/resources/${r.id}`, { kind: "cert" }, 400],
      ["PATCH", `/v1/infra/resources/${r.id}`, { classifications: Array.from({ length: 17 }, (_, i) => `t${i}`) }, 400],
      ["PATCH", `/v1/infra/policies/${p.id}`, { patchCadenceDays: 0 }, 400],
      ["PATCH", `/v1/infra/policies/${p.id}`, { patchCadenceDays: 3651 }, 400],
      ["PATCH", `/v1/infra/policies/${p.id}`, { autoRemediateMaxSeverity: "critical" }, 400],
      ["PATCH", `/v1/infra/policies/${p.id}`, { resourceId: null }, 400],
      ["POST", `/v1/infra/resources/${r.id}/retire`, { reason: "too short" }, 400],
      ["POST", `/v1/infra/policies/${p.id}/retire`, { reason: "x".repeat(2001) }, 400],
      ["POST", `/v1/infra/policies/${p.id}/retire`, {}, 400],
      ["PATCH", `/v1/infra/resources/not-a-uuid`, { name: "x" }, 400],
      ["PATCH", `/v1/infra/resources/00000000-0000-4000-8000-000000000000`, { name: "x" }, 404],
      ["POST", `/v1/infra/policies/00000000-0000-4000-8000-000000000000/retire`, { reason: REASON }, 404],
    ];
    for (const [method, url, payload, status] of bad) {
      const res = await asAdmin(method, url, payload);
      expect(res.statusCode, `${method} ${url} ${JSON.stringify(payload).slice(0, 80)}: ${res.body}`).toBe(status);
    }
  });
});
