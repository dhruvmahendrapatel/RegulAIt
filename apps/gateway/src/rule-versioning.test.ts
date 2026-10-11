import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
// ADR-0181: this file registers a LOCAL MCP double (127.0.0.1 / localhost, registered seconds ago) to pin
// unrelated behaviour, not the strict admission defaults — relaxed explicitly here, restored in afterAll.
let restoreStrictAdmission: (() => Promise<void>) | undefined;
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  approvalRules,
  auditLog,
  complianceProfiles,
  configActivationEvents,
  configCanaryObservations,
  configVersions,
  createDb,
  eq,
  inArray,
  rateLimits,
  runMigrations,
  type Db,
} from "@regulait/db";
import { randomUUID } from "node:crypto";
import { canaryBucket } from "@regulait/shared";
import { buildApp } from "./app.js";
import { complianceProfilesForTags } from "./projects.js";

/**
 * ADR-0073 — THE RULES ENGINE RESOLVED THROUGH `config_versions`, PROVED BY
 * ATTACK.
 *
 * ADR-0048 stored rule versions and nothing read them, so its shadow canary for
 * rules evaluated nothing. This suite exists to make four specific lies
 * impossible to tell:
 *
 *  1. "THE SHADOW IS HARMLESS." Asserted by capturing the ENTIRE served
 *     decision object before a candidate exists and after, and requiring deep
 *     equality — effect, ruleId, ruleChain, reason, approver, all of it. A
 *     candidate that leaked one field into the answer fails.
 *
 *  2. "THE SHADOW MEASURES SOMETHING." The candidate used is one that would
 *     DENY (pause) what the active version ALLOWS. The caller is still allowed,
 *     AND a divergence row exists naming both sides. A canary that recorded
 *     nothing would pass (1) and fail here; a canary that enforced would pass
 *     here and fail (1). Both are required together.
 *
 *  3. "A BROKEN CANDIDATE IS SAFE." A candidate whose evaluation THROWS is
 *     injected directly into `config_versions` (bypassing the API's type
 *     check — the corrupt-row case the try/catch exists for) and the served
 *     decision is asserted byte-identical, with the failure RECORDED rather
 *     than swallowed.
 *
 *  4. "ACTIVATION AND ROLLBACK ARE REAL." Promotion is asserted to CHANGE the
 *     served decision and rollback to RESTORE it — end to end through the
 *     kernel, not by reading a status column.
 *
 * SHARED-STATE DISCIPLINE: everything is `rv-` prefixed and owned by this
 * suite; `afterAll` deletes the versions, activation events, observations, the
 * compliance profile (a globally-listed row) and the audit rows it wrote.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "rv-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const TAG = "rv-framework";
/** the shadow SAMPLING rate used throughout; fixtures are chosen below so both
 * artifacts bucket strictly under it */
const CANARY_PCT = 20;

let db: Db;
let app: ReturnType<typeof buildApp>;
let anaId: string;
let piaId: string;
let piaAuth: { authorization: string };
let serverId: string;
let ruleId: string;
let limitId: string;
let profileId: string;
let projectId: string;

async function makeUser(email: string) {
  const u = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email, displayName: email.split("@")[0] },
  });
  const k = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${u.json().id}/keys`,
    payload: { name: "t" },
  });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

/** the ONE driver: a full governed evaluation of pia calling rv_write */
async function decide() {
  const res = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/evaluate",
    payload: { userId: piaId, serverId, toolName: "rv_write" },
  });
  return res;
}

async function newVersionOf(
  artifactType: string,
  artifactId: string,
  body: Record<string, unknown>,
  label: string,
) {
  return app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/config-versions/${artifactType}/${artifactId}`,
    payload: { body, label },
  });
}

