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
  configActivationEvents,
  configCanaryObservations,
  configVersions,
  createDb,
  dataScopeRules,
  eq,
  inArray,
  rateLimits,
  runMigrations,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";

/**
 * Batch B1 (ADR-0073 residual, closed per ADR-0074's pattern) — THE ORDINARY
 * RULE-CRUD SURFACE GAINS UPDATE AND DELETE, AND BOTH TELL THE TRUTH ABOUT
 * ENFORCEMENT.
 *
 * Before this batch the surface was create + list only (plus the field-scoped
 * deploy-mode PATCH): an admin could not edit a rule's body or remove a rule
 * through the API at all. Landing the routes bare would have shipped
 * ADR-0074's defect on day one — a 200 whose row moved while dispatch kept
 * serving the active version — so both routes are proved HERE the ADR-0074
 * way: every load-bearing assertion is a REAL GOVERNED DECISION through
 * `POST /v1/evaluate`, never a column read.
 *
 * The DELETE semantics pinned by this file (the "active version pointing at
 * nothing" decision):
 *   - the rule row is deleted and the kernel stops loading it;
 *   - every version row is KEPT (immutable history, ADR-0048 property 1);
 *   - the active/canary POINTERS are demoted to 'retired' with an
 *     'artifact_deleted' ledger entry each, so no version claims to enforce
 *     for an artifact that no longer exists and the canaries index stops
 *     listing a comparison that can never move again.
 *
 * SHARED-STATE DISCIPLINE: everything `rc-` prefixed and owned by this suite;
 * deltas only (M-008); afterAll removes the rules, versions, events,
 * observations and this suite's audit rows.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "rc-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let anaId: string;
let piaId: string;
let serverId: string;
/** the rule under test: versioned, then edited and finally deleted through the
 * ordinary CRUD surface */
let versionedRuleId: string;
/** an identical rule that is NEVER versioned — invariant 4's control */
let unversionedRuleId: string;
let rateLimitId: string;
let dataScopeRuleId: string;

async function makeUser(email: string) {
  const res = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email, displayName: email.split("@")[0] },
  });
  if (res.statusCode < 300) return { id: res.json().id as string };
  const list = await app.inject({ method: "GET", headers: AUTH, url: "/v1/users" });
  const found = list.json().users.find((u: { email: string }) => u.email === email);
  if (!found) throw new Error(`makeUser failed: ${res.statusCode} ${res.body}`);
  return { id: found.id as string };
}

/** a REAL governed decision — the only assertion that cannot pass against a
 * write that silently changed nothing (ADR-0074's own lesson) */
async function decide(tool = "rc_write") {
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

  anaId = (await makeUser("rc-ana@example.com")).id;
  piaId = (await makeUser("rc-pia@example.com")).id;

  const s = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/servers",
    payload: { name: "rc-server", url: "http://127.0.0.1:9" },
  });
  if (s.statusCode < 300) {
    serverId = s.json().id;
  } else {
    const list = await app.inject({ method: "GET", headers: AUTH, url: "/v1/servers" });
    serverId = list.json().servers.find((x: { name: string }) => x.name === "rc-server").id;
  }
  for (const tool of [
    { name: "rc_read", kind: "read" },
    { name: "rc_write", kind: "write" },
  ]) {
    await app.inject({ method: "POST", headers: AUTH, url: `/v1/servers/${serverId}/tools`, payload: tool });
  }
  await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/grants/tools",
    payload: { userId: piaId, serverId, toolName: "rc_write" },
  });

  // two identical approval rules pausing rc_write for pia — created through
  // the ordinary create routes, exactly as an admin would
  for (const slot of ["versioned", "unversioned"] as const) {
    const r = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/rules/approvals",
      payload: {
        scope: "user",
        userId: piaId,
        serverScope: "server",
        serverId,
        toolName: "rc_write",
        approverUserId: anaId,
      },
    });
    expect(r.statusCode).toBe(201);
    if (slot === "versioned") versionedRuleId = r.json().id;
    else unversionedRuleId = r.json().id;
  }
});

