/**
 * ADR-0085 — EU AI Act risk-tier screening on the use-case intake (gap L10).
 *
 * The load-bearing properties under test, end to end on the real rails:
 *
 *  - THE TIER IS COMPUTED SERVER-SIDE, FROM THE ANSWERS, ON SUBMIT. The
 *    questionnaire artifact's `eu-ai-act-answers` block is the only input;
 *    submitting stores tier + firing reasons + rule-set version on the use
 *    case, re-submission recomputes, and no block means NO tier — never a
 *    guessed one.
 *  - A SUBMITTED TIER IS REFUSED AT EVERY DOOR: a PATCH naming the tier
 *    columns 422s by name, and an answers block smuggling a `tier` key is
 *    invalid (screening cleared, not honoured).
 *  - NOTHING AUTO-BLOCKS. A `prohibited` use case can still be decided by
 *    the human sign-off — the tier informs the decision, the decide path is
 *    byte-identical (the ADR-0080 honesty, restated as an assertion).
 *  - THE CASCADE ENDING IS DERIVED LIVE (the ADR-0080 way): the high-tier
 *    recommendation reflects the ACTIVE eu-ai-act packs and the org's REAL
 *    §8.3 profiles at read time — creating a profile changes the next read,
 *    which a stored copy could never do.
 *
 * Shares one DB with the other gateway suites (fileParallelism off);
 * everything here is prefixed uct-. Audit assertions are DELTAS scoped to
 * this suite's own object ids (M-008).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aiUseCases,
  and,
  auditLog,
  compliancePackControls,
  compliancePacks,
  createDb,
  eq,
  inArray,
  runMigrations,
  type Db,
} from "@regulait/db";
import { renderEuAiActAnswersBlock, type EuAiActAnswers } from "@regulait/shared";
import { buildApp } from "./app.js";
import { installLicenseFixture, removeLicenseFixture } from "./testing/license-fixture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "uct-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const EU_TAG = "uct-eu-hr-tag";

let db: Db;
let app: ReturnType<typeof buildApp>;
let priyaAuth: { authorization: string };

/** nothing fires from here — perturbed per test */
const baseline: EuAiActAnswers = {
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
const answers = (over: Partial<EuAiActAnswers>): EuAiActAnswers => ({ ...baseline, ...over });

const questionnaireContent = (block?: string) =>
  "# AI use-case intake questionnaire\n\n## 1. Purpose\nFilled by the proposer." +
  (block ? `\n\n## 9. EU AI Act risk screening\n\n${block}` : "");

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
    payload: { name: "uct-key" },
  });
  return { id: user.json().id as string, auth: { authorization: `Bearer ${key.json().token}` } };
}

async function propose(name: string, extra: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST",
    headers: priyaAuth,
    url: "/v1/use-cases",
    payload: {
      name,
      description: "screen inbound resumes",
      businessContext: "cut time-to-shortlist",
      dataSensitivity: "internal",
      ...extra,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as {
    id: string;
    workflowInstanceId: string;
    instance: { id: string };
    questionnaireTemplate: string;
  };
}

const detailOf = async (id: string) =>
  app.inject({ method: "GET", headers: priyaAuth, url: `/v1/use-cases/${id}` });

/** drive plan → artifact, then submit the given questionnaire content */
async function submitQuestionnaire(instanceId: string, content: string, expectVersion = 1) {
  if (expectVersion === 1) {
    const left = await app.inject({
      method: "POST",
      headers: priyaAuth,
      url: `/v1/workflows/instances/${instanceId}/advance`,
      payload: { stageId: "plan" },
    });
    expect(left.statusCode).toBe(200);
    expect(left.json().status).toBe("blocked_on_artifact");
  }
  const art = await app.inject({
    method: "POST",
    headers: priyaAuth,
    url: `/v1/workflows/instances/${instanceId}/artifacts`,
    payload: { stageId: "questionnaire", content },
  });
  expect(art.statusCode).toBe(201);
  expect(art.json()).toMatchObject({ version: expectVersion, status: "blocked_on_approval" });
}

async function pendingSignoff(instanceId: string) {
  const q = await app.inject({ method: "GET", headers: priyaAuth, url: "/v1/approvals?status=pending" });
  return q
    .json()
    .approvals.find(
      (a: { instanceId: string | null; stageId: string | null }) =>
        a.instanceId === instanceId && a.stageId === "signoff",
    );
}

const screeningAudits = (useCaseId: string) =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.objectId, useCaseId), eq(auditLog.ruleId, "use-case-eu-tier")));

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  // ADR-0052 §4: pack ACTIVATION is now tier-gated on `compliance_packs` —
  // run under a real signed license granting it (removed in afterAll; the
  // deployment ends UNLICENSED as it started).
  await installLicenseFixture(app, { features: ["compliance_packs"], auth: AUTH });
  priyaAuth = (await makeUser("uct-priya@example.com")).auth;
});

