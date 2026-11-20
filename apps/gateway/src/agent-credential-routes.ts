/**
 * ADR-0315 (G7, slice 1): the agent credential issuer's public metadata and the admin registry of audiences.
 *
 *   GET  /agent-credentials/.well-known/openid-configuration   public: issuer, jwks_uri, the verifier's checks
 *   GET  /agent-credentials/.well-known/jwks.json              public: the ES256 and Ed25519 public halves (active, and
 *                                                              retired inside their overlap; never a revoked key)
 *   GET  /v1/agent-credentials/audiences                       admin: the registered audiences and their scope maps
 *   POST /v1/agent-credentials/audiences                       admin, `settings_relax` step-up bound to the WHOLE
 *                                                              registration (audience, algorithm, binding, lifetime,
 *                                                              scope map); audited
 *   POST /v1/agent-credentials/audiences/:audienceId/disable   admin, free (tightening), audited
 *   GET  /agent-credentials/status/:listId                     public (slice 2): the signed IETF Token Status List
 *   GET  /v1/agent-credentials/issued                          admin: issued credentials, newest first, paginated
 *   POST /v1/agent-credentials/issued/:jti/revoke              admin, free (tightening), audited
 *
 * Default-deny: no audience, no credential. Issuance itself is the token endpoint's (slice 1b); this module never
 * mints. The public routes are listed in route-classes.ts (auth-exempt and NON_ADMIN) like the other issuers' metadata.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  AGENT_CREDENTIAL_DISCOVERY_PATH,
  AGENT_CREDENTIAL_JWKS_PATH,
  AGENT_CREDENTIAL_STATUS_LIST_ID,
  AGENT_CREDENTIAL_STATUS_PATH,
  AGENT_CREDENTIAL_STEP_UP_KEY,
  AGENT_CREDENTIAL_TTL_DEFAULT_SECONDS,
  agentCredentialAudienceCreateSchema,
  agentCredentialDiscoveryDocument,
  type AgentCredentialAudienceCreate,
} from "@regulait/shared";
import { agentCredentialAudiences, and, agentCredentialAudienceScopes, agentCredentialsIssued, agents, auditLog, connectors, desc, eq, inArray, isNull, lt, mcpServers, sql, type Db } from "@regulait/db";
import {
  AUDIENCE_TRANSITIONS,
  agentCredentialIssuer,
  agentCredentialStatusList,
  audienceIssues,
  audienceState,
  issuedCredentialState,
  revokeAgentCredential,
} from "./agent-credential.js";
import { jwksDocument, publishedSigningKeys } from "./identity-signing-keys.js";
import { requireStepUp } from "./step-up.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const audienceParam = z.object({ audienceId: z.string().uuid() }).strict();
const listParam = z.object({ listId: z.string().regex(AGENT_CREDENTIAL_STATUS_LIST_ID) }).strict();
const jtiParam = z.object({ jti: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const revokeBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const issuedQuery = z
  .object({
    audienceId: z.string().uuid().optional(),
    grantId: z.string().uuid().optional(),
    /** the `statusIndex` of the last row of the previous page */
    before: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
const STATUS_ERRORS = {
  issuer_not_configured: { status: 404, detail: "the agent credential issuer needs REGULAIT_PUBLIC_URL" },
  unknown_list: { status: 404, detail: "no such status list" },
  signing_key_unavailable: { status: 503, detail: "no active ES256 signing key" },
} as const;

/** the step-up an audience registration needs: bound to all of it, so a grant for one registration cannot make another */
export function agentCredentialAudienceStepUpArgs(body: AgentCredentialAudienceCreate) {
  return {
    kind: "settings_relax" as const,
    facts: {
      values: {
        [AGENT_CREDENTIAL_STEP_UP_KEY]: {
          audience: body.audience,
          algorithm: body.algorithm,
          binding: body.binding,
          maxTtlSeconds: body.maxTtlSeconds,
          scopes: [...body.scopes].map((s) => JSON.stringify(s)).sort(),
        },
      },
    },
  };
}

