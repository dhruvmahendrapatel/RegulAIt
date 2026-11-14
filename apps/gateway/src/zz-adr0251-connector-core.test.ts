/**
 * ADR-0251 slice 1 — connector calls through the one governed decision core.
 *
 * The connector is a `webhook` at a local receiver that counts every request: the honest proof that a refused or held
 * call executed nothing. Covers the four restrictions the core adds on this path (attribution mandate, rate limit,
 * approval rule, error is deny) and a DIFFERENTIAL test: wherever the old path had a decision (no restriction rows,
 * an attributed call), the old decision (`evaluateConnector` alone) and the new one agree.
 *
 * Global state (M-068): the org setting and every rule row are put back in afterAll / at the end of each test.
 */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { relaxStepUpAround } from "./testing/step-up-posture.js";
import { removeEgressAllowEntry } from "./testing/egress-allow-cleanup.js";
import { and, approvals, auditLog, desc, eq, orgSettings, ORG_SETTINGS_ID, resourceApprovalRules, resourceRateLimits, resourceRateReservations, type Db } from "@regulait/db";
import { evaluateConnector, RESOURCE_RULE_IDS, type ExecutionMode } from "@regulait/policy-kernel";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxApprovalSigningForTest } from "./testing/approval-signing-posture.js";
import { governedEvaluateResource, loadResourceRestrictions } from "./governed-core.js";

let restoreApprovalSigning: (() => Promise<void>) | undefined;
let restoreGates: () => Promise<void> = async () => {};
let k: BuilderKit;
let owner: Person;
let other: Person;
let approver: Person;
let dialApprover: Person;
let connectorId = "";
let allowHostId = "";
let receiver: http.Server;
const received: string[] = [];

const invoke = (who: Person, operation: "read" | "write", opts: { project?: boolean; note?: string } = {}) =>
  k.req("POST", `/v1/connectors/${connectorId}/invoke`, who.auth, {
    operation,
    object: "inbox",
    payload: { note: opts.note ?? `n-${k.RUN}` },
    ...(opts.project === false ? {} : { projectId: who.projectId }),
  });
const lastDecisionRow = async (userId: string) =>
  (
    await k.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, userId), eq(auditLog.objectType, "connector"), eq(auditLog.objectId, connectorId)))
      .orderBy(desc(auditLog.seq))
      .limit(1)
  )[0]!;

beforeAll(async () => {
  k = await builderKit("adr0251-conn");
  restoreApprovalSigning = await relaxApprovalSigningForTest(k.db);
  // the mandate under test stays STRICT here; only the gates this suite does not test are relaxed
  restoreGates = await relaxGovernanceGatesForTest(k.db, { mrmEnforced: false, dispatchAttributionRequired: false });
  owner = await k.person("owner");
  other = await k.person("other");
  approver = await k.person("approver");
  dialApprover = await k.person("dial-approver");

  receiver = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ received: true }));
    });
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  const port = (receiver.address() as { port: number }).port;
  const allowed = await relaxStepUpAround(k.db, () =>
    k.req("POST", "/v1/egress-allow-hosts", k.BOOT, { host: "127.0.0.1", allowPrivateRanges: true, allowPlaintextHttp: true, note: `adr0251-${k.RUN}` }),
  );
  expect(allowed.statusCode, allowed.body).toBe(201);
  allowHostId = allowed.json().id as string;
  const c = await k.req("POST", "/v1/connectors", k.BOOT, {
    name: `adr0251-hook-${k.RUN}`,
    kind: "notifications",
    providerKind: "webhook",
    baseUrl: `http://127.0.0.1:${port}/collect`,
  });
  expect(c.statusCode, c.body).toBe(201);
  connectorId = c.json().id as string;
  for (const p of [owner, other]) {
    const g = await k.req("POST", "/v1/grants/connectors", k.BOOT, { userId: p.id, connectorId, mode: "readwrite" });
    expect(g.statusCode, g.body).toBeLessThan(300);
  }
}, 120_000);

