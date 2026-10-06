/**
 * ADR-0170 — lifecycle integrity on the use-case side of the governance flow.
 * Pinned through the real routes on a real database:
 *
 *  §3 MAKER–CHECKER ON BEFORE-GO-LIVE CONDITIONS. A blocking condition is
 *     closed by an admin, its owner when that owner is not the proposer, or a
 *     reviewer who approved the current approval — with a note (422
 *     `condition_note_required`). The proposer (use-case owner or intake
 *     initiator) is refused 403 `proposer_cannot_close_blocking_condition`,
 *     anyone else 403 `forbidden`. After-go-live conditions are unchanged.
 *     The detail read tells each viewer whether THEY may mark each one met.
 *  §4 LOCKED UNDER REVIEW. No PATCH lands while a use case is under_review
 *     (409 `locked_under_review`, owner and admin alike); proposed and
 *     needs_info stay editable.
 *  §5 NO SILENT DOWNGRADE. A later questionnaire version without a valid
 *     answers block keeps the tier the last screening computed.
 *  §6 LIFETIME BACKFILL + RUNTIME GATE. Migration 0133 gives every approved
 *     use case without a lifetime one (policy override, else 6/12 months);
 *     the runtime use-case gate refuses an expired approval.
 *  §8 Deactivated users cannot be named in the review policy, and one failing
 *     use case does not abort the recertification sweep.
 *
 * Shared-database discipline: the review policy and `org_settings` are ORG
 * SINGLETONS — snapshotted in beforeAll and restored in afterAll. Every other
 * fixture is created under a run-unique name and resolved by id; the sweep is
 * always narrowed to this file's own use cases.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aiUseCases,
  and,
  approvals,
  auditLog,
  createDb,
  eq,
  governanceReviewPolicy,
  orgSettings,
  runMigrations,
  sql,
  useCaseConditions,
  users as usersTable,
  workflowInstances,
  type Db,
  type GovernanceReviewPolicyRow,
} from "@regulait/db";
import { renderEuAiActAnswersBlock, type EuAiActAnswers } from "@regulait/shared";
import { buildApp } from "./app.js";
import { previewedPut } from "./testing/decision-regression.js";
import { runUseCaseRecertificationSweep } from "./review-policy.js";
import { useCaseDispatchGate } from "./use-case-gate.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `g170-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
type Who = "admin" | "owner" | "condOwner" | "reviewer" | "stranger" | "newOwner" | "gone";
const users = {} as Record<Who, { id: string; name: string; auth: { authorization: string } }>;
let db: Db;
let app: ReturnType<typeof buildApp>;
let originalPolicy: GovernanceReviewPolicyRow | null = null;
let originalGateMode: "off" | "warn" | "enforce" | null = null;

const minimalAnswers: EuAiActAnswers = {
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
const limitedAnswers: EuAiActAnswers = { ...minimalAnswers, interactsWithHumans: true };
const questionnaire = (a: EuAiActAnswers | null, note = "") =>
  `# AI use-case intake questionnaire\n\n## 1. Purpose\nFilled by the proposer.${note}\n\n## 9. EU AI Act risk screening\n\n` +
  (a ? renderEuAiActAnswersBlock(a) : "Not answered in this version.");

const post = (url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method: "POST", url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const patch = (url: string, headers: Record<string, string>, payload: unknown) =>
  app.inject({ method: "PATCH", url, headers, payload: payload as object });
const get = (url: string, headers: Record<string, string>) => app.inject({ method: "GET", url, headers });

const policy = () => ({
  roles: [{ id: "g170-review", name: "Governance review", memberUserIds: [users.reviewer.id] }],
  tiers: {
    minimal: { roleIds: ["g170-review"], validityMonths: 9 },
    limited: { roleIds: ["g170-review"] },
    high: { roleIds: ["g170-review"] },
    unscreened: { roleIds: ["g170-review"] },
  },
  riskAcceptorUserIds: [users.reviewer.id],
});

async function propose(label: string, extra: Record<string, unknown> = {}) {
  const p = await post("/v1/use-cases", users.owner.auth, {
    name: `g170 ${label} ${RUN}`,
    description: "synthetic ADR-0170 fixture",
    businessContext: "lifecycle hardening",
    dataSensitivity: "internal",
    ...extra,
  });
  expect(p.statusCode, p.body).toBe(201);
  const id = p.json().id as string;
  const instanceId = p.json().instance.id as string;
  const adv = await post(`/v1/workflows/instances/${instanceId}/advance`, users.owner.auth, { stageId: "plan" });
  expect(adv.statusCode, adv.body).toBe(200);
  return { id, instanceId };
}
async function submitQuestionnaire(instanceId: string, content: string, version: number) {
  const art = await post(`/v1/workflows/instances/${instanceId}/artifacts`, users.owner.auth, {
    stageId: "questionnaire",
    content,
  });
  expect(art.statusCode, art.body).toBe(201);
  expect(art.json()).toMatchObject({ version, status: "blocked_on_approval" });
}
async function proposeToReview(label: string, answers: EuAiActAnswers = minimalAnswers, extra: Record<string, unknown> = {}) {
  const uc = await propose(label, extra);
  await submitQuestionnaire(uc.instanceId, questionnaire(answers), 1);
  return uc;
}
const pendingSignoff = async (instanceId: string) => {
  const rows = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.instanceId, instanceId), eq(approvals.stageId, "signoff"), eq(approvals.status, "pending")));
  expect(rows).toHaveLength(1);
  return rows[0]!.id;
};
/** the reviewer (a live member of the policy's role) approves, imposing `conditions` */
async function approveWith(instanceId: string, conditions: unknown[] = []) {
  const r = await post(`/v1/approvals/${await pendingSignoff(instanceId)}/decide`, users.reviewer.auth, {
    decision: "approved",
    reason: "approved (g170)",
    ...(conditions.length ? { conditions } : {}),
  });
  expect(r.statusCode, r.body).toBe(200);
}
const useCaseRow = async (id: string) => (await db.select().from(aiUseCases).where(eq(aiUseCases.id, id)))[0]!;
const conditionsOf = (useCaseId: string) =>
  db.select().from(useCaseConditions).where(eq(useCaseConditions.useCaseId, useCaseId));
