/**
 * ADR-0231 §2 (slice B3) — AGENT GATEWAY CONNECTIONS AND THE ARD IMPORT.
 *
 * An admin connects one agent gateway (today only SAP Agent Gateway) and imports the agents its catalogue lists. The
 * gateway's catalogue is an ARD manifest (`/.well-known/ard.json`, an `entries` array; ARD v0.91 §5.1), filtered by
 * the customer's SAP ACL, so it lists only what this client may see. Nothing is ever registered on its own:
 *  - IMPORT reads the catalogue and every A2A card it names, checks each card, and LISTS the candidates. It writes no
 *    agent. The admin then registers the ones they pick, one at a time, and nobody may call one until granted.
 *  - REFRESH re-reads the catalogue and the imported agents' cards. A card that changed is held as `pending_card`; the
 *    stored card stays the one calls use until an admin ACCEPTS the change (a `settings_relax` step-up when it adds a
 *    skill or an interface). Narrowing needs no review: while a card is pending, a call may use only the skills and
 *    interfaces on BOTH cards. An agent gone from the catalogue is disabled, never deleted.
 *
 * TRUST BOUNDARY. Everything (manifest, cards, agent interfaces) must be on the connection's own origin; the
 * catalogue is the remote party's claim and may not point our calls, or the discovery token, anywhere else. Every
 * request goes through the guarded fetch on the CURRENT egress posture (re-validated, pinned, redirect-refused,
 * bounded).
 *
 * THE DISCOVERY TOKEN (§4, `oauth_client_credentials`). A client-credentials token, used ONLY to read the catalogue and
 * the cards, never sent with a message (a message needs a user-bound token, slice B2, owner-blocked). It is cached in
 * process memory per connection until a minute before it expires, keyed by the connection's last change, so a secret
 * rotation drops it. The client secret is the data-key envelope (CIPHERTEXT_COLUMNS) and no read returns it.
 *
 * DEFAULTS (ADR-0180). `org_settings.sap_agent_gateway_enabled` is off; while off, connections cannot be made,
 * imported or refreshed and their agents cannot be called. Creating a connection, rotating its secret, re-enabling or
 * deleting it are `settings_relax` step-ups, audited with the write.
 *
 * Open source first (ADR-0176): the token request is `oauth4webapi` (MIT, already pinned); card normalisation is the
 * A2A SDK's own resolver. What is ours is the trust rule, the review of a changed card and the record.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import * as oauth from "oauth4webapi";
import { AgentCard } from "@a2a-js/sdk";
import { DefaultAgentCardResolver } from "@a2a-js/sdk/client";
import { a2aAgentCredentials, a2aAgents, a2aGatewayConnections, and, asc, auditLog, eq, type A2aGatewayConnectionRow, type Db } from "@regulait/db";
import { createGuardedFetch, EGRESS_REDIRECT_REASON, egressRedirectRefused, egressRefusal, egressResponseTooLarge } from "./egress-guard.js";
import { checkMcpServerUrl, loadMcpEgressPosture } from "./mcp-egress.js";
import { loadOrgSettings } from "./org-settings.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { checkStepUp } from "./step-up.js";
import { timeouts } from "./timeouts.js";
import { A2A_CARD_RESPONSE_MAX_BYTES, a2aAgentView, cardBindings, cardDiff, cardProblem, cardSkills, type A2aDeps } from "./a2a.js";

const NIL_USER = "00000000-0000-0000-0000-000000000000";
/** ARD v0.91 §5.1: the manifest every conformant consumer reads */
export const ARD_MANIFEST_PATH = "/.well-known/ard.json";
export const ARD_MANIFEST_MAX_BYTES = 1024 * 1024;
export const ARD_MAX_ENTRIES = 500;
const TOKEN_RESPONSE_MAX_BYTES = 64 * 1024;
const TOKEN_REFRESH_MARGIN_MS = 60_000;

export const A2A_GATEWAY_RULE_IDS = Object.freeze({
  connectionCreated: "a2a-gateway-connection-created",
  connectionUpdated: "a2a-gateway-connection-updated",
  connectionRemoved: "a2a-gateway-connection-removed",
  connectionRefused: "a2a-gateway-connection-refused",
  discovery: "a2a-gateway-discovery",
  discoveryRefused: "a2a-gateway-discovery-refused",
  imported: "a2a-gateway-agent-imported",
  importRefused: "a2a-gateway-import-refused",
  cardPending: "a2a-card-pending",
  cardAccepted: "a2a-card-accepted",
  cardRejected: "a2a-card-rejected",
  agentGone: "a2a-gateway-agent-gone",
});

// ---------------------------------------------------------------------------
// Data key (set by registerA2aGatewayRoutes)
// ---------------------------------------------------------------------------

let gatewayDataKey: string | undefined;