async function canaryOn(artifactType: string, artifactId: string, version: number, pct: number) {
  return app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/config-versions/${artifactType}/${artifactId}/canary`,
    payload: { version, pct },
  });
}

async function observationsFor(artifactId: string) {
  return db
    .select()
    .from(configCanaryObservations)
    .where(eq(configCanaryObservations.artifactId, artifactId));
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreStrictAdmission = await relaxStrictAdmissionForTest(db);
  app = buildApp(db, { bootstrapToken: BOOT });

  const ana = await makeUser("rv-ana@example.com");
  anaId = ana.id;
  const pia = await makeUser("rv-pia@example.com");
  piaId = pia.id;
  piaAuth = pia.auth;

  const s = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/servers",
    payload: { name: "rv-server", url: "http://127.0.0.1:9" },
  });
  serverId = s.json().id;
  for (const tool of [
    { name: "rv_read", kind: "read" },
    { name: "rv_write", kind: "write" },
  ]) {
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/servers/${serverId}/tools`,
      payload: tool,
    });
  }
  await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/grants/tools",
    payload: { userId: piaId, serverId, toolName: "rv_write" },
  });

  // FIXTURE SELECTION, not test rigging — the same move ADR-0048's prompt suite
  // makes when it picks two users whose buckets differ. Shadow sampling buckets
  // on `canaryBucket(artifactId, userId)` with both ids randomly generated per
  // run, so a canary at 99% would leave this suite with a genuine 1-in-100
  // chance of asserting on a decision that was legitimately not sampled. The
  // ids are chosen with the SAME pure function the resolver uses so the canary
  // percentage used below (CANARY_PCT) is unambiguously above the bucket, and
  // the assertions then hold every run rather than almost every run.
  const lowBucketId = () => {
    for (;;) {
      const id = randomUUID();
      if (canaryBucket(id, piaId) < CANARY_PCT) return id;
    }
  };

  // The rule under test: it currently pauses `rv_read`, which pia is not
  // calling — so the served decision for `rv_write` is a plain ALLOW.
  ruleId = lowBucketId();
  await db.insert(approvalRules).values({
    id: ruleId,
    scope: "user",
    userId: piaId,
    serverScope: "server",
    serverId,
    toolName: "rv_read",
    writeOnly: false,
    approverUserId: anaId,
  });

  // A generous rate limit that changes nothing — the vehicle for the
  // throwing-candidate case.
  limitId = lowBucketId();
  await db.insert(rateLimits).values({
    id: limitId,
    scope: "user",
    userId: piaId,
    serverScope: "server",
    serverId,
    maxCalls: 100000,
    windowSeconds: 3600,
  });

  const p = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/compliance/profiles",
    payload: { tag: TAG, piiMode: "log", mcpDefaultMode: "read_write" },
  });
  expect(p.statusCode).toBe(201);
  profileId = p.json().id;
  const proj = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/projects",
    payload: { name: "rv-project", classifications: [TAG] },
  });
  projectId = proj.json().id;
});

afterAll(async () => {
  await restoreStrictAdmission?.();
  const artifacts = [ruleId, limitId, profileId].filter(Boolean);
  if (artifacts.length) {
    await db
      .delete(configCanaryObservations)
      .where(inArray(configCanaryObservations.artifactId, artifacts));
    await db
      .delete(configActivationEvents)
      .where(inArray(configActivationEvents.artifactId, artifacts));
    await db.delete(configVersions).where(inArray(configVersions.artifactId, artifacts));
  }
  if (ruleId) await db.delete(approvalRules).where(eq(approvalRules.id, ruleId));
  if (limitId) await db.delete(rateLimits).where(eq(rateLimits.id, limitId));
  // a compliance profile is listed org-wide by other surfaces — never leak one
  if (profileId) await db.delete(complianceProfiles).where(eq(complianceProfiles.id, profileId));
  if (piaId) await db.delete(auditLog).where(eq(auditLog.userId, piaId));
});