const met = (useCaseId: string, conditionId: string, who: Who, body: Record<string, unknown> = {}) =>
  post(`/v1/use-cases/${useCaseId}/conditions/${conditionId}/met`, users[who].auth, body);
const auditFor = (objectId: string, ruleId: string) =>
  db.select().from(auditLog).where(and(eq(auditLog.objectId, objectId), eq(auditLog.ruleId, ruleId)));

const future = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

let restoreAdminKeyMfa: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // ADR-0181 (FX2): an admin's API key now answers to mfaRequired. This suite
  // drives admins through keys and is not about MFA, so it relaxes the dial
  // explicitly and hands the shared database back strict in afterAll (M-068).
  restoreAdminKeyMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "c".repeat(64) });
  [originalPolicy = null] = await db.select().from(governanceReviewPolicy);
  const [org] = await db.select().from(orgSettings);
  originalGateMode = (org?.useCaseGateMode as "off" | "warn" | "enforce" | undefined) ?? null;
  const who: Array<[Who, boolean]> = [
    ["admin", true], ["owner", false], ["condOwner", false], ["reviewer", false], ["stranger", false], ["newOwner", false], ["gone", false],
  ];
  for (const [k, isAdmin] of who) {
    const name = `g170 ${k} ${RUN}`;
    const u = await post("/v1/users", AUTH, { email: `g170-${k.toLowerCase()}-${RUN}@example.com`, displayName: name, isAdmin });
    expect(u.statusCode, u.body).toBe(201);
    const id = u.json().id as string;
    const token = (await post(`/v1/users/${id}/keys`, AUTH, { name: "g170" })).json().token as string;
    users[k] = { id, name, auth: { authorization: `Bearer ${token}` } };
  }
  // ADR-0182 A11: previewed first, under the strict decision-regression gate
  const r = await previewedPut(app, "/v1/governance/review-policy", users.admin.auth, "review_policy", policy());
  expect(r.statusCode, r.body).toBe(200);
}, 120_000);