afterAll(async () => {
  // M-012, both knobs this suite turned:
  //  - the activated uct- eu-ai-act pack (and its controls) is removed so no
  //    later suite sees an extra active eu-ai-act pack (vendors.test.ts idiom);
  //  - the §8.3 profile written for EU_TAG is neutralized (weakest posture,
  //    no required templates) exactly like use-cases.test.ts does for its tag.
  const packIds = (
    await db
      .select({ id: compliancePacks.id })
      .from(compliancePacks)
      .where(and(eq(compliancePacks.framework, "eu-ai-act"), eq(compliancePacks.version, 999)))
  ).map((r) => r.id);
  if (packIds.length) {
    await db.delete(compliancePackControls).where(inArray(compliancePackControls.packId, packIds));
    await db.delete(compliancePacks).where(inArray(compliancePacks.id, packIds));
  }
  await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/compliance/profiles",
    payload: {
      tag: EU_TAG,
      requiredTemplateIds: [],
      piiMode: "log",
      mcpDefaultMode: "read_write",
      auditRetentionDays: null,
    },
  });
  await removeLicenseFixture(db);
  await app.close();
  await db.$client.end();
});

describe("the tier is computed server-side from the answers block, on submit", () => {
  it("the blank questionnaire carries the screening section; no answers block → no tier, honestly", async () => {
    const uc = await propose("uct-no-block");
    expect(uc.questionnaireTemplate).toContain("EU AI Act risk screening");
    expect(uc.questionnaireTemplate).toContain("SERVER-SIDE");
    expect(uc.questionnaireTemplate).toContain("eu-ai-act-answers");

    await submitQuestionnaire(uc.instance.id, questionnaireContent());
    const d = (await detailOf(uc.id)).json();
    expect(d.useCase.euAiActTier).toBeNull();
    expect(d.useCase.euAiActReasons).toBeNull();
    expect(d.useCase.euAiActRulesetVersion).toBeNull();
    expect(d.euAiActScreening.tier).toBeNull();
    expect(d.euAiActScreening.answersStatus).toBe("missing");
    expect(d.euAiActScreening.cascade).toBeNull();
    // the disclaimer and the no-auto-block posture ride the read regardless
    expect(d.euAiActScreening.disclaimer).toContain("not legal advice");
    expect(d.euAiActScreening.enforcement).toContain("nothing is auto-blocked");
    // no screening flip happened, so no screening audit row (delta, M-008)
    expect((await screeningAudits(uc.id)).length).toBe(0);
  });

  it("social scoring → prohibited, stored with the Art. 5 reason, the rule-set version, the refusal text — and re-submission recomputes", async () => {
    const uc = await propose("uct-prohibited-then-high");
    await submitQuestionnaire(
      uc.instance.id,
      questionnaireContent(renderEuAiActAnswersBlock(answers({ socialScoring: true }))),
    );
    let d = (await detailOf(uc.id)).json();
    expect(d.useCase.euAiActTier).toBe("prohibited");
    expect(d.useCase.euAiActRulesetVersion).toBe(1);
    const refs = (d.useCase.euAiActReasons as Array<{ ref: string; ruleId: string }>).map((r) => r.ref);
    expect(refs).toContain("Art. 5(1)(c)");
    expect(d.euAiActScreening.tier).toBe("prohibited");
    expect(d.euAiActScreening.refusal).toContain("PROHIBITED");
    expect(d.euAiActScreening.refusal).toContain("does not auto-block");
    expect((await screeningAudits(uc.id)).length).toBe(1);

    // versioned re-approval: v2 answers replace v1's — the tier FOLLOWS
    await submitQuestionnaire(
      uc.instance.id,
      questionnaireContent(
        renderEuAiActAnswersBlock(
          answers({ purposeDomain: "employment-hr", decisionAutonomy: "fully-automated" }),
        ),
      ),
      2,
    );
    d = (await detailOf(uc.id)).json();
    expect(d.useCase.euAiActTier).toBe("high");
    expect(
      (d.useCase.euAiActReasons as Array<{ ref: string }>).map((r) => r.ref),
    ).toContain("Annex III 4");
    expect(d.euAiActScreening.refusal).toBeNull();
    const audits = await screeningAudits(uc.id);
    expect(audits.length).toBe(2);
    expect((audits.at(-1)!.detail as { artifactVersion: number }).artifactVersion).toBe(2);
  });

  it("a minimal-tier screening stores minimal with an EMPTY reasons list — and no cascade ending", async () => {
    const uc = await propose("uct-minimal");
    await submitQuestionnaire(
      uc.instance.id,
      questionnaireContent(renderEuAiActAnswersBlock(baseline)),
    );
    const d = (await detailOf(uc.id)).json();
    expect(d.useCase.euAiActTier).toBe("minimal");
    expect(d.useCase.euAiActReasons).toEqual([]);
    expect(d.euAiActScreening.cascade).toBeNull();
  });
});

