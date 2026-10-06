import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
// ADR-0181: this file registers a LOCAL MCP double (127.0.0.1 / localhost, registered seconds ago) to pin
// unrelated behaviour, not the strict admission defaults — relaxed explicitly here, restored in afterAll.
let restoreStrictAdmission: (() => Promise<void>) | undefined;
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  abacPolicies,
  and,
  auditLog,
  createDb,
  eq,
  gte,
  inArray,
  isNotNull,
  policySimulationFlips,
  policySimulationSettings,
  policySimulations,
  runMigrations,
  sql,
  usageEvents,
  type Db,
} from "@regulait/db";
import {
  analyzeReplayFidelity,
  classifyReplay,
  resolvePolicySimulationScope,
  summarizeBlastRadius,
  type ReplayedDecision,
} from "@regulait/shared";

/**
 * ADR-0059 — POLICY SIMULATION / BLAST-RADIUS PREVIEW, proved by attack.
 *
 * What this file is trying to make impossible to fake:
 *
 *  1. A "DRY RUN" THAT IS NOT DRY. The provider spy's invocation count must be
 *     EXACTLY ZERO across a simulation of a forbid-everything policy — the one
 *     policy most likely to make a naive implementation re-execute something to
 *     find out what would happen. The assertion is a number, not an absence of
 *     complaints.
 *  2. A PREVIEW THAT MUTATES. The active policy pointer, the approvals queue,
 *     the usage ledger and the governed objects are counted before and after
 *     and must be identical. The only new audit rows are the simulation's own.
 *  3. A BLAST RADIUS THAT IS A PERCENTAGE. The preview must NAME the users and
 *     the projects out of real history, and the specific calls must be readable
 *     back as rows.
 *  4. NUMBERS THAT DO NOT RECONCILE. The bucket counts are checked against an
 *     INDEPENDENT SQL count of the historical rows the simulation claims to
 *     have examined — computed in the test, not read back from the preview.
 *  5. A PREVIEW AS A DATA-EXFILTRATION PATH. A caller in one team simulating
 *     over history must not see another team's calls. Asserted as SCOPING (the
 *     other team's users are absent from the named blast radius, and an explicit
 *     request for them is REFUSED with an audit row) — never as UI absence.
 *  6. FRICTION THAT IS DECORATIVE. Activating an un-previewed version is
 *     recorded as un-previewed unconditionally, and REFUSED when the deployment
 *     turns the dial on.
 *
 * SHARED-STATE DISCIPLINE. Two singletons are touched: the ABAC policy set
 * (global — any left enabled would change every later file's decisions) and
 * `policy_simulation_settings`. `afterAll` restores both exactly. Every object
 * is `ps-` prefixed.
 */

declare global {
  // eslint-disable-next-line no-var
  var __psProviderCalls: number;
}
globalThis.__psProviderCalls = 0;

// THE PROVIDER SPY. Wraps the real resolver and counts every dispatch. A
// simulation that reached a model would move this number.
vi.mock("@regulait/model-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@regulait/model-provider")>();
  return {
    ...actual,
    resolveModelProvider: (
      ...args: Parameters<typeof actual.resolveModelProvider>
    ): ReturnType<typeof actual.resolveModelProvider> => {
      const inner = actual.resolveModelProvider(...args);
      const wrapped = Object.create(inner as object) as typeof inner;
      wrapped.dispatch = async (req: Parameters<typeof inner.dispatch>[0]) => {
        globalThis.__psProviderCalls += 1;
        return inner.dispatch(req);
      };
      return wrapped;
    },
  };
});

const { buildApp } = await import("./app.js");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "ps-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let serverId: string;
let alphaLeadId: string;
let alphaLeadAuth: { authorization: string };
let alphaMemberId: string;
let betaMemberId: string;
let alphaProjectId: string;
let betaProjectId: string;
/** the deny-everything candidate under preview */
let denyAllPolicyId: string;
let denyAllVersionId: string;

