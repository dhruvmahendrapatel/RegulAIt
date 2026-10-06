import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, auditLog, certInventory, createDb, eq, runMigrations, type Db } from "@regulait/db";
import { resolveInfraProvider, InfraProviderError, type MockInfraProvider } from "@regulait/infra-provider";
import { buildApp } from "./app.js";

/**
 * O6 (ADR-0027) — the cert-rotation LIFECYCLE:
 *   active → rotation_proposed → (approve) → rotated
 *                              → (deny)    → rotation_denied  (re-proposable)
 *                              → (failure) → rotation_failed  (re-proposable)
 * One cert_rotations ledger row PER ATTEMPT, created at propose and advanced
 * to its terminal state with the denial/failure reason recorded; every
 * transition audited; state-machine guards refuse stale decisions. Shares one
 * DB (fileParallelism off); prefix o6-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);
const BOOT = "o6-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminAuth: { authorization: string };
let approverId: string;
let approverAuth: { authorization: string };
let certId: string;

async function post(url: string, payload: unknown, headers = adminAuth) {
  return app.inject({ method: "POST", url, headers, payload: payload as object });
}
async function getJson(url: string, headers = adminAuth) {
  return (await app.inject({ method: "GET", url, headers })).json();
}
async function decide(approvalId: string, decision: "approved" | "denied", reason?: string) {
  return app.inject({
    method: "POST", url: `/v1/approvals/${approvalId}/decide`, headers: approverAuth,
    payload: { decision, ...(reason ? { reason } : {}) },
  });
}
async function cert() {
  const certs = (await getJson("/v1/infra/certs")).certs;
  return certs.find((c: { id: string }) => c.id === certId);
}
async function rotations() {
  return (await getJson(`/v1/infra/certs/${certId}/rotations`)).rotations as Array<{
    status: string; reason: string | null; newSerial: string | null; createdAt: string;
  }>;
}
async function propose() {
  const r = await post(`/v1/infra/certs/${certId}/rotate`, { approverUserId: approverId });
  expect(r.statusCode).toBe(202);
  return r.json().approvalId as string;
}

let restoreAdminKeyMfa: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // ADR-0181 (FX2): an admin's API key now answers to mfaRequired. This suite
  // drives admins through keys and is not about MFA, so it relaxes the dial
  // explicitly and hands the shared database back strict in afterAll (M-068).
  restoreAdminKeyMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT });
  const mkUser = async (email: string, isAdmin: boolean) => {
    const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email, displayName: email.split("@")[0], isAdmin } });
    const k = await app.inject({ method: "POST", url: `/v1/users/${u.json().id}/keys`, headers: AUTH, payload: { name: "o6" } });
    return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
  };
  const admin = await mkUser("o6-admin@example.com", true);
  adminAuth = admin.auth;
  const approver = await mkUser("o6-approver@example.com", false);
  approverId = approver.id;
  approverAuth = approver.auth;
  await post("/v1/infra/resources", { name: "o6-cert", kind: "cert", config: { daysUntilExpiry: 7 } });
  await post("/v1/infra/scan", {});
  certId = (await getJson("/v1/infra/certs")).certs.find(
    (c: { resourceName: string }) => c.resourceName === "o6-cert",
  ).id;
});

describe("denied → rotation_denied with a recorded reason, then re-proposable to rotated", () => {
  it("walks active → proposed → denied (reasoned marker) → re-proposed → rotated, one ledger row per attempt", async () => {
    // attempt 1: propose creates the attempt's 'proposed' ledger row
    const approval1 = await propose();
    expect((await cert()).status).toBe("rotation_proposed");
    let rots = await rotations();
    expect(rots).toHaveLength(1);
    expect(rots[0]!.status).toBe("proposed");

    // second propose while one is pending: lifecycle guard 409s
    const dup = await post(`/v1/infra/certs/${certId}/rotate`, { approverUserId: approverId });
    expect(dup.statusCode).toBe(409);

    // deny WITH a reason → rotation_denied + the reason on the attempt row
    const d = await decide(approval1, "denied", "CA maintenance window — retry next week");
    expect(d.statusCode).toBe(200);
    expect((await cert()).status).toBe("rotation_denied");
    rots = await rotations();
    expect(rots).toHaveLength(1);
    expect(rots[0]!.status).toBe("denied");
    expect(rots[0]!.reason).toBe("CA maintenance window — retry next week");
    expect(rots[0]!.newSerial).toBeNull();

    // attempt 2: a denied cert is RE-PROPOSABLE — approve rotates it
    const approval2 = await propose();
    expect((await cert()).status).toBe("rotation_proposed");
    const a = await decide(approval2, "approved");
    expect(a.statusCode).toBe(200);
    const after = await cert();
    expect(after.status).toBe("rotated");
    expect(after.lastRotatedAt).toBeTruthy();
    rots = await rotations();
    expect(rots).toHaveLength(2);
    expect(rots.map((r) => r.status).sort()).toEqual(["denied", "rotated"]);

    // a rotated cert is NOT re-proposable — terminal for this inventory row
    const again = await post(`/v1/infra/certs/${certId}/rotate`, { approverUserId: approverId });
    expect(again.statusCode).toBe(409);
    expect(again.json().detail).toContain("active/rotation_denied/rotation_failed");
  });
});

describe("provider failure → rotation_failed (reasoned, re-proposable), finding re-opened", () => {
  let failCertId: string;

  it("an approved rotation the provider fails lands in rotation_failed — never a pretend success", async () => {
    await post("/v1/infra/resources", { name: "o6-fail-cert", kind: "cert", config: { daysUntilExpiry: 3 } });
    await post("/v1/infra/scan", {});
    failCertId = (await getJson("/v1/infra/certs")).certs.find(
      (c: { resourceName: string }) => c.resourceName === "o6-fail-cert",
    ).id;
    const r = await post(`/v1/infra/certs/${failCertId}/rotate`, { approverUserId: approverId });
    expect(r.statusCode).toBe(202);

    // force the shared mock provider to fail this remediation
    const mock = resolveInfraProvider({ kind: "mock" }) as MockInfraProvider;
    const original = mock.remediate.bind(mock);
    (mock as { remediate: unknown }).remediate = async () => {
      throw new InfraProviderError("simulated CA outage");
    };
    try {
      const d = await decide(r.json().approvalId, "approved");
      expect(d.statusCode).toBe(200); // the decide itself succeeds — the failure is recorded, not thrown
    } finally {
      (mock as { remediate: unknown }).remediate = original;
    }

    const certs = (await getJson("/v1/infra/certs")).certs;
    const failed = certs.find((c: { id: string }) => c.id === failCertId);
    expect(failed.status).toBe("rotation_failed");
    const rots = (await getJson(`/v1/infra/certs/${failCertId}/rotations`)).rotations;
    expect(rots).toHaveLength(1);
    expect(rots[0].status).toBe("failed");
    expect(rots[0].reason).toContain("simulated CA outage");

    // the linked finding re-opened (re-proposable), and the failure is audited
    const findings = (await getJson("/v1/infra/findings")).findings;
    const f = findings.find((x: { resourceName: string; kind: string }) => x.resourceName === "o6-fail-cert" && x.kind === "cert_expiring");
    expect(f.status).toBe("open");
    // Scoped to THIS cert: other files (the AER-018 barrier matrix) legitimately
    // write their own infra-cert-rotation-failed rows to the shared database, so
    // "the first such row" was whichever file ran first, not this rotation.
    const audits = (await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, "infra-cert-rotation-failed"))).filter((row) => (row.reason ?? "").includes("o6-fail-cert"));
    expect(audits).toHaveLength(1);
    const audit = audits[0];
    expect(audit).toBeTruthy();
    expect(audit!.reason).toContain("simulated CA outage");

    // and the failed cert IS re-proposable
    const again = await post(`/v1/infra/certs/${failCertId}/rotate`, { approverUserId: approverId });
    expect(again.statusCode).toBe(202);
  });
});

describe("state-machine guard: a stale approval never mutates the lifecycle", () => {
  it("an approval decided after the cert left rotation_proposed is refused and audited", async () => {
    await post("/v1/infra/resources", { name: "o6-stale-cert", kind: "cert", config: { daysUntilExpiry: 9 } });
    await post("/v1/infra/scan", {});
    const staleCertId = (await getJson("/v1/infra/certs")).certs.find(
      (c: { resourceName: string }) => c.resourceName === "o6-stale-cert",
    ).id;
    const r = await post(`/v1/infra/certs/${staleCertId}/rotate`, { approverUserId: approverId });
    const approvalId = r.json().approvalId;
    // the cert leaves rotation_proposed out-of-band (simulated)
    await db.update(certInventory).set({ status: "rotated" }).where(eq(certInventory.id, staleCertId));
    const d = await decide(approvalId, "approved");
    expect(d.statusCode).toBe(200);
    // lifecycle untouched: still exactly one 'proposed' attempt row, no rotation happened
    const rots = (await getJson(`/v1/infra/certs/${staleCertId}/rotations`)).rotations;
    expect(rots).toHaveLength(1);
    expect(rots[0].status).toBe("proposed");
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "infra-action-stale")));
    expect(audit).toBeTruthy();
    expect(audit!.reason).toContain("stale cert_rotate approval ignored");
  });
});

// ADR-0181 (FX2): hand the shared database back strict (M-068)
afterAll(async () => {
  await restoreAdminKeyMfa?.();
});
