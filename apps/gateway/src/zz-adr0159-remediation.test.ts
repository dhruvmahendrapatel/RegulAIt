/**
 * ADR-0159 — remediation proposals for governance-monitor alerts.
 *
 * Pinned: the planner's executable candidate can be proposed (and only an
 * exact current candidate can); the proposer can neither name nor act as the
 * approver; approval executes the STORED action inside the one decide path and
 * the alert resolves on the post-commit monitor pass; denial changes nothing;
 * a duplicate pending proposal is refused. Assertions are scoped to records
 * this file creates (M-008) — the database is shared.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agents, aiRiskControls, aiRisks, aiUseCases, and, compliancePacks, createDb, eq, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `g159-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const CONTROL = "eu-ai-act:art-15-accuracy-robustness";

let db: Db;
let app: ReturnType<typeof buildApp>;
const proposer = { id: "", auth: { authorization: "" } };
const approver = { id: "", auth: { authorization: "" } };
let agentId = "";
let useCaseId = "";
let riskId = "";

const call = (method: "GET" | "POST", url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const admin = async (who: typeof proposer, name: string) => {
  const u = await call("POST", "/v1/users", AUTH, { email: `g159-${name}-${RUN}@example.com`, displayName: name, isAdmin: true });
  who.id = u.json().id;
  who.auth = { authorization: `Bearer ${(await call("POST", `/v1/users/${who.id}/keys`, AUTH, { name: "k" })).json().token}` };
};
const alertFor = async (ruleId: string, keyPart: string) => {
  const r = await call("GET", "/v1/governance/alerts?status=all&limit=500", proposer.auth);
  return (r.json().alerts as Array<{ id: string; ruleId: string; status: string; subject: { key: string } }>).filter(
    (a) => a.ruleId === ruleId && a.subject.key.includes(keyPart),
  );
};

let restoreAdminKeyMfa: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // ADR-0181 (FX2): an admin's API key now answers to mfaRequired. This suite
  // drives admins through keys and is not about MFA, so it relaxes the dial
  // explicitly and hands the shared database back strict in afterAll (M-068).
  restoreAdminKeyMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT });
  await admin(proposer, "proposer");
  await admin(approver, "approver");
  expect([200, 201]).toContain((await call("POST", "/v1/compliance/packs/seed", AUTH, {})).statusCode);
  const active = await db.select().from(compliancePacks).where(and(eq(compliancePacks.framework, "eu-ai-act"), eq(compliancePacks.status, "active")));
  if (active.length === 0) {
    const [v1] = await db.select().from(compliancePacks).where(and(eq(compliancePacks.framework, "eu-ai-act"), eq(compliancePacks.version, 1)));
    await db.update(compliancePacks).set({ status: "active" }).where(eq(compliancePacks.id, v1!.id));
  }

  const [a] = await db.insert(agents).values({ name: `g159-agent-${RUN}`, provider: "mock", tier: 1, model: `g159-${RUN}` }).returning({ id: agents.id });
  agentId = a!.id;
  const [uc] = await db
    .insert(aiUseCases)
    .values({
      name: `g159-use-case-${RUN}`, description: "synthetic", businessContext: "remediation test",
      dataSensitivity: "internal", ownerUserId: proposer.id, intendedAgentIds: [agentId], status: "approved",
    })
    .returning({ id: aiUseCases.id });
  useCaseId = uc!.id;
  const [r] = await db
    .insert(aiRisks)
    .values({ title: `g159 risk ${RUN}`, description: "synthetic", category: "prompt_injection", ownerUserId: proposer.id, useCaseId, likelihood: "high", impact: "high" })
    .returning({ id: aiRisks.id });
  riskId = r!.id;
  expect((await call("POST", "/v1/governance/monitor/evaluate", proposer.auth)).statusCode).toBe(200);
}, 120_000);

afterAll(async () => {
  await restoreAdminKeyMfa?.();
  app.server.closeAllConnections();
  await app.close();
});

describe("ADR-0159 remediation", () => {
  it("plans an executable control link for a high risk with no control, plus nothing invented", async () => {
    const [alert] = await alertFor("high_risk_without_control", riskId);
    expect(alert).toBeDefined();
    const r = await call("GET", `/v1/governance/alerts/${alert!.id}/remediation`, proposer.auth);
    expect(r.statusCode, r.body).toBe(200);
    const link = r.json().candidates.find((c: any) => c.kind === "link_control" && c.params.controlRef === CONTROL);
    expect(link).toMatchObject({ executable: true, params: { riskId, controlRef: CONTROL } });
  });

  it("refuses: self-approver, a tampered action, a guidance kind; then accepts the exact candidate once", async () => {
    const [alert] = await alertFor("high_risk_without_control", riskId);
    const url = `/v1/governance/alerts/${alert!.id}/remediation`;
    const good = { kind: "link_control", params: { riskId, controlRef: CONTROL }, approverUserId: approver.id };
    expect((await call("POST", url, proposer.auth, { ...good, approverUserId: proposer.id })).json().error).toBe("approver_is_proposer");
    expect((await call("POST", url, proposer.auth, { ...good, params: { riskId, controlRef: "soc-2:CC6.1-logical-access" } })).json().error).toBe(
      "not_a_current_candidate",
    );
    expect((await call("POST", url, proposer.auth, { ...good, kind: "assess_vendor" })).json().error).toBe("not_executable");
    expect((await call("POST", url, AUTH, good)).statusCode).toBe(403); // bootstrap: no identity

    const ok = await call("POST", url, proposer.auth, good);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ status: "pending_approval", kind: "link_control" });
    const again = await call("POST", url, proposer.auth, good);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("already_pending");
  });

  it("the proposer cannot decide it; the approver's approval executes it and the alert resolves", async () => {
    const [alert] = await alertFor("high_risk_without_control", riskId);
    const proposal = (await call("GET", `/v1/governance/alerts/${alert!.id}/remediation`, proposer.auth)).json().proposals[0];
    const decide = (who: typeof proposer) =>
      call("POST", `/v1/approvals/${proposal.approvalId}/decide`, who.auth, { decision: "approved", reason: "control fits the mechanism" });

    // the approver's inbox names WHAT will change, never the raw stage sentinel
    const inbox = await call("GET", "/v1/approvals?status=pending", approver.auth);
    const row = inbox.json().approvals.find((a: any) => a.id === proposal.approvalId);
    expect(row).toMatchObject({ objectType: "remediation", objectLabel: proposal.title });

    const own = await decide(proposer);
    expect(own.statusCode).toBe(403);
    expect(own.json().error).toBe("cannot_approve_own_remediation");
    // nothing ran on the refusal
    expect(await db.select().from(aiRiskControls).where(eq(aiRiskControls.riskId, riskId))).toHaveLength(0);

    const res = await decide(approver);
    expect(res.statusCode, res.body).toBe(200);
    const links = await db.select().from(aiRiskControls).where(eq(aiRiskControls.riskId, riskId));
    expect(links.map((l) => l.controlRef)).toEqual([CONTROL]);
    expect(links[0]!.linkedByUserId).toBe(approver.id);

    const after = (await call("GET", `/v1/governance/alerts/${alert!.id}/remediation`, proposer.auth)).json();
    expect(after.proposals[0]).toMatchObject({ status: "applied", decidedByUserId: approver.id });
    expect(after.alert.status).toBe("resolved"); // post-commit monitor pass
    const applied = (await call("GET", "/v1/governance/remediations?status=applied", proposer.auth)).json().proposals;
    expect(applied.some((p: any) => p.id === proposal.id)).toBe(true);
  });

  it("a denied owner assignment changes nothing", async () => {
    const [alert] = await alertFor("use_case_agent_unowned", agentId);
    expect(alert).toBeDefined();
    const url = `/v1/governance/alerts/${alert!.id}/remediation`;
    const cand = (await call("GET", url, proposer.auth)).json().candidates[0];
    expect(cand).toMatchObject({ kind: "assign_agent_owner", executable: true, params: { agentId, ownerUserId: proposer.id } });
    const p = await call("POST", url, proposer.auth, { kind: cand.kind, params: cand.params, approverUserId: approver.id });
    expect(p.statusCode, p.body).toBe(201);
    const d = await call("POST", `/v1/approvals/${p.json().approvalId}/decide`, approver.auth, { decision: "denied", reason: "owner to be decided by the board" });
    expect(d.statusCode, d.body).toBe(200);
    const [row] = await db.select({ owner: agents.ownerUserId }).from(agents).where(eq(agents.id, agentId));
    expect(row!.owner).toBeNull();
    const after = (await call("GET", url, proposer.auth)).json();
    expect(after.proposals[0].status).toBe("denied");
  });
});
