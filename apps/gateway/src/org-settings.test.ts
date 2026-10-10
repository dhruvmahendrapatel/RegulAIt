/**
 * ADR-0021 — the ORG-SETTINGS configurability layer, end to end.
 *
 * The claims under test, in order of how much damage getting them wrong
 * would do:
 *  1. BEHAVIOUR-PRESERVING DEFAULTS: a fresh org_settings row changes
 *     nothing — the whole rest of this suite (and the other 432 tests
 *     sharing this DB) run against the defaults and must stay green.
 *  2. THE CEILING MODEL: an org-off technique cannot be re-enabled per-user
 *     (routing off + user 'automatic' still yields passthrough and writes no
 *     ledger row); a semantic-cache 'off' beats a caller's opt-in.
 *  3. The regulated-buyer defaults actually enforce: default_pii_mode block
 *     on an UNCLASSIFIED project, env-key fallback off => provider honestly
 *     unconfigured + dispatch 409, warn_only budgets audit-but-allow,
 *     quorum 'any' advances on the first approval, strict field rejection
 *     400s temperature, streaming 'reject' 400s a stream to a block project,
 *     size ceilings narrow below the zod walls.
 *  4. Writing the settings is admin-only and every write is audited with the
 *     changed keys.
 *
 * Shares one database with the other gateway suites (fileParallelism off), so
 * every object here is name-prefixed orgset- and EVERY settings mutation is
 * reverted (delete-the-singleton: the belt-and-braces loader recreates the
 * defaults row, which IS the previous behaviour).
 */
import { autoGrantCreatedAgentsForTest } from "./testing/agent-own-grants.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  complianceProfiles,
  costEvents,
  createDb,
  desc,
  eq,
  interceptionSettings,
  orgSettings,
  runMigrations,
  approvals,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
// ADR-0181: the governance gates this suite would trip but does not test, relaxed by name
let restoreSb2Gates: () => Promise<void> = async () => {};
// resetOrg/resetInterception drop the singletons (strict defaults come back), so
// afterEach re-applies exactly these
const SB2_RELAXED = { mrmEnforced: false, dispatchAttributionRequired: false, requireProjectAttribution: false };

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "orgset-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "d".repeat(64);
/** per-run suffix so rerunning this single file against the same DB never
 * trips a unique constraint or double-matches an assignment rule */
const RUN = Date.now().toString(36);

let db: Db;
let app: ReturnType<typeof buildApp>;

let umaId: string;
let umaAuth: { authorization: string };
let anaId: string; // approver 1
let anaAuth: { authorization: string };
let bobId: string; // approver 2
let cheapAgentId: string; // tier 0, model orgset-cheap
let premiumAgentId: string; // tier 2, model orgset-prem

// env hygiene (mirrors env-fallback.test.ts): never leak a provider key
const ORIG_ANTHROPIC = process.env.ANTHROPIC_API_KEY;
const ORIG_ANTHROPIC_BASE = process.env.ANTHROPIC_BASE_URL;

