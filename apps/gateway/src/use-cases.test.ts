/**
 * ADR-0080 — the AI use-case registry (the L1 pre-build front-door).
 *
 * The load-bearing property under test: a use case's status is DECIDED, never
 * written. `approved` is reachable only through the linked intake instance
 * completing on the one approvals queue; `rejected` only through a denial (or
 * abort); a PATCH naming `status` is refused by name. The lifecycle join is
 * proven non-vacuous the M-002 way during review: no-op the sync hook in
 * app.ts and the e2e flip assertions here fail (documented in ADR-0080).
 *
 * The intake runs on the PILLAR-2 RAILS: the instance rests at the ADR-0079
 * plan stage, the questionnaire is a versioned workflow artifact, and the
 * sign-off inherits the decide endpoint's separation-of-duties guards — the
 * self-review-reason requirement is asserted here as evidence, not mocked
 * around.
 *
 * Shares one DB with the other gateway suites (fileParallelism off);
 * everything here is prefixed uc-. Audit assertions are DELTAS scoped to this
 * suite's own object ids (M-008).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aiUseCases, and, auditLog, createDb, eq, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "uc-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let priyaId: string; // the proposer (non-admin)
let priyaAuth: { authorization: string };
let mallAuth: { authorization: string }; // a stranger (non-admin)

async function makeUser(email: string) {
  const user = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email, displayName: email.split("@")[0] },
  });
  expect(user.statusCode).toBe(201);
  const key = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${user.json().id}/keys`,
    payload: { name: "uc-key" },
  });
  return { id: user.json().id as string, auth: { authorization: `Bearer ${key.json().token}` } };
}

async function propose(name: string, extra: Record<string, unknown> = {}, auth = priyaAuth) {
  const res = await app.inject({
    method: "POST",
    headers: auth,
    url: "/v1/use-cases",
    payload: {
      name,
      description: "summarize inbound support tickets",
      businessContext: "cut first-response time for tier-1 support",
      dataSensitivity: "internal",
      ...extra,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as {
    id: string;
    status: string;
    workflowInstanceId: string;
    instance: { id: string; status: string };
    questionnaireTemplate: string;
  };
}

const detailOf = async (id: string, auth = priyaAuth) =>
  app.inject({ method: "GET", headers: auth, url: `/v1/use-cases/${id}` });

/** drive the intake instance from rest-at-plan to blocked_on_approval —
 * the exact workflow endpoints any pillar-2 instance is driven with */
async function submitQuestionnaire(instanceId: string, auth = priyaAuth) {
  const left = await app.inject({
    method: "POST",
    headers: auth,
    url: `/v1/workflows/instances/${instanceId}/advance`,
    payload: { stageId: "plan" },
  });
  expect(left.statusCode).toBe(200);
  expect(left.json().status).toBe("blocked_on_artifact");
  const art = await app.inject({
    method: "POST",
    headers: auth,
    url: `/v1/workflows/instances/${instanceId}/artifacts`,
    payload: {
      stageId: "questionnaire",
      content: "# AI use-case intake questionnaire\n\n## 1. Purpose\nFilled by the proposer.",
    },
  });
  expect(art.statusCode).toBe(201);
  expect(art.json()).toMatchObject({ version: 1, status: "blocked_on_approval" });
}

/** the proposer's own pending sign-off row for this instance (the intake
 * template resolves requesting_user to the initiator) */
async function pendingSignoff(instanceId: string, auth = priyaAuth) {
  const q = await app.inject({ method: "GET", headers: auth, url: "/v1/approvals?status=pending" });
  return q
    .json()
    .approvals.find(
      (a: { instanceId: string | null; stageId: string | null }) =>
        a.instanceId === instanceId && a.stageId === "signoff",
    );
}

const auditRows = (useCaseId: string, ruleId: string) =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.objectId, useCaseId), eq(auditLog.ruleId, ruleId)));

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  const priya = await makeUser("uc-priya@example.com");
  priyaId = priya.id;
  priyaAuth = priya.auth;
  mallAuth = (await makeUser("uc-mallory@example.com")).auth;
});

afterAll(async () => {
  // M-012: the cascade test writes a shared compliance profile — neutralize it
  // (no required templates, weakest pii mode) so no later suite inherits a
  // block-mode cascade from this one. Same idiom as template-gallery.test.ts.
  await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/compliance/profiles",
    payload: {
      tag: "uc-cascade-tag",
      requiredTemplateIds: [],
      piiMode: "log",
      mcpDefaultMode: "read_write",
      auditRetentionDays: null,
    },
  });
  await app.close();
  await db.$client.end();
});