describe("ADR-0073 — the shadow canary cannot touch the served decision", () => {
  let baseline: Record<string, unknown>;

  it("records the served decision BEFORE any version exists — the reference answer", async () => {
    const res = await decide();
    expect(res.statusCode).toBe(200);
    baseline = res.json();
    expect(baseline.effect).toBe("allow");
    // no versions yet: the rule resolves to its own table row, which is
    // byte-identical pre-ADR-0073 behaviour
    expect((await db.select().from(configVersions).where(eq(configVersions.artifactId, ruleId))).length).toBe(0);
  });

  it("the first version mints the v1 baseline from the live rule, so nothing is ever versionless-and-active", async () => {
    const created = await newVersionOf(
      "approval_rule",
      ruleId,
      { toolName: "rv_write" },
      "v2 — pause writes too",
    );
    expect(created.statusCode).toBe(201);
    expect(created.json().version.version).toBe(2);
    const rows = await db
      .select()
      .from(configVersions)
      .where(eq(configVersions.artifactId, ruleId));
    const v1 = rows.find((r) => r.version === 1)!;
    const v2 = rows.find((r) => r.version === 2)!;
    expect(v1.status).toBe("active");
    expect(v1.label).toMatch(/pre-versioning baseline/);
    // the baseline is the rule EXACTLY as it stood
    expect(v1.body).toMatchObject({ toolName: "rv_read", writeOnly: false, approverUserId: anaId });
    expect(v2.status).toBe("draft");
  });

  it("creating a version changes NOTHING until it is activated", async () => {
    const after = await decide();
    expect(after.json()).toEqual(baseline);
  });

  it("A CANDIDATE THAT WOULD PAUSE THE CALL LEAVES THE SERVED ANSWER BYTE-IDENTICAL", async () => {
    // a real percentage, not 100 — the bucketing code path is the one under
    // test, and the fixture ids were chosen so pia buckets strictly under it.
    const c = await canaryOn("approval_rule", ruleId, 2, CANARY_PCT);
    expect(c.statusCode).toBe(200);
    expect(c.json().live).toBe(false);
    expect(c.json().canaryMode).toBe("shadow");

    const served = await decide();
    // THE assertion of this file: the whole object, not just the effect.
    expect(served.json()).toEqual(baseline);
  });

  it("...and RECORDS what the candidate would have done instead", async () => {
    const rows = await observationsFor(ruleId);
    expect(rows.length).toBeGreaterThan(0);
    const diverged = rows.filter((r) => r.diverged);
    expect(diverged.length).toBeGreaterThan(0);
    const o = diverged[0]!;
    expect(o.servedEffect).toBe("allow");
    expect(o.candidateEffect).toBe("require_approval");
    expect(o.candidateVersion).toBe(2);
    expect(o.activeVersion).toBe(1);
    expect(o.userId).toBe(piaId);
    expect(o.toolName).toBe("rv_write");
    expect(o.failed).toBe(false);
    // the candidate's reason is stored in full, so an operator reads the
    // sentence the caller WOULD have been given
    expect(o.candidateReason).toMatch(/sign-off by approver/);
    // and the sampling rate is stored with it, so a count is never mistaken
    // for a fleet-wide total
    expect(o.canaryPct).toBe(CANARY_PCT);
    expect(o.bucket).toBeLessThan(CANARY_PCT);
  });

  it("the divergence report answers 'what changes if I promote this'", async () => {
    const res = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/config-versions/approval_rule/${ruleId}/divergence`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.canaryMode).toBe("shadow");
    expect(body.activeVersion).toBe(1);
    expect(body.candidateVersion).toBe(2);
    expect(body.totals.diverged).toBeGreaterThan(0);
    expect(body.totals.failed).toBe(0);
    expect(body.note).toMatch(/SAMPLED decisions/);
    const first = body.observations[0];
    expect(first.servedEffect).toBe("allow");
    expect(first.candidateEffect).toBe("require_approval");
  });

  it("the canary index lists it with its counts", async () => {
    const res = await app.inject({ method: "GET", headers: AUTH, url: "/v1/config-versions/canaries" });
    expect(res.statusCode).toBe(200);
    const mine = res
      .json()
      .canaries.find((c: { artifactId: string }) => c.artifactId === ruleId);
    expect(mine).toBeTruthy();
    expect(mine.canaryMode).toBe("shadow");
    expect(mine.diverged).toBeGreaterThan(0);
  });
});

describe("ADR-0073 — promotion changes evaluation and rollback restores it", () => {
  it("PROMOTION makes the candidate the served decision", async () => {
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/config-versions/approval_rule/${ruleId}/promote`,
      payload: { override: true, reason: "rv suite: no golden set for a rule change" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().activeVersion).toBe(2);

    const served = await decide();
    // this is the assertion that proves the kernel READS the version: nothing
    // about the `approval_rules` row's identity changed, only which version is
    // active
    expect(served.json().effect).toBe("require_approval");
    expect(served.json().ruleId).toBe(ruleId);
  });

  it("...and the rule's own row follows as a read-model, so listings show what is enforced", async () => {
    const res = await app.inject({ method: "GET", headers: AUTH, url: "/v1/rules/approvals" });
    const mine = res.json().rules.find((r: { id: string }) => r.id === ruleId);
    expect(mine.toolName).toBe("rv_write");
  });

  it("ROLLBACK genuinely restores the prior BEHAVIOUR, not merely a status column", async () => {
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/config-versions/approval_rule/${ruleId}/rollback`,
      payload: { reason: "rv suite: undo" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().activeVersion).toBe(1);

    const served = await decide();
    expect(served.json().effect).toBe("allow");
    // v2's row still exists with its body intact — nothing was rewritten
    const rows = await db
      .select()
      .from(configVersions)
      .where(and(eq(configVersions.artifactId, ruleId), eq(configVersions.version, 2)));
    expect(rows[0]!.status).toBe("rolled_back");
    expect(rows[0]!.body).toMatchObject({ toolName: "rv_write" });
    // and the read-model went back with it
    const list = await app.inject({ method: "GET", headers: AUTH, url: "/v1/rules/approvals" });
    expect(list.json().rules.find((r: { id: string }) => r.id === ruleId).toolName).toBe("rv_read");
  });
});

describe("ADR-0073 — a candidate that THROWS cannot disturb the served decision", () => {
  let reference: Record<string, unknown>;

  it("captures the reference answer with the healthy limit in place", async () => {
    const res = await decide();
    expect(res.statusCode).toBe(200);
    reference = res.json();
    expect(reference.effect).toBe("allow");
  });

  it("a corrupt candidate body leaves the answer identical and records the FAILURE", async () => {
    // Version the limit through the API (mints v1 baseline + v2), then CORRUPT
    // v2 by writing straight to the table. The API type-checks bodies, so this
    // is deliberately the case it cannot prevent: a row corrupted by a bad
    // migration, a hand-edited database, or a future column type change.
    const created = await newVersionOf("rate_limit", limitId, { maxCalls: 50000 }, "v2");
    expect(created.statusCode).toBe(201);
    const [v2] = await db
      .select()
      .from(configVersions)
      .where(and(eq(configVersions.artifactId, limitId), eq(configVersions.version, 2)));
    await db
      .update(configVersions)
      // a non-numeric window makes the candidate's count query build an Invalid
      // Date and throw. The SERVED limit is untouched.
      .set({ body: { windowSeconds: "sixty" }, status: "canary", canaryPct: CANARY_PCT })
      .where(eq(configVersions.id, v2!.id));

    const served = await decide();
    expect(served.statusCode).toBe(200);
    expect(served.json()).toEqual(reference);

    const rows = await observationsFor(limitId);
    const failures = rows.filter((r) => r.failed);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0]!.failureReason).toBeTruthy();
    // a failure is NOT a divergence — reporting it as one would let a broken
    // candidate look like a meaningful signal
    expect(failures[0]!.diverged).toBe(false);
    expect(failures[0]!.candidateEffect).toBeNull();
    // the served decision is still recorded on the failure row, so an operator
    // sees what the caller got
    expect(failures[0]!.servedEffect).toBe("allow");
  });

  it("the report refuses to let `diverged` be read as complete while a failure exists", async () => {
    const res = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/config-versions/rate_limit/${limitId}/divergence`,
    });
    expect(res.json().totals.failed).toBeGreaterThan(0);
    expect(res.json().note).toMatch(/do not read `diverged` as complete/);
  });

  it("abandoning the broken canary returns the artifact to a clean single-version state", async () => {
    const res = await app.inject({
      method: "DELETE",
      headers: AUTH,
      url: `/v1/config-versions/rate_limit/${limitId}/canary`,
    });
    expect(res.statusCode).toBe(200);
    const served = await decide();
    expect(served.json()).toEqual(reference);
  });
});

