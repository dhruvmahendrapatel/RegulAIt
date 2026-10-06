/**
 * B7a (ADR-0096 amendment) — THE SEVEN REGISTRY KINDS BECOME RESOLVABLE:
 * initiative, compliance pack, AI use case, AI risk, workflow template, role,
 * virtual key.
 *
 * ADR-0096's honest limit 3 (as narrowed by B6c) left these unresolvable,
 * "each still for want of a visibility predicate proved with a two-user test".
 * This file is those tests. Every predicate is a RE-USE of the kind's own
 * list-endpoint scoping, and every filter is proved as a ROW-COUNT DELTA with
 * real rows on both sides (M-024: refusals and narrowings alike fire while
 * plausible, real, well-formed rows sit in the ledger).
 *
 *  1. ROW DELTAS, never reported filters. `audit_log` narrows for all seven
 *     kinds (each has its own `object_type` enum value the gateway already
 *     writes; an initiative narrows through `detail->>'projectId'` over its
 *     project set). `usage_events` narrows for virtual keys (the first-class
 *     `virtual_key_id` column) and initiatives (`project_id IN` — the exact
 *     join GET /v1/initiatives runs). `approvals` narrows for initiatives
 *     (the project-OR-member rule a `project` filter already applies, across
 *     the set). Deliberately UNEQUAL seed counts per kind, so a filter that
 *     does nothing produces the wrong number, not a coincidentally right one.
 *  2. VISIBILITY IS THE LIST ENDPOINT'S OWN RULE. Admin-only kinds
 *     (initiative, pack, template, role — their list endpoints sit behind the
 *     default admin gate) resolve for an admin and refuse for a non-admin
 *     BYTE-IDENTICALLY to a nonexistent name. Owner-scoped kinds (use case,
 *     risk, virtual key — "fleet for admins, own rows for everyone else")
 *     resolve for their owner and refuse for a non-owner the same way.
 *  3. AMBIGUITY IS LISTED, NEVER TIE-BROKEN: two virtual keys sharing a label
 *     list both ids and run nothing (`virtual_keys.name` is not unique).
 *  4. THE KINDS NO OTHER LEDGER CAN NARROW refuse honestly: a role in a spend
 *     question and a pack in an approvals question end in
 *     `copilot_tool_cannot_filter_entity` naming `queryAuditDecisions` as the
 *     one tool that can.
 *
 * SHARED-DATABASE DISCIPLINE. Only `Quorlak`-prefixed rows, removed in
 * `afterAll`; audit cleanup keyed to THIS suite's user ids and its own rule id
 * (M-020); exact-count assertions ride only this suite's own scoped reads
 * (M-008) — org-wide admin counts are asserted as `>=`/`>` floors, never `===`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aiRisks,
  aiUseCases,
  approvals,
  auditLog,
  compliancePacks,
  copilotQueries,
  createDb,
  eq,
  inArray,
  initiatives,
  projectMembers,
  projects,
  roles,
  runMigrations,
  sql,
  usageEvents,
  users,
  virtualKeys,
  workflowTemplates,
  type Db,
} from "@regulait/db";
import { copilotEntityUnresolvedRefusal } from "@regulait/shared";

const { buildApp } = await import("./app.js");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "copilot-registry-bootstrap-token";
const ADMIN = { authorization: `Bearer ${BOOT}` };
const PREFIX = "copilot-registry";

const INITIATIVE = "Quorlak Atlas Initiative";
const PACK = "Quorlak SOC2 Pack";
const TEMPLATE = "Quorlak Intake Template";
const ROLE = "Quorlak Auditor Role";
const USE_CASE = "Quorlak Vision Triage";
const RISK = "Quorlak Drift Risk";
const VKEY = "Quorlak Falcon Key";
/** the label TWO keys share — `virtual_keys.name` is not unique, so a bare
 * label naming two real keys is the ambiguity outcome */
const TWIN_KEY = "Quorlak Twin Key";
const P_ALPHA = "Quorlak Alpha";
const P_BETA = "Quorlak Beta";
const P_GAMMA = "Quorlak Gamma";

/** deliberately DIFFERENT per kind so a no-op filter produces the wrong
 * number rather than a coincidentally right one */