afterAll(async () => {
  await restoreAdminKeyMfa?.();
  // org singletons: put back exactly what was there
  await db.delete(governanceReviewPolicy);
  if (originalPolicy) await db.insert(governanceReviewPolicy).values(originalPolicy);
  await db.update(orgSettings).set({ useCaseGateMode: originalGateMode ?? "enforce" });
  app.server.closeAllConnections();
  await app.close();
});

describe("§3 a before-go-live condition is closed by someone other than the proposer, with a note", () => {
  it("refuses the proposer and strangers by name, requires the note, and lets the owner, a reviewer and an admin close it", async () => {
    const uc = await proposeToReview("maker-checker");
    await approveWith(uc.instanceId, [
      { text: "DPIA filed (independent owner)", ownerUserId: users.condOwner.id, dueAt: future, blocking: true },
      { text: "Proposer-owned check", ownerUserId: users.owner.id, dueAt: future, blocking: true },
      { text: "Reviewer confirms", dueAt: future, blocking: true },
      { text: "Admin confirms", dueAt: future, blocking: true },
      { text: "Quarterly review (after go-live)", dueAt: future, blocking: false },
    ]);
    const rows = await conditionsOf(uc.id);
    const id = (prefix: string) => rows.find((c) => c.text.startsWith(prefix))!.id;

    // the detail read tells each viewer what THEY may close
    const asOwner = (await get(`/v1/use-cases/${uc.id}`, users.owner.auth)).json().conditions as any[];
    const ownerView = new Map(asOwner.map((c) => [c.text, c.canMarkMet]));
    expect(ownerView.get("DPIA filed (independent owner)")).toBe(false);
    expect(ownerView.get("Proposer-owned check")).toBe(false);
    expect(ownerView.get("Quarterly review (after go-live)")).toBe(true);
    const asReviewer = (await get(`/v1/use-cases/${uc.id}`, users.reviewer.auth)).json().conditions as any[];
    expect(asReviewer.filter((c) => c.blocking).every((c) => c.canMarkMet === true)).toBe(true);
    expect(asReviewer.find((c) => !c.blocking).canMarkMet).toBe(false);
    const asAdmin = (await get(`/v1/use-cases/${uc.id}`, users.admin.auth)).json().conditions as any[];
    expect(asAdmin.every((c) => c.canMarkMet === true)).toBe(true);

    // the proposer: refused by name — even on a condition they own, even with a note
    for (const c of ["DPIA filed", "Proposer-owned check", "Reviewer confirms"]) {
      const r = await met(uc.id, id(c), "owner", { note: "done" });
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json().error).toBe("proposer_cannot_close_blocking_condition");
    }
    // a stranger (not owner, not a reviewer of it): generic forbidden
    const s = await met(uc.id, id("Reviewer confirms"), "stranger", { note: "done" });
    expect(s.statusCode).toBe(403);
    expect(s.json().error).toBe("forbidden");
    // the condition owner may close it — but only with a note
    for (const body of [{}, { note: "   " }]) {
      const r = await met(uc.id, id("DPIA filed"), "condOwner", body);
      expect(r.statusCode, r.body).toBe(422);
      expect(r.json().error).toBe("condition_note_required");
    }
    expect((await conditionsOf(uc.id)).every((c) => c.status === "open")).toBe(true);
    const byOwner = await met(uc.id, id("DPIA filed"), "condOwner", { note: "DPIA filed with the DPO" });
    expect(byOwner.statusCode, byOwner.body).toBe(200);
    expect(byOwner.json()).toMatchObject({ status: "met", note: "DPIA filed with the DPO", canMarkMet: false });
    // a reviewer who approved the use case closes one they do not own
    expect((await met(uc.id, id("Reviewer confirms"), "reviewer", {})).json().error).toBe("condition_note_required");
    const byReviewer = await met(uc.id, id("Reviewer confirms"), "reviewer", { note: "verified the control" });
    expect(byReviewer.statusCode, byReviewer.body).toBe(200);
    // an admin also needs the note
    expect((await met(uc.id, id("Admin confirms"), "admin", {})).statusCode).toBe(422);
    expect((await met(uc.id, id("Admin confirms"), "admin", { note: "checked" })).statusCode).toBe(200);
    // after-go-live: unchanged — the use-case owner closes it, no note needed
    const after = await met(uc.id, id("Quarterly review"), "owner", {});
    expect(after.statusCode, after.body).toBe(200);
    expect(after.json().note).toBeNull();
    // the proposer-owned blocking one is still open; three closes were audited
    expect((await conditionsOf(uc.id)).find((c) => c.id === id("Proposer-owned check"))!.status).toBe("open");
    expect(await auditFor(uc.id, "use-case-condition-met")).toHaveLength(4);
  });

  it("the intake initiator stays the proposer after ownership moves, and so does the new owner", async () => {
    const uc = await proposeToReview("initiator");
    await approveWith(uc.instanceId, [
      { text: "initiator-owned", ownerUserId: users.owner.id, dueAt: future, blocking: true },
    ]);
    await db.update(aiUseCases).set({ ownerUserId: users.newOwner.id }).where(eq(aiUseCases.id, uc.id));
    const [cond] = await conditionsOf(uc.id);
    for (const who of ["owner", "newOwner"] as const) {
      const r = await met(uc.id, cond!.id, who, { note: "done" });
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json().error).toBe("proposer_cannot_close_blocking_condition");
    }
  });
});