describe("a submitted tier is refused at every door", () => {
  it("a PATCH naming the tier columns is refused BY NAME, pointing at the answers block", async () => {
    const uc = await propose("uct-no-patch");
    const patched = await app.inject({
      method: "PATCH",
      headers: priyaAuth,
      url: `/v1/use-cases/${uc.id}`,
      payload: { euAiActTier: "minimal" },
    });
    expect(patched.statusCode).toBe(422);
    expect(patched.json().error).toBe("eu_tier_is_computed_not_patched");
    expect(patched.json().detail).toContain("eu-ai-act-answers");
    // control: the row did not move
    expect((await detailOf(uc.id)).json().useCase.euAiActTier).toBeNull();
  });

  it("an answers block smuggling a `tier` key is invalid — screening cleared, never honoured", async () => {
    const uc = await propose("uct-smuggled-tier");
    const block =
      "```eu-ai-act-answers\n" +
      JSON.stringify({ ...answers({ socialScoring: true }), tier: "minimal" }) +
      "\n```";
    await submitQuestionnaire(uc.instance.id, questionnaireContent(block));
    const d = (await detailOf(uc.id)).json();
    expect(d.useCase.euAiActTier).toBeNull();
    expect(d.euAiActScreening.answersStatus).toBe("invalid");
    expect(d.euAiActScreening.answersError).toContain("computed server-side");
  });
});

describe("nothing auto-blocks: the tier informs the sign-off, the decide path is unchanged", () => {
  it("a PROHIBITED use case still reaches its human decision — and the tier survives it", async () => {
    const uc = await propose("uct-prohibited-decided");
    await submitQuestionnaire(
      uc.instance.id,
      questionnaireContent(renderEuAiActAnswersBlock(answers({ socialScoring: true }))),
    );
    const signoff = await pendingSignoff(uc.instance.id);
    expect(signoff).toBeTruthy(); // the approval EXISTS — nothing intercepted it
    const decided = await app.inject({
      method: "POST",
      headers: priyaAuth,
      url: `/v1/approvals/${signoff.id}/decide`,
      payload: { decision: "denied", reason: "uct-e2e: prohibited by the screening — refused by a human, which is the design" },
    });
    expect(decided.statusCode).toBe(200);
    const d = (await detailOf(uc.id)).json();
    expect(d.useCase.status).toBe("rejected");
    expect(d.useCase.euAiActTier).toBe("prohibited"); // the record of WHY survives the decision
  });

  it("the inverse holds too: approval of a prohibited use case is NOT refused by the platform (the human owns the call)", async () => {
    const uc = await propose("uct-prohibited-approved");
    await submitQuestionnaire(
      uc.instance.id,
      questionnaireContent(renderEuAiActAnswersBlock(answers({ manipulativeTechniques: true }))),
    );
    const signoff = await pendingSignoff(uc.instance.id);
    const decided = await app.inject({
      method: "POST",
      headers: priyaAuth,
      url: `/v1/approvals/${signoff.id}/decide`,
      payload: { decision: "approved", reason: "uct-e2e: self-review acknowledged — proving no auto-block exists" },
    });
    expect(decided.statusCode).toBe(200);
    const d = (await detailOf(uc.id)).json();
    expect(d.useCase.status).toBe("approved");
    expect(d.useCase.euAiActTier).toBe("prohibited");
  });
});

