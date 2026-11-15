import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, auditLog, createDb, eq, pmAssignmentStarts, pmLinks, runMigrations, workflowInstances, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { assignmentTriggerFor } from "./pm-assignment.js";
import { relaxStepUpAround } from "./testing/step-up-posture.js";
import { removeEgressAllowEntry } from "./testing/egress-allow-cleanup.js";

/**
 * ADR-0317 (lane L6, gap G4): RegulAIt assignable from Jira and Azure Boards.
 *
 * Claims:
 *  1. Off by default: with no trigger, or a trigger that is off, an assignment to the agent starts nothing (the
 *     second case is audited). Turning it on is admin-only and a settings_relax step-up.
 *  2. The workflow runs AS the assigning user, never more: an unlinked (or disabled) actor, a delivery naming no
 *     actor and the agent acting on itself start nothing; the template is matched on the user's own roles; a
 *     project the user cannot charge refuses the start.
 *  3. Assignment (Jira changelog, Azure DevOps AssignedTo), an @mention, or a Jira Automation rule each start the
 *     workflow, once per work item; the instance is linked to the EXISTING item and the start is written back as a
 *     comment, and a later approval decision mirrors back through that link.
 *  4. Every outcome is in the audit trail.
 *
 * Fake Jira and Azure DevOps servers; live tenants are owner-gated. Shares one database; objects prefixed pma-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "pma-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const RUN = Date.now().toString(36);
const AGENT = `712020:pma-agent-${RUN}`;
const ALICE_JIRA = `5b10pma-alice-${RUN}`;
const BOB_JIRA = `5b10pma-bob-${RUN}`;
const CHANGE_TYPE = `pma-assign-${RUN}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let server: http.Server;
let base = "";
let allowHostId: string | undefined;
/** every write the fake PM tools received */
const received: Array<{ method: string; url: string; body: string }> = [];

let alice: { id: string; auth: { authorization: string } };
let approver: { id: string; auth: { authorization: string } };
let jiraSecret = "";
let jiraConn = `pma-jira-${RUN}`;
const adoConn = `pma-ado-${RUN}`;
let adoSecret = "";

async function makeUser(email: string) {
  const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email, displayName: email.split("@")[0] } });
  expect(u.statusCode, u.body).toBe(201);
  const k = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "t" } });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

let delivery = 0;
const jiraHook = (body: Record<string, unknown>, conn = jiraConn, secret = jiraSecret) =>
  app.inject({
    method: "POST",
    url: `/v1/pm/webhooks/${conn}?token=${secret}`,
    headers: { "content-type": "application/json", "x-atlassian-webhook-identifier": `pma-${RUN}-${++delivery}` },
    payload: JSON.stringify({ timestamp: Date.now(), ...body }),
  });
const assignIssue = (issueId: string, actor: string | null, extra: Record<string, unknown> = {}) =>
  jiraHook({
    webhookEvent: "jira:issue_updated",
    ...(actor ? { user: { accountId: actor } } : {}),
    issue: { id: issueId, key: `PMA-${issueId}`, fields: { summary: `item ${issueId}`, assignee: { accountId: AGENT } } },
    changelog: { items: [{ field: "assignee", fieldId: "assignee", from: null, to: AGENT }] },
    ...extra,
  });
const putTrigger = (payload: Record<string, unknown>, headers = AUTH, conn = jiraConn) =>
  app.inject({ method: "PUT", headers, url: `/v1/pm/connections/${conn}/assignment-trigger`, payload });