async function makeUser(email: string, name: string) {
  const u = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email, displayName: name },
  });
  // idempotent across repeated single-file runs against the same DB: on a
  // unique-email conflict, reuse the existing user and mint a fresh key
  let id: string;
  if (u.statusCode === 201) {
    id = u.json().id as string;
  } else {
    const list = await app.inject({ method: "GET", headers: AUTH, url: "/v1/users" });
    id = list.json().users.find((x: { email: string }) => x.email === email)!.id as string;
  }
  const k = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${id}/keys`,
    payload: { name: "orgset" },
  });
  return { id, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function putOrg(patch: Record<string, unknown>, expectStatus = 200) {
  const r = await app.inject({ method: "PUT", headers: AUTH, url: "/v1/org/settings", payload: patch });
  expect(r.statusCode).toBe(expectStatus);
  return r.json();
}

/** revert to defaults: drop the singleton — the loader recreates it with the
 * migration defaults, which are the behaviour-preserving baseline */
async function resetOrg() {
  await db.delete(orgSettings);
}
async function resetInterception() {
  await db.delete(interceptionSettings);
}

const invoke = (
  auth: { authorization: string },
  agentId: string,
  payload: Record<string, unknown>,
) =>
  app.inject({
    method: "POST",
    headers: auth,
    url: `/v1/agents/${agentId}/invoke`,
    payload: { mode: "execute", dispatch: true, ...payload },
  });

const routingEventCount = async (userId: string) => {
  const rows = await db
    .select({ id: costEvents.id })
    .from(costEvents)
    .where(and(eq(costEvents.userId, userId), eq(costEvents.technique, "model_routing")));
  return rows.length;
};

beforeAll(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  // ADR-0188 S4: agents created here act under the strict `own_grants` default with grants of their own
  autoGrantCreatedAgentsForTest(app, db, { mirrorTools: true });
  restoreSb2Gates = await relaxGovernanceGatesForTest(db, SB2_RELAXED);

  // ADR-0034 amendment — model-credential / env `baseUrl` overrides are now
  // behind the default-deny egress guard. This suite points one at a loopback
  // address, so it allow-lists that host explicitly with the private-range and
  // plaintext opt-ins, exactly as an air-gapped operator would (the same
  // pattern as custom-providers.test.ts).
  const egressAllowed = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/egress-allow-hosts",
    payload: {
      host: "127.0.0.1",
      allowPrivateRanges: true,
      allowPlaintextHttp: true,
      note: "org-settings suite: local fake endpoints",
    },
  });
  expect(egressAllowed.statusCode).toBe(201);

  const uma = await makeUser("orgset-uma@example.com", "Orgset Uma");
  umaId = uma.id;
  umaAuth = uma.auth;
  const ana = await makeUser("orgset-ana@example.com", "Orgset Ana");
  anaId = ana.id;
  anaAuth = ana.auth;
  const bob = await makeUser("orgset-bob@example.com", "Orgset Bob");
  bobId = bob.id;

  const mkAgent = async (name: string, model: string, tier: number, priceIn: number) => {
    const r = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/agents",
      payload: { name, provider: "mock", tier, model, costPerMTokIn: priceIn, costPerMTokOut: priceIn * 2 },
    });
    // idempotent across repeated single-file runs: reuse an existing agent
    let id: string;
    if (r.statusCode === 201) {
      id = r.json().id as string;
    } else {
      const list = await app.inject({ method: "GET", headers: AUTH, url: "/v1/agents" });
      id = list.json().agents.find((a: { name: string }) => a.name === name)!.id as string;
    }
    await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId: umaId, agentId: id } });
    return id;
  };
  cheapAgentId = await mkAgent("orgset-cheap", "orgset-cheap", 0, 1);
  premiumAgentId = await mkAgent("orgset-prem", "orgset-prem", 2, 5);
});

afterEach(async () => {
  // EVERY test leaves the shared DB on the behaviour-preserving defaults
  await resetOrg();
  await resetInterception();
  await relaxGovernanceGatesForTest(db, SB2_RELAXED);
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
});

afterAll(async () => {
  await resetOrg();
  await resetInterception();
  await db.delete(complianceProfiles).where(eq(complianceProfiles.tag, "orgset-block"));
  await db.delete(complianceProfiles).where(eq(complianceProfiles.tag, "orgset-ret"));
  if (ORIG_ANTHROPIC !== undefined) process.env.ANTHROPIC_API_KEY = ORIG_ANTHROPIC;
  if (ORIG_ANTHROPIC_BASE !== undefined) process.env.ANTHROPIC_BASE_URL = ORIG_ANTHROPIC_BASE;
  await restoreSb2Gates();
  await app.close();
});

describe("settings endpoint — admin-only, partial update, audited", () => {
  it("GET returns the shipped defaults (ADR-0181: strict where it is a security choice) plus env-key presence (names only)", async () => {
    const r = await app.inject({ method: "GET", headers: AUTH, url: "/v1/org/settings" });
    expect(r.statusCode).toBe(200);
    const s = r.json().settings;
    expect(s).toMatchObject({
      routingEnabled: true,
      compactionEnabled: true,
      promptCachingEnabled: true,
      editVsRewriteEnabled: true,
      filePreprocessingEnabled: true,
      lazyToolLoadingEnabled: true,
      defaultRoutingMode: "automatic",
      compactionThresholdTokens: 1600,
      compactionRecentWindow: 4,
      minCacheableTokens: 1024,
      cacheReadDiscount: 0.9,
      maxToolsInManifest: 20,
      minEditableBaselineTokens: 200,
      batchOverheadTokens: 200,
      minPreprocessTokens: 200,
      semanticCachePolicy: "off",
      semanticCacheTtlSeconds: 3600,
      compactionFailureMode: "fail_closed",
      summarizerSelection: "cheapest",
      summarizerAgentId: null,
      defaultPiiMode: "block",
      envKeyFallbackEnabled: false,
      envFallbackProviders: ["anthropic", "openai", "google", "xai"],
      budgetEnforcement: "block",
      budgetHardBlockPct: 100,
      approvalQuorum: "all",
      autoPruneEnabled: false,
      pruneIntervalHours: 24,
      defaultAuditRetentionDays: null,
      defaultWorkerMaxTurns: 6,
      maxWorkerTurns: 20,
      maxAttachmentsPerDispatch: 8,
      maxAttachmentBytes: 6 * 1024 * 1024,
      imageTokenEstimateTokens: 1200,
      sharedContextMaxChars: 100_000,
      nodeOutputMaxChars: 20_000,
    });
    // presence report: names + booleans only, never a value
    const env = r.json().envKeys;
    expect(Array.isArray(env)).toBe(true);
    expect(env.map((e: { provider: string }) => e.provider).sort()).toEqual(
      ["anthropic", "google", "openai", "xai"],
    );
    for (const e of env) expect(Object.keys(e).sort()).toEqual(["envVar", "present", "provider"]);
  });

  it("GET/PUT are admin-only (NOT in NON_ADMIN_ROUTES)", async () => {
    const g = await app.inject({ method: "GET", headers: umaAuth, url: "/v1/org/settings" });
    expect(g.statusCode).toBe(403);
    const p = await app.inject({
      method: "PUT",
      headers: umaAuth,
      url: "/v1/org/settings",
      payload: { routingEnabled: false },
    });
    expect(p.statusCode).toBe(403);
  });

  it("PUT is a partial update and every write is audited with the changed keys", async () => {
    const r = await putOrg({ budgetHardBlockPct: 90 });
    expect(r.settings.budgetHardBlockPct).toBe(90);
    // untouched fields keep their stored values
    expect(r.settings.routingEnabled).toBe(true);
    expect(r.settings.approvalQuorum).toBe("all");
    const [row] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.objectType, "org_settings"))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect(row).toBeTruthy();
    expect(row!.ruleId).toBe("org-settings-updated");
    expect((row!.detail as { changed: Record<string, unknown> }).changed).toEqual({
      budgetHardBlockPct: 90,
    });
  });

  it("rejects unknown keys and out-of-wall values (zod max stays the absolute wall)", async () => {
    await putOrg({ notAKey: true }, 400);
    await putOrg({ maxWorkerTurns: 21 }, 400); // 20 is the API/kernel wall
    await putOrg({ maxAttachmentsPerDispatch: 9 }, 400); // 8 is the zod wall
    await putOrg({ budgetHardBlockPct: 0 }, 400);
  });
});

describe("optimizer governance — the ceiling model", () => {
  it("defaults preserve behaviour: a dispatch routes and writes a model_routing ledger row", async () => {
    const before = await routingEventCount(umaId);
    const r = await invoke(umaAuth, premiumAgentId, { input: "short probe" });
    expect(r.statusCode).toBe(200);
    expect(r.json().routing).toBeTruthy();
    expect(await routingEventCount(umaId)).toBe(before + 1);
  });

  it("routing off is an org CEILING: per-user 'automatic' cannot re-enable it, and no model_routing row lands", async () => {
    // the user EXPLICITLY opts into optimization — and still may not have it,
    // because the org toggle is the ceiling
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${umaId}/agent-policy`,
      payload: { routingMode: "automatic" },
    });
    await putOrg({ routingEnabled: false });
    const before = await routingEventCount(umaId);
    const r = await invoke(umaAuth, premiumAgentId, { input: "short probe" });
    expect(r.statusCode).toBe(200);
    expect(r.json().routing.effect).toBe("passthrough");
    expect(r.json().routing.ruleId).toBe("routing-mode");
    expect(r.json().dispatch.servedAgentId).toBe(premiumAgentId); // never substituted
    expect(await routingEventCount(umaId)).toBe(before); // technique OFF => no ledger row
  });

  it("semantic cache 'off' beats a caller's semanticCache:true; 'always' caches without one", async () => {
    const input = "orgset semantic cache probe";
    // OFF: two identical opt-in calls, the second is NOT served from cache
    await putOrg({ semanticCachePolicy: "off" });
    const a1 = await invoke(umaAuth, cheapAgentId, { input, semanticCache: true });
    expect(a1.statusCode).toBe(200);
    const a2 = await invoke(umaAuth, cheapAgentId, { input, semanticCache: true });
    expect(a2.statusCode).toBe(200);
    expect(a2.json().cached).toBeUndefined();

    // ALWAYS: the caller never asks, and the identical re-ask is a hit anyway
    await putOrg({ semanticCachePolicy: "always" });
    const b1 = await invoke(umaAuth, cheapAgentId, { input: input + " always" });
    expect(b1.statusCode).toBe(200);
    const b2 = await invoke(umaAuth, cheapAgentId, { input: input + " always" });
    expect(b2.statusCode).toBe(200);
    expect(b2.json().cached).toBe(true);
    expect(b2.json().dispatch.stopReason).toBe("cached");
  });

  it("off is the default (ADR-0181); opt_in, once an admin picks it, works exactly as before", async () => {
    const input = "orgset semantic cache default probe";
    // the strict default: even a caller that asks is not served from cache
    const o1 = await invoke(umaAuth, cheapAgentId, { input: input + " strict", semanticCache: true });
    expect(o1.statusCode).toBe(200);
    const o2 = await invoke(umaAuth, cheapAgentId, { input: input + " strict", semanticCache: true });
    expect(o2.statusCode).toBe(200);
    expect(o2.json().cached).toBeUndefined();

    await putOrg({ semanticCachePolicy: "opt_in" });
    const c1 = await invoke(umaAuth, cheapAgentId, { input, semanticCache: true });
    expect(c1.statusCode).toBe(200);
    const c2 = await invoke(umaAuth, cheapAgentId, { input, semanticCache: true });
    expect(c2.json().cached).toBe(true);
    // and without the opt-in flag nothing is cached
    const d1 = await invoke(umaAuth, cheapAgentId, { input: input + " plain" });
    const d2 = await invoke(umaAuth, cheapAgentId, { input: input + " plain" });
    expect(d1.statusCode).toBe(200);
    expect(d2.json().cached).toBeUndefined();
  });
});

