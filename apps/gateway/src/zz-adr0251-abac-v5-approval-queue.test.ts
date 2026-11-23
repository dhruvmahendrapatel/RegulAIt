/**
 * ADR-0251 slice 4c — an ABAC v5 `require_approval` on a model dispatch HOLDS the call in the one approvals queue
 * (P-01c item 1), the consent bound to the policy version, instead of refusing it:
 *
 *  - the dispatch answers 202 `approval_pending`, naming the policy's approver; nothing is sent or billed;
 *  - the approver's consent releases the IDENTICAL call once; the next one is held again;
 *  - a new active version of the policy makes an approved consent stale (the call is held again, under a new row);
 *  - an approval rule beside the policy is a separate consent: its approver's consent never releases the ABAC hold;
 *  - a connector write is held and released the same way, and executes nothing while held (a local receiver counts).
 *
 * Runs on its OWN scratch database: active ABAC policies are global, and must not reach other suites.
 */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { relaxStepUpAround } from "./testing/step-up-posture.js";
import { removeEgressAllowEntry } from "./testing/egress-allow-cleanup.js";
import { abacPolicies, abacPolicyVersions, and, approvals, eq, resourceApprovalRules, usageEvents } from "@regulait/db";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxApprovalSigningForTest } from "./testing/approval-signing-posture.js";

let k: BuilderKit;
let restoreGates: () => Promise<void> = async () => {};
let restoreSigning: () => Promise<void> = async () => {};
let caller: Person;
let approver: Person;
let ruleApprover: Person;
let MODEL = "";
let connectorId = "";
let allowHostId = "";
let receiver: http.Server;
const received: string[] = [];

const MODEL_SOURCE = () => `forbid (principal == RegulAIt::User::"${caller.id}", action == RegulAIt::Action::"ModelInvoke", resource);`;
const CONNECTOR_SOURCE = () =>
  `forbid (principal == RegulAIt::User::"${caller.id}", action == RegulAIt::Action::"ConnectorCall", resource) when { resource.operation == "write" };`;

async function holdPolicy(source: () => string = MODEL_SOURCE): Promise<string> {
  const [policy] = await k.db.insert(abacPolicies).values({ name: `adr0251-s4c-${Math.random().toString(36).slice(2, 8)}`, enabled: true }).returning({ id: abacPolicies.id });
  await activateVersion(policy!.id, 1, source);
  return policy!.id;
}
async function activateVersion(policyId: string, version: number, source: () => string = MODEL_SOURCE): Promise<void> {
  const [v] = await k.db
    .insert(abacPolicyVersions)
    .values({ policyId, version, source: source(), schemaVersion: "v5", mode: "require_approval", approverUserId: approver.id })
    .returning({ id: abacPolicyVersions.id });
  await k.db.update(abacPolicies).set({ activeVersionId: v!.id }).where(eq(abacPolicies.id, policyId));
}
const dropPolicy = (id: string) => k.db.update(abacPolicies).set({ enabled: false, activeVersionId: null }).where(eq(abacPolicies.id, id));

const ask = (input: string) => k.req("POST", `/v1/agents/${MODEL}/invoke`, caller.auth, { mode: "chat", input, dispatch: true, projectId: caller.projectId });
const decide = (id: string, who: Person) => k.req("POST", `/v1/approvals/${id}/decide`, who.auth, { decision: "approved" });
const usage = async () => (await k.db.select({ id: usageEvents.id }).from(usageEvents).where(and(eq(usageEvents.userId, caller.id), eq(usageEvents.agentId, MODEL)))).length;
const row = async (id: string) => (await k.db.select().from(approvals).where(eq(approvals.id, id)))[0]!;

beforeAll(async () => {
  k = await builderKit("adr0251-s4c", { scratch: true });
  restoreGates = await relaxGovernanceGatesForTest(k.db, { mrmEnforced: false });
  restoreSigning = await relaxApprovalSigningForTest(k.db);
  caller = await k.person("caller");
  approver = await k.person("approver");
  ruleApprover = await k.person("rule-approver");
  MODEL = await k.model("s4c", { price: 1 });
  await k.grantModel(caller.id, MODEL);

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
    k.req("POST", "/v1/egress-allow-hosts", k.BOOT, { host: "127.0.0.1", allowPrivateRanges: true, allowPlaintextHttp: true, note: `adr0251-s4c-${k.RUN}` }),
  );
  expect(allowed.statusCode, allowed.body).toBe(201);
  allowHostId = allowed.json().id as string;
  const c = await k.req("POST", "/v1/connectors", k.BOOT, { name: `adr0251-s4c-hook-${k.RUN}`, kind: "notifications", providerKind: "webhook", baseUrl: `http://127.0.0.1:${port}/collect` });
  expect(c.statusCode, c.body).toBe(201);
  connectorId = c.json().id as string;
  const g = await k.req("POST", "/v1/grants/connectors", k.BOOT, { userId: caller.id, connectorId, mode: "readwrite" });
  expect(g.statusCode, g.body).toBeLessThan(300);
}, 120_000);

afterAll(async () => {
  const loopback = await removeEgressAllowEntry(k.app, k.BOOT, { id: allowHostId });
  try {
    await k.db.delete(resourceApprovalRules).where(eq(resourceApprovalRules.agentId, MODEL));
    await restoreSigning();
    receiver.closeAllConnections();
    await new Promise<void>((r) => receiver.close(() => r()));
    await restoreGates();
    await k.close();
  } finally {
    loopback.assertRemoved();
  }
});

