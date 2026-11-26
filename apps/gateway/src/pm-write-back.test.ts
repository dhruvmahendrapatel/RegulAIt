import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, auditLog, createDb, eq, pmWorkTriggers, pmWriteBacks, runMigrations, workflowInstances, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { runPmWriteBackSweep, syncPmWriteBacks } from "./pm-write-back.js";
import { removeEgressAllowEntry } from "./testing/egress-allow-cleanup.js";
import { relaxStepUpAround } from "./testing/step-up-posture.js";

/**
 * ADR-0356 PR 2 — a PM-triggered workflow's progress, written back to its work item.
 *
 * Claims, against a fake Jira:
 *  1. The start and the plan sign-off request are written back as soon as the trigger starts the workflow.
 *  2. A sign-off decision is written back once (the ADR-0010 mirror does not tell the item a second time), and the
 *     next stage's request follows.
 *  3. Every write-back is idempotent: re-running the reconcile (or the sweep) writes nothing new.
 *  4. A failed write-back is released and audited, and the next pass writes it.
 *  5. The pull request is written to the configured field and as a comment.
 *  6. The final outcome moves the item to the configured state, and the trigger to written_back.
 *
 * Shares one database with the other gateway suites; objects are prefixed pmwb-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "pmwb-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "b".repeat(64);
const RUN = Date.now();
const CONN = `pmwb-jira-${RUN}`;
const AGENT_ACCOUNT = "557058:pmwb-agent";
const CHANGE_TYPE = `pmwb-change-${RUN}`;
const ITEM = `wb-${RUN}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let server: http.Server;
let allowHostId: string;
let secret: string;
let instanceId: string;
let approverAuth: { authorization: string };
let aliceAuth: { authorization: string };
let failComments = false;
const comments: string[] = [];
const fieldUpdates: Array<Record<string, unknown>> = [];
const transitions: string[] = [];

const commentsMatching = (re: RegExp) => comments.filter((c) => re.test(c));

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });

  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      const m = /\/rest\/api\/2\/issue\/([^/]+)(\/comment|\/transitions)?$/.exec(req.url ?? "");
      if (!m || m[1] !== ITEM) return void res.writeHead(404).end("{}");
      if (m[2] === "/comment") {
        if (failComments) return void res.writeHead(503).end("{}");
        comments.push((JSON.parse(raw) as { body: string }).body);
        return void res.writeHead(201).end("{}");
      }
      if (m[2] === "/transitions") {
        if (req.method === "GET") return void res.end(JSON.stringify({ transitions: [{ id: "31", name: "Cancel", to: { name: "Cancelled" } }] }));
        transitions.push((JSON.parse(raw) as { transition: { id: string } }).transition.id);
        return void res.writeHead(204).end();
      }
      if (req.method === "PUT") {
        fieldUpdates.push((JSON.parse(raw) as { fields: Record<string, unknown> }).fields);
        return void res.writeHead(204).end();
      }
      res.end(JSON.stringify({ id: ITEM, key: "PMWB-1", fields: { summary: "Write-back item", description: "details", issuetype: { name: "Task" }, status: { name: "To Do" } } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/jira`;
  const allow = await relaxStepUpAround(db, () =>
    app.inject({ method: "POST", headers: AUTH, url: "/v1/egress-allow-hosts", payload: { host: "127.0.0.1", allowPrivateRanges: true, allowPlaintextHttp: true, note: "pm-write-back suite: fake Jira" } }),
  );
  expect(allow.statusCode, allow.body).toBe(201);
  allowHostId = allow.json().id as string;
  const c = await app.inject({ method: "POST", headers: AUTH, url: "/v1/pm/connections", payload: { name: CONN, provider: "jira", project: "PMWB", baseUrl: base, token: "bot@example.com:api-token" } });
  expect(c.statusCode, c.body).toBe(201);
  secret = c.json().webhookSecret as string;

  const mkUser = async (email: string) => {
    const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email, displayName: email.split("@")[0] } });
    const k = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "pmwb" } });
    return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
  };
  const alice = await mkUser(`pmwb-alice-${RUN}@example.com`);
  const approver = await mkUser(`pmwb-approver-${RUN}@example.com`);
  approverAuth = approver.auth;
  aliceAuth = alice.auth;
  const agent = await app.inject({ method: "POST", headers: AUTH, url: "/v1/agents", payload: { name: `pmwb-agent-${RUN}`, provider: "anthropic", tier: 1, modes: ["execute"] } });
  const agentId = agent.json().id as string;
  await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId: alice.id, agentId } });
  const tpl = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/workflows/templates",
    payload: { name: `pmwb-template-${RUN}`, definition: { workflow: "pmwb", stages: [
      { id: "intake", type: "trigger" },
      { id: "plan_signoff", type: "human_approval", approvers: [approver.id] },
      { id: "merge_gate", type: "human_approval", approvers: [approver.id] },
    ] } },
  });
  expect(tpl.statusCode, tpl.body).toBe(201);
  await app.inject({ method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules", payload: { templateId: tpl.json().id, changeType: CHANGE_TYPE } });
  const put = await app.inject({
    method: "PUT", headers: AUTH, url: `/v1/pm/connections/${CONN}/trigger-settings`,
    payload: {
      enabled: true, agentIdentities: [AGENT_ACCOUNT], agentId, change: { changeType: CHANGE_TYPE, environment: "dev" },
      writeBack: { prLink: { field: "customfield_10050" }, outcome: { states: { aborted: "Cancelled" } } },
    },
  });
  expect(put.statusCode, put.body).toBe(200);
  await app.inject({ method: "POST", headers: AUTH, url: "/v1/pm/identity-links", payload: { connectionName: CONN, pmUserId: "557058:pmwb-alice", email: `pmwb-alice-${RUN}@example.com` } });
});

afterAll(async () => {
  (await removeEgressAllowEntry(app, AUTH, { id: allowHostId })).assertRemoved();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("ADR-0356 PR 2 write-back", () => {
  it("writes the start and the plan sign-off request back as soon as the trigger starts the workflow", async () => {
    const body = JSON.stringify({
      webhookEvent: "jira:issue_updated", timestamp: Date.now(), user: { accountId: "557058:pmwb-alice" },
      issue: { id: ITEM }, changelog: { items: [{ fieldId: "assignee", to: AGENT_ACCOUNT }] },
    });
    const r = await app.inject({ method: "POST", url: `/v1/pm/webhooks/${CONN}?token=${encodeURIComponent(secret)}`, headers: { "content-type": "application/json" }, payload: body });
    expect(r.statusCode, r.body).toBe(202);
    instanceId = r.json().triggers[0].instanceId as string;
    expect(commentsMatching(/governed workflow started/)).toHaveLength(1);
    expect(commentsMatching(/Sign-off requested: stage 'plan_signoff'/)).toHaveLength(1);
  });

  it("is idempotent: another pass, and the sweep, write nothing new", async () => {
    const before = comments.length;
    const again = await syncPmWriteBacks(db, DATA_KEY, instanceId);
    expect(again?.written).toEqual([]);
    await runPmWriteBackSweep(db, { dataKey: DATA_KEY });
    expect(comments.length).toBe(before);
  });

  it("a sign-off decision is written back once, and the next stage's request follows", async () => {
    const view = await app.inject({ method: "GET", headers: approverAuth, url: `/v1/workflows/instances/${instanceId}` });
    const gate = (view.json().pendingApprovals ?? []).find((a: { stageId: string }) => a.stageId === "plan_signoff");
    expect(gate, view.body).toBeTruthy();
    const d = await app.inject({ method: "POST", headers: approverAuth, url: `/v1/approvals/${gate.id}/decide`, payload: { decision: "approved", reason: "plan is sound" } });
    expect(d.statusCode, d.body).toBe(200);
    expect(d.json().pmMirror ?? null).toBeNull(); // the ADR-0010 mirror skipped: the write-back told the item
    expect(commentsMatching(/sign-off 'plan_signoff' approved by .*: plan is sound/)).toHaveLength(1);
    expect(commentsMatching(/Sign-off requested: stage 'merge_gate'/)).toHaveLength(1);
  });

  it("a failed write-back is released and audited, and the next pass writes it", async () => {
    await db.update(workflowInstances).set({ context: { prUrl: "https://git.example/acme/app/pull/7" } }).where(eq(workflowInstances.id, instanceId));
    failComments = true;
    const failed = await syncPmWriteBacks(db, DATA_KEY, instanceId);
    expect(failed?.failed.map((f) => f.kind)).toEqual(["pr_link"]);
    const [t] = await db.select().from(pmWorkTriggers).where(eq(pmWorkTriggers.instanceId, instanceId));
    expect(await db.select().from(pmWriteBacks).where(and(eq(pmWriteBacks.triggerId, t!.id), eq(pmWriteBacks.kind, "pr_link")))).toEqual([]);
    const [a] = await db.select().from(auditLog).where(and(eq(auditLog.objectId, t!.id), eq(auditLog.ruleId, "pm-write-back-failed")));
    expect(a?.effect).toBe("deny");
    failComments = false;
    const ok = await syncPmWriteBacks(db, DATA_KEY, instanceId);
    expect(ok?.written.map((w) => w.kind)).toEqual(["pr_link"]);
    expect(commentsMatching(/Pull request: https:\/\/git\.example\/acme\/app\/pull\/7/)).toHaveLength(1);
    // the field was set on both attempts (the comment failed the first); setting a field to the same url is harmless
    expect(fieldUpdates.at(-1)).toEqual({ customfield_10050: "https://git.example/acme/app/pull/7" });
  });

  it("the final outcome moves the item to the configured state and the trigger to written_back", async () => {
    // the initiator (the linked person the trigger started it for) aborts it
    const ab = await app.inject({ method: "POST", headers: aliceAuth, url: `/v1/workflows/instances/${instanceId}/abort`, payload: {} });
    expect(ab.statusCode, ab.body).toBe(200);
    expect(transitions).toEqual(["31"]);
    expect(commentsMatching(/The workflow for this item was aborted/)).toHaveLength(1);
    const [t] = await db.select().from(pmWorkTriggers).where(eq(pmWorkTriggers.instanceId, instanceId));
    expect(t?.state).toBe("written_back");
    // done: nothing more is ever written for it
    expect(await syncPmWriteBacks(db, DATA_KEY, instanceId)).toBeNull();
  });
});
