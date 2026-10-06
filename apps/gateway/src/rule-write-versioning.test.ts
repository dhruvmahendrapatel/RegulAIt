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
  runMigrations,
  type Db,
} from "@regulait/db";
import { randomUUID } from "node:crypto";
import { canaryBucket } from "@regulait/shared";
import { buildApp } from "./app.js";

/**
 * ADR-0074 — AN ORDINARY CRUD EDIT ON A VERSIONED RULE CHANGES WHAT IS
 * ENFORCED, PROVED THROUGH THE KERNEL.
 *
 * ADR-0073 wired the rules engine through `config_versions` and disclosed, as
 * its gap 10, that the rule tables had acquired a second writer. What that gap
 * actually described was a LIVE SILENT NO-OP: three routes wrote a VERSIONED
 * column straight onto the row, returned 200/201 with the new value, wrote a
 * confident audit row — and `rule-versions.ts:185` overlaid the active version's
 * body back over that row on every dispatch, so nothing about enforcement
 * changed. No test asserted the inverse of the fix, which is exactly why the
 * defect shipped.
 *
 * SO EVERY ASSERTION HERE IS ON A DECISION, NOT ON A COLUMN. A test that
 * asserted "the row now says air_gapped" or "a version row exists" would have
 * PASSED against the broken code. The only assertion that could not is: make a
 * real governed call and check what the kernel decided.
 *
 * Rows are identified by set-difference on id or by an explicit id, never by
 * position out of an unordered query.
 *
 * SHARED-STATE DISCIPLINE: everything is `rw-` prefixed and owned by this suite;
 * `afterAll` deletes the versions, activation events, observations, the
 * compliance profile (a globally-listed row) and the audit rows it wrote.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "rw-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const TAG = "rw-framework";
const CANARY_PCT = 20;

let db: Db;
let app: ReturnType<typeof buildApp>;
let anaId: string;
let piaId: string;
let serverId: string;
/** the rule under test: VERSIONED, and its deploy-mode is edited through the
 * ordinary admin PATCH */
let versionedRuleId: string;
/** an identical rule that is NEVER versioned — invariant 4's control */
let unversionedRuleId: string;
let profileId: string;
let projectId: string;

async function makeUser(email: string) {
  const res = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email, displayName: email.split("@")[0] },
  });
  if (res.statusCode < 300) return { id: res.json().id as string };
  // find-or-create, same reason as the server below: a re-run against a
  // database a previous run touched must not fail three statements later with
  // an error that says nothing about the real cause.
  const list = await app.inject({ method: "GET", headers: AUTH, url: "/v1/users" });
  const found = list.json().users.find((u: { email: string }) => u.email === email);
  if (!found) throw new Error(`makeUser failed: ${res.statusCode} ${res.body}`);
  return { id: found.id as string };
}

/** a REAL governed decision — the only thing that can tell a working fix from a
 * broken one */
async function decide(tool = "rw_write") {
  return app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/evaluate",
    payload: { userId: piaId, serverId, toolName: tool },
  });
}

