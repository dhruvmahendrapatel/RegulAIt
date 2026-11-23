/**
 * ADR-0251 slice 4 — Cedar ABAC on the governed core's model, connector and A2A calls (schema v5).
 *
 *  - no active v5 policy: the core's ABAC slot is null (nothing can apply);
 *  - a v5 `forbid` on `ModelInvoke` refuses a real model dispatch for its principal (audited, no usage row) and leaves
 *    another person's call alone; a v5 `forbid` on `ConnectorCall` refuses the core's decision;
 *  - slice 4c: a v5 `require_approval` holds a queueable call for the policy's approver, and refuses where nothing
 *    can queue it (A2A);
 *  - a v4 policy (written for `McpToolCall`) never applies to a model call, however broadly it is written;
 *  - review #836: a model forbid answers 403 `forbidden`; a failed read (the verdict's, a sibling's, or both, in
 *    either order) denies with no unhandled rejection; an engine error on a governed call denies.
 *
 * Runs on its OWN scratch database: active ABAC policies are global, and must not reach other suites.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abacPolicies, abacPolicyVersions, and, auditLog, desc, eq, resourceApprovalRules, usageEvents, type Db } from "@regulait/db";
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
      // review #836: a policy refusal, not a missing approval
      expect(JSON.parse(r.body).error).toBe("forbidden");
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
      // the policy names A2aMessage only, so a connector call is untouched by it
      const c = await governedEvaluateResource(k.db, {
        userId: caller.id,
        resource: { type: "connector", id: "00000000-0000-4000-a000-0000000000c2", operation: "write" },
        projectId: caller.projectId,
        base: allow,
        canQueue: true,
      });
      expect(c.effect).toBe("allow");
    } finally {
      await dropPolicy(id);
    }
  });

  it("slice 4c: a v5 require_approval on ConnectorCall HOLDS a queueable call for the policy's approver", async () => {
    const connectorId = "00000000-0000-4000-a000-0000000000c3";
    const id = await activePolicy(
      `forbid (principal == RegulAIt::User::"${caller.id}", action == RegulAIt::Action::"ConnectorCall", resource) when { resource.operation == "write" };`,
      "v5",
      "require_approval",
    );
    try {
      const held = await governedEvaluateResource(k.db, {
        userId: caller.id,
        resource: { type: "connector", id: connectorId, operation: "write" },
        projectId: caller.projectId,
        base: allow,
        canQueue: true,
      });
      expect(held).toMatchObject({ effect: "require_approval", ruleId: id, approverUserId: approver.id });
      expect(held.ruleChain.at(-1)).toEqual({ rule: "abac-require-approval", outcome: "require-approval", grantId: id });
      // where nothing can queue it, it still refuses (fail closed)
      const unqueueable = await governedEvaluateResource(k.db, {
        userId: caller.id,
        resource: { type: "connector", id: connectorId, operation: "write" },
        projectId: caller.projectId,
        base: allow,
        canQueue: false,
      });
      expect(unqueueable).toMatchObject({ effect: "deny", ruleId: id });
      // a read is not held by a write-only condition
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

  it("review #836: an engine error on a governed call denies (abac-engine-error), never allows", async () => {
    // stored directly (bypassing write-time validation): a Model has no skillId, so evaluation errors
    const id = await activePolicy(`forbid (principal, action == RegulAIt::Action::"ModelInvoke", resource) when { resource.skillId == "x" };`, "v5");
    try {
      const d = await governedEvaluateResource(k.db, {
        userId: caller.id,
        resource: { type: "model", id: MODEL, mode: "chat" },
        projectId: caller.projectId,
        base: allow,
        canQueue: false,
      });
      expect(d).toMatchObject({ effect: "deny", ruleId: "abac-engine-error" });
    } finally {
      await dropPolicy(id);
    }
  });
});

/** a query builder that rejects when awaited, after `delayMs` */
function failingQuery(delayMs: number): unknown {
  const fail = () => new Promise((_res, rej) => setTimeout(() => rej(new Error("injected read failure")), delayMs));
  const q: unknown = new Proxy(function () {}, {
    get: (_t, prop) => (prop === "then" ? (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => fail().then(ok, ko) : q),
    apply: () => q,
  });
  return q;
}

/** `k.db`, except a SELECT from one of `tables` fails after `delayMs` */
function dbFailingOn(tables: Map<unknown, number>): Db {
  return new Proxy(k.db, {
    get(target, prop, receiver) {
      if (prop !== "select") return Reflect.get(target, prop, receiver);
      return (...cols: unknown[]) => {
        const builder = (target.select as (...a: unknown[]) => object)(...cols);
        return new Proxy(builder, {
          get(b, p) {
            const v = Reflect.get(b, p, b);
            if (p !== "from" || typeof v !== "function") return typeof v === "function" ? v.bind(b) : v;
            return (table: unknown, ...rest: unknown[]) => (tables.has(table) ? failingQuery(tables.get(table)!) : v.call(b, table, ...rest));
          },
        });
      };
    },
  }) as Db;
}

describe("review #836: a failed read denies the governed call, with no unhandled rejection", () => {
  const cases: Array<[string, Map<unknown, number>]> = [
    ["the ABAC verdict's read fails", new Map([[abacPolicies, 0]])],
    ["a sibling read fails first, then the verdict's", new Map<unknown, number>([[resourceApprovalRules, 0], [abacPolicies, 40]])],
    ["a sibling read fails alone", new Map([[resourceApprovalRules, 0]])],
  ];
  for (const [name, tables] of cases) {
    it(name, async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (e: unknown) => unhandled.push(e);
      process.on("unhandledRejection", onUnhandled);
      try {
        const d = await governedEvaluateResource(dbFailingOn(tables), {
          userId: caller.id,
          resource: { type: "connector", id: "00000000-0000-4000-a000-0000000000c4", operation: "write" },
          projectId: caller.projectId,
          base: allow,
          canQueue: true,
        });
        expect(d).toMatchObject({ effect: "deny", ruleId: "governed-core-error" });
        // let the later failure settle; it must have been observed
        await new Promise((r) => setTimeout(r, 120));
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });
  }
});