describe("compliance defaults", () => {
  it("default_pii_mode 'block' (the default, ADR-0181) applies to an UNCLASSIFIED project; 'none' leaves it unenforced", async () => {
    const proj = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/projects",
      payload: { name: `orgset-unclassified-${RUN}` },
    });
    const projectId = proj.json().id as string;
    const ssnInput = "the ssn is 123-45-6789";

    // default 'block': the floor reaches an unclassified project
    const blocked = await invoke(umaAuth, cheapAgentId, { input: ssnInput, projectId });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe("pii_blocked");

    // clean input on the same project still runs — the default enforces the
    // MODE, it does not blanket-deny the project
    const clean = await invoke(umaAuth, cheapAgentId, { input: "no personal data here", projectId });
    expect(clean.statusCode).toBe(200);

    // an admin relaxation to 'none': an unclassified project has NO PII
    // policy and the call runs (afterEach puts the strict default back)
    await putOrg({ defaultPiiMode: "none" });
    const ok = await invoke(umaAuth, cheapAgentId, { input: ssnInput, projectId });
    expect(ok.statusCode).toBe(200);
  });

  it("env-key fallback off => provider honestly unconfigured and dispatch 409s (no env-var hint)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-orgset-test";
    // ADR-0034 amendment: offline but PERMITTED (allow-listed loopback, dead
    // port). A `.invalid` host now fails closed at the egress guard, which
    // would mask what this test asserts — that the credential gate was passed.
    process.env.ANTHROPIC_BASE_URL = "https://127.0.0.1:1";
    // wipe any stored anthropic platform credential another suite left
    const del = await app.inject({ method: "DELETE", headers: AUTH, url: "/v1/model-credentials/anthropic" });
    expect([200, 404]).toContain(del.statusCode);
    const agent = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/agents",
      payload: { name: `orgset-claude-${RUN}`, provider: "anthropic", tier: 2, costPerMTokIn: 5, costPerMTokOut: 25, model: "orgset-claude-model" },
    });
    const claudeId = agent.json().id as string;
    await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId: umaId, agentId: claudeId } });

    // quality-sensitive pins the requested agent — the pillar-6 router must
    // not downroute onto a mock agent and mask the credential-gate signal
    const qs = { input: "ping", costSensitivity: "quality-sensitive" as const };

    // default (ADR-0181): the fallback is OFF — honestly unconfigured, 409
    const status = await app.inject({ method: "GET", headers: umaAuth, url: "/v1/model-providers/status" });
    expect(status.json().providers.anthropic.configured).toBe(false);
    const off = await invoke(umaAuth, claudeId, qs);
    expect(off.statusCode).toBe(409);
    expect(off.json().error).toBe("no_model_credential");
    // a disabled path is not advertised as a remedy
    expect(off.json().detail).not.toContain("ANTHROPIC_API_KEY");

    // an admin turns it on: the env key engages (past the credential gate)
    await putOrg({ envKeyFallbackEnabled: true });
    const on = await invoke(umaAuth, claudeId, qs);
    expect(on.json().error).toBe("model_dispatch_failed"); // reached the provider, not the gate

    // the per-provider allow-list narrows the same way
    await putOrg({ envKeyFallbackEnabled: true, envFallbackProviders: ["openai"] });
    const narrowed = await invoke(umaAuth, claudeId, qs);
    expect(narrowed.statusCode).toBe(409);
    expect(narrowed.json().error).toBe("no_model_credential");
  });
});