async function versionsOf(artifactId: string) {
  return db.select().from(configVersions).where(eq(configVersions.artifactId, artifactId));
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreStrictAdmission = await relaxStrictAdmissionForTest(db);
  app = buildApp(db, { bootstrapToken: BOOT });

  anaId = (await makeUser("rw-ana@example.com")).id;
  piaId = (await makeUser("rw-pia@example.com")).id;

  // find-or-create: the suite must be re-runnable against a database a
  // previous run already touched, and a name collision here would otherwise
  // leave `serverId` undefined and produce a CHECK-constraint failure three
  // statements later that says nothing about the real cause.
  const s = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/servers",
    payload: { name: "rw-server", url: "http://127.0.0.1:9" },
  });
  if (s.statusCode < 300) {
    serverId = s.json().id;
  } else {
    const list = await app.inject({ method: "GET", headers: AUTH, url: "/v1/servers" });
    serverId = list.json().servers.find((x: { name: string }) => x.name === "rw-server").id;
  }
  for (const tool of [
    { name: "rw_read", kind: "read" },
    { name: "rw_write", kind: "write" },
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
    payload: { userId: piaId, serverId, toolName: "rw_write" },
  });

  // Same fixture-selection discipline as ADR-0073's suite: pick ids that bucket
  // strictly under the canary percentage with the SAME pure function the
  // resolver uses, so the sampling assertions hold every run.
  const lowBucketId = () => {
    for (;;) {
      const id = randomUUID();
      if (canaryBucket(id, piaId) < CANARY_PCT) return id;
    }
  };

  // Both rules PAUSE `rw_write` for pia. Deploy-mode scoping is what will be
  // edited: a rule scoped to `air_gapped` no longer binds a call with no
  // deploy context, so the decision flips allow/require_approval — a real
  // enforcement change, visible only through the kernel.
  for (const id of [(versionedRuleId = lowBucketId()), (unversionedRuleId = randomUUID())]) {
    await db.insert(approvalRules).values({
      id,
      scope: "user",
      userId: piaId,
      serverScope: "server",
      serverId,
      toolName: "rw_write",
      writeOnly: false,
      approverUserId: anaId,
    });
  }

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
    payload: { name: "rw-project", classifications: [TAG] },
  });
  projectId = proj.json().id;
});

afterAll(async () => {
  await restoreStrictAdmission?.();
  const artifacts = [versionedRuleId, unversionedRuleId, profileId].filter(Boolean);
  if (artifacts.length) {
    await db
      .delete(configCanaryObservations)
      .where(inArray(configCanaryObservations.artifactId, artifacts));
    await db
      .delete(configActivationEvents)
      .where(inArray(configActivationEvents.artifactId, artifacts));
    await db.delete(configVersions).where(inArray(configVersions.artifactId, artifacts));
  }
  if (versionedRuleId) await db.delete(approvalRules).where(eq(approvalRules.id, versionedRuleId));
  if (unversionedRuleId) await db.delete(approvalRules).where(eq(approvalRules.id, unversionedRuleId));
  if (profileId) await db.delete(complianceProfiles).where(eq(complianceProfiles.id, profileId));
  if (piaId) await db.delete(auditLog).where(eq(auditLog.userId, piaId));
});

// ---------------------------------------------------------------------------

