/**
 * ADR-0171 — AER-050 (drafts + idempotent creation), AER-052 (framework
 * rationales) and AER-053 ("Not sure" answers), through the real routes on a
 * real database.
 *
 *  AER-050  GET/PUT/DELETE /v1/use-cases/draft keep the CALLER'S OWN draft per
 *           scope (`new` or a use case they may edit); 413 over 256 KiB; drafts
 *           untouched for 30 days are pruned. POST /v1/use-cases honours an
 *           Idempotency-Key: same caller + key → the original body (200,
 *           `Idempotent-Replay: true`) and ONE use case, even when the
 *           duplicates race; keys are per caller and expire after 24h.
 *  AER-052  `frameworkRationales` is stored on create/PATCH, returned by the
 *           detail read, and refused for a framework the use case does not carry.
 *  AER-053  `unsure` on the Classify answers (create, PATCH) and in the
 *           questionnaire's answers block: every key must be a yes/no answer
 *           that is `true`, else 422 `unsure_answer_must_count_as_yes`. The tier
 *           is computed from the `true`; the detail read lists the unsure keys
 *           and the resubmission prefill carries them back.
 *
 * Shared-database discipline: every fixture carries a run-unique token and is
 * resolved by id; nothing asserts a global count.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aiUseCases,
  and,
  createDb,
  eq,
  runMigrations,
  useCaseDrafts,
  useCaseIdempotencyKeys,
  workflowArtifacts,
  type Db,
} from "@regulait/db";
import { renderEuAiActAnswersBlock, type EuAiActAnswers } from "@regulait/shared";
import { buildApp } from "./app.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `a050-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
type Who = "admin" | "owner" | "other";
const users = {} as Record<Who, { id: string; auth: { authorization: string } }>;
let db: Db;
let app: ReturnType<typeof buildApp>;

const minimal: EuAiActAnswers = {
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
const context = {
  sectors: [],
  dataCategories: ["proprietary"],
  deployment: "internal",
  euNexus: false,
  usesExternalVendor: false,
  generative: false,
  autonomousActions: false,
  toolsUsed: [],
};

const inject = (method: "GET" | "PUT" | "DELETE" | "POST" | "PATCH", url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

const proposalBody = (label: string, extra: Record<string, unknown> = {}) => ({
  name: `a050 ${label} ${RUN}`,
  description: "synthetic ADR-0171 fixture",
  businessContext: "intake durability",
  dataSensitivity: "internal",
  ...extra,
});
const create = (label: string, extra: Record<string, unknown> = {}, who: Who = "owner", headers: Record<string, string> = {}) =>
  inject("POST", "/v1/use-cases", { ...users[who].auth, ...headers }, proposalBody(label, extra));
const rowsNamed = (label: string) =>
  db.select().from(aiUseCases).where(eq(aiUseCases.name, `a050 ${label} ${RUN}`));
const detail = (id: string, who: Who = "owner") => inject("GET", `/v1/use-cases/${id}`, users[who].auth);

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  for (const [k, isAdmin] of [["admin", true], ["owner", false], ["other", false]] as Array<[Who, boolean]>) {
    const u = await inject("POST", "/v1/users", AUTH, { email: `a050-${k}-${RUN}@example.com`, displayName: `a050 ${k}`, isAdmin });
    expect(u.statusCode, u.body).toBe(201);
    const id = u.json().id as string;
    const token = (await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "a050" })).json().token as string;
    users[k] = { id, auth: { authorization: `Bearer ${token}` } };
  }
}, 120_000);

afterAll(async () => {
  app.server.closeAllConnections();
  await app.close();
});

// ===========================================================================
// AER-050 — drafts
// ===========================================================================

describe("AER-050 server-side drafts", () => {
  it("saves, resumes and deletes the caller's own draft — never another user's", async () => {
    const empty = await inject("GET", "/v1/use-cases/draft?scope=new", users.owner.auth);
    expect(empty.statusCode, empty.body).toBe(200);
    expect(empty.json()).toEqual({ draft: null });

    const state = { step: 3, answers: { purpose: `triage ${RUN}` }, idempotencyKey: `k-${RUN}` };
    const put = await inject("PUT", "/v1/use-cases/draft?scope=new", users.owner.auth, { state });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json().draft).toMatchObject({ scope: "new", state });
    expect(typeof put.json().draft.updatedAt).toBe("string");

    // resume after "refresh": the same state comes back
    const got = await inject("GET", "/v1/use-cases/draft?scope=new", users.owner.auth);
    expect(got.json().draft).toEqual(put.json().draft);

    // a save replaces it (one draft per user and scope)
    const next = { ...state, step: 4 };
    expect((await inject("PUT", "/v1/use-cases/draft?scope=new", users.owner.auth, { state: next })).statusCode).toBe(200);
    expect((await inject("GET", "/v1/use-cases/draft?scope=new", users.owner.auth)).json().draft.state).toEqual(next);
    const mine = await db
      .select()
      .from(useCaseDrafts)
      .where(and(eq(useCaseDrafts.userId, users.owner.id), eq(useCaseDrafts.scope, "new")));
    expect(mine).toHaveLength(1);

    // another signed-in user sees only their own (none) — even an admin
    expect((await inject("GET", "/v1/use-cases/draft?scope=new", users.other.auth)).json()).toEqual({ draft: null });
    expect((await inject("GET", "/v1/use-cases/draft?scope=new", users.admin.auth)).json()).toEqual({ draft: null });

    const del = await inject("DELETE", "/v1/use-cases/draft?scope=new", users.owner.auth);
    expect(del.statusCode).toBe(204);
    expect((await inject("GET", "/v1/use-cases/draft?scope=new", users.owner.auth)).json()).toEqual({ draft: null });
  });

  it("refuses a token with no user identity and a malformed scope", async () => {
    const boot = await inject("GET", "/v1/use-cases/draft?scope=new", AUTH);
    expect(boot.statusCode).toBe(403);
    expect(boot.json().error).toBe("drafts_require_identity");
    expect((await inject("PUT", "/v1/use-cases/draft?scope=new", AUTH, { state: {} })).statusCode).toBe(403);
    expect((await inject("GET", "/v1/use-cases/draft?scope=everything", users.owner.auth)).statusCode).toBe(400);
    expect((await inject("GET", "/v1/use-cases/draft", users.owner.auth)).statusCode).toBe(400);
    // state must be a JSON object
    expect((await inject("PUT", "/v1/use-cases/draft?scope=new", users.owner.auth, { state: [1, 2] })).statusCode).toBe(400);
  });

  it("keeps a resubmission draft per use case, only for someone who may edit it", async () => {
    const c = await create("draft-scope");
    expect(c.statusCode, c.body).toBe(201);
    const id = c.json().id as string;
    const url = `/v1/use-cases/draft?scope=${id}`;
    const owner = await inject("PUT", url, users.owner.auth, { state: { resubmitting: true } });
    expect(owner.statusCode, owner.body).toBe(200);
    expect(owner.json().draft.scope).toBe(id);
    // separate from the registration draft
    expect((await inject("GET", "/v1/use-cases/draft?scope=new", users.owner.auth)).json().draft).toBeNull();

    const stranger = await inject("PUT", url, users.other.auth, { state: { x: 1 } });
    expect(stranger.statusCode).toBe(403);
    expect((await inject("GET", url, users.other.auth)).statusCode).toBe(403);
    expect((await inject("DELETE", url, users.other.auth)).statusCode).toBe(403);
    // an admin may edit any use case, so may keep their OWN draft against it
    const admin = await inject("PUT", url, users.admin.auth, { state: { adminDraft: true } });
    expect(admin.statusCode, admin.body).toBe(200);
    expect((await inject("GET", url, users.owner.auth)).json().draft.state).toEqual({ resubmitting: true });

    const missing = await inject("GET", "/v1/use-cases/draft?scope=00000000-0000-4000-8000-000000000000", users.owner.auth);
    expect(missing.statusCode).toBe(404);
  });

  it("refuses a draft over 256 KiB by name and stores nothing", async () => {
    const big = { blob: "x".repeat(256 * 1024) };
    const r = await inject("PUT", "/v1/use-cases/draft?scope=new", users.other.auth, { state: big });
    expect(r.statusCode).toBe(413);
    expect(r.json().error).toBe("draft_too_large");
    expect((await inject("GET", "/v1/use-cases/draft?scope=new", users.other.auth)).json().draft).toBeNull();
    // just under the limit is fine
    const ok = await inject("PUT", "/v1/use-cases/draft?scope=new", users.other.auth, { state: { blob: "x".repeat(200 * 1024) } });
    expect(ok.statusCode, ok.body).toBe(200);
    await inject("DELETE", "/v1/use-cases/draft?scope=new", users.other.auth);
  });

  it("prunes a draft untouched for 30 days", async () => {
    expect((await inject("PUT", "/v1/use-cases/draft?scope=new", users.admin.auth, { state: { old: true } })).statusCode).toBe(200);
    await db
      .update(useCaseDrafts)
      .set({ updatedAt: new Date(Date.now() - 31 * 86_400_000) })
      .where(and(eq(useCaseDrafts.userId, users.admin.id), eq(useCaseDrafts.scope, "new")));
    expect((await inject("GET", "/v1/use-cases/draft?scope=new", users.admin.auth)).json().draft).toBeNull();
    const left = await db
      .select()
      .from(useCaseDrafts)
      .where(and(eq(useCaseDrafts.userId, users.admin.id), eq(useCaseDrafts.scope, "new")));
    expect(left).toHaveLength(0);
  });
});

// ===========================================================================
// AER-050 — idempotent creation
// ===========================================================================

describe("AER-050 idempotent POST /v1/use-cases", () => {
  it("a retry with the same key returns the original use case instead of a second one", async () => {
    const key = { "idempotency-key": `retry-${RUN}` };
    const first = await create("idem-retry", {}, "owner", key);
    expect(first.statusCode, first.body).toBe(201);
    expect(first.headers["idempotent-replay"]).toBeUndefined();
    // the response was "lost"; the wizard retries with the same key
    const again = await create("idem-retry", {}, "owner", key);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.headers["idempotent-replay"]).toBe("true");
    expect(again.json()).toEqual(first.json());
    expect(await rowsNamed("idem-retry")).toHaveLength(1);

    // the same key from ANOTHER caller is a different key
    const theirs = await create("idem-retry", {}, "other", key);
    expect(theirs.statusCode, theirs.body).toBe(201);
    expect(theirs.json().id).not.toBe(first.json().id);
    expect(await rowsNamed("idem-retry")).toHaveLength(2);

    // no key: unchanged behaviour — every call creates
    expect((await create("idem-retry")).statusCode).toBe(201);
    expect(await rowsNamed("idem-retry")).toHaveLength(3);
  });

  it("concurrent duplicates cannot both create", async () => {
    const key = { "idempotency-key": `race-${RUN}` };
    const results = await Promise.all(Array.from({ length: 5 }, () => create("idem-race", {}, "owner", key)));
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes, results.map((r) => r.body).join("\n")).toEqual([200, 200, 200, 200, 201]);
    const ids = new Set(results.map((r) => r.json().id as string));
    expect(ids.size).toBe(1);
    expect(await rowsNamed("idem-race")).toHaveLength(1);
    const claims = await db
      .select()
      .from(useCaseIdempotencyKeys)
      .where(and(eq(useCaseIdempotencyKeys.userId, users.owner.id), eq(useCaseIdempotencyKeys.key, `race-${RUN}`)));
    expect(claims).toHaveLength(1);
    expect(claims[0]!.useCaseId).toBe([...ids][0]);
  });

  it("a key older than 24 hours no longer replays", async () => {
    const key = { "idempotency-key": `expiry-${RUN}` };
    const first = await create("idem-expiry", {}, "owner", key);
    expect(first.statusCode).toBe(201);
    await db
      .update(useCaseIdempotencyKeys)
      .set({ createdAt: new Date(Date.now() - 25 * 3_600_000) })
      .where(and(eq(useCaseIdempotencyKeys.userId, users.owner.id), eq(useCaseIdempotencyKeys.key, `expiry-${RUN}`)));
    const later = await create("idem-expiry", {}, "owner", key);
    expect(later.statusCode, later.body).toBe(201);
    expect(later.json().id).not.toBe(first.json().id);
  });

  it("refuses a malformed key, and a refused request claims nothing", async () => {
    const long = await create("idem-bad", {}, "owner", { "idempotency-key": "k".repeat(201) });
    expect(long.statusCode).toBe(400);
    expect(long.json().error).toBe("invalid_idempotency_key");
    const empty = await create("idem-bad", {}, "owner", { "idempotency-key": "" });
    expect(empty.statusCode).toBe(400);
    expect(await rowsNamed("idem-bad")).toHaveLength(0);

    // refused for content → the key is still free for the corrected retry
    const key = { "idempotency-key": `refused-${RUN}` };
    const refused = await create("idem-refused", { complianceTags: [], frameworkRationales: { gdpr: "why" } }, "owner", key);
    expect(refused.statusCode).toBe(422);
    const fixed = await create("idem-refused", {}, "owner", key);
    expect(fixed.statusCode, fixed.body).toBe(201);
  });
});

// ===========================================================================
// AER-052 — framework rationales
// ===========================================================================

describe("AER-052 framework rationales are saved and shown to reviewers", () => {
  it("stores the owner's rationale per framework and returns it on the detail read", async () => {
    const why = `Customer data from EU residents (${RUN})`;
    const c = await create("rationale", { complianceTags: ["gdpr", "soc2"], frameworkRationales: { gdpr: why } });
    expect(c.statusCode, c.body).toBe(201);
    expect(c.json().frameworkRationales).toEqual({ gdpr: why });
    const d = (await detail(c.json().id)).json();
    expect(d.frameworkRationales).toEqual({ gdpr: why });
    expect(d.useCase.frameworkRationales).toEqual({ gdpr: why });

    // edited while editable: replaced
    const p = await inject("PATCH", `/v1/use-cases/${c.json().id}`, users.owner.auth, {
      frameworkRationales: { gdpr: why, soc2: "customer contracts require it" },
    });
    expect(p.statusCode, p.body).toBe(200);
    expect((await detail(c.json().id)).json().frameworkRationales).toEqual({ gdpr: why, soc2: "customer contracts require it" });

    // none recorded → {}
    const plain = await create("rationale-none");
    expect((await detail(plain.json().id)).json().frameworkRationales).toEqual({});
  });

  it("refuses a rationale for a framework the use case does not carry", async () => {
    const c = await create("rationale-unlisted", { complianceTags: ["soc2"], frameworkRationales: { hipaa: "x" } });
    expect(c.statusCode).toBe(422);
    expect(c.json()).toMatchObject({ error: "rationale_for_unlisted_framework", frameworks: ["hipaa"] });
    expect(await rowsNamed("rationale-unlisted")).toHaveLength(0);

    const ok = await create("rationale-unlisted-patch", { complianceTags: ["soc2"] });
    const p = await inject("PATCH", `/v1/use-cases/${ok.json().id}`, users.owner.auth, { frameworkRationales: { hipaa: "x" } });
    expect(p.statusCode).toBe(422);
    expect(p.json().error).toBe("rationale_for_unlisted_framework");
    expect((await detail(ok.json().id)).json().frameworkRationales).toEqual({});
  });
});

// ===========================================================================
// AER-053 — "Not sure" answers
// ===========================================================================

describe("AER-053 a 'Not sure' answer counts as yes and is shown to reviewers", () => {
  it("registration stores the unsure keys; a 'Not sure' that is not a yes is refused", async () => {
    const answers = { ...minimal, ...context, profilesNaturalPersons: true, euNexus: true, unsure: ["profilesNaturalPersons", "euNexus"] };
    const c = await create("unsure", { screeningAnswers: answers });
    expect(c.statusCode, c.body).toBe(201);
    expect(c.json().screeningUnsure).toEqual(["profilesNaturalPersons", "euNexus"]);
    const d = (await detail(c.json().id)).json();
    expect(d.screeningUnsure).toEqual(["profilesNaturalPersons", "euNexus"]);
    // `unsure` is not stored as an answer
    expect(d.useCase.intakeAnswers).not.toHaveProperty("unsure");

    const silentNo = await create("unsure-no", { screeningAnswers: { ...minimal, ...context, unsure: ["socialScoring"] } });
    expect(silentNo.statusCode).toBe(422);
    expect(silentNo.json()).toMatchObject({ error: "unsure_answer_must_count_as_yes", answers: ["socialScoring"] });
    const notYesNo = await create("unsure-no", { screeningAnswers: { ...minimal, ...context, unsure: ["purposeDomain"] } });
    expect(notYesNo.statusCode).toBe(422);
    expect(notYesNo.json().error).toBe("unsure_answer_must_count_as_yes");
    expect(await rowsNamed("unsure-no")).toHaveLength(0);

    // none → []
    expect((await detail((await create("unsure-none")).json().id)).json().screeningUnsure).toEqual([]);
  });

  it("the questionnaire's answers block may carry 'Not sure': screened as yes, refused when not a yes", async () => {
    const c = await create("unsure-block", { screeningAnswers: { ...minimal, ...context, euNexus: true, unsure: ["euNexus"] } });
    expect(c.statusCode, c.body).toBe(201);
    const { id } = c.json();
    const instanceId = c.json().instance.id as string;
    const adv = await inject("POST", `/v1/workflows/instances/${instanceId}/advance`, users.owner.auth, { stageId: "plan" });
    expect(adv.statusCode, adv.body).toBe(200);

    const block = (a: Record<string, unknown>) =>
      `# AI use-case intake questionnaire\n\n## 9. EU AI Act risk screening\n\n` +
      "```eu-ai-act-answers\n" + JSON.stringify(a, null, 2) + "\n```";
    // inconsistent: refused by name BEFORE anything is stored
    const bad = await inject("POST", `/v1/workflows/instances/${instanceId}/artifacts`, users.owner.auth, {
      stageId: "questionnaire",
      content: block({ ...minimal, unsure: ["interactsWithHumans"] }),
    });
    expect(bad.statusCode, bad.body).toBe(422);
    expect(bad.json().error).toBe("unsure_answer_must_count_as_yes");
    expect(await db.select().from(workflowArtifacts).where(eq(workflowArtifacts.instanceId, instanceId))).toHaveLength(0);

    // consistent: stored, screened from the `true`, the unsure key recorded
    const good = await inject("POST", `/v1/workflows/instances/${instanceId}/artifacts`, users.owner.auth, {
      stageId: "questionnaire",
      content: block({ ...minimal, interactsWithHumans: true, unsure: ["interactsWithHumans"] }),
    });
    expect(good.statusCode, good.body).toBe(201);
    const d = (await detail(id)).json();
    expect(d.euAiActScreening.answersStatus).toBe("ok");
    expect(d.useCase.euAiActTier).toBe("limited");
    // the block restates the EU answers' set; the context answer's entry stays
    expect([...d.screeningUnsure].sort()).toEqual(["euNexus", "interactsWithHumans"]);
  });

  it("a resubmission carries 'Not sure' back, replaces it, and refuses a 'Not sure' no", async () => {
    const c = await create("unsure-resubmit", {
      screeningAnswers: { ...minimal, ...context, safetyComponent: true, unsure: ["safetyComponent"] },
    });
    expect(c.statusCode, c.body).toBe(201);
    const id = c.json().id as string;
    // sent back for information (the decide path is covered by the ADR-0168 suite)
    await db.update(aiUseCases).set({ status: "needs_info" }).where(eq(aiUseCases.id, id));
    const before = (await detail(id)).json();
    expect(before.resubmission.allowed).toBe(true);
    expect(before.resubmission.screeningAnswers.unsure).toEqual(["safetyComponent"]);

    const refused = await inject("PATCH", `/v1/use-cases/${id}`, users.owner.auth, {
      screeningAnswers: { ...minimal, unsure: ["socialScoring"] },
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toBe("unsure_answer_must_count_as_yes");
    expect((await detail(id)).json().screeningUnsure).toEqual(["safetyComponent"]);

    // an omitted context answer keeps its stored value — and is checked as stored
    const ctxNo = await inject("PATCH", `/v1/use-cases/${id}`, users.owner.auth, {
      screeningAnswers: { ...minimal, unsure: ["usesExternalVendor"] },
    });
    expect(ctxNo.statusCode).toBe(422);

    const p = await inject("PATCH", `/v1/use-cases/${id}`, users.owner.auth, {
      screeningAnswers: { ...minimal, socialScoring: true, unsure: ["socialScoring"] },
    });
    expect(p.statusCode, p.body).toBe(200);
    // the classifier saw the conservative `true`
    expect(p.json().euAiActTier).toBe("prohibited");
    const after = (await detail(id)).json();
    expect(after.screeningUnsure).toEqual(["socialScoring"]);
    expect(after.resubmission.screeningAnswers.unsure).toEqual(["socialScoring"]);
    expect(after.useCase.intakeAnswers).not.toHaveProperty("unsure");

    // omitted = none
    const cleared = await inject("PATCH", `/v1/use-cases/${id}`, users.owner.auth, { screeningAnswers: minimal });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect((await detail(id)).json().screeningUnsure).toEqual([]);
  });
});