describe("the front door runs on pillar-2 rails", () => {
  it("propose creates the registry row AND a real intake instance resting at the plan stage", async () => {
    const uc = await propose("uc-rails");
    expect(uc.status).toBe("proposed");
    expect(uc.workflowInstanceId).toBe(uc.instance.id);
    // ADR-0079: the instance RESTS at plan — the refinement stage is real
    expect(uc.instance.status).toBe("blocked_on_plan");
    // the questionnaire is a FORM, delivered blank — no fake AI pre-fill
    expect(uc.questionnaireTemplate).toContain("intake questionnaire");
    expect(uc.questionnaireTemplate).toContain("Nothing below is pre-filled by a model");

    // the instance is an ordinary pillar-2 instance, visible through the
    // ordinary instance endpoint, built from the intake template
    const inst = await app.inject({
      method: "GET",
      headers: priyaAuth,
      url: `/v1/workflows/instances/${uc.instance.id}`,
    });
    expect(inst.statusCode).toBe(200);
    expect(
      (inst.json().instance.definition.stages as Array<{ id: string }>).map((s) => s.id),
    ).toEqual(["intake", "plan", "questionnaire", "signoff"]);
  });

  it("the intake shape is discoverable in the ADR-0077 template gallery, and two proposals share ONE minted template", async () => {
    const gallery = await app.inject({
      method: "GET",
      headers: AUTH,
      url: "/v1/workflows/template-gallery",
    });
    expect(gallery.statusCode).toBe(200);
    const entry = (gallery.json().entries as Array<{ galleryId: string }>).find(
      (e) => e.galleryId === "ai-use-case-intake",
    );
    expect(entry).toBeTruthy();

    const a = await propose("uc-shared-tpl-a");
    const b = await propose("uc-shared-tpl-b");
    const [ia, ib] = await Promise.all(
      [a.instance.id, b.instance.id].map(async (id) => {
        const r = await app.inject({
          method: "GET",
          headers: priyaAuth,
          url: `/v1/workflows/instances/${id}`,
        });
        return r.json().instance.templateIds as string[];
      }),
    );
    expect(ia).toEqual(ib); // find-or-create, not mint-per-proposal
  });
});

describe("the lifecycle join (the anti-Credo move: status is decided, never written)", () => {
  it("full e2e: propose -> questionnaire artifact -> under_review -> sign-off approves -> use case approved", async () => {
    const uc = await propose("uc-lifecycle-approve");
    await submitQuestionnaire(uc.instance.id);

    // submitting the questionnaire moved the use case to under_review
    const mid = await detailOf(uc.id);
    expect(mid.statusCode).toBe(200);
    expect(mid.json().useCase.status).toBe("under_review");
    // the submitted questionnaire is the detail's artifact now, not the blank
    expect(mid.json().questionnaire).toMatchObject({ version: 1 });
    expect(mid.json().questionnaireTemplate).toBeNull();

    const signoff = await pendingSignoff(uc.instance.id);
    expect(signoff).toBeTruthy();
    expect(signoff.approverUserId).toBe(priyaId);

    // SoD is inherited, not reimplemented: the proposer IS the approver
    // (requesting_user), so deciding without a reason refuses
    const bare = await app.inject({
      method: "POST",
      headers: priyaAuth,
      url: `/v1/approvals/${signoff.id}/decide`,
      payload: { decision: "approved" },
    });
    expect(bare.statusCode).toBe(400);
    expect(bare.json().error).toBe("self_review_reason_required");

    const approved = await app.inject({
      method: "POST",
      headers: priyaAuth,
      url: `/v1/approvals/${signoff.id}/decide`,
      payload: { decision: "approved", reason: "uc-e2e: self-review acknowledged for the test" },
    });
    expect(approved.statusCode).toBe(200);

    const after = await detailOf(uc.id);
    expect(after.json().useCase.status).toBe("approved");
    expect(after.json().useCase.decidedAt).toBeTruthy();
    expect(after.json().instance.status).toBe("completed"); // the linked workflow completed
    const flips = await auditRows(uc.id, "use-case-approved");
    expect(flips.length).toBe(1);
    expect(flips[0]!.effect).toBe("allow");
    expect((flips[0]!.detail as { workflowInstanceId: string }).workflowInstanceId).toBe(
      uc.instance.id,
    );
  });

  it("denial of the sign-off rejects the use case", async () => {
    const uc = await propose("uc-lifecycle-deny");
    await submitQuestionnaire(uc.instance.id);
    const signoff = await pendingSignoff(uc.instance.id);
    const denied = await app.inject({
      method: "POST",
      headers: priyaAuth,
      url: `/v1/approvals/${signoff.id}/decide`,
      payload: { decision: "denied", reason: "uc-e2e: not a governed use of AI" },
    });
    expect(denied.statusCode).toBe(200);

    const after = await detailOf(uc.id);
    expect(after.json().useCase.status).toBe("rejected");
    expect(after.json().useCase.decidedAt).toBeTruthy();
    const flips = await auditRows(uc.id, "use-case-rejected");
    expect(flips.length).toBe(1);
    expect(flips[0]!.effect).toBe("deny");
  });

  it("aborting the intake instance rejects the use case (a withdrawn proposal is not approvable)", async () => {
    const uc = await propose("uc-lifecycle-abort");
    const aborted = await app.inject({
      method: "POST",
      headers: priyaAuth,
      url: `/v1/workflows/instances/${uc.instance.id}/abort`,
      payload: {},
    });
    expect(aborted.statusCode).toBe(200);
    const after = await detailOf(uc.id);
    expect(after.json().useCase.status).toBe("rejected");
  });

  it("a direct status PATCH is refused BY NAME, and the refusal points at the decide path", async () => {
    const uc = await propose("uc-no-direct-status");
    const patched = await app.inject({
      method: "PATCH",
      headers: priyaAuth,
      url: `/v1/use-cases/${uc.id}`,
      payload: { status: "approved" },
    });
    expect(patched.statusCode).toBe(422);
    expect(patched.json().error).toBe("status_is_decided_not_patched");
    expect(patched.json().detail).toContain("/v1/approvals/:approvalId/decide");
    // control: the row did not move
    const after = await detailOf(uc.id);
    expect(after.json().useCase.status).toBe("proposed");

    // legitimate in-flight edits still work — and never touch status
    const edit = await app.inject({
      method: "PATCH",
      headers: priyaAuth,
      url: `/v1/use-cases/${uc.id}`,
      payload: { description: "sharper description" },
    });
    expect(edit.statusCode).toBe(200);
    expect(edit.json().description).toBe("sharper description");
    expect(edit.json().status).toBe("proposed");
  });

  it("a decided use case is not editable (the record was decided; editing it would change what was approved)", async () => {
    const uc = await propose("uc-decided-frozen");
    await submitQuestionnaire(uc.instance.id);
    const signoff = await pendingSignoff(uc.instance.id);
    await app.inject({
      method: "POST",
      headers: priyaAuth,
      url: `/v1/approvals/${signoff.id}/decide`,
      payload: { decision: "approved", reason: "uc-e2e: self-review acknowledged" },
    });
    const edit = await app.inject({
      method: "PATCH",
      headers: priyaAuth,
      url: `/v1/use-cases/${uc.id}`,
      payload: { description: "rewrite history" },
    });
    expect(edit.statusCode).toBe(409);
    expect(edit.json().error).toBe("use_case_not_editable");
  });
});