const triggerBody = (over: Record<string, unknown> = {}) => ({
  enabled: true, agentRef: AGENT, changeType: CHANGE_TYPE, environment: "pma-env", ...over,
});
const auditRows = (ruleId: string) => db.select().from(auditLog).where(eq(auditLog.ruleId, ruleId));

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "c".repeat(64) });

  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ method: req.method ?? "", url: req.url ?? "", body });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "1" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const allow = await relaxStepUpAround(db, () =>
    app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/egress-allow-hosts",
      payload: { host: "127.0.0.1", allowPrivateRanges: true, allowPlaintextHttp: true, note: "pm-assignment suite: fake Jira and ADO" },
    }),
  );
  expect(allow.statusCode, allow.body).toBe(201);
  allowHostId = allow.json().id as string;

  alice = await makeUser(`pma-alice-${RUN}@example.com`);
  approver = await makeUser(`pma-approver-${RUN}@example.com`);
  const tpl = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/workflows/templates",
    payload: {
      name: `pma-tpl-${RUN}`,
      definition: { workflow: `pma-${RUN}`, stages: [{ id: "intake", type: "trigger" }, { id: "pma_gate", type: "human_approval", approvers: [approver.id] }] },
    },
  });
  expect(tpl.statusCode, tpl.body).toBe(201);
  const rule = await app.inject({ method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules", payload: { templateId: tpl.json().id, changeType: CHANGE_TYPE } });
  expect(rule.statusCode, rule.body).toBe(201);

  const jira = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/pm/connections",
    payload: { name: jiraConn, provider: "jira", project: "PMA", baseUrl: `${base}/jira`, token: "bot@example.com:api-token" },
  });
  expect(jira.statusCode, jira.body).toBe(201);
  jiraSecret = jira.json().webhookSecret as string;
  const ado = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/pm/connections",
    payload: { name: adoConn, provider: "azure_devops", project: "Payments", baseUrl: `${base}/ado`, token: "ado-pat" },
  });
  expect(ado.statusCode, ado.body).toBe(201);
  adoSecret = ado.json().webhookSecret as string;
});

afterAll(async () => {
  (await removeEgressAllowEntry(app, AUTH, { id: allowHostId })).assertRemoved();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  app.server.closeAllConnections();
  await app.close();
});

describe("signal matching (pure)", () => {
  it("an explicit rule, then the assignee, then a mention; Azure DevOps compares case-insensitively", () => {
    expect(assignmentTriggerFor("jira", "A", { trigger: "automation" })).toBe("automation");
    expect(assignmentTriggerFor("jira", "A", { assignee: "A" })).toBe("assigned");
    expect(assignmentTriggerFor("jira", "A", { assignee: "a" })).toBeNull();
    expect(assignmentTriggerFor("jira", "A", { mentions: ["B", "A"] })).toBe("mentioned");
    expect(assignmentTriggerFor("azure_devops", "regulait@contoso.com", { assignee: "RegulAIt@Contoso.com" })).toBe("assigned");
    expect(assignmentTriggerFor("jira", "A", {})).toBeNull();
  });
});

describe("off by default", () => {
  it("with no trigger configured an assignment to the agent starts nothing", async () => {
    const r = await assignIssue("100", ALICE_JIRA);
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json()).toEqual({ matched: false });
  });

  it("enabling is admin-only and a step-up; set off, an assignment is audited and starts nothing", async () => {
    const nonAdmin = await putTrigger(triggerBody(), alice.auth);
    expect(nonAdmin.statusCode).toBe(403);
    const off = await putTrigger(triggerBody({ enabled: false }));
    expect(off.statusCode, off.body).toBe(200);
    const r = await assignIssue("101", ALICE_JIRA);
    expect(r.json().assignment).toEqual({ assignment: "disabled" });
    expect((await auditRows("pm-assignment-disabled")).some((a) => (a.detail as { externalId?: string }).externalId === "101")).toBe(true);
  });
});