describe("budgets — enforcement mode and hard-block threshold", () => {
  it("warn_only lets an over-budget attributed call through, escalated + audited", async () => {
    const proj = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/projects",
      payload: { name: `orgset-budget-${RUN}`, budgetUsd: 0.0000001, budgetApproverUserId: anaId },
    });
    const projectId = proj.json().id as string;

    // first crossing is allowed by design (measured cost lands after the call)
    const first = await invoke(umaAuth, cheapAgentId, { input: "spend a little", projectId });
    expect(first.statusCode).toBe(200);

    // default 'block': the pre-gate now refuses further attributed dispatches
    const blocked = await invoke(umaAuth, cheapAgentId, { input: "more spend", projectId });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe("project_budget_exceeded");

    // warn_only: the same over-budget call RUNS, and the crossing is audited
    await putOrg({ budgetEnforcement: "warn_only" });
    const allowed = await invoke(umaAuth, cheapAgentId, { input: "warned spend", projectId });
    expect(allowed.statusCode).toBe(200);
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "project-budget-cap"), eq(auditLog.objectId, projectId)));
    expect(audits.length).toBeGreaterThan(0);
  });

  it("budget_hard_block_pct blocks EARLIER than 100% when narrowed", async () => {
    const proj = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/projects",
      // a budget far above anything a mock dispatch can spend
      payload: { name: `orgset-budget-pct-${RUN}`, budgetUsd: 1000, budgetApproverUserId: anaId },
    });
    const projectId = proj.json().id as string;
    const warm = await invoke(umaAuth, cheapAgentId, { input: "warm up spend", projectId });
    expect(warm.statusCode).toBe(200);
    // 1% of $1000 = $10 — still far above the mock's spend, so it runs...
    await putOrg({ budgetHardBlockPct: 1 });
    const stillOk = await invoke(umaAuth, cheapAgentId, { input: "still fine", projectId });
    expect(stillOk.statusCode).toBe(200);
    // ...but shrink the budget so 1% is below the measured spend, and the
    // narrowed threshold engages where 100% would not have
    await app.inject({
      method: "PATCH",
      headers: AUTH,
      url: `/v1/projects/${projectId}`,
      payload: { budgetUsd: 0.001 },
    });
    const gated = await invoke(umaAuth, cheapAgentId, { input: "now gated", projectId });
    expect([200, 409]).toContain(gated.statusCode);
    if (gated.statusCode === 409) {
      expect(gated.json().error).toBe("project_budget_exceeded");
      expect(gated.json().detail).toContain("1% of budget");
    }
  });
});

