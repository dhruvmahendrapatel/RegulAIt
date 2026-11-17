/**
 * ADR-0353 part 1 — the admin routes of governed OpenAPI tool sources (admin-only by the global gate; none is in
 * NON_ADMIN_ROUTES; the screens are tracked on #453).
 *
 *   POST /v1/openapi-tool-sources                                         import: server + source + staged operations
 *   GET  /v1/openapi-tool-sources                                         list, paginated
 *   GET  /v1/openapi-tool-sources/:sourceId                               one source, its operations and allowed events
 *   POST /v1/openapi-tool-sources/:sourceId/reimport                      re-import: the per-operation transitions
 *   POST /v1/openapi-tool-sources/:sourceId/operations/:operationId/:event   approve | reject | revoke
 *
 * Every state change goes through `nextOperationState` (the declared table in @regulait/shared) and writes one audit
 * row in the transaction that makes it. Approve is a compare-and-set on the digest the admin reviewed, needs a
 * `settings_relax` step-up bound to it (it widens what can be called), and approves the ADR-0246 pin of that tool at
 * the same digest, so one review is enough.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  and,
  asc,
  auditLog,
  count,
  eq,
  inArray,
  mcpDefinitionPins,
  mcpServers,
  openapiToolOperations,
  openapiToolSources,
  sql,
  type Db,
  type OpenapiToolOperationRow,
} from "@regulait/db";
import {
  allowedOperationEvents,
  decideOpenApiOperationSchema,
  importOpenApiToolSourceSchema,
  mcpOpenApiSentinelUrl,
  nextOperationState,
  OPENAPI_OPERATION_ADMIN_EVENTS,
  pinnableDefinition,
  planOpenApiReimport,
  reimportOpenApiToolSourceSchema,
  type OpenApiOperationDefinition,
  type OpenApiOperationEvent,
  type OpenApiOperationState,
} from "@regulait/shared";
import { REGISTRATION_ADMISSION_STATE } from "./mcp-admission.js";
import { checkMcpTransportWrite, refuseMcpServerWrite } from "./mcp-egress.js";
import { refuseIfExpansionBlocked } from "./licensing.js";
import { resolveRegistrationOwner } from "./ownership.js";
import { requireStepUp } from "./step-up.js";
import { generateOpenApiOperations, OpenApiImportError, type GeneratedSource } from "./openapi-tools.js";

const NIL_USER = "00000000-0000-0000-0000-000000000000";
const PAGE_MAX = 200;
const pageQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(PAGE_MAX).default(50),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .strict();
const sourceParam = z.object({ sourceId: z.string().uuid() }).strict();
const operationParam = z
  .object({ sourceId: z.string().uuid(), operationId: z.string().uuid(), event: z.enum(OPENAPI_OPERATION_ADMIN_EVENTS) })
  .strict();

export const OPENAPI_RULE_IDS = {
  imported: "openapi-tool-source-imported",
  reimported: "openapi-tool-source-reimported",
  transition: (event: OpenApiOperationEvent) => `openapi-operation-${event.replace(/_/g, "-")}`,
  staged: "openapi-operation-staged",
} as const;

type Tx = Db;

function invalid(reply: FastifyReply, err: z.ZodError) {
  // the issue list can quote a whole document back: paths and messages only
  return reply.status(400).send({
    error: "invalid_request",
    issues: err.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })),
  });
}

/** the operation as the API shows it: its state, the events it allows, both definitions and their digests */
function operationView(op: OpenapiToolOperationRow) {
  const state = op.state as OpenApiOperationState;
  return {
    id: op.id,
    operationKey: op.operationKey,
    toolName: op.toolName,
    state,
    served: state === "approved",
    allowedEvents: allowedOperationEvents(state),
    importedDigest: op.importedDigest,
    approvedDigest: op.approvedDigest,
    imported: op.importedDefinition,
    approved: op.approvedDefinition,
    decidedBy: op.decidedBy,
    decidedAt: op.decidedAt,
    stateChangedAt: op.stateChangedAt,
  };
}

