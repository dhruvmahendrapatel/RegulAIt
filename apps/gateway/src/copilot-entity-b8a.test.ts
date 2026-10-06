/**
 * B8a (ADR-0096 amendment) — THE THREE FOLLOW-UPS THE B7a AMENDMENT ITSELF
 * NAMED, each closed as a ROW DELTA with real rows on both sides:
 *
 *  1. VENDOR BECOMES AUDIT-FILTERABLE. B7a's honest-limit 5 observed that
 *     `audit_log.object_type` now carries `'ai_vendor'` (ADR-0084's vendor
 *     surface writes it), so §4's "no join exists anywhere" was stale for
 *     `queryAuditDecisions`. The rows this suite narrows over are GENERATED
 *     THE WAY THE PRODUCT GENERATES THEM — POST /v1/vendors and PATCH
 *     /v1/vendors/:id, never a hand-inserted ledger row — with a second,
 *     unrelated vendor's rows on the far side of the delta. Every other
 *     vendor pair (usage, approvals, anomalies) still refuses, now naming
 *     `queryAuditDecisions` as the tool that can.
 *  2. ai_use_case × listApprovals, through the ONE product-read join B7a
 *     recorded as deferred: `approvals.instance_id` =
 *     `ai_use_cases.workflow_instance_id` — the use case's own intake
 *     instance, never a new attribution column. Real approvals on both sides;
 *     a use case with no instance fails CLOSED (pinned in the registry suite,
 *     whose old refusal test this batch REPLACED).
 *  3. workflow_template × listApprovals, via `workflow_instances.template_ids
 *     @> [template]` (a jsonb array snapshot — an instance may be COMPOSED
 *     from several templates, and the composed instance counts for BOTH).
 *
 * TWO-USER SCOPE HONESTY, unchanged visibility: a vendor someone else owns
 * refuses BYTE-IDENTICALLY to one that exists nowhere; the owner resolves it
 * as the control — and the owner's own audit narrowing honestly returns ZERO
 * rows, because ADR-0084's vendor rows carry no project attribution and a
 * non-admin's audit read is project-scoped (B7a honest-limit 3, extended to
 * vendor verbatim, not silently widened).
 *
 * SHARED-DATABASE DISCIPLINE. Only `Braxel`-prefixed rows, removed in
 * `afterAll`; audit cleanup keyed to this suite's own user ids and object ids
 * (M-020); exact-count assertions ride only suite-scoped reads (an owner's
 * member scope, or a filter over this suite's own object/instance ids);
 * org-wide admin counts are floors, never equalities (M-008).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aiUseCases,
  aiVendors,
  approvals,
  auditLog,
  copilotQueries,
  createDb,
  eq,
  inArray,
  projectMembers,
  projects,
  runMigrations,
  sql,
  users,
  workflowInstances,
  workflowTemplates,
  type Db,
} from "@regulait/db";

const { buildApp } = await import("./app.js");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "copilot-b8a-bootstrap-token";
const ADMIN = { authorization: `Bearer ${BOOT}` };
const PREFIX = "copilot-b8a";

const VENDOR_A = "Braxel Vendor Prime";
const VENDOR_B = "Braxel Vendor Second";
const USE_CASE = "Braxel Vision Uplift";
const T_INTAKE = "Braxel Intake Template";
const T_DEPLOY = "Braxel Deploy Template";
const P_ALPHA = "Braxel Alpha";
const P_BETA = "Braxel Beta";
const P_GAMMA = "Braxel Gamma";

/** vendor A: 1 propose + 2 updates through the REAL routes; vendor B: 1
 * propose — deliberately unequal, so a no-op filter produces the wrong
 * number rather than a coincidentally right one */
const VENDOR_A_AUDIT = 3;
const VENDOR_B_AUDIT = 1;

/** use-case side: 2 approvals on ITS intake instance, 3 raised by the same
 * owner on other instances/none — owner broad 5, narrow 2 */
const UC_APPROVALS = 2;
const UC_OWNER_BROAD = 5;

/** template side: W1=[intake]×2, W2=[deploy,intake]×1 (composed), W3=[deploy]×3
 * — intake narrow 3, deploy narrow 4 */
const INTAKE_APPROVALS = 3;
const DEPLOY_APPROVALS = 4;

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let adminAuth: { authorization: string };
let ucOwnerId: string;
let ucOwnerAuth: { authorization: string };
let vendorOwnerId: string;
let vendorOwnerAuth: { authorization: string };
let outsiderId: string;
let outsiderAuth: { authorization: string };
let vendorAId: string;
let vendorBId: string;
let useCaseId: string;
let ucInstanceId: string;
let intakeTplId: string;
let deployTplId: string;
let w1Id: string;
let w2Id: string;
let w3Id: string;

