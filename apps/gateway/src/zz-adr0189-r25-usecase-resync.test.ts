/**
 * ADR-0189 R25 item 13 FOLLOW-UP — a use case left behind its completed
 * instance, and the routes whose executor can complete an instance.
 *
 * One file, its OWN scratch database (`builderKit(…, { scratch: true })`, M-040):
 * it turns the receipt key off and on and relaxes step-up, which must never
 * reach the shared database. It holds its own receipt key and restores the
 * caller's afterwards.
 *
 *  - the stranded case, end to end: an executor (a check report) completes the
 *    instance while no key is usable, the use case stays behind, the response
 *    says so, and the posture report counts it;
 *  - POST /v1/use-cases/:useCaseId/resync: no key refuses 409 (audited, nothing
 *    commits); with a key it approves and takes the snapshot after commit;
 *    a second call is a 200 no-op; non-admins, unknown ids and a strict step-up
 *    are refused; it touches only the use case it names;
 *  - deploy-override mirrors the use case, and refuses before commit without a key;
 *  - the two #352 recheck tests: a refused submit on the Idempotency-Key branch
 *    (409, claim rolled back, a retry works) and a refused submit or advance on a
 *    template carrying an executor (check) stage (nothing of the executor moves).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  aiBomSnapshots,
  approvals,
  and,
  aiUseCases,
  auditLog,
  eq,
  requestIdempotencyKeys,
  sql,
  useCaseDecisionRecords,
  workflowArtifacts,
  workflowEvents,
  workflowInstances,
  type Db,
} from "@regulait/db";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import { relaxStepUpForTest } from "./testing/step-up-posture.js";
import { createWorkflowTemplateValidated, startWorkflowInstanceWithTemplates } from "./workflows.js";

const KEY_ENV = ["REGULAIT_RECEIPT_SIGNING_KEY", "REGULAIT_RECEIPT_SIGNING_KEY_ID"] as const;
const savedEnv = Object.fromEntries(KEY_ENV.map((k) => [k, process.env[k]]));
let keyDir: string;
let k: BuilderKit;
let db: Db;
let owner: Person;
let admin: Person;
let approver: Person;
/** SYNTHETIC: the one agent every use case here lists */
let ucAgentId: string;
let restoreStepUp: (() => Promise<void>) | undefined;

function useKey(on: boolean) {
  for (const key of KEY_ENV) delete process.env[key];
  if (on) {
    process.env.REGULAIT_RECEIPT_SIGNING_KEY = path.join(keyDir, "receipt.pem");
    process.env.REGULAIT_RECEIPT_SIGNING_KEY_ID = `r25rs-receipt-${k.RUN}`;
  }
}
async function withoutKey<T>(fn: () => Promise<T>): Promise<T> {
  useKey(false);
  try {
    return await fn();
  } finally {
    useKey(true);
  }
}

/** a template started directly (no assignment rule is left behind), and a use case it governs */
async function startInstance(label: string, stages: unknown[]) {
  const tpl = await createWorkflowTemplateValidated(db, { name: `r25rs-${label}-${k.RUN}`, definition: { workflow: `r25rs-${label}-${k.RUN}`, stages } });
  if (!tpl.ok) throw new Error(`template refused: ${JSON.stringify(tpl.body)}`);
  const started = await startWorkflowInstanceWithTemplates(db, undefined, {
    templateIds: [tpl.row.id],
    initiatorUserId: owner.id,
    change: { description: `r25rs ${label}`, paths: [], environment: `r25rs-env-${k.RUN}` },
  });
  if (!started.ok) throw new Error(`instance refused: ${JSON.stringify(started.body)}`);
  const [uc] = await db.insert(aiUseCases).values({
    name: `r25rs-uc-${label}-${k.RUN}`, description: "r25rs synthetic", ownerUserId: owner.id, businessContext: "r25rs synthetic",
    intendedAgentIds: [ucAgentId], dataSensitivity: "internal", status: "proposed", workflowInstanceId: started.instance.id,
  }).returning({ id: aiUseCases.id });
  return { instanceId: started.instance.id, useCaseId: uc!.id };
}

