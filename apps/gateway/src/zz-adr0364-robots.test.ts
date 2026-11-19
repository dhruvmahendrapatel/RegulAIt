/**
 * ADR-0364 (lane E45 S2) — robots: CRUD, the frozen version, the submit gate, review through the one approvals queue
 * (never by the author), publication as a first-party MCP tool with an approved definition pin, the toolbox option,
 * and retirement halting the tool. Runs on its own scratch database (approval decisions are append-only rows).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, mcpDefinitionPins, mcpServers, mcpTools, robotRuns, robotSecrets, robots, robotVersions, sql, toolGrants } from "@regulait/db";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import { grantStepUpForTest, stepUpRequest } from "./testing/step-up-grant.js";
import { connectFirstPartyServer } from "./mcp-first-party.js";
import { unavailableRobotToolIds } from "./builder-access.js";
import { ROBOTS_SERVER_URL } from "./robots-mcp.js";

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
    expect(list.json().robots.map((x: { id: string }) => x.id)).toContain(robotId);
    expect((await kit.req("GET", "/v1/robots", stranger.auth)).json().robots).toHaveLength(0);
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

    // the in-process server lists it, and refuses to run it until the S3 runner exists
    const [server] = await kit.db.select().from(mcpServers).where(eq(mcpServers.url, ROBOTS_SERVER_URL));
    const client = (await connectFirstPartyServer(kit.db, server!, 5_000))!;
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name)).toContain(tool!.name);
      const called = await client.callTool({ name: tool!.name, arguments: { username: "a" } });
      expect(called.isError).toBe(true);
      expect(called.structuredContent).toMatchObject({ error: "robot_runner_unavailable" });
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
    expect((await kit.req("GET", "/v1/robots", owner.auth)).json().robots.find((x: { id: string }) => x.id === robotId).status).toBe("retired");
  });
});