const ROLE_DENIALS = 2;
const PACK_DENIALS = 5;
const TEMPLATE_DENIALS = 6;
const VK_DENIALS = 3; // attributed to Alpha
const UC_DENIALS = 4; // attributed to Alpha
const RISK_DENIALS = 7; // attributed to Beta
/** the owner's project-scoped broad denial count (Alpha + Beta attributed) —
 * also the initiative's audit count, since the initiative IS {Alpha, Beta} */
const OWNER_DENY_BROAD = VK_DENIALS + UC_DENIALS + RISK_DENIALS;
const ADMIN_DENY_FLOOR = OWNER_DENY_BROAD + ROLE_DENIALS + PACK_DENIALS + TEMPLATE_DENIALS;

const INIT_APPROVALS = 3; // raised by the owner, project-stamped Alpha/Beta
const ALL_APPROVALS = 6; // + 3 raised by the outsider on Gamma

const ALPHA_PLAIN_USAGE = 3;
const BETA_PLAIN_USAGE = 2;
const GAMMA_USAGE = 4;
const VK_USAGE = 2; // Alpha rows that carry virtual_key_id
const INIT_USAGE = ALPHA_PLAIN_USAGE + BETA_PLAIN_USAGE + VK_USAGE;
const OWNER_USAGE_BROAD = INIT_USAGE; // owner is member of Alpha + Beta only
const ADMIN_USAGE_FLOOR = INIT_USAGE + GAMMA_USAGE;

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let adminAuth: { authorization: string };
let ownerId: string;
let ownerAuth: { authorization: string };
let outsiderId: string;
let outsiderAuth: { authorization: string };
let initiativeId: string;
let alphaId: string;
let betaId: string;
let gammaId: string;
let packId: string;
let templateId: string;
let roleId: string;
let useCaseId: string;
let riskId: string;
let vkeyId: string;
let twinAId: string;
let twinBId: string;

const post = (url: string, payload: unknown, headers = ADMIN) =>
  app.inject({ method: "POST", url, headers, payload: payload as object });

/** default asker: the ADMIN USER (the bootstrap token is identity-less and the
 * copilot refuses it — there is no entitlement set to inherit) */
const ask = (question: string, headers?: { authorization: string }) =>
  post("/v1/copilot/ask", { question }, headers ?? adminAuth);

const decisions = (body: { evidence: { counts: Array<{ key: string; value: number }> } }) =>
  body.evidence.counts.find((c) => c.key === "decisions")!.value;
const approvalCount = (body: { evidence: { counts: Array<{ key: string; value: number }> } }) =>
  body.evidence.counts.find((c) => c.key === "approvals")!.value;
const calls = (body: { evidence: { counts: Array<{ key: string; value: number }> } }) =>
  body.evidence.counts.find((c) => c.key === "calls")!.value;

/** a governed denial ABOUT one object, in the shape the gateway really writes
 * it: the object's own `object_type` enum value + `object_id`, with project
 * attribution on the detail exactly when the acted-on object lives inside a
 * project (which is also what makes the row visible inside a non-admin's
 * project-scoped audit read) */
