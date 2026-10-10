/**
 * ADR-0040 — ABAC / policy-as-code, end to end through the real gateway.
 *
 * The bar here is PROOF BY ATTACK. Each block tries to make the ABAC layer do
 * something the ADR says it must never do, and asserts it cannot:
 *
 *   * grant — a call the RBAC layer default-denies stays denied even with a
 *     policy that would match it, and ABAC is never even consulted;
 *   * change anything when no policy is active — decisions stay byte-identical
 *     to the pre-ADR-0040 kernel, ruleChain included;
 *   * invent a second approvals mechanism — an ABAC pause writes a row in the
 *     SAME `approvals` table, of the same shape, that the same endpoint decides;
 *   * read the server's clock — a time-of-day policy is evaluated in the zone
 *     the POLICY declares, proved by running the suite under a deliberately
 *     wrong process TZ;
 *   * be spoofed — a client header claiming `environment=sandbox` or a
 *     different deploy mode does not reach the evaluated context;
 *   * accept a policy referencing an attribute that does not exist;
 *   * lose history — activating v2 and rolling back to v1 restores v1's
 *     decisions and leaves v2 intact.
 *
 * Shares one DB with the rest of the gateway suite (fileParallelism off), so
 * every fixture is prefixed `abac-` and the file cleans up the global state it
 * creates.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  abacPolicies,
  and,
  approvals,
  auditLog,
  createDb,
  desc,
  eq,
  runMigrations,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { governedEvaluate } from "./governed-evaluate.js";
import { abacPrincipalFromRequest } from "./abac-principal.js";
import { assembleAbacRequest, loadActiveAbacPolicies } from "./abac.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
// ADR-0181: the governance gates this suite would trip but does not test, relaxed by name
let restoreSb2Gates: () => Promise<void> = async () => {};
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { relaxApprovalSigningForTest } from "./testing/approval-signing-posture.js";
// ADR-0186 A2+B: this suite pins pre-0186 single-approver tool-call approvals (decided
// through API keys, unsigned); signing and the sensitive quorum are relaxed for its run
// and restored after (M-068). Dual control and signing are proved in zz-b4ab-*.
let restoreApprovalSigning: (() => Promise<void>) | undefined;

// ADR-0181: this file pins behaviour against a LOCAL MCP double (127.0.0.1, registered
// seconds ago), not the strict admission defaults — relaxed explicitly, restored after.
let restoreStrictAdmission: (() => Promise<void>) | undefined;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "abac-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let userId: string;
let approverId: string;
let serverId: string;
let hipaaProjectId: string;
let plainProjectId: string;

/**
 * THE PROCESS TIMEZONE IS DELIBERATELY WRONG.
 *
 * Every time-of-day assertion below would still pass if the implementation
 * quietly read the server's clock — unless the server's clock disagrees with
 * the policy's declared zone. So it is forced to disagree: the suite runs in
 * Asia/Tokyo (UTC+09:00) while the policies declare UTC and America/New_York.
 * If any of these tests starts passing because `new Date().getHours()` crept
 * into the evaluator, the Tokyo offset will make it fail.
 */
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = "Asia/Tokyo";

const NIGHT_HIPAA_WRITES = `
forbid (
  principal,
  action == RegulAIt::Action::"McpToolCall",
  resource
) when {
  resource.kind == "write" &&
  resource.classifications.contains("abac-hipaa") &&
  (context.hour >= 22 || context.hour < 6)
};`;

const mkUser = async (email: string) => {
  const u = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/users",
    payload: { email, displayName: email.split("@")[0] },
  });
  expect(u.statusCode, u.body).toBe(201);
  return u.json().id as string;
};

const createPolicy = (payload: Record<string, unknown>) =>
  app.inject({ method: "POST", headers: AUTH, url: "/v1/abac/policies", payload });

const activate = (policyId: string, version: number) =>
  app.inject({
    method: "POST", headers: AUTH, url: `/v1/abac/policies/${policyId}/activate`,
    payload: { version },
  });

const deletePolicy = (policyId: string) =>
  app.inject({ method: "DELETE", headers: AUTH, url: `/v1/abac/policies/${policyId}` });