describe("§4 a use case under review is locked", () => {
  it("refuses every PATCH while under_review (owner and admin) and writes nothing; proposed stays editable", async () => {
    const draft = await propose("lock-proposed");
    const ok = await patch(`/v1/use-cases/${draft.id}`, users.owner.auth, { description: "edited while proposed" });
    expect(ok.statusCode, ok.body).toBe(200);

    const uc = await proposeToReview("lock");
    const before = await useCaseRow(uc.id);
    expect(before.status).toBe("under_review");
    for (const [who, body] of [
      ["owner", { description: "changed under the reviewers" }],
      ["owner", { intendedAgentIds: [] }],
      ["owner", { businessContext: "x" }],
      ["admin", { description: "an admin cannot either" }],
    ] as const) {
      const r = await patch(`/v1/use-cases/${uc.id}`, users[who].auth, body);
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().error).toBe("locked_under_review");
      expect(r.json().detail).toMatch(/sends it back/);
    }
    const after = await useCaseRow(uc.id);
    expect(after.description).toBe(before.description);
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
    // a non-owner is still told "forbidden" first, not what state the record is in
    expect((await patch(`/v1/use-cases/${uc.id}`, users.stranger.auth, { description: "x" })).statusCode).toBe(403);
  });
});

describe("§5 screening never silently downgrades", () => {
  it("a questionnaire version without (or with an invalid) answers block keeps the last computed tier", async () => {
    const uc = await proposeToReview("no-downgrade", limitedAnswers);
    const screened = await useCaseRow(uc.id);
    expect(screened.euAiActTier).toBe("limited");
    const auditsBefore = (await auditFor(uc.id, "use-case-eu-tier")).length;

    await submitQuestionnaire(uc.instanceId, questionnaire(null, " Version 2."), 2);
    let row = await useCaseRow(uc.id);
    expect(row.euAiActTier).toBe("limited");
    expect(row.euAiActReasons).toEqual(screened.euAiActReasons);
    expect(row.euAiActRulesetVersion).toBe(screened.euAiActRulesetVersion);

    const invalid = "```eu-ai-act-answers\n{ not json\n```";
    await submitQuestionnaire(uc.instanceId, `# AI use-case intake questionnaire\n\n${invalid}`, 3);
    row = await useCaseRow(uc.id);
    expect(row.euAiActTier).toBe("limited");
    expect((await auditFor(uc.id, "use-case-eu-tier")).length).toBe(auditsBefore);

    // a valid block still recomputes (here: up to high)
    await submitQuestionnaire(
      uc.instanceId,
      questionnaire({ ...minimalAnswers, purposeDomain: "employment-hr", decisionAutonomy: "fully-automated" }),
      4,
    );
    expect((await useCaseRow(uc.id)).euAiActTier).toBe("high");
  });
});