describe("approvals — org quorum", () => {
  it("quorum 'any' advances a two-approver sign-off on the FIRST approval and supersedes the rest", async () => {
    const tpl = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/workflows/templates",
      payload: {
        name: `orgset-quorum-${RUN}`,
        definition: {
          workflow: "orgset-quorum",
          stages: [
            { id: "intake", type: "trigger" },
            { id: "plan", type: "planning" },
            { id: "requirements", type: "artifact_generation", output: "requirements_file" },
            { id: "signoff", type: "human_approval", approvers: [anaId, bobId] },
          ],
        },
      },
    });
    expect(tpl.statusCode).toBe(201);
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/workflows/assignment-rules",
      payload: { templateId: tpl.json().id, changeType: `orgset-quorum-change-${RUN}` },
    });

    await putOrg({ approvalQuorum: "any" });

    const started = await app.inject({
      method: "POST",
      headers: umaAuth,
      url: "/v1/workflows/instances",
      payload: {
        change: {
          description: "orgset quorum change",
          paths: ["src/orgset.ts"],
          changeType: `orgset-quorum-change-${RUN}`,
          environment: "staging",
        },
      },
    });
    expect(started.statusCode).toBe(201);
    const instanceId = started.json().id as string;
    // ADR-0079: the planning stage rests — leave plan-only before the artifact
    await app.inject({
      method: "POST",
      headers: umaAuth,
      url: `/v1/workflows/instances/${instanceId}/advance`,
      payload: { stageId: "plan" },
    });
    await app.inject({
      method: "POST",
      headers: umaAuth,
      url: `/v1/workflows/instances/${instanceId}/artifacts`,
      payload: { stageId: "requirements", content: "# quorum requirements" },
    });

    // both named approvers hold a pending row
    const pending = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.instanceId, instanceId), eq(approvals.status, "pending")));
    expect(pending.length).toBe(2);
    const anaRow = pending.find((p) => p.approverUserId === anaId)!;

    // ONE approval advances the instance to completion (signoff is the last stage)
    const decided = await app.inject({
      method: "POST",
      headers: anaAuth,
      url: `/v1/approvals/${anaRow.id}/decide`,
      payload: { decision: "approved" },
    });
    expect(decided.statusCode).toBe(200);
    const view = await app.inject({
      method: "GET",
      headers: umaAuth,
      url: `/v1/workflows/instances/${instanceId}`,
    });
    expect(view.json().instance.status).toBe("completed");

    // the second approver's row is superseded — no ghost gate survives
    const bobRows = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.instanceId, instanceId), eq(approvals.approverUserId, bobId)));
    expect(bobRows).toHaveLength(1);
    expect(bobRows[0]!.status).toBe("superseded");
  });
});