/** the enforcement path, called exactly as the MCP proxy calls it */
const evaluateTool = (toolName: string, kind: "read" | "write", projectId: string | null) =>
  governedEvaluate(
    db,
    userId,
    serverId,
    { serverId, name: toolName, kind },
    undefined,
    null,
    projectId, undefined, undefined, undefined, undefined, { actor: null },
  );

/**
 * Run `fn` with the WALL CLOCK moved to `iso`.
 *
 * Deliberately done by faking `Date` rather than by threading a test-only
 * instant through `governedEvaluate`: the enforcement path must read the real
 * clock, so the test moves the real clock instead of opening a parameter a
 * caller could one day supply. Only `Date` is faked — timers stay real, so the
 * pg driver is untouched.
 */
async function atTime<T>(iso: string, fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(iso) });
  try {
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreApprovalSigning = await relaxApprovalSigningForTest(db);
  restoreStrictAdmission = await relaxStrictAdmissionForTest(db);
  app = buildApp(db, { bootstrapToken: BOOT });
  restoreSb2Gates = await relaxGovernanceGatesForTest(db, { requirePreviewBeforeActivate: false });

  userId = await mkUser("abac-pat@example.com");
  approverId = await mkUser("abac-ada@example.com");

  const s = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/servers",
    payload: { name: "abac-server", url: "http://127.0.0.1:9" },
  });
  expect(s.statusCode, s.body).toBe(201);
  serverId = s.json().id;
  for (const tool of [
    { name: "abac_read", kind: "read" },
    { name: "abac_write", kind: "write" },
  ]) {
    const t = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/servers/${serverId}/tools`, payload: tool,
    });
    expect(t.statusCode, t.body).toBe(201);
  }
  // RBAC base: the user is granted the WRITE tool and NOT the read tool. That
  // asymmetry is what lets "ABAC cannot grant" be tested against a real
  // default-deny rather than a contrived one.
  const g = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/grants/tools",
    payload: { userId, serverId, toolName: "abac_write" },
  });
  expect(g.statusCode, g.body).toBe(201);

  // a HIPAA-classified project and an unclassified one — the §8.3 cascade tags
  // are what the resource bag exposes as `classifications`/`dataSensitivity`
  await app.inject({
    method: "POST", headers: AUTH, url: "/v1/compliance/profiles",
    payload: { tag: "abac-hipaa", mcpDefaultMode: "read_write" },
  });
  const hp = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/projects",
    payload: { name: "abac-hipaa-project", classifications: ["abac-hipaa"] },
  });
  expect(hp.statusCode, hp.body).toBe(201);
  hipaaProjectId = hp.json().id;
  const pp = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/projects", payload: { name: "abac-plain-project" },
  });
  expect(pp.statusCode, pp.body).toBe(201);
  plainProjectId = pp.json().id;
}, 120_000);

afterAll(async () => {
  await restoreApprovalSigning?.();
  await restoreStrictAdmission?.();
  // Active ABAC policies are GLOBAL state: leaving one enabled would silently
  // change what every later file's governed calls decide. Delete everything
  // this file created (cascades the version rows), then hand the process TZ
  // back.
  await db.delete(abacPolicies);
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
  await restoreSb2Gates();
  await app?.close();
});

// ===========================================================================
describe("ADR-0040 (1) — ABAC NEVER GRANTS", () => {
  it("a policy set that would 'permit' cannot rescue a call the RBAC layer default-denies", async () => {
    // `abac_read` is deliberately ungranted. Activate a policy so the ABAC
    // layer is genuinely live for this call — then prove it never runs.
    const created = await createPolicy({
      name: "abac-inert-forbid",
      source: `forbid (principal, action == RegulAIt::Action::"McpToolCall", resource)
               when { resource.toolName == "nothing-at-all" };`,
    });
    expect(created.statusCode, created.body).toBe(201);
    const policyId = created.json().policy.id;
    expect((await activate(policyId, 1)).statusCode).toBe(200);
    expect(await loadActiveAbacPolicies(db)).toHaveLength(1);

    const { decision } = await evaluateTool("abac_read", "read", hipaaProjectId);
    expect(decision.effect).toBe("deny");
    expect(decision.ruleId).toBe("default-deny");
    // THE PROOF: ABAC left no trace, because an ungranted call is default-denied
    // before the ABAC step is reached at all.
    expect(decision.ruleChain.some((t) => t.rule === "abac-forbid")).toBe(false);
    expect(decision.ruleChain.map((t) => t.rule)).toEqual([
      "tool-allow-list",
      "role-tool-allow-list",
      "server-read-only-all",
      "role-server-read-only-all",
      "default-deny",
    ]);
    await deletePolicy(policyId);
  });

  it("the API refuses to store a Cedar `permit` at all — there is no way to author a grant", async () => {
    const r = await createPolicy({
      name: "abac-would-be-permit",
      source: `permit (principal, action == RegulAIt::Action::"McpToolCall", resource);`,
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe("invalid_policy");
    expect(JSON.stringify(r.json().errors)).toContain("can never grant");
    // nothing was stored
    const list = await app.inject({ method: "GET", headers: AUTH, url: "/v1/abac/policies" });
    expect(list.json().policies.some((p: { name: string }) => p.name === "abac-would-be-permit")).toBe(false);
  });
});

// ===========================================================================
describe("ADR-0040 (2) — EMPTY POLICY SET = TODAY, byte for byte", () => {
  it("a representative ALLOW and a representative DENY are unchanged, ruleChain included", async () => {
    expect(await loadActiveAbacPolicies(db)).toHaveLength(0);

    const allow = (await evaluateTool("abac_write", "write", hipaaProjectId)).decision;
    expect(allow.effect).toBe("allow");
    expect(allow.ruleChain).toEqual([
      { rule: "tool-allow-list", outcome: "allow", grantId: allow.ruleId },
      { rule: "data-scope", outcome: "no-match" },
      { rule: "rate-limit", outcome: "no-match" },
      { rule: "approval-required", outcome: "no-match" },
    ]);

    const deny = (await evaluateTool("abac_read", "read", hipaaProjectId)).decision;
    expect(deny.effect).toBe("deny");
    expect(deny.ruleId).toBe("default-deny");
    expect(deny.ruleChain).toEqual([
      { rule: "tool-allow-list", outcome: "no-match" },
      { rule: "role-tool-allow-list", outcome: "no-match" },
      { rule: "server-read-only-all", outcome: "no-match" },
      { rule: "role-server-read-only-all", outcome: "no-match" },
      { rule: "default-deny", outcome: "deny" },
    ]);
  });

  it("a DEACTIVATED policy is as absent as one that was never written", async () => {
    const created = await createPolicy({ name: "abac-deactivated", source: NIGHT_HIPAA_WRITES });
    const policyId = created.json().policy.id;
    const before = (await atTime("2026-08-02T23:00:00Z", () => evaluateTool("abac_write", "write", hipaaProjectId))).decision;
    // created but never activated
    expect(before.effect).toBe("allow");
    expect(before.ruleChain.some((t) => t.rule === "abac-forbid")).toBe(false);

    await activate(policyId, 1);
    const active = (await atTime("2026-08-02T23:00:00Z", () => evaluateTool("abac_write", "write", hipaaProjectId))).decision;
    expect(active.effect).toBe("deny");

    await app.inject({ method: "POST", headers: AUTH, url: `/v1/abac/policies/${policyId}/deactivate` });
    const after = (await atTime("2026-08-02T23:00:00Z", () => evaluateTool("abac_write", "write", hipaaProjectId))).decision;
    expect(after).toEqual(before);
    await deletePolicy(policyId);
  });
});

// ===========================================================================
describe("ADR-0040 (3) — a real conditional policy, end to end", () => {
  let policyId: string;

  beforeAll(async () => {
    const r = await createPolicy({
      name: "abac-no-night-hipaa-writes",
      description: "no write-capable tool against a HIPAA-classified project between 22:00 and 06:00",
      source: NIGHT_HIPAA_WRITES,
      timezone: "UTC",
      testCases: [
        {
          name: "midday hipaa write is fine",
          at: "2026-08-02T12:00:00.000Z",
          principal: {},
          resource: { toolName: "abac_write", kind: "write", classifications: ["abac-hipaa"] },
          expect: "no_match",
        },
        {
          name: "23:00 hipaa write fires",
          at: "2026-08-02T23:00:00.000Z",
          principal: {},
          resource: { toolName: "abac_write", kind: "write", classifications: ["abac-hipaa"] },
          expect: "match",
        },
      ],
    });
    expect(r.statusCode, r.body).toBe(201);
    policyId = r.json().policy.id;
    expect((await activate(policyId, 1)).statusCode).toBe(200);
  });

  afterAll(async () => {
    await deletePolicy(policyId);
  });

  it("ALLOWS at 12:00 and DENIES at 23:00 with every other input identical", async () => {
    const noon = (await atTime("2026-08-02T12:00:00Z", () => evaluateTool("abac_write", "write", hipaaProjectId))).decision;
    const night = (await atTime("2026-08-02T23:00:00Z", () => evaluateTool("abac_write", "write", hipaaProjectId))).decision;

    expect(noon.effect).toBe("allow");
    expect(night.effect).toBe("deny");
    // ruleId is the POLICY id, and the chain carries the new abac-forbid entry
    expect(night.ruleId).toBe(policyId);
    expect(night.ruleChain).toContainEqual({
      rule: "abac-forbid", outcome: "deny", grantId: policyId,
    });
    expect(night.reason).toContain("abac-no-night-hipaa-writes");
    expect(night.reason).toContain("v1");
  });

  it("the SAME instant is judged by the POLICY'S zone, not the server's (process TZ is Asia/Tokyo)", async () => {
    // sanity: the process really is running somewhere else
    expect(process.env.TZ).toBe("Asia/Tokyo");
    // 2026-08-02T23:00Z is 08:00 the NEXT DAY in Tokyo and 19:00 in New York
    const AT = "2026-08-02T23:00:00.000Z";

    // …under the UTC policy the call is refused
    expect(
      (await atTime(AT, () => evaluateTool("abac_write", "write", hipaaProjectId))).decision.effect,
    ).toBe("deny");

    // …and moving the DECLARED zone to New York (19:00 there) permits it,
    // while the server's Tokyo clock (08:00) never enters the question at all.
    const v2 = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/abac/policies/${policyId}/versions`,
      payload: { source: NIGHT_HIPAA_WRITES, timezone: "America/New_York" },
    });
    expect(v2.statusCode, v2.body).toBe(201);
    await activate(policyId, 2);
    expect(
      (await atTime(AT, () => evaluateTool("abac_write", "write", hipaaProjectId))).decision.effect,
    ).toBe("allow");

    // If the evaluator were reading the process clock, Tokyo's 08:00 would have
    // permitted BOTH — the difference between the two answers is the proof.
    await activate(policyId, 1);
  });

  it("does not touch an UNCLASSIFIED project — the attribute is really doing the work", async () => {
    const AT = "2026-08-02T23:00:00.000Z";
    expect(
      (await atTime(AT, () => evaluateTool("abac_write", "write", plainProjectId))).decision.effect,
    ).toBe("allow");
    expect(
      (await atTime(AT, () => evaluateTool("abac_write", "write", null))).decision.effect,
    ).toBe("allow");
  });

  it("runs the policy's stored unit tests through the endpoint", async () => {
    const r = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/abac/policies/${policyId}/test`, payload: {},
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ total: 2, passed: 2, failed: 0 });
    // and the CI entry point over the whole active set
    const all = await app.inject({ method: "POST", headers: AUTH, url: "/v1/abac/test", payload: {} });
    expect(all.json().failed).toBe(0);
    expect(all.json().passed).toBeGreaterThanOrEqual(2);
  });

  it("previews the decision + the exact attributes WITHOUT executing anything", async () => {
    const before = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .orderBy(desc(auditLog.at))
      .limit(1);
    const r = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/abac/simulate",
      payload: {
        userId, serverId, toolName: "abac_write",
        projectId: hipaaProjectId, at: "2026-08-02T23:00:00.000Z",
      },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().abacDecision.effect).toBe("forbid");
    expect(r.json().abacDecision.policyId).toBe(policyId);
    expect(r.json().attributes.resource.classifications).toEqual(["abac-hipaa"]);
    // simulation writes no audit row and no approval — it executes nothing
    const after = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect(after[0]?.id).toBe(before[0]?.id);
  });
});

// ===========================================================================
describe("ADR-0040 (4) — require_approval rides the EXISTING Approvals Queue", () => {
  let policyId: string;

  beforeAll(async () => {
    const r = await createPolicy({
      name: "abac-prod-writes-need-signoff",
      source: `forbid (principal, action == RegulAIt::Action::"McpToolCall", resource)
               when { resource.kind == "write" };`,
      mode: "require_approval",
      approverUserId: approverId,
    });
    expect(r.statusCode, r.body).toBe(201);
    policyId = r.json().policy.id;
    await activate(policyId, 1);
  });

  afterAll(async () => {
    await deletePolicy(policyId);
    await db.delete(approvals).where(eq(approvals.userId, userId));
  });

  it("refuses to store a require_approval policy with no approver — a pause needs somewhere to go", async () => {
    const r = await createPolicy({
      name: "abac-approver-less",
      source: `forbid (principal, action == RegulAIt::Action::"McpToolCall", resource);`,
      mode: "require_approval",
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe("approver_required");
  });

  it("turns the call into require_approval, naming the policy and its approver", async () => {
    const { decision } = await evaluateTool("abac_write", "write", plainProjectId);
    expect(decision.effect).toBe("require_approval");
    expect(decision.ruleId).toBe(policyId);
    expect(decision.approverUserId).toBe(approverId);
    expect(decision.ruleChain).toContainEqual({
      rule: "abac-forbid", outcome: "require-approval", grantId: policyId,
    });
  });

  it("the MCP path writes a row in the SAME approvals table, of the same shape, decided by the same endpoint", async () => {
    const { executeGovernedToolCall } = await import("./mcp-proxy.js");
    const outcome = await executeGovernedToolCall(db, undefined, {
      userId, serverId, toolName: "abac_write", projectId: plainProjectId,
    });
    expect(outcome.kind).toBe("approval_required");

    const [row] = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.userId, userId), eq(approvals.toolName, "abac_write")))
      .orderBy(desc(approvals.requestedAt))
      .limit(1);
    expect(row).toBeTruthy();
    // THE POINT: the existing shape — the ordinary mcp_tool object type, this
    // server/tool, the ABAC policy id in the SAME `rule_id` column an approval
    // RULE would have used, and the standard pending status.
    expect(row!.objectType).toBe("mcp_tool");
    expect(row!.serverId).toBe(serverId);
    expect(row!.ruleId).toBe(policyId);
    expect(row!.approverUserId).toBe(approverId);
    expect(row!.status).toBe("pending");

    // and it is decided through the pre-existing endpoint, not a new one
    const key = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/users/${approverId}/keys`, payload: { name: "abac-appr" },
    });
    const decided = await app.inject({
      method: "POST",
      headers: { authorization: `Bearer ${key.json().token}` },
      url: `/v1/approvals/${row!.id}/decide`,
      payload: { decision: "approved" },
    });
    expect(decided.statusCode, decided.body).toBe(200);

    // the approved entry now SATISFIES the ABAC pause — same mechanism, not a
    // parallel one
    const after = (await evaluateTool("abac_write", "write", plainProjectId)).decision;
    expect(after.effect).toBe("allow");
    expect(after.ruleChain).toContainEqual({
      rule: "abac-forbid", outcome: "satisfied-by-approval", grantId: row!.id,
    });
  });
});

