/**
 * ADR-0356 — WORK ASSIGNED FROM THE PM TOOL, the gateway half.
 *
 *   `@regulait/pm-provider` triggers.ts   signal extraction, the settings schema, the lifecycle table. Pure.
 *   THIS FILE                              the admin API (settings, identity links, the trigger list) and
 *                                          `handlePmTriggers`, which the PM webhook route calls.
 *   `workflows.ts`                         owns `startWorkflowForChange`. THIS FILE STARTS NOTHING ITSELF: it calls
 *                                          that function, exactly as `POST /v1/workflows/instances` does.
 *
 * THE WALLS A TRIGGER PASSES, IN ORDER
 *  1. VERIFIED AND RECORDED. The webhook route has verified the delivery (URL token, basic auth or HMAC), checked its
 *     timestamp window and recorded it in `pm_webhook_deliveries` (S-03) before this file runs, so a replay never
 *     reaches here.
 *  2. SETTINGS. A connection without `pm_trigger_settings`, or disabled, or with the mechanism off, ignores the
 *     signal and records nothing (off by default, ADR-0180).
 *  3. ONE OPEN TRIGGER PER ITEM. A second hand-over while one is open is recorded in the audit trail and starts
 *     nothing (the partial unique index).
 *  4. MAP. The PM actor is an ASSERTION. It becomes a RegulAIt user only through an admin's `pm_identity_links` row.
 *     Unlinked → denied. Disabled → denied.
 *  5. ENTITLED. The mapped user's own agent decision (`agentDecision`, the invoke path's check, in `execute` mode)
 *     must allow the connection's configured agent. Run as that user, never as an admin.
 *  6. THE ONE START. `startWorkflowForChange` as that user with that user's own `is_admin`: the template assignment
 *     picks the workflow (Intake, then forced Plan come from the template).
 * A denial is explained on the item in plain words. Every step writes an audit row.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  agents,
  and,
  auditLog,
  desc,
  eq,
  inArray,
  lt,
  oidcProviders,
  pmConnections,
  pmIdentityLinks,
  pmLinks,
  pmTriggerSettings,
  pmWorkTriggers,
  projects,
  runWithRlsPrincipal,
  samlProviders,
  sql,
  users,
  type Db,
} from "@regulait/db";
import {
  adfToText,
  extractTriggerSignals,
  mappingFor,
  matchTrigger,
  pmTriggerSettingsSchema,
  pmTriggerSourcesOf,
  type PmTriggerSettings,
  type PmTriggerSignal,
  type PmTriggerState,
} from "@regulait/pm-provider";
import { agentDecision } from "./copilot.js";
import { providerFor } from "./pm.js";
import { startWorkflowForChange } from "./workflows.js";
import { errMessage } from "./err-serializer.js";

const SYSTEM_IDENTITY = "00000000-0000-0000-0000-000000000000";
/** at most this many triggers are handled from one delivery (a comment can mention the agent once; the rest is noise) */
export const PM_TRIGGERS_PER_DELIVERY_MAX = 5;
/** the change description read from the item is bounded, like every other untrusted field */
export const PM_TRIGGER_DESCRIPTION_MAX = 8000;
const TRIGGERS_LIST_DEFAULT = 50;
const TRIGGERS_LIST_MAX = 200;

export const PM_TRIGGER_RULE_IDS = {
  settingsSaved: "pm-trigger-settings-saved",
  identityLinked: "pm-identity-linked",
  identityUnlinked: "pm-identity-unlinked",
  received: "pm-trigger-received",
  duplicateOpen: "pm-trigger-duplicate-open",
  accepted: "pm-trigger-accepted",
  denied: "pm-trigger-denied",
  running: "pm-trigger-running",
  failed: "pm-trigger-failed",
  writtenBack: "pm-trigger-written-back",
  settingsInvalid: "pm-trigger-settings-invalid",
} as const;