async function useCaseStatus(useCaseId: string) {
  const [u] = await db.select({ status: aiUseCases.status }).from(aiUseCases).where(eq(aiUseCases.id, useCaseId));
  return u!.status;
}
async function instanceRow(instanceId: string) {
  const [i] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId));
  return i!;
}
/** everything the instance and its executor own: a refused transition moves none of it */
async function instanceFootprint(instanceId: string, useCaseId: string) {
  const i = await instanceRow(instanceId);
  const events = await db.select({ id: workflowEvents.id }).from(workflowEvents).where(eq(workflowEvents.instanceId, instanceId));
  const artifacts = await db.select({ id: workflowArtifacts.id }).from(workflowArtifacts).where(eq(workflowArtifacts.instanceId, instanceId));
  const audits = await db.select({ id: auditLog.id }).from(auditLog).where(sql`${auditLog.objectType} = 'workflow' and ${auditLog.objectId} = ${instanceId}`);
  return {
    status: i.status,
    state: i.state,
    context: i.context,
    round: i.round,
    events: events.length,
    artifacts: artifacts.length,
    workflowAudits: audits.length,
    useCase: await useCaseStatus(useCaseId),
  };
}
async function snapshotsOf(useCaseId: string) {
  return db.select().from(aiBomSnapshots).where(sql`${aiBomSnapshots.subjectKind} = 'use_case' and ${aiBomSnapshots.subjectId} = ${useCaseId}`);
}
async function auditRows(ruleId: string, objectId: string) {
  return db.select().from(auditLog).where(sql`${auditLog.ruleId} = ${ruleId} and ${auditLog.objectId} = ${objectId}`);
}
/** the audit row of the transition into `completed` (what the re-sync dates a no-approval decision by) */
async function completionRow(instanceId: string) {
  const rows = await db
    .select({ at: auditLog.at, userId: auditLog.userId })
    .from(auditLog)
    .where(sql`${auditLog.objectType} = 'workflow' and ${auditLog.objectId} = ${instanceId} and ${auditLog.detail} ? 'event' and ${auditLog.reason} like ${"%(status → completed)"}`)
    .orderBy(sql`${auditLog.at} desc`)
    .limit(1);
  expect(rows, "the instance's completion is on the record").toHaveLength(1);
  return rows[0]!;
}
async function lifetimeOf(useCaseId: string) {
  const [u] = await db
    .select({ approvedAt: aiUseCases.approvedAt, approvedUntil: aiUseCases.approvedUntil, decidedAt: aiUseCases.decidedAt })
    .from(aiUseCases)
    .where(eq(aiUseCases.id, useCaseId));
  return u!;
}
async function decisionRecords(useCaseId: string) {
  return db.select().from(useCaseDecisionRecords).where(eq(useCaseDecisionRecords.useCaseId, useCaseId));
}
async function posture() {
  const res = await k.req("GET", "/v1/reports/posture", k.BOOT);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().useCases.instanceCompletedNotApproved as { count: number; sampleUseCaseIds: string[]; action: string };
}
const CHECK_STAGES = (label: string) => [
  { id: "intake", type: "trigger" },
  { id: "questionnaire", type: "artifact_generation", output: `r25rs_${label}` },
  { id: "ci-gate", type: "automated_check", checks: ["ci"] },
];
/** the owner reports the named check passed (a self-report: it carries a reason) */
async function reportPass(instanceId: string) {
  const round = (await instanceRow(instanceId)).round;
  return k.req("POST", `/v1/workflows/instances/${instanceId}/checks`, owner.auth, {
    round,
    stageId: "ci-gate",
    results: [{ check: "ci", status: "passed" }],
    reason: "r25rs: the CI run passed",
  });
}
/**
 * THE STRANDED CASE, through the real routes: the questionnaire is submitted
 * (the instance then waits on its check stage), and the passing check report
 * arrives while no key is usable. The executor completes the instance after the
 * route committed; the use-case approval is refused and the use case stays behind.
 */