const post = (url: string, payload: unknown, headers = ADMIN) =>
  app.inject({ method: "POST", url, headers, payload: payload as object });

const ask = (question: string, headers?: { authorization: string }) =>
  post("/v1/copilot/ask", { question }, headers ?? adminAuth);

const decisions = (body: { evidence: { counts: Array<{ key: string; value: number }> } }) =>
  body.evidence.counts.find((c) => c.key === "decisions")!.value;
const approvalCount = (body: { evidence: { counts: Array<{ key: string; value: number }> } }) =>
  body.evidence.counts.find((c) => c.key === "approvals")!.value;

let restoreAdminKeyMfa: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // ADR-0181 (FX2): an admin's API key now answers to mfaRequired. This suite
  // drives admins through keys and is not about MFA, so it relaxes the dial
  // explicitly and hands the shared database back strict in afterAll (M-068).
  restoreAdminKeyMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT });
  await app.ready();

  const mk = async (local: string, isAdmin = false) => {
    const res = await post("/v1/users", {
      email: `${local}@${PREFIX}.example`,
      displayName: local,
      isAdmin,
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;
    const key = await post(`/v1/users/${id}/keys`, { name: PREFIX });
    return { id, auth: { authorization: `Bearer ${key.json().token}` } };
  };
  const admin = await mk(`${PREFIX}-admin`, true);
  adminId = admin.id;
  adminAuth = admin.auth;
  const ucOwner = await mk(`${PREFIX}-uc-owner`);
  ucOwnerId = ucOwner.id;
  ucOwnerAuth = ucOwner.auth;
  const vendorOwner = await mk(`${PREFIX}-vendor-owner`);
  vendorOwnerId = vendorOwner.id;
  vendorOwnerAuth = vendorOwner.auth;
  const outsider = await mk(`${PREFIX}-outsider`);
  outsiderId = outsider.id;
  outsiderAuth = outsider.auth;

  // every non-admin gets a NON-EMPTY scope of their own — a caller who can
  // see nothing at all would make both "refused" and "zero rows" prove less
  const [alpha] = await db.insert(projects).values({ name: P_ALPHA }).returning();
  const [beta] = await db.insert(projects).values({ name: P_BETA }).returning();
  const [gamma] = await db.insert(projects).values({ name: P_GAMMA }).returning();
  await db.insert(projectMembers).values([
    { projectId: alpha!.id, userId: ucOwnerId, role: "owner" },
    { projectId: beta!.id, userId: vendorOwnerId, role: "owner" },
    { projectId: gamma!.id, userId: outsiderId, role: "owner" },
  ]);

  // --- close 1's ledger: ai_vendor audit rows THE WAY THE PRODUCT WRITES
  //     THEM. POST /v1/vendors (vendor-proposed) + two PATCHes
  //     (vendor-updated) for vendor A; one POST for vendor B — never a
  //     hand-inserted audit row -------------------------------------------
  const proposeVendor = async (name: string, auth: { authorization: string }) => {
    const res = await post(
      "/v1/vendors",
      {
        name,
        description: `${PREFIX} vendor under assessment`,
        category: "ai_feature_vendor",
      },
      auth,
    );
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  };
  vendorAId = await proposeVendor(VENDOR_A, vendorOwnerAuth);
  vendorBId = await proposeVendor(VENDOR_B, outsiderAuth);
  for (const description of ["scope narrowed after review", "DPA reference recorded"]) {
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/vendors/${vendorAId}`,
      headers: vendorOwnerAuth,
      payload: { description },
    });
    expect(res.statusCode).toBe(200);
  }

  // --- close 2's ledger: a use case whose OWN intake instance has real
  //     approvals, plus real approvals that are NOT its instance's ---------
  const [ucTpl] = await db
    .insert(workflowTemplates)
    .values({ name: `${PREFIX}-uc-intake-template`, definition: { stages: [] } })
    .returning();
  const mkInstance = async (templateIds: string[], initiatorUserId: string) => {
    const [row] = await db
      .insert(workflowInstances)
      .values({
        templateIds,
        definition: { stages: [] },
        initiatorUserId,
        change: { description: `${PREFIX} governed change`, paths: [] },
        state: {},
        status: "blocked_on_approval",
      })
      .returning();
    return row!.id;
  };
  ucInstanceId = await mkInstance([ucTpl!.id], ucOwnerId);
  const otherInstanceId = await mkInstance([ucTpl!.id], ucOwnerId);
  const [uc] = await db
    .insert(aiUseCases)
    .values({
      name: USE_CASE,
      description: `${PREFIX} seeded use case`,
      ownerUserId: ucOwnerId,
      businessContext: "uplift vision triage quality",
      dataSensitivity: "internal",
      workflowInstanceId: ucInstanceId,
    })
    .returning();
  useCaseId = uc!.id;
  const approvalRow = (userId: string, instanceId: string | null) => ({
    userId,
    approverUserId: adminId,
    objectType: "workflow" as const,
    instanceId,
    stageId: "sign-off",
  });
  // 2 sign-offs of the use case's OWN intake instance…
  for (let i = 0; i < UC_APPROVALS; i++) {
    await db.insert(approvals).values(approvalRow(ucOwnerId, ucInstanceId));
  }
  // …and 3 more raised by the SAME owner (so they sit inside the same member
  // scope on both sides of the delta): 2 on a different instance, 1 on none
  await db.insert(approvals).values(approvalRow(ucOwnerId, otherInstanceId));
  await db.insert(approvals).values(approvalRow(ucOwnerId, otherInstanceId));
  await db.insert(approvals).values(approvalRow(ucOwnerId, null));

  // --- close 3's ledger: two templates, three instances — one COMPOSED from
  //     both, so its approval counts for both templates --------------------
  const [intakeTpl] = await db
    .insert(workflowTemplates)
    .values({ name: T_INTAKE, definition: { stages: [] } })
    .returning();
  intakeTplId = intakeTpl!.id;
  const [deployTpl] = await db
    .insert(workflowTemplates)
    .values({ name: T_DEPLOY, definition: { stages: [] } })
    .returning();
  deployTplId = deployTpl!.id;
  w1Id = await mkInstance([intakeTplId], outsiderId);
  w2Id = await mkInstance([deployTplId, intakeTplId], outsiderId); // composed
  w3Id = await mkInstance([deployTplId], outsiderId);
  for (const [instanceId, n] of [
    [w1Id, 2],
    [w2Id, 1],
    [w3Id, 3],
  ] as const) {
    for (let i = 0; i < n; i++) {
      await db.insert(approvals).values(approvalRow(outsiderId, instanceId));
    }
  }
});

afterAll(async () => {
  await restoreAdminKeyMfa?.();
  const mine = [adminId, ucOwnerId, vendorOwnerId, outsiderId].filter(Boolean);
  await db.delete(copilotQueries).where(inArray(copilotQueries.userId, mine));
  await db.delete(approvals).where(inArray(approvals.userId, mine));
  await db.delete(auditLog).where(inArray(auditLog.userId, mine));
  await db.delete(aiUseCases).where(inArray(aiUseCases.ownerUserId, mine));
  await db.delete(aiVendors).where(inArray(aiVendors.ownerUserId, mine));
  await db.delete(workflowInstances).where(inArray(workflowInstances.initiatorUserId, mine));
  await db
    .delete(workflowTemplates)
    .where(
      inArray(workflowTemplates.name, [T_INTAKE, T_DEPLOY, `${PREFIX}-uc-intake-template`]),
    );
  await db.delete(projectMembers).where(inArray(projectMembers.userId, mine));
  await db.delete(projects).where(sql`${projects.name} LIKE ${"Braxel %"}`);
  await db.delete(users).where(sql`${users.email} LIKE ${"%@" + PREFIX + ".example"}`);
  await app.close();
});

// ---------------------------------------------------------------------------

describe("B8a close 1 — vendor narrows the audit ledger, over PRODUCT-WRITTEN rows", () => {
  it("the admin's broad count vs one vendor's own rows — and the filter tracks the subject", async () => {
    // broad: org-wide for an admin, so a FLOOR (M-008) — at minimum this
    // suite's own 4 ai_vendor rows plus the instance/lifecycle rows around them
    const broad = await ask("summarise the decisions from this quarter");
    expect(broad.statusCode).toBe(201);
    expect(decisions(broad.json())).toBeGreaterThanOrEqual(VENDOR_A_AUDIT + VENDOR_B_AUDIT);

    // narrow: EXACT, because the filter is over THIS suite's own vendor id —
    // 1 vendor-proposed + 2 vendor-updated, written by the real routes
    const narrow = await ask(`summarise the decisions for "${VENDOR_A}" from this quarter`);
    expect(narrow.statusCode).toBe(201);
    const body = narrow.json();
    expect(body.plan.tool).toBe("queryAuditDecisions");
    expect(body.plan.entity).toMatchObject({
      kind: "vendor",
      id: vendorAId,
      name: VENDOR_A,
      matchedOn: VENDOR_A,
    });
    // THE NO-OP-FILTER PROBE'S TARGET: the count must MOVE
    expect(decisions(body)).toBe(VENDOR_A_AUDIT);
    expect(decisions(body)).toBeLessThan(decisions(broad.json()));
    expect(body.answer.subjectFiltered).toBe(true);
    expect(body.answer.unfilteredSubjectCaveat).toBeNull();
    expect(body.note).toMatch(/SUBJECT RESOLVED AND FILTERED/);

    // the same question naming the OTHER vendor returns the OTHER count —
    // real rows on both sides of the filter, and the filter tracks the subject
    const other = await ask(`summarise the decisions for "${VENDOR_B}" from this quarter`);
    expect(other.statusCode).toBe(201);
    expect(other.json().plan.entity).toMatchObject({ kind: "vendor", id: vendorBId });
    expect(decisions(other.json())).toBe(VENDOR_B_AUDIT);
    expect(VENDOR_B_AUDIT).not.toBe(VENDOR_A_AUDIT);
  });

  it("every OTHER vendor pair still refuses — now naming the tool that can", async () => {
    const spend = await ask(`how much have we spent this quarter on "${VENDOR_A}"?`);
    expect(spend.statusCode).toBe(422);
    expect(spend.json().error).toBe("copilot_tool_cannot_filter_entity");
    expect(spend.json().tool).toBe("summarizeUsage");
    expect(spend.json().toolsThatCanFilter).toEqual(["queryAuditDecisions"]);

    const anomalies = await ask(`any anomalies for "${VENDOR_A}" this quarter?`);
    expect(anomalies.statusCode).toBe(422);
    expect(anomalies.json().error).toBe("copilot_tool_cannot_filter_entity");
    expect(anomalies.json().tool).toBe("listAnomalies");
    expect(anomalies.json().toolsThatCanFilter).toEqual(["queryAuditDecisions"]);

    const approvalsQ = await ask(`summarise the approvals for "${VENDOR_A}" from this quarter`);
    expect(approvalsQ.statusCode).toBe(422);
    expect(approvalsQ.json().tool).toBe("listApprovals");
    expect(approvalsQ.json().toolsThatCanFilter).toEqual(["queryAuditDecisions"]);
  });

  it("two-user scope honesty, and the owner's honest ZERO (B7a limit 3 extends to vendor)", async () => {
    // a vendor someone else owns refuses BYTE-IDENTICALLY to one that exists
    // nowhere — the copilot is not an existence oracle for other users' vendors
    const invisible = await ask(
      `summarise the decisions for "${VENDOR_A}" from this quarter`,
      outsiderAuth,
    );
    expect(invisible.statusCode).toBe(422);
    expect(invisible.json().error).toBe("copilot_entity_unresolved");
    const nonexistent = await ask(
      `summarise the decisions for "Braxel Vendor Nowhere" from this quarter`,
      outsiderAuth,
    );
    expect(nonexistent.statusCode).toBe(422);
    expect(
      JSON.stringify(invisible.json()).split(VENDOR_A).join("Braxel Vendor Nowhere"),
    ).toBe(JSON.stringify(nonexistent.json()));
    expect(invisible.json().detail).not.toContain(vendorAId);

    // THE CONTROL: the owner resolves the very same vendor — and their
    // narrowing honestly examines ZERO rows, because ADR-0084's vendor rows
    // carry no project attribution and a non-admin's audit read is
    // project-scoped. The filter narrows WITHIN the caller's scope; it never
    // widens it (B7a honest-limit 3, verbatim for vendor).
    const control = await ask(
      `summarise the decisions for "${VENDOR_A}" from this quarter`,
      vendorOwnerAuth,
    );
    expect(control.statusCode).toBe(201);
    expect(control.json().plan.entity).toMatchObject({ kind: "vendor", id: vendorAId });
    expect(control.json().evidence.rowsExamined).toBe(0);
  });
});

describe("B8a close 2 — ai_use_case × listApprovals through the intake-instance join", () => {
  it("the owner's broad approvals vs the sign-offs of the use case's OWN instance", async () => {
    // broad: EXACT on the owner's member scope — this suite is the only
    // writer of approvals raised by this owner
    const broad = await ask("summarise the approvals from this quarter", ucOwnerAuth);
    expect(broad.statusCode).toBe(201);
    expect(approvalCount(broad.json())).toBe(UC_OWNER_BROAD);

    const narrow = await ask(
      `summarise the approvals for "${USE_CASE}" from this quarter`,
      ucOwnerAuth,
    );
    expect(narrow.statusCode).toBe(201);
    const body = narrow.json();
    expect(body.plan.tool).toBe("listApprovals");
    expect(body.plan.entity).toMatchObject({ kind: "ai_use_case", id: useCaseId });
    // THE NO-OP-FILTER PROBE'S TARGET: `approvals.instance_id` =
    // `ai_use_cases.workflow_instance_id` — the 3 same-owner approvals on
    // OTHER instances (and none) drop out
    expect(approvalCount(body)).toBe(UC_APPROVALS);
    expect(approvalCount(body)).not.toBe(UC_OWNER_BROAD);
    expect(body.answer.subjectFiltered).toBe(true);
    expect(body.note).toMatch(/SUBJECT RESOLVED AND FILTERED/);
  });

  it("usage and anomalies still refuse for a use case, naming BOTH tools that can filter", async () => {
    const spend = await ask(
      `how much have we spent this quarter on "${USE_CASE}"?`,
      ucOwnerAuth,
    );
    expect(spend.statusCode).toBe(422);
    expect(spend.json().error).toBe("copilot_tool_cannot_filter_entity");
    expect(spend.json().toolsThatCanFilter).toEqual(["queryAuditDecisions", "listApprovals"]);

    // the anomalies intersection is now technically satisfiable for this kind
    // (both halves could narrow) but is NOT wired in this batch — the refusal
    // stands until the pair carries its own row-delta proof
    const anomalies = await ask(`any anomalies for "${USE_CASE}" this quarter?`, ucOwnerAuth);
    expect(anomalies.statusCode).toBe(422);
    expect(anomalies.json().tool).toBe("listAnomalies");
    expect(anomalies.json().toolsThatCanFilter).toEqual([
      "queryAuditDecisions",
      "listApprovals",
    ]);
  });
});

describe("B8a close 3 — workflow_template × listApprovals via template_ids containment", () => {
  it("each template narrows to the instances COMPOSED from it — the shared instance counts for both", async () => {
    // broad: org-wide for an admin, so a FLOOR (M-008) — at minimum every
    // approval this suite seeded
    const broad = await ask("summarise the approvals from this quarter");
    expect(broad.statusCode).toBe(201);
    expect(approvalCount(broad.json())).toBeGreaterThanOrEqual(
      UC_OWNER_BROAD + INTAKE_APPROVALS + DEPLOY_APPROVALS - 1, // W2's approval counted once
    );

    // narrow: EXACT, because only THIS suite's instances reference these
    // templates — intake = W1(2) + composed W2(1)
    const intake = await ask(`summarise the approvals for "${T_INTAKE}" from this quarter`);
    expect(intake.statusCode).toBe(201);
    expect(intake.json().plan.tool).toBe("listApprovals");
    expect(intake.json().plan.entity).toMatchObject({
      kind: "workflow_template",
      id: intakeTplId,
    });
    expect(approvalCount(intake.json())).toBe(INTAKE_APPROVALS);

    // deploy = W3(3) + composed W2(1): the SAME composed instance counts for
    // BOTH templates, which is exactly what the jsonb snapshot array records
    const deploy = await ask(`summarise the approvals for "${T_DEPLOY}" from this quarter`);
    expect(deploy.statusCode).toBe(201);
    expect(deploy.json().plan.entity).toMatchObject({
      kind: "workflow_template",
      id: deployTplId,
    });
    expect(approvalCount(deploy.json())).toBe(DEPLOY_APPROVALS);
    expect(DEPLOY_APPROVALS).not.toBe(INTAKE_APPROVALS);
    expect(approvalCount(deploy.json())).toBeLessThan(approvalCount(broad.json()));
  });

  it("usage and anomalies still refuse for a template, naming BOTH tools that can filter", async () => {
    const spend = await ask(`how much have we spent this quarter on "${T_INTAKE}"?`);
    expect(spend.statusCode).toBe(422);
    expect(spend.json().error).toBe("copilot_tool_cannot_filter_entity");
    expect(spend.json().toolsThatCanFilter).toEqual(["queryAuditDecisions", "listApprovals"]);

    const anomalies = await ask(`any anomalies for "${T_INTAKE}" this quarter?`);
    expect(anomalies.statusCode).toBe(422);
    expect(anomalies.json().toolsThatCanFilter).toEqual([
      "queryAuditDecisions",
      "listApprovals",
    ]);
  });
});