describe("the cascade ending is DERIVED LIVE from the active eu-ai-act packs and the real §8.3 profiles", () => {
  it("high tier: the recommendation appears with the pack, tracks profile creation, and cites controls read-only", async () => {
    const uc = await propose("uct-cascade-high");
    await submitQuestionnaire(
      uc.instance.id,
      questionnaireContent(
        renderEuAiActAnswersBlock(
          answers({ purposeDomain: "essential-services", decisionAutonomy: "fully-automated" }),
        ),
      ),
    );

    // control FIRST: before OUR pack exists, our tag is not recommended
    let cascade = (await detailOf(uc.id)).json().euAiActScreening.cascade;
    expect(cascade).toBeTruthy(); // high tier always carries the cascade ending
    expect(
      (cascade.recommendedTags as Array<{ tag: string }>).map((t) => t.tag),
    ).not.toContain(EU_TAG);

    // an ACTIVE eu-ai-act pack whose cascadeTag is ours
    const pack = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/compliance/packs",
      payload: {
        framework: "eu-ai-act",
        version: 999,
        title: "uct: EU AI Act high-risk obligations",
        description: "test pack for the ADR-0085 cascade ending",
        provenance: { source: "uct test", catalogueRevision: "n/a", reviewedBy: null, reviewedOn: null, note: "test" },
        cascadeTag: EU_TAG,
        controls: [
          {
            controlRef: "eu-ai-act:art-14-human-oversight",
            title: "Human oversight",
            coverage: "enforced",
            collector: "approvals",
            collectorParams: { status: "approved" },
            minEvidenceCount: 1,
            attestationRequired: false,
          },
        ],
      },
    });
    expect(pack.statusCode).toBe(201);
    const activated = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/compliance/packs/${pack.json().pack.id}/activate`,
      payload: {},
    });
    expect(activated.statusCode).toBe(200);

    // the SAME read now recommends the tag — derived live, no resubmission
    cascade = (await detailOf(uc.id)).json().euAiActScreening.cascade;
    const rec = (
      cascade.recommendedTags as Array<{ tag: string; profileExists: boolean; carriedByUseCase: boolean }>
    ).find((t) => t.tag === EU_TAG);
    expect(rec).toBeTruthy();
    expect(rec!.profileExists).toBe(false); // no §8.3 profile yet — said, not hidden
    expect(rec!.carriedByUseCase).toBe(false);
    const ourPack = (
      cascade.packs as Array<{ cascadeTag: string | null; controls: Array<{ controlRef: string }> }>
    ).find((p) => p.cascadeTag === EU_TAG);
    expect(ourPack!.controls.map((c) => c.controlRef)).toContain("eu-ai-act:art-14-human-oversight");

    // write the §8.3 profile → the NEXT read flips profileExists. A stored
    // copy could not do this; that is the whole point (ADR-0077 rule 1).
    const profile = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/compliance/profiles",
      payload: { tag: EU_TAG, requiredTemplateIds: [], piiMode: "block" },
    });
    expect(profile.statusCode).toBe(201);
    cascade = (await detailOf(uc.id)).json().euAiActScreening.cascade;
    expect(
      (cascade.recommendedTags as Array<{ tag: string; profileExists: boolean }>).find(
        (t) => t.tag === EU_TAG,
      )!.profileExists,
    ).toBe(true);
  });
});