async function makeUser(email: string) {
  const u = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email, displayName: email.split("@")[0]!.replace(/-/g, " ") },
  });
  expect(u.statusCode, u.body).toBe(201);
  const k = await app.inject({
    method: "POST",
    url: `/v1/users/${u.json().id}/keys`,
    headers: AUTH,
    payload: { name: "ps" },
  });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function makeTeam(name: string, memberIds: string[]) {
  const t = await app.inject({ method: "POST", url: "/v1/teams", headers: AUTH, payload: { name } });
  expect(t.statusCode, t.body).toBe(201);
  const teamId = t.json().id as string;
  for (const userId of memberIds) {
    const m = await app.inject({
      method: "POST",
      url: `/v1/teams/${teamId}/members`,
      headers: AUTH,
      payload: { userId },
    });
    expect(m.statusCode, m.body).toBeLessThan(300);
  }
  return teamId;
}

/**
 * RECORDED HISTORY. Written straight into `audit_log`/`usage_events` — which is
 * exactly what they are: the append-only transcript of decisions the gateway
 * already made. The simulation replays these rows; it does not care how they
 * got there, and neither does an air-gapped install.
 */
async function recordCall(opts: {
  userId: string;
  toolName: string;
  effect: "allow" | "deny" | "require_approval";
  projectId?: string | null;
  minutesAgo?: number;
}) {
  const at = new Date(Date.now() - (opts.minutesAgo ?? 5) * 60_000);
  const [row] = await db
    .insert(auditLog)
    .values({
      at,
      userId: opts.userId,
      objectType: "mcp_tool",
      serverId,
      toolName: opts.toolName,
      effect: opts.effect,
      ruleId: opts.effect === "allow" ? "tool-allow-list" : "default-deny",
      ruleChain: [],
      reason: "ps recorded history",
    })
    .returning();
  if (opts.effect === "allow" && opts.projectId) {
    await db.insert(usageEvents).values({
      at,
      userId: opts.userId,
      objectType: "mcp_tool",
      operation: opts.toolName,
      costUsd: 0.01,
      projectId: opts.projectId,
      detail: { serverId, toolName: opts.toolName },
    });
  }
  return row!.id;
}

