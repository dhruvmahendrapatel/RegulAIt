/**
 * ADR-0084 — the AI vendor registry (the L5 third-party front-door).
 *
 * The load-bearing properties under test:
 *
 *  1. A vendor's status is DECIDED, never written — `approved` only through
 *     the linked assessment instance completing on the one approvals queue,
 *     `rejected` only through a denial (or abort), a PATCH naming `status`
 *     refused by name. Proven non-vacuous the M-002 way during review: no-op
 *     the decide-path sync in app.ts and the approve/deny flips here fail
 *     (documented in ADR-0084).
 *
 *  2. ATTESTED AND MEASURED NEVER BLEND. A vendor's pack-control answers are
 *     recorded with attribution into the vendor's own row — the
 *     `compliance_pack_attestations` table gains NOTHING (delta-asserted),
 *     and the org's own pack evaluation still reports the control
 *     `attestation_required`, never `attested`, after a vendor claim is
 *     recorded. Proven non-vacuous by dropping the attribution during review
 *     and watching the labelling assertions fail.
 *
 *  3. The register's third_party_ai evidence is a QUERY over real vendor
 *     rows — the counts move by exactly the vendors this suite creates and
 *     decides (deltas, M-008).
 *
 * Shares one DB with the other gateway suites (fileParallelism off);
 * everything here is prefixed vnd-. Audit assertions are DELTAS scoped to
 * this suite's own object ids (M-008). The authored pack is deleted in
 * afterAll (M-012) so no later suite sees an extra active framework.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aiVendors,
  and,
  auditLog,
  compliancePackAttestations,
  compliancePackControls,
  compliancePackReports,
  compliancePacks,
  count,
  createDb,
  eq,
  inArray,
  runMigrations,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "vnd-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

/** the framework this suite authors — deliberately NOT one of the seeds, so
 * activating it collides with nothing another suite reads */
const FRAMEWORK = "vnd-internal-standard";

let db: Db;
let app: ReturnType<typeof buildApp>;
let priyaId: string; // the proposer (non-admin)
let priyaAuth: { authorization: string };
let mallAuth: { authorization: string }; // a stranger (non-admin)
let packId: string;

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
    payload: { name: "vnd-key" },
  });
  return { id: user.json().id as string, auth: { authorization: `Bearer ${key.json().token}` } };
}

