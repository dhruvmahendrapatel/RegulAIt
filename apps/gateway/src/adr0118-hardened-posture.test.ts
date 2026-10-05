import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, auditLog, createDb, eq, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { buildPostureReport } from "./posture-preset.js";
import { loadOrgSettings } from "./org-settings.js";

/**
 * ADR-0118 — THE HARDENED POSTURE PRESET.
 *
 * THE ONLY EVIDENCE THAT MATTERS HERE IS BEHAVIOURAL. Asserting that a column
 * moved from "none" to "block" proves a column moved. The claim the deck makes
 * is that the product ENFORCES, so the load-bearing tests below send the SAME
 * request twice — once before hardening and once after — and require it to be
 * allowed the first time and refused the second, by the reason hardening was
 * supposed to introduce (M-026: verify the reason, never merely the status).
 *
 * Every fixture is resolved by an ID created in this file, never by a natural
 * key another file could also be using (M-037).
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `adr0118-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let userId: string;
let userAuth: { authorization: string };
let agentId: string;

/** Restore the shipped defaults for the columns this file moves, so the suite's
 * shared database is handed on exactly as it was found. */
async function restoreShippedDefaults() {
  const r = await app.inject({
    method: "PUT",
    url: "/v1/org/settings",
    headers: AUTH,
    payload: {
      defaultPiiMode: "none",
      mcpAdmissionMode: "enforce", // ADR-0181 ships enforce
      useCaseGateMode: "off",
      dispatchAttributionRequired: false,
      semanticCachePolicy: "opt_in",
    },
  });
  // Assert the restore, do not assume it. A silently-failing helper leaves
  // every later test measuring the previous test's leftovers, which is how
  // five of these failed the first time this file ran.
  expect(r.statusCode).toBe(200);
  // `mrmEnforced` is deliberately NOT on the generic settings PUT — it has its
  // own route because turning it on starts refusing dispatch.
  const m = await app.inject({
    method: "POST",
    url: "/v1/mrm/enforcement",
    headers: AUTH,
    payload: { enforced: false },
  });
  expect(m.statusCode).toBe(200);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "d".repeat(64) });

  const u = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email: `adr0118-${RUN}@example.com`, displayName: "ADR118 User" },
  });
  userId = u.json().id;
  const k = await app.inject({
    method: "POST",
    url: `/v1/users/${userId}/keys`,
    headers: AUTH,
    payload: { name: "adr0118" },
  });
  userAuth = { authorization: `Bearer ${k.json().token}` };

  const a = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: AUTH,
    payload: {
      name: `adr0118-mock-${RUN}`,
      provider: "mock",
      tier: 1,
      costPerMTokIn: 3,
      costPerMTokOut: 15,
      model: `adr0118-model-${RUN}`,
    },
  });
  agentId = a.json().id;
  await app.inject({
    method: "POST",
    url: "/v1/grants/agents",
    headers: AUTH,
    payload: { userId, agentId },
  });

  await restoreShippedDefaults();
});

afterAll(async () => {
  await restoreShippedDefaults();
  await app.close();
});

describe("the posture READ — answering 'what is enforcing right now?'", () => {
  it("reports the shipped defaults as NOT hardened, and names what each control would refuse", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/org/posture", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.hardened).toBe(false);
    // positive control: the report is really describing THIS deployment's row
    const pii = body.controls.find((c: { key: string }) => c.key === "defaultPiiMode");
    expect(pii).toBeTruthy();
    expect(pii.current).toBe("none");
    expect(pii.hardened).toBe("block");
    expect(pii.satisfied).toBe(false);
    expect(pii.settable).toBe(true);
    // the blast radius is the reason this endpoint is worth reading
    expect(pii.refuses.length).toBeGreaterThan(40);

    // every settings-backed control carries a non-empty `refuses`
    for (const c of body.controls) expect(typeof c.refuses).toBe("string");
  });

  it("reports the two environment-backed controls as NOT settable, with their OBSERVED state", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/org/posture", headers: AUTH });
    const body = res.json();

    const anchor = body.controls.find(
      (c: { key: string }) => c.key === "auditAnchorTamperResistant",
    );
    expect(anchor.settable).toBe(false);
    // observed, not configured: with no S3 env this is the local buffer, which
    // grades itself false — the whole point of ADR-0060's precedent
    expect(anchor.current.tamperResistant).toBe(false);
    expect(anchor.satisfied).toBe(false);

    const sched = body.controls.find((c: { key: string }) => c.key === "schedulerEnabled");
    expect(sched.settable).toBe(false);

    expect(body.summary.blockedByEnvironment).toContain("auditAnchorTamperResistant");
    expect(body.summary.blockedByEnvironment).toContain("schedulerEnabled");
  });

  it("the report is a pure read — it changes nothing", async () => {
    const before = await loadOrgSettings(db);
    await app.inject({ method: "GET", url: "/v1/org/posture", headers: AUTH });
    const after = await loadOrgSettings(db);
    expect(after.defaultPiiMode).toBe(before.defaultPiiMode);
    expect(after.updatedAt?.getTime()).toBe(before.updatedAt?.getTime());
  });
});