/** The plain-words reason posted on the item for each denial or failure. No ids, no secret material. */
const OUTCOME_TEXT: Record<string, string> = {
  not_linked:
    "RegulAIt did not start this work: the person who handed it over is not linked to a RegulAIt user. " +
    "A RegulAIt admin can link their account under PM identity links.",
  user_disabled: "RegulAIt did not start this work: the RegulAIt account of the person who handed it over is disabled.",
  not_entitled:
    "RegulAIt did not start this work: the person who handed it over is not entitled to use the RegulAIt agent this " +
    "connection runs on. A RegulAIt admin can grant it.",
  item_unreadable: "RegulAIt could not read this work item, so no workflow was started.",
  no_workflow:
    "RegulAIt did not start this work: no workflow is assigned to this kind of change. A RegulAIt admin can assign " +
    "one under workflow templates.",
  start_refused: "RegulAIt did not start this work: the workflow could not be started for this item.",
};

// ---------------------------------------------------------------------------
// Settings: the stored row ↔ the validated document
// ---------------------------------------------------------------------------

/** the stored row as the one validated settings document, or null when it no longer validates (then: ignored) */
export function settingsOf(row: typeof pmTriggerSettings.$inferSelect): PmTriggerSettings | null {
  const parsed = pmTriggerSettingsSchema.safeParse({
    ...(row.config !== null && typeof row.config === "object" ? (row.config as Record<string, unknown>) : {}),
    enabled: row.enabled,
    agentId: row.agentId,
  });
  return parsed.success ? parsed.data : null;
}

const putSettingsSchema = pmTriggerSettingsSchema.extend({ projectId: z.string().uuid().nullable().optional() }).strict();

const linkSchema = z
  .object({
    connectionName: z.string().min(1).max(200),
    pmUserId: z.string().trim().min(1).max(200),
    email: z.string().trim().min(3).max(320),
  })
  .strict();

const triggersQuerySchema = z
  .object({
    connectionName: z.string().min(1).max(200),
    limit: z.coerce.number().int().min(1).max(TRIGGERS_LIST_MAX).default(TRIGGERS_LIST_DEFAULT),
    /** keyset cursor: the createdAt of the last row of the previous page (ISO) */
    before: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// The lifecycle: one compare-and-set move, along the declared table only
// ---------------------------------------------------------------------------

async function moveTrigger(
  db: Db,
  id: string,
  to: PmTriggerState,
  set: Partial<Pick<typeof pmWorkTriggers.$inferInsert, "userId" | "outcomeCode" | "outcomeDetail" | "instanceId">> = {},
): Promise<boolean> {
  const from = pmTriggerSourcesOf(to);
  const moved = await db
    .update(pmWorkTriggers)
    .set({ ...set, state: to, updatedAt: sql`now()` })
    .where(and(eq(pmWorkTriggers.id, id), inArray(pmWorkTriggers.state, from)))
    .returning({ id: pmWorkTriggers.id });
  return moved.length === 1;
}

type ConnRow = typeof pmConnections.$inferSelect;

export interface PmTriggerOutcome {
  externalId: string;
  mechanism: PmTriggerSignal["mechanism"];
  state: PmTriggerState | "duplicate";
  instanceId?: string;
  outcomeCode?: string;
}

/** a field value read through from the PM tool as plain text (ADF on Jira v3), or "" */
function fieldText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v !== null && typeof v === "object" && (v as { type?: unknown }).type === "doc") return adfToText(v);
  return "";
}

/**
 * ADR-0356: handle the trigger signals of ONE delivery the webhook route has verified and recorded. Never throws for
 * a trigger-level problem (each is recorded and audited on its own row); a database failure propagates so the route
 * releases the delivery record and the provider retries.
 */
export async function handlePmTriggers(
  db: Db,
  dataKey: string,
  conn: ConnRow,
  delivery: { rawBody: string; query: Record<string, string | undefined>; contentSha256: string },
): Promise<PmTriggerOutcome[]> {
  const [row] = await db.select().from(pmTriggerSettings).where(eq(pmTriggerSettings.connectionId, conn.id));
  if (!row || !row.enabled) return [];
  const settings = settingsOf(row);
  if (!settings) {
    await audit(db, SYSTEM_IDENTITY, conn.id, PM_TRIGGER_RULE_IDS.settingsInvalid, "deny",
      `PM connection '${conn.name}': its trigger settings no longer validate, so a trigger signal was ignored`,
      { connection: conn.name });
    return [];
  }
  const signals = extractTriggerSignals(conn.provider, delivery.rawBody, delivery.query)
    .filter((s) => matchTrigger(s, settings))
    .slice(0, PM_TRIGGERS_PER_DELIVERY_MAX);
  const out: PmTriggerOutcome[] = [];
  for (const signal of signals) {
    out.push(await handleOneSafely(db, dataKey, conn, row, settings, signal, delivery.contentSha256));
  }
  return out;
}

