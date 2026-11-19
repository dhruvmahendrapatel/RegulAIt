/**
 * ADR-0364 (lane E45 S2) — THE FIRST-PARTY "RegulAIt Robots" MCP SERVER.
 *
 * Every approved robot version is one tool on this server, `robot_<slug>_v<N>`, so a robot reaches an agent through
 * the same governed MCP path as any other tool: the toolbox entry stays `{ kind: "mcp_tool", refId }`, and the call
 * goes through the proxy's entitlement, approval, rate-limit, cost and audit decisions before it gets here.
 *
 * The server runs in-process (the SDK's linked in-memory transport), so nothing leaves the gateway to list or call a
 * robot. It is reached only through `guardedMcpConnect`'s first-party branch, for the one row whose URL is
 * `regulait:robots` (`mcp-first-party.ts`).
 *
 * tools/list: the approved versions of active robots. tools/call: re-checks, at call time, that the version is still
 * approved, its robot active, its tool the one this version was approved as, and its stored content still hashes to
 * the digest the reviewer approved. S3: it then places one robot_browser run for the governed call (`robot-runs.ts`).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  and,
  approvals,
  asc,
  eq,
  mcpTools,
  robots,
  robotVersionAllowedSites,
  robotVersions,
  robotVersionSecrets,
  type Db,
  type RobotVersionRow,
} from "@regulait/db";
import { robotContentDigest, robotToolName } from "@regulait/shared";
import type { FirstPartyCallContext } from "./mcp-first-party.js";
import { startRobotRun, type RobotRunDeps } from "./robot-runs.js";

/** the run deps (the data key and the evidence store), set once at startup by `registerRobotRoutes` */
let runDeps: RobotRunDeps = { dataKey: undefined, store: null };
export function setRobotRunDeps(deps: RobotRunDeps): void {
  runDeps = deps;
}

/** the fixed URL of the one first-party Robots server row (seeded by the migration) */
export const ROBOTS_SERVER_URL = "regulait:robots";

/** the sites and bindings a version's digest covers, read from the join tables */
export async function robotVersionContent(db: Db, version: RobotVersionRow) {
  const sites = await db
    .select({ origin: robotVersionAllowedSites.origin })
    .from(robotVersionAllowedSites)
    .where(eq(robotVersionAllowedSites.robotVersionId, version.id))
    .orderBy(asc(robotVersionAllowedSites.origin));
  const bindings = await db
    .select({
      name: robotVersionSecrets.name,
      origin: robotVersionSecrets.origin,
      liveSecretId: robotVersionSecrets.liveSecretId,
      testSecretId: robotVersionSecrets.testSecretId,
    })
    .from(robotVersionSecrets)
    .where(eq(robotVersionSecrets.robotVersionId, version.id))
    .orderBy(asc(robotVersionSecrets.name));
  const allowedOrigins = sites.map((s) => s.origin);
  const digest = robotContentDigest({
    scriptFormat: version.scriptFormat,
    script: version.script,
    compiledSha256: version.compiledSha256,
    compilerVersion: version.compilerVersion,
    inputSchema: version.inputSchema,
    outputSchema: version.outputSchema,
    allowedOrigins,
    secretBindings: bindings.map((b) => ({ name: b.name, origin: b.origin, liveSecretId: b.liveSecretId })),
  });
  return { allowedOrigins, bindings, digest };
}

/** the MCP tool definition an approved version is published as */
export function robotToolDefinition(robot: { slug: string; name: string; description: string }, version: RobotVersionRow): Tool {
  return {
    name: robotToolName(robot.slug, version.version),
    description: `${robot.name} (robot, version ${version.version})${robot.description ? `: ${robot.description}` : ""}`,
    inputSchema: version.inputSchema as Tool["inputSchema"],
    outputSchema: version.outputSchema as Tool["outputSchema"],
    // a robot acts on a real site with real credentials: never read-only, never assumed idempotent
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  };
}

const refusal = (code: string, text: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text }],
  structuredContent: { error: code },
});

/**
 * build the in-process server; `serverId` is the Robots row's id (for the tool-row re-check), `call` the governed
 * call this connect serves (null for a manifest sync or a probe: tools/list works, tools/call refuses)
 */
export function createRobotsMcpServer(db: Db, serverId: string, call: FirstPartyCallContext = null): Server {
  const server = new Server({ name: "regulait-robots", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const rows = await db
      .select({ robot: robots, version: robotVersions })
      .from(robotVersions)
      .innerJoin(robots, eq(robots.id, robotVersions.robotId))
      .where(and(eq(robotVersions.status, "approved"), eq(robots.status, "active")))
      .orderBy(asc(robots.slug), asc(robotVersions.version));
    return { tools: rows.map((r) => robotToolDefinition(r.robot, r.version)) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const name = req.params.name;
    const [row] = await db
      .select({ robot: robots, version: robotVersions, tool: mcpTools, approvedDigest: approvals.argumentsDigest, approvalStatus: approvals.status })
      .from(robotVersions)
      .innerJoin(robots, eq(robots.id, robotVersions.robotId))
      .innerJoin(mcpTools, eq(mcpTools.id, robotVersions.mcpToolId))
      .leftJoin(approvals, eq(approvals.id, robotVersions.approvalId))
      .where(and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, name)));
    if (!row || row.robot.status !== "active" || row.version.status !== "approved") {
      return refusal("robot_version_not_approved", `'${name}' is not an approved robot version; nothing ran.`);
    }
    if (row.tool.haltedAt) {
      return refusal("robot_version_retired", `'${name}' is halted; nothing ran.`);
    }
    const content = await robotVersionContent(db, row.version);
    // the stored content must hash to BOTH the version's digest and the digest its approval was granted on, so a
    // database-level rewrite of the script and its digest together is still refused
    if (
      !row.version.contentDigest ||
      content.digest !== row.version.contentDigest ||
      row.approvedDigest !== row.version.contentDigest ||
      row.approvalStatus !== "approved"
    ) {
      return refusal(
        "robot_version_digest_mismatch",
        `'${name}' no longer matches the content its reviewer approved; nothing ran. Submit a new version for review.`,
      );
    }
    // ADR-0364 S3: the governed call places one robot_browser run. A connect with no call behind it never runs one.
    if (!call || !call.userId) {
      return refusal("robot-run-needs-project", `'${name}' runs only from a governed call attributed to a project; nothing ran.`);
    }
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const outcome = await startRobotRun(
      db,
      {
        robot: row.robot,
        version: row.version,
        kind: "agent",
        requestedBy: call.userId,
        projectId: call.projectId,
        inputs: args,
        agent: call.agent ?? null,
        parentGrantId: call.parentGrantId ?? null,
        interactivePerson: call.interactivePerson === true,
        builderAgentId: call.agent?.kind === "builder_agent" ? call.agent.id : null,
        contentDigest: row.version.contentDigest!,
      },
      runDeps,
    );
    if (outcome.kind === "refused") return refusal(outcome.code, outcome.message);
    if (outcome.status !== "succeeded" || !outcome.outputs) {
      return refusal(
        `robot_run_${outcome.status}`,
        `'${name}' ${outcome.status.replaceAll("_", " ")}${outcome.failureCode ? ` (${outcome.failureCode})` : ""}; run ${outcome.runId}.`,
      );
    }
    // §7: the outputs are page content — returned as untrusted tool output, validated against the output schema
    return {
      content: [{ type: "text", text: JSON.stringify(outcome.outputs) }],
      structuredContent: outcome.outputs,
      _meta: { "regulait/robotRunId": outcome.runId, "regulait/untrusted": true },
    };
  });

  return server;
}
