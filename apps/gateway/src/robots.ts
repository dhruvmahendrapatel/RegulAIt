/**
 * ADR-0364 (lane E45 S2) — GOVERNED RPA "ROBOTS": robots, versions, review and secrets.
 *
 * A robot is a named, owned automation; each version is a script plus the sites it may visit and the secrets it may
 * fill on them. A version is edited while it is a draft, then submitted for review through the one approvals queue
 * (object type `robot_version`), bound to the content digest of everything it will do. The approver is never its
 * author. On approval the version becomes one tool, `robot_<slug>_v<N>`, on the first-party Robots MCP server
 * (`robots-mcp.ts`), and from then on it reaches an agent through the governed MCP path like any other tool.
 * Retiring a version halts its tool; retiring a robot retires every version.
 *
 * S2 narrows the secure defaults further than the ADR's end state: the `browser` engine only, the `steps_v1`
 * script format only, and https named-host origins only. Submitting needs a passing test run on the exact digest,
 * and the sandbox runner that produces one arrives in S3, so in S2 nothing becomes approvable outside tests.
 *
 * Object-level authorisation: a robot, its versions and its secrets are read and written by the robot's owner or an
 * admin. Row-level security (migration `robots.sql`) enforces the same write rule underneath.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  and,
  approvals,
  asc,
  auditLog,
  builderAgentTools,
  count,
  desc,
  eq,
  inArray,
  mcpDefinitionPins,
  mcpServers,
  mcpTools,
  robotRuns,
  robots,
  robotSecrets,
  robotVersionAllowedSites,
  robotVersions,
  robotVersionSecrets,
  sql,
  users,
  type Db,
  type RobotRow,
  type RobotVersionRow,
} from "@regulait/db";
import {
  createRobotSchema,
  normaliseRobotOrigin,
  pinnableDefinition,
  ROBOT_ENGINES_AVAILABLE,
  ROBOT_LIMITS,
  ROBOT_MACHINE,
  ROBOT_SCRIPT_FORMATS_AVAILABLE,
  ROBOT_VERSION_MACHINE,
  robotContentDigest,
  robotListStatus,
  robotScriptSha256,
  robotToolName,
  robotVersionDraftSchema,
  setRobotSecretSchema,
  submitRobotVersionSchema,
  validateStepsScript,
  type RobotVersionDraft,
} from "@regulait/shared";
import { encryptSecret } from "./secrets.js";
import { loadOrgSettings } from "./org-settings.js";
import { afterCursorDesc, atTextSql, decodeCursor, encodeCursor } from "./pagination.js";
import { checkStepUp } from "./step-up.js";
import { whereFrom } from "./state-transition.js";
import { robotToolDefinition, robotVersionContent, ROBOTS_SERVER_URL } from "./robots-mcp.js";

type Viewer = { userId: string; isAdmin: boolean };
type Refusal = { status: number; body: Record<string, unknown> };

const robotParam = z.object({ robotId: z.string().uuid() });
const versionParam = z.object({ robotId: z.string().uuid(), version: z.coerce.number().int().min(1).max(100000) });
const secretParam = z.object({
  robotId: z.string().uuid(),
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
  scope: z.enum(["live", "test"]),
});
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().max(200).optional() });

function viewerOf(req: FastifyRequest, reply: FastifyReply): Viewer | null {
  const userId = req.authCtx.userId;
  if (!userId) {
    void reply.status(403).send({ error: "robots_require_identity", detail: "a robot is owned and reviewed by people; a token with no user identity cannot manage one" });
    return null;
  }
  return { userId, isAdmin: req.authCtx.isAdmin };
}

async function audit(
  db: Db,
  userId: string,
  objectType: "robot" | "robot_version" | "robot_secret",
  objectId: string,
  ruleId: string,
  reason: string,
  detail: Record<string, unknown> = {},
  effect: "allow" | "deny" | "require_approval" = "allow",
) {
  await db.insert(auditLog).values({ userId, objectType, objectId, detail, effect, ruleId, ruleChain: [], reason });
}

/** the robot, if the viewer may manage it (owner or admin); otherwise the reply is sent (404: never confirm it exists) */
async function managedRobot(db: Db, viewer: Viewer, robotId: string, reply: FastifyReply): Promise<RobotRow | null> {
  const [robot] = await db.select().from(robots).where(eq(robots.id, robotId));
  if (!robot || (!viewer.isAdmin && robot.ownerUserId !== viewer.userId)) {
    void reply.status(404).send({ error: "unknown_robot" });
    return null;
  }
  return robot;
}

async function versionOf(db: Db, robotId: string, version: number): Promise<RobotVersionRow | undefined> {
  const [row] = await db.select().from(robotVersions).where(and(eq(robotVersions.robotId, robotId), eq(robotVersions.version, version)));
  return row;
}

async function robotsServerId(db: Db): Promise<string | null> {
  const [row] = await db.select({ id: mcpServers.id }).from(mcpServers).where(eq(mcpServers.url, ROBOTS_SERVER_URL));
  return row?.id ?? null;
}