async function strandUseCase(label: string) {
  const f = await startInstance(label, CHECK_STAGES(label));
  const submitted = await k.req("POST", `/v1/workflows/instances/${f.instanceId}/artifacts`, owner.auth, { stageId: "questionnaire", content: "r25rs answers" });
  expect(submitted.statusCode, submitted.body).toBe(201);
  expect(submitted.json().status).toBe("awaiting_execution");
  const reported = await withoutKey(() => reportPass(f.instanceId));
  expect(reported.statusCode, reported.body).toBe(200);
  expect(reported.json().status).toBe("completed");
  expect(reported.json().useCaseSignoffWarning).toMatchObject({ code: "bom_signing_unavailable" });
  expect(await useCaseStatus(f.useCaseId)).toBe("proposed");
  return f;
}
const resync = (useCaseId: string, who: { authorization: string } = admin.auth) => k.req("POST", `/v1/use-cases/${useCaseId}/resync`, who, {});

beforeAll(async () => {
  keyDir = mkdtempSync(path.join(tmpdir(), "r25rs-"));
  writeFileSync(path.join(keyDir, "receipt.pem"), generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  k = await builderKit("r25rs", { scratch: true });
  db = k.db;
  useKey(true);
  // the step-up is proved once, below, under the strict policy
  restoreStepUp = await relaxStepUpForTest(db);
  owner = await k.person("owner");
  admin = await k.person("admin", { admin: true });
  approver = await k.person("approver");
  ucAgentId = await k.model("uc-agent");
}, 300_000);

afterAll(async () => {
  for (const key of KEY_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await restoreStepUp?.();
  await k?.close();
  rmSync(keyDir, { recursive: true, force: true });
}, 120_000);

describe("a use case left behind its completed instance", () => {
  it("is counted on the posture report, with an example id and the action, and blocks nothing", async () => {
    const before = await posture();
    const f = await strandUseCase("posture");
    const after = await posture();
    expect(after.count).toBe(before.count + 1);
    expect(after.sampleUseCaseIds).toContain(f.useCaseId);
    expect(after.action).toContain("/v1/use-cases/:useCaseId/resync");
    // recovered, it leaves the count
    const res = await resync(f.useCaseId);
    expect(res.statusCode, res.body).toBe(200);
    const settled = await posture();
    expect(settled.count).toBe(before.count);
    expect(settled.sampleUseCaseIds).not.toContain(f.useCaseId);
  }, 180_000);
});

describe("POST /v1/use-cases/:useCaseId/resync", () => {
  it("no usable key: 409 bom_signing_unavailable, audited as refused, and nothing commits", async () => {
    const f = await strandUseCase("nokey");
    const snapshotsBefore = (await snapshotsOf(f.useCaseId)).length;
    const res = await withoutKey(() => resync(f.useCaseId));
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ error: "bom_signing_unavailable" });
    expect(await useCaseStatus(f.useCaseId)).toBe("proposed");
    expect(await auditRows("use-case-approved", f.useCaseId)).toEqual([]);
    expect(await auditRows("use-case-resynced", f.useCaseId)).toEqual([]);
    const refused = await auditRows("use-case-resync-refused", f.useCaseId);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.effect).toBe("deny");
    expect(refused[0]!.detail).toMatchObject({ code: "bom_signing_unavailable", workflowInstanceId: f.instanceId });
    expect((await snapshotsOf(f.useCaseId)).length).toBe(snapshotsBefore);
    // recovered here, so it never crowds the posture sample (5) the later tests read
    const recovered = await resync(f.useCaseId);
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(await useCaseStatus(f.useCaseId)).toBe("approved");
  }, 180_000);

  it("with a key: approves the use case, audits the re-sync, owes and takes the signed snapshot after commit; a second call is a no-op", async () => {
    const f = await strandUseCase("ok");
    const res = await resync(f.useCaseId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ useCaseId: f.useCaseId, workflowInstanceId: f.instanceId, instanceStatus: "completed", from: "proposed", status: "approved", resynced: true });
    expect(res.json().aiBomSnapshotWarning).toBeUndefined();
    expect(await useCaseStatus(f.useCaseId)).toBe("approved");
    const approved = await auditRows("use-case-approved", f.useCaseId);
    expect(approved).toHaveLength(1);
    expect((approved[0]!.detail as { aiBomSnapshotsDue?: unknown }).aiBomSnapshotsDue).toEqual([{ subjectKind: "use_case", subjectId: f.useCaseId }]);
    const resynced = await auditRows("use-case-resynced", f.useCaseId);
    expect(resynced).toHaveLength(1);
    expect(resynced[0]!.detail).toMatchObject({ from: "proposed", to: "approved", workflowInstanceId: f.instanceId });
    const snaps = (await snapshotsOf(f.useCaseId)).filter((s) => s.trigger === "use_case_approval");
    expect(snaps).toHaveLength(1);
    // no approval on this template: the decision is the completing step (the owner's
    // passing check report), and the approval's lifetime starts THEN, not at the re-sync
    const completion = await completionRow(f.instanceId);
    expect(resynced[0]!.detail).toMatchObject({ resyncedBy: admin.id, approvalId: null, originalApprover: owner.id, originalDecidedAt: completion.at.toISOString() });
    const lifetime = await lifetimeOf(f.useCaseId);
    expect(lifetime.approvedAt!.getTime()).toBe(completion.at.getTime());
    expect(lifetime.decidedAt!.getTime()).toBe(completion.at.getTime());
    expect(lifetime.approvedUntil!.getTime()).toBeGreaterThan(lifetime.approvedAt!.getTime());
    const [record] = await decisionRecords(f.useCaseId);
    expect(record).toMatchObject({ outcome: "approved", decidedBy: owner.id, approvalId: null });
    expect(record!.decidedAt.getTime()).toBe(completion.at.getTime());

    // idempotent: in step now, so nothing moves and nothing is written
    const again = await resync(f.useCaseId);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ status: "approved", resynced: false });
    expect(await auditRows("use-case-approved", f.useCaseId)).toHaveLength(1);
    expect(await auditRows("use-case-resynced", f.useCaseId)).toHaveLength(1);
    expect((await snapshotsOf(f.useCaseId)).filter((s) => s.trigger === "use_case_approval")).toHaveLength(1);
  }, 180_000);

  it("a use case in step with an instance that has not completed is a no-op; one out of step is 409 instance_not_completed", async () => {
    const f = await startInstance("running", CHECK_STAGES("running"));
    // blocked on its questionnaire: the use case at `proposed` is in step
    const inStep = await resync(f.useCaseId);
    expect(inStep.statusCode, inStep.body).toBe(200);
    expect(inStep.json()).toMatchObject({ status: "proposed", resynced: false, instanceStatus: "blocked_on_artifact" });
    // a use case marked under review against an instance waiting on its questionnaire is out of step, and not ours to fix
    await db.update(aiUseCases).set({ status: "under_review" }).where(eq(aiUseCases.id, f.useCaseId));
    const notCompleted = await resync(f.useCaseId);
    expect(notCompleted.statusCode, notCompleted.body).toBe(409);
    expect(notCompleted.json()).toMatchObject({ error: "instance_not_completed" });
    expect(await useCaseStatus(f.useCaseId)).toBe("under_review");
    // no governing instance at all
    const [loose] = await db.insert(aiUseCases).values({
      name: `r25rs-uc-loose-${k.RUN}`, description: "r25rs synthetic", ownerUserId: owner.id, businessContext: "r25rs synthetic",
      intendedAgentIds: [ucAgentId], dataSensitivity: "internal", status: "proposed",
    }).returning({ id: aiUseCases.id });
    const none = await resync(loose!.id);
    expect(none.statusCode, none.body).toBe(409);
    expect(none.json()).toMatchObject({ error: "no_governing_instance" });
    // a DENIED intake is final: the refusal says it can't be re-synced, and why
    const [denied] = await db.insert(workflowInstances).values({
      templateIds: [], definition: { stages: [] }, initiatorUserId: owner.id, change: { description: "r25rs denied", paths: [] }, state: {}, status: "denied",
    }).returning({ id: workflowInstances.id });
    const [deniedCase] = await db.insert(aiUseCases).values({
      name: `r25rs-uc-denied-${k.RUN}`, description: "r25rs synthetic", ownerUserId: owner.id, businessContext: "r25rs synthetic",
      intendedAgentIds: [ucAgentId], dataSensitivity: "internal", status: "under_review", workflowInstanceId: denied!.id,
    }).returning({ id: aiUseCases.id });
    const final = await resync(deniedCase!.id);
    expect(final.statusCode, final.body).toBe(409);
    expect(final.json()).toMatchObject({ error: "instance_not_completed", instanceStatus: "denied" });
    expect(final.json().detail).toMatch(/ended denied\. That is final/);
    expect(final.json().detail).not.toMatch(/drive this instance/);
  }, 180_000);

  it("authz: a non-admin (even the use case's owner) is refused, an unknown id is 404, and the strict step-up is required", async () => {
    const f = await strandUseCase("authz");
    const asOwner = await resync(f.useCaseId, owner.auth);
    expect(asOwner.statusCode, asOwner.body).toBe(403);
    expect(await useCaseStatus(f.useCaseId)).toBe("proposed");
    const unknown = await resync(randomUUID());
    expect(unknown.statusCode, unknown.body).toBe(404);
    // the bootstrap credential names no person, so it cannot apply an approval
    const asBoot = await resync(f.useCaseId, k.BOOT);
    expect(asBoot.statusCode, asBoot.body).toBe(403);
    expect(asBoot.json()).toMatchObject({ error: "bootstrap_cannot_drive" });
    expect(await useCaseStatus(f.useCaseId)).toBe("proposed");
    // under the strict step-up policy: a missing key is refused FIRST (no step-up is
    // asked for, so none is spent), and an admin's API key cannot confirm who is acting
    await restoreStepUp!();
    let strict;
    let strictNoKey;
    try {
      strictNoKey = await withoutKey(() => resync(f.useCaseId, admin.auth));
      strict = await resync(f.useCaseId, admin.auth);
    } finally {
      restoreStepUp = await relaxStepUpForTest(db);
    }
    expect(strictNoKey.statusCode, strictNoKey.body).toBe(409);
    expect(strictNoKey.json()).toMatchObject({ error: "bom_signing_unavailable" });
    expect(strict.statusCode, strict.body).toBe(403);
    expect(strict.json()).toMatchObject({ error: "step_up_required", actionKind: "approval_decide" });
    expect(await useCaseStatus(f.useCaseId)).toBe("proposed");
    // with step-up relaxed, the admin's key re-syncs it
    const ok = await resync(f.useCaseId, admin.auth);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().status).toBe("approved");
  }, 180_000);

  it("touches only the use case it names: another stranded use case stays behind and stays counted", async () => {
    const a = await strandUseCase("iso-a");
    const b = await strandUseCase("iso-b");
    const res = await resync(a.useCaseId);
    expect(res.statusCode, res.body).toBe(200);
    expect(await useCaseStatus(a.useCaseId)).toBe("approved");
    expect(await useCaseStatus(b.useCaseId)).toBe("proposed");
    expect(await auditRows("use-case-resynced", b.useCaseId)).toEqual([]);
    expect((await posture()).sampleUseCaseIds).toContain(b.useCaseId);
    // and b is recovered on its own
    expect((await resync(b.useCaseId)).statusCode).toBe(200);
    expect(await useCaseStatus(b.useCaseId)).toBe("approved");
  }, 180_000);
});

