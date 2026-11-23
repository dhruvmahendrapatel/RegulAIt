/**
 * ADR-0364 (lane E45 S2) — robots: CRUD, the frozen version, the submit gate, review through the one approvals queue
 * (never by the author), publication as a first-party MCP tool with an approved definition pin, the toolbox option,
 * and retirement halting the tool. Runs on its own scratch database (approval decisions are append-only rows).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, approvalRules, eq, mcpDefinitionPins, rateLimits, mcpServers, mcpTools, robotRuns, robotSecrets, robots, robotVersions, sql, toolGrants } from "@regulait/db";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import { grantStepUpForTest, stepUpRequest } from "./testing/step-up-grant.js";
import { connectFirstPartyServer } from "./mcp-first-party.js";
import { unavailableRobotToolIds } from "./builder-access.js";
import { ROBOTS_SERVER_URL } from "./robots-mcp.js";
import { checkUpstreamDestination, guardedMcpConnect, McpUpstreamRefusedError } from "./mcp-egress.js";
import { PROJECT_HEADER } from "./project-header.js";

const SITE = "https://portal.example.com";
const script = (steps: unknown[]) => JSON.stringify({ steps });
const goodDraft = {
  source: "recorded",
  scriptFormat: "steps_v1",
  script: script([
    { op: "goto", url: `${SITE}/login` },
    { op: "fill", selector: "#user", input: "username" },
    { op: "fill", selector: "#pass", secret: "PORTAL_PASSWORD" },
    { op: "click", selector: "button[type=submit]" },
    { op: "read", selector: "#balance", output: "balance" },
  ]),
  inputSchema: { type: "object", properties: { username: { type: "string" } }, required: ["username"] },
  outputSchema: { type: "object", properties: { balance: { type: "string" } } },
  allowedSites: [SITE],
  secretBindings: [{ name: "PORTAL_PASSWORD", origin: SITE }],
};

let kit: BuilderKit;
let owner: Person;
let approver: Person;
let stranger: Person;
let adminAuthor: Person;
let slug: string;
let robotId: string;

describe.skipIf(!process.env.DATABASE_URL)("ADR-0364 S2 robots", () => {
  beforeAll(async () => {
    kit = await builderKit("rbt", { scratch: true });
    owner = await kit.person("owner");
    approver = await kit.person("approver");
    stranger = await kit.person("stranger");
    adminAuthor = await kit.person("admin", { admin: true });
    slug = `invoice_bot_${kit.RUN}`;
  }, 180_000);
  afterAll(async () => kit?.close());

  /** a robot with one secret-free version, submitted for review (the S3 runner's passing test run inserted directly) */
  const submittedVersion = async (
    author: Person,
    opts: { submitter?: Person; editor?: Person; approverId?: string } = {},
  ): Promise<{ robotId: string; versionId: string; approvalId: string; slug: string }> => {
    const s2 = `sod_${Math.random().toString(36).slice(2, 8)}_${kit.RUN}`;
    const r = await kit.req("POST", "/v1/robots", author.auth, { slug: s2, name: `SoD ${s2}` });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().robot.id as string;
    const draft = { ...goodDraft, secretBindings: [], script: script([{ op: "goto", url: `${SITE}/` }]) };
    expect((await kit.req("POST", `/v1/robots/${id}/versions`, author.auth, draft)).statusCode).toBe(201);
    if (opts.editor) {
      const e = await kit.req("PUT", `/v1/robots/${id}/versions/1`, opts.editor.auth, { ...draft, script: script([{ op: "goto", url: `${SITE}/edited` }]) });
      expect(e.statusCode, e.body).toBe(200);
    }
    const submitter = opts.submitter ?? author;
    const gate = await kit.req("POST", `/v1/robots/${id}/versions/1/submit`, submitter.auth, { approverUserId: opts.approverId ?? approver.id });
    expect(gate.json().error, gate.body).toBe("robot_test_run_required");
    const [v] = await kit.db.select().from(robotVersions).where(eq(robotVersions.robotId, id));
    await kit.db.insert(robotRuns).values({ robotVersionId: v!.id, requestedBy: author.id, projectId: author.projectId, kind: "test", status: "succeeded", contentDigest: gate.json().contentDigest });
    const sub = await kit.req("POST", `/v1/robots/${id}/versions/1/submit`, submitter.auth, { approverUserId: opts.approverId ?? approver.id });
    expect(sub.statusCode, sub.body).toBe(202);
    const [after] = await kit.db.select().from(robotVersions).where(eq(robotVersions.id, v!.id));
    return { robotId: id, versionId: v!.id, approvalId: after!.approvalId!, slug: s2 };
  };
  const decide = (who: Person, approvalId: string, decision: "approved" | "denied", reason?: string) =>
    kit.app.inject({ method: "POST", url: `/v1/approvals/${approvalId}/decide`, headers: who.auth, payload: { decision, ...(reason ? { reason } : {}) } });
  /** run `fn` with the robot freeze triggers off, as a database-level tamper would (restored after) */
  const withFreezeOff = async (fn: () => Promise<void>) => {
    await kit.db.execute(sql`ALTER TABLE robot_versions DISABLE TRIGGER robot_versions_freeze`);
    try {
      await fn();
    } finally {
      await kit.db.execute(sql`ALTER TABLE robot_versions ENABLE TRIGGER robot_versions_freeze`);
    }
  };
  const mcp = (who: Person, serverId: string, method: string, params: Record<string, unknown> = {}) =>
    kit.app.inject({
      method: "POST",
      url: `/mcp/${serverId}`,
      headers: { ...who.auth, [PROJECT_HEADER]: who.projectId, "content-type": "application/json", accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 1, method, params },
    });

  const setSecret = async (who: Person, id: string, name: string, scope: "live" | "test", value: string) => {
    const g = await grantStepUpForTest(kit.db, who.id, { kind: "settings_relax", facts: { op: "robot_secret_set", robotId: id, name, scope } });
    const r = stepUpRequest(g);
    return kit.app.inject({ method: "PUT", url: `/v1/robots/${id}/secrets/${name}/${scope}`, headers: r.headers, cookies: r.cookies, payload: { value } });
  };

  it("the Robots server is seeded as the one first-party row", async () => {
    const rows = await kit.db.select().from(mcpServers).where(eq(mcpServers.url, ROBOTS_SERVER_URL));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.transport).toBe("first_party");
    // the CHECK ties the transport to the regulait: URL shape
    await expect(
      kit.db.execute(sql`INSERT INTO mcp_servers (name, url, transport) VALUES ('x', 'https://x.example.com/mcp', 'first_party')`),
    ).rejects.toThrow();
  });

  it("creates a robot; desktop is refused in S2, a taken slug is 409, a stranger gets 404", async () => {
    const desktop = await kit.req("POST", "/v1/robots", owner.auth, { slug: `${slug}_d`, name: "Desk", engine: "desktop" });
    expect(desktop.statusCode, desktop.body).toBe(422);
    expect(desktop.json().error).toBe("robot_engine_unavailable");
    const r = await kit.req("POST", "/v1/robots", owner.auth, { slug, name: "Invoice bot", description: "reads the balance" });
    expect(r.statusCode, r.body).toBe(201);
    robotId = r.json().robot.id;
    expect((await kit.req("POST", "/v1/robots", owner.auth, { slug, name: "again" })).statusCode).toBe(409);
    expect((await kit.req("GET", `/v1/robots/${robotId}`, stranger.auth)).statusCode).toBe(404);
    const list = await kit.req("GET", "/v1/robots", owner.auth);
    expect(list.json().items.map((x: { id: string }) => x.id)).toContain(robotId);
    expect((await kit.req("GET", "/v1/robots", stranger.auth)).json().items).toHaveLength(0);
  });

  it("refuses a non-https site, a goto off the allow-list and a non-steps format", async () => {
    const http = await kit.req("POST", `/v1/robots/${robotId}/versions`, owner.auth, { ...goodDraft, allowedSites: ["http://portal.example.com"], secretBindings: [] });
    expect(http.statusCode, http.body).toBe(422);
    const off = await kit.req("POST", `/v1/robots/${robotId}/versions`, owner.auth, {
      ...goodDraft,
      script: script([{ op: "goto", url: "https://elsewhere.example.com/" }]),
    });
    expect(off.statusCode, off.body).toBe(422);
    expect(off.json().error).toBe("robot_script_invalid");
    const ts = await kit.req("POST", `/v1/robots/${robotId}/versions`, owner.auth, { ...goodDraft, scriptFormat: "playwright_ts" });
    expect(ts.statusCode, ts.body).toBe(422);
    expect(ts.json().error).toBe("robot_script_format_unavailable");
  });

  it("drafts, edits, sets secrets (never returned), and gates submit on a passing test run", async () => {
    const d = await kit.req("POST", `/v1/robots/${robotId}/versions`, owner.auth, goodDraft);
    expect(d.statusCode, d.body).toBe(201);
    expect(d.json().version).toMatchObject({ version: 1, status: "draft", allowedSites: [SITE] });
    const e = await kit.req("PUT", `/v1/robots/${robotId}/versions/1`, owner.auth, { ...goodDraft, source: "uploaded" });
    expect(e.statusCode, e.body).toBe(200);

    // a secret write needs a step-up: an API key alone is refused
    const plain = await kit.req("PUT", `/v1/robots/${robotId}/secrets/PORTAL_PASSWORD/live`, owner.auth, { value: "correct-horse-battery" });
    expect(plain.statusCode).not.toBe(200);
    const noSecret = await kit.req("POST", `/v1/robots/${robotId}/versions/1/submit`, owner.auth, { approverUserId: approver.id });
    expect(noSecret.statusCode, noSecret.body).toBe(409);
    expect(noSecret.json().error).toBe("robot_secret_missing");

    const set = await setSecret(owner, robotId, "PORTAL_PASSWORD", "live", "correct-horse-battery");
    expect(set.statusCode, set.body).toBe(200);
    expect(set.body).not.toContain("correct-horse");
    const [stored] = await kit.db.select().from(robotSecrets).where(eq(robotSecrets.robotId, robotId));
    expect(stored!.valueCiphertext).not.toContain("correct-horse");
    const detail = await kit.req("GET", `/v1/robots/${robotId}`, owner.auth);
    expect(detail.body).not.toContain("correct-horse");
    expect(detail.json().secrets).toEqual([expect.objectContaining({ name: "PORTAL_PASSWORD", scope: "live", last4: "tery" })]);

    const noRun = await kit.req("POST", `/v1/robots/${robotId}/versions/1/submit`, owner.auth, { approverUserId: approver.id });
    expect(noRun.statusCode, noRun.body).toBe(409);
    expect(noRun.json().error).toBe("robot_test_run_required");
    const digest = noRun.json().contentDigest as string;
    expect(digest).toMatch(/^[0-9a-f]{64}$/);

    // a passing test run on a DIFFERENT digest does not count; on the exact one it does (the runner is S3's)
    const [v] = await kit.db.select().from(robotVersions).where(and(eq(robotVersions.robotId, robotId), eq(robotVersions.version, 1)));
    await kit.db.insert(robotRuns).values({ robotVersionId: v!.id, requestedBy: owner.id, projectId: owner.projectId, kind: "test", status: "succeeded", contentDigest: "0".repeat(64) });
    expect((await kit.req("POST", `/v1/robots/${robotId}/versions/1/submit`, owner.auth, { approverUserId: approver.id })).json().error).toBe("robot_test_run_required");
    await kit.db.insert(robotRuns).values({ robotVersionId: v!.id, requestedBy: owner.id, projectId: owner.projectId, kind: "test", status: "succeeded", contentDigest: digest });

    const self = await kit.req("POST", `/v1/robots/${robotId}/versions/1/submit`, owner.auth, { approverUserId: owner.id });
    expect(self.statusCode, self.body).toBe(403);
    const sub = await kit.req("POST", `/v1/robots/${robotId}/versions/1/submit`, owner.auth, { approverUserId: approver.id });
    expect(sub.statusCode, sub.body).toBe(202);
    expect(sub.json().version).toMatchObject({ status: "in_review", contentDigest: digest });
  });

  it("a submitted version is frozen, in the route and in the database", async () => {
    const e = await kit.req("PUT", `/v1/robots/${robotId}/versions/1`, owner.auth, goodDraft);
    expect(e.statusCode).toBe(409);
    expect(e.json().error).toBe("robot_version_frozen");
    const cause = (p: Promise<unknown>) => p.then(() => "no error", (e: { cause?: { message?: string } }) => e.cause?.message ?? String(e));
    expect(await cause(kit.db.execute(sql`UPDATE robot_versions SET script = '{}' WHERE robot_id = ${robotId} AND version = 1`))).toMatch(/frozen/);
    expect(
      await cause(
        kit.db.execute(sql`DELETE FROM robot_version_allowed_sites WHERE robot_version_id = (SELECT id FROM robot_versions WHERE robot_id = ${robotId} AND version = 1)`),
      ),
    ).toMatch(/frozen/);
  });

  it("the approver publishes it as a write tool with an approved definition pin", async () => {
    const [v] = await kit.db.select().from(robotVersions).where(and(eq(robotVersions.robotId, robotId), eq(robotVersions.version, 1)));
    const ok = await kit.app.inject({ method: "POST", url: `/v1/approvals/${v!.approvalId}/decide`, headers: approver.auth, payload: { decision: "approved" } });
    expect(ok.statusCode, ok.body).toBe(200);
    const [after] = await kit.db.select().from(robotVersions).where(eq(robotVersions.id, v!.id));
    expect(after!.status).toBe("approved");
    const [tool] = await kit.db.select().from(mcpTools).where(eq(mcpTools.id, after!.mcpToolId!));
    expect(tool).toMatchObject({ name: `robot_${slug}_v1`, kind: "write" });
    const [pin] = await kit.db
      .select()
      .from(mcpDefinitionPins)
      .where(and(eq(mcpDefinitionPins.serverId, tool!.serverId), eq(mcpDefinitionPins.name, tool!.name)));
    expect(pin!.approvedDigest).toBe(pin!.observedDigest);
    expect(pin!.approvedBy).toBe(approver.id);

    // the in-process server lists it; a connect with no governed call behind it never runs a robot (S3)
    const [server] = await kit.db.select().from(mcpServers).where(eq(mcpServers.url, ROBOTS_SERVER_URL));
    const client = (await connectFirstPartyServer(kit.db, server!, 5_000))!;
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name)).toContain(tool!.name);
      const called = await client.callTool({ name: tool!.name, arguments: { username: "a" } });
      expect(called.isError).toBe(true);
      expect(called.structuredContent).toMatchObject({ error: "robot-run-needs-project" });
    } finally {
      await client.close();
    }

    // the toolbox offers it, tagged as a robot, to a user entitled to it
    await kit.db.insert(toolGrants).values({ userId: owner.id, serverId: tool!.serverId, toolName: tool!.name });
    const opts = await kit.req("GET", "/v1/builder/toolbox-options", owner.auth);
    expect(opts.statusCode, opts.body).toBe(200);
    const option = opts.json().options.find((o: { refId: string }) => o.refId === tool!.id);
    expect(option).toMatchObject({ kind: "mcp_tool", source: "robot", robot: { robotId, version: 1, engine: "browser" } });
  });

  it("the author cannot decide their own version, even as an admin", async () => {
    const r = await kit.req("POST", "/v1/robots", adminAuthor.auth, { slug: `${slug}_a`, name: "Admin bot" });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().robot.id as string;
    const draft = { ...goodDraft, secretBindings: [], script: script([{ op: "goto", url: `${SITE}/` }]) };
    expect((await kit.req("POST", `/v1/robots/${id}/versions`, adminAuthor.auth, draft)).statusCode).toBe(201);
    const gate = await kit.req("POST", `/v1/robots/${id}/versions/1/submit`, adminAuthor.auth, { approverUserId: approver.id });
    const [v] = await kit.db.select().from(robotVersions).where(eq(robotVersions.robotId, id));
    await kit.db.insert(robotRuns).values({ robotVersionId: v!.id, requestedBy: adminAuthor.id, projectId: adminAuthor.projectId, kind: "test", status: "succeeded", contentDigest: gate.json().contentDigest });
    expect((await kit.req("POST", `/v1/robots/${id}/versions/1/submit`, adminAuthor.auth, { approverUserId: approver.id })).statusCode).toBe(202);
    const [sub] = await kit.db.select().from(robotVersions).where(eq(robotVersions.id, v!.id));
    const self = await kit.app.inject({
      method: "POST",
      url: `/v1/approvals/${sub!.approvalId}/decide`,
      headers: adminAuthor.auth,
      payload: { decision: "approved", reason: "admin override attempt on own robot" },
    });
    expect(self.statusCode, self.body).toBe(403);
    const [still] = await kit.db.select().from(robotVersions).where(eq(robotVersions.id, v!.id));
    expect(still!.status).toBe("in_review");
    // the named approver may still deny it
    const denied = await kit.app.inject({ method: "POST", url: `/v1/approvals/${sub!.approvalId}/decide`, headers: approver.auth, payload: { decision: "denied", reason: "no" } });
    expect(denied.statusCode, denied.body).toBe(200);
    const [rejected] = await kit.db.select().from(robotVersions).where(eq(robotVersions.id, v!.id));
    expect(rejected!.status).toBe("rejected");
  });

  it("governed path: tools/list and tools/call reach the Robots server through /mcp, entitlement-gated and audited", async () => {
    const [server] = await kit.db.select().from(mcpServers).where(eq(mcpServers.url, ROBOTS_SERVER_URL));
    const [v] = await kit.db.select().from(robotVersions).where(and(eq(robotVersions.robotId, robotId), eq(robotVersions.version, 1)));
    const [tool] = await kit.db.select().from(mcpTools).where(eq(mcpTools.id, v!.mcpToolId!));
    // a caller with no grant is offered nothing and is refused the call (default deny)
    const strangerList = await mcp(stranger, server!.id, "tools/list");
    expect(strangerList.statusCode, strangerList.body).toBe(200);
    expect(strangerList.body).not.toContain(tool!.name);
    const strangerCall = await mcp(stranger, server!.id, "tools/call", { name: tool!.name, arguments: { username: "a" } });
    expect(strangerCall.body).not.toContain("robot-run-needs-project");
    const denied = await kit.db.execute(
      sql`SELECT effect FROM audit_log WHERE server_id = ${server!.id} AND tool_name = ${tool!.name} AND user_id = ${stranger.id} ORDER BY at DESC LIMIT 1`,
    );
    expect((denied as unknown as { rows: Array<{ effect: string }> }).rows[0]?.effect).toBe("deny");
    // the entitled owner (tool grant from the toolbox test) sees it in tools/list, and the governed call passes the
    // decision path and reaches the server and its run controller
    const ownerList = await mcp(owner, server!.id, "tools/list");
    expect(ownerList.body).toContain(tool!.name);
    const ownerCall = await mcp(owner, server!.id, "tools/call", { name: tool!.name, arguments: { username: "a" } });
    expect(ownerCall.statusCode, ownerCall.body).toBe(200);
    // the governed decision allowed it, the proxy connected in-process with the call's context, and the run controller
    // refused before any sandbox: the owner's project has no budget (S3; the full run is the S3 e2e suite)
    expect(ownerCall.body).toContain("robot-run-needs-project");
    const decided = await kit.db.execute(
      sql`SELECT count(*)::int AS n FROM audit_log WHERE server_id = ${server!.id} AND tool_name = ${tool!.name} AND user_id = ${owner.id}`,
    );
    expect((decided as unknown as { rows: Array<{ n: number }> }).rows[0]!.n).toBeGreaterThan(0);

    // an approval rule on the robot tool sends the call through the approval gate before anything reaches the server
    // (under the shipped strict signing posture, with no approver holding a passkey, it is refused rather than queued)
    const [rule] = await kit.db
      .insert(approvalRules)
      .values({ scope: "user", userId: owner.id, serverScope: "server", serverId: server!.id, toolName: tool!.name, writeOnly: false, approverUserId: approver.id })
      .returning({ id: approvalRules.id });
    try {
      const held = await mcp(owner, server!.id, "tools/call", { name: tool!.name, arguments: { username: "held" } });
      expect(held.body).not.toContain("robot-run-needs-project");
      expect(held.body).toMatch(/approver/);
    } finally {
      await kit.db.delete(approvalRules).where(eq(approvalRules.id, rule!.id));
    }

    // a rate limit on the robot tool refuses the call past its window's budget
    const [limit] = await kit.db
      .insert(rateLimits)
      .values({ scope: "user", userId: owner.id, serverScope: "server", serverId: server!.id, toolName: tool!.name, maxCalls: 1, windowSeconds: 3600 })
      .returning({ id: rateLimits.id });
    try {
      await mcp(owner, server!.id, "tools/call", { name: tool!.name, arguments: { username: "one" } });
      const limited = await mcp(owner, server!.id, "tools/call", { name: tool!.name, arguments: { username: "two" } });
      expect(limited.body).not.toContain("robot-run-needs-project");
      expect(limited.body.toLowerCase()).toContain("rate");
    } finally {
      await kit.db.delete(rateLimits).where(eq(rateLimits.id, limit!.id));
    }
  });

  it("tools/call refuses a version whose stored content no longer matches its approved digest", async () => {
    const [server] = await kit.db.select().from(mcpServers).where(eq(mcpServers.url, ROBOTS_SERVER_URL));
    const [v] = await kit.db.select().from(robotVersions).where(and(eq(robotVersions.robotId, robotId), eq(robotVersions.version, 1)));
    const [tool] = await kit.db.select().from(mcpTools).where(eq(mcpTools.id, v!.mcpToolId!));
    const original = v!.script;
    await withFreezeOff(async () => {
      await kit.db.execute(sql`UPDATE robot_versions SET script = ${script([{ op: "goto", url: `${SITE}/tampered` }])} WHERE id = ${v!.id}`);
    });
    const client = (await connectFirstPartyServer(kit.db, server!, 5_000))!;
    try {
      const called = await client.callTool({ name: tool!.name, arguments: { username: "a" } });
      expect(called.isError).toBe(true);
      expect(called.structuredContent).toMatchObject({ error: "robot_version_digest_mismatch" });
    } finally {
      await client.close();
      await withFreezeOff(async () => {
        await kit.db.execute(sql`UPDATE robot_versions SET script = ${original} WHERE id = ${v!.id}`);
      });
    }
  });

  it("first_party is served only for a key on the fixed list; the egress path refuses it everywhere else", async () => {
    const [other] = await kit.db
      .insert(mcpServers)
      .values({ name: `other ${kit.RUN}`, url: `regulait:other_${kit.RUN}`, transport: "first_party" })
      .returning();
    const refused = await guardedMcpConnect(kit.db, other!).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(McpUpstreamRefusedError);
    expect((refused as McpUpstreamRefusedError).error).toBe("mcp_transport_disabled");
    const [robotsRow] = await kit.db.select().from(mcpServers).where(eq(mcpServers.url, ROBOTS_SERVER_URL));
    const direct = await checkUpstreamDestination(kit.db, robotsRow!).then(
      () => null,
      (e: unknown) => e,
    );
    expect(direct).toBeInstanceOf(McpUpstreamRefusedError);
    expect((direct as McpUpstreamRefusedError).error).toBe("mcp_transport_disabled");
  });

  it("separation of duties: an editor and a submitter are refused at decide time, even through the admin override", async () => {
    // the admin edits the owner's draft, then submits it: the admin wrote content AND put it forward
    const edited = await submittedVersion(owner, { editor: adminAuthor, submitter: adminAuthor });
    const asEditor = await decide(adminAuthor, edited.approvalId, "approved", "admin override on a version I edited");
    expect(asEditor.statusCode, asEditor.body).toBe(403);
    expect(asEditor.json().error ?? asEditor.json().detail?.error).toBeDefined();
    expect(asEditor.body).toContain("cannot_approve_own_robot_version");
    // the admin only submits a version the owner wrote: still refused as the submitter
    const submitted = await submittedVersion(owner, { submitter: adminAuthor });
    const asSubmitter = await decide(adminAuthor, submitted.approvalId, "approved", "admin override on a version I submitted");
    expect(asSubmitter.statusCode, asSubmitter.body).toBe(403);
    expect(asSubmitter.body).toContain("cannot_approve_own_robot_version");
    // naming an editor as approver is refused at submit
    const s3 = `sod_named_${kit.RUN}`;
    const r = await kit.req("POST", "/v1/robots", owner.auth, { slug: s3, name: "named" });
    const id = r.json().robot.id as string;
    const draft = { ...goodDraft, secretBindings: [], script: script([{ op: "goto", url: `${SITE}/` }]) };
    await kit.req("POST", `/v1/robots/${id}/versions`, owner.auth, draft);
    await kit.req("PUT", `/v1/robots/${id}/versions/1`, adminAuthor.auth, draft);
    const gate = await kit.req("POST", `/v1/robots/${id}/versions/1/submit`, owner.auth, { approverUserId: adminAuthor.id });
    const [nv] = await kit.db.select().from(robotVersions).where(eq(robotVersions.robotId, id));
    await kit.db.insert(robotRuns).values({ robotVersionId: nv!.id, requestedBy: owner.id, projectId: owner.projectId, kind: "test", status: "succeeded", contentDigest: gate.json().contentDigest });
    const named = await kit.req("POST", `/v1/robots/${id}/versions/1/submit`, owner.auth, { approverUserId: adminAuthor.id });
    expect(named.statusCode, named.body).toBe(403);
    expect(named.json().error).toBe("caller_cannot_approve");
    // the named approver (neither) still decides
    expect((await decide(approver, edited.approvalId, "denied", "no")).statusCode).toBe(200);
    expect((await decide(approver, submitted.approvalId, "denied", "no")).statusCode).toBe(200);
  });

  it("the named approver reads the version under review (and its full content is in the approval preview)", async () => {
    const pending = await submittedVersion(owner);
    const asApprover = await kit.req("GET", `/v1/robots/${pending.robotId}`, approver.auth);
    expect(asApprover.statusCode, asApprover.body).toBe(200);
    expect(asApprover.json().readAsReviewer).toBe(true);
    expect(asApprover.json().versions[0].script).toContain("goto");
    // only reading: the reviewer cannot edit or retire it
    expect((await kit.req("POST", `/v1/robots/${pending.robotId}/retire`, approver.auth)).statusCode).toBe(404);
    expect((await kit.req("GET", `/v1/robots/${pending.robotId}`, stranger.auth)).statusCode).toBe(404);
    const [a] = await kit.db.execute(sql`SELECT arguments_preview AS p FROM approvals WHERE id = ${pending.approvalId}`).then(
      (r) => (r as unknown as { rows: Array<{ p: Record<string, unknown> }> }).rows,
    );
    expect(a!.p).toMatchObject({ script: expect.stringContaining("goto"), inputSchema: expect.any(Object), toolDefinition: expect.objectContaining({ name: `robot_${pending.slug}_v1` }) });
    expect((await decide(approver, pending.approvalId, "denied", "no")).statusCode).toBe(200);
  });

  it("a decision on content changed under the approval is recorded stale and publishes nothing", async () => {
    const pending = await submittedVersion(owner);
    await withFreezeOff(async () => {
      await kit.db.execute(sql`UPDATE robot_versions SET script = ${script([{ op: "goto", url: `${SITE}/swapped` }])} WHERE id = ${pending.versionId}`);
    });
    const ok = await decide(approver, pending.approvalId, "approved");
    expect(ok.statusCode, ok.body).toBe(200);
    const [after] = await kit.db.select().from(robotVersions).where(eq(robotVersions.id, pending.versionId));
    expect(after!.status).toBe("rejected");
    expect(after!.mcpToolId).toBeNull();
    const stale = await kit.db.execute(sql`SELECT count(*)::int AS n FROM audit_log WHERE object_id = ${pending.versionId} AND rule_id = 'robot-version-stale'`);
    expect((stale as unknown as { rows: Array<{ n: number }> }).rows[0]!.n).toBe(1);
  });

  it("the database refuses moving a version back to draft (the freeze cannot be reopened)", async () => {
    const pending = await submittedVersion(owner);
    const cause = (p: Promise<unknown>) => p.then(() => "no error", (e: { cause?: { message?: string } }) => e.cause?.message ?? String(e));
    expect(await cause(kit.db.execute(sql`UPDATE robot_versions SET status = 'draft' WHERE id = ${pending.versionId}`))).toMatch(/cannot move/);
    const [v1] = await kit.db.select().from(robotVersions).where(and(eq(robotVersions.robotId, robotId), eq(robotVersions.version, 1)));
    expect(await cause(kit.db.execute(sql`UPDATE robot_versions SET status = 'draft' WHERE id = ${v1!.id}`))).toMatch(/cannot move/);
    expect((await decide(approver, pending.approvalId, "denied", "no")).statusCode).toBe(200);
  });

  it("a client cannot label a version agent_drafted, and the list answers the list contract", async () => {
    const r = await kit.req("POST", `/v1/robots/${robotId}/versions`, owner.auth, { ...goodDraft, source: "agent_drafted" });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json().error).toBe("robot_source_refused");
    const page = await kit.req("GET", "/v1/robots?limit=10&count=exact&robotStatus=active", owner.auth);
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json()).toMatchObject({ items: expect.any(Array), total: expect.any(Number) });
    expect((await kit.req("GET", "/v1/robots?nope=1", owner.auth)).statusCode).toBe(400);
  });

  it("retiring the version halts its tool and drops it from the toolbox; retiring the robot discards drafts", async () => {
    const [v] = await kit.db.select().from(robotVersions).where(and(eq(robotVersions.robotId, robotId), eq(robotVersions.version, 1)));
    const toolId = v!.mcpToolId!;
    // a stranger cannot retire it
    expect((await kit.req("POST", `/v1/robots/${robotId}/versions/1/retire`, stranger.auth)).statusCode).toBe(404);
    const r = await kit.req("POST", `/v1/robots/${robotId}/versions/1/retire`, owner.auth);
    expect(r.statusCode, r.body).toBe(200);
    const [tool] = await kit.db.select().from(mcpTools).where(eq(mcpTools.id, toolId));
    expect(tool!.haltedAt).not.toBeNull();
    expect([...(await unavailableRobotToolIds(kit.db, [toolId]))]).toEqual([toolId]);
    const opts = await kit.req("GET", "/v1/builder/toolbox-options", owner.auth);
    expect(opts.json().options.some((o: { refId: string }) => o.refId === toolId)).toBe(false);

    expect((await kit.req("POST", `/v1/robots/${robotId}/versions`, owner.auth, goodDraft)).statusCode).toBe(201);
    const rr = await kit.req("POST", `/v1/robots/${robotId}/retire`, owner.auth);
    expect(rr.statusCode, rr.body).toBe(200);
    const versions = await kit.db.select().from(robotVersions).where(eq(robotVersions.robotId, robotId));
    expect(versions.map((x) => x.status).sort()).toEqual(["rejected", "retired"]);
    const [robot] = await kit.db.select().from(robots).where(eq(robots.id, robotId));
    expect(robot!.status).toBe("retired");
    expect((await kit.req("GET", "/v1/robots", owner.auth)).json().items.find((x: { id: string }) => x.id === robotId).status).toBe("retired");
  });

  it("tools/call refuses a retired version", async () => {
    const [server] = await kit.db.select().from(mcpServers).where(eq(mcpServers.url, ROBOTS_SERVER_URL));
    const client = (await connectFirstPartyServer(kit.db, server!, 5_000))!;
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name)).not.toContain(`robot_${slug}_v1`);
      const called = await client.callTool({ name: `robot_${slug}_v1`, arguments: { username: "a" } });
      expect(called.isError).toBe(true);
      expect(called.structuredContent).toMatchObject({ error: "robot_version_not_approved" });
    } finally {
      await client.close();
    }
  });
});