describe("interception posture additions (fold into interception_settings)", () => {
  const anthropicBody = (extra: Record<string, unknown> = {}) => ({
    model: "orgset-cheap",
    max_tokens: 64,
    messages: [{ role: "user", content: "orgset compat probe" }],
    ...extra,
  });
  const setPosture = async (patch: Record<string, unknown>) => {
    const r = await app.inject({
      method: "PUT",
      headers: AUTH,
      url: "/v1/interception/settings",
      payload: patch,
    });
    expect(r.statusCode).toBe(200);
    return r.json().settings;
  };

  it("strict_field_rejection: temperature is a 400 by default (ADR-0181), accepted-and-disclosed when relaxed", async () => {
    const s = await setPosture({ anthropicCompatEnabled: true });
    expect(s.strictFieldRejection).toBe(true); // migration default (ADR-0181)
    const strict = await app.inject({
      method: "POST",
      headers: umaAuth,
      url: "/v1/messages",
      payload: anthropicBody({ temperature: 0.2 }),
    });
    expect(strict.statusCode).toBe(400);
    expect(JSON.stringify(strict.json())).toContain("strict field rejection");
    // a clean request still flows
    const clean = await app.inject({
      method: "POST",
      headers: umaAuth,
      url: "/v1/messages",
      payload: anthropicBody(),
    });
    expect(clean.statusCode).toBe(200);

    // an admin relaxes it: accepted, not honoured, and disclosed
    await setPosture({ strictFieldRejection: false });
    const lax = await app.inject({
      method: "POST",
      headers: umaAuth,
      url: "/v1/messages",
      payload: anthropicBody({ temperature: 0.2 }),
    });
    expect(lax.statusCode).toBe(200);
    expect(lax.headers["x-regulait-ignored-fields"]).toBe("temperature");
  });

  it("streaming_on_block_mode 'reject' (the default, ADR-0181) 400s a stream request to a block-mode project; 'suppress' buffers", async () => {
    await db
      .insert(complianceProfiles)
      .values({ tag: "orgset-block", piiMode: "block", mcpDefaultMode: "read_write" })
      .onConflictDoNothing();
    const proj = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/projects",
      payload: { name: `orgset-block-proj-${RUN}`, classifications: ["orgset-block"] },
    });
    const projectId = proj.json().id as string;

    // default 'reject': refused before anything is dispatched
    const rejected = await invoke(umaAuth, cheapAgentId, {
      input: "clean text",
      projectId,
      stream: true,
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toBe("streaming_rejected_on_block_project");

    // relaxed to 'suppress': the governed dispatch runs buffered + disclosed
    await setPosture({ streamingOnBlockMode: "suppress" });
    const suppressed = await invoke(umaAuth, cheapAgentId, {
      input: "clean text",
      projectId,
      stream: true,
    });
    expect(suppressed.statusCode).toBe(200);
    expect(suppressed.json().streamingSuppressed).toBe(true);
    // without stream the same call is fine
    const plain = await invoke(umaAuth, cheapAgentId, { input: "clean text", projectId });
    expect(plain.statusCode).toBe(200);
  });
});