/**
 * Check a draft's content (S2 narrowing included). Returns the normalised allow-list and bindings, or the refusal.
 */
function checkDraft(robot: RobotRow, draft: RobotVersionDraft): { ok: true; origins: string[]; bindings: Array<{ name: string; origin: string }> } | { ok: false; refusal: Refusal } {
  if (!(ROBOT_ENGINES_AVAILABLE as readonly string[]).includes(robot.engine)) {
    return { ok: false, refusal: { status: 422, body: { error: "robot_engine_unavailable", detail: `the '${robot.engine}' engine is not available in this release` } } };
  }
  if (!(ROBOT_SCRIPT_FORMATS_AVAILABLE as readonly string[]).includes(draft.scriptFormat)) {
    return {
      ok: false,
      refusal: {
        status: 422,
        body: { error: "robot_script_format_unavailable", detail: `the '${draft.scriptFormat}' script format is not available yet: only ${ROBOT_SCRIPT_FORMATS_AVAILABLE.join(", ")}` },
      },
    };
  }
  if (Buffer.byteLength(draft.script, "utf8") > ROBOT_LIMITS.scriptBytes) {
    return { ok: false, refusal: { status: 413, body: { error: "robot_script_too_large", limitBytes: ROBOT_LIMITS.scriptBytes } } };
  }
  const origins: string[] = [];
  for (const site of draft.allowedSites) {
    const n = normaliseRobotOrigin(site);
    if (!n.ok) return { ok: false, refusal: { status: 422, body: { error: "robot_site_refused", site: site.slice(0, 300), detail: n.reason } } };
    if (!origins.includes(n.origin)) origins.push(n.origin);
  }
  const bindings: Array<{ name: string; origin: string }> = [];
  for (const b of draft.secretBindings) {
    const n = normaliseRobotOrigin(b.origin);
    if (!n.ok || !origins.includes(n.origin)) {
      return { ok: false, refusal: { status: 422, body: { error: "robot_secret_site_refused", secret: b.name, detail: "a secret is bound to exactly one of the version's own allowed sites" } } };
    }
    if (bindings.some((x) => x.name === b.name)) {
      return { ok: false, refusal: { status: 422, body: { error: "robot_secret_duplicate", secret: b.name } } };
    }
    bindings.push({ name: b.name, origin: n.origin });
  }
  const steps = validateStepsScript(draft.script, {
    allowedOrigins: origins,
    secretNames: bindings.map((b) => b.name),
    inputSchema: draft.inputSchema,
    outputSchema: draft.outputSchema,
  });
  if (!steps.ok) return { ok: false, refusal: { status: 422, body: { error: "robot_script_invalid", problems: steps.problems } } };
  return { ok: true, origins, bindings };
}

async function writeDraftChildren(tx: Db, versionId: string, robotId: string, origins: string[], bindings: Array<{ name: string; origin: string }>) {
  await tx.delete(robotVersionSecrets).where(eq(robotVersionSecrets.robotVersionId, versionId));
  await tx.delete(robotVersionAllowedSites).where(eq(robotVersionAllowedSites.robotVersionId, versionId));
  if (origins.length) await tx.insert(robotVersionAllowedSites).values(origins.map((origin) => ({ robotVersionId: versionId, origin })));
  if (bindings.length) {
    await tx.insert(robotVersionSecrets).values(bindings.map((b) => ({ robotVersionId: versionId, robotId, name: b.name, origin: b.origin })));
  }
}

async function versionView(db: Db, robot: RobotRow, v: RobotVersionRow, viewer: Viewer) {
  const content = await robotVersionContent(db, v);
  const [lastTest] = await db
    .select({ id: robotRuns.id, status: robotRuns.status, contentDigest: robotRuns.contentDigest, finishedAt: robotRuns.finishedAt })
    .from(robotRuns)
    .where(and(eq(robotRuns.robotVersionId, v.id), eq(robotRuns.kind, "test")))
    .orderBy(desc(robotRuns.createdAt))
    .limit(1);
  const isManager = viewer.isAdmin || robot.ownerUserId === viewer.userId;
  return {
    id: v.id,
    version: v.version,
    status: v.status,
    lifecycle: ROBOT_VERSION_MACHINE.describe(v.status, {
      ...(isManager ? {} : { submit: "only the robot's owner or an admin may submit it", retire: "only the robot's owner or an admin may retire it" }),
      approve: "decided in the approvals queue by a reviewer who is not the author",
      reject: "decided in the approvals queue by a reviewer who is not the author",
      discard: "a draft is discarded when its robot is retired",
    }),
    source: v.source,
    scriptFormat: v.scriptFormat,
    script: v.script,
    scriptSha256: v.scriptSha256,
    inputSchema: v.inputSchema,
    outputSchema: v.outputSchema,
    allowedSites: content.allowedOrigins,
    secretBindings: content.bindings.map((b) => ({ name: b.name, origin: b.origin, liveSecretBound: b.liveSecretId !== null })),
    contentDigest: v.contentDigest,
    /** what the content would hash to now, so a client can see a test run matches it before submitting */
    currentDigest: content.digest,
    authorUserId: v.authorUserId,
    approvalId: v.approvalId,
    toolName: v.mcpToolId ? robotToolName(robot.slug, v.version) : null,
    lastTestRun: lastTest ?? null,
    createdAt: v.createdAt,
    submittedAt: v.submittedAt,
    decidedAt: v.decidedAt,
  };
}