afterAll(async () => {
  const loopback = await removeEgressAllowEntry(k.app, k.BOOT, { id: allowHostId });
  try {
    await k.db.delete(resourceRateLimits).where(eq(resourceRateLimits.connectorId, connectorId));
    await k.db.delete(resourceApprovalRules).where(eq(resourceApprovalRules.connectorId, connectorId));
    await k.db.update(orgSettings).set({ connectorAttributionRequired: true }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    await restoreApprovalSigning?.();
    receiver.closeAllConnections();
    await new Promise<void>((r) => receiver.close(() => r()));
    await restoreGates();
    await k.close();
  } finally {
    loopback.assertRemoved();
  }
});

describe("ADR-0251 slice 1: the attribution mandate on connector calls (S-06)", () => {
  it("is ON by default: an unattributed call is refused, audited, and sends nothing", async () => {
    const [org] = await k.db.select({ on: orgSettings.connectorAttributionRequired }).from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    expect(org?.on).toBe(true);
    const before = received.length;
    const r = await invoke(owner, "read", { project: false });
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json().decision).toMatchObject({ effect: "deny", ruleId: RESOURCE_RULE_IDS.attribution });
    expect(received.length).toBe(before);
    const row = await lastDecisionRow(owner.id);
    expect(row).toMatchObject({ effect: "deny", ruleId: RESOURCE_RULE_IDS.attribution });
  });

  it("an attributed call runs; the relaxation lets an unattributed one run too", async () => {
    const before = received.length;
    expect((await invoke(owner, "read")).statusCode).toBe(200);
    await k.db.update(orgSettings).set({ connectorAttributionRequired: false }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    try {
      const r = await invoke(owner, "read", { project: false });
      expect(r.statusCode, r.body).toBe(200);
    } finally {
      await k.db.update(orgSettings).set({ connectorAttributionRequired: true }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    }
    expect(received.length).toBe(before + 2);
  });
});

describe("ADR-0251 slice 1: connector rate limits (P-01)", () => {
  it("refuses the call over the limit for that subject only, and sends nothing", async () => {
    const [limit] = await k.db
      .insert(resourceRateLimits)
      .values({ resourceType: "connector", connectorId, scope: "user", userId: owner.id, maxCalls: 2, windowSeconds: 3600 })
      .returning();
    try {
      // the earlier allowed calls in this file already count inside the window
      const used = (
        await k.db
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.userId, owner.id), eq(auditLog.objectType, "connector"), eq(auditLog.objectId, connectorId), eq(auditLog.effect, "allow")))
      ).length;
      expect(used).toBeGreaterThanOrEqual(2);
      const before = received.length;
      const r = await invoke(owner, "read");
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json().decision).toMatchObject({ effect: "deny", ruleId: limit!.id });
      expect(received.length).toBe(before);
      // another person is not counted against this user's limit
      expect((await invoke(other, "read")).statusCode).toBe(200);
    } finally {
      await k.db.delete(resourceRateLimits).where(eq(resourceRateLimits.id, limit!.id));
    }
    expect((await invoke(owner, "read")).statusCode).toBe(200);
  });
});

describe("ADR-0251 slice 1: connector approval rules (P-01)", () => {
  it("holds a matching call for the rule's approver, runs the approved identical call once, and queues the next", async () => {
    const [rule] = await k.db
      .insert(resourceApprovalRules)
      .values({ resourceType: "connector", connectorId, scope: "user", userId: owner.id, writeOnly: true, approverUserId: approver.id })
      .returning();
    try {
      // a write-only rule leaves reads alone
      expect((await invoke(owner, "read")).statusCode).toBe(200);
      const before = received.length;
      const note = `held-${k.RUN}`;
      const held = await invoke(owner, "write", { note });
      expect(held.statusCode, held.body).toBe(202);
      expect(held.json().decision).toMatchObject({ effect: "require_approval", ruleId: rule!.id });
      const approvalId = held.json().approvalId as string;
      const [row] = await k.db.select().from(approvals).where(eq(approvals.id, approvalId));
      expect(row).toMatchObject({ status: "pending", connectorId });
      expect(received.length).toBe(before);
      const decided = await k.req("POST", `/v1/approvals/${approvalId}/decide`, approver.auth, { decision: "approved" });
      expect(decided.statusCode, decided.body).toBeLessThan(300);
      const ran = await invoke(owner, "write", { note });
      expect(ran.statusCode, ran.body).toBe(200);
      expect(received.length).toBe(before + 1);
      // spent once: the same call is held again
      expect((await invoke(owner, "write", { note })).statusCode).toBe(202);
      expect(received.length).toBe(before + 1);
      // the rule binds its subject only
      expect((await invoke(other, "write")).statusCode).toBe(200);
    } finally {
      await k.db.delete(resourceApprovalRules).where(eq(resourceApprovalRules.id, rule!.id));
    }
  });
});