/** One trigger that fails unexpectedly must not stay open (it would block every later hand-over of the item): its
 * open row moves to `failed` with the error recorded, and the delivery's other work still completes. */
async function handleOneSafely(
  db: Db,
  dataKey: string,
  conn: ConnRow,
  row: typeof pmTriggerSettings.$inferSelect,
  settings: PmTriggerSettings,
  signal: PmTriggerSignal,
  contentSha256: string,
): Promise<PmTriggerOutcome> {
  try {
    return await handleOne(db, dataKey, conn, row, settings, signal, contentSha256);
  } catch (err) {
    const [open] = await db
      .update(pmWorkTriggers)
      .set({ state: "failed", outcomeCode: "error", outcomeDetail: "RegulAIt could not handle this hand-over.", updatedAt: sql`now()` })
      .where(
        and(
          eq(pmWorkTriggers.connectionId, conn.id),
          eq(pmWorkTriggers.externalId, signal.externalId),
          eq(pmWorkTriggers.deliveryContentSha256, contentSha256),
          inArray(pmWorkTriggers.state, pmTriggerSourcesOf("failed")),
        ),
      )
      .returning({ id: pmWorkTriggers.id });
    await audit(db, SYSTEM_IDENTITY, open?.id ?? conn.id, PM_TRIGGER_RULE_IDS.failed, "deny",
      `PM connection '${conn.name}': the hand-over of item ${signal.externalId} failed unexpectedly`,
      { connection: conn.name, externalId: signal.externalId, mechanism: signal.mechanism, error: errMessage(err).slice(0, 300) },
      open ? "pm_work_trigger" : "pm_connection");
    return { externalId: signal.externalId, mechanism: signal.mechanism, state: "failed", outcomeCode: "error" };
  }
}