async function propose(name: string, extra: Record<string, unknown> = {}, auth = priyaAuth) {
  const res = await app.inject({
    method: "POST",
    headers: auth,
    url: "/v1/vendors",
    payload: {
      name,
      description: "a transcription product with AI summarization over our call data",
      category: "ai_feature_vendor",
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

const detailOf = async (id: string, auth = priyaAuth, query = "") =>
  app.inject({ method: "GET", headers: auth, url: `/v1/vendors/${id}${query}` });

/** drive the assessment instance from rest-at-plan to blocked_on_approval —
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
      content:
        "# Vendor AI assessment questionnaire\n\n## 1. What AI the vendor runs\n" +
        "Vendor states: summarization over call transcripts (vendor-supplied answer).",
    },
  });
  expect(art.statusCode).toBe(201);
  expect(art.json()).toMatchObject({ version: 1, status: "blocked_on_approval" });
}

/** the proposer's own pending sign-off row for this instance */
async function pendingSignoff(instanceId: string, auth = priyaAuth) {
  const q = await app.inject({ method: "GET", headers: auth, url: "/v1/approvals?status=pending" });
  return q
    .json()
    .approvals.find(
      (a: { instanceId: string | null; stageId: string | null }) =>
        a.instanceId === instanceId && a.stageId === "signoff",
    );
}

/** drive a proposed vendor all the way to approved */
async function approve(vendor: { id: string; instance: { id: string } }, auth = priyaAuth) {
  await submitQuestionnaire(vendor.instance.id, auth);
  const signoff = await pendingSignoff(vendor.instance.id, auth);
  const approved = await app.inject({
    method: "POST",
    headers: auth,
    url: `/v1/approvals/${signoff.id}/decide`,
    payload: { decision: "approved", reason: "vnd-e2e: self-review acknowledged for the test" },
  });
  expect(approved.statusCode).toBe(200);
}

const auditRows = (vendorId: string, ruleId: string) =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.objectId, vendorId), eq(auditLog.ruleId, ruleId)));

const packAttestationCount = async () => {
  const [row] = await db.select({ n: count() }).from(compliancePackAttestations);
  return row?.n ?? 0;
};

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  const priya = await makeUser("vnd-priya@example.com");
  priyaId = priya.id;
  priyaAuth = priya.auth;
  mallAuth = (await makeUser("vnd-mallory@example.com")).auth;

  // the pack the attested checklist renders — authored as DATA (the ADR-0058
  // discipline) and activated; framework name is this suite's own
  const created = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/compliance/packs",
    payload: {
      framework: FRAMEWORK,
      version: 1,
      title: "vnd internal third-party standard (test pack)",
      description: "authored by the vendor suite; exists nowhere in src/",
      provenance: { source: "authored by the test suite", reviewedBy: null },
      cascadeTag: null,
      controls: [
        {
          controlRef: "vnd:9.2-vendor-risk",
          title: "Vendor and business-partner risks are assessed and managed",
          coverage: "unaddressed",
          collector: "none",
          collectorParams: {},
          minEvidenceCount: 1,
          attestationRequired: true,
          ownerNote: "an organisational control — the org attests from its own process",
        },
        {
          controlRef: "vnd:6.1-access-controls",
          title: "Access to systems is restricted",
          coverage: "enforced",
          collector: "audit_decisions",
          collectorParams: { effect: "deny" },
          minEvidenceCount: 1,
          attestationRequired: false,
          ownerNote: null,
        },
      ],
    },
  });
  expect(created.statusCode).toBe(201);
  packId = created.json().pack.id;
  const activated = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/compliance/packs/${packId}/activate`,
    payload: {},
  });
  expect(activated.statusCode).toBe(200);
});

afterAll(async () => {
  // M-012: this suite activated a pack under its own framework name — remove
  // it (and any attestations/controls) so no later suite sees an extra
  // active framework in the pack list.
  const packIds = (
    await db
      .select({ id: compliancePacks.id })
      .from(compliancePacks)
      .where(eq(compliancePacks.framework, FRAMEWORK))
  ).map((r) => r.id);
  if (packIds.length) {
    await db.delete(compliancePackReports).where(inArray(compliancePackReports.packId, packIds));
    await db
      .delete(compliancePackAttestations)
      .where(inArray(compliancePackAttestations.packId, packIds));
    await db.delete(compliancePackControls).where(inArray(compliancePackControls.packId, packIds));
    await db.delete(compliancePacks).where(inArray(compliancePacks.id, packIds));
  }
  await app.close();
  await db.$client.end();
});

describe("the front door runs on pillar-2 rails", () => {
  it("propose creates the registry row AND a real assessment instance resting at the plan stage", async () => {
    const v = await propose("vnd-rails");
    expect(v.status).toBe("proposed");
    expect(v.workflowInstanceId).toBe(v.instance.id);
    // ADR-0079: the instance RESTS at plan
    expect(v.instance.status).toBe("blocked_on_plan");
    // the questionnaire is an honest blank form — every answer is a claim
    expect(v.questionnaireTemplate).toContain("Vendor AI assessment questionnaire");
    expect(v.questionnaireTemplate).toContain("vendor attestation");
    expect(v.questionnaireTemplate).toContain("Nothing is pre-filled by a model");

    const inst = await app.inject({
      method: "GET",
      headers: priyaAuth,
      url: `/v1/workflows/instances/${v.instance.id}`,
    });
    expect(inst.statusCode).toBe(200);
    expect(
      (inst.json().instance.definition.stages as Array<{ id: string }>).map((s) => s.id),
    ).toEqual(["intake", "plan", "questionnaire", "signoff"]);
  });

  it("the assessment shape is discoverable in the ADR-0077 gallery, and two proposals share ONE minted template", async () => {
    const gallery = await app.inject({
      method: "GET",
      headers: AUTH,
      url: "/v1/workflows/template-gallery",
    });
    expect(gallery.statusCode).toBe(200);
    const entry = (gallery.json().entries as Array<{ galleryId: string; description: string }>).find(
      (e) => e.galleryId === "vendor-ai-assessment",
    );
    expect(entry).toBeTruthy();
    expect(entry!.description).toContain("vendor attestations");

    const a = await propose("vnd-shared-tpl-a");
    const b = await propose("vnd-shared-tpl-b");
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

describe("the lifecycle join (status is decided, never written)", () => {
  it("full e2e: propose -> questionnaire artifact -> under_assessment -> sign-off approves -> vendor approved", async () => {
    const v = await propose("vnd-lifecycle-approve");
    await submitQuestionnaire(v.instance.id);

    const mid = await detailOf(v.id);
    expect(mid.statusCode).toBe(200);
    expect(mid.json().vendor.status).toBe("under_assessment");
    expect(mid.json().questionnaire).toMatchObject({ version: 1 });
    expect(mid.json().questionnaireTemplate).toBeNull();

    const signoff = await pendingSignoff(v.instance.id);
    expect(signoff).toBeTruthy();
    expect(signoff.approverUserId).toBe(priyaId);

    // SoD is inherited, not reimplemented: proposer IS the approver
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
      payload: { decision: "approved", reason: "vnd-e2e: self-review acknowledged for the test" },
    });
    expect(approved.statusCode).toBe(200);

    const after = await detailOf(v.id);
    expect(after.json().vendor.status).toBe("approved");
    expect(after.json().vendor.decidedAt).toBeTruthy();
    expect(after.json().instance.status).toBe("completed");
    const flips = await auditRows(v.id, "vendor-approved");
    expect(flips.length).toBe(1);
    expect(flips[0]!.effect).toBe("allow");
    // the flip's own record says what an approval IS — a sign-off on
    // attested answers, not a verification of them
    expect(flips[0]!.reason).toContain("not a");
    expect(flips[0]!.reason).toContain("verification");
    expect((flips[0]!.detail as { workflowInstanceId: string }).workflowInstanceId).toBe(
      v.instance.id,
    );
  });

  it("denial of the sign-off rejects the vendor", async () => {
    const v = await propose("vnd-lifecycle-deny");
    await submitQuestionnaire(v.instance.id);
    const signoff = await pendingSignoff(v.instance.id);
    const denied = await app.inject({
      method: "POST",
      headers: priyaAuth,
      url: `/v1/approvals/${signoff.id}/decide`,
      payload: { decision: "denied", reason: "vnd-e2e: the attested data flows are unacceptable" },
    });
    expect(denied.statusCode).toBe(200);

    const after = await detailOf(v.id);
    expect(after.json().vendor.status).toBe("rejected");
    expect(after.json().vendor.decidedAt).toBeTruthy();
    const flips = await auditRows(v.id, "vendor-rejected");
    expect(flips.length).toBe(1);
    expect(flips[0]!.effect).toBe("deny");
  });

  it("aborting the assessment instance rejects the vendor (a withdrawn assessment is not approvable)", async () => {
    const v = await propose("vnd-lifecycle-abort");
    const aborted = await app.inject({
      method: "POST",
      headers: priyaAuth,
      url: `/v1/workflows/instances/${v.instance.id}/abort`,
      payload: {},
    });
    expect(aborted.statusCode).toBe(200);
    const after = await detailOf(v.id);
    expect(after.json().vendor.status).toBe("rejected");
  });

  it("a direct status PATCH is refused BY NAME, and the refusal points at the decide path", async () => {
    const v = await propose("vnd-no-direct-status");
    const patched = await app.inject({
      method: "PATCH",
      headers: priyaAuth,
      url: `/v1/vendors/${v.id}`,
      payload: { status: "approved" },
    });
    expect(patched.statusCode).toBe(422);
    expect(patched.json().error).toBe("status_is_decided_not_patched");
    expect(patched.json().detail).toContain("/v1/approvals/:approvalId/decide");
    // control: the row did not move
    const after = await detailOf(v.id);
    expect(after.json().vendor.status).toBe("proposed");

    // legitimate in-flight edits still work — and never touch status
    const edit = await app.inject({
      method: "PATCH",
      headers: priyaAuth,
      url: `/v1/vendors/${v.id}`,
      payload: { description: "sharper description", category: "data_processor" },
    });
    expect(edit.statusCode).toBe(200);
    expect(edit.json().description).toBe("sharper description");
    expect(edit.json().category).toBe("data_processor");
    expect(edit.json().status).toBe("proposed");
  });

  it("a decided vendor is not editable (the record was decided; editing it would change what was assessed)", async () => {
    const v = await propose("vnd-decided-frozen");
    await approve(v);
    const edit = await app.inject({
      method: "PATCH",
      headers: priyaAuth,
      url: `/v1/vendors/${v.id}`,
      payload: { description: "rewrite history" },
    });
    expect(edit.statusCode).toBe(409);
    expect(edit.json().error).toBe("vendor_not_editable");
  });
});

describe("retirement", () => {
  it("retire is admin-only, requires a reason, is audited, and is terminal", async () => {
    const v = await propose("vnd-retire");

    const own = await app.inject({
      method: "POST",
      headers: priyaAuth,
      url: `/v1/vendors/${v.id}/retire`,
      payload: { reason: "trying anyway" },
    });
    expect(own.statusCode).toBe(403);

    const retired = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/vendors/${v.id}/retire`,
      payload: { reason: "vnd-e2e: contract ended; AI features disabled" },
    });
    expect(retired.statusCode).toBe(200);
    expect(retired.json()).toMatchObject({
      status: "retired",
      retiredReason: "vnd-e2e: contract ended; AI features disabled",
    });
    expect(retired.json().retiredAt).toBeTruthy();
    const rows = await auditRows(v.id, "vendor-retired");
    expect(rows.length).toBe(1);
    expect(rows[0]!.reason).toContain("contract ended");

    const again = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/vendors/${v.id}/retire`,
      payload: { reason: "twice" },
    });
    expect(again.statusCode).toBe(409);

    // terminal even against the sync: drive the assessment to completion and
    // the retired vendor does NOT resurrect as approved
    await approve(v);
    const after = await detailOf(v.id, AUTH);
    expect(after.json().vendor.status).toBe("retired");
  });
});

describe("visibility (owner + admin, per the existing self-scoping patterns)", () => {
  it("a stranger cannot read, list, or edit someone else's vendor", async () => {
    const v = await propose("vnd-visibility");
    const read = await detailOf(v.id, mallAuth);
    expect(read.statusCode).toBe(403);

    const list = await app.inject({ method: "GET", headers: mallAuth, url: "/v1/vendors" });
    expect(list.statusCode).toBe(200);
    expect(
      (list.json().vendors as Array<{ id: string }>).find((r) => r.id === v.id),
    ).toBeUndefined();

    const edit = await app.inject({
      method: "PATCH",
      headers: mallAuth,
      url: `/v1/vendors/${v.id}`,
      payload: { description: "not mine" },
    });
    expect(edit.statusCode).toBe(403);

    // admin sees it (fleet view)
    const adminList = await app.inject({ method: "GET", headers: AUTH, url: "/v1/vendors" });
    expect(
      (adminList.json().vendors as Array<{ id: string }>).find((r) => r.id === v.id),
    ).toBeTruthy();
  });

  it("an unknown custom-provider linkage refuses with invalid_reference", async () => {
    const res = await app.inject({
      method: "POST",
      headers: priyaAuth,
      url: "/v1/vendors",
      payload: {
        name: "vnd-bad-provider",
        description: "d",
        category: "model_provider",
        linkedCustomProviderIds: ["00000000-0000-0000-0000-0000000000aa"],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_reference", field: "linkedCustomProviderIds" });
  });

  it("the bootstrap token cannot propose (no identity to own the vendor)", async () => {
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/vendors",
      payload: { name: "vnd-bootstrap", description: "d", category: "integration" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("bootstrap_cannot_propose");
  });
});

describe("ATTESTED AND MEASURED NEVER BLEND (the honesty this feature exists for)", () => {
  it("a vendor answer is recorded with attribution, from the questionnaire — and refused before the questionnaire exists", async () => {
    const v = await propose("vnd-attest");

    // BEFORE the questionnaire artifact exists, there is nothing to
    // attribute an answer to — refused, not defaulted
    const early = await app.inject({
      method: "POST",
      headers: priyaAuth,
      url: `/v1/vendors/${v.id}/attestations`,
      payload: {
        framework: FRAMEWORK,
        controlRef: "vnd:9.2-vendor-risk",
        statement: "vendor claims an annual third-party risk program",
      },
    });
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toBe("questionnaire_not_submitted");

    await submitQuestionnaire(v.instance.id);

    // the compliance_pack_attestations table gains NOTHING from a vendor
    // answer — delta-asserted around the write (M-008)
    const orgAttestationsBefore = await packAttestationCount();

    const rec = await app.inject({
      method: "POST",
      headers: priyaAuth,
      url: `/v1/vendors/${v.id}/attestations`,
      payload: {
        framework: FRAMEWORK,
        controlRef: "vnd:9.2-vendor-risk",
        statement: "vendor claims an annual third-party risk program",
        evidenceRef: "vendor-report-2026-Q2",
      },
    });
    expect(rec.statusCode).toBe(201);
    // THE ATTRIBUTION — who recorded the claim, when, from which
    // questionnaire version, against which pack version. Dropping any of
    // this is what "blending" starts to look like, so it is pinned.
    expect(rec.json().attestation).toMatchObject({
      framework: FRAMEWORK,
      packVersion: 1,
      controlRef: "vnd:9.2-vendor-risk",
      statement: "vendor claims an annual third-party risk program",
      evidenceRef: "vendor-report-2026-Q2",
      recordedByUserId: priyaId,
      questionnaireVersion: 1,
    });
    expect(rec.json().attestation.recordedAt).toBeTruthy();
    // the disclaimer rides the response as a FIELD, not a doc
    expect(rec.json().disclaimer).toContain("not verified by this platform");

    expect(await packAttestationCount()).toBe(orgAttestationsBefore); // delta 0

    // the act is audited on the one trail
    const rows = await auditRows(v.id, "vendor-attestation-recorded");
    expect(rows.length).toBe(1);
    expect((rows[0]!.detail as { controlRef: string }).controlRef).toBe("vnd:9.2-vendor-risk");

    // and the ORG's own pack evaluation is untouched: the
    // attestation-required control still reports attestation_required —
    // never `attested` — because a vendor's claim is not the org's statement
    const evaluated = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/compliance/packs/${packId}/evaluate`,
      payload: { period: "current_quarter", scopeKind: "org", entitlementScope: "org" },
    });
    expect(evaluated.statusCode).toBe(201); // an evaluation stores a report artifact
    const control = (
      evaluated.json().scorecard.controls as Array<{ controlRef: string; status: string }>
    ).find((c) => c.controlRef === "vnd:9.2-vendor-risk");
    expect(control!.status).toBe("attestation_required");
  });

  it("the attested checklist renders the pack's controls read-only, labelled, with the vendor's answers merged", async () => {
    const v = await propose("vnd-checklist");
    await submitQuestionnaire(v.instance.id);
    await app.inject({
      method: "POST",
      headers: priyaAuth,
      url: `/v1/vendors/${v.id}/attestations`,
      payload: {
        framework: FRAMEWORK,
        controlRef: "vnd:6.1-access-controls",
        statement: "vendor claims role-based access with quarterly reviews",
      },
    });

    const detail = await detailOf(v.id, priyaAuth, `?framework=${FRAMEWORK}`);
    expect(detail.statusCode).toBe(200);
    const checklist = detail.json().packChecklist;
    expect(checklist.pack).toMatchObject({ id: packId, version: 1 });
    expect(checklist.disclaimer).toContain("Vendor-attested");
    expect(checklist.disclaimer).toContain("not verified by this platform");
    const refs = (checklist.controls as Array<{ controlRef: string }>).map((c) => c.controlRef);
    expect(refs).toEqual(["vnd:6.1-access-controls", "vnd:9.2-vendor-risk"]);
    const answered = checklist.controls.find(
      (c: { controlRef: string }) => c.controlRef === "vnd:6.1-access-controls",
    );
    expect(answered.vendorAttestation).toMatchObject({
      statement: "vendor claims role-based access with quarterly reviews",
      recordedByUserId: priyaId,
    });
    const unanswered = checklist.controls.find(
      (c: { controlRef: string }) => c.controlRef === "vnd:9.2-vendor-risk",
    );
    expect(unanswered.vendorAttestation).toBeNull();

    // an unknown framework yields an honest empty checklist, not an error
    const none = await detailOf(v.id, priyaAuth, "?framework=vnd-no-such-framework");
    expect(none.json().packChecklist.pack).toBeNull();
    expect(none.json().packChecklist.note).toContain("no active compliance pack");
  });

  it("refuses an unknown control, a claim from the bootstrap token, and a PATCH naming packAttestations", async () => {
    const v = await propose("vnd-attest-refusals");
    await submitQuestionnaire(v.instance.id);

    const badControl = await app.inject({
      method: "POST",
      headers: priyaAuth,
      url: `/v1/vendors/${v.id}/attestations`,
      payload: { framework: FRAMEWORK, controlRef: "vnd:0.0-invented", statement: "s" },
    });
    expect(badControl.statusCode).toBe(400);
    expect(badControl.json().error).toBe("unknown_control_ref");

    // no identity, no attribution, no record
    const boot = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/vendors/${v.id}/attestations`,
      payload: { framework: FRAMEWORK, controlRef: "vnd:9.2-vendor-risk", statement: "s" },
    });
    expect(boot.statusCode).toBe(403);
    expect(boot.json().error).toBe("attribution_requires_identity");

    const patched = await app.inject({
      method: "PATCH",
      headers: priyaAuth,
      url: `/v1/vendors/${v.id}`,
      payload: { packAttestations: [] },
    });
    expect(patched.statusCode).toBe(422);
    expect(patched.json().error).toBe("attestations_are_recorded_not_patched");
  });
});

describe("the register's third_party_ai evidence is a QUERY over real vendor rows", () => {
  it("vendor-assessment counts move by exactly the vendors this test creates and decides (deltas)", async () => {
    // an org-wide third-party risk (no vendor pinned)
    const reg = await app.inject({
      method: "POST",
      headers: priyaAuth,
      url: "/v1/risks",
      payload: {
        title: "vnd-risk-org-wide",
        description: "third-party AI exposure, org-wide",
        category: "third_party_ai",
        likelihood: "medium",
        impact: "high",
      },
    });
    expect(reg.statusCode).toBe(201);
    const riskId = reg.json().id as string;

    const evidenceOf = async () => {
      const res = await app.inject({
        method: "GET",
        headers: priyaAuth,
        url: `/v1/risks/${riskId}`,
      });
      expect(res.statusCode).toBe(200);
      const entry = (
        res.json().evidence.entries as Array<{
          resolver: string;
          kind: string;
          source: string | null;
          queried: string | null;
          measured: {
            total: number;
            proposed: number;
            approved: number;
            decidedInWindow: number;
          } | null;
        }>
      ).find((e) => e.resolver === "vendor_assessments");
      expect(entry).toBeTruthy();
      return entry!;
    };

    const before = await evidenceOf();
    expect(before.kind).toBe("measured");
    expect(before.source).toBe("ai_vendors");
    // the payload itself says what the counts are NOT — verified claims
    expect(before.queried).toContain("vendor attestations");

    // create one vendor: proposed +1
    const v = await propose("vnd-risk-delta");
    const mid = await evidenceOf();
    expect(mid.measured!.total).toBe(before.measured!.total + 1);
    expect(mid.measured!.proposed).toBe(before.measured!.proposed + 1);

    // decide it: approved +1, decidedInWindow +1, proposed back down
    await approve(v);
    const after = await evidenceOf();
    expect(after.measured!.approved).toBe(before.measured!.approved + 1);
    expect(after.measured!.decidedInWindow).toBe(before.measured!.decidedInWindow + 1);
    expect(after.measured!.proposed).toBe(before.measured!.proposed);
  });

  it("a risk pinned to one vendor scopes the counts to that vendor's rows", async () => {
    const v = await propose("vnd-risk-scoped");
    const reg = await app.inject({
      method: "POST",
      headers: priyaAuth,
      url: "/v1/risks",
      payload: {
        title: "vnd-risk-one-vendor",
        description: "this vendor's AI over our call data",
        category: "third_party_ai",
        likelihood: "medium",
        impact: "high",
        vendorId: v.id,
      },
    });
    expect(reg.statusCode).toBe(201);
    const detail = await app.inject({
      method: "GET",
      headers: priyaAuth,
      url: `/v1/risks/${reg.json().id}`,
    });
    const evidence = detail.json().evidence;
    expect(evidence.scope.vendorId).toBe(v.id);
    const entry = evidence.entries.find(
      (e: { resolver: string }) => e.resolver === "vendor_assessments",
    );
    expect(entry.queried).toContain("scoped to this risk's vendor");
    expect(entry.measured).toMatchObject({ total: 1, proposed: 1, approved: 0 });

    // an unknown vendor reference refuses with invalid_reference
    const bad = await app.inject({
      method: "POST",
      headers: priyaAuth,
      url: "/v1/risks",
      payload: {
        title: "vnd-risk-bad-vendor",
        description: "d",
        category: "third_party_ai",
        likelihood: "low",
        impact: "low",
        vendorId: "00000000-0000-0000-0000-0000000000ab",
      },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: "invalid_reference", field: "vendorId" });
  });

  it("the seed library's third_party_ai entry names the vendor registry and its honest limit", async () => {
    const lib = await app.inject({ method: "GET", headers: priyaAuth, url: "/v1/risks/library" });
    const entry = (
      lib.json().library as Array<{ category: string; mitigatingControl: string }>
    ).find((e) => e.category === "third_party_ai");
    expect(entry).toBeTruthy();
    expect(entry!.mitigatingControl).toContain("vendor attestations");
    expect(lib.json().categoryEvidence.third_party_ai).toEqual(["vendor_assessments"]);
  });
});