// ---------------------------------------------------------------------------
// The discovery token (client credentials), cached per connection in this process only
// ---------------------------------------------------------------------------

const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const cacheKey = (conn: A2aGatewayConnectionRow) => `${conn.id}:${conn.updatedAt.getTime()}`;
/** tests only */
export function clearGatewayTokenCacheForTest(): void {
  tokenCache.clear();
}

type Refusal = { ok: false; code: string; detail: string };

function egressFailure(err: unknown, what: string, maxBytes: number): Refusal {
  if (egressResponseTooLarge(err)) return { ok: false, code: "response_too_large", detail: `the ${what} was larger than ${maxBytes} bytes, so it was refused` };
  if (egressRedirectRefused(err)) return { ok: false, code: "egress_blocked", detail: EGRESS_REDIRECT_REASON };
  const blocked = egressRefusal(err);
  if (blocked) return { ok: false, code: "egress_blocked", detail: blocked };
  return { ok: false, code: "unreachable", detail: `the ${what} could not be read` };
}

async function guarded(db: Db, conn: Pick<A2aGatewayConnectionRow, "allowPrivateRanges">, maxResponseBytes: number, deps: A2aDeps): Promise<typeof fetch> {
  const posture = await loadMcpEgressPosture(db, conn.allowPrivateRanges);
  return createGuardedFetch({ allowList: posture.allowList, privateLan: { openByDefault: posture.openByDefault }, maxResponseBytes, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
}

async function discoveryToken(db: Db, conn: A2aGatewayConnectionRow, deps: A2aDeps): Promise<{ ok: true; token: string } | Refusal> {
  const key = cacheKey(conn);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) return { ok: true, token: cached.token };
  if (!gatewayDataKey) return { ok: false, code: "data_key_unavailable", detail: "the data key is not configured, so the client secret cannot be opened" };
  let secret: string;
  try {
    secret = decryptSecret(gatewayDataKey, conn.clientSecretCiphertext);
  } catch {
    return { ok: false, code: "credential_unavailable", detail: "the client secret could not be opened" };
  }
  const { decision } = await checkMcpServerUrl(db, conn.tokenEndpoint, conn.allowPrivateRanges);
  if (!decision.ok) return { ok: false, code: "egress_blocked", detail: decision.reason };
  const fetchImpl = await guarded(db, conn, TOKEN_RESPONSE_MAX_BYTES, deps);
  const as: oauth.AuthorizationServer = { issuer: new URL(conn.tokenEndpoint).origin, token_endpoint: conn.tokenEndpoint };
  const client: oauth.Client = { client_id: conn.clientId };
  const params = new URLSearchParams();
  if (conn.scope) params.set("scope", conn.scope);
  if (conn.resource) params.set("resource", conn.resource);
  try {
    const res = await oauth.clientCredentialsGrantRequest(as, client, oauth.ClientSecretBasic(secret), params, {
      [oauth.customFetch]: fetchImpl,
      // http only where the admin opted the connection into private ranges (a stepped-up relaxation): a lab gateway
      ...(new URL(conn.tokenEndpoint).protocol === "http:" && conn.allowPrivateRanges === true ? { [oauth.allowInsecureRequests]: true } : {}),
      signal: AbortSignal.timeout(timeouts().outboundDefaultMs),
    });
    const body = await oauth.processClientCredentialsResponse(as, client, res);
    if (!body.access_token || body.access_token.length > 16_384) return { ok: false, code: "token_refused", detail: "the token endpoint returned no usable token" };
    const ttl = typeof body.expires_in === "number" && body.expires_in > 0 ? Math.min(body.expires_in, 3600) * 1000 : 300_000;
    tokenCache.set(key, { token: body.access_token, expiresAt: Date.now() + ttl });
    return { ok: true, token: body.access_token };
  } catch (err) {
    const failed = egressFailure(err, "token response", TOKEN_RESPONSE_MAX_BYTES);
    // the remote's error text is not ours to repeat (A2A-SEC-01): a fixed sentence, or our own egress reason
    return failed.code === "unreachable" ? { ok: false, code: "token_refused", detail: "the token endpoint did not issue a discovery token" } : failed;
  }
}

/** a GET on the connection's origin with the discovery token, through the guarded fetch, bounded; JSON or a refusal */
async function discoveryGet(db: Db, conn: A2aGatewayConnectionRow, url: string, maxBytes: number, what: string, deps: A2aDeps): Promise<{ ok: true; json: unknown; sha256: string } | Refusal> {
  if (originOf(url) !== originOf(conn.baseUrl)) return { ok: false, code: "origin_refused", detail: `the ${what} is on another origin than the gateway` };
  const token = await discoveryToken(db, conn, deps);
  if (!token.ok) return token;
  const fetchImpl = await guarded(db, conn, maxBytes, deps);
  try {
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token.token}`, accept: "application/json" }, signal: AbortSignal.timeout(timeouts().outboundDefaultMs) });
    if (!res.ok) return { ok: false, code: "upstream_status", detail: `the ${what} answered HTTP ${res.status}` };
    const text = await res.text();
    try {
      return { ok: true, json: JSON.parse(text), sha256: createHash("sha256").update(text).digest("hex") };
    } catch {
      return { ok: false, code: "unreadable", detail: `the ${what} is not JSON` };
    }
  } catch (err) {
    return egressFailure(err, what, maxBytes);
  }
}

const originOf = (raw: string): string | null => {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// The catalogue and the cards
// ---------------------------------------------------------------------------

export interface ArdEntry {
  identifier: string;
  displayName: string;
  type: string;
  url: string;
}

/** an ARD entry is an A2A agent card when its media type names one (ARD §3.3; SAP's exact type is confirmed at B0) */
const isA2aCardType = (type: string) => /a2a|agent-card/i.test(type);

/** the entries of an ARD manifest that are A2A agent cards by reference (`url`); inline `data` entries are listed as unsupported */
export function parseArdManifest(json: unknown): { entries: ArdEntry[]; skipped: Array<{ identifier: string; reason: string }> } {
  const raw = json && typeof json === "object" && Array.isArray((json as Record<string, unknown>).entries) ? ((json as Record<string, unknown>).entries as unknown[]) : [];
  const entries: ArdEntry[] = [];
  const skipped: Array<{ identifier: string; reason: string }> = [];
  for (const e of raw.slice(0, ARD_MAX_ENTRIES)) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const identifier = typeof o.identifier === "string" ? o.identifier.slice(0, 512) : "";
    if (!identifier) continue;
    if (typeof o.type !== "string" || !isA2aCardType(o.type)) continue;
    if (typeof o.url !== "string") {
      skipped.push({ identifier, reason: "the entry carries its card inline (data), which the import does not accept yet" });
      continue;
    }
    entries.push({ identifier, displayName: typeof o.displayName === "string" ? o.displayName.slice(0, 200) : identifier, type: o.type.slice(0, 200), url: o.url.slice(0, 2048) });
  }
  return { entries, skipped };
}

export interface CheckedCard {
  card: Record<string, unknown>;
  rawSha256: string;
  protocolVersion: string;
}

/** read one card, normalise it with the SDK (0.3 cards included), and run every card check against the gateway's origin */
async function readCard(db: Db, conn: A2aGatewayConnectionRow, url: string, deps: A2aDeps): Promise<({ ok: true } & CheckedCard) | Refusal> {
  const got = await discoveryGet(db, conn, url, A2A_CARD_RESPONSE_MAX_BYTES, "agent card", deps);
  if (!got.ok) return got;
  let card: AgentCard;
  try {
    card = new DefaultAgentCardResolver({ legacyCompat: { enabled: true } }).normalizeAgentCard(got.json);
  } catch {
    return { ok: false, code: "card_unreadable", detail: "the agent card could not be read" };
  }
  const problem = cardProblem(card, conn.baseUrl);
  if (problem) return { ok: false, code: "card_refused", detail: problem };
  const raw = got.json as Record<string, unknown>;
  const protocolVersion = typeof raw.protocolVersion === "string" ? raw.protocolVersion.slice(0, 32) : (cardBindings(AgentCard.toJSON(card) as Record<string, unknown>)[0]?.protocolVersion ?? "");
  return { ok: true, card: AgentCard.toJSON(card) as Record<string, unknown>, rawSha256: got.sha256, protocolVersion };
}

async function readCatalogue(db: Db, conn: A2aGatewayConnectionRow, deps: A2aDeps) {
  const got = await discoveryGet(db, conn, new URL(ARD_MANIFEST_PATH, conn.baseUrl).toString(), ARD_MANIFEST_MAX_BYTES, "ARD catalogue", deps);
  if (!got.ok) return got;
  return { ok: true as const, ...parseArdManifest(got.json) };
}

// ---------------------------------------------------------------------------
// Routes (admin-only by the default gate)
// ---------------------------------------------------------------------------

const connParam = z.object({ connectionId: z.string().uuid() });
const agentParam = z.object({ agentId: z.string().uuid() });
const createSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    provider: z.literal("sap_agent_gateway"),
    baseUrl: z.string().url().max(2048),
    tokenEndpoint: z.string().url().max(2048),
    clientId: z.string().min(1).max(512),
    clientSecret: z.string().min(8).max(4096),
    resource: z.string().max(2048).nullable().optional(),
    scope: z.string().max(1024).nullable().optional(),
    allowPrivateRanges: z.boolean().nullable().optional(),
  })
  .strict();
const updateSchema = z.object({ enabled: z.boolean().optional(), clientSecret: z.string().min(8).max(4096).optional() }).strict();
const registerSchema = z
  .object({ identifier: z.string().min(1).max(512), name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/), pricePerCallUsd: z.number().min(0).max(1000).nullable().optional() })
  .strict();

export function gatewayConnectionView(row: A2aGatewayConnectionRow) {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    baseUrl: row.baseUrl,
    tokenEndpoint: row.tokenEndpoint,
    clientId: row.clientId,
    clientSecretLast4: row.clientSecretLast4,
    resource: row.resource,
    scope: row.scope,
    allowPrivateRanges: row.allowPrivateRanges,
    enabled: row.enabled,
    lastImportedAt: row.lastImportedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

const actor = (req: FastifyRequest) => req.authCtx.userId ?? NIL_USER;

export function registerA2aGatewayRoutes(app: FastifyInstance, db: Db, opts: { dataKey?: string | undefined; deps?: A2aDeps } = {}): void {
  gatewayDataKey = opts.dataKey;
  const deps = opts.deps ?? {};

  const audit = (tx: Db, req: FastifyRequest, objectType: "a2a_agent", objectId: string | null, ruleId: string, effect: "allow" | "deny", reason: string, detail: Record<string, unknown>) =>
    tx.insert(auditLog).values({ userId: actor(req), objectType, objectId, detail, effect, ruleId, ruleChain: [], reason });
  const loadConn = async (id: string) => (await db.select().from(a2aGatewayConnections).where(eq(a2aGatewayConnections.id, id)))[0];
  /** the org settings that gate everything here; a refusal is audited */
  const gate = async (req: FastifyRequest, connectionId: string | null): Promise<{ ok: true } | { ok: false; status: number; body: Record<string, unknown> }> => {
    const org = await loadOrgSettings(db);
    const off = !org.a2aEnabled ? "calls to remote agents are turned off for this organisation" : !org.sapAgentGatewayEnabled ? "SAP Agent Gateway connections are turned off for this organisation" : null;
    if (!off) return { ok: true };
    await audit(db, req, "a2a_agent", null, A2A_GATEWAY_RULE_IDS.connectionRefused, "deny", `Agent gateway refused: ${off}. Nothing was read or saved.`, { phase: "gateway", connectionId, code: "sap_agent_gateway_disabled" });
    return { ok: false, status: 409, body: { error: "sap_agent_gateway_disabled", detail: `${off}; an admin turns it on in Organisation settings` } };
  };

  app.get("/v1/a2a/gateway-connections", async () => {
    const [org, rows] = await Promise.all([loadOrgSettings(db), db.select().from(a2aGatewayConnections).orderBy(asc(a2aGatewayConnections.name)).limit(100)]);
    return { enabled: org.sapAgentGatewayEnabled, connections: rows.map(gatewayConnectionView) };
  });

  app.post("/v1/a2a/gateway-connections", async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    // the body holds the secret: a fixed sentence, never the zod issue list
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request", detail: "expected { name, provider: 'sap_agent_gateway', baseUrl, tokenEndpoint, clientId, clientSecret, resource?, scope?, allowPrivateRanges? }" });
    const body = parsed.data;
    const g = await gate(req, null);
    if (!g.ok) return reply.status(g.status).send(g.body);
    if (!opts.dataKey) return reply.status(503).send({ error: "data_key_unavailable", detail: "the data key is not configured, so a secret cannot be stored encrypted" });
    const allowPrivateRanges = body.allowPrivateRanges ?? null;
    const refuse = async (code: string, detail: string) => {
      await audit(db, req, "a2a_agent", null, A2A_GATEWAY_RULE_IDS.connectionRefused, "deny", `Agent gateway '${body.name}' refused (${code}): ${detail}. Nothing was saved.`, { phase: "gateway", code, name: body.name, baseUrl: body.baseUrl });
      return reply.status(400).send({ error: "a2a_gateway_refused", code, detail });
    };
    for (const [what, url] of [["base url", body.baseUrl], ["token endpoint", body.tokenEndpoint]] as const) {
      if (new URL(url).protocol !== "https:" && allowPrivateRanges !== true) return refuse("https_required", `the ${what} must use https`);
      const { decision } = await checkMcpServerUrl(db, url, allowPrivateRanges);
      if (!decision.ok) return refuse("egress_blocked", `${what}: ${decision.reason}`);
    }
    const [taken] = await db.select({ id: a2aGatewayConnections.id }).from(a2aGatewayConnections).where(eq(a2aGatewayConnections.name, body.name));
    if (taken) return reply.status(409).send({ error: "name_taken", detail: "a gateway connection with this name exists" });
    const su = await checkStepUp(db, req, { kind: "settings_relax", facts: { op: "a2a_gateway_connection_create", name: body.name, baseUrl: body.baseUrl, tokenEndpoint: body.tokenEndpoint, values: { allowPrivateRanges } } });
    if (!su.ok) return reply.status(su.status).send(su.body);
    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(a2aGatewayConnections)
        .values({
          name: body.name,
          provider: body.provider,
          baseUrl: new URL(body.baseUrl).origin,
          tokenEndpoint: body.tokenEndpoint,
          clientId: body.clientId,
          clientSecretCiphertext: encryptSecret(opts.dataKey!, body.clientSecret),
          clientSecretLast4: body.clientSecret.slice(-4),
          resource: body.resource ?? null,
          scope: body.scope ?? null,
          allowPrivateRanges,
          createdBy: req.authCtx.userId ?? null,
        })
        .onConflictDoNothing()
        .returning();
      if (!created) return null;
      await audit(tx as unknown as Db, req, "a2a_agent", null, A2A_GATEWAY_RULE_IDS.connectionCreated, "allow", `Agent gateway '${created.name}' connected at ${created.baseUrl}; no agent is registered until an admin imports one`, {
        phase: "gateway",
        connectionId: created.id,
        provider: created.provider,
        baseUrl: created.baseUrl,
        tokenEndpoint: created.tokenEndpoint,
        clientId: created.clientId,
        allowPrivateRanges,
        relaxation: true,
      });
      return created;
    });
    if (!row) return reply.status(409).send({ error: "name_taken", detail: "a gateway connection with this name exists" });
    return reply.status(201).send(gatewayConnectionView(row));
  });

  app.patch("/v1/a2a/gateway-connections/:connectionId", async (req, reply) => {
    const { connectionId } = connParam.parse(req.params);
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success || Object.keys(parsed.data).length === 0) return reply.status(400).send({ error: "invalid_request", detail: "expected { enabled?, clientSecret? }" });
    const conn = await loadConn(connectionId);
    if (!conn) return reply.status(404).send({ error: "unknown_connection" });
    const { enabled, clientSecret } = parsed.data;
    // a secret rotation and re-enabling are step-ups; turning a connection off is not (narrowing needs no ceremony)
    if (clientSecret !== undefined || (enabled === true && !conn.enabled)) {
      if (!opts.dataKey && clientSecret !== undefined) return reply.status(503).send({ error: "data_key_unavailable" });
      const su = await checkStepUp(db, req, { kind: "settings_relax", facts: { op: "a2a_gateway_connection_update", connectionId, values: { enabled: enabled ?? null, rotateSecret: clientSecret !== undefined } } });
      if (!su.ok) return reply.status(su.status).send(su.body);
    }
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(a2aGatewayConnections)
        .set({
          ...(enabled !== undefined ? { enabled } : {}),
          ...(clientSecret !== undefined ? { clientSecretCiphertext: encryptSecret(opts.dataKey!, clientSecret), clientSecretLast4: clientSecret.slice(-4) } : {}),
          updatedAt: new Date(),
        })
        .where(eq(a2aGatewayConnections.id, connectionId))
        .returning();
      if (!updated) return null;
      await audit(tx as unknown as Db, req, "a2a_agent", null, A2A_GATEWAY_RULE_IDS.connectionUpdated, "allow", `Agent gateway '${conn.name}' updated${clientSecret !== undefined ? " (client secret rotated)" : ""}`, {
        phase: "gateway",
        connectionId,
        before: { enabled: conn.enabled },
        after: { enabled: updated.enabled },
        secretRotated: clientSecret !== undefined,
      });
      return updated;
    });
    if (!row) return reply.status(404).send({ error: "unknown_connection" });
    return gatewayConnectionView(row);
  });

  app.delete("/v1/a2a/gateway-connections/:connectionId", async (req, reply) => {
    const { connectionId } = connParam.parse(req.params);
    const conn = await loadConn(connectionId);
    if (!conn) return reply.status(404).send({ error: "unknown_connection" });
    const su = await checkStepUp(db, req, { kind: "settings_relax", facts: { op: "a2a_gateway_connection_delete", connectionId } });
    if (!su.ok) return reply.status(su.status).send(su.body);
    await db.transaction(async (tx) => {
      // its agents stay (with their grants and trail) but are turned off: a gateway that is gone vouches for nothing
      const disabled = await tx.update(a2aAgents).set({ enabled: false, updatedAt: new Date() }).where(eq(a2aAgents.gatewayConnectionId, connectionId)).returning({ id: a2aAgents.id });
      await tx.delete(a2aGatewayConnections).where(eq(a2aGatewayConnections.id, connectionId));
      await audit(tx as unknown as Db, req, "a2a_agent", null, A2A_GATEWAY_RULE_IDS.connectionRemoved, "allow", `Agent gateway '${conn.name}' removed; its client secret was destroyed and ${disabled.length} imported agent(s) turned off`, {
        phase: "gateway",
        connectionId,
        agentsDisabled: disabled.map((d) => d.id),
      });
    });
    return reply.status(204).send();
  });

  // --- import: list what the catalogue offers; register nothing -------------------------------------------------

  app.post("/v1/a2a/gateway-connections/:connectionId/import", async (req, reply) => {
    const { connectionId } = connParam.parse(req.params);
    const conn = await loadConn(connectionId);
    if (!conn) return reply.status(404).send({ error: "unknown_connection" });
    const g = await gate(req, connectionId);
    if (!g.ok) return reply.status(g.status).send(g.body);
    if (!conn.enabled) return reply.status(409).send({ error: "connection_disabled" });
    const cat = await readCatalogue(db, conn, deps);
    if (!cat.ok) {
      await audit(db, req, "a2a_agent", null, A2A_GATEWAY_RULE_IDS.discoveryRefused, "deny", `Agent gateway '${conn.name}': the catalogue could not be read (${cat.code}): ${cat.detail}`, { phase: "discovery", connectionId, code: cat.code });
      return reply.status(502).send({ error: "a2a_gateway_discovery_failed", code: cat.code, detail: cat.detail });
    }
    const registered = await db.select({ id: a2aAgents.id, ardIdentifier: a2aAgents.ardIdentifier, cardRawSha256: a2aAgents.cardRawSha256 }).from(a2aAgents).where(eq(a2aAgents.gatewayConnectionId, connectionId));
    const byIdentifier = new Map(registered.map((r) => [r.ardIdentifier, r]));
    const candidates: Array<Record<string, unknown> & { identifier: string; status: string }> = [];
    for (const entry of cat.entries) {
      const card = await readCard(db, conn, entry.url, deps);
      const existing = byIdentifier.get(entry.identifier);
      candidates.push({
        identifier: entry.identifier,
        displayName: entry.displayName,
        cardUrl: entry.url,
        ...(card.ok
          ? { status: existing ? (existing.cardRawSha256 === card.rawSha256 ? "registered" : "changed") : "new", skills: cardSkills(card.card), bindings: cardBindings(card.card), protocolVersion: card.protocolVersion }
          : { status: "refused", code: card.code, detail: card.detail }),
        ...(existing ? { agentId: existing.id } : {}),
      });
    }
    await db.transaction(async (tx) => {
      await tx.update(a2aGatewayConnections).set({ lastImportedAt: new Date() }).where(eq(a2aGatewayConnections.id, connectionId));
      await audit(tx as unknown as Db, req, "a2a_agent", null, A2A_GATEWAY_RULE_IDS.discovery, "allow", `Agent gateway '${conn.name}': catalogue read, ${candidates.length} A2A agent(s) listed; nothing was registered`, {
        phase: "discovery",
        connectionId,
        listed: candidates.map((c) => ({ identifier: c.identifier, status: c.status })),
        skipped: cat.skipped,
      });
    });
    return { connectionId, candidates, skipped: cat.skipped };
  });

  // --- register one chosen agent -----------------------------------------------------------------------------------

  app.post("/v1/a2a/gateway-connections/:connectionId/agents", async (req, reply) => {
    const { connectionId } = connParam.parse(req.params);
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request", detail: "expected { identifier, name (lower-case letters, digits, hyphens), pricePerCallUsd? }" });
    const body = parsed.data;
    const conn = await loadConn(connectionId);
    if (!conn) return reply.status(404).send({ error: "unknown_connection" });
    const g = await gate(req, connectionId);
    if (!g.ok) return reply.status(g.status).send(g.body);
    if (!conn.enabled) return reply.status(409).send({ error: "connection_disabled" });
    const refuse = async (status: number, code: string, detail: string) => {
      await audit(db, req, "a2a_agent", null, A2A_GATEWAY_RULE_IDS.importRefused, "deny", `Agent gateway '${conn.name}': '${body.identifier.slice(0, 200)}' not registered (${code}): ${detail}`, { phase: "import", connectionId, identifier: body.identifier, code });
      return reply.status(status).send({ error: "a2a_import_refused", code, detail });
    };
    // re-read: the admin's pick is checked against the catalogue as it is NOW, not as it was when listed
    const cat = await readCatalogue(db, conn, deps);
    if (!cat.ok) return refuse(502, cat.code, cat.detail);
    const entry = cat.entries.find((e) => e.identifier === body.identifier);
    if (!entry) return refuse(404, "not_in_catalogue", "the gateway's catalogue does not list this agent for this client");
    const card = await readCard(db, conn, entry.url, deps);
    if (!card.ok) return refuse(card.code === "card_refused" ? 400 : 502, card.code, card.detail);
    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(a2aAgents)
        .values({
          name: body.name,
          url: entry.url,
          card: card.card,
          allowPrivateRanges: conn.allowPrivateRanges,
          pricePerCallUsd: body.pricePerCallUsd ?? null,
          createdBy: req.authCtx.userId ?? null,
          gatewayConnectionId: connectionId,
          ardIdentifier: entry.identifier,
          cardProtocolVersion: card.protocolVersion,
          cardRawSha256: card.rawSha256,
        })
        .onConflictDoNothing()
        .returning();
      if (!created) return null;
      await audit(tx as unknown as Db, req, "a2a_agent", created.id, A2A_GATEWAY_RULE_IDS.imported, "allow", `Remote agent '${created.name}' imported from agent gateway '${conn.name}' (${entry.identifier}) with ${cardSkills(card.card).length} skill(s); nobody may call it until granted`, {
        phase: "import",
        connectionId,
        identifier: entry.identifier,
        url: entry.url,
        protocolVersion: card.protocolVersion,
        cardRawSha256: card.rawSha256,
        skills: cardSkills(card.card).map((s) => s.id),
        bindings: cardBindings(card.card),
      });
      return created;
    });
    if (!row) return reply.status(409).send({ error: "already_registered", detail: "an agent with this name, or this catalogue entry, is already registered" });
    return reply.status(201).send(a2aAgentView(row, null));
  });

  // --- refresh: changed cards are held, gone agents are turned off -------------------------------------------------

  app.post("/v1/a2a/gateway-connections/:connectionId/refresh", async (req, reply) => {
    const { connectionId } = connParam.parse(req.params);
    const conn = await loadConn(connectionId);
    if (!conn) return reply.status(404).send({ error: "unknown_connection" });
    const g = await gate(req, connectionId);
    if (!g.ok) return reply.status(g.status).send(g.body);
    const cat = await readCatalogue(db, conn, deps);
    if (!cat.ok) {
      await audit(db, req, "a2a_agent", null, A2A_GATEWAY_RULE_IDS.discoveryRefused, "deny", `Agent gateway '${conn.name}': refresh could not read the catalogue (${cat.code}); nothing changed`, { phase: "refresh", connectionId, code: cat.code });
      return reply.status(502).send({ error: "a2a_gateway_discovery_failed", code: cat.code, detail: cat.detail });
    }
    const agents = await db.select().from(a2aAgents).where(eq(a2aAgents.gatewayConnectionId, connectionId));
    const results: Array<Record<string, unknown>> = [];
    for (const agent of agents) {
      const entry = cat.entries.find((e) => e.identifier === agent.ardIdentifier);
      if (!entry) {
        if (agent.enabled) {
          await db.transaction(async (tx) => {
            await tx.update(a2aAgents).set({ enabled: false, updatedAt: new Date() }).where(eq(a2aAgents.id, agent.id));
            await audit(tx as unknown as Db, req, "a2a_agent", agent.id, A2A_GATEWAY_RULE_IDS.agentGone, "allow", `Remote agent '${agent.name}' is gone from agent gateway '${conn.name}'s catalogue, so it was turned off (not deleted)`, { phase: "refresh", connectionId, identifier: agent.ardIdentifier });
          });
        }
        results.push({ agentId: agent.id, outcome: "gone_disabled" });
        continue;
      }
      const card = await readCard(db, conn, entry.url, deps);
      if (!card.ok) {
        await audit(db, req, "a2a_agent", agent.id, A2A_GATEWAY_RULE_IDS.importRefused, "deny", `Remote agent '${agent.name}': the refreshed card was refused (${card.code}): ${card.detail}. The stored card is unchanged.`, { phase: "refresh", connectionId, code: card.code });
        results.push({ agentId: agent.id, outcome: "refused", code: card.code });
        continue;
      }
      if (card.rawSha256 === agent.cardRawSha256 && entry.url === agent.url) {
        // unchanged: a pending card that the remote has since reverted is dropped
        if (agent.pendingCard) await db.update(a2aAgents).set({ pendingCard: null, pendingCardRawSha256: null, pendingCardFetchedAt: null, updatedAt: new Date() }).where(eq(a2aAgents.id, agent.id));
        results.push({ agentId: agent.id, outcome: "unchanged" });
        continue;
      }
      if (entry.url !== agent.url) {
        // a moved card is a new registration for the admin to make, never a silent redirect of our calls
        await audit(db, req, "a2a_agent", agent.id, A2A_GATEWAY_RULE_IDS.importRefused, "deny", `Remote agent '${agent.name}': the catalogue now names its card at another url; the stored card and url are unchanged`, { phase: "refresh", connectionId, code: "card_moved", newUrl: entry.url });
        results.push({ agentId: agent.id, outcome: "moved_refused" });
        continue;
      }
      if (card.rawSha256 === agent.pendingCardRawSha256) {
        results.push({ agentId: agent.id, outcome: "pending" });
        continue;
      }
      const diff = cardDiff(agent.card, card.card);
      await db.transaction(async (tx) => {
        await tx.update(a2aAgents).set({ pendingCard: card.card, pendingCardRawSha256: card.rawSha256, pendingCardFetchedAt: new Date(), updatedAt: new Date() }).where(eq(a2aAgents.id, agent.id));
        await audit(tx as unknown as Db, req, "a2a_agent", agent.id, A2A_GATEWAY_RULE_IDS.cardPending, "allow", `Remote agent '${agent.name}': its card changed and is held for review; calls keep the stored card, narrowed to what both allow`, {
          phase: "refresh",
          connectionId,
          diff,
          cardRawSha256: card.rawSha256,
        });
      });
      results.push({ agentId: agent.id, outcome: "pending", diff });
    }
    return { connectionId, results };
  });

  // --- the pending card: accept (a step-up when it widens) or reject -----------------------------------------------

  app.post("/v1/a2a/agents/:agentId/pending-card/accept", async (req, reply) => {
    const { agentId } = agentParam.parse(req.params);
    const [agent] = await db.select().from(a2aAgents).where(eq(a2aAgents.id, agentId));
    if (!agent) return reply.status(404).send({ error: "unknown_agent" });
    if (!agent.pendingCard) return reply.status(409).send({ error: "no_pending_card" });
    // every card check again, on the card that would become the one calls use
    let parsedCard: AgentCard;
    try {
      parsedCard = AgentCard.fromJSON(agent.pendingCard);
    } catch {
      return reply.status(400).send({ error: "card_refused", detail: "the pending card cannot be read" });
    }
    const problem = cardProblem(parsedCard, agent.url);
    if (problem) {
      await audit(db, req, "a2a_agent", agentId, A2A_GATEWAY_RULE_IDS.importRefused, "deny", `Remote agent '${agent.name}': the pending card was refused on accept: ${problem}`, { phase: "accept", code: "card_refused" });
      return reply.status(400).send({ error: "card_refused", detail: problem });
    }
    const diff = cardDiff(agent.card, agent.pendingCard);
    if (diff.widens) {
      const su = await checkStepUp(db, req, { kind: "settings_relax", facts: { op: "a2a_card_accept", agentId, values: { skillsAdded: diff.skillsAdded, interfacesAdded: diff.interfacesAdded } } });
      if (!su.ok) return reply.status(su.status).send(su.body);
    }
    const pending = agent.pendingCard;
    const pendingSha = agent.pendingCardRawSha256;
    const row = await db.transaction(async (tx) => {
      // compare-and-set on the pending hash: a refresh that replaced it meanwhile is not accepted by this click
      const [updated] = await tx
        .update(a2aAgents)
        .set({ card: pending, cardRawSha256: pendingSha, cardFetchedAt: agent.pendingCardFetchedAt ?? new Date(), pendingCard: null, pendingCardRawSha256: null, pendingCardFetchedAt: null, updatedAt: new Date() })
        .where(and(eq(a2aAgents.id, agentId), pendingSha === null ? eq(a2aAgents.id, agentId) : eq(a2aAgents.pendingCardRawSha256, pendingSha)))
        .returning();
      if (!updated) return null;
      await audit(tx as unknown as Db, req, "a2a_agent", agentId, A2A_GATEWAY_RULE_IDS.cardAccepted, "allow", `Remote agent '${agent.name}': the changed card was accepted${diff.widens ? " (it widens what the agent offers; new skills still need a grant)" : ""}`, {
        phase: "accept",
        diff,
        cardRawSha256: pendingSha,
        ...(diff.widens ? { relaxation: true } : {}),
      });
      return updated;
    });
    if (!row) return reply.status(409).send({ error: "changed_concurrently", detail: "the pending card changed while this was being accepted; review it again" });
    const [cred] = await db.select().from(a2aAgentCredentials).where(eq(a2aAgentCredentials.agentId, agentId));
    return a2aAgentView(row, cred);
  });

  app.delete("/v1/a2a/agents/:agentId/pending-card", async (req, reply) => {
    const { agentId } = agentParam.parse(req.params);
    const [agent] = await db.select().from(a2aAgents).where(eq(a2aAgents.id, agentId));
    if (!agent) return reply.status(404).send({ error: "unknown_agent" });
    if (!agent.pendingCard) return reply.status(409).send({ error: "no_pending_card" });
    await db.transaction(async (tx) => {
      // the rejected hash is remembered as pending-and-rejected by keeping it out of the stored card; the next refresh
      // that sees the same card holds it again, so a rejection is a decision for now, not a permanent ignore
      await tx.update(a2aAgents).set({ pendingCard: null, pendingCardRawSha256: null, pendingCardFetchedAt: null, updatedAt: new Date() }).where(eq(a2aAgents.id, agentId));
      await audit(tx as unknown as Db, req, "a2a_agent", agentId, A2A_GATEWAY_RULE_IDS.cardRejected, "allow", `Remote agent '${agent.name}': the changed card was rejected; the stored card stays`, { phase: "reject", diff: cardDiff(agent.card, agent.pendingCard!) });
    });
    return reply.status(204).send();
  });
}