async function handleOne(
  db: Db,
  dataKey: string,
  conn: ConnRow,
  row: typeof pmTriggerSettings.$inferSelect,
  settings: PmTriggerSettings,
  signal: PmTriggerSignal,
  contentSha256: string,
): Promise<PmTriggerOutcome> {
  const base = { externalId: signal.externalId, mechanism: signal.mechanism };
  const actorPmUserId = signal.actorIds[0] ?? null;
  const [trigger] = await db
    .insert(pmWorkTriggers)
    .values({
      connectionId: conn.id,
      externalId: signal.externalId,
      mechanism: signal.mechanism,
      actorPmUserId,
      deliveryContentSha256: contentSha256,
    })
    .onConflictDoNothing()
    .returning({ id: pmWorkTriggers.id });
  const detail = { connection: conn.name, provider: conn.provider, externalId: signal.externalId, mechanism: signal.mechanism, actorPmUserId };
  if (!trigger) {
    await audit(db, SYSTEM_IDENTITY, conn.id, PM_TRIGGER_RULE_IDS.duplicateOpen, "deny",
      `PM connection '${conn.name}': item ${signal.externalId} was handed to RegulAIt again while its earlier hand-over is still open; nothing new was started`,
      detail, "pm_connection");
    return { ...base, state: "duplicate" };
  }
  await audit(db, SYSTEM_IDENTITY, trigger.id, PM_TRIGGER_RULE_IDS.received, "allow",
    `PM connection '${conn.name}': item ${signal.externalId} was handed to RegulAIt (${signal.mechanism})`, detail);

  // wall 4: map the asserted actor through an admin's link (case-insensitive; the first candidate that is linked)
  const candidates = signal.actorIds.map((a) => a.toLowerCase());
  const links =
    candidates.length === 0
      ? []
      : await db
          .select({ userId: pmIdentityLinks.userId, pmUserId: pmIdentityLinks.pmUserId })
          .from(pmIdentityLinks)
          .where(and(eq(pmIdentityLinks.connectionId, conn.id), inArray(sql<string>`lower(${pmIdentityLinks.pmUserId})`, candidates)));
  const link = candidates.map((c) => links.find((l) => l.pmUserId.toLowerCase() === c)).find((l) => l !== undefined);
  if (!link) return deny(db, dataKey, conn, trigger.id, base, detail, null, "not_linked");
  const [user] = await db
    .select({ id: users.id, isAdmin: users.isAdmin, disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, link.userId));
  if (!user) return deny(db, dataKey, conn, trigger.id, base, detail, null, "not_linked");
  if (user.disabledAt) return deny(db, dataKey, conn, trigger.id, base, detail, user.id, "user_disabled");

  // wall 5: the person's own agent decision, as that person
  const [agent] = await db.select().from(agents).where(eq(agents.id, row.agentId));
  const decision = agent
    ? await runWithRlsPrincipal({ userId: user.id }, () => agentDecision(db, user.id, agent, undefined, "execute"))
    : null;
  if (!decision || decision.effect !== "allow") {
    return deny(db, dataKey, conn, trigger.id, base, { ...detail, agentId: row.agentId, agentRuleId: decision?.ruleId ?? null }, user.id, "not_entitled");
  }
  if (!(await moveTrigger(db, trigger.id, "accepted", { userId: user.id }))) return { ...base, state: "received" };
  await audit(db, user.id, trigger.id, PM_TRIGGER_RULE_IDS.accepted, "allow",
    `PM connection '${conn.name}': item ${signal.externalId} accepted for the linked user (agent decision ${decision.ruleId})`,
    { ...detail, agentId: row.agentId, agentRuleId: decision.ruleId });

  // the item is the source of truth (pillar 8): its text is read through now and never stored
  let item: { url: string; fields: Record<string, unknown> };
  try {
    const provider = await providerFor(db, conn, dataKey, { userId: user.id, detail: { phase: "pm-trigger" } });
    item = await provider.getWorkItem(conn.project, signal.externalId);
  } catch (err) {
    return fail(db, dataKey, conn, trigger.id, base, { ...detail, error: errMessage(err).slice(0, 300) }, user.id, "item_unreadable");
  }
  const map = mappingFor(conn.provider, conn.mapping ?? undefined).task.fields;
  const title = fieldText(item.fields[map.title]).trim();
  const body = [map.description, map.acceptanceCriteria]
    .filter((f): f is string => typeof f === "string")
    .map((f) => fieldText(item.fields[f]).trim())
    .filter((t) => t !== "");
  const description = [title || `Work item ${signal.externalId}`, ...body].join("\n\n").slice(0, PM_TRIGGER_DESCRIPTION_MAX);

  // wall 6: the one start, as the person, with the person's own is_admin
  const started = await runWithRlsPrincipal({ userId: user.id }, () =>
    startWorkflowForChange(db, dataKey, {
      userId: user.id,
      isAdmin: user.isAdmin,
      body: {
        change: {
          description,
          paths: [],
          changeType: settings.change.changeType,
          environment: settings.change.environment,
          ...(settings.change.targetSystem ? { targetSystem: settings.change.targetSystem } : {}),
        },
        projectId: row.projectId ?? undefined,
      },
    }),
  );
  if (started.status !== 201) {
    const error = (started.body as { error?: unknown } | null)?.error;
    const code = error === "no_workflow_matches_change" ? "no_workflow" : "start_refused";
    return fail(db, dataKey, conn, trigger.id, base, { ...detail, status: started.status, error: typeof error === "string" ? error : null }, user.id, code);
  }
  const instanceId = (started.body as { id: string }).id;
  // linked, not copied: the same record a manual pm-sync writes, so the status mirror and drift processing apply
  await db
    .insert(pmLinks)
    .values({ connectionId: conn.id, objectType: "workflow_instance", objectId: instanceId, externalId: signal.externalId, externalUrl: item.url })
    .onConflictDoNothing();
  if (await moveTrigger(db, trigger.id, "running", { instanceId })) {
    await audit(db, user.id, trigger.id, PM_TRIGGER_RULE_IDS.running, "allow",
      `PM connection '${conn.name}': item ${signal.externalId} started workflow instance ${instanceId}`, { ...detail, instanceId });
  }
  return { ...base, state: "running", instanceId };
}