async function simulateAs(
  auth: { authorization: string },
  payload: Record<string, unknown>,
) {
  return app.inject({ method: "POST", url: "/v1/policy-simulations", headers: auth, payload });
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreStrictAdmission = await relaxStrictAdmissionForTest(db);
  app = buildApp(db, { bootstrapToken: BOOT });

  const lead = await makeUser("ps-alpha-lead@example.com");
  alphaLeadId = lead.id;
  alphaLeadAuth = lead.auth;
  const member = await makeUser("ps-alpha-member@example.com");
  alphaMemberId = member.id;
  const beta = await makeUser("ps-beta-member@example.com");
  betaMemberId = beta.id;

  await makeTeam("ps-team-alpha", [alphaLeadId, alphaMemberId]);
  await makeTeam("ps-team-beta", [betaMemberId]);

  const s = await app.inject({
    method: "POST",
    url: "/v1/servers",
    headers: AUTH,
    payload: { name: "ps-server", url: "http://127.0.0.1:9" },
  });
  expect(s.statusCode, s.body).toBe(201);
  serverId = s.json().id;
  for (const tool of [
    { name: "ps_read", kind: "read" },
    { name: "ps_write", kind: "write" },
  ]) {
    const t = await app.inject({
      method: "POST",
      url: `/v1/servers/${serverId}/tools`,
      headers: AUTH,
      payload: tool,
    });
    expect(t.statusCode, t.body).toBe(201);
  }

  const ap = await app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: AUTH,
    payload: { name: "ps-alpha-project", key: "PSALPHA" },
  });
  expect(ap.statusCode, ap.body).toBe(201);
  alphaProjectId = ap.json().id;
  const bp = await app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: AUTH,
    payload: { name: "ps-beta-project", key: "PSBETA" },
  });
  expect(bp.statusCode, bp.body).toBe(201);
  betaProjectId = bp.json().id;

  // ---- the recorded history the preview replays ---------------------------
  // alpha: 4 allowed writes + 2 allowed reads + 1 already-denied write
  for (let i = 0; i < 4; i++) {
    await recordCall({ userId: alphaLeadId, toolName: "ps_write", effect: "allow", projectId: alphaProjectId, minutesAgo: 10 + i });
  }
  for (let i = 0; i < 2; i++) {
    await recordCall({ userId: alphaMemberId, toolName: "ps_read", effect: "allow", projectId: alphaProjectId, minutesAgo: 20 + i });
  }
  // an ALREADY-denied call: it must land in `unchanged`, never in
  // `newly_denied`, or the preview would double-count the status quo.
  await recordCall({ userId: alphaMemberId, toolName: "ps_write", effect: "deny", minutesAgo: 30 });
  // beta: 3 allowed writes that the alpha lead must never be able to see
  for (let i = 0; i < 3; i++) {
    await recordCall({ userId: betaMemberId, toolName: "ps_write", effect: "allow", projectId: betaProjectId, minutesAgo: 40 + i });
  }

  // ---- the PROPOSED policy: forbid everything -----------------------------
  // Deliberately the most destructive candidate expressible. It is authored and
  // versioned but NEVER activated by this file.
  const created = await app.inject({
    method: "POST",
    url: "/v1/abac/policies",
    headers: AUTH,
    payload: {
      name: "ps-deny-all-candidate",
      source: `forbid (principal, action == RegulAIt::Action::"McpToolCall", resource);`,
      mode: "forbid",
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  denyAllPolicyId = created.json().policy.id;
  denyAllVersionId = created.json().version.id;
});

afterAll(async () => {
  await restoreStrictAdmission?.();
  // the ABAC policy set is GLOBAL: nothing this file authored may survive
  await db.delete(abacPolicies);
  // and the friction dial is a singleton every later activation would read:
  // back to its strict default (ADR-0181)
  await db
    .update(policySimulationSettings)
    .set({ requirePreviewBeforeActivate: true })
    .where(eq(policySimulationSettings.id, "singleton"));
  await app?.close();
});

// ===========================================================================
// 1. THE PURE HALF
// ===========================================================================

describe("(1) the replay classifier, the fidelity analysis, and the scope decision", () => {
  it("only an ALLOW can flip, because ABAC is subtractive", () => {
    expect(classifyReplay({ recorded: "allow", candidate: "forbid" })).toBe("newly_denied");
    expect(classifyReplay({ recorded: "allow", candidate: "require_approval" })).toBe(
      "newly_approval_required",
    );
    expect(classifyReplay({ recorded: "allow", candidate: "permit" })).toBe("unchanged");
    // an already-denied call under a forbidding candidate is the STATUS QUO
    expect(classifyReplay({ recorded: "deny", candidate: "forbid" })).toBe("unchanged");
    // a Cedar permit is not a grant, so nothing can be newly allowed
    expect(classifyReplay({ recorded: "deny", candidate: "permit" })).toBe("unchanged");
    expect(classifyReplay({ recorded: "require_approval", candidate: "permit" })).toBe("unchanged");
    expect(classifyReplay({ recorded: "allow", candidate: null })).toBe("indeterminate");
  });

  it("fidelity is read off the CANDIDATE'S OWN SOURCE, never asserted by the caller", () => {
    expect(analyzeReplayFidelity('forbid (principal, action, resource) when { resource.kind == "write" };').exact).toBe(
      true,
    );
    const inexact = analyzeReplayFidelity(
      "forbid (principal, action, resource) when { context.rateLimitUsagePct > 80 };",
    );
    expect(inexact.exact).toBe(false);
    expect(inexact.caveats[0]!.attribute).toBe("rateLimitUsagePct");
    expect(inexact.caveats[0]!.why).toMatch(/does not store the decision-time rate-limit counters/);
  });

  it("a non-admin naming a subject outside their teams is REFUSED, not silently narrowed", () => {
    const refused = resolvePolicySimulationScope({
      isAdmin: false,
      callerUserId: "u1",
      visibleUserIds: ["u1", "u2"],
      requestedUserIds: ["u1", "u3"],
    });
    expect(refused.allowed).toBe(false);
    expect(refused.userIds).toEqual([]);
    expect(refused.reason).toMatch(/another team's traffic/);
    // a silent narrowing would let someone probe team membership by watching
    // the counts move, which is why this is a refusal
    const scoped = resolvePolicySimulationScope({
      isAdmin: false,
      callerUserId: "u1",
      visibleUserIds: ["u1", "u2"],
    });
    expect(scoped.allowed).toBe(true);
    expect([...scoped.userIds!].sort()).toEqual(["u1", "u2"]);
    const admin = resolvePolicySimulationScope({
      isAdmin: true,
      callerUserId: "a1",
      visibleUserIds: [],
    });
    expect(admin.userIds).toBeNull(); // org-wide
  });

  it("the headline NAMES the reach — a bucket count alone is not a preview", () => {
    const rows: ReplayedDecision[] = [
      {
        auditLogId: "a", userId: "u1", userLabel: "Ada", projectId: "p1", projectName: "Payments",
        serverId: "s", toolName: "t", recorded: "allow", candidate: "forbid", bucket: "newly_denied",
        occurredAt: "2026-08-01T00:00:00.000Z",
      },
    ];
    const radius = summarizeBlastRadius(rows, { windowDays: 30 });
    expect(radius.affectedUsers[0]).toMatchObject({ userId: "u1", label: "Ada", calls: 1 });
    expect(radius.affectedProjects[0]).toMatchObject({ projectId: "p1", name: "Payments" });
    expect(radius.headline).toMatch(/BLOCKS 1 call/);
    expect(summarizeBlastRadius([], { windowDays: 30 }).headline).toMatch(/not the same as/);
  });
});

// ===========================================================================
// 2. ZERO DISPATCHES, ZERO MUTATION
// ===========================================================================

describe("(2) a dry run is dry", () => {
  let simulationId: string;
  let before: {
    provider: number;
    usage: number;
    audit: number;
    approvals: number;
    activeVersion: string | null;
    policyEnabled: boolean;
  };

  beforeAll(async () => {
    globalThis.__psProviderCalls = 0;
    const [u] = await db.select({ n: sql<number>`count(*)::int` }).from(usageEvents);
    const [a] = await db.select({ n: sql<number>`count(*)::int` }).from(auditLog);
    const [p] = await db.select().from(abacPolicies).where(eq(abacPolicies.id, denyAllPolicyId));
    // the approvals queue is SHARED with every other suite in this run, so the
    // assertion has to be "this simulation added none", not "the queue is empty"
    const pending = await app.inject({
      method: "GET",
      url: "/v1/approvals?status=pending",
      headers: AUTH,
    });
    before = {
      provider: globalThis.__psProviderCalls,
      usage: u!.n,
      audit: a!.n,
      approvals: (pending.json().approvals ?? []).length,
      activeVersion: p!.activeVersionId,
      policyEnabled: p!.enabled,
    };
    const res = await simulateAs(AUTH, { policyVersionId: denyAllVersionId, windowDays: 1 });
    expect(res.statusCode, res.body).toBe(201);
    simulationId = res.json().simulation.id;
  });

  it("performs ZERO dispatches — the count is a number, not an absence of complaints", () => {
    // The candidate forbids EVERY call, which is the policy most likely to tempt
    // an implementation into re-running something to find out what happens.
    expect(globalThis.__psProviderCalls).toBe(before.provider);
    expect(globalThis.__psProviderCalls).toBe(0);
  });

  it("meters nothing and queues nothing", async () => {
    const [u] = await db.select({ n: sql<number>`count(*)::int` }).from(usageEvents);
    expect(u!.n).toBe(before.usage);
    const approvals = await app.inject({ method: "GET", url: "/v1/approvals?status=pending", headers: AUTH });
    expect((approvals.json().approvals ?? []).length).toBe(before.approvals);
  });

  it("does NOT activate, enable, or otherwise touch the policy it previewed", async () => {
    const [p] = await db.select().from(abacPolicies).where(eq(abacPolicies.id, denyAllPolicyId));
    expect(p!.activeVersionId).toBe(before.activeVersion);
    expect(p!.enabled).toBe(before.policyEnabled);
    // and nothing became live: a forbid-everything policy that had leaked into
    // the active set would break every later governed call in the suite
    const res = await app.inject({ method: "GET", url: "/v1/abac/policies", headers: AUTH });
    const active = (res.json().policies as Array<{ enabled: boolean }>).filter((x) => x.enabled);
    expect(active).toHaveLength(0);
  });

  it("writes exactly ONE audit row — the record that a preview happened", async () => {
    const [a] = await db.select({ n: sql<number>`count(*)::int` }).from(auditLog);
    expect(a!.n).toBe(before.audit + 1);
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectType, "abac_policy"), eq(auditLog.ruleId, "policy-simulation-run")));
    const mine = rows.find((r) => (r.detail as { simulationId?: string }).simulationId === simulationId);
    expect(mine).toBeTruthy();
    expect((mine!.detail as { dryRun: boolean }).dryRun).toBe(true);
    expect(mine!.reason).toMatch(/DRY RUN \(nothing executed, nothing activated\)/);
  });
});

