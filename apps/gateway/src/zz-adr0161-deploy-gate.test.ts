/**
 * ADR-0161 — `POST /v1/gates/deploy`.
 *
 * Pinned: an approved use case with an available agent is allowed (with the
 * model-card warning while MRM is not enforced); an unapproved use case, an
 * agent outside the approved stack and an open HIGH monitor alert each deny;
 * acknowledging the alert turns the block into a warning; the use case's owner
 * (a pipeline's service account) may ask, a stranger may not; every
 * evaluation is audited with the pipeline's ref. Org-wide MRM enforcement is
 * not toggled here (shared database) — the pure tests cover that branch.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agents, aiUseCases, and, auditLog, createDb, eq, governanceAlerts, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { setAssuranceGateModeForTest } from "./testing/assurance-mode.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
// ADR-0181: the governance gates this suite would trip but does not test, relaxed by name
let restoreSb2Gates: () => Promise<void> = async () => {};

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `g161-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
let db: Db;
let app: ReturnType<typeof buildApp>;
const users = {} as Record<"admin" | "owner" | "stranger", { id: string; auth: { authorization: string } }>;
let agentA = "";
let agentB = "";
let approvedUc = "";
let reviewUc = "";

const call = (url: string, headers: Record<string, string>, payload: unknown) =>
  app.inject({ method: "POST", url, headers, payload: payload as object });

let restoreAdminKeyMfa: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // ADR-0181 (FX2): an admin's API key now answers to mfaRequired. This suite
  // drives admins through keys and is not about MFA, so it relaxes the dial
  // explicitly and hands the shared database back strict in afterAll (M-068).
  restoreAdminKeyMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT });
  restoreSb2Gates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false });
  for (const [k, isAdmin] of [["admin", true], ["owner", false], ["stranger", false]] as const) {
    const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `g161-${k}-${RUN}@example.com`, displayName: k, isAdmin } });
    const id = u.json().id as string;
    const token = (await app.inject({ method: "POST", url: `/v1/users/${id}/keys`, headers: AUTH, payload: { name: "ci" } })).json().token;
    users[k] = { id, auth: { authorization: `Bearer ${token}` } };
  }
  const [a] = await db.insert(agents).values({ name: `g161-a-${RUN}`, provider: "mock", tier: 1, model: "m", ownerUserId: users.owner.id }).returning({ id: agents.id });
  const [b] = await db
    .insert(agents)
    .values({ name: `g161-b-${RUN}`, provider: "mock", tier: 1, model: "m", haltedAt: new Date(), haltedReason: "drill", haltedByUserId: users.admin.id })
    .returning({ id: agents.id });
  agentA = a!.id;
  agentB = b!.id;
  const base = { description: "synthetic", businessContext: "gate test", dataSensitivity: "internal" as const, ownerUserId: users.owner.id };
  const [u1] = await db.insert(aiUseCases).values({ ...base, name: `g161 approved ${RUN}`, status: "approved", intendedAgentIds: [agentA] }).returning({ id: aiUseCases.id });
  const [u2] = await db.insert(aiUseCases).values({ ...base, name: `g161 review ${RUN}`, status: "under_review", intendedAgentIds: [agentA] }).returning({ id: aiUseCases.id });
  approvedUc = u1!.id;
  reviewUc = u2!.id;
}, 120_000);

afterAll(async () => {
  await restoreAdminKeyMfa?.();
  app.server.closeAllConnections();
  await restoreSb2Gates();
  await app.close();
});

describe("ADR-0161 deploy gate", () => {
  it("allows the owner's approved use case, warning on the unapproved model card", async () => {
    const r = await call("/v1/gates/deploy", users.owner.auth, { useCaseId: approvedUc, environment: "staging", ref: `build-${RUN}` });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ decision: "allow", agentsChecked: [agentA], environment: "staging", ref: `build-${RUN}` });
    expect(r.json().reasons.map((x: any) => [x.code, x.severity])).toEqual([["model_card_unapproved", "warn"]]);
  });

  it("denies an unapproved use case and an agent outside the approved stack", async () => {
    const review = await call("/v1/gates/deploy", users.owner.auth, { useCaseId: reviewUc });
    expect(review.json().decision).toBe("deny");
    expect(review.json().reasons[0].code).toBe("use_case_not_approved");
    const extra = await call("/v1/gates/deploy", users.owner.auth, { useCaseId: approvedUc, agentIds: [agentA, agentB] });
    expect(extra.json().decision).toBe("deny");
    expect(extra.json().reasons.some((x: any) => x.code === "agent_not_in_approved_stack" && x.ref.id === agentB)).toBe(true);
  });

  it("an open high alert on the use case blocks; acknowledging it leaves a warning", async () => {
    const [alert] = await db
      .insert(governanceAlerts)
      .values({ ruleId: "use_case_inherited_high_risk", subjectKey: `use_case:${approvedUc}`, severity: "high", title: `g161 high ${RUN}` })
      .returning({ id: governanceAlerts.id });
    const blocked = await call("/v1/gates/deploy", users.owner.auth, { useCaseId: approvedUc });
    expect(blocked.json().decision).toBe("deny");
    expect(blocked.json().reasons[0]).toMatchObject({ code: "open_high_alert", severity: "block", ref: { type: "alert", id: alert!.id } });

    const ack = await call(`/v1/governance/alerts/${alert!.id}/acknowledge`, users.admin.auth, { note: "vendor re-assessment booked" });
    expect(ack.statusCode, ack.body).toBe(200);
    const allowed = await call("/v1/gates/deploy", users.owner.auth, { useCaseId: approvedUc });
    expect(allowed.json().decision).toBe("allow");
    expect(allowed.json().reasons.some((x: any) => x.code === "acknowledged_high_alert")).toBe(true);
    await db.update(governanceAlerts).set({ status: "resolved", resolvedAt: new Date() }).where(eq(governanceAlerts.id, alert!.id));
  });

  it("refuses a stranger, 404s an unknown use case, and audits every evaluation", async () => {
    expect((await call("/v1/gates/deploy", users.stranger.auth, { useCaseId: approvedUc })).statusCode).toBe(403);
    expect((await call("/v1/gates/deploy", users.admin.auth, { useCaseId: "00000000-0000-4000-8000-000000000000" })).statusCode).toBe(404);
    expect((await call("/v1/gates/deploy", users.owner.auth, { useCaseId: approvedUc, bogus: 1 })).statusCode).toBe(400);
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectType, "deploy_gate"), eq(auditLog.objectId, approvedUc)));
    expect(rows.some((r) => (r.detail as any).ref === `build-${RUN}` && r.ruleId === "deploy-gate-allowed")).toBe(true);
    expect(rows.some((r) => r.ruleId === "deploy-gate-denied")).toBe(true);
  });
});

// ADR-0180: this file pins the gate rules above; the continuous-assurance checks
// (strict `enforce` by default) are pinned in zz-adr0180-a3-required-tests.test.ts.
// M-068: the strict default is restored before the file ends.
let restoreAssuranceMode = async (): Promise<void> => {};
beforeAll(async () => {
  restoreAssuranceMode = await setAssuranceGateModeForTest(db, "off");
});
afterAll(async () => {
  await restoreAssuranceMode();
});