/** received → denied, then the plain-words comment on the item (denied → written_back, or → failed if it cannot post) */
async function deny(
  db: Db,
  dataKey: string,
  conn: ConnRow,
  triggerId: string,
  base: { externalId: string; mechanism: PmTriggerSignal["mechanism"] },
  detail: Record<string, unknown>,
  userId: string | null,
  code: string,
): Promise<PmTriggerOutcome> {
  const text = OUTCOME_TEXT[code]!;
  if (!(await moveTrigger(db, triggerId, "denied", { userId, outcomeCode: code, outcomeDetail: text }))) {
    return { ...base, state: "received" };
  }
  await audit(db, userId ?? SYSTEM_IDENTITY, triggerId, PM_TRIGGER_RULE_IDS.denied, "deny",
    `PM connection '${conn.name}': item ${base.externalId} was not started (${code})`, { ...detail, outcomeCode: code });
  const posted = await postOutcomeComment(db, dataKey, conn, base.externalId, text, userId);
  if (posted.ok) {
    await moveTrigger(db, triggerId, "written_back");
    await audit(db, userId ?? SYSTEM_IDENTITY, triggerId, PM_TRIGGER_RULE_IDS.writtenBack, "allow",
      `PM connection '${conn.name}': the reason was posted on item ${base.externalId}`, { ...detail, outcomeCode: code });
    return { ...base, state: "written_back", outcomeCode: code };
  }
  await moveTrigger(db, triggerId, "failed", { outcomeDetail: `${text} (The reason could not be posted on the item.)` });
  await audit(db, userId ?? SYSTEM_IDENTITY, triggerId, PM_TRIGGER_RULE_IDS.failed, "deny",
    `PM connection '${conn.name}': the reason could not be posted on item ${base.externalId}`, { ...detail, outcomeCode: code, error: posted.error });
  return { ...base, state: "failed", outcomeCode: code };
}

/** accepted → failed, with a best-effort comment on the item saying why */
async function fail(
  db: Db,
  dataKey: string,
  conn: ConnRow,
  triggerId: string,
  base: { externalId: string; mechanism: PmTriggerSignal["mechanism"] },
  detail: Record<string, unknown>,
  userId: string,
  code: string,
): Promise<PmTriggerOutcome> {
  const text = OUTCOME_TEXT[code]!;
  await moveTrigger(db, triggerId, "failed", { outcomeCode: code, outcomeDetail: text });
  const posted = await postOutcomeComment(db, dataKey, conn, base.externalId, text, userId);
  await audit(db, userId, triggerId, PM_TRIGGER_RULE_IDS.failed, "deny",
    `PM connection '${conn.name}': item ${base.externalId} was accepted but no workflow started (${code})`,
    { ...detail, outcomeCode: code, commentPosted: posted.ok, ...(posted.ok ? {} : { commentError: posted.error }) });
  return { ...base, state: "failed", outcomeCode: code };
}

async function postOutcomeComment(
  db: Db,
  dataKey: string,
  conn: ConnRow,
  externalId: string,
  text: string,
  userId: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const provider = await providerFor(db, conn, dataKey, { userId, detail: { phase: "pm-trigger-comment" } });
    await provider.addComment(conn.project, externalId, text);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errMessage(err).slice(0, 300) };
  }
}

async function audit(
  db: Db,
  userId: string,
  objectId: string,
  ruleId: string,
  effect: "allow" | "deny",
  reason: string,
  detail: Record<string, unknown>,
  objectType: "pm_work_trigger" | "pm_connection" | "pm_identity_link" | "pm_trigger_settings" = "pm_work_trigger",
): Promise<void> {
  await db.insert(auditLog).values({
    userId,
    objectType,
    objectId,
    detail: { phase: "pm-trigger", ...detail },
    effect,
    ruleId,
    ruleChain: [],
    reason,
  });
}