describe("as the assigning user, never more", () => {
  beforeAll(async () => {
    const on = await relaxStepUpAround(db, () => putTrigger(triggerBody()));
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().trigger).toMatchObject({ enabled: true, agentRef: AGENT });
    // enabling is recorded as a relaxation, with the step-up that allowed it
    const [audited] = (await auditRows("pm-assignment-trigger-updated")).filter((a) => (a.detail as { relaxation?: boolean }).relaxation);
    expect(audited?.effect).toBe("deny");
    expect((audited?.detail as { stepUp?: string }).stepUp).toBeTruthy();
  });

  it("an actor no admin linked, and a delivery naming no actor, start nothing", async () => {
    const unlinked = await assignIssue("200", BOB_JIRA);
    expect(unlinked.json().assignment).toEqual({ assignment: "unmapped_actor" });
    const anonymous = await assignIssue("201", null);
    expect(anonymous.json().assignment).toEqual({ assignment: "no_actor" });
    const self = await assignIssue("202", AGENT);
    expect(self.json().assignment).toEqual({ assignment: "self" });
    const started = await db.select().from(pmAssignmentStarts).where(eq(pmAssignmentStarts.externalId, "200"));
    expect(started).toEqual([]);
  });

  it("identity links are admin-only; linking Alice makes her assignment start the workflow as her, once", async () => {
    const byUser = await app.inject({ method: "POST", headers: alice.auth, url: `/v1/pm/connections/${jiraConn}/identity-links`, payload: { externalUserId: ALICE_JIRA, userId: alice.id } });
    expect(byUser.statusCode).toBe(403);
    const link = await app.inject({ method: "POST", headers: AUTH, url: `/v1/pm/connections/${jiraConn}/identity-links`, payload: { externalUserId: ALICE_JIRA, userId: alice.id } });
    expect(link.statusCode, link.body).toBe(201);
    const dup = await app.inject({ method: "POST", headers: AUTH, url: `/v1/pm/connections/${jiraConn}/identity-links`, payload: { externalUserId: ALICE_JIRA, userId: alice.id } });
    expect(dup.statusCode).toBe(409);

    const before = received.length;
    const r = await assignIssue("300", ALICE_JIRA);
    expect(r.statusCode, r.body).toBe(202);
    const outcome = r.json().assignment as { assignment: string; instanceId: string; writeBack: string };
    expect(outcome).toMatchObject({ assignment: "started", writeBack: "commented" });

    const [instance] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, outcome.instanceId));
    expect(instance?.initiatorUserId).toBe(alice.id);
    const [linkRow] = await db
      .select()
      .from(pmLinks)
      .where(and(eq(pmLinks.objectType, "workflow_instance"), eq(pmLinks.objectId, outcome.instanceId)));
    expect(linkRow).toMatchObject({ externalId: "300", externalUrl: `${base}/jira/browse/PMA-300` });
    const comment = received.slice(before).find((w) => w.method === "POST" && w.url.endsWith("/issue/300/comment"));
    expect(comment?.body).toContain(outcome.instanceId);
    const [startedAudit] = (await auditRows("pm-assignment-started")).filter((a) => a.objectId === outcome.instanceId);
    expect(startedAudit).toMatchObject({ userId: alice.id, effect: "allow", objectType: "workflow" });

    // a later mention of the agent on the same item starts nothing new
    const mention = await jiraHook({
      webhookEvent: "comment_created",
      issue: { id: "300", key: "PMA-300" },
      comment: { body: `again [~accountid:${AGENT}]`, author: { accountId: ALICE_JIRA } },
    });
    expect(mention.json().assignment).toEqual({ assignment: "already_started", instanceId: outcome.instanceId });

    // the approval decision mirrors back onto the item through the link
    const queue = await app.inject({ method: "GET", headers: approver.auth, url: "/v1/approvals?status=pending" });
    const pending = (queue.json().approvals as Array<{ id: string; instanceId: string | null }>).find((a) => a.instanceId === outcome.instanceId);
    expect(pending).toBeDefined();
    const beforeDecide = received.length;
    const decide = await app.inject({ method: "POST", headers: approver.auth, url: `/v1/approvals/${pending!.id}/decide`, payload: { decision: "approved", reason: "looks right" } });
    expect(decide.statusCode, decide.body).toBe(200);
    const mirrored = received.slice(beforeDecide).find((w) => w.url.endsWith("/issue/300/comment"));
    expect(mirrored?.body).toContain("pma_gate");
  });

  it("a mention and a Jira Automation rule each start a workflow for their own item", async () => {
    const mention = await jiraHook({
      webhookEvent: "comment_created",
      issue: { id: "400", key: "PMA-400" },
      comment: { body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: AGENT } }] }] }, author: { accountId: ALICE_JIRA } },
    });
    expect(mention.json().assignment).toMatchObject({ assignment: "started" });
    const rule = await jiraHook({ webhookEvent: "regulait:assign", user: { accountId: ALICE_JIRA }, issue: { id: "401", key: "PMA-401", fields: { summary: "from a rule" } } });
    expect(rule.json().assignment).toMatchObject({ assignment: "started" });
    const [claim] = await db.select().from(pmAssignmentStarts).where(eq(pmAssignmentStarts.externalId, "401"));
    expect(claim?.trigger).toBe("automation");
  });

  it("a project Alice cannot charge refuses the start; a change type no rule matches starts nothing", async () => {
    const project = await app.inject({ method: "POST", headers: AUTH, url: "/v1/projects", payload: { name: `pma-closed-${RUN}` } });
    expect(project.statusCode, project.body).toBe(201);
    const member = await app.inject({ method: "POST", headers: AUTH, url: `/v1/projects/${project.json().id}/members`, payload: { userId: approver.id, role: "contributor" } });
    expect(member.statusCode, member.body).toBe(201);
    expect((await putTrigger(triggerBody({ projectId: project.json().id }))).statusCode).toBe(200);
    const refused = await assignIssue("500", ALICE_JIRA);
    expect(refused.json().assignment).toEqual({ assignment: "refused" });
    expect(await db.select().from(pmAssignmentStarts).where(eq(pmAssignmentStarts.externalId, "500"))).toEqual([]);

    expect((await putTrigger(triggerBody({ changeType: `pma-unmatched-${RUN}`, projectId: null }))).statusCode).toBe(200);
    const none = await assignIssue("501", ALICE_JIRA);
    expect(none.json().assignment).toEqual({ assignment: "no_workflow" });
    expect((await putTrigger(triggerBody({ projectId: null }))).statusCode).toBe(200);
  });

  it("unlinking Alice stops her assignments", async () => {
    const list = await app.inject({ method: "GET", headers: AUTH, url: `/v1/pm/connections/${jiraConn}/identity-links` });
    expect(list.statusCode).toBe(200);
    const mine = (list.json().links as Array<{ id: string; externalUserId: string }>).find((l) => l.externalUserId === ALICE_JIRA);
    const del = await app.inject({ method: "DELETE", headers: AUTH, url: `/v1/pm/connections/${jiraConn}/identity-links/${mine!.id}` });
    expect(del.statusCode).toBe(204);
    const r = await assignIssue("600", ALICE_JIRA);
    expect(r.json().assignment).toEqual({ assignment: "unmapped_actor" });
  });
});