describe("what the re-sync approves is what the workflow approved (PR #355 review)", () => {
  it("PATCH refuses an edit once the instance has completed (409 use_case_locked_instance_completed), and nothing changes", async () => {
    const f = await strandUseCase("patch-lock");
    const [before] = await db.select({ description: aiUseCases.description }).from(aiUseCases).where(eq(aiUseCases.id, f.useCaseId));
    for (const who of [owner.auth, admin.auth]) {
      const res = await k.req("PATCH", `/v1/use-cases/${f.useCaseId}`, who, { description: "r25rs edited after completion" });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toMatchObject({ error: "use_case_locked_instance_completed" });
    }
    const [after] = await db.select({ description: aiUseCases.description }).from(aiUseCases).where(eq(aiUseCases.id, f.useCaseId));
    expect(after!.description).toBe(before!.description);
    expect(await auditRows("use-case-updated", f.useCaseId)).toEqual([]);
    // an edit while the instance is still running is unaffected
    const open = await startInstance("patch-open", CHECK_STAGES("patch-open"));
    const edited = await k.req("PATCH", `/v1/use-cases/${open.useCaseId}`, owner.auth, { description: "r25rs edited while proposed" });
    expect(edited.statusCode, edited.body).toBe(200);
    // and the stranded one is still recoverable
    expect((await resync(f.useCaseId)).statusCode).toBe(200);
  }, 180_000);

  it("the re-sync refuses a use case edited after its instance completed (an edit made before the PATCH lock): 409, nothing changes", async () => {
    const f = await strandUseCase("edited");
    // what a pre-lock PATCH left behind: its audit row, after the completion
    await db.insert(auditLog).values({
      userId: owner.id, objectType: "ai_use_case", objectId: f.useCaseId, detail: { phase: "updated", fields: ["description"] },
      effect: "allow", ruleId: "use-case-updated", ruleChain: [], reason: "r25rs synthetic: an edit after completion",
    });
    const res = await resync(f.useCaseId);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ error: "use_case_edited_after_completion" });
    expect(await useCaseStatus(f.useCaseId)).toBe("proposed");
    expect(await auditRows("use-case-approved", f.useCaseId)).toEqual([]);
    expect(await auditRows("use-case-resynced", f.useCaseId)).toEqual([]);
    // it stays behind (and counted) by design; retire it so it does not crowd the posture sample
    await db.update(aiUseCases).set({ status: "retired", retiredReason: "r25rs cleanup", retiredAt: new Date() }).where(eq(aiUseCases.id, f.useCaseId));
  }, 180_000);

  it("a template with a sign-off: the decision keeps the original approver and approval, and the lifetime starts when it was decided", async () => {
    const f = await startInstance("approved", [
      { id: "intake", type: "trigger" },
      { id: "questionnaire", type: "artifact_generation", output: "r25rs_approved" },
      { id: "signoff", type: "human_approval", approvers: [approver.id] },
      { id: "ci-gate", type: "automated_check", checks: ["ci"] },
    ]);
    const submitted = await k.req("POST", `/v1/workflows/instances/${f.instanceId}/artifacts`, owner.auth, { stageId: "questionnaire", content: "r25rs answers" });
    expect(submitted.statusCode, submitted.body).toBe(201);
    expect(await useCaseStatus(f.useCaseId)).toBe("under_review");
    const [pending] = await db
      .select({ id: approvals.id })
      .from(approvals)
      .where(and(eq(approvals.instanceId, f.instanceId), eq(approvals.status, "pending")));
    const decided = await k.req("POST", `/v1/approvals/${pending!.id}/decide`, approver.auth, { decision: "approved", reason: "r25rs sign-off" });
    expect(decided.statusCode, decided.body).toBe(200);
    // the instance now waits on its check; the use case is still under review
    expect((await instanceRow(f.instanceId)).status).toBe("awaiting_execution");
    const reported = await withoutKey(() => reportPass(f.instanceId));
    expect(reported.statusCode, reported.body).toBe(200);
    expect(reported.json().status).toBe("completed");
    expect(await useCaseStatus(f.useCaseId)).toBe("under_review");
    const [approval] = await db.select().from(approvals).where(eq(approvals.id, pending!.id));
    expect(approval!.decidedBy).toBe(approver.id);

    const res = await resync(f.useCaseId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ from: "under_review", status: "approved", resynced: true });
    const [resynced] = await auditRows("use-case-resynced", f.useCaseId);
    expect(resynced!.userId).toBe(admin.id);
    expect(resynced!.detail).toMatchObject({
      resyncedBy: admin.id,
      approvalId: pending!.id,
      originalApprover: approver.id,
      originalDecidedAt: approval!.decidedAt!.toISOString(),
    });
    const lifetime = await lifetimeOf(f.useCaseId);
    expect(lifetime.approvedAt!.getTime()).toBe(approval!.decidedAt!.getTime());
    expect(lifetime.decidedAt!.getTime()).toBe(approval!.decidedAt!.getTime());
    const [record] = await decisionRecords(f.useCaseId);
    expect(record).toMatchObject({ outcome: "approved", decidedBy: approver.id, approvalId: pending!.id });
    expect(record!.decidedAt.getTime()).toBe(approval!.decidedAt!.getTime());
  }, 180_000);
});