// ===========================================================================
// 3. THE BLAST RADIUS IS NAMED, AND THE NUMBERS RECONCILE
// ===========================================================================

describe("(3) a deny-all candidate, previewed org-wide by an admin", () => {
  let body: {
    simulation: {
      id: string;
      considered: number;
      newlyDenied: number;
      unchanged: number;
      newlyAllowed: number;
      indeterminate: number;
      affectedUsers: number;
      affectedProjects: number;
      headline: string;
      fidelityExact: boolean;
      policyVersion: number;
      capped: boolean;
    };
    samples: Array<{ userId: string; projectId: string | null; toolName: string; recordedEffect: string; simulatedEffect: string }>;
  };
  /** an INDEPENDENT count, computed here rather than read back from the preview */
  let independent: { total: number; allowed: number };

  beforeAll(async () => {
    // The run is NARROWED to this file's three subjects (an admin may narrow —
    // `resolvePolicySimulationScope` only ever refuses a WIDENING). That makes
    // the independent count below exact and deterministic even though the whole
    // suite shares one audit_log.
    const subjects = [alphaLeadId, alphaMemberId, betaMemberId];
    const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const scopeWhere = and(
      eq(auditLog.objectType, "mcp_tool"),
      isNotNull(auditLog.serverId),
      isNotNull(auditLog.toolName),
      gte(auditLog.at, windowStart),
      inArray(auditLog.userId, subjects),
    );
    const [total] = await db.select({ n: sql<number>`count(*)::int` }).from(auditLog).where(scopeWhere);
    const [allowed] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(and(scopeWhere, eq(auditLog.effect, "allow")));
    independent = { total: total!.n, allowed: allowed!.n };

    const res = await simulateAs(AUTH, {
      policyVersionId: denyAllVersionId,
      windowDays: 1,
      userIds: subjects,
    });
    expect(res.statusCode, res.body).toBe(201);
    body = res.json();
  });

  it("the counts reconcile against an INDEPENDENT count of the historical rows", () => {
    expect(body.simulation.considered).toBe(independent.total);
    // a forbid-everything candidate flips exactly the recorded ALLOWS, and
    // nothing else — the already-denied row stays `unchanged`
    expect(body.simulation.newlyDenied).toBe(independent.allowed);
    expect(body.simulation.unchanged).toBe(independent.total - independent.allowed);
    expect(
      body.simulation.newlyDenied +
        body.simulation.unchanged +
        body.simulation.newlyAllowed +
        body.simulation.indeterminate,
    ).toBe(body.simulation.considered);
    expect(body.simulation.capped).toBe(false);
  });

  it("`newly_allowed` is structurally zero, because ABAC cannot grant", () => {
    expect(body.simulation.newlyAllowed).toBe(0);
  });

  it("NAMES the users and the projects out of real history — not a percentage", () => {
    const radius = body as unknown as { simulation: { blastRadius: {
      users: Array<{ userId: string; label: string | null; calls: number }>;
      projects: Array<{ projectId: string | null; name: string | null; calls: number }>;
      tools: Array<{ toolName: string; calls: number }>;
    } } };
    const users = radius.simulation.blastRadius.users;
    const projects = radius.simulation.blastRadius.projects;
    expect(users.map((u) => u.userId).sort()).toEqual(
      [alphaLeadId, alphaMemberId, betaMemberId].sort(),
    );
    expect(users.find((u) => u.userId === alphaLeadId)).toMatchObject({
      label: "ps alpha lead",
      calls: 4,
    });
    expect(projects.map((p) => p.projectId).filter(Boolean).sort()).toEqual(
      [alphaProjectId, betaProjectId].sort(),
    );
    expect(projects.find((p) => p.projectId === betaProjectId)!.name).toBe("ps-beta-project");
    expect(radius.simulation.blastRadius.tools.map((t) => t.toolName).sort()).toEqual([
      "ps_read",
      "ps_write",
    ]);
    expect(body.simulation.headline).toMatch(/BLOCKS \d+ call\(s\) that succeeded/);
  });

  it("the SPECIFIC calls are readable back as rows, allow → deny", async () => {
    expect(body.samples.length).toBeGreaterThan(0);
    expect(body.samples.every((s) => s.recordedEffect === "allow")).toBe(true);
    expect(body.samples.every((s) => s.simulatedEffect === "forbid")).toBe(true);
    const stored = await db
      .select()
      .from(policySimulationFlips)
      .where(eq(policySimulationFlips.simulationId, body.simulation.id));
    expect(stored.length).toBe(body.samples.length);
    expect(stored.every((f) => f.recordedEffect === "allow")).toBe(true);
    // a project NAME (not a bare uuid) is what makes the sample actionable
    expect(stored.some((f) => f.projectName === "ps-alpha-project")).toBe(true);
  });

  it("targets an immutable VERSION, and reports its replay fidelity", async () => {
    expect(body.simulation.policyVersion).toBe(1);
    // the deny-all source reads no un-replayable attribute
    expect(body.simulation.fidelityExact).toBe(true);
    const view = await app.inject({
      method: "GET",
      url: `/v1/policy-simulations/${body.simulation.id}`,
      headers: AUTH,
    });
    expect(view.statusCode).toBe(200);
    expect(view.json().fidelity).toMatch(/It executes nothing/);
    expect(view.json().abacCannotGrant).toMatch(/structurally always zero/);
  });
});

