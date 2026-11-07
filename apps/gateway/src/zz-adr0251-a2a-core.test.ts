/**
 * ADR-0251 slice 3 (review S-05, S-06) — A2A calls through the one governed decision core.
 *
 * The remote agent's url is a private address that the egress decision refuses (no private-range opt-in), so a call
 * the governance layer ALLOWS ends at `a2a-egress-blocked` and nothing is ever sent: that rule id is the marker of
 * "governance said yes". Covers the kill switch and safe modes (new for A2A), the literacy gate, the attribution
 * mandate (on by default), rate limits, approval rules (refused: no A2A queue yet), error is deny, and a DIFFERENTIAL
 * test against a transcription of the pre-ADR-0251 route's own checks (lead ceiling, then the grant).
 *
 * Global state (M-068): org settings and rule rows are restored in afterAll / per test.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { a2aAgentGrants, a2aAgents, auditLog, eq, orgSettings, ORG_SETTINGS_ID, resourceApprovalRules, resourceRateLimits, type Db } from "@regulait/db";
import { RESOURCE_RULE_IDS } from "@regulait/policy-kernel";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import { A2A_RULE_IDS, executeGovernedA2aCall } from "./a2a.js";

let k: BuilderKit;
let caller: Person;
let other: Person;
let approver: Person;
let agentId = "";
let priorA2a = false;

const ALLOWED_MARKER = A2A_RULE_IDS.egress;
const call = (who: Person, opts: { skillId?: string | null; project?: boolean; ceiling?: string[] | null; db?: Db } = {}) =>
  executeGovernedA2aCall(opts.db ?? k.db, {
    userId: who.id,
    agentId,
    skillId: opts.skillId ?? null,
    text: "adr0251 probe",
    projectId: opts.project === false ? null : who.projectId,
    ceilingAgentIds: opts.ceiling ?? null,
  });
const setOrg = (v: Partial<typeof orgSettings.$inferInsert>) => k.db.update(orgSettings).set(v).where(eq(orgSettings.id, ORG_SETTINGS_ID));

beforeAll(async () => {
  k = await builderKit("adr0251-a2a");
  caller = await k.person("caller");
  other = await k.person("other");
  approver = await k.person("approver");
  const [org] = await k.db.select({ on: orgSettings.a2aEnabled }).from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  priorA2a = org?.on ?? false;
  await setOrg({ a2aEnabled: true });
  const [agent] = await k.db
    .insert(a2aAgents)
    .values({ name: `adr0251-${k.RUN}`, url: "http://10.255.255.1:9/a2a", card: { name: "probe", skills: [{ id: "s1" }, { id: "s2" }] }, allowPrivateRanges: false })
    .returning();
  agentId = agent!.id;
  await k.db.insert(a2aAgentGrants).values({ agentId, userId: caller.id, skillId: null });
}, 120_000);

afterAll(async () => {
  await k.db.delete(resourceRateLimits).where(eq(resourceRateLimits.a2aAgentId, agentId));
  await k.db.delete(resourceApprovalRules).where(eq(resourceApprovalRules.a2aAgentId, agentId));
  await k.db.delete(a2aAgents).where(eq(a2aAgents.id, agentId));
  await k.req("PUT", "/v1/execution/mode", k.BOOT, { mode: "normal", reason: "adr0251 a2a: cleanup" });
  await setOrg({ a2aEnabled: priorA2a, a2aAttributionRequired: true });
  await k.close();
});

describe("ADR-0251 slice 3: governance allows a granted, attributed call (and only then does egress decide)", () => {
  it("reaches the egress decision", async () => {
    const out = await call(caller);
    expect(out).toMatchObject({ kind: "denied", ruleId: ALLOWED_MARKER });
  });
});

describe("ADR-0251 slice 3: the kill switch and safe modes now apply to A2A (S-05)", () => {
  for (const [mode, ruleId] of [
    ["halted", "execution-halted"],
    ["read_only", "execution-read-only"],
    ["require_approval", "execution-require-approval"],
  ] as const) {
    it(`${mode} refuses the call before anything is sent, audited`, async () => {
      const set = await k.req("PUT", "/v1/execution/mode", k.BOOT, { mode, reason: `adr0251 a2a: ${mode}`, ...(mode === "require_approval" ? { approverUserId: approver.id } : {}) });
      expect(set.statusCode, set.body).toBeLessThan(300);
      try {
        const out = await call(caller);
        expect(out).toMatchObject({ kind: "denied", status: 403, error: "execution_refused", ruleId });
        const [row] = await k.db.select().from(auditLog).where(eq(auditLog.id, (out as { auditId: string }).auditId));
        expect(row).toMatchObject({ effect: "deny", ruleId, objectType: "a2a_agent" });
      } finally {
        await k.req("PUT", "/v1/execution/mode", k.BOOT, { mode: "normal", reason: "adr0251 a2a: restore" });
      }
    });
  }
});

describe("ADR-0251 slice 3: the attribution mandate on A2A (S-06)", () => {
  it("is on by default: an unattributed call is refused 409; the relaxation lets it through to egress", async () => {
    expect(await call(caller, { project: false })).toMatchObject({ kind: "denied", status: 409, error: "attribution_required", ruleId: RESOURCE_RULE_IDS.attribution });
    await setOrg({ a2aAttributionRequired: false });
    try {
      expect(await call(caller, { project: false })).toMatchObject({ kind: "denied", ruleId: ALLOWED_MARKER });
    } finally {
      await setOrg({ a2aAttributionRequired: true });
    }
  });
});

describe("ADR-0251 slice 3: A2A rate limits and approval rules (P-01)", () => {
  it("a limit refuses the call once the window holds as many allowed calls as it permits (429)", async () => {
    const [limit] = await k.db.insert(resourceRateLimits).values({ resourceType: "a2a", a2aAgentId: agentId, scope: "user", userId: caller.id, maxCalls: 1, windowSeconds: 3600 }).returning();
    try {
      // one allowed A2A decision already in the window (what a replied call writes)
      await k.db.insert(auditLog).values({ userId: caller.id, objectType: "a2a_agent", objectId: agentId, detail: { outcome: "replied", receiptClass: "decision" }, effect: "allow", ruleId: A2A_RULE_IDS.callAllowed, ruleChain: [], reason: "adr0251 fixture: a prior allowed call" });
      expect(await call(caller)).toMatchObject({ kind: "denied", status: 429, error: "rate_limited", ruleId: limit!.id });
    } finally {
      await k.db.delete(resourceRateLimits).where(eq(resourceRateLimits.id, limit!.id));
    }
    expect(await call(caller)).toMatchObject({ ruleId: ALLOWED_MARKER });
  });

  it("an approval rule refuses (no A2A approval queue yet), naming the approver, and binds only its subject", async () => {
    await k.db.insert(a2aAgentGrants).values({ agentId, userId: other.id, skillId: null });
    const [rule] = await k.db.insert(resourceApprovalRules).values({ resourceType: "a2a", a2aAgentId: agentId, scope: "user", userId: caller.id, approverUserId: approver.id }).returning();
    try {
      const out = await call(caller);
      expect(out).toMatchObject({ kind: "denied", status: 403, error: "approval_required", ruleId: rule!.id });
      expect((out as { reason: string }).reason).toContain("no per-call approval queue");
      expect(await call(other)).toMatchObject({ ruleId: ALLOWED_MARKER });
    } finally {
      await k.db.delete(resourceApprovalRules).where(eq(resourceApprovalRules.id, rule!.id));
    }
  });
});

describe("ADR-0251: an error inside the core is a deny", () => {
  it("a grant load that throws refuses with governed-core-error", async () => {
    let n = 0;
    const flaky = new Proxy(k.db, {
      get(target, prop, recv) {
        // the org settings and agent reads succeed; the core's first load fails
        if (prop === "select" && ++n > 2) throw new Error("connection reset");
        return Reflect.get(target, prop, recv);
      },
    }) as Db;
    expect(await call(caller, { db: flaky })).toMatchObject({ kind: "denied", status: 503, error: "governed_core_error", ruleId: RESOURCE_RULE_IDS.coreError });
  });
});

describe("ADR-0251 differential: the A2A entitlement decision agrees with the pre-ADR-0251 route wherever it decided", () => {
  /** the pre-ADR-0251 route's steps 3 and 4, transcribed: the lead ceiling, then the grant (whole agent, or the skill) */
  const oldDecision = (grants: { skillId: string | null }[], skillId: string | null, ceiling: string[] | null): string | null => {
    if (ceiling && !ceiling.includes(agentId)) return A2A_RULE_IDS.leadCeiling;
    const granted = grants.some((g) => (skillId === null ? g.skillId === null : g.skillId === null || g.skillId === skillId));
    return granted ? null : A2A_RULE_IDS.noGrant;
  };

  it("over grant shape x requested skill x lead ceiling (normal posture, attributed)", async () => {
    const shapes: { skillId: string | null }[][] = [[], [{ skillId: null }], [{ skillId: "s1" }], [{ skillId: "s2" }], [{ skillId: "s1" }, { skillId: "s2" }]];
    let compared = 0;
    for (const shape of shapes) {
      await k.db.delete(a2aAgentGrants).where(eq(a2aAgentGrants.userId, other.id));
      for (const g of shape) await k.db.insert(a2aAgentGrants).values({ agentId, userId: other.id, skillId: g.skillId });
      for (const skillId of [null, "s1", "s2"])
        for (const ceiling of [null, [agentId], ["00000000-0000-4000-8000-000000000000"]]) {
          const want = oldDecision(shape, skillId, ceiling) ?? ALLOWED_MARKER;
          const got = await call(other, { skillId, ceiling });
          expect((got as { ruleId: string }).ruleId, `${JSON.stringify(shape)}/${skillId}/${JSON.stringify(ceiling)}`).toBe(want);
          compared++;
        }
    }
    expect(compared).toBe(5 * 3 * 3);
  });
});