async function seedObjectDenials(
  objectType: string,
  objectId: string,
  n: number,
  projectId?: string,
) {
  for (let i = 0; i < n; i++) {
    await db.insert(auditLog).values({
      userId: ownerId,
      objectType: objectType as never,
      objectId,
      detail: projectId ? { projectId, phase: "compliance" } : { phase: "compliance" },
      effect: "deny",
      ruleId: `${PREFIX}-rule`,
      ruleChain: [],
      reason: `${PREFIX} seeded governance refusal`,
    });
  }
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
  const owner = await mk(`${PREFIX}-owner`);
  const outsider = await mk(`${PREFIX}-outsider`);
  ownerId = owner.id;
  ownerAuth = owner.auth;
  outsiderId = outsider.id;
  outsiderAuth = outsider.auth;

  // THE INITIATIVE AND ITS PROJECT SET — Alpha and Beta grouped under it,
  // Gamma deliberately outside so the initiative filter has real rows to
  // EXCLUDE (a 0-vs-0 delta would prove nothing)
  const [init] = await db.insert(initiatives).values({ name: INITIATIVE }).returning();
  initiativeId = init!.id;
  const [alpha] = await db
    .insert(projects)
    .values({ name: P_ALPHA, initiativeId })
    .returning();
  const [beta] = await db.insert(projects).values({ name: P_BETA, initiativeId }).returning();
  const [gamma] = await db.insert(projects).values({ name: P_GAMMA }).returning();
  alphaId = alpha!.id;
  betaId = beta!.id;
  gammaId = gamma!.id;
  await db.insert(projectMembers).values([
    { projectId: alphaId, userId: ownerId, role: "owner" },
    { projectId: betaId, userId: ownerId, role: "contributor" },
    // the outsider gets a project of their own so their scope is NON-EMPTY —
    // an outsider who can see nothing at all would make "refused" prove less
    { projectId: gammaId, userId: outsiderId, role: "owner" },
  ]);

  // THE FOUR ADMIN-ONLY REGISTRY OBJECTS
  const [pack] = await db
    .insert(compliancePacks)
    .values({ framework: `${PREFIX}-soc2`, version: 1, title: PACK })
    .returning();
  packId = pack!.id;
  const [tmpl] = await db
    .insert(workflowTemplates)
    .values({ name: TEMPLATE, definition: { stages: [] } })
    .returning();
  templateId = tmpl!.id;
  const [role] = await db.insert(roles).values({ name: ROLE }).returning();
  roleId = role!.id;

  // THE THREE OWNER-SCOPED OBJECTS, all owned by `owner`
  const [uc] = await db
    .insert(aiUseCases)
    .values({
      name: USE_CASE,
      description: `${PREFIX} seeded use case`,
      ownerUserId: ownerId,
      businessContext: "triage incoming vision requests",
      dataSensitivity: "internal",
    })
    .returning();
  useCaseId = uc!.id;
  const [risk] = await db
    .insert(aiRisks)
    .values({
      title: RISK,
      description: `${PREFIX} seeded risk`,
      category: "scope_drift",
      ownerUserId: ownerId,
      likelihood: "low",
      impact: "low",
    })
    .returning();
  riskId = risk!.id;
  const [vk] = await db
    .insert(virtualKeys)
    .values({ name: VKEY, userId: ownerId, tokenHash: `${PREFIX}-hash-falcon` })
    .returning();
  vkeyId = vk!.id;
  const [twinA] = await db
    .insert(virtualKeys)
    .values({ name: TWIN_KEY, userId: ownerId, tokenHash: `${PREFIX}-hash-twin-a` })
    .returning();
  const [twinB] = await db
    .insert(virtualKeys)
    .values({ name: TWIN_KEY, userId: ownerId, tokenHash: `${PREFIX}-hash-twin-b` })
    .returning();
  twinAId = twinA!.id;
  twinBId = twinB!.id;

  // THE PLAUSIBLE LEDGER (M-024) — every refusal below fires with these rows
  // in place, and every narrowing is measured against them
  await seedObjectDenials("role", roleId, ROLE_DENIALS);
  await seedObjectDenials("compliance_pack", packId, PACK_DENIALS);
  await seedObjectDenials("workflow_template", templateId, TEMPLATE_DENIALS);
  await seedObjectDenials("virtual_key", vkeyId, VK_DENIALS, alphaId);
  await seedObjectDenials("ai_use_case", useCaseId, UC_DENIALS, alphaId);
  await seedObjectDenials("ai_risk", riskId, RISK_DENIALS, betaId);

  // approvals: 3 raised by the owner with the initiative's projects stamped
  // (2 Alpha + 1 Beta), 3 raised by the outsider on Gamma
  for (const projectId of [alphaId, alphaId, betaId]) {
    await db.insert(approvals).values({
      userId: ownerId,
      approverUserId: outsiderId,
      objectType: "project",
      projectId,
    });
  }
  for (let i = 0; i < ALL_APPROVALS - INIT_APPROVALS; i++) {
    await db.insert(approvals).values({
      userId: outsiderId,
      approverUserId: ownerId,
      objectType: "project",
      projectId: gammaId,
    });
  }

  // usage: plain project rows on Alpha/Beta/Gamma, plus Alpha rows that carry
  // the virtual key's FIRST-CLASS `virtual_key_id` column
  const usageRow = (projectId: string, userId: string, virtualKeyId: string | null) => ({
    userId,
    projectId,
    virtualKeyId,
    provider: "mock",
    model: "mock-balanced",
    inputTokens: 10,
    outputTokens: 5,
    costUsd: 0.01,
  });
  for (let i = 0; i < ALPHA_PLAIN_USAGE; i++) {
    await db.insert(usageEvents).values(usageRow(alphaId, ownerId, null));
  }
  for (let i = 0; i < BETA_PLAIN_USAGE; i++) {
    await db.insert(usageEvents).values(usageRow(betaId, ownerId, null));
  }
  for (let i = 0; i < GAMMA_USAGE; i++) {
    await db.insert(usageEvents).values(usageRow(gammaId, outsiderId, null));
  }
  for (let i = 0; i < VK_USAGE; i++) {
    await db.insert(usageEvents).values(usageRow(alphaId, ownerId, vkeyId));
  }
});