afterAll(async () => {
  await restoreStrictAdmission?.();
  const artifacts = [versionedRuleId, unversionedRuleId, rateLimitId, dataScopeRuleId].filter(Boolean);
  if (artifacts.length) {
    await db
      .delete(configCanaryObservations)
      .where(inArray(configCanaryObservations.artifactId, artifacts));
    await db.delete(configActivationEvents).where(inArray(configActivationEvents.artifactId, artifacts));
    await db.delete(configVersions).where(inArray(configVersions.artifactId, artifacts));
    await db.delete(approvalRules).where(inArray(approvalRules.id, artifacts));
    await db.delete(rateLimits).where(inArray(rateLimits.id, artifacts));
    await db.delete(dataScopeRules).where(inArray(dataScopeRules.id, artifacts));
  }
  if (piaId) await db.delete(auditLog).where(eq(auditLog.userId, piaId));
});

// ---------------------------------------------------------------------------

describe("B1 — PATCH /v1/rules/:kind/:ruleId mints on a versioned rule and the kernel follows", () => {
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
      payload: { body: { writeOnly: true }, label: "rc v2 — draft, never activated" },
    });
    expect(created.statusCode).toBe(201);
    expect((await decide()).json().effect).toBe("require_approval");
    const rows = await versionsOf(versionedRuleId);
    expect(rows.find((r) => r.version === 1)!.status).toBe("active");
    expect(rows.find((r) => r.version === 2)!.status).toBe("draft");
  });

  it("PATCHing toolName on the VERSIONED rule mints + activates, and evaluation genuinely changes", async () => {
    const before = new Set((await versionsOf(versionedRuleId)).map((v) => v.id));

    const res = await app.inject({
      method: "PATCH",
      headers: AUTH,
      url: `/v1/rules/approvals/${versionedRuleId}`,
      payload: { toolName: "rc_read" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().versionMinted).toBe(3);
    expect(res.json().note).toMatch(/minted as version 3 and activated/);

    // set-difference on id, never a row picked by position
    const after = await versionsOf(versionedRuleId);
    const minted = after.filter((v) => !before.has(v.id));
    expect(minted.length).toBe(1);
    expect(minted[0]!.status).toBe("active");
    expect(minted[0]!.body).toMatchObject({ toolName: "rc_read" });
    expect(minted[0]!.label).toMatch(/PATCH \/v1\/rules\/approvals/);

    // THE ASSERTION THE OLD DISCLOSURE SAID WOULD FAIL: the versioned rule now
    // binds rc_read only, so the rc_write decision is carried by the OTHER
    // rule. Under the pre-B1 failure mode (row written, version untouched)
    // dispatch would still resolve the active body's rc_write and this
    // decision would name versionedRuleId.
    const decided = await decide();
    expect(decided.json().effect).toBe("require_approval");
    expect(decided.json().ruleId).toBe(unversionedRuleId);
  });

  it("re-PATCHing the SAME value mints nothing — an idempotent write is not a policy change", async () => {
    const before = (await versionsOf(versionedRuleId)).length;
    const res = await app.inject({
      method: "PATCH",
      headers: AUTH,
      url: `/v1/rules/approvals/${versionedRuleId}`,
      payload: { toolName: "rc_read" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().versionMinted).toBeNull();
    expect(res.json().note).toMatch(/No version was minted/);
    expect((await versionsOf(versionedRuleId)).length).toBe(before);
  });

  it("a SELECTION field is refused with the remedy named — rebinding is a new rule, not an edit", async () => {
    const res = await app.inject({
      method: "PATCH",
      headers: AUTH,
      url: `/v1/rules/approvals/${versionedRuleId}`,
      payload: { userId: anaId },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("selection_field_not_editable");
    expect(res.json().detail).toMatch(/Create a new rule/);
    // and nothing moved — neither a version nor the decision
    expect((await decide()).json().ruleId).toBe(unversionedRuleId);
  });

  it("an UNRESOLVABLE artifact refuses the edit with 409 — default-deny extends to writes", async () => {
    await db
      .update(configVersions)
      .set({ status: "superseded" })
      .where(and(eq(configVersions.artifactId, versionedRuleId), eq(configVersions.status, "active")));
    const res = await app.inject({
      method: "PATCH",
      headers: AUTH,
      url: `/v1/rules/approvals/${versionedRuleId}`,
      payload: { toolName: "rc_write" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("config_version_unresolvable");
    await db
      .update(configVersions)
      .set({ status: "active" })
      .where(and(eq(configVersions.artifactId, versionedRuleId), eq(configVersions.version, 3)));
  });
});

describe("B1 — DELETE /v1/rules/:kind/:ruleId: the row goes, the history stays TRUE", () => {
  it("deleting the VERSIONED rule stops it binding, keeps every version, and retires the pointer", async () => {
    const res = await app.inject({
      method: "DELETE",
      headers: AUTH,
      url: `/v1/rules/approvals/${versionedRuleId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(true);
    expect(res.json().versionsRetired).toBe(1);
    expect(res.json().versionCount).toBe(3);
    expect(res.json().note).toMatch(/KEPT/);

    // the kernel proof: the rule no longer loads, so the decision is carried
    // by the unversioned rule alone
    const decided = await decide();
    expect(decided.json().effect).toBe("require_approval");
    expect(decided.json().ruleId).toBe(unversionedRuleId);

    // NO ACTIVE VERSION POINTS AT NOTHING: all three rows survive, none is
    // active or canary, and the demotion is 'retired' — not 'superseded' or
    // 'rolled_back', which would misstate history
    const rows = await versionsOf(versionedRuleId);
    expect(rows.length).toBe(3);
    expect(rows.filter((r) => r.status === "active" || r.status === "canary")).toEqual([]);
    expect(rows.filter((r) => r.status === "retired").length).toBe(1);

    // the demotion is LEDGERED, append-only
    const events = await db
      .select()
      .from(configActivationEvents)
      .where(
        and(
          eq(configActivationEvents.artifactId, versionedRuleId),
          eq(configActivationEvents.action, "artifact_deleted"),
        ),
      );
    expect(events.length).toBe(1);
    expect(events[0]!.reason).toMatch(/kept \(status 'retired'\)/);

    // and the read surface says the artifact is gone
    const lineage = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/config-versions/approval_rule/${versionedRuleId}`,
    });
    expect(lineage.json().artifactDeleted).toBe(true);
    expect(lineage.json().active).toBeNull();
  });

  it("deleting it twice is a 404, not a silent success", async () => {
    const res = await app.inject({
      method: "DELETE",
      headers: AUTH,
      url: `/v1/rules/approvals/${versionedRuleId}`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("unknown_rule");
  });

  it("the UNVERSIONED rule keeps plain-write semantics through PATCH (invariant 4) and deletes cleanly", async () => {
    // the plain row write is still a real enforcement change — proved through
    // the kernel like everything else: retargeting the rule to rc_read frees
    // rc_write entirely (the versioned rule is already gone)
    const patched = await app.inject({
      method: "PATCH",
      headers: AUTH,
      url: `/v1/rules/approvals/${unversionedRuleId}`,
      payload: { toolName: "rc_read" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().versionMinted).toBeNull();
    expect((await versionsOf(unversionedRuleId)).length).toBe(0);
    expect((await decide()).json().effect).toBe("allow");

    const res = await app.inject({
      method: "DELETE",
      headers: AUTH,
      url: `/v1/rules/approvals/${unversionedRuleId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().versionsRetired).toBe(0);
    expect(res.json().versionCount).toBe(0);
    expect(res.json().note).toMatch(/no stored versions/);
    expect((await decide()).json().effect).toBe("allow");
  });
});

describe("B1 — the same surface for rate limits, proved through a kernel DENY", () => {
  it("PATCHing maxCalls on a versioned rate limit changes the decision; delete retires active AND canary", async () => {
    const created = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/rules/rate-limits",
      payload: {
        scope: "user",
        userId: piaId,
        serverScope: "server",
        serverId,
        toolName: "rc_write",
        maxCalls: 5,
        windowSeconds: 3600,
      },
    });
    expect(created.statusCode).toBe(201);
    rateLimitId = created.json().id;
    expect((await decide()).json().effect).toBe("allow");

    // version it (v1 baseline active + v2 draft), then edit through CRUD
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/config-versions/rate_limit/${rateLimitId}`,
      payload: { body: { maxCalls: 5 }, label: "rc limit v2 draft" },
    });
    const res = await app.inject({
      method: "PATCH",
      headers: AUTH,
      url: `/v1/rules/rate-limits/${rateLimitId}`,
      payload: { maxCalls: 0 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().versionMinted).toBe(3);

    // maxCalls 0: 0 >= 0 exhausts immediately — a DENY only the RESOLVED
    // version can produce. Under the pre-B1 failure mode the row would say 0
    // while the active body said 5, and this stayed `allow`.
    const denied = await decide();
    expect(denied.json().effect).toBe("deny");
    expect(denied.json().ruleId).toBe(rateLimitId);
    expect(denied.json().reason).toMatch(/rate limit exhausted/);

    // rollback undoes it through the same version machinery
    const rb = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/config-versions/rate_limit/${rateLimitId}/rollback`,
      payload: { reason: "rc suite: undo the zero limit" },
    });
    expect(rb.statusCode).toBe(200);
    expect((await decide()).json().effect).toBe("allow");

    // put a canary up too, so the delete demotes BOTH pointers
    const canary = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/config-versions/rate_limit/${rateLimitId}/canary`,
      payload: { version: 3, pct: 50 },
    });
    expect(canary.statusCode).toBe(200);

    const del = await app.inject({
      method: "DELETE",
      headers: AUTH,
      url: `/v1/rules/rate-limits/${rateLimitId}`,
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().versionsRetired).toBe(2);
    expect((await decide()).json().effect).toBe("allow");

    const rows = await versionsOf(rateLimitId);
    expect(rows.filter((r) => r.status === "active" || r.status === "canary")).toEqual([]);
    // the demoted canary carries no percentage any more (DB CHECK: only a
    // canary status may carry one)
    expect(rows.every((r) => r.canaryPct === null)).toBe(true);

    // ...and the canaries index no longer lists a comparison that can never
    // accumulate another observation (delta: absence of THIS artifact only)
    const canaries = await app.inject({ method: "GET", headers: AUTH, url: "/v1/config-versions/canaries" });
    expect(
      canaries.json().canaries.filter((c: { artifactId: string }) => c.artifactId === rateLimitId),
    ).toEqual([]);
  });
});

describe("B1 — data scopes ride the same choke point", () => {
  it("PATCHing allowedValues on a versioned data-scope rule mints + activates", async () => {
    const created = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/rules/data-scopes",
      payload: {
        scope: "user",
        userId: piaId,
        serverScope: "server",
        serverId,
        toolName: "rc_write",
        argPath: "region",
        allowedValues: ["eu"],
      },
    });
    expect(created.statusCode).toBe(201);
    dataScopeRuleId = created.json().id;
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/config-versions/data_scope_rule/${dataScopeRuleId}`,
      payload: { body: { allowedValues: ["eu"] }, label: "rc scope v2 draft" },
    });

    const before = new Set((await versionsOf(dataScopeRuleId)).map((v) => v.id));
    const res = await app.inject({
      method: "PATCH",
      headers: AUTH,
      url: `/v1/rules/data-scopes/${dataScopeRuleId}`,
      payload: { allowedValues: ["eu", "us"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().versionMinted).toBe(3);
    expect(res.json().allowedValues).toEqual(["eu", "us"]);
    // The kernel-following proof for the shared choke point rides the
    // approval and rate-limit cases above (a data-scope decision needs call
    // args, which /v1/evaluate does not carry); what THIS case pins is that
    // the third kind reaches the same minting path — the activated version,
    // not just the row, carries the widened list.
    const minted = (await versionsOf(dataScopeRuleId)).filter((v) => !before.has(v.id));
    expect(minted.length).toBe(1);
    expect(minted[0]!.status).toBe("active");
    expect(minted[0]!.body).toMatchObject({ allowedValues: ["eu", "us"] });
  });
});