// ===========================================================================
describe("ADR-0040 (5) — the context is SERVER-DERIVED and cannot be spoofed", () => {
  it("a client header claiming environment/deploy mode does not reach the evaluated context", async () => {
    // The project has no in-flight deploy work, so the derived sets are empty…
    const honest = await assembleAbacRequest(db, {
      userId, serverId, toolName: "abac_write", toolKind: "write", projectId: plainProjectId,
    });
    expect(honest.context.environments).toEqual([]);
    expect(honest.context.deployModes).toEqual([]);

    // …and a caller asserting otherwise gets exactly the same answer, because
    // the simulate route (the ONLY route that accepts any hypothetical at all)
    // has no environment/deployMode input to accept.
    const spoofed = await app.inject({
      method: "POST",
      headers: {
        ...AUTH,
        "x-regulait-environment": "sandbox",
        "x-regulait-deploy-mode": "hosted",
      },
      url: "/v1/abac/simulate",
      payload: {
        userId, serverId, toolName: "abac_write", projectId: plainProjectId,
        // and the body cannot smuggle them either — zod strips unknown keys
        environment: "sandbox",
        deployMode: "hosted",
        environments: ["sandbox"],
        deployModes: ["hosted"],
      },
    });
    expect(spoofed.statusCode, spoofed.body).toBe(200);
    expect(spoofed.json().attributes.context.environments).toEqual([]);
    expect(spoofed.json().attributes.context.deployModes).toEqual([]);
  });

  it("a forbid bound to `environments` therefore cannot be dodged by claiming a different one", async () => {
    const created = await createPolicy({
      name: "abac-no-sandbox-escape",
      source: `forbid (principal, action == RegulAIt::Action::"McpToolCall", resource)
               unless { context.environments.contains("sandbox") };`,
    });
    const policyId = created.json().policy.id;
    await activate(policyId, 1);
    // The derived environment set is empty, so `unless sandbox` fires — and no
    // header or body field the caller can set changes that.
    const { decision } = await evaluateTool("abac_write", "write", plainProjectId);
    expect(decision.effect).toBe("deny");
    expect(decision.ruleId).toBe(policyId);
    await deletePolicy(policyId);
  });

  it("session origin + MFA come from the resolved session, never from a header", () => {
    // CLOSED SET, widened by exactly one field for schema v2's `clientIp`. Listed
    // rather than loosened to `objectContaining`, for the same reason the rest of
    // this file pins shapes: a new principal attribute must be added by someone
    // who has read what this test is protecting.
    expect(abacPrincipalFromRequest({ authCtx: { via: "api-key" } })).toEqual({
      sessionOrigin: "api_key", mfaCompleted: false, clientIp: null,
    });
    expect(abacPrincipalFromRequest({ authCtx: { via: "bootstrap" } })).toEqual({
      sessionOrigin: "bootstrap", mfaCompleted: false, clientIp: null,
    });
    expect(
      abacPrincipalFromRequest({
        authCtx: { via: "session" },
        sessionAuth: { origin: "saml", totpEnabled: true },
      }),
    ).toEqual({ sessionOrigin: "saml", mfaCompleted: true, clientIp: null });
    // an unknown/absent session fails toward the WEAK claim, never the strong one
    expect(
      abacPrincipalFromRequest({ authCtx: { via: "session" }, sessionAuth: undefined }),
    ).toEqual({ sessionOrigin: "unknown", mfaCompleted: false, clientIp: null });
  });

  it("the client address comes from the RESOLVED peer, and absence is null not a guess", () => {
    // Schema v2. `ip` is what Fastify resolved under ADR-0031's trusted-proxy
    // policy — this module never reads a forwarding header itself, which is the
    // whole reason the field is sourced here rather than parsed anywhere else.
    expect(
      abacPrincipalFromRequest({ authCtx: { via: "api-key" }, ip: "203.0.113.7" }).clientIp,
    ).toBe("203.0.113.7");
    // and an unresolvable peer is NULL — never a sentinel address, which a
    // policy could not tell apart from a real one
    expect(abacPrincipalFromRequest({ authCtx: { via: "api-key" }, ip: null }).clientIp).toBeNull();
    expect(abacPrincipalFromRequest({ authCtx: { via: "api-key" } }).clientIp).toBeNull();
  });
});