describe("§6 an approval without an end date is not an approval without end", () => {
  it("migration 0133 backfills approved_at/approved_until (policy override, else 6/12 months) and touches nothing else", async () => {
    const mk = async (label: string, tier: "minimal" | "limited" | "high" | null) => {
      const uc = await proposeToReview(`backfill-${label}`);
      await approveWith(uc.instanceId);
      await db
        .update(aiUseCases)
        .set({
          approvedAt: null,
          approvedUntil: null,
          euAiActTier: tier,
          ...(tier === null ? { euAiActReasons: null, euAiActRulesetVersion: null } : {}),
          updatedAt: new Date("2026-01-15T10:00:00Z"),
        })
        .where(eq(aiUseCases.id, uc.id));
      return uc.id;
    };
    const minimal = await mk("minimal", "minimal"); // policy validityMonths 9
    const limited = await mk("limited", "limited"); // no override → 12
    const high = await mk("high", "high"); // no override → 6
    const unscreened = await mk("unscreened", null); // no override → 6
    const proposed = await propose("backfill-proposed"); // not approved: untouched

    const file = path.join(migrationsFolder, "0133_use_case_lifetime_backfill.sql");
    await db.execute(sql.raw(readFileSync(file, "utf8")));

    const at = "2026-01-15T10:00:00.000Z";
    for (const [id, until] of [
      [minimal, "2026-10-15T10:00:00.000Z"],
      [limited, "2027-01-15T10:00:00.000Z"],
      [high, "2026-07-15T10:00:00.000Z"],
      [unscreened, "2026-07-15T10:00:00.000Z"],
    ] as const) {
      const row = await useCaseRow(id);
      expect(row.approvedAt?.toISOString(), id).toBe(at);
      expect(row.approvedUntil?.toISOString(), id).toBe(until);
    }
    expect(await useCaseRow(proposed.id)).toMatchObject({ approvedAt: null, approvedUntil: null });
    // idempotent: a second run changes nothing
    await db.execute(sql.raw(readFileSync(file, "utf8")));
    expect((await useCaseRow(high)).approvedUntil?.toISOString()).toBe("2026-07-15T10:00:00.000Z");
  });

  it("the runtime use-case gate refuses an expired approval instead of waiting for the sweep", async () => {
    const p = await post("/v1/projects", AUTH, { name: `g170-gate-${RUN}` });
    expect(p.statusCode, p.body).toBe(201);
    const projectId = p.json().id as string;
    const uc = await proposeToReview("gate", minimalAnswers, { projectId });
    await approveWith(uc.instanceId);
    await db.update(orgSettings).set({ useCaseGateMode: "enforce" });
    const ctx = { userId: users.admin.id, agentId: "00000000-0000-0000-0000-000000000170", agentName: "g170 agent", projectId };
    // a current approval passes
    expect(await useCaseDispatchGate(db, ctx)).toBeNull();
    // past its valid-until: refused, the roster says why
    await db.update(aiUseCases).set({ approvedUntil: new Date(Date.now() - 60_000) }).where(eq(aiUseCases.id, uc.id));
    const refused = await useCaseDispatchGate(db, ctx);
    expect(refused).toMatchObject({ kind: "refuse", status: 409, error: "use_case_approval_required" });
    expect(refused && refused.kind === "refuse" ? refused.detail : "").toContain("approval has expired");
    // NULL (only a row the backfill could not reach) is not treated as expired
    await db.update(aiUseCases).set({ approvedAt: null, approvedUntil: null }).where(eq(aiUseCases.id, uc.id));
    expect(await useCaseDispatchGate(db, ctx)).toBeNull();
    await db.update(orgSettings).set({ useCaseGateMode: originalGateMode ?? "enforce" });
  });
});