async function auditTransition(
  tx: Tx,
  args: {
    actor: string | null;
    serverId: string;
    sourceId: string;
    op: { id: string; operationKey: string; toolName: string };
    event: OpenApiOperationEvent | "import";
    from: OpenApiOperationState | null;
    to: OpenApiOperationState;
    digest: string | null;
    reason?: string | undefined;
    via?: unknown;
  },
) {
  await tx.insert(auditLog).values({
    userId: args.actor ?? NIL_USER,
    serverId: args.serverId,
    toolName: args.op.toolName,
    objectType: "mcp_tool",
    objectId: args.op.id,
    detail: {
      phase: "openapi-operation",
      sourceId: args.sourceId,
      operationKey: args.op.operationKey,
      event: args.event,
      from: args.from,
      to: args.to,
      digest: args.digest,
      ...(args.reason ? { note: args.reason } : {}),
      ...(args.via !== undefined ? { via: args.via } : {}),
    },
    effect: args.to === "approved" ? "allow" : args.from === "approved" ? "deny" : "allow",
    ruleId: args.event === "import" ? OPENAPI_RULE_IDS.staged : OPENAPI_RULE_IDS.transition(args.event),
    ruleChain: [],
    reason:
      `OpenAPI operation ${args.op.operationKey} (tool '${args.op.toolName}'): ` +
      (args.from ? `${args.from} -> ${args.to}` : `staged for approval`) +
      (args.to === "approved" ? ", now served" : args.from === "approved" ? ", no longer served" : ", not served"),
  });
}

async function generateOr422(
  reply: FastifyReply,
  input: { spec?: string | undefined; endpoints?: Parameters<typeof generateOpenApiOperations>[0]["endpoints"] },
  title: string,
): Promise<GeneratedSource | null> {
  try {
    const generated = await generateOpenApiOperations(
      input.spec !== undefined ? { spec: input.spec } : { endpoints: input.endpoints ?? [] },
      title,
    );
    if (generated.operations.length === 0) {
      await reply.status(422).send({
        error: "openapi_no_servable_operations",
        detail: "no operation in the document can be served as a governed tool. Nothing was saved.",
        skipped: generated.skipped,
      });
      return null;
    }
    return generated;
  } catch (err) {
    if (err instanceof OpenApiImportError) {
      await reply.status(422).send({ error: "openapi_document_invalid", detail: `${err.detail}. Nothing was saved.` });
      return null;
    }
    throw err;
  }
}

/** approve the ADR-0246 pin of `definition`'s tool at the digest the in-process server will serve */
async function approveDefinitionPin(tx: Tx, serverId: string, definition: OpenApiOperationDefinition, actor: string | null) {
  const [server] = await tx.select({ pinnedAt: mcpServers.definitionsPinnedAt }).from(mcpServers).where(eq(mcpServers.id, serverId));
  // before the admission baseline there is nothing to approve: the baseline pins what is served then
  if (!server?.pinnedAt) return;
  const pin = pinnableDefinition("tool", definition.tool);
  if (!pin) return;
  const values = {
    approvedDigest: pin.digest,
    approvedDefinition: pin.definition,
    approvedBy: actor,
    approvedAt: sql`now()`,
    observedDigest: pin.digest,
    observedDefinition: pin.definition,
    observedAt: sql`now()`,
    changedAt: null,
  };
  await tx
    .insert(mcpDefinitionPins)
    .values({ serverId, kind: "tool", name: pin.name, ...values })
    .onConflictDoUpdate({ target: [mcpDefinitionPins.serverId, mcpDefinitionPins.kind, mcpDefinitionPins.name], set: values });
}