afterAll(async () => {
  await restoreAdminKeyMfa?.();
  const mine = [adminId, ownerId, outsiderId].filter(Boolean);
  await db.delete(copilotQueries).where(inArray(copilotQueries.userId, mine));
  await db.delete(approvals).where(inArray(approvals.userId, mine));
  await db.delete(usageEvents).where(inArray(usageEvents.userId, mine));
  await db.delete(auditLog).where(inArray(auditLog.userId, mine));
  await db.delete(auditLog).where(eq(auditLog.ruleId, `${PREFIX}-rule`));
  await db.delete(virtualKeys).where(inArray(virtualKeys.userId, mine));
  await db.delete(aiRisks).where(inArray(aiRisks.ownerUserId, mine));
  await db.delete(aiUseCases).where(inArray(aiUseCases.ownerUserId, mine));
  await db.delete(roles).where(eq(roles.name, ROLE));
  await db.delete(workflowTemplates).where(eq(workflowTemplates.name, TEMPLATE));
  await db.delete(compliancePacks).where(eq(compliancePacks.framework, `${PREFIX}-soc2`));
  await db.delete(projectMembers).where(inArray(projectMembers.userId, mine));
  await db.delete(projects).where(sql`${projects.name} LIKE ${"Quorlak %"}`);
  await db.delete(initiatives).where(eq(initiatives.name, INITIATIVE));
  await db.delete(users).where(sql`${users.email} LIKE ${"%@" + PREFIX + ".example"}`);
  await app.close();
});

// ---------------------------------------------------------------------------