// ===========================================================================
describe("ADR-0040 (6) — write-time validation", () => {
  it("refuses a policy referencing an undefined attribute, with a message naming it", async () => {
    const r = await createPolicy({
      name: "abac-undefined-attribute",
      source: `forbid (principal, action == RegulAIt::Action::"McpToolCall", resource)
               when { context.moonPhase == "waxing" };`,
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe("invalid_policy");
    expect(JSON.stringify(r.json().errors)).toContain("moonPhase");
  });

  it("refuses an unresolvable timezone rather than silently falling back to the server's", async () => {
    const r = await createPolicy({
      name: "abac-bad-tz", source: NIGHT_HIPAA_WRITES, timezone: "Mars/Olympus",
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe("invalid_timezone");
  });

  it("validates without storing, and publishes the schema the author must write against", async () => {
    const bad = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/abac/validate",
      payload: { source: `forbid (principal, action, resource) when { resource.nope };` },
    });
    expect(bad.json().ok).toBe(false);
    const good = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/abac/validate",
      payload: { source: NIGHT_HIPAA_WRITES },
    });
    expect(good.json().ok).toBe(true);

    const schema = await app.inject({ method: "GET", headers: AUTH, url: "/v1/abac/schema" });
    expect(schema.json().engine).toContain("cedar-wasm@");
    expect(schema.json().abacCanGrant).toBe(false);
    expect(schema.json().schemaText).toContain("classifications");
  });
});