describe("ADR-0073 — default-deny survives version resolution", () => {
  it("versions with NO active version DENY with the reason stated — never 'no rule, therefore allow'", async () => {
    // reachable only by corruption: `activateVersion` always leaves exactly one
    // active and the lazy baseline mints one on first use. Simulated directly,
    // because the whole point is that the code does not trust that.
    await db
      .update(configVersions)
      .set({ status: "superseded" })
      .where(and(eq(configVersions.artifactId, ruleId), eq(configVersions.status, "active")));

    const res = await decide();
    expect(res.statusCode).toBe(200);
    expect(res.json().effect).toBe("deny");
    expect(res.json().ruleId).toBe("config-version-unresolvable");
    expect(res.json().reason).toMatch(/NONE is active/);
    expect(res.json().reason).toMatch(/refused rather than evaluated without it/);

    // restore
    await db
      .update(configVersions)
      .set({ status: "active" })
      .where(and(eq(configVersions.artifactId, ruleId), eq(configVersions.version, 1)));
    expect((await decide()).json().effect).toBe("allow");
  });

  it("an unresolvable COMPLIANCE PROFILE refuses with a real 409 rather than dropping the framework", async () => {
    const created = await newVersionOf("compliance_profile", profileId, { piiMode: "block" }, "v2");
    expect(created.statusCode).toBe(201);
    await db
      .update(configVersions)
      .set({ status: "superseded" })
      .where(and(eq(configVersions.artifactId, profileId), eq(configVersions.status, "active")));

    // any surface that consults the §8.3 cascade for this project now refuses
    const res = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/projects/${projectId}/compliance`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("config_version_unresolvable");

    await db
      .update(configVersions)
      .set({ status: "active" })
      .where(and(eq(configVersions.artifactId, profileId), eq(configVersions.version, 1)));
  });
});

describe("ADR-0073 — the compliance cascade reads the active version", () => {
  it("activating a profile version changes the effective policy the cascade returns", async () => {
    const before = await complianceProfilesForTags(db, [TAG]);
    expect(before[0]!.piiMode).toBe("log");

    const act = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/config-versions/compliance_profile/${profileId}/activate`,
      payload: { version: 2, reason: "rv suite" },
    });
    expect(act.statusCode).toBe(200);

    const after = await complianceProfilesForTags(db, [TAG]);
    expect(after[0]!.piiMode).toBe("block");
  });

  it("rolling the profile back restores the prior posture", async () => {
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/config-versions/compliance_profile/${profileId}/rollback`,
      payload: { reason: "rv suite: undo" },
    });
    expect(res.statusCode).toBe(200);
    const after = await complianceProfilesForTags(db, [TAG]);
    expect(after[0]!.piiMode).toBe("log");
  });

  // B8b (ADR-0073 disclosures 6+7): this test used to assert the note said
  // "NOT sampled and NOT stored". The computation is still per-project and
  // still not sampled, but it is now STORED — each comparison is persisted
  // into config_canary_observations (deduplicated by fingerprint) at the same
  // read-time site. Rewritten rather than deleted, per the ADR-0048 precedent:
  // the assertion now pins the new disclosure AND that the storage is real.
  it("the divergence report computes the per-project impact and PERSISTS it, deduplicated", async () => {
    const c = await canaryOn("compliance_profile", profileId, 2, 50);
    expect(c.statusCode).toBe(200);
    const obsBefore = (await observationsFor(profileId)).length;
    const res = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/config-versions/compliance_profile/${profileId}/divergence`,
    });
    expect(res.statusCode).toBe(200);
    const mine = res
      .json()
      .projectImpact.find((p: { projectId: string }) => p.projectId === projectId);
    expect(mine).toBeTruthy();
    expect(mine.diverged).toBe(true);
    expect(mine.changed).toContain("piiMode");
    expect(mine.before.piiMode).toBe("log");
    expect(mine.after.piiMode).toBe("block");
    expect(res.json().projectImpactNote).toMatch(/NOT sampled/);
    expect(res.json().projectImpactNote).toMatch(/STORED/);
    // the comparison is now history: one observation row per examined project
    // (DELTA, not absolute — the rule canaries above wrote their own rows)
    const obsAfter = await observationsFor(profileId);
    const stored = obsAfter.filter(
      (o) => o.projectId === projectId && o.detail?.source === "profile-shadow-read-through",
    );
    expect(obsAfter.length).toBeGreaterThan(obsBefore);
    expect(stored.length).toBe(1);
    expect(stored[0]!.diverged).toBe(true);
    // a refresh recomputes but DEDUPLICATES — no second identical row
    const again = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/config-versions/compliance_profile/${profileId}/divergence`,
    });
    expect(again.statusCode).toBe(200);
    expect((await observationsFor(profileId)).length).toBe(obsAfter.length);
    await app.inject({
      method: "DELETE",
      headers: AUTH,
      url: `/v1/config-versions/compliance_profile/${profileId}/canary`,
    });
  });
});

describe("ADR-0073 — honest refusals on the authoring surface", () => {
  it("refuses a version body that would rebind the rule to a different subject", async () => {
    const res = await newVersionOf("approval_rule", ruleId, { userId: anaId }, "sneaky");
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("selection_field_not_versionable");
    expect(res.json().detail).toMatch(/separate rule/);
  });

  it("refuses a wrongly-typed field before it can be activated onto the served path", async () => {
    const res = await newVersionOf("rate_limit", limitId, { windowSeconds: "sixty" }, "bad");
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("invalid_versioned_field");
  });

  it("refuses a version of a rule that does not exist", async () => {
    const res = await newVersionOf(
      "approval_rule",
      "00000000-0000-4000-8000-0000000000ff",
      { toolName: "x" },
      "ghost",
    );
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("unknown_artifact");
  });

  it("still refuses every versioning route to a non-admin", async () => {
    const res = await app.inject({
      method: "POST",
      headers: piaAuth,
      url: `/v1/config-versions/approval_rule/${ruleId}`,
      payload: { body: { toolName: "rv_read" } },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("ADR-0073 — the disclosure now matches reality", () => {
  it("a rule type reports shadow AND evaluated, and no longer claims to be unwired", async () => {
    const res = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/config-versions/approval_rule/${ruleId}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.canaryMode).toBe("shadow");
    // canaryIsLive stays FALSE for rules on purpose — a live rule canary would
    // ENFORCE a candidate deny on a share of real work
    expect(body.canaryIsLive).toBe(false);
    expect(body.canaryIsEvaluated).toBe(true);
    expect(body.note).toMatch(/genuinely evaluated in parallel/);
    expect(body.note).not.toMatch(/NOT yet wired/);
  });

  it("agent_config reports SHADOW — the residual ADR-0073 left open, closed by batch B1", async () => {
    // REWRITTEN (2026-08-22, batch B1), not deleted — this test used to pin
    // `inert` while agent_config was vocabulary-only, the same way ADR-0048's
    // "NOT yet wired" test pinned the pre-0073 disclosure. The dispatch core
    // now resolves the active agent_config version and shadow-evaluates a
    // sampled candidate (agent-config-versioning.test.ts proves it through
    // real dispatches), so the honest disclosure moved and this assertion
    // moved with it. canaryIsLive stays false: an agent_config canary must
    // never SERVE a candidate model.
    const res = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/config-versions/agent_config/${ruleId}`,
    });
    expect(res.json().canaryMode).toBe("shadow");
    expect(res.json().canaryIsLive).toBe(false);
    expect(res.json().canaryIsEvaluated).toBe(true);
    expect(res.json().note).not.toMatch(/VOCABULARY ONLY/);
  });
});