describe("B7a — audit_log narrows for every registry kind, as a ROW DELTA", () => {
  it("virtual key: the owner's broad count vs the key's own rows", async () => {
    const broad = await ask("which denied decisions happened this quarter?", ownerAuth);
    expect(broad.statusCode).toBe(201);
    expect(decisions(broad.json())).toBe(OWNER_DENY_BROAD);

    const narrow = await ask(
      `which denied decisions for "${VKEY}" happened this quarter?`,
      ownerAuth,
    );
    expect(narrow.statusCode).toBe(201);
    const body = narrow.json();
    expect(body.plan.entity).toMatchObject({
      kind: "virtual_key",
      id: vkeyId,
      name: VKEY,
      matchedOn: VKEY,
    });
    // THE NO-OP-FILTER PROBE'S TARGET: the count must MOVE
    expect(decisions(body)).toBe(VK_DENIALS);
    expect(decisions(body)).not.toBe(OWNER_DENY_BROAD);
    expect(body.answer.subjectFiltered).toBe(true);
    expect(body.answer.unfilteredSubjectCaveat).toBeNull();
    expect(body.note).toMatch(/SUBJECT RESOLVED AND FILTERED/);
  });

  it("AI use case and AI risk each narrow to their own, different counts", async () => {
    const uc = await ask(
      `which denied decisions for "${USE_CASE}" happened this quarter?`,
      ownerAuth,
    );
    expect(uc.statusCode).toBe(201);
    expect(uc.json().plan.entity).toMatchObject({ kind: "ai_use_case", id: useCaseId });
    expect(decisions(uc.json())).toBe(UC_DENIALS);

    const risk = await ask(
      `which denied decisions for "${RISK}" happened this quarter?`,
      ownerAuth,
    );
    expect(risk.statusCode).toBe(201);
    expect(risk.json().plan.entity).toMatchObject({ kind: "ai_risk", id: riskId });
    expect(decisions(risk.json())).toBe(RISK_DENIALS);
    expect(RISK_DENIALS).not.toBe(UC_DENIALS);
  });

  it("role, compliance pack and workflow template narrow for an admin", async () => {
    const role = await ask(`which denied decisions for "${ROLE}" happened this quarter?`);
    expect(role.statusCode).toBe(201);
    expect(role.json().plan.entity).toMatchObject({ kind: "role", id: roleId });
    expect(decisions(role.json())).toBe(ROLE_DENIALS);

    const pack = await ask(`which denied decisions for "${PACK}" happened this quarter?`);
    expect(pack.statusCode).toBe(201);
    expect(pack.json().plan.entity).toMatchObject({ kind: "compliance_pack", id: packId });
    expect(decisions(pack.json())).toBe(PACK_DENIALS);

    const tmpl = await ask(`which denied decisions for "${TEMPLATE}" happened this quarter?`);
    expect(tmpl.statusCode).toBe(201);
    expect(tmpl.json().plan.entity).toMatchObject({ kind: "workflow_template", id: templateId });
    expect(decisions(tmpl.json())).toBe(TEMPLATE_DENIALS);

    // the admin's org-wide broad count sits ABOVE every narrowed one — the
    // floor is this suite's own 27 seeded denials (exactness would race other
    // suites' residue and this suite's own refusal audit rows, M-008)
    const broad = await ask("which denied decisions happened this quarter?");
    expect(broad.statusCode).toBe(201);
    expect(decisions(broad.json())).toBeGreaterThanOrEqual(ADMIN_DENY_FLOOR);
    expect(decisions(broad.json())).toBeGreaterThan(TEMPLATE_DENIALS);
  });

  it("initiative: `detail->>'projectId'` over the project SET — Gamma's rows drop out", async () => {
    const res = await ask(
      `which denied decisions for "${INITIATIVE}" happened this quarter?`,
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().plan.entity).toMatchObject({ kind: "initiative", id: initiativeId });
    // Alpha + Beta attributed rows only — the same 14 the owner's own scope
    // reads, which is what "the initiative IS its project set" means
    expect(decisions(res.json())).toBe(OWNER_DENY_BROAD);
    expect(decisions(res.json())).toBeLessThan(ADMIN_DENY_FLOOR);
  });

  it("the resolved kind REPLACES a keyword-derived objectType instead of ANDing to zero", async () => {
    // "tool call" maps to objectType 'mcp_tool'; the key's audit rows carry
    // object_type='virtual_key'. ANDing the keyword would return 0 rows.
    const res = await ask(
      `which denied tool call decisions for "${VKEY}" happened this quarter?`,
      ownerAuth,
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().plan.entity).toMatchObject({ kind: "virtual_key", id: vkeyId });
    expect(decisions(res.json())).toBe(VK_DENIALS);
  });
});

describe("B7a — usage_events narrows where a real column or product-used join exists", () => {
  it("virtual key: the FIRST-CLASS virtual_key_id column, owner-scoped both sides", async () => {
    const broad = await ask("how much have we spent this quarter?", ownerAuth);
    expect(broad.statusCode).toBe(201);
    expect(calls(broad.json())).toBe(OWNER_USAGE_BROAD);

    const narrow = await ask(`how much have we spent this quarter on "${VKEY}"?`, ownerAuth);
    expect(narrow.statusCode).toBe(201);
    expect(narrow.json().plan.tool).toBe("summarizeUsage");
    expect(narrow.json().plan.entity).toMatchObject({ kind: "virtual_key", id: vkeyId });
    expect(calls(narrow.json())).toBe(VK_USAGE);
    expect(calls(narrow.json())).not.toBe(OWNER_USAGE_BROAD);
  });

  it("initiative: project_id over the set — the exact join GET /v1/initiatives runs", async () => {
    const narrow = await ask(`how much have we spent this quarter on "${INITIATIVE}"?`);
    expect(narrow.statusCode).toBe(201);
    expect(narrow.json().plan.entity).toMatchObject({ kind: "initiative", id: initiativeId });
    expect(calls(narrow.json())).toBe(INIT_USAGE);

    const broad = await ask("how much have we spent this quarter?");
    expect(broad.statusCode).toBe(201);
    expect(calls(broad.json())).toBeGreaterThanOrEqual(ADMIN_USAGE_FLOOR);
    expect(calls(broad.json())).toBeGreaterThan(INIT_USAGE);
  });
});

