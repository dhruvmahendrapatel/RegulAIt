/**
 * ADR-0173 batch 2b — CONNECTOR WRITES IN THE APPROVALS QUEUE.
 *
 * Under the execution dial's `require_approval` mode a connector write is
 * queued (it used to be refused), bound to its argument digest and policy
 * context exactly like an MCP approval, and spent ONCE by the identical call.
 * The connector is a `webhook` pointed at a local receiver that counts every
 * request: the only honest proof that a write did or did not execute.
 *
 * The dial and the egress allow-host are GLOBAL state (M-068): both are put
 * back in afterAll, and the dial after every test.
 */
import http from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, approvals, auditLog, builderAgents, eq, egressAllowHosts, orgSettings, sql } from "@regulait/db";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import { resolveToolbox } from "./builder-tools.js";
import { drainBackgroundWork } from "./background-work.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
// ADR-0181: the governance gates this suite would trip but does not test, relaxed by name
let restoreSb2Gates: () => Promise<void> = async () => {};

let k: BuilderKit;
let owner: Person;
let other: Person;
let stranger: Person;
let approver: Person;
let model = "";
let connectorId = "";
let connectorName = "";
let allowHostId = "";
let receiver: http.Server;
const received: string[] = [];

const setDial = async (mode: "normal" | "require_approval", approverUserId?: string) => {
  const r = await k.req("PUT", "/v1/execution/mode", k.BOOT, {
    mode,
    reason: `adr0173 connector approvals: ${mode}`,
    ...(mode === "require_approval" ? { approverUserId: approverUserId ?? approver.id } : {}),
  });
  expect(r.statusCode, r.body).toBeLessThan(300);
};
const invoke = (who: Person, payload: Record<string, unknown>, operation: "read" | "write" = "write") =>
  k.req("POST", `/v1/connectors/${connectorId}/invoke`, who.auth, { operation, object: "inbox", payload });
const decide = (approvalId: string, decision: "approved" | "denied", reason?: string) =>
  k.req("POST", `/v1/approvals/${approvalId}/decide`, approver.auth, { decision, ...(reason ? { reason } : {}) });
const approvalRow = async (id: string) => (await k.db.select().from(approvals).where(eq(approvals.id, id)))[0]!;