/** the digest a submit would bind, with live secrets resolved by name (null ids where a live secret is not set) */
async function resolvedDigest(db: Db, v: RobotVersionRow) {
  const content = await robotVersionContent(db, v);
  const live = content.bindings.length
    ? await db
        .select({ id: robotSecrets.id, name: robotSecrets.name })
        .from(robotSecrets)
        .where(and(eq(robotSecrets.robotId, v.robotId), eq(robotSecrets.scope, "live"), inArray(robotSecrets.name, content.bindings.map((b) => b.name))))
    : [];
  const test = content.bindings.length
    ? await db
        .select({ id: robotSecrets.id, name: robotSecrets.name })
        .from(robotSecrets)
        .where(and(eq(robotSecrets.robotId, v.robotId), eq(robotSecrets.scope, "test"), inArray(robotSecrets.name, content.bindings.map((b) => b.name))))
    : [];
  const bindings = content.bindings.map((b) => ({
    name: b.name,
    origin: b.origin,
    liveSecretId: live.find((s) => s.name === b.name)?.id ?? null,
    testSecretId: test.find((s) => s.name === b.name)?.id ?? null,
  }));
  const digest = robotContentDigest({
    scriptFormat: v.scriptFormat,
    script: v.script,
    compiledSha256: v.compiledSha256,
    compilerVersion: v.compilerVersion,
    inputSchema: v.inputSchema,
    outputSchema: v.outputSchema,
    allowedOrigins: content.allowedOrigins,
    secretBindings: bindings.map((b) => ({ name: b.name, origin: b.origin, liveSecretId: b.liveSecretId })),
  });
  return { digest, bindings, allowedOrigins: content.allowedOrigins };
}

/** halt a retired version's tool (ADR-0124's halt, which the execution posture already enforces on every call) */
async function haltVersionTool(tx: Db, v: RobotVersionRow, userId: string, reason: string) {
  if (!v.mcpToolId) return;
  await tx
    .update(mcpTools)
    .set({ haltedAt: sql`now()`, haltedReason: reason, haltedByUserId: userId })
    .where(and(eq(mcpTools.id, v.mcpToolId), sql`${mcpTools.haltedAt} IS NULL`));
}