describe("retirement", () => {
  it("retire is admin-only, requires a reason, is audited, and is terminal", async () => {
    const uc = await propose("uc-retire");

    // the owner cannot retire — taking a use case out of service is an org act
    const own = await app.inject({
      method: "POST",
      headers: priyaAuth,
      url: `/v1/use-cases/${uc.id}/retire`,
      payload: { reason: "trying anyway" },
    });
    expect(own.statusCode).toBe(403);

    const retired = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/use-cases/${uc.id}/retire`,
      payload: { reason: "uc-e2e: superseded by a narrower use case" },
    });
    expect(retired.statusCode).toBe(200);
    expect(retired.json()).toMatchObject({
      status: "retired",
      retiredReason: "uc-e2e: superseded by a narrower use case",
    });
    expect(retired.json().retiredAt).toBeTruthy();
    const rows = await auditRows(uc.id, "use-case-retired");
    expect(rows.length).toBe(1);
    expect(rows[0]!.reason).toContain("superseded by a narrower use case");

    const again = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/use-cases/${uc.id}/retire`,
      payload: { reason: "twice" },
    });
    expect(again.statusCode).toBe(409);

    // terminal even against the sync: drive the intake to completion and the
    // retired use case does NOT resurrect as approved
    await submitQuestionnaire(uc.instance.id);
    const signoff = await pendingSignoff(uc.instance.id);
    const approved = await app.inject({
      method: "POST",
      headers: priyaAuth,
      url: `/v1/approvals/${signoff.id}/decide`,
      payload: { decision: "approved", reason: "uc-e2e: self-review acknowledged" },
    });
    expect(approved.statusCode).toBe(200);
    const after = await detailOf(uc.id, AUTH);
    expect(after.json().useCase.status).toBe("retired");
  });
});