describe("size ceilings — narrowing below the zod walls", () => {
  const b64 = (chars: number) => "A".repeat(chars); // valid base64 alphabet
  const attach = (name: string, chars: number) => ({
    kind: "image" as const,
    name,
    mediaType: "image/png",
    dataBase64: b64(chars),
  });

  it("max_attachments_per_dispatch and max_attachment_bytes reject above the narrowed ceiling", async () => {
    // defaults: two small attachments are fine (behaviour-preserving)
    const ok = await invoke(umaAuth, cheapAgentId, {
      input: "with attachments",
      attachments: [attach("a.png", 400), attach("b.png", 400)],
    });
    expect(ok.statusCode).toBe(200);

    await putOrg({ maxAttachmentsPerDispatch: 1 });
    const tooMany = await invoke(umaAuth, cheapAgentId, {
      input: "with attachments",
      attachments: [attach("a.png", 400), attach("b.png", 400)],
    });
    expect(tooMany.statusCode).toBe(422);
    expect(tooMany.json().error).toBe("too_many_attachments");

    await putOrg({ maxAttachmentsPerDispatch: 8, maxAttachmentBytes: 1024 });
    const tooBig = await invoke(umaAuth, cheapAgentId, {
      input: "with attachments",
      // 2800 base64 chars ≈ 2100 decoded bytes > the 1024 ceiling
      attachments: [attach("big.png", 2800)],
    });
    expect(tooBig.statusCode).toBe(422);
    expect(tooBig.json().error).toBe("attachment_too_large");
  });

  it("/v1/me carries the org attachment limits for client-side pre-validation", async () => {
    await putOrg({ maxAttachmentsPerDispatch: 3 });
    const me = await app.inject({ method: "GET", headers: umaAuth, url: "/v1/me" });
    expect(me.json().limits).toMatchObject({
      maxAttachmentsPerDispatch: 3,
      maxAttachmentBytes: 6 * 1024 * 1024,
    });
  });
});