export function registerRobotRoutes(app: FastifyInstance, db: Db, opts: { dataKey?: string | undefined } = {}): void {
  app.get("/v1/robots", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const q = listQuery.safeParse(req.query ?? {});
    if (!q.success) return reply.status(400).send({ error: "invalid_query" });
    const cursor = q.data.cursor ? decodeCursor(q.data.cursor) : null;
    if (q.data.cursor && !cursor) return reply.status(400).send({ error: "invalid_cursor" });
    const conds = [
      ...(viewer.isAdmin ? [] : [eq(robots.ownerUserId, viewer.userId)]),
      ...(cursor ? [afterCursorDesc(robots.createdAt, robots.id, cursor)] : []),
    ];
    const rows = await db
      .select({ robot: robots, at: atTextSql(robots.createdAt) })
      .from(robots)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(robots.createdAt), desc(robots.id))
      .limit(q.data.limit + 1);
    const page = rows.slice(0, q.data.limit);
    const ids = page.map((r) => r.robot.id);
    const versions = ids.length
      ? await db
          .select({ robotId: robotVersions.robotId, version: robotVersions.version, status: robotVersions.status, toolId: robotVersions.mcpToolId })
          .from(robotVersions)
          .where(inArray(robotVersions.robotId, ids))
      : [];
    const toolIds = versions.map((v) => v.toolId).filter((x): x is string => !!x);
    // "Used by N agents": distinct agents whose toolbox holds any of the robot's version tools (computed, never stored)
    const usage = toolIds.length
      ? await db
          .select({ refId: builderAgentTools.refId, agentId: builderAgentTools.agentId })
          .from(builderAgentTools)
          .where(and(eq(builderAgentTools.kind, "mcp_tool"), inArray(builderAgentTools.refId, toolIds)))
      : [];
    const items = page.map(({ robot }) => {
      const mine = versions.filter((v) => v.robotId === robot.id);
      const tools = new Set(mine.map((v) => v.toolId).filter((x): x is string => !!x));
      return {
        id: robot.id,
        slug: robot.slug,
        name: robot.name,
        description: robot.description,
        engine: robot.engine,
        ownerUserId: robot.ownerUserId,
        status: robotListStatus(robot.status, mine.map((v) => v.status)),
        latestVersion: mine.reduce((m, v) => Math.max(m, v.version), 0) || null,
        usedByAgents: new Set(usage.filter((u) => tools.has(u.refId)).map((u) => u.agentId)).size,
        createdAt: robot.createdAt,
      };
    });
    const last = rows.length > q.data.limit ? page[page.length - 1] : undefined;
    return { robots: items, nextCursor: last ? encodeCursor({ at: last.at, id: last.robot.id }) : null };
  });

  app.post("/v1/robots", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const parsed = createRobotSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request", issues: parsed.error.issues.slice(0, 20) });
    const body = parsed.data;
    if (!(ROBOT_ENGINES_AVAILABLE as readonly string[]).includes(body.engine)) {
      return reply.status(422).send({ error: "robot_engine_unavailable", detail: `the '${body.engine}' engine is not available in this release` });
    }
    const [taken] = await db.select({ id: robots.id }).from(robots).where(eq(robots.slug, body.slug));
    if (taken) return reply.status(409).send({ error: "robot_slug_taken", slug: body.slug });
    const robot = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [row] = await tx
        .insert(robots)
        .values({ slug: body.slug, name: body.name, description: body.description, engine: body.engine, ownerUserId: viewer.userId })
        .onConflictDoNothing({ target: robots.slug })
        .returning();
      if (!row) return null;
      await audit(tx, viewer.userId, "robot", row.id, "robot-created", `robot '${row.name}' (${row.slug}) created`, { slug: row.slug, engine: row.engine });
      return row;
    });
    if (!robot) return reply.status(409).send({ error: "robot_slug_taken", slug: body.slug });
    return reply.status(201).send({ robot: { ...robot, lifecycle: ROBOT_MACHINE.describe(robot.status) } });
  });

  app.get("/v1/robots/:robotId", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const { robotId } = robotParam.parse(req.params);
    const robot = await managedRobot(db, viewer, robotId, reply);
    if (!robot) return reply;
    const versions = await db.select().from(robotVersions).where(eq(robotVersions.robotId, robot.id)).orderBy(desc(robotVersions.version));
    const secrets = await db
      .select({ name: robotSecrets.name, scope: robotSecrets.scope, last4: robotSecrets.last4, setAt: robotSecrets.setAt, setBy: robotSecrets.setBy })
      .from(robotSecrets)
      .where(eq(robotSecrets.robotId, robot.id))
      .orderBy(asc(robotSecrets.name), asc(robotSecrets.scope));
    return {
      robot: {
        ...robot,
        status: robotListStatus(robot.status, versions.map((v) => v.status)),
        lifecycle: ROBOT_MACHINE.describe(robot.status),
      },
      versions: await Promise.all(versions.map((v) => versionView(db, robot, v, viewer))),
      // never the value: name, scope, last four and who set it when
      secrets,
    };
  });

  app.post("/v1/robots/:robotId/retire", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const { robotId } = robotParam.parse(req.params);
    const robot = await managedRobot(db, viewer, robotId, reply);
    if (!robot) return reply;
    const out = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [done] = await tx
        .update(robots)
        .set({ status: "retired", retiredAt: sql`now()` })
        .where(and(eq(robots.id, robot.id), whereFrom(robots.status, ROBOT_MACHINE, "retire")))
        .returning();
      if (!done) return null;
      const versions = await tx.select().from(robotVersions).where(eq(robotVersions.robotId, robot.id)).for("update");
      for (const v of versions) {
        if (v.status === "approved") {
          await haltVersionTool(tx, v, viewer.userId, `robot '${robot.slug}' retired`);
          await tx.update(robotVersions).set({ status: "retired", updatedAt: sql`now()` }).where(and(eq(robotVersions.id, v.id), whereFrom(robotVersions.status, ROBOT_VERSION_MACHINE, "retire")));
        } else if (v.status === "draft") {
          await tx.update(robotVersions).set({ status: "rejected", updatedAt: sql`now()` }).where(and(eq(robotVersions.id, v.id), whereFrom(robotVersions.status, ROBOT_VERSION_MACHINE, "discard")));
        } else if (v.status === "in_review") {
          await tx.update(robotVersions).set({ status: "rejected", decidedAt: sql`now()`, updatedAt: sql`now()` }).where(and(eq(robotVersions.id, v.id), whereFrom(robotVersions.status, ROBOT_VERSION_MACHINE, "reject")));
          // the pending review can no longer be decided: superseded, so nobody approves a retired robot
          if (v.approvalId) await tx.update(approvals).set({ status: "superseded" }).where(and(eq(approvals.id, v.approvalId), eq(approvals.status, "pending")));
        }
      }
      await audit(tx, viewer.userId, "robot", robot.id, "robot-retired", `robot '${robot.slug}' retired; its approved versions are halted`, {
        versions: versions.map((v) => ({ version: v.version, from: v.status })),
      });
      return done;
    });
    if (!out) return reply.status(409).send({ error: "robot_not_active", lifecycle: ROBOT_MACHINE.describe(robot.status) });
    return { robot: { ...out, lifecycle: ROBOT_MACHINE.describe(out.status) } };
  });

  app.post("/v1/robots/:robotId/versions", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const { robotId } = robotParam.parse(req.params);
    const robot = await managedRobot(db, viewer, robotId, reply);
    if (!robot) return reply;
    if (robot.status !== "active") return reply.status(409).send({ error: "robot_not_active" });
    const parsed = robotVersionDraftSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request", issues: parsed.error.issues.slice(0, 20) });
    const draft = parsed.data;
    const check = checkDraft(robot, draft);
    if (!check.ok) return reply.status(check.refusal.status).send(check.refusal.body);
    const row = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      // the robot row is the lock that orders version numbers
      await tx.select({ id: robots.id }).from(robots).where(eq(robots.id, robot.id)).for("update");
      const [{ max } = { max: 0 }] = await tx
        .select({ max: sql<number>`coalesce(max(${robotVersions.version}), 0)::int` })
        .from(robotVersions)
        .where(eq(robotVersions.robotId, robot.id));
      const [v] = await tx
        .insert(robotVersions)
        .values({
          robotId: robot.id,
          version: max + 1,
          source: draft.source,
          scriptFormat: draft.scriptFormat,
          script: draft.script,
          scriptSha256: robotScriptSha256(draft.script),
          inputSchema: draft.inputSchema,
          outputSchema: draft.outputSchema,
          authorUserId: viewer.userId,
        })
        .returning();
      await writeDraftChildren(tx, v!.id, robot.id, check.origins, check.bindings);
      await audit(tx, viewer.userId, "robot_version", v!.id, "robot-version-drafted", `robot '${robot.slug}' version ${v!.version} drafted`, {
        robotId: robot.id,
        version: v!.version,
        source: v!.source,
        scriptSha256: v!.scriptSha256,
        allowedSites: check.origins,
      });
      return v!;
    });
    return reply.status(201).send({ version: await versionView(db, robot, row, viewer) });
  });

  app.put("/v1/robots/:robotId/versions/:version", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const { robotId, version } = versionParam.parse(req.params);
    const robot = await managedRobot(db, viewer, robotId, reply);
    if (!robot) return reply;
    const v = await versionOf(db, robot.id, version);
    if (!v) return reply.status(404).send({ error: "unknown_robot_version" });
    if (v.status !== "draft") {
      return reply.status(409).send({ error: "robot_version_frozen", detail: "a version is edited only while it is a draft; draft a new version instead", lifecycle: ROBOT_VERSION_MACHINE.describe(v.status) });
    }
    const parsed = robotVersionDraftSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request", issues: parsed.error.issues.slice(0, 20) });
    const draft = parsed.data;
    const check = checkDraft(robot, draft);
    if (!check.ok) return reply.status(check.refusal.status).send(check.refusal.body);
    const row = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [u] = await tx
        .update(robotVersions)
        .set({
          source: draft.source,
          scriptFormat: draft.scriptFormat,
          script: draft.script,
          scriptSha256: robotScriptSha256(draft.script),
          inputSchema: draft.inputSchema,
          outputSchema: draft.outputSchema,
          updatedAt: sql`now()`,
        })
        .where(and(eq(robotVersions.id, v.id), eq(robotVersions.status, "draft")))
        .returning();
      if (!u) return null;
      await writeDraftChildren(tx, v.id, robot.id, check.origins, check.bindings);
      await audit(tx, viewer.userId, "robot_version", v.id, "robot-version-edited", `robot '${robot.slug}' version ${v.version} draft edited`, {
        robotId: robot.id,
        version: v.version,
        scriptSha256: u.scriptSha256,
        allowedSites: check.origins,
      });
      return u;
    });
    if (!row) return reply.status(409).send({ error: "robot_version_frozen" });
    return { version: await versionView(db, robot, row, viewer) };
  });

  app.post("/v1/robots/:robotId/versions/:version/submit", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const { robotId, version } = versionParam.parse(req.params);
    const robot = await managedRobot(db, viewer, robotId, reply);
    if (!robot) return reply;
    const parsed = submitRobotVersionSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request", issues: parsed.error.issues.slice(0, 20) });
    const v = await versionOf(db, robot.id, version);
    if (!v) return reply.status(404).send({ error: "unknown_robot_version" });
    if (robot.status !== "active") return reply.status(409).send({ error: "robot_not_active" });
    if (v.status !== "draft") return reply.status(409).send({ error: "robot_version_not_draft", lifecycle: ROBOT_VERSION_MACHINE.describe(v.status) });
    // the content is re-checked as stored, under the same S2 narrowing a draft write applies
    const recheck = checkDraft(robot, {
      source: v.source,
      scriptFormat: v.scriptFormat,
      script: v.script,
      inputSchema: v.inputSchema,
      outputSchema: v.outputSchema,
      allowedSites: (await robotVersionContent(db, v)).allowedOrigins,
      secretBindings: (await robotVersionContent(db, v)).bindings.map((b) => ({ name: b.name, origin: b.origin })),
    } as RobotVersionDraft);
    if (!recheck.ok) return reply.status(recheck.refusal.status).send(recheck.refusal.body);
    const resolved = await resolvedDigest(db, v);
    const missing = resolved.bindings.filter((b) => b.liveSecretId === null).map((b) => b.name);
    if (missing.length) {
      return reply.status(409).send({ error: "robot_secret_missing", secrets: missing, detail: "set each bound secret's live value before submitting" });
    }
    // ADR-0364 §3: a submit needs a passing test run on this exact content (the runner arrives in S3)
    const [passed] = await db
      .select({ id: robotRuns.id })
      .from(robotRuns)
      .where(and(eq(robotRuns.robotVersionId, v.id), eq(robotRuns.kind, "test"), eq(robotRuns.status, "succeeded"), eq(robotRuns.contentDigest, resolved.digest)))
      .limit(1);
    if (!passed) {
      return reply.status(409).send({
        error: "robot_test_run_required",
        contentDigest: resolved.digest,
        detail: "a version is submitted only after a test run of this exact content passed",
      });
    }
    const org = await loadOrgSettings(db);
    const approverUserId = parsed.data.approverUserId ?? org.infraApproverUserId ?? null;
    if (!approverUserId) {
      return reply.status(422).send({ error: "robot_approver_required", detail: "name approverUserId, or set a default approver in org settings" });
    }
    if (approverUserId === v.authorUserId || approverUserId === viewer.userId) {
      return reply.status(403).send({ error: "caller_cannot_approve", detail: "a robot version is reviewed by someone other than its author or submitter" });
    }
    const [approver] = await db.select({ id: users.id, disabledAt: users.disabledAt }).from(users).where(eq(users.id, approverUserId));
    if (!approver || approver.disabledAt) return reply.status(404).send({ error: "unknown_approver" });

    const out = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [locked] = await tx.select().from(robotVersions).where(eq(robotVersions.id, v.id)).for("update");
      if (!locked || locked.status !== "draft") return null;
      // bindings are resolved while the version is still a draft (the freeze trigger seals them after the submit)
      for (const b of resolved.bindings) {
        await tx
          .update(robotVersionSecrets)
          .set({ liveSecretId: b.liveSecretId, testSecretId: b.testSecretId })
          .where(and(eq(robotVersionSecrets.robotVersionId, v.id), eq(robotVersionSecrets.name, b.name)));
      }
      const again = await resolvedDigest(tx, locked);
      if (again.digest !== resolved.digest) return "changed" as const;
      const [a] = await tx
        .insert(approvals)
        .values({
          userId: viewer.userId,
          objectType: "robot_version",
          approverUserId,
          projectId: null,
          stageId: `robot-version:${v.id}`,
          argumentsDigest: resolved.digest,
          argumentsPreview: {
            robot: robot.slug,
            name: robot.name,
            version: v.version,
            engine: robot.engine,
            scriptFormat: v.scriptFormat,
            scriptSha256: v.scriptSha256,
            allowedSites: resolved.allowedOrigins,
            secrets: resolved.bindings.map((b) => ({ name: b.name, origin: b.origin })),
            testRunId: passed.id,
            toolName: robotToolName(robot.slug, v.version),
          },
          argumentsPreviewKind: "arguments_v1",
          approvalScope: "action",
          status: "pending",
          ...(org.approvalTtlHours != null ? { expiresAt: new Date(Date.now() + org.approvalTtlHours * 3_600_000) } : {}),
        })
        .returning({ id: approvals.id });
      const [u] = await tx
        .update(robotVersions)
        .set({ status: "in_review", contentDigest: resolved.digest, approvalId: a!.id, submittedAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(robotVersions.id, v.id), whereFrom(robotVersions.status, ROBOT_VERSION_MACHINE, "submit")))
        .returning();
      await audit(tx, viewer.userId, "robot_version", v.id, "robot-version-submitted", `robot '${robot.slug}' version ${v.version} submitted for review`, {
        robotId: robot.id,
        version: v.version,
        approvalId: a!.id,
        approverUserId,
        contentDigest: resolved.digest,
        testRunId: passed.id,
      }, "require_approval");
      return u!;
    });
    if (out === null) return reply.status(409).send({ error: "robot_version_not_draft" });
    if (out === "changed") return reply.status(409).send({ error: "robot_version_changed", detail: "the version's content changed while it was submitted; submit again" });
    return reply.status(202).send({ version: await versionView(db, robot, out, viewer) });
  });

  app.post("/v1/robots/:robotId/versions/:version/retire", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const { robotId, version } = versionParam.parse(req.params);
    const robot = await managedRobot(db, viewer, robotId, reply);
    if (!robot) return reply;
    const v = await versionOf(db, robot.id, version);
    if (!v) return reply.status(404).send({ error: "unknown_robot_version" });
    const out = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [u] = await tx
        .update(robotVersions)
        .set({ status: "retired", updatedAt: sql`now()` })
        .where(and(eq(robotVersions.id, v.id), whereFrom(robotVersions.status, ROBOT_VERSION_MACHINE, "retire")))
        .returning();
      if (!u) return null;
      await haltVersionTool(tx, u, viewer.userId, `robot '${robot.slug}' version ${v.version} retired`);
      await audit(tx, viewer.userId, "robot_version", v.id, "robot-version-retired", `robot '${robot.slug}' version ${v.version} retired; its tool is halted`, {
        robotId: robot.id,
        version: v.version,
        mcpToolId: v.mcpToolId,
      });
      return u;
    });
    if (!out) return reply.status(409).send({ error: "robot_version_not_approved", lifecycle: ROBOT_VERSION_MACHINE.describe(v.status) });
    return { version: await versionView(db, robot, out, viewer) };
  });

  app.put("/v1/robots/:robotId/secrets/:name/:scope", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const params = secretParam.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ error: "invalid_request", detail: "a secret name is a letter then letters, digits or _ (64 at most); scope is live or test" });
    const { robotId, name, scope } = params.data;
    const robot = await managedRobot(db, viewer, robotId, reply);
    if (!robot) return reply;
    if (robot.status !== "active") return reply.status(409).send({ error: "robot_not_active" });
    const parsed = setRobotSecretSchema.safeParse(req.body ?? {});
    // the zod issue list could echo the body back, and the body is the secret: a fixed sentence instead
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request", detail: "expected { value } (1 to 8192 characters)" });
    if (!opts.dataKey) return reply.status(503).send({ error: "data_key_unavailable", detail: "the data key is not configured, so a secret cannot be stored encrypted" });
    const stepUp = { kind: "settings_relax" as const, facts: { op: "robot_secret_set", robotId: robot.id, name, scope } };
    const look = await checkStepUp(db, req, stepUp, { spend: true });
    if (!look.ok) return reply.status(look.status).send(look.body);
    const value = parsed.data.value;
    const values = {
      valueCiphertext: encryptSecret(opts.dataKey, value),
      // a short secret shows nothing of itself
      last4: value.length >= 12 ? value.slice(-4) : "",
      setBy: viewer.userId,
      setAt: sql`now()`,
    };
    const row = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [s] = await tx
        .insert(robotSecrets)
        .values({ robotId: robot.id, name, scope, ...values })
        .onConflictDoUpdate({ target: [robotSecrets.robotId, robotSecrets.name, robotSecrets.scope], set: values })
        .returning({ id: robotSecrets.id, name: robotSecrets.name, scope: robotSecrets.scope, last4: robotSecrets.last4, setAt: robotSecrets.setAt });
      // never the value: the name, the scope and who set it
      await audit(tx, viewer.userId, "robot_secret", s!.id, "robot-secret-set", `robot '${robot.slug}' secret '${name}' (${scope}) set`, { robotId: robot.id, name, scope });
      return s!;
    });
    return { secret: row };
  });

  app.delete("/v1/robots/:robotId/secrets/:name/:scope", async (req, reply) => {
    const viewer = viewerOf(req, reply);
    if (!viewer) return;
    const params = secretParam.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ error: "invalid_request" });
    const { robotId, name, scope } = params.data;
    const robot = await managedRobot(db, viewer, robotId, reply);
    if (!robot) return reply;
    const [secret] = await db
      .select({ id: robotSecrets.id })
      .from(robotSecrets)
      .where(and(eq(robotSecrets.robotId, robot.id), eq(robotSecrets.name, name), eq(robotSecrets.scope, scope)));
    if (!secret) return reply.status(404).send({ error: "unknown_robot_secret" });
    // a secret a submitted version is bound to stays: the version's approval covers that exact secret
    const [{ n } = { n: 0 }] = await db
      .select({ n: count() })
      .from(robotVersionSecrets)
      .where(scope === "live" ? eq(robotVersionSecrets.liveSecretId, secret.id) : eq(robotVersionSecrets.testSecretId, secret.id));
    if (Number(n) > 0) {
      return reply.status(409).send({ error: "robot_secret_in_use", detail: "a submitted version is bound to this secret; retire the version first, or set a new value instead" });
    }
    await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await tx.delete(robotSecrets).where(eq(robotSecrets.id, secret.id));
      await audit(tx, viewer.userId, "robot_secret", secret.id, "robot-secret-cleared", `robot '${robot.slug}' secret '${name}' (${scope}) cleared`, { robotId: robot.id, name, scope });
    });
    return reply.status(204).send();
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The approvals decide path (app.ts) — object type `robot_version`
// ---------------------------------------------------------------------------------------------------------------------