beforeAll(async () => {
  k = await builderKit("p2bl-conn");
  restoreSb2Gates = await relaxGovernanceGatesForTest(k.db, { mrmEnforced: false, dispatchAttributionRequired: false });
  owner = await k.person("owner");
  other = await k.person("other");
  stranger = await k.person("stranger");
  approver = await k.person("approver");
  model = await k.model("conn", { price: 1 });
  await k.grantModel(owner.id, model);

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
  const allowed = await k.req("POST", "/v1/egress-allow-hosts", k.BOOT, {
    host: "127.0.0.1",
    allowPrivateRanges: true,
    allowPlaintextHttp: true,
    note: `p2bl-conn-${k.RUN}`,
  });
  expect(allowed.statusCode, allowed.body).toBe(201);
  allowHostId = allowed.json().id as string;

  connectorName = `p2bl-hook-${k.RUN}`;
  const c = await k.req("POST", "/v1/connectors", k.BOOT, {
    name: connectorName,
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

afterEach(async () => {
  await setDial("normal");
});

afterAll(async () => {
  await k.req("PUT", "/v1/execution/mode", k.BOOT, { mode: "normal", reason: "adr0173 connector approvals: cleanup" });
  if (allowHostId) await k.db.delete(egressAllowHosts).where(eq(egressAllowHosts.id, allowHostId));
  receiver.closeAllConnections();
  await new Promise<void>((r) => receiver.close(() => r()));
  await restoreSb2Gates();
  await k.close();
});

describe("a connector write under the require_approval dial", () => {
  it("is QUEUED, not run: 202 with an approval bound to its digest, and an identical re-submit reuses it", async () => {
    await setDial("require_approval");
    const before = received.length;
    const r = await invoke(owner, { note: `queued-${k.RUN}` });
    expect(r.statusCode, r.body).toBe(202);
    const body = r.json();
    expect(body).toMatchObject({ status: "pending_approval", approvalKind: "approval_required" });
    expect(body.decision).toMatchObject({ effect: "require_approval", ruleId: "execution-require-approval" });
    expect(received.length).toBe(before);
    const row = await approvalRow(body.approvalId);
    expect(row).toMatchObject({
      objectType: "connector_call",
      connectorId,
      userId: owner.id,
      approverUserId: approver.id,
      status: "pending",
      approvalScope: "action",
      argumentsPreviewKind: "arguments_v1",
    });
    expect(row.argumentsDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(row.contextDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(row.argumentsPreview).toMatchObject({ operation: "write", object: "inbox", payload: { note: `queued-${k.RUN}` } });
    // the decision row carries the binding digests (ADR-0104 forensic half)
    const [audit] = await k.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, connectorId), eq(auditLog.effect, "require_approval")))
      .orderBy(sql`${auditLog.at} desc`)
      .limit(1);
    expect(audit!.detail).toMatchObject({ argumentsDigest: row.argumentsDigest, contextDigest: row.contextDigest });

    const again = await invoke(owner, { note: `queued-${k.RUN}` });
    expect(again.statusCode).toBe(202);
    expect(again.json().approvalId).toBe(body.approvalId);
    expect(received.length).toBe(before);
  });

  it("a READ is still refused under the dial (the hold is defined for writes)", async () => {
    await setDial("require_approval");
    const r = await invoke(owner, {}, "read");
    expect(r.statusCode).toBe(403);
    expect(r.json().decision).toMatchObject({ effect: "deny", ruleId: "execution-require-approval" });
  });

  it("entitlement comes first: an UNGRANTED write is denied and never offered the queue", async () => {
    await setDial("require_approval");
    const before = (await k.db.select().from(approvals).where(eq(approvals.userId, stranger.id))).length;
    const r = await invoke(stranger, { note: "nope" });
    expect(r.statusCode).toBe(403);
    expect(r.json().decision.effect).toBe("deny");
    expect((await k.db.select().from(approvals).where(eq(approvals.userId, stranger.id))).length).toBe(before);
  });

  it("approved -> the identical re-submit executes ONCE and spends the approval; a third submit queues afresh", async () => {
    await setDial("require_approval");
    const payload = { note: `once-${k.RUN}` };
    const approvalId = (await invoke(owner, payload)).json().approvalId as string;
    expect((await decide(approvalId, "approved")).statusCode).toBe(200);
    const before = received.length;
    // two identical re-submits racing for one consent
    const [a, b] = await Promise.all([invoke(owner, payload), invoke(owner, payload)]);
    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(received.length).toBe(before + 1);
    expect((await approvalRow(approvalId)).status).toBe("consumed");
    const loser = a.statusCode === 200 ? b : a;
    // the loser either lost the consume race or arrived after it and queued anew
    expect([409, 202]).toContain(loser.statusCode);
    if (loser.statusCode === 409) expect(loser.json().error).toBe("approval_consumed_race");
    // spent: the same call now needs a new sign-off
    const third = await invoke(owner, payload);
    expect(third.statusCode).toBe(202);
    expect(third.json().approvalId).not.toBe(approvalId);
    expect(received.length).toBe(before + 1);
  });

  it("binding mismatch: an approval for one payload (or one person) never releases another", async () => {
    await setDial("require_approval");
    const approvalId = (await invoke(owner, { note: `A-${k.RUN}` })).json().approvalId as string;
    expect((await decide(approvalId, "approved")).statusCode).toBe(200);
    const before = received.length;
    const changed = await invoke(owner, { note: `B-${k.RUN}` });
    expect(changed.statusCode).toBe(202);
    expect(changed.json().approvalId).not.toBe(approvalId);
    // another granted person sending the very same payload is not released either
    const someoneElse = await invoke(other, { note: `A-${k.RUN}` });
    expect(someoneElse.statusCode).toBe(202);
    expect(someoneElse.json().approvalId).not.toBe(approvalId);
    expect(received.length).toBe(before);
    expect((await approvalRow(approvalId)).status).toBe("approved");
  });

  it("a consent granted under another approver goes stale: superseded visibly and re-queued, nothing runs", async () => {
    await setDial("require_approval");
    const approvalId = (await invoke(owner, { note: `stale-${k.RUN}` })).json().approvalId as string;
    expect((await decide(approvalId, "approved")).statusCode).toBe(200);
    // the dial route writes nothing when the mode is unchanged: go through normal
    await setDial("normal");
    await setDial("require_approval", other.id);
    const before = received.length;
    const r = await invoke(owner, { note: `stale-${k.RUN}` });
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json()).toMatchObject({ approvalKind: "approval_context_stale", supersededApprovalIds: [approvalId] });
    expect((await approvalRow(approvalId)).status).toBe("superseded");
    expect((await approvalRow(r.json().approvalId)).approverUserId).toBe(other.id);
    expect(received.length).toBe(before);
  });

  it("under PII redact the queued preview is the redacted action in the shape the approval review reads, never the raw payload", async () => {
    const tag = `p2bl-redact-${k.RUN}`;
    expect((await k.req("POST", "/v1/compliance/profiles", k.BOOT, { tag, piiMode: "warn" })).statusCode).toBeLessThan(300);
    // internal test policy only (as connector-redaction.test.ts): the public mode is not offered
    await k.db.execute(sql`update compliance_profiles set pii_mode = 'redact' where tag = ${tag}`);
    const proj = await k.req("POST", "/v1/projects", k.BOOT, { name: tag, classifications: [tag] });
    expect(proj.statusCode, proj.body).toBe(201);
    const m = await k.req("POST", `/v1/projects/${proj.json().id}/members`, k.BOOT, { userId: owner.id, role: "contributor" });
    expect(m.statusCode, m.body).toBeLessThan(300);
    await setDial("require_approval");
    const RAW = `alice-${k.RUN}@example.test`;
    const r = await k.req("POST", `/v1/connectors/${connectorId}/invoke`, owner.auth, {
      operation: "write", object: "inbox", payload: { note: RAW }, projectId: proj.json().id,
    });
    expect(r.statusCode, r.body).toBe(202);
    const row = await approvalRow(r.json().approvalId);
    expect(row.argumentsPreviewKind).toBe("mcp_redacted_v1");
    const preview = row.argumentsPreview as { schemaDigest: string; prepared: { effectiveArguments: unknown; transformation: { mode: string } } };
    expect(preview.schemaDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.prepared.transformation.mode).toBe("redact");
    expect(preview.prepared.effectiveArguments).toMatchObject({ operation: "write", object: "inbox", payload: { note: "[EMAIL]" } });
    expect(JSON.stringify(row.argumentsPreview)).not.toContain(RAW);
  });

  it("denied -> the re-submit is queued again, never run", async () => {
    await setDial("require_approval");
    const approvalId = (await invoke(owner, { note: `deny-${k.RUN}` })).json().approvalId as string;
    expect((await decide(approvalId, "denied", "not today")).statusCode).toBe(200);
    const before = received.length;
    const r = await invoke(owner, { note: `deny-${k.RUN}` });
    expect(r.statusCode).toBe(202);
    expect(r.json().approvalId).not.toBe(approvalId);
    expect(received.length).toBe(before);
  });
});

describe("a builder turn's connector write pauses in the queue and resumes from the decision", () => {
  /** the operator turns the dial while the turn is in flight: after the model
   * asked for the tool (its agent message is written) and before the call */
  const dialFlipTrigger = async (agentId: string) => {
    const fn = `p2bl_flip_${k.RUN}`;
    await k.db.execute(sql.raw(`CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger AS $$ BEGIN
      IF NEW.role = 'agent' AND NEW.agent_id = '${agentId}' THEN
        UPDATE org_settings SET execution_mode = 'require_approval', execution_mode_reason = 'adr0173 test: dial turned mid-turn',
          execution_mode_approver_user_id = '${approver.id}';
      END IF; RETURN NEW; END $$ LANGUAGE plpgsql`));
    await k.db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${fn} ON builder_messages`));
    await k.db.execute(sql.raw(`CREATE TRIGGER ${fn} AFTER INSERT ON builder_messages FOR EACH ROW EXECUTE FUNCTION ${fn}()`));
    return async () => {
      await k.db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${fn} ON builder_messages`));
      await k.db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${fn}()`));
    };
  };
  const newAgent = async () => {
    const r = await k.req("POST", "/v1/builder/agents", owner.auth, {
      name: `Conn agent ${Math.random().toString(36).slice(2, 7)}`,
      connectionFormat: "shared",
      computerUse: false,
      modelAgentId: model,
      projectId: owner.projectId,
    });
    expect(r.statusCode, r.body).toBe(201);
    const agent = r.json().agent as { id: string };
    const t = await k.req("PUT", `/v1/builder/agents/${agent.id}/tools`, owner.auth, {
      tools: [{ kind: "connector", refId: connectorId, requiresApproval: false }],
    });
    expect(t.statusCode, t.body).toBe(200);
    const [row] = await k.db.select().from(builderAgents).where(eq(builderAgents.id, agent.id));
    const box = await resolveToolbox(k.db, row!, owner.id);
    return { id: agent.id, toolName: box.entries[0]!.name };
  };
  const ask = (agentId: string, toolName: string, note: string) => {
    const args = Buffer.from(JSON.stringify({ operation: "write", object: "inbox", payload: { note } })).toString("base64");
    return k.req("POST", `/v1/builder/agents/${agentId}/chat`, owner.auth, {
      message: `send it <<use-tool:${toolName}>> <<use-tool-args:${args}>>`,
    });
  };
  const thread = async (id: string) => (await k.req("GET", `/v1/builder/threads/${id}`, owner.auth)).json();
  const steps = (detail: { messages: Array<{ steps: any[] }> }) => detail.messages.flatMap((m) => m.steps);

  it("approved -> the identical write runs once (the bound approval is consumed)", async () => {
    const a = await newAgent();
    const drop = await dialFlipTrigger(a.id);
    try {
      const before = received.length;
      const r = await ask(a.id, a.toolName, `builder-ok-${k.RUN}`);
      expect(r.statusCode, r.body).toBe(200);
      const body = r.json();
      expect(body.pending).toMatchObject({ status: "pending_approval", approverName: `approver ${k.RUN}` });
      const approvalId = body.pending.approvalId as string;
      expect((await approvalRow(approvalId)).objectType).toBe("connector_call");
      expect(received.length).toBe(before);
      const d = await decide(approvalId, "approved");
      expect(d.statusCode, d.body).toBe(200);
      await drainBackgroundWork(k.db);
      expect(received.length).toBe(before + 1);
      expect(received.at(-1)).toContain(`builder-ok-${k.RUN}`);
      const step = steps(await thread(body.thread.id))[0];
      expect(step).toMatchObject({ kind: "connector", status: "done", approvalId });
      expect((await approvalRow(approvalId)).status).toBe("consumed");
    } finally {
      await drop();
    }
  });

  it("denied -> the model is told, and the write never runs", async () => {
    const a = await newAgent();
    const drop = await dialFlipTrigger(a.id);
    try {
      const before = received.length;
      const body = (await ask(a.id, a.toolName, `builder-deny-${k.RUN}`)).json();
      const d = await decide(body.pending.approvalId, "denied", "not this one");
      expect(d.statusCode, d.body).toBe(200);
      await drainBackgroundWork(k.db);
      const step = steps(await thread(body.thread.id))[0];
      expect(step).toMatchObject({ status: "denied", outcomeCode: "approval_denied" });
      expect(step.outcomeDetail).toContain("not this one");
      expect(received.length).toBe(before);
    } finally {
      await drop();
    }
  });

  it("an approval that no longer binds to the call is refused on resume, not run", async () => {
    const a = await newAgent();
    const drop = await dialFlipTrigger(a.id);
    try {
      const before = received.length;
      const body = (await ask(a.id, a.toolName, `builder-mismatch-${k.RUN}`)).json();
      await k.db.update(approvals).set({ argumentsDigest: "0".repeat(64) }).where(eq(approvals.id, body.pending.approvalId));
      const d = await decide(body.pending.approvalId, "approved");
      expect(d.statusCode, d.body).toBe(200);
      await drainBackgroundWork(k.db);
      const step = steps(await thread(body.thread.id))[0];
      expect(step).toMatchObject({ status: "refused", outcomeCode: "approval_binding_mismatch" });
      expect(received.length).toBe(before);
    } finally {
      await drop();
    }
  });

  it("cancelling the paused step supersedes its pending connector approval", async () => {
    const a = await newAgent();
    const drop = await dialFlipTrigger(a.id);
    try {
      const body = (await ask(a.id, a.toolName, `builder-cancel-${k.RUN}`)).json();
      const c = await k.req("POST", `/v1/builder/threads/${body.thread.id}/steps/${body.pending.stepId}/cancel`, owner.auth, {});
      expect(c.statusCode, c.body).toBe(200);
      expect((await approvalRow(body.pending.approvalId)).status).toBe("superseded");
      // and the superseded consent can no longer be decided
      expect((await decide(body.pending.approvalId, "approved")).statusCode).toBe(409);
    } finally {
      await drop();
    }
  });
});

describe("the dial is put back", () => {
  it("leaves the deployment at normal", async () => {
    const [row] = await k.db.select().from(orgSettings);
    expect(row!.executionMode).toBe("normal");
  });
});