describe("B7a — approvals and anomalies narrow for an initiative", () => {
  it("approvals: the project-OR-member rule across the initiative's project set", async () => {
    const broad = await ask("summarise the approvals from this quarter");
    expect(broad.statusCode).toBe(201);
    expect(approvalCount(broad.json())).toBeGreaterThanOrEqual(ALL_APPROVALS);

    const narrow = await ask(`summarise the approvals for "${INITIATIVE}" from this quarter`);
    expect(narrow.statusCode).toBe(201);
    expect(narrow.json().plan.tool).toBe("listApprovals");
    expect(narrow.json().plan.entity).toMatchObject({ kind: "initiative", id: initiativeId });
    expect(approvalCount(narrow.json())).toBe(INIT_APPROVALS);
    expect(approvalCount(narrow.json())).toBeLessThan(ALL_APPROVALS);
  });

  it("anomalies: BOTH halves narrowed (the intersection rule, satisfied not waived)", async () => {
    const res = await ask(`any anomalies for "${INITIATIVE}" this quarter?`);
    expect(res.statusCode).toBe(201);
    expect(res.json().plan.tool).toBe("listAnomalies");
    expect(res.json().plan.entity).toMatchObject({ kind: "initiative", id: initiativeId });
    // audit half: the initiative's 14 attributed rows, not the org-wide count
    expect(res.json().evidence.rowsExamined).toBe(OWNER_DENY_BROAD);
  });
});

describe("B7a — the kinds no other ledger can narrow REFUSE, naming the tool that can", () => {
  it("a role in a spend question", async () => {
    const res = await ask(`how much have we spent this quarter on "${ROLE}"?`);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("copilot_tool_cannot_filter_entity");
    expect(res.json().toolsThatCanFilter).toEqual(["queryAuditDecisions"]);
    expect(res.json().entity).toMatchObject({ kind: "role", id: roleId });
  });

  it("a compliance pack in an approvals question", async () => {
    const res = await ask(`summarise the approvals for "${PACK}" from this quarter`);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("copilot_tool_cannot_filter_entity");
    expect(res.json().toolsThatCanFilter).toEqual(["queryAuditDecisions"]);
  });

  // B8a REPLACED the refusal test that stood here ("an AI use case in an
  // approvals question — the instance join is NOT smuggled in"): the join is
  // now deliberately wired (`approvals.instance_id` =
  // `ai_use_cases.workflow_instance_id`), so the pair filters instead of
  // refusing, and its proof is the ROW-DELTA test in
  // copilot-entity-b8a.test.ts ("AI use case: approvals narrow to its own
  // intake instance…"). This suite's use case has NO instance, which is now
  // the fail-closed row-delta below rather than a refusal.
  it("an AI use case with NO intake instance matches NOTHING on approvals — fail closed, never broad", async () => {
    const broad = await ask("summarise the approvals from this quarter", ownerAuth);
    expect(broad.statusCode).toBe(201);
    expect(approvalCount(broad.json())).toBeGreaterThan(0);

    const res = await ask(`summarise the approvals for "${USE_CASE}" from this quarter`, ownerAuth);
    expect(res.statusCode).toBe(201);
    expect(res.json().plan.tool).toBe("listApprovals");
    expect(res.json().plan.entity).toMatchObject({ kind: "ai_use_case", id: useCaseId });
    // this suite's use case predates any instance (workflow_instance_id NULL):
    // the filter must select NOTHING, never fall through to the broad count
    expect(approvalCount(res.json())).toBe(0);
  });
});