describe("ADR-0251 slice 4c: an ABAC hold on a model dispatch is queued, bound to the policy version", () => {
  it("holds the call for the policy's approver, releases the identical call once, and holds the next", async () => {
    const id = await holdPolicy();
    try {
      const before = await usage();
      const held = await ask("s4c hold");
      expect(held.statusCode, held.body).toBe(202);
      expect(held.json()).toMatchObject({ error: "approval_pending" });
      const approvalId = held.json().approvalId as string;
      expect(await row(approvalId)).toMatchObject({ status: "pending", approverUserId: approver.id, objectType: "model_call" });
      expect(await usage()).toBe(before);
      // the caller cannot approve their own call
      expect((await decide(approvalId, caller)).statusCode).toBeGreaterThanOrEqual(400);
      expect((await decide(approvalId, approver)).statusCode).toBeLessThan(300);
      // a different payload is not released by this consent
      expect((await ask("s4c hold other")).statusCode).toBe(202);
      const ran = await ask("s4c hold");
      expect(ran.statusCode, ran.body).toBe(200);
      expect(await usage()).toBe(before + 1);
      expect(await row(approvalId)).toMatchObject({ status: "consumed" });
      const again = await ask("s4c hold");
      expect(again.statusCode).toBe(202);
      expect(again.json().approvalId).not.toBe(approvalId);
    } finally {
      await dropPolicy(id);
    }
  });

  it("a new active version of the policy makes an approved consent stale", async () => {
    const id = await holdPolicy();
    try {
      const held = await ask("s4c version");
      expect(held.statusCode, held.body).toBe(202);
      const approvalId = held.json().approvalId as string;
      expect((await decide(approvalId, approver)).statusCode).toBeLessThan(300);
      await activateVersion(id, 2);
      const after = await ask("s4c version");
      expect(after.statusCode, after.body).toBe(202);
      expect(after.json().approvalId).not.toBe(approvalId);
      expect((await row(approvalId)).status).not.toBe("consumed");
    } finally {
      await dropPolicy(id);
    }
  });

  it("an approval rule beside the policy is a separate consent: its approver cannot release the ABAC hold", async () => {
    const id = await holdPolicy();
    const [rule] = await k.db
      .insert(resourceApprovalRules)
      .values({ resourceType: "model", agentId: MODEL, scope: "user", userId: caller.id, approverUserId: ruleApprover.id })
      .returning();
    try {
      // the ABAC approver is asked first
      const first = await ask("s4c both");
      expect(first.statusCode, first.body).toBe(202);
      const abacApproval = first.json().approvalId as string;
      expect((await row(abacApproval)).approverUserId).toBe(approver.id);
      // the rule approver cannot sign the ABAC hold
      expect((await decide(abacApproval, ruleApprover)).statusCode).toBeGreaterThanOrEqual(400);
      expect((await decide(abacApproval, approver)).statusCode).toBeLessThan(300);
      // then the rule's approver is asked, on a row of its own
      const second = await ask("s4c both");
      expect(second.statusCode, second.body).toBe(202);
      const ruleApproval = second.json().approvalId as string;
      expect(ruleApproval).not.toBe(abacApproval);
      expect((await row(ruleApproval)).approverUserId).toBe(ruleApprover.id);
      expect((await decide(ruleApproval, ruleApprover)).statusCode).toBeLessThan(300);
      // with both consents in hand, the identical call runs once and spends both
      const ran = await ask("s4c both");
      expect(ran.statusCode, ran.body).toBe(200);
      expect((await row(abacApproval)).status).toBe("consumed");
      expect((await row(ruleApproval)).status).toBe("consumed");
    } finally {
      await k.db.delete(resourceApprovalRules).where(eq(resourceApprovalRules.id, rule!.id));
      await dropPolicy(id);
    }
  });
});

describe("ADR-0251 slice 4c: an ABAC hold on a connector write is queued and released the same way", () => {
  const invoke = (operation: "read" | "write", note: string) =>
    k.req("POST", `/v1/connectors/${connectorId}/invoke`, caller.auth, { operation, object: "inbox", payload: { note }, projectId: caller.projectId });

  it("holds the write (nothing sent), the approver's consent releases it once, and a read is not held", async () => {
    const id = await holdPolicy(CONNECTOR_SOURCE);
    try {
      const note = `s4c-conn-${k.RUN}`;
      const before = received.length;
      const held = await invoke("write", note);
      expect(held.statusCode, held.body).toBe(202);
      const approvalId = held.json().approvalId as string;
      expect(await row(approvalId)).toMatchObject({ status: "pending", approverUserId: approver.id, objectType: "connector_call" });
      expect(received.length).toBe(before);
      expect((await invoke("read", note)).statusCode).toBe(200);
      expect((await decide(approvalId, approver)).statusCode).toBeLessThan(300);
      const ran = await invoke("write", note);
      expect(ran.statusCode, ran.body).toBe(200);
      expect(await row(approvalId)).toMatchObject({ status: "consumed" });
      expect((await invoke("write", note)).statusCode).toBe(202);
    } finally {
      await dropPolicy(id);
    }
  });
});