describe("ADR-0251 review #715 finding 1: every named approver signs", () => {
  const setDial = async (mode: "normal" | "require_approval") => {
    const r = await k.req("PUT", "/v1/execution/mode", k.BOOT, {
      mode,
      reason: `adr0251 finding 1: ${mode}`,
      ...(mode === "require_approval" ? { approverUserId: dialApprover.id } : {}),
    });
    expect(r.statusCode, r.body).toBeLessThan(300);
  };
  const decide = (id: string, who: Person) => k.req("POST", `/v1/approvals/${id}/decide`, who.auth, { decision: "approved" });

  it("a write held by the dial AND a rule with another approver runs only after BOTH approvers sign, then spends both", async () => {
    const [rule] = await k.db
      .insert(resourceApprovalRules)
      .values({ resourceType: "connector", connectorId, scope: "user", userId: owner.id, approverUserId: approver.id })
      .returning();
    await setDial("require_approval");
    try {
      const note = `two-approvers-${k.RUN}`;
      const before = received.length;
      // 1. the dial's consent is asked for first
      const first = await invoke(owner, "write", { note });
      expect(first.statusCode, first.body).toBe(202);
      const dialApproval = first.json().approvalId as string;
      expect((await k.db.select().from(approvals).where(eq(approvals.id, dialApproval)))[0]).toMatchObject({ approverUserId: dialApprover.id });
      expect((await decide(dialApproval, dialApprover)).statusCode).toBeLessThan(300);
      // 2. the dial's approver alone does NOT release it: the rule's approver is asked next
      const second = await invoke(owner, "write", { note });
      expect(second.statusCode, second.body).toBe(202);
      const ruleApproval = second.json().approvalId as string;
      expect(ruleApproval).not.toBe(dialApproval);
      expect((await k.db.select().from(approvals).where(eq(approvals.id, ruleApproval)))[0]).toMatchObject({ approverUserId: approver.id });
      expect(received.length).toBe(before);
      // the dial's approver cannot decide the rule's consent
      expect((await decide(ruleApproval, dialApprover)).statusCode).toBeGreaterThanOrEqual(400);
      expect(received.length).toBe(before);
      // 3. with both consents in hand the identical call runs once, and both are spent
      expect((await decide(ruleApproval, approver)).statusCode).toBeLessThan(300);
      const ran = await invoke(owner, "write", { note });
      expect(ran.statusCode, ran.body).toBe(200);
      expect(received.length).toBe(before + 1);
      const rows = await k.db.select().from(approvals).where(eq(approvals.connectorId, connectorId));
      expect(rows.find((r) => r.id === dialApproval)?.status).toBe("consumed");
      expect(rows.find((r) => r.id === ruleApproval)?.status).toBe("consumed");
      // 4. spent: the same call is held again
      expect((await invoke(owner, "write", { note })).statusCode).toBe(202);
      expect(received.length).toBe(before + 1);
    } finally {
      await setDial("normal");
      await k.db.delete(resourceApprovalRules).where(eq(resourceApprovalRules.id, rule!.id));
    }
  });
});