export function registerAgentCredentialRoutes(app: FastifyInstance, db: Db): void {
  const badRequest = (reply: FastifyReply, err: z.ZodError) =>
    reply.status(400).send({ error: "invalid_request", detail: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
  const actor = (req: FastifyRequest) => req.authCtx.userId ?? NIL_UUID;

  app.get(AGENT_CREDENTIAL_DISCOVERY_PATH, async (_req, reply) => {
    const issuer = agentCredentialIssuer();
    if (!issuer) return reply.status(404).send({ error: "issuer_not_configured", detail: "the agent credential issuer needs REGULAIT_PUBLIC_URL" });
    return reply.header("cache-control", "public, max-age=300").type("application/json").send(JSON.stringify(agentCredentialDiscoveryDocument(issuer)));
  });
  // short cache: a key revocation must reach verifiers quickly
  app.get(AGENT_CREDENTIAL_JWKS_PATH, async (_req, reply) => {
    const es = jwksDocument(await publishedSigningKeys(db, undefined, "ES256")).keys;
    const ed = jwksDocument(await publishedSigningKeys(db, undefined, "Ed25519")).keys;
    return reply.header("cache-control", "public, max-age=60").type("application/jwk-set+json").send(JSON.stringify({ keys: [...es, ...ed] }));
  });

  // public, signed, short-lived: the cache bounds what an unauthenticated GET costs (one computation per replica per
  // AGENT_CREDENTIAL_STATUS_CACHE_SECONDS); a verifier refetches within the list's own `ttl`
  app.get(AGENT_CREDENTIAL_STATUS_PATH, async (req, reply) => {
    const p = listParam.safeParse(req.params);
    if (!p.success) return reply.status(404).send({ error: "unknown_list", detail: "no such status list" });
    const out = await agentCredentialStatusList(db, Number(p.data.listId));
    if (!out.ok) return reply.status(STATUS_ERRORS[out.code].status).send({ error: out.code, detail: STATUS_ERRORS[out.code].detail });
    return reply.header("cache-control", "public, max-age=10").type("application/statuslist+jwt").send(out.token);
  });

  app.get("/v1/agent-credentials/issued", async (req, reply) => {
    const q = issuedQuery.safeParse(req.query ?? {});
    if (!q.success) return badRequest(reply, q.error);
    const { audienceId, grantId, before, limit } = q.data;
    const rows = await db
      .select()
      .from(agentCredentialsIssued)
      .where(
        and(
          audienceId ? eq(agentCredentialsIssued.audienceId, audienceId) : undefined,
          grantId ? eq(agentCredentialsIssued.grantId, grantId) : undefined,
          before ? lt(agentCredentialsIssued.statusIndex, before) : undefined,
        ),
      )
      .orderBy(desc(agentCredentialsIssued.statusIndex))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const now = Date.now();
    return {
      credentials: page.map((r) => ({
        jti: r.jti,
        audienceId: r.audienceId,
        grantId: r.grantId,
        statusIndex: r.statusIndex,
        state: issuedCredentialState(r),
        expired: r.expiresAt.getTime() <= now,
        issuedAt: r.issuedAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
        revokedAt: r.revokedAt?.toISOString() ?? null,
      })),
      next: rows.length > limit ? page[page.length - 1]!.statusIndex : null,
    };
  });

  app.post("/v1/agent-credentials/issued/:jti/revoke", async (req, reply) => {
    const p = jtiParam.safeParse(req.params);
    if (!p.success) return badRequest(reply, p.error);
    const b = revokeBody.safeParse(req.body ?? {});
    if (!b.success) return badRequest(reply, b.error);
    const out = await revokeAgentCredential(db, { jti: p.data.jti, actorUserId: actor(req), reason: b.data.reason });
    if (!out) return reply.status(404).send({ error: "unknown_credential", detail: "no unrevoked credential with that jti" });
    return { jti: out.jti, state: "revoked", revokedAt: out.revokedAt.toISOString() };
  });

  app.get("/v1/agent-credentials/audiences", async () => {
    const rows = await db.select().from(agentCredentialAudiences).orderBy(desc(agentCredentialAudiences.createdAt)).limit(500);
    const scopes = rows.length
      ? await db.select().from(agentCredentialAudienceScopes).where(inArray(agentCredentialAudienceScopes.audienceId, rows.map((r) => r.id)))
      : [];
    return {
      audiences: rows.map((r) => ({
        id: r.id,
        audience: r.audience,
        name: r.name,
        algorithm: r.algorithm,
        binding: r.binding,
        maxTtlSeconds: r.maxTtlSeconds,
        state: audienceState(r),
        enabled: audienceIssues(r),
        disabledAt: r.disabledAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
        scopes: scopes
          .filter((s) => s.audienceId === r.id)
          .map((s) => ({ type: s.resourceType, serverId: s.serverId, toolName: s.toolName, connectorId: s.connectorId, agentId: s.agentId, kind: s.kind, scope: s.scope })),
      })),
    };
  });

  app.post("/v1/agent-credentials/audiences", async (req, reply) => {
    const parsed = agentCredentialAudienceCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(reply, parsed.error);
    const body = parsed.data;
    // every referenced resource must exist (checked before the step-up is spent)
    const ids = (t: string, k: "serverId" | "connectorId" | "agentId") => [...new Set(body.scopes.filter((s) => s.type === t).map((s) => (s as Record<string, string>)[k]!))];
    const [srv, con, agt] = [ids("mcp_tool", "serverId"), ids("connector", "connectorId"), ids("agent", "agentId")];
    const found = async (table: typeof mcpServers | typeof connectors | typeof agents, list: string[]) =>
      list.length ? (await db.select({ id: table.id }).from(table).where(inArray(table.id, list))).length === list.length : true;
    if (!(await found(mcpServers, srv)) || !(await found(connectors, con)) || !(await found(agents, agt))) {
      return reply.status(400).send({ error: "unknown_resource", detail: "a scope mapping names a server, connector or agent that does not exist" });
    }
    const [taken] = await db.select({ id: agentCredentialAudiences.id }).from(agentCredentialAudiences).where(and(eq(agentCredentialAudiences.audience, body.audience), isNull(agentCredentialAudiences.disabledAt)));
    if (taken) return reply.status(409).send({ error: "conflict", detail: "this audience is already registered and enabled" });
    const su = await requireStepUp(db, req, reply, agentCredentialAudienceStepUpArgs(body));
    if (!su.ok) return reply;
    const relaxations = [...(body.binding === "bearer" ? ["bearer"] : []), ...(body.maxTtlSeconds > AGENT_CREDENTIAL_TTL_DEFAULT_SECONDS ? ["lifetime"] : [])];
    const id = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(agentCredentialAudiences)
        .values({ audience: body.audience, name: body.name, algorithm: body.algorithm, binding: body.binding, maxTtlSeconds: body.maxTtlSeconds, createdByUserId: req.authCtx.userId ?? null })
        .returning({ id: agentCredentialAudiences.id });
      await tx.insert(agentCredentialAudienceScopes).values(
        body.scopes.map((s) => ({
          audienceId: row!.id,
          resourceType: s.type,
          serverId: s.type === "mcp_tool" ? s.serverId : null,
          toolName: s.type === "mcp_tool" ? s.toolName : null,
          connectorId: s.type === "connector" ? s.connectorId : null,
          agentId: s.type === "agent" ? s.agentId : null,
          kind: s.kind,
          scope: s.scope,
        })),
      );
      await tx.insert(auditLog).values({
        userId: actor(req),
        objectType: "agent_credential_audience",
        objectId: row!.id,
        detail: { subsystem: "agent-credential", audience: body.audience, algorithm: body.algorithm, binding: body.binding, maxTtlSeconds: body.maxTtlSeconds, scopes: body.scopes.length, relaxations, stepUp: su.method },
        effect: "allow",
        ruleId: relaxations.length ? "agent-credential-audience-registered-relaxed" : "agent-credential-audience-registered",
        ruleChain: [],
        reason: `agent credential audience '${body.name}' registered${relaxations.length ? ` (relaxed: ${relaxations.join(", ")})` : ""}`,
      });
      return row!.id;
    });
    return reply.status(201).send({ id });
  });

  app.post("/v1/agent-credentials/audiences/:audienceId/disable", async (req, reply) => {
    const p = audienceParam.safeParse(req.params);
    if (!p.success) return badRequest(reply, p.error);
    const out = await db.transaction(async (tx) => {
      // the declared machine decides; the row is locked so a concurrent disable sees the moved state
      const [cur] = await tx.select({ disabledAt: agentCredentialAudiences.disabledAt }).from(agentCredentialAudiences).where(eq(agentCredentialAudiences.id, p.data.audienceId)).for("update");
      if (!cur || !AUDIENCE_TRANSITIONS[audienceState(cur)].includes("disabled")) return null;
      const [row] = await tx
        .update(agentCredentialAudiences)
        .set({ disabledAt: sql`now()` })
        .where(sql`${agentCredentialAudiences.id} = ${p.data.audienceId} AND ${isNull(agentCredentialAudiences.disabledAt)}`)
        .returning({ id: agentCredentialAudiences.id, name: agentCredentialAudiences.name });
      if (!row) return null;
      await tx.insert(auditLog).values({
        userId: actor(req),
        objectType: "agent_credential_audience",
        objectId: row.id,
        detail: { subsystem: "agent-credential" },
        effect: "allow",
        ruleId: "agent-credential-audience-disabled",
        ruleChain: [],
        reason: `agent credential audience '${row.name}' disabled: no new credential is issued to it`,
      });
      return row;
    });
    if (!out) return reply.status(404).send({ error: "unknown_audience", detail: "no enabled audience with that id" });
    return { id: out.id, enabled: false };
  });
}
