/**
 * ADR-0350 §5 (lane E31) — endpoint device groups and time-limited per-device command-rule exceptions.
 *
 * Device groups only narrow: their rules are ask or deny. Removing a device from a group, or a rule from a group,
 * relaxes that device's policy, so each is a `settings_relax` step-up. An exception relaxes ONE named rule on ONE
 * device for at most `hours`:
 *   - requested by an admin, naming a different active admin as approver (the database refuses self-approval too);
 *   - approved only by that approver, with an `approval_decide` step-up bound to the exact terms digest the request
 *     produced (the approvals queue's ADR-0104 binding), plus a `settings_relax` step-up when it is longer than the
 *     default maximum of 24 hours (never longer than 168);
 *   - expiry is `now() + hours` on the database clock at approval, and `expired` is derived, never stored.
 * Every transition is one conditional UPDATE from the state the shared lifecycle table names, so a concurrent decision
 * cannot apply twice, and every write is audited. Admin-only by the app default (none of these is in
 * NON_ADMIN_ROUTES). The device receives approved exceptions in its signed policy (slice 2b).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  and,
  auditLog,
  desc,
  endpointCommandExceptions,
  endpointDeviceGroupMembers,
  endpointDeviceGroupRules,
  endpointDeviceGroups,
  endpointDevices,
  eq,
  isNull,
  lt,
  sql,
  users,
  type Db,
} from "@regulait/db";
import {
  ENDPOINT_EXCEPTION_DEFAULT_MAX_HOURS,
  ENDPOINT_EXCEPTION_HARD_MAX_HOURS,
  ENDPOINT_EXCEPTION_TRANSITIONS,
  ENDPOINT_EXCEPTION_VERDICTS,
  ENDPOINT_GROUP_RULE_VERDICTS,
  ENDPOINT_RULE_ID,
  type EndpointExceptionAction,
  endpointExceptionDigest,
  endpointExceptionState,
  endpointExceptionTransitionRefusal,
} from "@regulait/shared";
import { requireStepUp, requireStepUps, type StepUpCheckArgs } from "./step-up.js";

const LIST_MAX = 200;

const refuse = (reply: FastifyReply, status: number, error: string, detail: string) => reply.status(status).send({ error, detail });
const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
const actor = (req: FastifyRequest) => req.authCtx.userId ?? null;
const id = (name: string) => z.object({ [name]: z.string().uuid() });

// glob text the device accepts: a conservative character set, so a group rule can never make the device refuse the
// whole policy over a pattern its glob library rejects (ADR-0350 §2 refuses a policy with a bad pattern)
const glob = z.string().min(1).max(512).regex(/^[A-Za-z0-9._/@:~*+=,%-]+$/, "letters, digits and ._/@:~*+=,%- only");
const groupRuleBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exec"), ruleId: z.string().regex(ENDPOINT_RULE_ID), verdict: z.enum(ENDPOINT_GROUP_RULE_VERDICTS), rule: z.object({ argv: z.array(glob).min(1).max(32) }).strict() }).strict(),
  z.object({
    kind: z.literal("file"),
    ruleId: z.string().regex(ENDPOINT_RULE_ID),
    verdict: z.enum(ENDPOINT_GROUP_RULE_VERDICTS),
    rule: z.object({ access: z.enum(["read", "write", "any"]), path: glob.regex(/^(\/|~\/|\*\*\/|[A-Za-z]:\/)/, "an absolute path glob") }).strict(),
  }).strict(),
  z.object({
    kind: z.literal("package"),
    ruleId: z.string().regex(ENDPOINT_RULE_ID),
    verdict: z.enum(ENDPOINT_GROUP_RULE_VERDICTS),
    rule: z.object({ ecosystem: z.enum(["npm", "pypi", "apt", "dnf", "apk", "brew", "cargo", "go", "gem", "*"]), name: glob }).strict(),
  }).strict(),
]);
const groupBody = z.object({ name: z.string().trim().min(1).max(120), description: z.string().max(1000).optional() }).strict();
const memberBody = z.object({ deviceId: z.string().uuid() }).strict();
const requestBody = z
  .object({
    deviceId: z.string().uuid(),
    ruleId: z.string().regex(ENDPOINT_RULE_ID),
    verdict: z.enum(ENDPOINT_EXCEPTION_VERDICTS),
    hours: z.number().int().min(1).max(ENDPOINT_EXCEPTION_HARD_MAX_HOURS),
    reason: z.string().trim().min(1).max(500),
    approverUserId: z.string().uuid(),
  })
  .strict();
const decideBody = z.object({ termsDigest: z.string().regex(/^[0-9a-f]{64}$/), decisionReason: z.string().trim().max(500).optional() }).strict();
const reasonBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const listQuery = z
  .object({
    deviceId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(LIST_MAX).default(50),
    before: z.string().datetime().optional(),
  })
  .strict();

type AuditObject = "endpoint_device_group" | "endpoint_command_exception";

// the bootstrap token has no user: its audit rows carry the nil id, as the other endpoint routes do
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

async function audit(db: Db, userId: string | null, objectType: AuditObject, objectId: string, ruleId: string, reason: string, detail: Record<string, unknown>) {
  await db.insert(auditLog).values({ userId: userId ?? NIL_UUID, objectType, objectId, detail: { adr: "ADR-0350", ...detail }, effect: "allow", ruleId, ruleChain: [], reason });
}

type ExceptionRow = typeof endpointCommandExceptions.$inferSelect;

function view(row: ExceptionRow, now: Date) {
  return {
    id: row.id,
    deviceId: row.deviceId,
    ruleId: row.ruleId,
    verdict: row.verdict,
    hours: row.hours,
    reason: row.reason,
    termsDigest: row.termsDigest,
    requestedBy: row.requestedBy,
    approverUserId: row.approverUserId,
    state: endpointExceptionState({ status: row.status, notAfter: row.notAfter }, now),
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionReason: row.decisionReason,
    notAfter: row.notAfter?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function dbNow(db: Db): Promise<Date> {
  const r = await db.execute(sql`SELECT now() AS now`);
  return new Date((r.rows[0] as { now: string | Date }).now);
}

async function activeAdmin(db: Db, userId: string): Promise<boolean> {
  const [u] = await db.select({ isAdmin: users.isAdmin, disabledAt: users.disabledAt }).from(users).where(eq(users.id, userId));
  return !!u && u.isAdmin && u.disabledAt === null;
}

export function registerEndpointCommandExceptionRoutes(app: FastifyInstance, db: Db): void {
  // ----- device groups -----------------------------------------------------------------------------------------
  app.post("/v1/endpoint-device-groups", async (req, reply) => {
    const b = groupBody.safeParse(req.body ?? {});
    if (!b.success) return refuse(reply, 400, "invalid_body", issues(b.error));
    const [row] = await db
      .insert(endpointDeviceGroups)
      .values({ name: b.data.name, description: b.data.description ?? null, createdBy: actor(req) })
      .onConflictDoNothing()
      .returning();
    if (!row) return refuse(reply, 409, "name_taken", "a device group with this name exists");
    await audit(db, actor(req), "endpoint_device_group", row.id, "endpoint-device-group.create", "device group created", { name: row.name });
    return reply.status(201).send({ id: row.id, name: row.name, description: row.description, createdAt: row.createdAt.toISOString() });
  });

  app.get("/v1/endpoint-device-groups", async () => {
    const groups = await db.select().from(endpointDeviceGroups).orderBy(endpointDeviceGroups.name).limit(LIST_MAX);
    const members = await db.select({ groupId: endpointDeviceGroupMembers.groupId, deviceId: endpointDeviceGroupMembers.deviceId }).from(endpointDeviceGroupMembers);
    const rules = await db.select().from(endpointDeviceGroupRules).orderBy(endpointDeviceGroupRules.ruleId);
    return {
      items: groups.map((g) => ({
        id: g.id,
        name: g.name,
        description: g.description,
        deviceIds: members.filter((m) => m.groupId === g.id).map((m) => m.deviceId),
        rules: rules.filter((r) => r.groupId === g.id).map((r) => ({ id: r.id, ruleId: r.ruleId, kind: r.kind, rule: r.rule, verdict: r.verdict })),
      })),
    };
  });

  app.post("/v1/endpoint-device-groups/:groupId/members", async (req, reply) => {
    const p = id("groupId").safeParse(req.params);
    const b = memberBody.safeParse(req.body ?? {});
    if (!p.success || !b.success) return refuse(reply, 400, "invalid_request", "groupId and deviceId must be uuids");
    const groupId = p.data.groupId as string;
    const [g] = await db.select({ id: endpointDeviceGroups.id }).from(endpointDeviceGroups).where(eq(endpointDeviceGroups.id, groupId));
    const [d] = await db.select({ id: endpointDevices.id, revokedAt: endpointDevices.revokedAt }).from(endpointDevices).where(eq(endpointDevices.id, b.data.deviceId));
    if (!g || !d) return refuse(reply, 404, "not_found", "no such group or device");
    const added = await db.insert(endpointDeviceGroupMembers).values({ groupId, deviceId: d.id, addedBy: actor(req) }).onConflictDoNothing().returning();
    if (added.length) await audit(db, actor(req), "endpoint_device_group", groupId, "endpoint-device-group.member-add", "device added to group", { deviceId: d.id });
    return reply.status(added.length ? 201 : 200).send({ groupId, deviceId: d.id, added: added.length > 0 });
  });

  app.delete("/v1/endpoint-device-groups/:groupId/members/:deviceId", async (req, reply) => {
    const p = z.object({ groupId: z.string().uuid(), deviceId: z.string().uuid() }).safeParse(req.params);
    if (!p.success) return refuse(reply, 400, "invalid_request", "groupId and deviceId must be uuids");
    // leaving a group drops its narrowing rules from the device: a relaxation
    const step = await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { values: { endpointDeviceGroupMemberRemove: p.data } } });
    if (!step.ok) return reply;
    const gone = await db
      .delete(endpointDeviceGroupMembers)
      .where(and(eq(endpointDeviceGroupMembers.groupId, p.data.groupId), eq(endpointDeviceGroupMembers.deviceId, p.data.deviceId)))
      .returning();
    if (!gone.length) return refuse(reply, 404, "not_found", "the device is not in this group");
    await audit(db, actor(req), "endpoint_device_group", p.data.groupId, "endpoint-device-group.member-remove", "device removed from group", { deviceId: p.data.deviceId, stepUp: step.method });
    return reply.send({ removed: true });
  });

  app.post("/v1/endpoint-device-groups/:groupId/rules", async (req, reply) => {
    const p = id("groupId").safeParse(req.params);
    if (!p.success) return refuse(reply, 400, "invalid_request", "groupId must be a uuid");
    const b = groupRuleBody.safeParse(req.body ?? {});
    if (!b.success) return refuse(reply, 400, "invalid_body", issues(b.error));
    const groupId = p.data.groupId as string;
    const [g] = await db.select({ id: endpointDeviceGroups.id }).from(endpointDeviceGroups).where(eq(endpointDeviceGroups.id, groupId));
    if (!g) return refuse(reply, 404, "not_found", "no such group");
    const [row] = await db
      .insert(endpointDeviceGroupRules)
      .values({ groupId, ruleId: b.data.ruleId, kind: b.data.kind, rule: b.data.rule, verdict: b.data.verdict, createdBy: actor(req) })
      .onConflictDoNothing()
      .returning();
    if (!row) return refuse(reply, 409, "rule_id_taken", "this group already has a rule with this id");
    await audit(db, actor(req), "endpoint_device_group", groupId, "endpoint-device-group.rule-add", "narrowing rule added", { ruleId: row.ruleId, kind: row.kind, verdict: row.verdict });
    return reply.status(201).send({ id: row.id, ruleId: row.ruleId, kind: row.kind, rule: row.rule, verdict: row.verdict });
  });

  app.delete("/v1/endpoint-device-groups/:groupId/rules/:ruleId", async (req, reply) => {
    const p = z.object({ groupId: z.string().uuid(), ruleId: z.string().regex(ENDPOINT_RULE_ID) }).safeParse(req.params);
    if (!p.success) return refuse(reply, 400, "invalid_request", "groupId must be a uuid and ruleId a rule id");
    const step = await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { values: { endpointDeviceGroupRuleRemove: p.data } } });
    if (!step.ok) return reply;
    const gone = await db
      .delete(endpointDeviceGroupRules)
      .where(and(eq(endpointDeviceGroupRules.groupId, p.data.groupId), eq(endpointDeviceGroupRules.ruleId, p.data.ruleId)))
      .returning();
    if (!gone.length) return refuse(reply, 404, "not_found", "no such rule in this group");
    await audit(db, actor(req), "endpoint_device_group", p.data.groupId, "endpoint-device-group.rule-remove", "narrowing rule removed", { ruleId: p.data.ruleId, stepUp: step.method });
    return reply.send({ removed: true });
  });

  // ----- exceptions --------------------------------------------------------------------------------------------
  app.post("/v1/endpoint-command-exceptions", async (req, reply) => {
    const b = requestBody.safeParse(req.body ?? {});
    if (!b.success) return refuse(reply, 400, "invalid_body", issues(b.error));
    const requester = actor(req);
    if (!requester) return refuse(reply, 403, "user_required", "an exception is requested by a person");
    if (b.data.approverUserId === requester) return refuse(reply, 403, "caller_cannot_approve", "name an approver other than yourself");
    if (!(await activeAdmin(db, b.data.approverUserId))) return refuse(reply, 400, "approver_not_admin", "the approver must be an active admin");
    const [d] = await db.select({ id: endpointDevices.id, revokedAt: endpointDevices.revokedAt }).from(endpointDevices).where(eq(endpointDevices.id, b.data.deviceId));
    if (!d) return refuse(reply, 404, "not_found", "no such device");
    if (d.revokedAt) return refuse(reply, 409, "device_revoked", "the device is revoked");
    const terms = { deviceId: d.id, ruleId: b.data.ruleId, verdict: b.data.verdict, hours: b.data.hours, reason: b.data.reason };
    const [row] = await db
      .insert(endpointCommandExceptions)
      .values({ ...terms, termsDigest: endpointExceptionDigest(terms), requestedBy: requester, approverUserId: b.data.approverUserId })
      .returning();
    await audit(db, requester, "endpoint_command_exception", row!.id, "endpoint-command-exception.request", "exception requested", { ...terms, approverUserId: b.data.approverUserId });
    return reply.status(201).send(view(row!, await dbNow(db)));
  });

  app.get("/v1/endpoint-command-exceptions", async (req, reply) => {
    const q = listQuery.safeParse(req.query ?? {});
    if (!q.success) return refuse(reply, 400, "invalid_query", issues(q.error));
    const where = and(
      q.data.deviceId ? eq(endpointCommandExceptions.deviceId, q.data.deviceId) : undefined,
      q.data.before ? lt(endpointCommandExceptions.createdAt, new Date(q.data.before)) : undefined,
    );
    const rows = await db.select().from(endpointCommandExceptions).where(where).orderBy(desc(endpointCommandExceptions.createdAt), desc(endpointCommandExceptions.id)).limit(q.data.limit + 1);
    const now = await dbNow(db);
    const page = rows.slice(0, q.data.limit);
    return { items: page.map((r) => view(r, now)), next: rows.length > q.data.limit ? page[page.length - 1]!.createdAt.toISOString() : null, transitions: ENDPOINT_EXCEPTION_TRANSITIONS };
  });

  /** Load, check the lifecycle table, and apply one transition as a conditional update. */
  async function transition(req: FastifyRequest, reply: FastifyReply, action: EndpointExceptionAction): Promise<{ row: ExceptionRow; now: Date } | null> {
    const p = id("exceptionId").safeParse(req.params);
    if (!p.success) {
      await refuse(reply, 400, "invalid_request", "exceptionId must be a uuid");
      return null;
    }
    const [row] = await db.select().from(endpointCommandExceptions).where(eq(endpointCommandExceptions.id, p.data.exceptionId as string));
    if (!row) {
      await refuse(reply, 404, "not_found", "no such exception");
      return null;
    }
    const now = await dbNow(db);
    const refusal = endpointExceptionTransitionRefusal(endpointExceptionState({ status: row.status, notAfter: row.notAfter }, now), action);
    if (refusal) {
      await refuse(reply, 409, "invalid_transition", refusal);
      return null;
    }
    return { row, now };
  }

  app.post("/v1/endpoint-command-exceptions/:exceptionId/approve", async (req, reply) => {
    const b = decideBody.safeParse(req.body ?? {});
    if (!b.success) return refuse(reply, 400, "invalid_body", issues(b.error));
    const t = await transition(req, reply, "approve");
    if (!t) return reply;
    const { row } = t;
    const decider = actor(req);
    if (!decider || decider === row.requestedBy || decider !== row.approverUserId) return refuse(reply, 403, "caller_cannot_approve", "only the named approver, who is not the requester, may approve");
    if (b.data.termsDigest !== row.termsDigest) return refuse(reply, 409, "terms_changed", "the approval names different terms from the request");
    const steps: StepUpCheckArgs[] = [{ kind: "approval_decide", facts: { endpointCommandException: row.id, termsDigest: row.termsDigest } }];
    // longer than the default maximum is a relaxation of its own
    if (row.hours > ENDPOINT_EXCEPTION_DEFAULT_MAX_HOURS) steps.push({ kind: "settings_relax", facts: { values: { endpointCommandExceptionHours: { exception: row.id, hours: row.hours } } } });
    if (!(await requireStepUps(db, req, reply, steps))) return reply;
    const [done] = await db
      .update(endpointCommandExceptions)
      .set({ status: "approved", decidedBy: decider, decidedAt: sql`now()`, decisionReason: b.data.decisionReason ?? null, notAfter: sql`now() + make_interval(hours => ${row.hours})` })
      .where(and(eq(endpointCommandExceptions.id, row.id), eq(endpointCommandExceptions.status, "requested"), eq(endpointCommandExceptions.termsDigest, row.termsDigest)))
      .returning();
    if (!done) return refuse(reply, 409, "invalid_transition", "the exception was decided concurrently");
    await audit(db, decider, "endpoint_command_exception", row.id, "endpoint-command-exception.approve", "exception approved", { termsDigest: row.termsDigest, notAfter: done.notAfter?.toISOString(), hours: row.hours });
    return reply.send(view(done, await dbNow(db)));
  });

  app.post("/v1/endpoint-command-exceptions/:exceptionId/reject", async (req, reply) => {
    const b = reasonBody.safeParse(req.body ?? {});
    if (!b.success) return refuse(reply, 400, "invalid_body", issues(b.error));
    const t = await transition(req, reply, "reject");
    if (!t) return reply;
    const decider = actor(req);
    if (!decider || decider === t.row.requestedBy) return refuse(reply, 403, "caller_cannot_decide", "the requester cannot reject their own request; cancel it instead");
    const [done] = await db
      .update(endpointCommandExceptions)
      .set({ status: "rejected", decidedBy: decider, decidedAt: sql`now()`, decisionReason: b.data.reason })
      .where(and(eq(endpointCommandExceptions.id, t.row.id), eq(endpointCommandExceptions.status, "requested")))
      .returning();
    if (!done) return refuse(reply, 409, "invalid_transition", "the exception was decided concurrently");
    await audit(db, decider, "endpoint_command_exception", t.row.id, "endpoint-command-exception.reject", "exception rejected", { reason: b.data.reason });
    return reply.send(view(done, await dbNow(db)));
  });

  app.post("/v1/endpoint-command-exceptions/:exceptionId/cancel", async (req, reply) => {
    const t = await transition(req, reply, "cancel");
    if (!t) return reply;
    const caller = actor(req);
    if (caller !== t.row.requestedBy) return refuse(reply, 403, "caller_cannot_cancel", "only the requester may cancel a request");
    const [done] = await db
      .update(endpointCommandExceptions)
      .set({ status: "cancelled", decidedBy: caller, decidedAt: sql`now()` })
      .where(and(eq(endpointCommandExceptions.id, t.row.id), eq(endpointCommandExceptions.status, "requested")))
      .returning();
    if (!done) return refuse(reply, 409, "invalid_transition", "the exception was decided concurrently");
    await audit(db, caller, "endpoint_command_exception", t.row.id, "endpoint-command-exception.cancel", "exception request cancelled", {});
    return reply.send(view(done, await dbNow(db)));
  });

  app.post("/v1/endpoint-command-exceptions/:exceptionId/revoke", async (req, reply) => {
    const b = reasonBody.safeParse(req.body ?? {});
    if (!b.success) return refuse(reply, 400, "invalid_body", issues(b.error));
    const t = await transition(req, reply, "revoke");
    if (!t) return reply;
    // revoking tightens, so it needs no step-up; the device stops applying it on its next policy
    const [done] = await db
      .update(endpointCommandExceptions)
      .set({ status: "revoked", revokedBy: actor(req), revokedAt: sql`now()` })
      .where(and(eq(endpointCommandExceptions.id, t.row.id), eq(endpointCommandExceptions.status, "approved"), sql`${endpointCommandExceptions.notAfter} > now()`, isNull(endpointCommandExceptions.revokedAt)))
      .returning();
    if (!done) return refuse(reply, 409, "invalid_transition", "the exception expired or was revoked concurrently");
    await audit(db, actor(req), "endpoint_command_exception", t.row.id, "endpoint-command-exception.revoke", "exception revoked", { reason: b.data.reason });
    return reply.send(view(done, await dbNow(db)));
  });
}