/** `cannot_approve_own_robot_version`, keyed on the DECIDER, so the author cannot reach their own review through
 * delegation or the admin override */
export async function precheckRobotVersionDecision(db: Db, approval: { id: string }, deciderUserId: string): Promise<Refusal | null> {
  const [v] = await db.select({ authorUserId: robotVersions.authorUserId }).from(robotVersions).where(eq(robotVersions.approvalId, approval.id));
  if (!v) return null;
  if (v.authorUserId === deciderUserId) {
    return {
      status: 403,
      body: { error: "cannot_approve_own_robot_version", detail: "the decider wrote this robot version; another reviewer must decide it" },
    };
  }
  return null;
}

/**
 * Runs inside the decision's transaction. Approved: the version becomes a tool on the Robots server ONLY if its
 * robot is still active and its stored content still hashes to the digest both the version and the approval carry;
 * the tool's definition pin is approved by the same decision (the reviewer approved exactly this definition).
 * Anything else records the version rejected and creates nothing. Denied: rejected.
 */
export async function applyRobotVersionDecision(
  tx: Db,
  approval: { id: string; argumentsDigest: string | null },
  decision: "approved" | "denied",
  deciderUserId: string,
): Promise<null> {
  const [v] = await tx.select().from(robotVersions).where(eq(robotVersions.approvalId, approval.id)).for("update");
  if (!v || v.status !== "in_review") return null;
  const [robot] = await tx.select().from(robots).where(eq(robots.id, v.robotId));
  const reject = async (ruleId: string, reason: string, detail: Record<string, unknown> = {}) => {
    await tx
      .update(robotVersions)
      .set({ status: "rejected", decidedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(robotVersions.id, v.id), whereFrom(robotVersions.status, ROBOT_VERSION_MACHINE, "reject")));
    await audit(tx, deciderUserId, "robot_version", v.id, ruleId, reason, { robotId: v.robotId, version: v.version, approvalId: approval.id, ...detail }, decision === "approved" ? "deny" : "allow");
    return null;
  };
  if (decision === "denied") return reject("robot-version-rejected", `robot version ${v.version} rejected in review`);
  const content = await robotVersionContent(tx, v);
  if (!robot || robot.status !== "active") return reject("robot-version-stale", `robot version ${v.version} not published: its robot is retired`);
  if (!v.contentDigest || v.contentDigest !== approval.argumentsDigest || content.digest !== v.contentDigest) {
    return reject("robot-version-stale", `robot version ${v.version} not published: its content no longer matches the approved digest`, {
      approvedDigest: approval.argumentsDigest,
      currentDigest: content.digest,
    });
  }
  const serverId = await robotsServerId(tx);
  if (!serverId) return reject("robot-version-stale", `robot version ${v.version} not published: the Robots MCP server is not registered`);
  const def = robotToolDefinition(robot, v);
  const [tool] = await tx
    .insert(mcpTools)
    .values({ serverId, name: def.name, kind: "write", description: def.description ?? null, inputSchema: def.inputSchema as Record<string, unknown> })
    .onConflictDoUpdate({
      target: [mcpTools.serverId, mcpTools.name],
      set: { kind: "write", description: def.description ?? null, inputSchema: def.inputSchema as Record<string, unknown> },
    })
    .returning({ id: mcpTools.id });
  const pin = pinnableDefinition("tool", def);
  if (pin) {
    const approvedPin = {
      approvedDigest: pin.digest,
      approvedDefinition: pin.definition,
      approvedBy: deciderUserId,
      approvedAt: sql`now()`,
      observedDigest: pin.digest,
      observedDefinition: pin.definition,
      observedAt: sql`now()`,
      changedAt: null,
    };
    await tx
      .insert(mcpDefinitionPins)
      .values({ serverId, kind: "tool", name: pin.name, ...approvedPin })
      .onConflictDoUpdate({ target: [mcpDefinitionPins.serverId, mcpDefinitionPins.kind, mcpDefinitionPins.name], set: approvedPin });
    // the server's baseline is the reviewed set: a later sync compares against approved pins, never re-baselines them
    await tx.update(mcpServers).set({ definitionsPinnedAt: sql`now()` }).where(and(eq(mcpServers.id, serverId), sql`${mcpServers.definitionsPinnedAt} IS NULL`));
  }
  await tx
    .update(robotVersions)
    .set({ status: "approved", mcpToolId: tool!.id, decidedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(robotVersions.id, v.id), whereFrom(robotVersions.status, ROBOT_VERSION_MACHINE, "approve")));
  await audit(tx, deciderUserId, "robot_version", v.id, "robot-version-approved", `robot '${robot.slug}' version ${v.version} approved; published as tool '${def.name}'`, {
    robotId: robot.id,
    version: v.version,
    approvalId: approval.id,
    mcpToolId: tool!.id,
    contentDigest: v.contentDigest,
  });
  return null;
}