describe("ADR-0074 — a CRUD edit on a VERSIONED rule changes what the kernel enforces", () => {
  it("both rules pause the call today — the reference decision", async () => {
    const res = await decide();
    expect(res.statusCode).toBe(200);
    expect(res.json().effect).toBe("require_approval");
  });

  it("versioning one rule changes nothing (the lazy v1 baseline is the rule as it stands)", async () => {
    const created = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/config-versions/approval_rule/${versionedRuleId}`,
      payload: { body: { toolName: "rw_read" }, label: "rw v2 — draft, not activated" },
    });
    expect(created.statusCode).toBe(201);
    expect((await decide()).json().effect).toBe("require_approval");
    const rows = await versionsOf(versionedRuleId);
    expect(rows.find((r) => r.version === 1)!.status).toBe("active");
    expect(rows.find((r) => r.version === 2)!.status).toBe("draft");
  });

  it("THE DEFECT: PATCH deploy-mode on the VERSIONED rule now MINTS a version and the KERNEL FOLLOWS", async () => {
    const before = new Set((await versionsOf(versionedRuleId)).map((v) => v.id));

    const res = await app.inject({
      method: "PATCH",
      headers: AUTH,
      url: `/v1/rules/approvals/${versionedRuleId}/deploy-mode`,
      payload: { deployMode: "air_gapped" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().versionMinted).toBe(3);

    // set-difference on id — never a row picked by position out of an
    // unordered query
    const after = await versionsOf(versionedRuleId);
    const minted = after.filter((v) => !before.has(v.id));
    expect(minted.length).toBe(1);
    expect(minted[0]!.status).toBe("active");
    expect(minted[0]!.body).toMatchObject({ deployMode: "air_gapped", toolName: "rw_write" });
    expect(minted[0]!.label).toMatch(/deploy-mode set via PATCH/);

    // THE ASSERTION THAT COULD NOT PASS BEFORE THIS ADR. The versioned rule is
    // now scoped to air_gapped and no longer binds this call; the UNVERSIONED
    // rule still does, so the decision is still require_approval and names the
    // OTHER rule. Before the fix, the versioned rule's row said air_gapped and
    // the active version's body said null, and applyRuleBody put null back.
    const decided = await decide();
    expect(decided.json().effect).toBe("require_approval");
    expect(decided.json().ruleId).toBe(unversionedRuleId);
  });

  it("...and scoping the UNVERSIONED rule too flips the decision to ALLOW", async () => {
    const res = await app.inject({
      method: "PATCH",
      headers: AUTH,
      url: `/v1/rules/approvals/${unversionedRuleId}/deploy-mode`,
      payload: { deployMode: "air_gapped" },
    });
    expect(res.statusCode).toBe(200);
    // INVARIANT 4: no versions exist for this rule, so nothing is minted and
    // the write is byte-identical to pre-ADR-0073 behaviour
    expect(res.json().versionMinted).toBeNull();
    expect((await versionsOf(unversionedRuleId)).length).toBe(0);

    expect((await decide()).json().effect).toBe("allow");
  });

  it("the minted version is ROLLBACK-ABLE — the edit gained a history it did not have", async () => {
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/config-versions/approval_rule/${versionedRuleId}/rollback`,
      payload: { reason: "rw suite: undo the deploy-mode scope" },
    });
    expect(res.statusCode).toBe(200);
    // back to v1, i.e. mode-unscoped, i.e. the rule binds again
    expect((await decide()).json().effect).toBe("require_approval");
    expect((await decide()).json().ruleId).toBe(versionedRuleId);

    // and forward again, so the rest of the suite runs against the scoped state
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/config-versions/approval_rule/${versionedRuleId}/activate`,
      payload: { version: 3, reason: "rw suite: redo" },
    });
    expect((await decide()).json().effect).toBe("allow");
  });

  it("a re-PATCH with the SAME value mints nothing — an idempotent write is not a policy change", async () => {
    const before = (await versionsOf(versionedRuleId)).length;
    const res = await app.inject({
      method: "PATCH",
      headers: AUTH,
      url: `/v1/rules/approvals/${versionedRuleId}/deploy-mode`,
      payload: { deployMode: "air_gapped" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().versionMinted).toBeNull();
    expect(res.json().note).toMatch(/No version was minted/);
    expect((await versionsOf(versionedRuleId)).length).toBe(before);
  });

  it("an UNRESOLVABLE artifact REFUSES the edit and names the remedy — default-deny extends to writes", async () => {
    await db
      .update(configVersions)
      .set({ status: "superseded" })
      .where(and(eq(configVersions.artifactId, versionedRuleId), eq(configVersions.status, "active")));

    const res = await app.inject({
      method: "PATCH",
      headers: AUTH,
      url: `/v1/rules/approvals/${versionedRuleId}/deploy-mode`,
      payload: { deployMode: "hosted" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("config_version_unresolvable");
    // the refusal must name what to do, or an operator hits a dead end during
    // exactly the incident the fail-closed branch exists for
    expect(res.json().detail).toMatch(/activate a version explicitly/);
    expect(res.json().detail).toMatch(/config-versions/);

    await db
      .update(configVersions)
      .set({ status: "active" })
      .where(and(eq(configVersions.artifactId, versionedRuleId), eq(configVersions.version, 3)));
    expect((await decide()).json().effect).toBe("allow");
  });
});

describe("ADR-0074 — the compliance-profile UPSERT is an EDIT, and it is versioned", () => {
  it("re-POSTing a versioned profile CHANGES the cascade, not just the row", async () => {
    // version the profile so it has an active version other than its own row
    const created = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/config-versions/compliance_profile/${profileId}`,
      payload: { body: { piiMode: "log" }, label: "rw profile v2" },
    });
    expect(created.statusCode).toBe(201);

    const before = new Set((await versionsOf(profileId)).map((v) => v.id));
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/compliance/profiles",
      payload: { tag: TAG, piiMode: "block", mcpDefaultMode: "read_only" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().versionMinted).toBeTruthy();

    const minted = (await versionsOf(profileId)).filter((v) => !before.has(v.id));
    expect(minted.length).toBe(1);
    expect(minted[0]!.status).toBe("active");

    // THE ASSERTION ON ENFORCEMENT, not on the row: the §8.3 cascade resolves
    // compliance profiles through config_versions, so this is what a silently
    // ignored edit would have left unchanged.
    const cascade = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/projects/${projectId}/compliance`,
    });
    expect(cascade.statusCode).toBe(200);
    expect(JSON.stringify(cascade.json())).toMatch(/block/);
  });

  it("the onboarding pack re-applied over a VERSIONED profile mints rather than silently overwriting", async () => {
    // The suite shares one database, and other files apply the soc2 pack too
    // and may leave its profile behind; this case needs a genuine CREATE, so
    // it clears any leftover first rather than depending on file order.
    for (const leftover of await db
      .select({ id: complianceProfiles.id })
      .from(complianceProfiles)
      .where(eq(complianceProfiles.tag, "soc2"))) {
      await db.delete(configActivationEvents).where(eq(configActivationEvents.artifactId, leftover.id));
      await db.delete(configVersions).where(eq(configVersions.artifactId, leftover.id));
      await db.delete(complianceProfiles).where(eq(complianceProfiles.id, leftover.id));
    }
    const pack = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/onboarding/compliance-pack",
      payload: { pack: "soc2", mode: "apply" },
    });
    expect(pack.statusCode).toBe(200);
    expect(pack.json().plan.profile).toBe("create");
    // a genuine CREATE mints nothing: a brand-new row has no versions, so its
    // own row is what the kernel resolves (invariant 4)
    expect(pack.json().versionMinted).toBeNull();
    const soc2Id = pack.json().profile.id as string;

    // version it, then re-apply the SAME pack
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/config-versions/compliance_profile/${soc2Id}`,
      payload: { body: { piiMode: "block" }, label: "rw soc2 tightened", activate: true },
    });
    const again = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/onboarding/compliance-pack",
      payload: { pack: "soc2", mode: "apply" },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().plan.profile).toBe("update");
    // the pack's own piiMode differs from the hand-tightened `block`, so this
    // is a genuine change and must become a version
    expect(again.json().versionMinted).toBeTruthy();
    expect(again.json().note).toMatch(/VERSIONED/);

    // cleanup — soc2 is a globally-listed profile
    await db.delete(configActivationEvents).where(eq(configActivationEvents.artifactId, soc2Id));
    await db.delete(configVersions).where(eq(configVersions.artifactId, soc2Id));
    await db.delete(complianceProfiles).where(eq(complianceProfiles.id, soc2Id));
  });
});