describe("ADR-0251 review #715 finding 3: a call's side rows do not spend a second rate-limit slot", () => {
  it("only the call's reservation takes a slot; its decision, PII-warning and guardrail audit rows never do", async () => {
    const [limit] = await k.db
      .insert(resourceRateLimits)
      .values({ resourceType: "connector", connectorId, scope: "user", userId: other.id, maxCalls: 100, windowSeconds: 3600 })
      .returning();
    try {
      const count = async () =>
        (await loadResourceRestrictions(k.db, { userId: other.id, resource: { type: "connector", id: connectorId, operation: "read" } })).rateLimits.find(
          (l) => l.id === limit!.id,
        )!.currentCount;
      const base = await count();
      const row = (detail: Record<string, unknown>, ruleId: string) =>
        k.db.insert(auditLog).values({ userId: other.id, objectType: "connector", objectId: connectorId, detail, effect: "allow", ruleId, ruleChain: [], reason: "adr0251 finding 3 fixture" });
      await row({ operation: "read", receiptClass: "decision" }, "g1");
      await row({ phase: "pii", pii: { mode: "warn" }, operation: "read", receiptClass: "decision" }, "pii-warned");
      await row({ phase: "guardrail", receiptClass: "decision" }, "guardrail-warned");
      // audit rows are evidence, not the counter (hard windows): none of them takes a slot
      expect(await count()).toBe(base);
      // one allowed call takes exactly one slot
      const d = await governedEvaluateResource(k.db, {
        userId: other.id,
        resource: { type: "connector", id: connectorId, operation: "read" },
        projectId: other.projectId,
        base: { effect: "allow", ruleId: "g", reason: "granted", ruleChain: [] },
        canQueue: true,
      });
      expect(d.effect).toBe("allow");
      expect(await count()).toBe(base + 1);
    } finally {
      await k.db.delete(resourceRateLimits).where(eq(resourceRateLimits.id, limit!.id));
    }
  });
});

describe("ADR-0251 hard windows: concurrent calls never overshoot a limit", () => {
  it("twenty calls decided at the same moment against a limit of five: exactly five are allowed and five slots taken", async () => {
    const solo = await k.person("hard-window");
    const [limit] = await k.db
      .insert(resourceRateLimits)
      .values({ resourceType: "connector", connectorId, scope: "user", userId: solo.id, maxCalls: 5, windowSeconds: 3600 })
      .returning();
    try {
      const decide = () =>
        governedEvaluateResource(k.db, {
          userId: solo.id,
          resource: { type: "connector", id: connectorId, operation: "read" },
          projectId: solo.projectId,
          base: { effect: "allow", ruleId: "g", reason: "granted", ruleChain: [] },
          canQueue: true,
        });
      const out = await Promise.all(Array.from({ length: 20 }, decide));
      expect(out.filter((d) => d.effect === "allow").length).toBe(5);
      const refused = out.filter((d) => d.effect === "deny");
      expect(refused.length).toBe(15);
      for (const d of refused) {
        expect(d.ruleId).toBe(limit!.id);
        expect(d.reason).toMatch(/rate limit reached .* 5\/5 calls in 3600s/);
      }
      const slots = await k.db.select().from(resourceRateReservations).where(eq(resourceRateReservations.userId, solo.id));
      expect(slots.length).toBe(5);
      expect(slots.every((r) => r.connectorId === connectorId && r.resourceType === "connector")).toBe(true);
    } finally {
      await k.db.delete(resourceRateLimits).where(eq(resourceRateLimits.id, limit!.id));
    }
  });

  it("a call with no binding limit writes no slot, yet a limit added later still counts it; a refused call takes no slot", async () => {
    const solo = await k.person("no-slot");
    const g = await k.req("POST", "/v1/grants/connectors", k.BOOT, { userId: solo.id, connectorId, mode: "readwrite" });
    expect(g.statusCode, g.body).toBeLessThan(300);
    const slots = async () => (await k.db.select().from(resourceRateReservations).where(eq(resourceRateReservations.userId, solo.id))).length;
    // a real call with no limit: one allowed decision row, no slot, no lock
    expect((await invoke(solo, "read")).statusCode).toBe(200);
    expect(await slots()).toBe(0);
    const [limit] = await k.db
      .insert(resourceRateLimits)
      .values({ resourceType: "connector", connectorId, scope: "user", userId: solo.id, maxCalls: 2, windowSeconds: 3600 })
      .returning();
    try {
      const count = async () =>
        (await loadResourceRestrictions(k.db, { userId: solo.id, resource: { type: "connector", id: connectorId, operation: "read" } })).rateLimits.find(
          (l) => l.id === limit!.id,
        )!.currentCount;
      // the limit added after the call counts it (from the audit trail, before the limit existed)
      expect(await count()).toBe(1);
      // refused by the attribution mandate before the rate step: no slot
      const refused = await governedEvaluateResource(k.db, {
        userId: solo.id,
        resource: { type: "connector", id: connectorId, operation: "read" },
        projectId: null,
        base: { effect: "allow", ruleId: "g", reason: "granted", ruleChain: [] },
        canQueue: true,
      });
      expect(refused.effect).toBe("deny");
      expect(await slots()).toBe(0);
      // the second call takes the last slot (reserved, and its decision row is not counted twice); the third is refused
      expect((await invoke(solo, "read")).statusCode).toBe(200);
      expect(await slots()).toBe(1);
      expect(await count()).toBe(2);
      const third = await invoke(solo, "read");
      expect(third.statusCode, third.body).toBe(403);
      expect(third.json().decision).toMatchObject({ effect: "deny", ruleId: limit!.id });
    } finally {
      await k.db.delete(resourceRateLimits).where(eq(resourceRateLimits.id, limit!.id));
    }
  });
});