describe("visibility (owner + admin, per the existing self-scoping patterns)", () => {
  it("a stranger cannot read, list, or edit someone else's use case", async () => {
    const uc = await propose("uc-visibility");
    const read = await detailOf(uc.id, mallAuth);
    expect(read.statusCode).toBe(403);

    const list = await app.inject({ method: "GET", headers: mallAuth, url: "/v1/use-cases" });
    expect(list.statusCode).toBe(200);
    expect(
      (list.json().useCases as Array<{ id: string }>).find((r) => r.id === uc.id),
    ).toBeUndefined();

    const edit = await app.inject({
      method: "PATCH",
      headers: mallAuth,
      url: `/v1/use-cases/${uc.id}`,
      payload: { description: "not mine" },
    });
    expect(edit.statusCode).toBe(403);

    // admin sees it (fleet view)
    const adminList = await app.inject({ method: "GET", headers: AUTH, url: "/v1/use-cases" });
    expect(
      (adminList.json().useCases as Array<{ id: string }>).find((r) => r.id === uc.id),
    ).toBeTruthy();
  });
});

describe("the cascade-consequences card is DERIVED from the real cascade rules", () => {
  it("an invented tag's profile appears in the card the moment the profile exists, and a project names which tags actually bind", async () => {
    const TAG = "uc-cascade-tag";
    // control FIRST: without a profile, the tag is honestly unrecognized
    const before = await propose("uc-cascade-before", { complianceTags: [TAG] });
    const beforeCard = (await detailOf(before.id)).json().cascadeConsequences;
    expect(beforeCard.unrecognizedTags).toContain(TAG);
    expect(
      (beforeCard.profiles as Array<{ tag: string }>).find((p) => p.tag === TAG),
    ).toBeUndefined();

    // a required template + profile for the tag — the SAME rules the cascade enforces
    const tpl = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/workflows/templates",
      payload: {
        name: "uc-cascade-gate",
        definition: {
          workflow: "uc-cascade-gate",
          stages: [
            { id: "uc-gate-intake", type: "trigger" },
            { id: "uc-sec-review", type: "human_approval", approvers: ["requesting_user"] },
          ],
        },
      },
    });
    expect(tpl.statusCode).toBe(201);
    const profile = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/compliance/profiles",
      payload: { tag: TAG, requiredTemplateIds: [tpl.json().id], piiMode: "block" },
    });
    expect(profile.statusCode).toBe(201);

    // a project CARRYING the tag vs the use case's own tag list
    const project = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/projects",
      payload: { name: "uc-cascade-project", classifications: [TAG] },
    });
    expect(project.statusCode).toBe(201);

    const uc = await propose("uc-cascade-after", {
      complianceTags: [TAG, "uc-unwritten-tag"],
      projectId: project.json().id,
    });
    const card = (await detailOf(uc.id)).json().cascadeConsequences;
    const prof = (
      card.profiles as Array<{ tag: string; piiMode: string; requiredTemplates: Array<{ name: string; stageIds: string[] }> }>
    ).find((p) => p.tag === TAG);
    expect(prof).toBeTruthy(); // derived live — a stored copy could not contain it
    expect(prof!.piiMode).toBe("block");
    expect(prof!.requiredTemplates.map((t) => t.name)).toContain("uc-cascade-gate");
    expect(card.combined.forcedStageIds).toContain("uc-sec-review");
    expect(card.unrecognizedTags).toEqual(["uc-unwritten-tag"]);
    // the project half: which of the tags the cascade is enforcing THERE
    expect(card.project.tagsCarried).toEqual([TAG]);
    expect(card.project.tagsNotCarried).toEqual(["uc-unwritten-tag"]);
  });
});

describe("input validation", () => {
  it("an unknown project or agent reference refuses with invalid_reference", async () => {
    const badProject = await app.inject({
      method: "POST",
      headers: priyaAuth,
      url: "/v1/use-cases",
      payload: {
        name: "uc-bad-project",
        description: "d",
        businessContext: "b",
        dataSensitivity: "internal",
        projectId: "00000000-0000-4000-8000-0000000000aa",
      },
    });
    expect(badProject.statusCode).toBe(400);
    expect(badProject.json()).toMatchObject({ error: "invalid_reference", field: "projectId" });

    const badAgent = await app.inject({
      method: "POST",
      headers: priyaAuth,
      url: "/v1/use-cases",
      payload: {
        name: "uc-bad-agent",
        description: "d",
        businessContext: "b",
        dataSensitivity: "internal",
        intendedAgentIds: ["00000000-0000-4000-8000-0000000000ab"],
      },
    });
    expect(badAgent.statusCode).toBe(400);
    expect(badAgent.json()).toMatchObject({ error: "invalid_reference", field: "intendedAgentIds" });
  });

  it("the bootstrap token cannot propose (no identity to own the use case)", async () => {
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/use-cases",
      payload: {
        name: "uc-bootstrap",
        description: "d",
        businessContext: "b",
        dataSensitivity: "internal",
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("bootstrap_cannot_propose");
  });
});