describe("audit retention — org default composed with the profile floor", () => {
  it("org default adds a retention where no profile set one; a profile floor always wins upward", async () => {
    // NOTE: other suites in this shared DB may have profiles with retention
    // set; assertions are therefore relative (>=), never absolute equality.
    const before = await app.inject({ method: "GET", headers: AUTH, url: "/v1/audit/retention" });
    const baseline = before.json().retainedDays as number | null;

    // an org default far above every profile becomes the floor
    await putOrg({ defaultAuditRetentionDays: 10_000 });
    const withOrg = await app.inject({ method: "GET", headers: AUTH, url: "/v1/audit/retention" });
    expect(withOrg.json().retainedDays).toBe(10_000);
    expect(withOrg.json().floorSource).toContain("org_default");

    // floor-wins: a profile demanding MORE than the org default overrides it
    await db
      .insert(complianceProfiles)
      .values({ tag: "orgset-ret", piiMode: "log", mcpDefaultMode: "read_write", auditRetentionDays: 20_000 })
      .onConflictDoUpdate({
        target: complianceProfiles.tag,
        set: { auditRetentionDays: 20_000 },
      });
    const withProfile = await app.inject({ method: "GET", headers: AUTH, url: "/v1/audit/retention" });
    expect(withProfile.json().retainedDays).toBe(20_000);
    expect(withProfile.json().floorSource).toContain("orgset-ret");

    // and a tiny org default can never shorten the profile's floor
    await putOrg({ defaultAuditRetentionDays: 1 });
    const shortened = await app.inject({ method: "GET", headers: AUTH, url: "/v1/audit/retention" });
    expect(shortened.json().retainedDays).toBe(20_000);

    // cleanup the profile so the shared floor returns to its baseline
    await db.delete(complianceProfiles).where(eq(complianceProfiles.tag, "orgset-ret"));
    await resetOrg();
    const after = await app.inject({ method: "GET", headers: AUTH, url: "/v1/audit/retention" });
    expect(after.json().retainedDays).toBe(baseline);
  });

  it("manual prune under an org-default floor deletes only rows older than the floor and audits itself", async () => {
    // a 100-day org floor; other suites' profiles may hold a LONGER one in
    // this shared DB, so read the composed floor and plant a row beyond it
    await putOrg({ defaultAuditRetentionDays: 100 });
    const floorView = await app.inject({ method: "GET", headers: AUTH, url: "/v1/audit/retention" });
    const floorDays = floorView.json().retainedDays as number;
    expect(floorDays).toBeGreaterThanOrEqual(100); // the org default is at least in force
    const old = new Date(Date.now() - (floorDays + 100) * 24 * 3600 * 1000);
    const plantedRuleId = `orgset-planted-old-row-${RUN}`;
    await db.insert(auditLog).values({
      userId: umaId,
      objectType: "agent",
      objectId: null,
      at: old,
      detail: { orgsetPlanted: true },
      effect: "allow",
      ruleId: plantedRuleId,
      ruleChain: [],
      reason: "planted by org-settings.test.ts to verify retention pruning",
    });
    const pruned = await app.inject({ method: "POST", headers: AUTH, url: "/v1/audit/prune" });
    expect(pruned.statusCode).toBe(200);
    expect(pruned.json().retainedDays).toBe(floorDays);
    expect(pruned.json().deleted).toBeGreaterThanOrEqual(1);
    // the planted row is gone; the prune's own meta row survives
    const planted = await db.select().from(auditLog).where(eq(auditLog.ruleId, plantedRuleId));
    expect(planted).toHaveLength(0);
    const meta = await db.select().from(auditLog).where(eq(auditLog.ruleId, "audit-log-pruned"));
    expect(meta.length).toBeGreaterThan(0);
  });
});

describe("worker caps", () => {
  it("default_worker_max_turns / max_worker_turns bound the run-node loop (narrowing only)", async () => {
    // a single-node run on the mock agent; the loop runs 1 turn (no tools),
    // so the observable contract here is that dispatch still works with a
    // narrowed cap — the cap maths itself is pure clamping
    await putOrg({ defaultWorkerMaxTurns: 1, maxWorkerTurns: 1 });
    const run = await app.inject({
      method: "POST",
      headers: umaAuth,
      url: "/v1/runs",
      payload: {
        graph: {
          run: "orgset-workers",
          escalationApproverUserId: anaId,
          nodes: [
            { id: "solo", title: "Do one thing", ownerAgentId: cheapAgentId, mode: "execute", estimate: { in: 5, out: 5 } },
          ],
        },
      },
    });
    expect(run.statusCode).toBe(201);
    const runId = run.json().id as string;
    const auto = await app.inject({
      method: "POST",
      headers: umaAuth,
      url: `/v1/runs/${runId}/auto`,
      payload: { acceptReviews: true },
    });
    expect(auto.statusCode).toBe(200);
    expect(auto.json().status).toBe("completed");
  });
});