// ===========================================================================
describe("ADR-0040 (7) — versioning: activation is a bump, rollback is a selection", () => {
  it("activating v2 then rolling back to v1 restores v1's decisions, and v2 still exists", async () => {
    // v1 forbids NIGHT hipaa writes; v2 forbids ALL writes.
    const created = await createPolicy({ name: "abac-versioned", source: NIGHT_HIPAA_WRITES });
    const policyId = created.json().policy.id;
    await activate(policyId, 1);
    const NOON = "2026-08-02T12:00:00.000Z";
    const atNoon = async () =>
      (await atTime(NOON, () => evaluateTool("abac_write", "write", hipaaProjectId))).decision.effect;
    expect(await atNoon()).toBe("allow");

    const v2 = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/abac/policies/${policyId}/versions`,
      payload: {
        source: `forbid (principal, action == RegulAIt::Action::"McpToolCall", resource)
                 when { resource.kind == "write" };`,
      },
    });
    expect(v2.statusCode, v2.body).toBe(201);
    expect(v2.json().version.version).toBe(2);
    // authoring v2 changes NOTHING until it is activated
    expect(await atNoon()).toBe("allow");

    const on = await activate(policyId, 2);
    expect(on.json()).toMatchObject({ activeVersion: 2, rollback: false });
    expect(await atNoon()).toBe("deny");

    // ROLLBACK = activating the older version. v1's decisions come back exactly.
    const back = await activate(policyId, 1);
    expect(back.json()).toMatchObject({ activeVersion: 1, rollback: true });
    expect(await atNoon()).toBe("allow");

    // …and HISTORY IS INTACT: v2's row still exists, unedited, re-activatable.
    const detail = await app.inject({
      method: "GET", headers: AUTH, url: `/v1/abac/policies/${policyId}`,
    });
    const versions = detail.json().versions as Array<{ version: number; source: string }>;
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2]);
    expect(versions.find((v) => v.version === 1)!.source).toContain("context.hour");
    expect(versions.find((v) => v.version === 2)!.source).not.toContain("context.hour");

    // every activation is audited, and the rollback names where it came from
    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.objectId, policyId))
      .orderBy(desc(auditLog.at));
    expect(rows.some((r) => r.ruleId === "abac-policy-activated")).toBe(true);
    const rollbackRow = rows.find((r) => r.ruleId === "abac-policy-rolled-back");
    expect(rollbackRow).toBeTruthy();
    expect((rollbackRow!.detail as Record<string, unknown>).from).toBe(2);
    expect((rollbackRow!.detail as Record<string, unknown>).to).toBe(1);

    await deletePolicy(policyId);
  });

  it("a second policy with the same name is refused, and an unknown version cannot be activated", async () => {
    const a = await createPolicy({ name: "abac-dupe", source: NIGHT_HIPAA_WRITES });
    expect(a.statusCode).toBe(201);
    const b = await createPolicy({ name: "abac-dupe", source: NIGHT_HIPAA_WRITES });
    expect(b.statusCode).toBe(409);
    const missing = await activate(a.json().policy.id, 99);
    expect(missing.statusCode).toBe(404);
    await deletePolicy(a.json().policy.id);
  });
});
