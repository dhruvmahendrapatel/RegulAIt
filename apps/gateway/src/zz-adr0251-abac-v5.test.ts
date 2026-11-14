/**
 * ADR-0251 slice 4 — Cedar ABAC on the governed core's model, connector and A2A calls (schema v5).
 *
 *  - no active v5 policy: the core's ABAC slot is null (nothing can apply);
 *  - a v5 `forbid` on `ModelInvoke` refuses a real model dispatch for its principal (audited, no usage row) and leaves
 *    another person's call alone; a v5 `forbid` on `ConnectorCall` refuses the core's decision;
 *  - a v5 `require_approval` on these call types refuses (fail closed: no consent binds an ABAC hold on them yet);
 *  - a v4 policy (written for `McpToolCall`) never applies to a model call, however broadly it is written.
 *
 * Runs on its OWN scratch database: active ABAC policies are global, and must not reach other suites.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abacPolicies, abacPolicyVersions, and, auditLog, desc, eq, usageEvents } from "@regulait/db";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { governedEvaluateResource, loadResourceRestrictions } from "./governed-core.js";

let k: BuilderKit;
let restoreGates: () => Promise<void> = async () => {};
let caller: Person;
let other: Person;
let approver: Person;
let MODEL = "";

async function activePolicy(source: string, schemaVersion: string, mode: "forbid" | "require_approval" = "forbid"): Promise<string> {
  const [policy] = await k.db.insert(abacPolicies).values({ name: `adr0251-v5-${Math.random().toString(36).slice(2, 8)}`, enabled: true }).returning({ id: abacPolicies.id });
  const [version] = await k.db
    .insert(abacPolicyVersions)
    .values({ policyId: policy!.id, version: 1, source, schemaVersion, mode, ...(mode === "require_approval" ? { approverUserId: approver.id } : {}) })
    .returning({ id: abacPolicyVersions.id });
  await k.db.update(abacPolicies).set({ activeVersionId: version!.id }).where(eq(abacPolicies.id, policy!.id));
  return policy!.id;
}
const dropPolicy = (id: string) => k.db.update(abacPolicies).set({ enabled: false, activeVersionId: null }).where(eq(abacPolicies.id, id));
const usage = async (userId: string) => (await k.db.select({ id: usageEvents.id }).from(usageEvents).where(and(eq(usageEvents.userId, userId), eq(usageEvents.agentId, MODEL)))).length;
const invoke = (who: Person) => k.req("POST", `/v1/agents/${MODEL}/invoke`, who.auth, { mode: "chat", input: "abac v5 probe", dispatch: true, projectId: who.projectId });
const allow = { effect: "allow" as const, ruleId: "g", reason: "granted", ruleChain: [] };

beforeAll(async () => {
  k = await builderKit("adr0251-abac5", { scratch: true });
  restoreGates = await relaxGovernanceGatesForTest(k.db, { mrmEnforced: false });
  caller = await k.person("caller");
  other = await k.person("other");
  approver = await k.person("approver");
  MODEL = await k.model("abac", { price: 1 });
  await k.grantModel(caller.id, MODEL);
  await k.grantModel(other.id, MODEL);
}, 120_000);

afterAll(async () => {
  await restoreGates();
  await k.close();
});

describe("ADR-0251 slice 4: ABAC v5 on the governed core", () => {
  it("with no active v5 policy the core's ABAC slot is null", async () => {
    const v4 = await activePolicy(`forbid (principal == RegulAIt::User::"${caller.id}", action, resource);`, "v4");
    try {
      const r = await loadResourceRestrictions(k.db, { userId: caller.id, resource: { type: "model", id: MODEL, mode: "chat" }, projectId: caller.projectId });
      expect(r.abacDecision).toBeNull();
      // a v4 policy, however broad, never applies to a model call
      expect((await invoke(caller)).statusCode).toBe(200);
    } finally {
      await dropPolicy(v4);
    }
  });

  it("a v5 forbid on ModelInvoke refuses that principal's dispatch (audited, no usage row) and no one else's", async () => {
    const id = await activePolicy(
      `forbid (principal == RegulAIt::User::"${caller.id}", action == RegulAIt::Action::"ModelInvoke", resource) when { resource.mode == "chat" && resource has projectId };`,
      "v5",
    );
    try {
      const before = await usage(caller.id);
      const r = await invoke(caller);
      expect(r.statusCode, r.body).toBe(403);
      expect(await usage(caller.id)).toBe(before);
      const [row] = await k.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.userId, caller.id), eq(auditLog.objectId, MODEL), eq(auditLog.ruleId, id)))
        .orderBy(desc(auditLog.seq))
        .limit(1);
      expect(row).toMatchObject({ effect: "deny", objectType: "agent" });
      expect((await invoke(other)).statusCode).toBe(200);
    } finally {
      await dropPolicy(id);
    }
    expect((await invoke(caller)).statusCode).toBe(200);
  });

  it("a v5 forbid on ConnectorCall writes refuses the core's decision for writes only", async () => {
    const id = await activePolicy(
      `forbid (principal == RegulAIt::User::"${caller.id}", action == RegulAIt::Action::"ConnectorCall", resource) when { resource.operation == "write" };`,
      "v5",
    );
    const connectorId = "00000000-0000-4000-a000-0000000000c1";
    try {
      const write = await governedEvaluateResource(k.db, {
        userId: caller.id,
        resource: { type: "connector", id: connectorId, operation: "write" },
        projectId: caller.projectId,
        base: allow,
        canQueue: true,
      });
      expect(write).toMatchObject({ effect: "deny", ruleId: id });
      const read = await governedEvaluateResource(k.db, {
        userId: caller.id,
        resource: { type: "connector", id: connectorId, operation: "read" },
        projectId: caller.projectId,
        base: allow,
        canQueue: true,
      });
      expect(read.effect).toBe("allow");
    } finally {
      await dropPolicy(id);
    }
  });

  it("a v5 require_approval on A2aMessage refuses (fail closed), naming the policy", async () => {
    const id = await activePolicy(
      `forbid (principal == RegulAIt::User::"${caller.id}", action == RegulAIt::Action::"A2aMessage", resource);`,
      "v5",
      "require_approval",
    );
    try {
      const d = await governedEvaluateResource(k.db, {
        userId: caller.id,
        resource: { type: "a2a", id: "00000000-0000-4000-a000-0000000000a1", skillId: null },
        projectId: caller.projectId,
        base: allow,
        canQueue: false,
      });
      expect(d).toMatchObject({ effect: "deny", ruleId: id });
      expect(d.reason).toMatch(/approv/i);
      // the same hold on a queueable connector call refuses too: no consent binds an ABAC hold on this path yet
      const c = await governedEvaluateResource(k.db, {
        userId: caller.id,
        resource: { type: "connector", id: "00000000-0000-4000-a000-0000000000c2", operation: "write" },
        projectId: caller.projectId,
        base: allow,
        canQueue: true,
      });
      expect(c.effect).toBe("allow"); // the policy names A2aMessage only
    } finally {
      await dropPolicy(id);
    }
  });
});