// ---------------------------------------------------------------------------
// Admin API (admin-only: none of these routes is in the non-admin route set)
// ---------------------------------------------------------------------------

export function registerPmTriggerRoutes(app: FastifyInstance, db: Db): void {
  const connByName = async (name: string) => {
    const [conn] = await db.select().from(pmConnections).where(eq(pmConnections.name, name));
    return conn ?? null;
  };

  app.get("/v1/pm/connections/:name/trigger-settings", async (req, reply) => {
    const { name } = z.object({ name: z.string().min(1).max(200) }).parse(req.params);
    const conn = await connByName(name);
    if (!conn) return reply.status(404).send({ error: "unknown_connection" });
    const [row] = await db.select().from(pmTriggerSettings).where(eq(pmTriggerSettings.connectionId, conn.id));
    if (!row) return { configured: false, enabled: false };
    const settings = settingsOf(row);
    return { configured: true, valid: settings !== null, ...(settings ?? { enabled: row.enabled }), projectId: row.projectId, updatedAt: row.updatedAt };
  });

  app.put("/v1/pm/connections/:name/trigger-settings", async (req, reply) => {
    const { name } = z.object({ name: z.string().min(1).max(200) }).parse(req.params);
    const body = putSettingsSchema.parse(req.body);
    const conn = await connByName(name);
    if (!conn) return reply.status(404).send({ error: "unknown_connection" });
    const [agent] = await db.select({ id: agents.id }).from(agents).where(eq(agents.id, body.agentId));
    if (!agent) return reply.status(400).send({ error: "invalid_reference", detail: "agentId names no registered agent" });
    if (body.projectId) {
      const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, body.projectId));
      if (!project) return reply.status(400).send({ error: "invalid_reference", detail: "projectId names no project" });
    }
    const { enabled, agentId, projectId, ...config } = body;
    const values = { enabled, agentId, projectId: projectId ?? null, config, updatedByUserId: req.authCtx.userId ?? null };
    await db
      .insert(pmTriggerSettings)
      .values({ connectionId: conn.id, ...values })
      .onConflictDoUpdate({ target: pmTriggerSettings.connectionId, set: { ...values, updatedAt: sql`now()` } });
    await audit(db, req.authCtx.userId ?? SYSTEM_IDENTITY, conn.id, PM_TRIGGER_RULE_IDS.settingsSaved, "allow",
      `${enabled ? "enabled" : "saved (disabled)"} work triggers on PM connection '${conn.name}': ${Object.entries(config.mechanisms).filter(([, on]) => on).map(([m]) => m).join(", ") || "no mechanism"} on, agent ${agentId}`,
      { connection: conn.name, enabled, agentId, projectId: projectId ?? null, mechanisms: config.mechanisms, change: config.change }, "pm_trigger_settings");
    return { saved: true, enabled };
  });

  app.get("/v1/pm/identity-links", async (req) => {
    const { connectionName } = z.object({ connectionName: z.string().min(1).max(200).optional() }).strict().parse(req.query);
    const rows = await db
      .select({
        id: pmIdentityLinks.id,
        connectionName: pmConnections.name,
        pmUserId: pmIdentityLinks.pmUserId,
        userId: pmIdentityLinks.userId,
        email: users.email,
        verifiedSource: pmIdentityLinks.verifiedSource,
        createdAt: pmIdentityLinks.createdAt,
      })
      .from(pmIdentityLinks)
      .innerJoin(pmConnections, eq(pmConnections.id, pmIdentityLinks.connectionId))
      .innerJoin(users, eq(users.id, pmIdentityLinks.userId))
      .where(connectionName ? eq(pmConnections.name, connectionName) : undefined)
      .orderBy(pmConnections.name, pmIdentityLinks.pmUserId)
      .limit(1000);
    return { links: rows };
  });

  app.post("/v1/pm/identity-links", async (req, reply) => {
    const body = linkSchema.parse(req.body);
    const conn = await connByName(body.connectionName);
    if (!conn) return reply.status(400).send({ error: "invalid_reference", detail: "connectionName names no PM connection" });
    const email = body.email.toLowerCase();
    const [user] = await db.select().from(users).where(eq(users.email, email));
    // an admin binds an EXISTING principal, never invents one: a PM tool must not be a way to mint RegulAIt users
    if (!user) {
      return reply.status(400).send({
        error: "unknown_user",
        detail: "the email must name an existing RegulAIt user — a PM identity link binds an existing principal, it never creates one",
      });
    }
    if (user.disabledAt) return reply.status(422).send({ error: "user_disabled", detail: "a disabled user cannot be linked" });
    const [oidc] = await db.select({ id: oidcProviders.id }).from(oidcProviders).where(eq(oidcProviders.enabled, true)).limit(1);
    const [saml] = await db.select({ id: samlProviders.id }).from(samlProviders).where(eq(samlProviders.enabled, true)).limit(1);
    const verifiedSource = user.scimExternalId ? "scim" : oidc || saml ? "idp" : "admin_asserted";
    const [row] = await db
      .insert(pmIdentityLinks)
      .values({ connectionId: conn.id, pmUserId: body.pmUserId, userId: user.id, verifiedSource, createdByUserId: req.authCtx.userId ?? null })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      return reply.status(409).send({
        error: "identity_link_exists",
        detail:
          "this PM identity, or this user, is already linked on this connection — one PM identity maps to one person, or 'who handed it over?' would have two answers",
      });
    }
    await audit(db, req.authCtx.userId ?? SYSTEM_IDENTITY, row.id, PM_TRIGGER_RULE_IDS.identityLinked, "allow",
      `linked ${conn.provider} identity '${body.pmUserId}' on PM connection '${conn.name}' to RegulAIt user ${email} (verification: ${verifiedSource})`,
      { connection: conn.name, pmUserId: body.pmUserId, userId: user.id, verifiedSource }, "pm_identity_link");
    return reply.status(201).send({ id: row.id, userId: user.id, verifiedSource });
  });

  app.delete("/v1/pm/identity-links/:linkId", async (req, reply) => {
    const { linkId } = z.object({ linkId: z.string().uuid() }).parse(req.params);
    const [row] = await db.delete(pmIdentityLinks).where(eq(pmIdentityLinks.id, linkId)).returning();
    if (!row) return reply.status(404).send({ error: "unknown_link" });
    await audit(db, req.authCtx.userId ?? SYSTEM_IDENTITY, linkId, PM_TRIGGER_RULE_IDS.identityUnlinked, "allow",
      `removed the PM identity link for '${row.pmUserId}': hand-overs from that identity are now denied`,
      { pmUserId: row.pmUserId, userId: row.userId }, "pm_identity_link");
    return { deleted: true, id: linkId };
  });

  app.get("/v1/pm/triggers", async (req, reply) => {
    const q = triggersQuerySchema.parse(req.query);
    const conn = await connByName(q.connectionName);
    if (!conn) return reply.status(404).send({ error: "unknown_connection" });
    const rows = await db
      .select({
        id: pmWorkTriggers.id,
        externalId: pmWorkTriggers.externalId,
        mechanism: pmWorkTriggers.mechanism,
        actorPmUserId: pmWorkTriggers.actorPmUserId,
        userId: pmWorkTriggers.userId,
        state: pmWorkTriggers.state,
        outcomeCode: pmWorkTriggers.outcomeCode,
        outcomeDetail: pmWorkTriggers.outcomeDetail,
        instanceId: pmWorkTriggers.instanceId,
        createdAt: pmWorkTriggers.createdAt,
        updatedAt: pmWorkTriggers.updatedAt,
      })
      .from(pmWorkTriggers)
      .where(and(eq(pmWorkTriggers.connectionId, conn.id), q.before ? lt(pmWorkTriggers.createdAt, new Date(q.before)) : undefined))
      .orderBy(desc(pmWorkTriggers.createdAt), desc(pmWorkTriggers.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    return {
      triggers: page,
      nextBefore: rows.length > q.limit ? page[page.length - 1]!.createdAt.toISOString() : null,
    };
  });
}