// ===========================================================================
// 4. A PREVIEW IS NOT A WAY TO READ ANOTHER TEAM'S TRAFFIC
// ===========================================================================

describe("(4) entitlement scoping", () => {
  it("a team lead's preview covers their OWN team's history and nobody else's", async () => {
    const res = await simulateAs(alphaLeadAuth, { policyVersionId: denyAllVersionId, windowDays: 1 });
    expect(res.statusCode, res.body).toBe(201);
    const sim = res.json().simulation as {
      considered: number;
      newlyDenied: number;
      blastRadius: { users: Array<{ userId: string }> };
    };
    const named = sim.blastRadius.users.map((u) => u.userId);
    expect(named).toContain(alphaLeadId);
    expect(named).toContain(alphaMemberId);
    // THE ASSERTION THAT MATTERS: beta's calls are not merely hidden in a UI —
    // they were never replayed, so they cannot be in any bucket.
    expect(named).not.toContain(betaMemberId);
    // alpha recorded 7 calls (6 allow + 1 deny); beta's 3 are outside scope
    expect(sim.considered).toBe(7);
    expect(sim.newlyDenied).toBe(6);
    expect(res.json().scope.orgWide).toBe(false);
  });

  it("explicitly naming another team's user is REFUSED, and the refusal is a record", async () => {
    const res = await simulateAs(alphaLeadAuth, {
      policyVersionId: denyAllVersionId,
      windowDays: 1,
      userIds: [alphaLeadId, betaMemberId],
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("simulation_scope_denied");
    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.objectType, "abac_policy"),
          eq(auditLog.ruleId, "policy-simulation-denied-outside-scope"),
        ),
      );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.effect).toBe("deny");
  });

  it("a narrower caller cannot read a WIDER stored preview back out of the archive", async () => {
    const orgWide = await simulateAs(AUTH, { policyVersionId: denyAllVersionId, windowDays: 1 });
    // (an admin run with no explicit narrowing is org-wide: scopeUserIds is null)
    expect(orgWide.statusCode).toBe(201);
    const id = orgWide.json().simulation.id as string;
    const read = await app.inject({
      method: "GET",
      url: `/v1/policy-simulations/${id}`,
      headers: alphaLeadAuth,
    });
    expect(read.statusCode).toBe(403);
    expect(read.json().error).toBe("simulation_scope_denied");
  });

  it("ADR-0167 (AUTHZ-02): the LIST is scoped the same way — a wider run is absent, not merely un-clickable, and no row carries a named radius", async () => {
    // an admin's org-wide run: the exact row the detail route refuses to alpha's lead
    const orgWide = await simulateAs(AUTH, { policyVersionId: denyAllVersionId, windowDays: 1 });
    expect(orgWide.statusCode).toBe(201);
    const wideId = orgWide.json().simulation.id as string;
    // the lead's own, team-scoped run: theirs to see
    const own = await simulateAs(alphaLeadAuth, { policyVersionId: denyAllVersionId, windowDays: 1 });
    expect(own.statusCode, own.body).toBe(201);
    const ownId = own.json().simulation.id as string;

    const list = await app.inject({ method: "GET", url: "/v1/policy-simulations?limit=200", headers: alphaLeadAuth });
    expect(list.statusCode).toBe(200);
    const rows = list.json().simulations as Array<Record<string, unknown>>;
    const ids = rows.map((s) => s.id);
    expect(ids).toContain(ownId);
    expect(ids).not.toContain(wideId);
    // SUMMARY rows: the named users/projects/tools and the scope stay behind
    // the detail route's guard; counts and the headline are what a list needs
    for (const s of rows) {
      expect(s).not.toHaveProperty("blastRadius");
      expect(s).not.toHaveProperty("scopeUserIds");
      expect(typeof s.affectedUsers).toBe("number");
      expect(typeof s.headline).toBe("string");
    }

    // a user in NO team sees neither run — not even the lead's team-scoped one
    const outsider = await makeUser("ps-gamma-outsider@example.com");
    const outsiderList = await app.inject({ method: "GET", url: "/v1/policy-simulations?limit=200", headers: outsider.auth });
    expect(outsiderList.statusCode).toBe(200);
    const outsiderIds = (outsiderList.json().simulations as Array<{ id: string }>).map((s) => s.id);
    expect(outsiderIds).not.toContain(wideId);
    expect(outsiderIds).not.toContain(ownId);

    // the admin still sees both, and the named radius is still readable where it belongs
    const adminList = await app.inject({ method: "GET", url: "/v1/policy-simulations?limit=200", headers: AUTH });
    const adminIds = (adminList.json().simulations as Array<{ id: string }>).map((s) => s.id);
    expect(adminIds).toContain(wideId);
    expect(adminIds).toContain(ownId);
    const detail = await app.inject({ method: "GET", url: `/v1/policy-simulations/${wideId}`, headers: AUTH });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().simulation).toHaveProperty("blastRadius");
  });
});