describe("deploy-override mirrors the use case (R25 item 13 follow-up)", () => {
  const DEPLOY_STAGES = () => [
    { id: "intake", type: "trigger" },
    // no such target: the deploy parks at blocked_on_deploy for a manual handoff
    { id: "deploy", type: "deployment", connection: `r25rs-missing-${k.RUN}`, environment: "staging" },
  ];
  it("without a key the clear is refused 409 before anything commits; with a key the completion approves the use case and snapshots it", async () => {
    const f = await startInstance("deploy", DEPLOY_STAGES());
    expect((await instanceRow(f.instanceId)).status).toBe("blocked_on_deploy");
    const before = await instanceFootprint(f.instanceId, f.useCaseId);
    const body = { stageId: "deploy", reason: "r25rs: released by hand" };
    const refused = await withoutKey(() => k.req("POST", `/v1/workflows/instances/${f.instanceId}/deploy-override`, owner.auth, body));
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ error: "bom_signing_unavailable" });
    // nothing moved: not the instance, not its attestation row, not the use case
    expect(await instanceFootprint(f.instanceId, f.useCaseId)).toEqual(before);
    expect(await auditRows("workflow:deploy-override-attested", f.instanceId)).toEqual([]);

    const cleared = await k.req("POST", `/v1/workflows/instances/${f.instanceId}/deploy-override`, owner.auth, body);
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json().status).toBe("completed");
    expect(cleared.json().useCaseSignoffWarning).toBeUndefined();
    expect(await useCaseStatus(f.useCaseId)).toBe("approved");
    expect(await auditRows("workflow:deploy-override-attested", f.instanceId)).toHaveLength(1);
    expect((await snapshotsOf(f.useCaseId)).filter((s) => s.trigger === "use_case_approval")).toHaveLength(1);
  }, 180_000);
});