describe("applying the preset ENFORCES — allowed before, refused after", () => {
  it("PII: the same dispatch is allowed before hardening and refused after, for a PII reason", async () => {
    await restoreShippedDefaults();

    const payload = {
      mode: "execute" as const,
      input: "my ssn is 123-45-6789",
      dispatch: true,
    };

    // BEFORE — allowed. This is the positive half that makes the refusal below
    // non-vacuous: without it, a route that refused everything would pass.
    const before = await app.inject({
      method: "POST",
      url: `/v1/agents/${agentId}/invoke`,
      headers: userAuth,
      payload,
    });
    expect(before.statusCode).toBe(200);

    const harden = await app.inject({
      method: "POST",
      url: "/v1/org/posture/harden",
      headers: AUTH,
      payload: {},
    });
    expect(harden.statusCode).toBe(200);

    // AFTER — refused, and refused for the RIGHT reason (M-026)
    const after = await app.inject({
      method: "POST",
      url: `/v1/agents/${agentId}/invoke`,
      headers: userAuth,
      payload,
    });
    expect(after.statusCode).not.toBe(200);
    // Name the error, not a substring of the whole body: the response carries
    // a policy decision, a trace and an optimiser block, any of which could
    // contain the word by coincidence.
    expect(after.json().error).toBe("pii_blocked");

    await restoreShippedDefaults();
  });

  it("ordinary prose: allowed before, refused after — and the reason is one the preset introduced", async () => {
    await restoreShippedDefaults();

    const payload = { mode: "execute" as const, input: "ordinary prose", dispatch: true };

    const before = await app.inject({
      method: "POST",
      url: `/v1/agents/${agentId}/invoke`,
      headers: userAuth,
      payload,
    });
    expect(before.statusCode).toBe(200);

    await app.inject({
      method: "POST",
      url: "/v1/org/posture/harden",
      headers: AUTH,
      payload: {},
    });

    const after = await app.inject({
      method: "POST",
      url: `/v1/agents/${agentId}/invoke`,
      headers: userAuth,
      payload,
    });
    expect(after.statusCode).toBe(409);
    // The refusal must be attributable to a control this preset turned on, not
    // to some unrelated policy. Several of the hardened gates can legitimately
    // answer first — see the isolation test below for why this is a set and not
    // a single value.
    expect(after.json().error).toMatch(
      /^(mrm_approval_required|attribution_required|pii_blocked|use_case_.*)$/,
    );

    await restoreShippedDefaults();
  });

  /**
   * THE GATES ARE ORDERED, AND THE PRESET TURNS ON SEVERAL AT ONCE. Applying
   * the whole preset and asserting "refused for attribution" would be testing
   * the PIPELINE ORDER, not the attribution gate: with everything hardened,
   * `mrmEnforced` answers first and returns `mrm_approval_required`, so an
   * assertion naming attribution fails even though the attribution gate is
   * perfectly healthy. (The first draft of this file made exactly that mistake
   * and the strengthened assertion caught it — M-026 again.)
   *
   * So each gate the preset turns on is ALSO proved in isolation, by moving
   * that one dial and nothing else.
   */
  it("attribution, in ISOLATION: only that dial moves, and the refusal names it", async () => {
    await restoreShippedDefaults();

    const payload = { mode: "execute" as const, input: "ordinary prose", dispatch: true };

    const before = await app.inject({
      method: "POST",
      url: `/v1/agents/${agentId}/invoke`,
      headers: userAuth,
      payload,
    });
    expect(before.statusCode).toBe(200);

    const put = await app.inject({
      method: "PUT",
      url: "/v1/org/settings",
      headers: AUTH,
      payload: { dispatchAttributionRequired: true },
    });
    expect(put.statusCode).toBe(200);

    const after = await app.inject({
      method: "POST",
      url: `/v1/agents/${agentId}/invoke`,
      headers: userAuth,
      payload,
    });
    expect(after.statusCode).toBe(409);
    expect(after.json().error).toBe("attribution_required");

    await restoreShippedDefaults();
  });
});