describe("Azure Boards", () => {
  it("an AssignedTo change to the agent, by a linked user, starts the workflow and comments on the work item", async () => {
    const adoAgent = `RegulAIt.${RUN}@Contoso.com`;
    const on = await relaxStepUpAround(db, () => putTrigger(triggerBody({ agentRef: adoAgent }), AUTH, adoConn));
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().trigger.agentRef).toBe(adoAgent.toLowerCase());
    const link = await app.inject({ method: "POST", headers: AUTH, url: `/v1/pm/connections/${adoConn}/identity-links`, payload: { externalUserId: `Alice.${RUN}@Contoso.com`, userId: alice.id } });
    expect(link.statusCode, link.body).toBe(201);

    const before = received.length;
    const r = await app.inject({
      method: "POST",
      url: `/v1/pm/webhooks/${adoConn}`,
      headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`svc:${adoSecret}`).toString("base64")}` },
      payload: JSON.stringify({
        id: `pma-ado-${RUN}-1`, createdDate: new Date().toISOString(), eventType: "workitem.updated",
        resource: {
          workItemId: 77, revisedBy: { uniqueName: `alice.${RUN}@contoso.com` },
          fields: { "System.AssignedTo": { oldValue: "", newValue: `RegulAIt Agent <${adoAgent}>` } },
          revision: { id: 77, fields: { "System.Title": "Rotate keys" } },
        },
      }),
    });
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json().assignment).toMatchObject({ assignment: "started", writeBack: "commented" });
    expect(received.slice(before).some((w) => w.url.includes("/Payments/_apis/wit/workItems/77/comments"))).toBe(true);
  });
});