describe("#352 recheck: refusals on the Idempotency-Key branch and on a template with an executor stage", () => {
  it("a refused artifact submit with an Idempotency-Key: 409, the claim rolls back, and a retry with the same key goes through", async () => {
    const f = await startInstance("idem", [
      { id: "intake", type: "trigger" },
      { id: "questionnaire", type: "artifact_generation", output: "r25rs_idem" },
    ]);
    const before = await instanceFootprint(f.instanceId, f.useCaseId);
    const headers = { ...owner.auth, "idempotency-key": `r25rs-idem-${k.RUN}` };
    const payload = { stageId: "questionnaire", content: "r25rs answers" };
    const claims = () => db.select().from(requestIdempotencyKeys).where(eq(requestIdempotencyKeys.scope, `workflow-artifact:${f.instanceId}`));
    const refused = await withoutKey(() => k.req("POST", `/v1/workflows/instances/${f.instanceId}/artifacts`, headers, payload));
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ error: "bom_signing_unavailable" });
    expect(await claims(), "the key's claim rolled back with the submission").toEqual([]);
    expect(await instanceFootprint(f.instanceId, f.useCaseId)).toEqual(before);

    // the retry with the SAME key is a fresh request, not a replay of the refusal
    const retried = await k.req("POST", `/v1/workflows/instances/${f.instanceId}/artifacts`, headers, payload);
    expect(retried.statusCode, retried.body).toBe(201);
    expect(retried.headers["idempotent-replay"]).toBeUndefined();
    expect(retried.json()).toMatchObject({ version: 1, status: "completed" });
    expect(await useCaseStatus(f.useCaseId)).toBe("approved");
    expect(await claims()).toHaveLength(1);
    // and a third send now replays the stored answer
    const replay = await k.req("POST", `/v1/workflows/instances/${f.instanceId}/artifacts`, headers, payload);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.headers["idempotent-replay"]).toBe("true");
    expect(replay.json().version).toBe(1);
  }, 180_000);

  it("a refused submit on a template with an executor (check) stage: nothing of the instance or its executor moves", async () => {
    const f = await startInstance("exec-submit", [
      { id: "intake", type: "trigger" },
      { id: "ci-gate", type: "automated_check", checks: ["ci"] },
      { id: "questionnaire", type: "artifact_generation", output: "r25rs_exec_submit" },
    ]);
    // the executor stage ran first and waits on its report; the report passes it
    expect((await instanceRow(f.instanceId)).status).toBe("awaiting_execution");
    const passed = await reportPass(f.instanceId);
    expect(passed.statusCode, passed.body).toBe(200);
    expect(passed.json().status).toBe("blocked_on_artifact");
    const before = await instanceFootprint(f.instanceId, f.useCaseId);
    const refused = await withoutKey(() => k.req("POST", `/v1/workflows/instances/${f.instanceId}/artifacts`, owner.auth, { stageId: "questionnaire", content: "r25rs answers" }));
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ error: "bom_signing_unavailable" });
    // the check results, the executor's context, the events, the artifact rows and the audit trail are as they were
    expect(await instanceFootprint(f.instanceId, f.useCaseId)).toEqual(before);
    const ok = await k.req("POST", `/v1/workflows/instances/${f.instanceId}/artifacts`, owner.auth, { stageId: "questionnaire", content: "r25rs answers" });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(await useCaseStatus(f.useCaseId)).toBe("approved");
  }, 180_000);

  it("a refused advance on a template with an executor (check) stage: nothing of the instance or its executor moves", async () => {
    const f = await startInstance("exec-advance", [
      { id: "intake", type: "trigger" },
      { id: "ci-gate", type: "automated_check", checks: ["ci"] },
      { id: "build", type: "automated_build" },
    ]);
    const passed = await reportPass(f.instanceId);
    expect(passed.statusCode, passed.body).toBe(200);
    expect(passed.json().status).toBe("awaiting_trigger");
    const before = await instanceFootprint(f.instanceId, f.useCaseId);
    const refused = await withoutKey(() => k.req("POST", `/v1/workflows/instances/${f.instanceId}/advance`, owner.auth, { stageId: "build" }));
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ error: "bom_signing_unavailable" });
    expect(await instanceFootprint(f.instanceId, f.useCaseId)).toEqual(before);
    const ok = await k.req("POST", `/v1/workflows/instances/${f.instanceId}/advance`, owner.auth, { stageId: "build" });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await useCaseStatus(f.useCaseId)).toBe("approved");
  }, 180_000);
});