// ===========================================================================
// 5. ACTIVATING WITHOUT PREVIEWING IS FRICTION
// ===========================================================================

describe("(5) friction on activation (ADR-0040's honest-risks note, made operable)", () => {
  let unpreviewedPolicyId: string;

  beforeAll(async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/abac/policies",
      headers: AUTH,
      payload: {
        name: "ps-never-previewed",
        source: `forbid (principal, action == RegulAIt::Action::"McpToolCall", resource)
                 when { resource.toolName == "ps-nothing-at-all" };`,
        mode: "forbid",
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    unpreviewedPolicyId = created.json().policy.id;
  });

  afterAll(async () => {
    await app.inject({
      method: "DELETE",
      url: `/v1/abac/policies/${unpreviewedPolicyId}`,
      headers: AUTH,
    });
    await app.inject({
      method: "PUT",
      url: "/v1/policy-simulations/settings",
      headers: AUTH,
      payload: { requirePreviewBeforeActivate: true },
    });
  });

  it("the dial ships ON (ADR-0181)", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/policy-simulations/settings", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.requirePreviewBeforeActivate).toBe(true);
  });

  it("with the dial relaxed OFF activation succeeds but the omission is RECORDED", async () => {
    const off = await app.inject({
      method: "PUT",
      url: "/v1/policy-simulations/settings",
      headers: AUTH,
      payload: { requirePreviewBeforeActivate: false },
    });
    expect(off.statusCode, off.body).toBe(200);
    const res = await app.inject({
      method: "POST",
      url: `/v1/abac/policies/${unpreviewedPolicyId}/activate`,
      headers: AUTH,
      payload: { version: 1 },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().blastRadiusPreviewed).toBe(false);
    expect(res.json().warning).toMatch(/WITHOUT a blast-radius preview/);
    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.objectType, "abac_policy"), eq(auditLog.objectId, unpreviewedPolicyId)),
      );
    const activation = rows.find((r) => r.ruleId === "abac-policy-activated");
    expect(activation).toBeTruthy();
    expect((activation!.detail as { blastRadiusPreviewed: boolean }).blastRadiusPreviewed).toBe(false);
    // put it back out of the active set immediately — an enabled policy is
    // global state every later file's decisions would read
    await app.inject({
      method: "POST",
      url: `/v1/abac/policies/${unpreviewedPolicyId}/deactivate`,
      headers: AUTH,
    });
  });

  it("with the dial ON the same activation is REFUSED, and previewing unblocks it", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/v1/policy-simulations/settings",
      headers: AUTH,
      payload: { requirePreviewBeforeActivate: true },
    });
    expect(put.statusCode, put.body).toBe(200);

    const refused = await app.inject({
      method: "POST",
      url: `/v1/abac/policies/${unpreviewedPolicyId}/activate`,
      headers: AUTH,
      payload: { version: 1 },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("blast_radius_not_previewed");
    const versionId = refused.json().policyVersionId as string;

    // preview it — still a dry run, still zero dispatches
    const callsBefore = globalThis.__psProviderCalls;
    const sim = await simulateAs(AUTH, { policyVersionId: versionId, windowDays: 1 });
    expect(sim.statusCode, sim.body).toBe(201);
    expect(globalThis.__psProviderCalls).toBe(callsBefore);
    // a narrowly-scoped forbid changes nothing about the recorded past, and the
    // headline says so rather than manufacturing a reason to feel good
    expect(sim.json().simulation.newlyDenied).toBe(0);
    expect(sim.json().simulation.headline).toMatch(/would have been decided differently/);

    const allowed = await app.inject({
      method: "POST",
      url: `/v1/abac/policies/${unpreviewedPolicyId}/activate`,
      headers: AUTH,
      payload: { version: 1 },
    });
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(allowed.json().blastRadiusPreviewed).toBe(true);
    expect(allowed.json().blastRadiusSimulationId).toBe(sim.json().simulation.id);
    await app.inject({
      method: "POST",
      url: `/v1/abac/policies/${unpreviewedPolicyId}/deactivate`,
      headers: AUTH,
    });
  });
});

// ===========================================================================
// 6. STILL NOTHING WAS DISPATCHED, ACROSS THE WHOLE FILE
// ===========================================================================

describe("(6) the closing count", () => {
  it("no model provider was invoked once, by any simulation in this file", async () => {
    expect(globalThis.__psProviderCalls).toBe(0);
    const runs = await db.select({ n: sql<number>`count(*)::int` }).from(policySimulations);
    expect(runs[0]!.n).toBeGreaterThanOrEqual(4);
  });
});