describe("§8 smaller hardening", () => {
  it("a deactivated user cannot be named as a role member or a risk acceptor", async () => {
    await db.update(usersTable).set({ disabledAt: new Date() }).where(eq(usersTable.id, users.gone.id));
    const put = (body: unknown) =>
      app.inject({ method: "PUT", url: "/v1/governance/review-policy", headers: users.admin.auth, payload: body as object });
    const asMember = await put({
      ...policy(),
      roles: [{ id: "g170-review", name: "Governance review", memberUserIds: [users.reviewer.id, users.gone.id] }],
    });
    expect(asMember.statusCode, asMember.body).toBe(422);
    expect(asMember.json()).toMatchObject({
      error: "user_deactivated",
      field: "roles.g170-review.memberUserIds",
      userIds: [users.gone.id],
    });
    const asAcceptor = await put({ ...policy(), riskAcceptorUserIds: [users.reviewer.id, users.gone.id] });
    expect(asAcceptor.statusCode, asAcceptor.body).toBe(422);
    expect(asAcceptor.json()).toMatchObject({ error: "user_deactivated", field: "riskAcceptorUserIds", userIds: [users.gone.id] });
    // nothing was stored: the live policy is still this file's
    const live = (await get("/v1/governance/review-policy", users.admin.auth)).json();
    expect(live.roles[0].memberUserIds).toEqual([users.reviewer.id]);
    expect(live.riskAcceptorUserIds).toEqual([users.reviewer.id]);
  });

  it("one failing use case is skipped and logged; the sweep still moves the others", async () => {
    const broken = await proposeToReview("sweep-broken");
    await approveWith(broken.instanceId);
    const healthy = await proposeToReview("sweep-healthy");
    await approveWith(healthy.instanceId);
    const lapsed = new Date("2026-02-01T00:00:00Z");
    for (const id of [broken.id, healthy.id]) {
      await db.update(aiUseCases).set({ approvedUntil: lapsed }).where(eq(aiUseCases.id, id));
    }
    // the kernel refuses this re-open (a WorkflowStateError): the stage it
    // targets is no longer before the instance's current stage
    await db
      .update(workflowInstances)
      .set({ state: sql`jsonb_set(${workflowInstances.state}, '{currentStageIndex}', '0'::jsonb)` })
      .where(eq(workflowInstances.id, broken.instanceId));

    const logged: string[] = [];
    // broken first, so a loop that aborts on it would never reach healthy
    const out = await runUseCaseRecertificationSweep(db, { useCaseIds: [broken.id, healthy.id], log: (l) => logged.push(l) });
    expect(out.evaluated).toBe(2);
    expect(out.movedIds).toEqual([healthy.id]);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0]).toMatchObject({ id: broken.id, reason: expect.stringMatching(/^error: /) });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(broken.id);
    // the failed one rolled back whole: still approved, nothing audited
    expect(await useCaseRow(broken.id)).toMatchObject({ status: "approved", recertification: false });
    expect(await auditFor(broken.id, "use-case-recertification-started")).toHaveLength(0);
    expect(await useCaseRow(healthy.id)).toMatchObject({ status: "under_review", recertification: true });
  });
});