describe("what the preset does NOT do", () => {
  it("leaves the OPTIMISATION group alone unless it is asked for", async () => {
    await restoreShippedDefaults();

    const res = await app.inject({
      method: "POST",
      url: "/v1/org/posture/harden",
      headers: AUTH,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    // positive: enforcement really was applied by this same call
    expect(Object.keys(res.json().applied)).toContain("defaultPiiMode");
    // negative, paired with the positive above (M-033)
    expect(Object.keys(res.json().applied)).not.toContain("semanticCachePolicy");
    expect((await loadOrgSettings(db)).semanticCachePolicy).toBe("opt_in");

    const both = await app.inject({
      method: "POST",
      url: "/v1/org/posture/harden",
      headers: AUTH,
      payload: { groups: ["enforcement", "optimisation"] },
    });
    expect(Object.keys(both.json().applied)).toContain("semanticCachePolicy");
    expect((await loadOrgSettings(db)).semanticCachePolicy).toBe("always");

    await restoreShippedDefaults();
  });

  it("does NOT set the other two attribution switches, and its own text says so", async () => {
    /**
     * FOUND WHILE BUILDING THE DEMO ENVIRONMENT, and the reason this test
     * exists rather than a comment.
     *
     * There are THREE independent attribution switches. `org_settings.
     * dispatch_attribution_required` guards the native governed dispatch;
     * `interception_settings.require_project_attribution` guards the compat
     * edge; `interception_settings.require_mcp_attribution` guards the MCP
     * proxy. The schema has always said they guard surfaces each other cannot
     * reach — but this preset's `refuses` sentence read "any dispatch that
     * names no project", which an operator hardening a deployment would
     * reasonably take to mean all of them. A fully hardened deployment still
     * accepts an unattributed MCP tool call.
     *
     * The blast-radius column is the whole value of the posture read. So the
     * scope is asserted BOTH ways: the preset really does leave the other two
     * alone, AND the sentence really does say which surfaces stay open. If
     * someone later widens the preset, this fails until the sentence is
     * rewritten to match — which is the point.
     */
    await restoreShippedDefaults();
    const res = await app.inject({
      method: "POST",
      url: "/v1/org/posture/harden",
      headers: AUTH,
      payload: { groups: ["enforcement"] },
    });
    expect(res.statusCode).toBe(200);

    // positive control: the switch this preset DOES own really moved
    expect(Object.keys(res.json().applied)).toContain("dispatchAttributionRequired");
    expect((await loadOrgSettings(db)).dispatchAttributionRequired).toBe(true);

    // the two it does not own are absent from the preset entirely — not set,
    // not reported as applied, not reported as already-satisfied
    const outcome = res.json();
    const named = [
      ...Object.keys(outcome.applied),
      ...outcome.alreadySatisfied,
      ...outcome.notSettable.map((n: { key: string }) => n.key),
    ];
    expect(named).not.toContain("requireProjectAttribution");
    expect(named).not.toContain("requireMcpAttribution");

    // and the DISCLOSURE: the control's own sentence names the surfaces that
    // stay open, so a reader of the posture page is not misled by it
    const report = await buildPostureReport(await loadOrgSettings(db), { env: {} as NodeJS.ProcessEnv });
    const attribution = report.controls.find((c) => c.key === "dispatchAttributionRequired")!;
    expect(attribution.refuses).toMatch(/require_mcp_attribution/);
    expect(attribution.refuses).toMatch(/require_project_attribution/);
    expect(attribution.refuses).toMatch(/unattributed MCP tool call/);

    await restoreShippedDefaults();
  });

  it("never claims the environment-backed controls, even when everything settable is hardened", async () => {
    await restoreShippedDefaults();
    const res = await app.inject({
      method: "POST",
      url: "/v1/org/posture/harden",
      headers: AUTH,
      payload: { groups: ["enforcement", "optimisation"] },
    });
    const body = res.json();

    // every settable control is now satisfied ...
    for (const c of body.posture.controls.filter((x: { settable: boolean }) => x.settable)) {
      expect(c.satisfied).toBe(true);
    }
    // ... and the overall verdict is STILL false, because two are not settable
    expect(body.posture.hardened).toBe(false);
    expect(body.notSettable.map((n: { key: string }) => n.key)).toContain("schedulerEnabled");
    expect(body.notSettable.map((n: { key: string }) => n.key)).toContain(
      "auditAnchorTamperResistant",
    );

    await restoreShippedDefaults();
  });

  it("refuses an unknown group and changes NOTHING", async () => {
    await restoreShippedDefaults();
    const res = await app.inject({
      method: "POST",
      url: "/v1/org/posture/harden",
      headers: AUTH,
      payload: { groups: ["enforcement", "not-a-group"] },
    });
    expect(res.statusCode).toBe(400);
    // the valid group in the same request must NOT have been applied
    expect((await loadOrgSettings(db)).defaultPiiMode).toBe("none");
  });
});

describe("idempotency and the audit trail", () => {
  it("a second application changes nothing and says so", async () => {
    await restoreShippedDefaults();

    const first = await app.inject({
      method: "POST",
      url: "/v1/org/posture/harden",
      headers: AUTH,
      payload: {},
    });
    expect(Object.keys(first.json().applied).length).toBeGreaterThan(0);

    const second = await app.inject({
      method: "POST",
      url: "/v1/org/posture/harden",
      headers: AUTH,
      payload: {},
    });
    expect(Object.keys(second.json().applied).length).toBe(0);
    expect(second.json().alreadySatisfied).toContain("defaultPiiMode");
    // and it still reports what it cannot do, so "nothing to do" is never read
    // as "you are fully hardened"
    expect(second.json().notSettable.length).toBeGreaterThan(0);

    await restoreShippedDefaults();
  });

  it("writes ONE audit row under its own rule id, naming what moved and from what", async () => {
    await restoreShippedDefaults();

    const before = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, "org-posture-hardened"));

    await app.inject({
      method: "POST",
      url: "/v1/org/posture/harden",
      headers: AUTH,
      payload: {},
    });

    const after = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, "org-posture-hardened"));
    expect(after.length).toBe(before.length + 1);

    const row = after[after.length - 1]!;
    const detail = row.detail as { applied: Record<string, [unknown, unknown]> };
    expect(detail.applied.defaultPiiMode).toEqual(["none", "block"]);
    // its own rule id, NOT org-settings-updated: an operator must be able to
    // tell "an admin edited one dial" from "an admin applied the preset"
    expect(row.ruleId).toBe("org-posture-hardened");

    // the idempotent re-application mints NO second row
    await app.inject({
      method: "POST",
      url: "/v1/org/posture/harden",
      headers: AUTH,
      payload: {},
    });
    const afterNoop = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, "org-posture-hardened"));
    expect(afterNoop.length).toBe(after.length);

    await restoreShippedDefaults();
  });
});

describe("the report builder, unit-level", () => {
  it("grades the anchor from the OBSERVED sink, not from the fact a bucket was named", async () => {
    const settings = await loadOrgSettings(db);
    // an env that NAMES an S3 bucket but whose lock state cannot be confirmed
    const report = await buildPostureReport(settings, {
      env: { REGULAIT_AUDIT_ANCHOR_DIR: "/tmp/adr0118-anchor" } as NodeJS.ProcessEnv,
    });
    const anchor = report.controls.find((c) => c.key === "auditAnchorTamperResistant")!;
    expect((anchor.current as { tamperResistant: boolean }).tamperResistant).toBe(false);
    expect(anchor.satisfied).toBe(false);
  });

  it("counts enforcement and optimisation separately", async () => {
    const settings = await loadOrgSettings(db);
    const report = await buildPostureReport(settings, { env: {} as NodeJS.ProcessEnv });
    expect(report.summary.optimisationTotal).toBe(1);
    expect(report.summary.enforcementTotal).toBeGreaterThan(1);
  });
});