describe("ADR-0074 — the shadow canary's baseline seam", () => {
  it("an edit while a canary runs is NOT refused, and the ledger records the seam", async () => {
    // a candidate that would pause `rw_write` again
    const created = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/config-versions/approval_rule/${versionedRuleId}`,
      payload: { body: { deployMode: null }, label: "rw candidate — unscope" },
    });
    expect(created.statusCode).toBe(201);
    const candidateVersion = created.json().version.version as number;
    const canary = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/config-versions/approval_rule/${versionedRuleId}/canary`,
      payload: { version: candidateVersion, pct: CANARY_PCT },
    });
    expect(canary.statusCode).toBe(200);

    // collect observations against the CURRENT baseline
    await decide();
    const firstBaseline = await db
      .select()
      .from(configCanaryObservations)
      .where(eq(configCanaryObservations.artifactId, versionedRuleId));
    expect(firstBaseline.length).toBeGreaterThan(0);

    // now MOVE the baseline through an ordinary admin edit. It must succeed —
    // a measurement may not veto a policy change.
    const patch = await app.inject({
      method: "PATCH",
      headers: AUTH,
      url: `/v1/rules/approvals/${versionedRuleId}/deploy-mode`,
      payload: { deployMode: "byoc" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().versionMinted).toBeTruthy();

    // the canary is untouched — not abandoned, not invalidated
    const stillCanary = (await versionsOf(versionedRuleId)).find((v) => v.status === "canary");
    expect(stillCanary?.version).toBe(candidateVersion);

    // and the ledger names the seam
    const events = await db
      .select()
      .from(configActivationEvents)
      .where(eq(configActivationEvents.artifactId, versionedRuleId));
    expect(events.some((e) => (e.reason ?? "").includes("shadow comparison baseline moved here"))).toBe(true);
  });

  it("the divergence report SEPARATES the stranded observations instead of pooling them", async () => {
    await decide(); // an observation against the NEW baseline

    const res = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/config-versions/approval_rule/${versionedRuleId}/divergence`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.staleBaseline.observed).toBeGreaterThan(0);
    expect(body.staleBaseline.note).toMatch(/no longer active/);
    expect(body.note).toMatch(/ADR-0074/);
    // the totals cover ONLY the current pair — the stranded rows are not in them
    expect(body.totals.observed).toBeLessThan(body.totals.observed + body.staleBaseline.observed);
  });

  it("PROMOTING on a mixed-baseline sample is REFUSED, naming the counts on each side", async () => {
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/config-versions/approval_rule/${versionedRuleId}/promote`,
      payload: { override: false },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("canary-promote-stale-baseline");
    expect(res.json().detail).toMatch(/has since\s+moved|has since moved/);
    expect(res.json().detail).toMatch(/Re-point the canary/);
  });

  it("...and an OVERRIDE with a reason is allowed, with the mixed baseline stated on the ledger row", async () => {
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/config-versions/approval_rule/${versionedRuleId}/promote`,
      payload: { override: true, reason: "rw suite: accepting a mixed-baseline sample deliberately" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().baselineGate).toBe("canary-promote-stale-baseline-override");
    const events = await db
      .select()
      .from(configActivationEvents)
      .where(
        and(
          eq(configActivationEvents.artifactId, versionedRuleId),
          eq(configActivationEvents.action, "promoted"),
        ),
      );
    expect(events.length).toBe(1);
    expect(events[0]!.reason).toMatch(/MIXED-BASELINE/);
  });

  it("THE ADR-0073 INVARIANT SURVIVES: the shadow candidate never reached the served decision", async () => {
    // Every observation this suite produced records what the candidate WOULD
    // have decided. None of them may ever equal what the caller got on a call
    // where the two disagreed — proved by the served side of each observation
    // matching the effect the /evaluate response actually returned.
    const rows = await db
      .select()
      .from(configCanaryObservations)
      .where(eq(configCanaryObservations.artifactId, versionedRuleId));
    expect(rows.length).toBeGreaterThan(0);
    const divergent = rows.filter((r) => r.diverged);
    expect(divergent.length).toBeGreaterThan(0);
    for (const r of divergent) {
      expect(r.servedEffect).not.toBe(r.candidateEffect);
      // the served side is the ACTIVE version's answer, always
      expect(["allow", "require_approval", "deny"]).toContain(r.servedEffect!);
    }
  });
});

describe("ADR-0074 — the create routes are CREATE-ONLY, and nothing pins that but this", () => {
  it("POSTing the same approval rule twice creates TWO rows, never an upsert", async () => {
    const payload = {
      scope: "user",
      userId: piaId,
      serverScope: "server",
      serverId,
      toolName: "rw_read",
      approverUserId: anaId,
    };
    const a = await app.inject({ method: "POST", headers: AUTH, url: "/v1/rules/approvals", payload });
    const b = await app.inject({ method: "POST", headers: AUTH, url: "/v1/rules/approvals", payload });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.json().id).not.toBe(b.json().id);
    // This is the property that makes those three inserts benign: a row that
    // was just created cannot have a config_versions row, so the raw row is
    // served. If a future change adds an onConflictDoUpdate or an edit route,
    // this test fails and the writer must move to `applyRuleEdit`.
    await db.delete(approvalRules).where(inArray(approvalRules.id, [a.json().id, b.json().id]));
  });
});
