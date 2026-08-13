/**
 * Demo-readiness must-fix e2e (findings 1, 2, 6):
 *
 *  1. Stale escalation approvals + atomic decide — a reassigned/retried node
 *     or a terminal run supersedes its open approvals in the same
 *     transaction as the event; deciding a superseded approval is a clean
 *     409 that persists NOTHING; a downstream invalid-state 409 rolls the
 *     decision itself back (the client never sees failure while the decision
 *     silently persisted).
 *
 *  2. PM mirror across provider restarts — the mock provider upserts writes
 *     against ids it has never seen (a demo double for a durable tool), so
 *     mirrors recorded by one process succeed in the next; 'Sync now'
 *     verifies every link live, repairs missing items in place, and orphans
 *     truly-dead links, which every future mirror then skips.
 *
 *  6. Separation-of-duties on self-review — an approval whose approver IS
 *     the requesting user is exposed as selfReview, requires a recorded
 *     reason to decide, and stamps the audit trail.
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { approvals, createDb, eq, runMigrations, type Db } from "@regulait/db";
import { MockPmProvider, resolvePmProvider } from "@regulait/pm-provider";
import { buildApp } from "./app.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "test-bootstrap-token-df";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let rexId: string; // initiator
let rexAuth: { authorization: string };
let adaId: string; // named escalation approver
let adaAuth: { authorization: string };
let workerId: string;

const mkUser = async (email: string, name: string): Promise<string> => {
  const r = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/users",
    payload: { email, displayName: name },
  });
  return r.json().id;
};
const authFor = async (userId: string): Promise<{ authorization: string }> => {
  const r = await app.inject({
    method: "POST", headers: AUTH, url: `/v1/users/${userId}/keys`,
    payload: { name: "df-key" },
  });
  return { authorization: `Bearer ${r.json().token}` };
};
const mkNode = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `task ${id}`,
  ownerAgentId: workerId,
  mode: "execute",
  estimate: { in: 10, out: 20 },
  ...extra,
});
const mkRun = async (name: string, nodes: unknown[]): Promise<string> => {
  const r = await app.inject({
    method: "POST", headers: rexAuth, url: "/v1/runs",
    payload: { graph: { run: name, escalationApproverUserId: adaId, nodes } },
  });
  expect(r.statusCode).toBe(201);
  return r.json().id;
};
const runEvent = (runId: string, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", headers: rexAuth, url: `/v1/runs/${runId}/events`, payload });
const approvalRow = async (
  auth: { authorization: string },
  match: (a: { runId: string | null; instanceId: string | null; stageId: string | null }) => boolean,
  status?: string,
) => {
  const q = await app.inject({
    method: "GET", headers: auth,
    url: `/v1/approvals${status ? `?status=${status}` : ""}`,
  });
  return q.json().approvals.find(match);
};

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "c".repeat(64) });

  rexId = await mkUser("df-rex@example.com", "Demo Rex");
  rexAuth = await authFor(rexId);
  adaId = await mkUser("df-ada@example.com", "Demo Ada");
  adaAuth = await authFor(adaId);

  const agent = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/agents",
    payload: {
      name: "df-worker", provider: "mock", tier: 0, modes: ["execute"],
      costPerMTokIn: 1, costPerMTokOut: 5, model: "mock-df",
    },
  });
  workerId = agent.json().id;
  await app.inject({
    method: "POST", headers: AUTH, url: "/v1/grants/agents",
    payload: { userId: rexId, agentId: workerId },
  });
});

afterAll(async () => {
  await app.close();
});

describe("finding 1: moot approvals are superseded, decide is atomic", () => {
  it("reassigning a node supersedes its pending escalation; deciding it is a clean 409 with nothing persisted", async () => {
    const runId = await mkRun("df-reassign", [mkNode("n1")]);
    await runEvent(runId, { kind: "start" });
    await runEvent(runId, { kind: "node_started", nodeId: "n1" });
    await runEvent(runId, { kind: "node_failed", nodeId: "n1", error: "worker crashed" });
    await runEvent(runId, { kind: "escalate_node", nodeId: "n1" });

    const pending = await approvalRow(adaAuth, (a) => a.runId === runId && a.stageId === "n1", "pending");
    expect(pending).toBeTruthy();
    expect(pending.selfReview).toBe(false); // rex asked, ada decides

    // the human fixes the problem another way: reassign (same owner is fine)
    const reassigned = await runEvent(runId, {
      kind: "reassign_node", nodeId: "n1", ownerAgentId: workerId,
    });
    expect(reassigned.statusCode).toBe(200);

    // the escalation is now moot — superseded, visible as such in the queue
    const superseded = await approvalRow(adaAuth, (a) => a.runId === runId, "superseded");
    expect(superseded).toBeTruthy();
    expect(superseded.id).toBe(pending.id);
    // …and it no longer shows on the run's pending gates
    const view = await app.inject({ method: "GET", headers: rexAuth, url: `/v1/runs/${runId}` });
    expect(view.json().pendingApprovals).toEqual([]);

    // deciding it refuses loudly and persists NOTHING
    const decided = await app.inject({
      method: "POST", headers: adaAuth, url: `/v1/approvals/${pending.id}/decide`,
      payload: { decision: "approved", reason: "trying anyway" },
    });
    expect(decided.statusCode).toBe(409);
    expect(decided.json().error).toBe("approval_superseded");
    const [row] = await db.select().from(approvals).where(eq(approvals.id, pending.id));
    expect(row!.status).toBe("superseded");
    expect(row!.decidedBy).toBeNull();
    expect(row!.decidedAt).toBeNull();
  });

  it("a run turning terminal supersedes every approval still open against it (abort AND completion)", async () => {
    // abort path: deny the escalation → the run aborts → nothing stays pending
    const abortRunId = await mkRun("df-abort", [mkNode("a"), mkNode("b")]);
    await runEvent(abortRunId, { kind: "start" });
    await runEvent(abortRunId, { kind: "node_started", nodeId: "a" });
    await runEvent(abortRunId, { kind: "node_failed", nodeId: "a", error: "boom" });
    await runEvent(abortRunId, { kind: "escalate_node", nodeId: "a" });
    const escalation = await approvalRow(adaAuth, (x) => x.runId === abortRunId, "pending");
    // a non-self approval needs no reason (the guard is scoped to self-review)
    const denied = await app.inject({
      method: "POST", headers: adaAuth, url: `/v1/approvals/${escalation.id}/decide`,
      payload: { decision: "denied" },
    });
    expect(denied.statusCode).toBe(200);
    expect(denied.json().status).toBe("denied");
    const aborted = await app.inject({ method: "GET", headers: rexAuth, url: `/v1/runs/${abortRunId}` });
    expect(aborted.json().run.status).toBe("aborted");

    // completion path: a measured-breach budget gate left pending while the
    // node kept going (the exact stale row the demo judge caught)
    const runId = await mkRun("df-complete", [mkNode("c")]);
    await runEvent(runId, { kind: "start" });
    await runEvent(runId, { kind: "node_started", nodeId: "c" });
    await runEvent(runId, { kind: "node_submitted", nodeId: "c" });
    await db.insert(approvals).values({
      userId: rexId,
      objectType: "run",
      runId,
      stageId: "__budget__:c",
      approverUserId: adaId,
    });
    const accepted = await runEvent(runId, { kind: "node_accepted", nodeId: "c" });
    expect(accepted.json().status).toBe("completed");

    const budgetGate = await approvalRow(adaAuth, (a) => a.runId === runId && a.stageId === "__budget__:c");
    expect(budgetGate.status).toBe("superseded");
    const decided = await app.inject({
      method: "POST", headers: adaAuth, url: `/v1/approvals/${budgetGate.id}/decide`,
      payload: { decision: "approved", reason: "too late" },
    });
    expect(decided.statusCode).toBe(409);
    expect(decided.json().error).toBe("approval_superseded");
  });

  it("a downstream invalid-state 409 rolls the decision back — the approval stays pending", async () => {
    const runId = await mkRun("df-atomic", [mkNode("d")]);
    await runEvent(runId, { kind: "start" });
    await runEvent(runId, { kind: "node_started", nodeId: "d" });
    await runEvent(runId, { kind: "node_submitted", nodeId: "d" });
    await runEvent(runId, { kind: "node_accepted", nodeId: "d" }); // → completed

    // a pending escalation-style row against the already-terminal run —
    // deciding it must fail AND leave the row untouched (one transaction)
    const [inserted] = await db
      .insert(approvals)
      .values({ userId: rexId, objectType: "run", runId, stageId: "d", approverUserId: adaId })
      .returning();
    const decided = await app.inject({
      method: "POST", headers: adaAuth, url: `/v1/approvals/${inserted!.id}/decide`,
      payload: { decision: "approved", reason: "should not stick" },
    });
    expect(decided.statusCode).toBe(409);
    expect(decided.json().error).toBe("invalid_run_state");

    const [row] = await db.select().from(approvals).where(eq(approvals.id, inserted!.id));
    expect(row!.status).toBe("pending"); // decision did NOT persist
    expect(row!.decidedBy).toBeNull();
    expect(row!.decisionReason).toBeNull();
  });
});

describe("finding 2: PM mirrors survive provider restarts; Sync now is honest", () => {
  const mock = resolvePmProvider({ provider: "mock", token: "" }) as MockPmProvider;
  let runId: string;

  it("links created before a provider 'restart' still mirror (upsert), and sync verifies/repairs honestly", async () => {
    const conn = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/pm/connections",
      payload: { name: "df-pm", provider: "mock", project: "DF-PROJ", token: "not-a-real-token" },
    });
    expect(conn.statusCode).toBe(201);

    runId = await mkRun("df-pm-run", [mkNode("api"), mkNode("docs")]);
    const synced = await app.inject({
      method: "POST", headers: rexAuth, url: `/v1/runs/${runId}/pm-sync`,
      payload: { connectionName: "df-pm" },
    });
    expect(synced.statusCode).toBe(201);
    expect(synced.json().created).toHaveLength(2);
    expect(synced.json().orphaned).toEqual([]);

    // simulate a gateway/provider restart: the in-memory store forgets everything
    mock.reset();

    // decision mirror against the run's parent item — succeeds via upsert
    const recorded = await app.inject({
      method: "POST", headers: rexAuth, url: "/v1/decisions",
      payload: { objectType: "run", objectId: runId, decision: "Ship the df feature behind a flag" },
    });
    expect(recorded.statusCode).toBe(201);
    expect(recorded.json().pmMirror).toMatchObject({ ok: true, action: "comment" });

    // node-status mirror — also an upsert against a forgotten id
    await runEvent(runId, { kind: "start" });
    const started = await runEvent(runId, { kind: "node_started", nodeId: "api" });
    expect(started.statusCode).toBe(200);
    expect(started.json().pmSync).toMatchObject({ ok: true, state: "Doing" });

    // Sync now: what the writes revived is VERIFIED, what is still missing is
    // REPAIRED in place (same external id), nothing is orphaned or duplicated
    const resync = await app.inject({
      method: "POST", headers: rexAuth, url: `/v1/runs/${runId}/pm-sync`,
      payload: { connectionName: "df-pm" },
    });
    expect(resync.statusCode).toBe(201);
    expect(resync.json().created).toEqual([]);
    expect(resync.json().orphaned).toEqual([]);
    expect(resync.json().verified.length + resync.json().repaired.length).toBe(3); // run parent + 2 nodes
    expect(resync.json().repaired.map((r: { nodeId: string | null }) => r.nodeId)).toContain("docs");
    // record another decision after the resync — still mirrors
    const again = await app.inject({
      method: "POST", headers: rexAuth, url: "/v1/decisions",
      payload: { objectType: "run", objectId: runId, decision: "Also update the runbook" },
    });
    expect(again.json().pmMirror).toMatchObject({ ok: true });
  });

  it("a truly-dead work item orphans its link; future mirrors and syncs skip it, never silently re-link", async () => {
    const links = await app.inject({ method: "GET", headers: rexAuth, url: `/v1/pm/links?runId=${runId}` });
    const docsLink = links.json().links.find((l: { nodeId: string | null }) => l.nodeId === "docs");
    expect(docsLink.orphanedAt).toBeNull();

    // the customer deletes the item in their tool (tombstoned — no upsert revives it)
    await mock.deleteWorkItem("DF-PROJ", docsLink.externalId);

    const sync = await app.inject({
      method: "POST", headers: rexAuth, url: `/v1/runs/${runId}/pm-sync`,
      payload: { connectionName: "df-pm" },
    });
    expect(sync.statusCode).toBe(201);
    expect(sync.json().orphaned).toHaveLength(1);
    expect(sync.json().orphaned[0]).toMatchObject({ nodeId: "docs", externalId: docsLink.externalId });
    expect(sync.json().created).toEqual([]); // never silently re-linked

    const after = await app.inject({ method: "GET", headers: rexAuth, url: `/v1/pm/links?runId=${runId}` });
    expect(after.json().links.find((l: { nodeId: string | null }) => l.nodeId === "docs").orphanedAt).not.toBeNull();

    // a status change on the orphaned node mirrors NOTHING (skipped, not failed)
    const started = await runEvent(runId, { kind: "node_started", nodeId: "docs" });
    expect(started.statusCode).toBe(200);
    expect(started.json().pmSync).toBeUndefined();

    // and the next sync reports it neither repaired nor re-orphaned nor created
    const sync2 = await app.inject({
      method: "POST", headers: rexAuth, url: `/v1/runs/${runId}/pm-sync`,
      payload: { connectionName: "df-pm" },
    });
    expect(sync2.json().created).toEqual([]);
    expect(sync2.json().orphaned).toEqual([]);
    expect(sync2.json().skipped).toContain("docs");
  });

  it("instance sync follows the same verify/repair/orphan contract", async () => {
    const tpl = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/templates",
      payload: {
        name: "df-inst-pm",
        definition: {
          workflow: "df-inst-pm",
          stages: [
            { id: "intake", type: "trigger" },
            { id: "signoff", type: "human_approval", approvers: [adaId] },
          ],
        },
      },
    });
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules",
      payload: { templateId: tpl.json().id, changeType: "df-inst-pm" },
    });
    const started = await app.inject({
      method: "POST", headers: rexAuth, url: "/v1/workflows/instances",
      payload: {
        change: { description: "df instance", paths: ["src/df.ts"], changeType: "df-inst-pm", environment: "staging" },
      },
    });
    const instanceId = started.json().id;

    const created = await app.inject({
      method: "POST", headers: rexAuth, url: `/v1/workflows/instances/${instanceId}/pm-sync`,
      payload: { connectionName: "df-pm" },
    });
    expect(created.statusCode).toBe(201);
    const externalId = created.json().externalId;

    // alive → verified
    const verified = await app.inject({
      method: "POST", headers: rexAuth, url: `/v1/workflows/instances/${instanceId}/pm-sync`,
      payload: { connectionName: "df-pm" },
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({ created: false, verified: true, externalId });

    // forgotten (restart) → repaired in place under the SAME id
    mock.reset();
    const repaired = await app.inject({
      method: "POST", headers: rexAuth, url: `/v1/workflows/instances/${instanceId}/pm-sync`,
      payload: { connectionName: "df-pm" },
    });
    expect(repaired.statusCode).toBe(200);
    expect(repaired.json()).toMatchObject({ created: false, repaired: true, externalId });

    // deleted in the tool → orphaned, and it STAYS orphaned
    await mock.deleteWorkItem("DF-PROJ", externalId);
    const orphaned = await app.inject({
      method: "POST", headers: rexAuth, url: `/v1/workflows/instances/${instanceId}/pm-sync`,
      payload: { connectionName: "df-pm" },
    });
    expect(orphaned.statusCode).toBe(200);
    expect(orphaned.json()).toMatchObject({ created: false, orphaned: true, externalId });
    const again = await app.inject({
      method: "POST", headers: rexAuth, url: `/v1/workflows/instances/${instanceId}/pm-sync`,
      payload: { connectionName: "df-pm" },
    });
    expect(again.json()).toMatchObject({ created: false, orphaned: true });
  });
});

describe("finding 6: self-review is exposed, reason-gated, and audited", () => {
  it("a self-submitted sign-off carries selfReview, 400s without a reason, and stamps the audit row with one", async () => {
    const tpl = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/templates",
      payload: {
        name: "df-selfreview",
        definition: {
          workflow: "df-selfreview",
          stages: [
            { id: "intake", type: "trigger" },
            { id: "requirements", type: "artifact_generation", output: "requirements_file" },
            { id: "signoff", type: "human_approval", approvers: ["requesting_user"] },
          ],
        },
      },
    });
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules",
      payload: { templateId: tpl.json().id, changeType: "df-self" },
    });
    const started = await app.inject({
      method: "POST", headers: rexAuth, url: "/v1/workflows/instances",
      payload: {
        change: { description: "rex's own change", paths: ["src/self.ts"], changeType: "df-self", environment: "staging" },
      },
    });
    const instanceId = started.json().id;
    await app.inject({
      method: "POST", headers: rexAuth, url: `/v1/workflows/instances/${instanceId}/artifacts`,
      payload: { stageId: "requirements", content: "# Requirements\n\n1. Rex signs off on Rex." },
    });

    // the sign-off is in rex's OWN inbox, flagged as a self-review
    const signoff = await approvalRow(rexAuth, (a) => a.instanceId === instanceId, "pending");
    expect(signoff).toBeTruthy();
    expect(signoff.approverUserId).toBe(rexId);
    expect(signoff.userId).toBe(rexId);
    expect(signoff.selfReview).toBe(true);

    // no reason → refused, still pending
    const bare = await app.inject({
      method: "POST", headers: rexAuth, url: `/v1/approvals/${signoff.id}/decide`,
      payload: { decision: "approved" },
    });
    expect(bare.statusCode).toBe(400);
    expect(bare.json().error).toBe("self_review_reason_required");
    const blank = await app.inject({
      method: "POST", headers: rexAuth, url: `/v1/approvals/${signoff.id}/decide`,
      payload: { decision: "approved", reason: "   " },
    });
    expect(blank.statusCode).toBe(400);
    const [still] = await db.select().from(approvals).where(eq(approvals.id, signoff.id));
    expect(still!.status).toBe("pending");

    // with a reason → decided, response flags it, instance advances
    const decided = await app.inject({
      method: "POST", headers: rexAuth, url: `/v1/approvals/${signoff.id}/decide`,
      payload: { decision: "approved", reason: "no other approver on this demo team; risk accepted" },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().selfReview).toBe(true);
    expect(decided.json().status).toBe("approved");
    const view = await app.inject({
      method: "GET", headers: rexAuth, url: `/v1/workflows/instances/${instanceId}`,
    });
    expect(view.json().instance.status).toBe("completed");

    // the audit trail carries the selfReview stamp
    const audit = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit?userId=${rexId}` });
    const stamped = audit.json().entries.find(
      (e: { ruleId: string; detail: { approvalId?: string } | null }) =>
        e.ruleId === "approval-self-review" && e.detail?.approvalId === signoff.id,
    );
    expect(stamped).toBeTruthy();
    expect(stamped.detail.selfReview).toBe(true);
    expect(stamped.reason).toContain("risk accepted");
  });

  // ADR-0022 delegation must not become the way AROUND finding 6. The guard
  // above compares the REQUESTER to the NAMED APPROVER, which says nothing
  // about who actually decided: an approver who delegates to the requester
  // hands them their own gate. Separation of duties is a property of the
  // decider, so the flag has to be too.
  it("a delegation back to the requester is still a self-review", async () => {
    const tpl = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/templates",
      payload: {
        name: "df-deleg-selfreview",
        definition: {
          workflow: "df-deleg-selfreview",
          stages: [
            { id: "intake", type: "trigger" },
            { id: "requirements", type: "artifact_generation", output: "requirements_file" },
            { id: "signoff", type: "human_approval", approvers: [adaId] },
          ],
        },
      },
    });
    expect(tpl.statusCode).toBe(201);
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules",
      payload: { templateId: tpl.json().id, changeType: "df-deleg-self" },
    });
    const started = await app.inject({
      method: "POST", headers: rexAuth, url: "/v1/workflows/instances",
      payload: {
        change: {
          description: "rex's change, ada's gate",
          paths: ["src/deleg.ts"],
          changeType: "df-deleg-self",
          environment: "staging",
        },
      },
    });
    expect(started.statusCode).toBe(201);
    const instanceId = started.json().id;
    await app.inject({
      method: "POST", headers: rexAuth, url: `/v1/workflows/instances/${instanceId}/artifacts`,
      payload: { stageId: "requirements", content: "# Requirements\n\n1. Ada is meant to sign this." },
    });

    // ada is the named approver and rex is the requester — NOT a self-review yet
    const signoff = await approvalRow(adaAuth, (a) => a.instanceId === instanceId, "pending");
    expect(signoff).toBeTruthy();
    expect(signoff.approverUserId).toBe(adaId);
    expect(signoff.userId).toBe(rexId);
    expect(signoff.selfReview).toBe(false);

    // ada delegates to rex — the requester now holds his own approval
    const now = Date.now();
    const deleg = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/delegations",
      payload: {
        fromUserId: adaId,
        toUserId: rexId,
        startsAt: new Date(now - 60_000).toISOString(),
        endsAt: new Date(now + 3_600_000).toISOString(),
        reason: "ada is out",
      },
    });
    expect(deleg.statusCode).toBe(201);

    // rex's inbox badges it before he can act on it — the warning has to be
    // visible at the point of decision, not only in the audit trail after
    const inRexInbox = await approvalRow(rexAuth, (a) => a.instanceId === instanceId, "pending");
    expect(inRexInbox).toBeTruthy();
    expect(inRexInbox.selfReview).toBe(true);
    expect(inRexInbox.delegatedFrom).toBeTruthy();
    // ...and stays an ordinary arm's-length gate for everyone else
    const inAdaInbox = await approvalRow(adaAuth, (a) => a.instanceId === instanceId, "pending");
    expect(inAdaInbox.selfReview).toBe(false);

    // rex deciding his own request is a self-review however he got there:
    // refused without a recorded reason
    const bare = await app.inject({
      method: "POST", headers: rexAuth, url: `/v1/approvals/${signoff.id}/decide`,
      payload: { decision: "approved" },
    });
    expect(bare.statusCode).toBe(400);
    expect(bare.json().error).toBe("self_review_reason_required");
    const [still] = await db.select().from(approvals).where(eq(approvals.id, signoff.id));
    expect(still!.status).toBe("pending");

    // with a reason it goes through, flagged, and stamped as both the
    // delegated decision it is and the self-review it also is
    const decided = await app.inject({
      method: "POST", headers: rexAuth, url: `/v1/approvals/${signoff.id}/decide`,
      payload: { decision: "approved", reason: "ada delegated to me before leaving; risk accepted" },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().selfReview).toBe(true);
    const audit = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit?userId=${rexId}` });
    const stampedRow = audit.json().entries.find(
      (e: { ruleId: string; detail: { approvalId?: string } | null }) =>
        e.ruleId === "approval-self-review" && e.detail?.approvalId === signoff.id,
    );
    expect(stampedRow).toBeTruthy();
  });
});