export function registerOpenApiToolRoutes(app: FastifyInstance, db: Db): void {
  app.post("/v1/openapi-tool-sources", async (req: FastifyRequest, reply) => {
    const parsed = importOpenApiToolSourceSchema.safeParse(req.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const body = parsed.data;
    const actor = req.authCtx.userId ?? null;
    const label = `MCP server '${body.name}'`;
    // the transport rule first (off until an admin enables 'openapi'), exactly as POST /v1/servers
    const transportCheck = await checkMcpTransportWrite(db, { transport: "openapi", userId: actor, phase: "registration", label, viaOpenApiImport: true });
    if (!transportCheck.ok) return reply.status(transportCheck.status).send(transportCheck.body);
    const licenseRefusal = await refuseIfExpansionBlocked(db, { actorUserId: actor, objectType: "mcp_server", what: `importing OpenAPI tools as '${body.name}'` });
    if (licenseRefusal) return reply.status(licenseRefusal.status).send(licenseRefusal.body);
    const owner = await resolveRegistrationOwner(db, { actorUserId: actor, requested: body.ownerUserId });
    if (!owner.ok) return reply.status(owner.status).send(owner.body);
    const [taken] = await db.select({ id: mcpServers.id }).from(mcpServers).where(eq(mcpServers.name, body.name));
    if (taken) return reply.status(409).send({ error: "conflict", detail: `an MCP server named '${body.name}' already exists` });
    // the base URL is the admin's and goes behind the egress guard at write time (re-checked on every connect)
    const egress = await refuseMcpServerWrite(db, {
      url: body.baseUrl,
      allowPrivateRanges: body.allowPrivateRanges ?? null,
      userId: actor,
      phase: "registration",
      label: `${label} base URL`,
    });
    if (egress) return reply.status(400).send(egress);
    const generated = await generateOr422(reply, body, body.name);
    if (!generated) return reply;
    let rangesStepUp: string | null = null;
    if (body.allowPrivateRanges === true) {
      const su = await requireStepUp(db, req, reply, {
        kind: "settings_relax",
        facts: { op: "mcp_server_create", name: body.name, url: body.baseUrl, values: { allowPrivateRanges: true } },
      });
      if (!su.ok) return reply;
      rangesStepUp = su.method;
    }
    const out = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Tx;
      const [server] = await tx
        .insert(mcpServers)
        .values({
          name: body.name,
          url: mcpOpenApiSentinelUrl(body.name),
          transport: "openapi",
          allowPrivateRanges: body.allowPrivateRanges ?? null,
          ownerUserId: owner.ownerUserId,
          admissionState: REGISTRATION_ADMISSION_STATE,
        })
        .returning({ id: mcpServers.id });
      const [source] = await tx
        .insert(openapiToolSources)
        .values({
          mcpServerId: server!.id,
          baseUrl: body.baseUrl,
          sourceKind: generated.sourceKind,
          specTitle: generated.title,
          specVersion: generated.version,
          specDigest: generated.specDigest,
          importedBy: actor,
        })
        .returning();
      const ops = await tx
        .insert(openapiToolOperations)
        .values(
          generated.operations.map((o) => ({
            sourceId: source!.id,
            operationKey: o.operationKey,
            toolName: o.toolName,
            state: "staged" as const,
            importedDefinition: o.definition,
            importedDigest: o.digest,
          })),
        )
        .returning();
      await tx.insert(auditLog).values({
        userId: actor ?? NIL_USER,
        serverId: server!.id,
        objectType: "mcp_server",
        objectId: server!.id,
        detail: {
          phase: "registration",
          transport: "openapi",
          sourceId: source!.id,
          baseUrl: body.baseUrl,
          sourceKind: generated.sourceKind,
          specDigest: generated.specDigest,
          staged: ops.length,
          skipped: generated.skipped,
          allowPrivateRanges: body.allowPrivateRanges ?? null,
          ...(rangesStepUp ? { relaxed: { allowPrivateRanges: true }, stepUp: rangesStepUp } : {}),
        },
        effect: "allow",
        ruleId: OPENAPI_RULE_IDS.imported,
        ruleChain: [],
        reason:
          `${label} registered as an OpenAPI tool source for ${body.baseUrl}: ${ops.length} operation(s) staged for ` +
          `approval, ${generated.skipped.length} skipped. Nothing is served until an admin approves an operation.`,
      });
      for (const op of ops) {
        await auditTransition(tx, { actor, serverId: server!.id, sourceId: source!.id, op, event: "import", from: null, to: "staged", digest: op.importedDigest });
      }
      return { serverId: server!.id, source: source!, ops };
    });
    return reply.status(201).send({
      ...out.source,
      serverId: out.serverId,
      operations: out.ops.map(operationView),
      skipped: generated.skipped,
    });
  });

  app.get("/v1/openapi-tool-sources", async (req) => {
    const q = pageQuery.parse(req.query ?? {});
    const rows = await db
      .select({
        id: openapiToolSources.id,
        serverId: openapiToolSources.mcpServerId,
        serverName: mcpServers.name,
        baseUrl: openapiToolSources.baseUrl,
        sourceKind: openapiToolSources.sourceKind,
        specTitle: openapiToolSources.specTitle,
        specVersion: openapiToolSources.specVersion,
        importedAt: openapiToolSources.importedAt,
      })
      .from(openapiToolSources)
      .innerJoin(mcpServers, eq(mcpServers.id, openapiToolSources.mcpServerId))
      .orderBy(asc(mcpServers.name))
      .limit(q.limit + 1)
      .offset(q.offset);
    const page = rows.slice(0, q.limit);
    const counts = page.length
      ? await db
          .select({ sourceId: openapiToolOperations.sourceId, state: openapiToolOperations.state, n: count() })
          .from(openapiToolOperations)
          .where(inArray(openapiToolOperations.sourceId, page.map((r) => r.id)))
          .groupBy(openapiToolOperations.sourceId, openapiToolOperations.state)
      : [];
    return {
      sources: page.map((r) => ({
        ...r,
        operationsByState: Object.fromEntries(counts.filter((c) => c.sourceId === r.id).map((c) => [c.state, Number(c.n)])),
      })),
      hasMore: rows.length > q.limit,
    };
  });

  app.get("/v1/openapi-tool-sources/:sourceId", async (req, reply) => {
    const { sourceId } = sourceParam.parse(req.params);
    const [source] = await db.select().from(openapiToolSources).where(eq(openapiToolSources.id, sourceId));
    if (!source) return reply.status(404).send({ error: "unknown_openapi_tool_source" });
    const ops = await db
      .select()
      .from(openapiToolOperations)
      .where(eq(openapiToolOperations.sourceId, sourceId))
      .orderBy(asc(openapiToolOperations.operationKey));
    return { ...source, serverId: source.mcpServerId, operations: ops.map(operationView) };
  });

  app.post("/v1/openapi-tool-sources/:sourceId/reimport", async (req, reply) => {
    const { sourceId } = sourceParam.parse(req.params);
    const parsed = reimportOpenApiToolSourceSchema.safeParse(req.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const [source] = await db
      .select({ id: openapiToolSources.id, serverId: openapiToolSources.mcpServerId, name: mcpServers.name })
      .from(openapiToolSources)
      .innerJoin(mcpServers, eq(mcpServers.id, openapiToolSources.mcpServerId))
      .where(eq(openapiToolSources.id, sourceId));
    if (!source) return reply.status(404).send({ error: "unknown_openapi_tool_source" });
    const generated = await generateOr422(reply, parsed.data, source.name);
    if (!generated) return reply;
    const actor = req.authCtx.userId ?? null;
    const out = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Tx;
      // one re-import or decision at a time per source
      await tx.select({ id: openapiToolSources.id }).from(openapiToolSources).where(eq(openapiToolSources.id, sourceId)).for("update");
      const stored = await tx.select().from(openapiToolOperations).where(eq(openapiToolOperations.sourceId, sourceId));
      const plan = planOpenApiReimport(
        stored.map((s) => ({ id: s.id, operationKey: s.operationKey, state: s.state as OpenApiOperationState, importedDigest: s.importedDigest, approvedDigest: s.approvedDigest })),
        generated.operations.map((o) => ({ operationKey: o.operationKey, digest: o.digest })),
      );
      const byKey = new Map(generated.operations.map((o) => [o.operationKey, o]));
      const storedById = new Map(stored.map((s) => [s.id, s]));
      const transitions: Array<{ operationKey: string; event: string; from: string | null; to: string }> = [];
      for (const m of plan.moved) {
        const next = byKey.get(m.operationKey);
        const before = storedById.get(m.id)!;
        await tx
          .update(openapiToolOperations)
          .set({
            state: m.to,
            stateChangedAt: sql`now()`,
            ...(next ? { importedDefinition: next.definition, importedDigest: next.digest, toolName: next.toolName } : {}),
          })
          .where(and(eq(openapiToolOperations.id, m.id), eq(openapiToolOperations.state, m.from)));
        await auditTransition(tx, { actor, serverId: source.serverId, sourceId, op: before, event: m.event, from: m.from, to: m.to, digest: m.digest });
        transitions.push({ operationKey: m.operationKey, event: m.event, from: m.from, to: m.to });
      }
      for (const a of plan.added) {
        const o = byKey.get(a.operationKey)!;
        const [row] = await tx
          .insert(openapiToolOperations)
          .values({ sourceId, operationKey: o.operationKey, toolName: o.toolName, state: "staged", importedDefinition: o.definition, importedDigest: o.digest })
          .returning();
        await auditTransition(tx, { actor, serverId: source.serverId, sourceId, op: row!, event: "import", from: null, to: "staged", digest: o.digest });
        transitions.push({ operationKey: o.operationKey, event: "import", from: null, to: "staged" });
      }
      await tx
        .update(openapiToolSources)
        .set({ specDigest: generated.specDigest, specTitle: generated.title, specVersion: generated.version, sourceKind: generated.sourceKind, importedBy: actor, importedAt: sql`now()` })
        .where(eq(openapiToolSources.id, sourceId));
      await tx.insert(auditLog).values({
        userId: actor ?? NIL_USER,
        serverId: source.serverId,
        objectType: "mcp_server",
        objectId: source.serverId,
        detail: { phase: "openapi-reimport", sourceId, specDigest: generated.specDigest, transitions: transitions.length, unchanged: plan.unchanged.length, skipped: generated.skipped },
        effect: "allow",
        ruleId: OPENAPI_RULE_IDS.reimported,
        ruleChain: [],
        reason:
          `MCP server '${source.name}': OpenAPI source re-imported, ${transitions.length} operation(s) moved, ` +
          `${plan.unchanged.length} unchanged. A changed approved operation is withheld until it is approved again.`,
      });
      return { transitions, unchanged: plan.unchanged.length };
    });
    const ops = await db.select().from(openapiToolOperations).where(eq(openapiToolOperations.sourceId, sourceId)).orderBy(asc(openapiToolOperations.operationKey));
    return reply.send({ sourceId, ...out, skipped: generated.skipped, operations: ops.map(operationView) });
  });

  app.post("/v1/openapi-tool-sources/:sourceId/operations/:operationId/:event", async (req, reply) => {
    const { sourceId, operationId, event } = operationParam.parse(req.params);
    const parsed = decideOpenApiOperationSchema.safeParse(req.body ?? {});
    if (!parsed.success) return invalid(reply, parsed.error);
    const body = parsed.data;
    const [op] = await db
      .select()
      .from(openapiToolOperations)
      .where(and(eq(openapiToolOperations.id, operationId), eq(openapiToolOperations.sourceId, sourceId)));
    if (!op) return reply.status(404).send({ error: "unknown_openapi_operation" });
    const from = op.state as OpenApiOperationState;
    const to = nextOperationState(from, event);
    if (!to) {
      return reply.status(409).send({
        error: "openapi_operation_transition_refused",
        detail: `an operation in state '${from}' cannot be '${event}'d (allowed: ${allowedOperationEvents(from).join(", ") || "none"}). Nothing changed.`,
        state: from,
        allowedEvents: allowedOperationEvents(from),
      });
    }
    if (event === "approve") {
      if (!body.definitionDigest) {
        return reply.status(400).send({ error: "definition_digest_required", detail: "approve names the importedDigest of the definition reviewed. Nothing changed." });
      }
      if (body.definitionDigest !== op.importedDigest) {
        return reply.status(409).send({ error: "openapi_operation_stale", detail: "the operation's definition changed after it was reviewed. Nothing changed; reload it." });
      }
      // approving widens what can be called: a settings_relax step-up bound to this exact definition
      const su = await requireStepUp(db, req, reply, {
        kind: "settings_relax",
        facts: { sourceId, values: { openapiOperationApproved: [operationId, body.definitionDigest] } },
      });
      if (!su.ok) return reply;
    }
    const actor = req.authCtx.userId ?? null;
    const [source] = await db.select({ serverId: openapiToolSources.mcpServerId }).from(openapiToolSources).where(eq(openapiToolSources.id, sourceId));
    const result = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Tx;
      await tx.select({ id: openapiToolSources.id }).from(openapiToolSources).where(eq(openapiToolSources.id, sourceId)).for("update");
      // compare-and-set on the state (and, for approve, the digest) this request was decided on
      const where = and(
        eq(openapiToolOperations.id, operationId),
        eq(openapiToolOperations.state, from),
        event === "approve" ? eq(openapiToolOperations.importedDigest, body.definitionDigest!) : undefined,
      );
      if (event === "approve") {
        const [clash] = await tx
          .select({ id: openapiToolOperations.id })
          .from(openapiToolOperations)
          .where(and(eq(openapiToolOperations.sourceId, sourceId), eq(openapiToolOperations.toolName, op.toolName), eq(openapiToolOperations.state, "approved")));
        if (clash) return { ok: false as const, status: 409, error: "openapi_tool_name_served", detail: `another approved operation already serves the tool '${op.toolName}'. Nothing changed.` };
      }
      const [updated] = await tx
        .update(openapiToolOperations)
        .set({
          state: to,
          stateChangedAt: sql`now()`,
          decidedBy: actor,
          decidedAt: sql`now()`,
          ...(event === "approve" ? { approvedDefinition: op.importedDefinition, approvedDigest: op.importedDigest } : {}),
        })
        .where(where)
        .returning();
      if (!updated) return { ok: false as const, status: 409, error: "openapi_operation_stale", detail: "the operation changed while this was decided. Nothing changed; reload it." };
      if (event === "approve") await approveDefinitionPin(tx, source!.serverId, op.importedDefinition as OpenApiOperationDefinition, actor);
      await auditTransition(tx, { actor, serverId: source!.serverId, sourceId, op, event, from, to, digest: op.importedDigest, reason: body.reason, via: req.authCtx.via });
      return { ok: true as const, op: updated };
    });
    if (!result.ok) return reply.status(result.status).send({ error: result.error, detail: result.detail });
    return reply.send(operationView(result.op));
  });
}