describe("ADR-0251: an error inside the core is a deny", () => {
  it("returns governed-core-error when a load throws, never an allow", async () => {
    const broken = new Proxy(k.db, {
      get(target, prop, recv) {
        if (prop === "select") throw new Error("connection reset");
        return Reflect.get(target, prop, recv);
      },
    }) as Db;
    const d = await governedEvaluateResource(broken, {
      userId: owner.id,
      resource: { type: "connector", id: connectorId, operation: "read" },
      projectId: owner.projectId,
      base: { effect: "allow", ruleId: "g", reason: "granted", ruleChain: [] },
      canQueue: true,
    });
    expect(d).toMatchObject({ effect: "deny", ruleId: RESOURCE_RULE_IDS.coreError });
  });
});

describe("ADR-0251 differential: old and new connector decisions agree wherever the old path decided", () => {
  it("over grant mode x operation x object scope x dial mode, with no restriction rows and an attributed call", async () => {
    const modes: ExecutionMode[] = ["normal", "read_only", "halted", "require_approval"];
    const grantModes = [null, "read", "readwrite"] as const;
    const scopes = [null, ["inbox"], ["other"]] as const;
    let compared = 0;
    for (const execMode of modes)
      for (const grantMode of grantModes)
        for (const allowedObjects of scopes)
          for (const operation of ["read", "write"] as const)
            for (const queueable of [false, true]) {
              const old = evaluateConnector({
                userId: other.id,
                actor: null,
                execution: { mode: execMode, approverUserId: approver.id },
                connectorId,
                operation,
                object: "inbox",
                connectorGrants: grantMode
                  ? [{ id: "g1", userId: other.id, connectorId, mode: grantMode, allowedObjects: allowedObjects ? [...allowedObjects] : null }]
                  : [],
                ...(queueable ? { writeApprovalQueue: { approvedApprovalId: null } } : {}),
              });
              const now = await governedEvaluateResource(k.db, {
                userId: other.id,
                resource: { type: "connector", id: connectorId, operation },
                projectId: other.projectId,
                base: old,
                canQueue: true,
              });
              expect({ effect: now.effect, ruleId: now.ruleId, approver: now.approverUserId }, `${execMode}/${grantMode}/${allowedObjects}/${operation}/${queueable}`).toEqual({
                effect: old.effect,
                ruleId: old.ruleId,
                approver: old.approverUserId,
              });
              compared++;
            }
    expect(compared).toBe(4 * 3 * 3 * 2 * 2);
  });
});