describe("B7a — existence does not leak across any registry kind's boundary", () => {
  it("a virtual key the caller does not own refuses BYTE-IDENTICALLY to one that exists nowhere", async () => {
    const invisible = await ask(
      `which denied decisions for "${VKEY}" happened this quarter?`,
      outsiderAuth,
    );
    expect(invisible.statusCode).toBe(422);
    expect(invisible.json().error).toBe("copilot_entity_unresolved");

    const nonexistent = await ask(
      `which denied decisions for "Quorlak Nowhere Key" happened this quarter?`,
      outsiderAuth,
    );
    expect(nonexistent.statusCode).toBe(422);

    // after substituting only the caller's own words, the two bodies are the
    // same bytes — the copilot is not an existence oracle for other users' keys
    expect(
      JSON.stringify(invisible.json()).split(VKEY).join("Quorlak Nowhere Key"),
    ).toBe(JSON.stringify(nonexistent.json()));
    expect(invisible.json().detail).not.toContain(vkeyId);

    // THE CONTROL: the owner resolves the very same key
    const control = await ask(
      `which denied decisions for "${VKEY}" happened this quarter?`,
      ownerAuth,
    );
    expect(control.statusCode).toBe(201);
    expect(control.json().plan.entity.id).toBe(vkeyId);
  });

  it("an AI use case and an AI risk owned by someone else are the same absence", async () => {
    const uc = await ask(
      `which denied decisions for "${USE_CASE}" happened this quarter?`,
      outsiderAuth,
    );
    expect(uc.statusCode).toBe(422);
    expect(uc.json().error).toBe("copilot_entity_unresolved");
    expect(uc.json().detail).toBe(copilotEntityUnresolvedRefusal([USE_CASE]));
    expect(uc.json().detail).not.toContain(useCaseId);

    const risk = await ask(
      `which denied decisions for "${RISK}" happened this quarter?`,
      outsiderAuth,
    );
    expect(risk.statusCode).toBe(422);
    expect(risk.json().detail).toBe(copilotEntityUnresolvedRefusal([RISK]));
    expect(risk.json().detail).not.toContain(riskId);
  });

  it("the four ADMIN-ONLY registries do not exist for a non-admin, byte-identically", async () => {
    // full-body proof on the initiative…
    const invisible = await ask(
      `which denied decisions for "${INITIATIVE}" happened this quarter?`,
      ownerAuth,
    );
    expect(invisible.statusCode).toBe(422);
    expect(invisible.json().error).toBe("copilot_entity_unresolved");
    const nonexistent = await ask(
      `which denied decisions for "Quorlak Nowhere Initiative" happened this quarter?`,
      ownerAuth,
    );
    expect(
      JSON.stringify(invisible.json()).split(INITIATIVE).join("Quorlak Nowhere Initiative"),
    ).toBe(JSON.stringify(nonexistent.json()));
    expect(invisible.json().detail).not.toContain(initiativeId);
    expect(invisible.json().detail).not.toMatch(/not permitted|forbidden|no access|admin/i);

    // …and the same absence for pack, template and role, against the shared
    // pure function (the same equality the full-body proof rests on)
    for (const [name, id] of [
      [PACK, packId],
      [TEMPLATE, templateId],
      [ROLE, roleId],
    ] as const) {
      const res = await ask(
        `which denied decisions for "${name}" happened this quarter?`,
        ownerAuth,
      );
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe("copilot_entity_unresolved");
      expect(res.json().detail).toBe(copilotEntityUnresolvedRefusal([name]));
      expect(res.json().detail).not.toContain(id);
    }

    // THE CONTROLS: an admin resolves every one of them (asserted in the
    // row-delta suite above; re-pinned here for the initiative)
    const control = await ask(
      `which denied decisions for "${INITIATIVE}" happened this quarter?`,
    );
    expect(control.statusCode).toBe(201);
    expect(control.json().plan.entity.id).toBe(initiativeId);
  });
});

describe("B7a — a shared label is AMBIGUITY, never a tiebreak", () => {
  it("two virtual keys with one name list BOTH ids and run nothing", async () => {
    const res = await ask(
      `which denied decisions for "${TWIN_KEY}" happened this quarter?`,
      ownerAuth,
    );
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toBe("copilot_entity_ambiguous");
    expect(
      (body.candidates as Array<{ kind: string }>).every((m) => m.kind === "virtual_key"),
    ).toBe(true);
    const ids = (body.candidates as Array<{ id: string }>).map((m) => m.id).sort();
    expect(ids).toEqual([twinAId, twinBId].sort());
    expect(body.detail).toMatch(/^AMBIGUOUS SUBJECT — REFUSING TO GUESS/);
    // NOTHING was retrieved: the refusal precedes the query
    expect(body.evidence).toBeUndefined();
  });
});
