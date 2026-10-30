/**
 * ADR-0219 (P10) — GOVERNED AGENT-TO-AGENT (A2A) CALLS.
 *
 * A remote agent that speaks the A2A protocol is a third kind of callable, beside a model agent and an MCP tool. It is
 * governed at the same kind of choke point as an MCP tool call: `executeGovernedA2aCall` is the ONLY function that
 * sends a message to a remote agent, and the route, any future orchestration worker and any test all go through it.
 *
 * ONE CALL, IN ORDER (each refusal is audited and returned as `denied`; nothing leaves the box):
 *  1. the org setting `a2aEnabled` (default false, ADR-0180);
 *  2. the agent exists and is enabled, and the named skill is on its card;
 *  3. the lead ceiling: a worker may call only the agents its lead chain allows (it can only NARROW, never widen);
 *  4. the person's grant (`a2a_agent_grants`): default-deny, for the whole agent or that one skill. A worker never has
 *     a grant of its own: it calls as the person who started the run, so it never exceeds them;
 *  5. the egress decision on the CURRENT posture (the MCP allow-list and private-range default), then the guarded
 *     fetch for every request (re-validated, pinned, redirect-refused);
 *  6. the credential, opened at send time and sent only to the registered origin.
 * The outcome is written in ONE transaction: the pillar-5 `usage_events` row (`object_type` 'a2a_agent', the agent's
 * flat price, the project) and the audit row.
 *
 * ADMIN. Registration, the card refresh, the credential and the grants are admin-only (the default gate) and audited in
 * the same transaction as the write. Registration reads the agent card through the guarded fetch and refuses a card
 * whose JSON-RPC interface is on another origin than the registered url. A private-range opt-in and every credential
 * write need a `settings_relax` step-up. The secret is the data-key envelope and no read returns it.
 *
 * Open source first (ADR-0176): the A2A wire protocol is the A2A project's own SDK (`@a2a-js/sdk`, Apache-2.0, pinned,
 * pure JavaScript with no runtime downloads), given our guarded fetch. What is ours is who may call and what is
 * recorded.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AgentCard, Role, type Message, type Part, type Task } from "@a2a-js/sdk";
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import {
  a2aAgentCredentials,
  a2aAgentGrants,
  a2aAgents,
  and,
  asc,
  auditLog,
  eq,
  isNull,
  or,
  usageEvents,
  users,
  type A2aAgentCredentialRow,
  type A2aAgentRow,
  type Db,
} from "@regulait/db";
import { mcpUpstreamHeaderNameProblem, mcpUpstreamSecretProblem, setMcpUpstreamCredentialSchema } from "@regulait/shared";
import { createGuardedFetch, egressRefusal } from "./egress-guard.js";
import { checkMcpServerUrl, loadMcpEgressPosture } from "./mcp-egress.js";
import { loadOrgSettings } from "./org-settings.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { checkStepUp, requireStepUp } from "./step-up.js";
import { timeouts } from "./timeouts.js";

const NIL_USER = "00000000-0000-0000-0000-000000000000";
/** the JSON-RPC binding is the one transport this gateway speaks to a remote agent */
const JSONRPC = "JSONRPC";
/** a stored card is at most this many bytes of JSON (the 0239 CHECK allows a little more for jsonb overhead) */
export const A2A_CARD_MAX_BYTES = 60_000;
/** what a caller may send and what we hand back, in characters */
export const A2A_MESSAGE_MAX_CHARS = 32_000;
export const A2A_REPLY_MAX_CHARS = 64_000;
/** headers the A2A transport sets itself, so a credential may never name them */
const A2A_RESERVED_HEADERS = ["a2a-version", "a2a-extensions"];

export const A2A_RULE_IDS = Object.freeze({
  registered: "a2a-agent-registered",
  registrationRefused: "a2a-agent-registration-refused",
  cardRefreshed: "a2a-agent-card-refreshed",
  updated: "a2a-agent-updated",
  removed: "a2a-agent-removed",
  credentialSet: "a2a-credential-set",
  credentialRotated: "a2a-credential-rotated",
  credentialCleared: "a2a-credential-cleared",
  credentialRefused: "a2a-credential-refused",
  granted: "a2a-grant-added",
  grantRemoved: "a2a-grant-removed",
  callAllowed: "a2a-call",
  disabled: "a2a-disabled",
  unknownAgent: "a2a-unknown-agent",
  unknownSkill: "a2a-unknown-skill",
  leadCeiling: "lead-ceiling",
  noGrant: "a2a-default-deny",
  egress: "a2a-egress-blocked",
  credentialUnavailable: "a2a-credential-unavailable",
  upstreamError: "a2a-upstream-error",
});

// ---------------------------------------------------------------------------
// Data key (set once by registerA2aRoutes, like the MCP upstream credential's)
// ---------------------------------------------------------------------------

let a2aDataKey: string | undefined;
export function configureA2aDataKey(dataKey: string | undefined): void {
  a2aDataKey = dataKey;
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

export interface A2aSkillView {
  id: string;
  name: string;
  description: string;
}

/** the skills a stored card lists (bounded; an unreadable card lists none) */
export function cardSkills(card: Record<string, unknown>): A2aSkillView[] {
  const skills = Array.isArray(card.skills) ? card.skills : [];
  return skills.slice(0, 200).flatMap((s) => {
    if (!s || typeof s !== "object") return [];
    const o = s as Record<string, unknown>;
    if (typeof o.id !== "string" || o.id.length === 0 || o.id.length > 128) return [];
    return [{ id: o.id, name: typeof o.name === "string" ? o.name.slice(0, 200) : o.id, description: typeof o.description === "string" ? o.description.slice(0, 1000) : "" }];
  });
}

const originOf = (raw: string): string | null => {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
};

/**
 * Why `card` cannot be registered at `registeredUrl`, or null. It needs a JSON-RPC interface, and every JSON-RPC
 * interface must be on the registered origin: the card is the remote party's own claim, so it may not move our calls
 * (or the credential) to another host.
 */
export function cardProblem(card: AgentCard, registeredUrl: string): string | null {
  const origin = originOf(registeredUrl);
  const rpc = card.supportedInterfaces.filter((i) => i.protocolBinding === JSONRPC);
  if (rpc.length === 0) return "the agent card offers no JSON-RPC interface, the one transport the gateway uses";
  const elsewhere = rpc.find((i) => originOf(i.url) !== origin);
  if (elsewhere) return `the agent card names a JSON-RPC interface on another origin (${originOf(elsewhere.url) ?? "an invalid url"}) than the registered url`;
  if (Buffer.byteLength(JSON.stringify(AgentCard.toJSON(card)), "utf8") > A2A_CARD_MAX_BYTES) return `the agent card is larger than ${A2A_CARD_MAX_BYTES} bytes`;
  return null;
}

/** the card the client is built from: only the JSON-RPC interfaces on the registered origin */
function clientCard(stored: Record<string, unknown>, registeredUrl: string): AgentCard {
  const card = AgentCard.fromJSON(stored);
  const origin = originOf(registeredUrl);
  return { ...card, supportedInterfaces: card.supportedInterfaces.filter((i) => i.protocolBinding === JSONRPC && originOf(i.url) === origin) };
}

// ---------------------------------------------------------------------------
// Egress and the credential
// ---------------------------------------------------------------------------

export interface A2aDeps {
  /** tests only: replaces the pinned transport under the guarded fetch (see `GuardedFetchOptions.fetchImpl`) */
  fetchImpl?: typeof fetch;
}

/** the guarded fetch for one agent, on the CURRENT posture, with the credential added on the registered origin only */
async function agentFetch(db: Db, agent: { url: string; allowPrivateRanges: boolean | null }, credential: { headerName: string; value: string } | null, deps: A2aDeps): Promise<typeof fetch> {
  const posture = await loadMcpEgressPosture(db, agent.allowPrivateRanges);
  const guarded = createGuardedFetch({
    allowList: posture.allowList,
    privateLan: { openByDefault: posture.openByDefault },
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  const registered = originOf(agent.url);
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (credential) {
      headers.delete(credential.headerName);
      if (registered !== null && originOf(url) === registered) headers.set(credential.headerName, credential.value);
    }
    return guarded(url, { ...init, headers });
  }) as typeof fetch;
}

type OpenedCredential = { ok: true; credential: { headerName: string; value: string } | null } | { ok: false; reason: "data_key_unavailable" | "undecryptable" };

async function openCredential(db: Db, agentId: string): Promise<OpenedCredential> {
  const [row] = await db.select().from(a2aAgentCredentials).where(eq(a2aAgentCredentials.agentId, agentId));
  if (!row) return { ok: true, credential: null };
  if (!a2aDataKey) return { ok: false, reason: "data_key_unavailable" };
  try {
    const secret = decryptSecret(a2aDataKey, row.secretCiphertext);
    return { ok: true, credential: { headerName: row.headerName, value: row.scheme === "bearer" ? `Bearer ${secret}` : secret } };
  } catch {
    return { ok: false, reason: "undecryptable" };
  }
}

export function a2aCredentialView(row: A2aAgentCredentialRow | undefined | null) {
  if (!row) return { set: false, scheme: null, headerName: null, last4: null, setBy: null, setAt: null };
  return { set: true, scheme: row.scheme, headerName: row.headerName, last4: row.secretLast4, setBy: row.setBy, setAt: row.secretSetAt.toISOString() };
}

/** read the card at `url` through the guarded fetch (no credential: a card is public by the protocol) */
async function fetchCard(db: Db, url: string, allowPrivateRanges: boolean | null, deps: A2aDeps): Promise<{ ok: true; card: AgentCard } | { ok: false; code: string; detail: string }> {
  const fetchImpl = await agentFetch(db, { url, allowPrivateRanges }, null, deps);
  try {
    const card = await new DefaultAgentCardResolver({ fetchImpl }).resolve(url);
    const problem = cardProblem(card, url);
    return problem ? { ok: false, code: "card_refused", detail: problem } : { ok: true, card };
  } catch (err) {
    const blocked = egressRefusal(err);
    if (blocked) return { ok: false, code: "egress_blocked", detail: blocked };
    return { ok: false, code: "card_unreadable", detail: "the agent card could not be read from the url" };
  }
}

// ---------------------------------------------------------------------------
// THE GOVERNED CALL
// ---------------------------------------------------------------------------

export interface GovernedA2aCallArgs {
  /** the person the call is made for: the caller, or the person who started a worker's run */
  userId: string;
  agentId: string;
  /** null = no named skill (the grant must then cover the whole agent) */
  skillId?: string | null;
  text: string;
  /** pillar 5 attribution; null = the Unattributed bucket */
  projectId?: string | null;
  /** §5.1 lead ceiling: the agent ids a worker's lead chain permits. null/undefined = no lead constraint */
  ceilingAgentIds?: readonly string[] | null;
}

export type GovernedA2aCallOutcome =
  | { kind: "allowed"; reply: string; taskState: string | null; costUsd: number | null; usageEventId: string; auditId: string }
  | { kind: "denied"; status: number; error: string; ruleId: string; reason: string; auditId: string }
  | { kind: "upstream_error"; status: 502; error: "a2a_upstream_error"; reason: string; auditId: string };

/** the text of a reply: a message's text parts, or a task's artifacts and status message, capped */
export function replyText(result: Message | Task): { text: string; taskState: string | null } {
  const texts = (parts: readonly Part[] | undefined) => (parts ?? []).flatMap((p) => (p.content?.$case === "text" ? [p.content.value] : []));
  if ("messageId" in result && "parts" in result) return { text: texts(result.parts).join("\n").slice(0, A2A_REPLY_MAX_CHARS), taskState: null };
  const task = result as Task;
  const out = [...task.artifacts.flatMap((a) => texts(a.parts)), ...texts(task.status?.message?.parts)];
  return { text: out.join("\n").slice(0, A2A_REPLY_MAX_CHARS), taskState: task.status ? String(task.status.state) : null };
}

export async function executeGovernedA2aCall(db: Db, args: GovernedA2aCallArgs, deps: A2aDeps = {}): Promise<GovernedA2aCallOutcome> {
  const skillId = args.skillId ?? null;
  const projectId = args.projectId ?? null;
  const base = { phase: "call", skillId, projectId, ...(args.ceilingAgentIds ? { ceiling: true } : {}) };
  const deny = async (status: number, error: string, ruleId: string, reason: string, label: string, extra: Record<string, unknown> = {}): Promise<GovernedA2aCallOutcome> => {
    const [row] = await db
      .insert(auditLog)
      .values({ userId: args.userId, objectType: "a2a_agent", objectId: args.agentId, toolName: skillId, detail: { ...base, ...extra }, effect: "deny", ruleId, ruleChain: [ruleId], reason: `${label}: ${reason}` })
      .returning({ id: auditLog.id });
    return { kind: "denied", status, error, ruleId, reason, auditId: row!.id };
  };

  // 1. the org setting
  const org = await loadOrgSettings(db);
  if (!org.a2aEnabled) return deny(403, "a2a_disabled", A2A_RULE_IDS.disabled, "calls to remote agents are turned off for this organisation", "Remote agent call refused");

  // 2. the agent and the skill
  const [agent] = await db.select().from(a2aAgents).where(eq(a2aAgents.id, args.agentId));
  if (!agent || !agent.enabled) return deny(404, "unknown_agent", A2A_RULE_IDS.unknownAgent, agent ? "the remote agent is turned off" : "no such remote agent", "Remote agent call refused");
  const label = `Remote agent '${agent.name}'`;
  if (skillId !== null && !cardSkills(agent.card).some((s) => s.id === skillId)) {
    return deny(400, "unknown_skill", A2A_RULE_IDS.unknownSkill, `its card lists no skill '${skillId.slice(0, 128)}'`, label);
  }

  // 3. the lead ceiling (only ever narrows)
  if (args.ceilingAgentIds && !args.ceilingAgentIds.includes(agent.id)) {
    return deny(403, "forbidden", A2A_RULE_IDS.leadCeiling, "this worker's lead does not allow it to call this agent", label);
  }

  // 4. the person's grant (default-deny)
  const [grant] = await db
    .select({ id: a2aAgentGrants.id })
    .from(a2aAgentGrants)
    .where(and(eq(a2aAgentGrants.agentId, agent.id), eq(a2aAgentGrants.userId, args.userId), skillId === null ? isNull(a2aAgentGrants.skillId) : or(isNull(a2aAgentGrants.skillId), eq(a2aAgentGrants.skillId, skillId))))
    .limit(1);
  if (!grant) {
    return deny(403, "forbidden", A2A_RULE_IDS.noGrant, skillId === null ? "you have no access to this agent" : `you have no access to this agent's skill '${skillId}'`, label);
  }

  // 5. the egress decision on the current posture
  const { decision } = await checkMcpServerUrl(db, agent.url, agent.allowPrivateRanges);
  if (!decision.ok) return deny(403, "egress_blocked", A2A_RULE_IDS.egress, decision.reason, label, { code: decision.code });

  // 6. the credential
  const opened = await openCredential(db, agent.id);
  if (!opened.ok) return deny(503, opened.reason, A2A_RULE_IDS.credentialUnavailable, "its credential could not be opened, so nothing was sent", label);

  const grantDetail = { ...base, grantId: grant.id, url: agent.url };
  let result: Message | Task;
  try {
    const fetchImpl = await agentFetch(db, agent, opened.credential, deps);
    const client = await new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl })], preferredTransports: [JSONRPC] }).createFromAgentCard(clientCard(agent.card, agent.url));
    result = await client.sendMessage(
      {
        tenant: "",
        message: { messageId: randomUUID(), contextId: "", taskId: "", role: Role.ROLE_USER, parts: [{ content: { $case: "text", value: args.text }, metadata: undefined, filename: "", mediaType: "text/plain" }], metadata: undefined, extensions: [], referenceTaskIds: [] },
        configuration: undefined,
        metadata: undefined,
      },
      { signal: AbortSignal.timeout(timeouts().outboundDefaultMs) },
    );
  } catch (err) {
    const blocked = egressRefusal(err);
    // the remote party's error text is not ours to repeat: a fixed sentence, and the egress reason when it was ours
    const reason = blocked ?? "the remote agent did not return a usable reply";
    const [row] = await db
      .insert(auditLog)
      .values({ userId: args.userId, objectType: "a2a_agent", objectId: agent.id, toolName: skillId, detail: { ...grantDetail, outcome: blocked ? "egress_blocked" : "upstream_error" }, effect: "allow", ruleId: A2A_RULE_IDS.upstreamError, ruleChain: [A2A_RULE_IDS.callAllowed], reason: `${label}: the call was allowed, but ${reason}; nothing was charged` })
      .returning({ id: auditLog.id });
    return { kind: "upstream_error", status: 502, error: "a2a_upstream_error", reason, auditId: row!.id };
  }

  const { text, taskState } = replyText(result);
  const costUsd = agent.pricePerCallUsd;
  // the spend and the decision, together
  const written = await db.transaction(async (tx) => {
    const [usage] = await tx
      .insert(usageEvents)
      .values({ userId: args.userId, objectType: "a2a_agent", operation: skillId ?? "message", costUsd, projectId, detail: { a2aAgentId: agent.id, agentName: agent.name, taskState } })
      .returning({ id: usageEvents.id });
    const [audit] = await tx
      .insert(auditLog)
      .values({ userId: args.userId, objectType: "a2a_agent", objectId: agent.id, toolName: skillId, detail: { ...grantDetail, outcome: "replied", taskState, usageEventId: usage!.id, costUsd, replyChars: text.length }, effect: "allow", ruleId: A2A_RULE_IDS.callAllowed, ruleChain: [A2A_RULE_IDS.callAllowed], reason: `${label}: message sent${skillId ? ` for skill '${skillId}'` : ""} and a reply received` })
      .returning({ id: auditLog.id });
    return { usageEventId: usage!.id, auditId: audit!.id };
  });
  return { kind: "allowed", reply: text, taskState, costUsd, ...written };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const agentParam = z.object({ agentId: z.string().uuid() });
const grantParam = z.object({ agentId: z.string().uuid(), grantId: z.string().uuid() });
const registerSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    url: z.string().url().max(2048),
    allowPrivateRanges: z.boolean().nullable().optional(),
    pricePerCallUsd: z.number().min(0).max(1000).nullable().optional(),
  })
  .strict();
const updateSchema = z.object({ enabled: z.boolean().optional(), pricePerCallUsd: z.number().min(0).max(1000).nullable().optional() }).strict();
const grantSchema = z.object({ userId: z.string().uuid(), skillId: z.string().min(1).max(128).nullable().optional() }).strict();
const callSchema = z
  .object({ text: z.string().min(1).max(A2A_MESSAGE_MAX_CHARS), skillId: z.string().min(1).max(128).nullable().optional(), projectId: z.string().uuid().nullable().optional() })
  .strict();

export function a2aAgentView(row: A2aAgentRow, credential: A2aAgentCredentialRow | undefined | null) {
  const card = row.card;
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    cardName: typeof card.name === "string" ? card.name.slice(0, 200) : row.name,
    cardDescription: typeof card.description === "string" ? card.description.slice(0, 2000) : "",
    cardVersion: typeof card.version === "string" ? card.version.slice(0, 64) : "",
    skills: cardSkills(card),
    cardFetchedAt: row.cardFetchedAt.toISOString(),
    allowPrivateRanges: row.allowPrivateRanges,
    pricePerCallUsd: row.pricePerCallUsd,
    enabled: row.enabled,
    credential: a2aCredentialView(credential),
    createdAt: row.createdAt.toISOString(),
  };
}

const actor = (req: FastifyRequest) => req.authCtx.userId ?? NIL_USER;

export function registerA2aRoutes(app: FastifyInstance, db: Db, opts: { dataKey?: string | undefined; deps?: A2aDeps } = {}): void {
  configureA2aDataKey(opts.dataKey);
  const deps = opts.deps ?? {};

  const audit = (tx: Db, req: FastifyRequest, agentId: string, ruleId: string, effect: "allow" | "deny", reason: string, detail: Record<string, unknown>) =>
    tx.insert(auditLog).values({ userId: actor(req), objectType: "a2a_agent", objectId: agentId, detail, effect, ruleId, ruleChain: [], reason });

  const loadAgent = async (agentId: string) => (await db.select().from(a2aAgents).where(eq(a2aAgents.id, agentId)))[0];

  app.get("/v1/a2a/agents", async () => {
    const [org, rows, creds] = await Promise.all([
      loadOrgSettings(db),
      db.select().from(a2aAgents).orderBy(asc(a2aAgents.name)).limit(500),
      db.select().from(a2aAgentCredentials).limit(500),
    ]);
    const byAgent = new Map(creds.map((c) => [c.agentId, c]));
    return { enabled: org.a2aEnabled, agents: rows.map((r) => a2aAgentView(r, byAgent.get(r.id))) };
  });

  app.post("/v1/a2a/agents", async (req, reply) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request", detail: "expected { name (lower-case letters, digits, hyphens), url, allowPrivateRanges?, pricePerCallUsd? }" });
    const body = parsed.data;
    const allowPrivateRanges = body.allowPrivateRanges ?? null;
    const org = await loadOrgSettings(db);
    const refuse = async (status: number, code: string, detail: string) => {
      await db.insert(auditLog).values({ userId: actor(req), objectType: "a2a_agent", objectId: null, detail: { phase: "registration", code, name: body.name, url: body.url }, effect: "deny", ruleId: A2A_RULE_IDS.registrationRefused, ruleChain: [], reason: `Remote agent '${body.name}' refused: ${detail}. Nothing was saved.` });
      return reply.status(status).send({ error: "a2a_registration_refused", code, detail });
    };
    if (!org.a2aEnabled) return refuse(409, "a2a_disabled", "calls to remote agents are turned off for this organisation; an admin turns them on in Organisation settings");
    const [taken] = await db.select({ id: a2aAgents.id }).from(a2aAgents).where(eq(a2aAgents.name, body.name));
    if (taken) return reply.status(409).send({ error: "name_taken", detail: "a remote agent with this name is already registered" });
    // write-time egress decision, before anything is fetched
    const { decision } = await checkMcpServerUrl(db, body.url, allowPrivateRanges);
    if (!decision.ok) return refuse(400, "egress_blocked", decision.reason);
    if (allowPrivateRanges === true) {
      const su = await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { op: "a2a_agent_create", name: body.name, url: body.url, values: { allowPrivateRanges: true } } });
      if (!su.ok) return reply;
    }
    const got = await fetchCard(db, body.url, allowPrivateRanges, deps);
    if (!got.ok) return refuse(got.code === "card_refused" ? 400 : 502, got.code, got.detail);
    const card = AgentCard.toJSON(got.card) as Record<string, unknown>;
    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(a2aAgents)
        .values({ name: body.name, url: body.url, card, allowPrivateRanges, pricePerCallUsd: body.pricePerCallUsd ?? null, createdBy: req.authCtx.userId ?? null })
        .onConflictDoNothing()
        .returning();
      if (!created) return null;
      await audit(tx as unknown as Db, req, created.id, A2A_RULE_IDS.registered, "allow", `Remote agent '${created.name}' registered at ${new URL(created.url).origin} with ${cardSkills(card).length} skill(s); nobody may call it until granted`, {
        phase: "registration",
        name: created.name,
        url: created.url,
        allowPrivateRanges,
        pricePerCallUsd: created.pricePerCallUsd,
        skills: cardSkills(card).map((s) => s.id),
        ...(allowPrivateRanges === true ? { relaxation: true } : {}),
      });
      return created;
    });
    if (!row) return reply.status(409).send({ error: "name_taken", detail: "a remote agent with this name is already registered" });
    return reply.status(201).send(a2aAgentView(row, null));
  });

  app.post("/v1/a2a/agents/:agentId/card", async (req, reply) => {
    const { agentId } = agentParam.parse(req.params);
    const agent = await loadAgent(agentId);
    if (!agent) return reply.status(404).send({ error: "unknown_agent" });
    const got = await fetchCard(db, agent.url, agent.allowPrivateRanges, deps);
    if (!got.ok) {
      await audit(db, req, agentId, A2A_RULE_IDS.registrationRefused, "deny", `Remote agent '${agent.name}': card refresh refused (${got.code}): ${got.detail}. The stored card is unchanged.`, { phase: "card-refresh", code: got.code });
      return reply.status(got.code === "card_refused" ? 400 : 502).send({ error: "a2a_card_refused", code: got.code, detail: got.detail });
    }
    const card = AgentCard.toJSON(got.card) as Record<string, unknown>;
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx.update(a2aAgents).set({ card, cardFetchedAt: new Date(), updatedAt: new Date() }).where(eq(a2aAgents.id, agentId)).returning();
      if (!updated) return null;
      const before = cardSkills(agent.card).map((s) => s.id);
      const after = cardSkills(card).map((s) => s.id);
      await audit(tx as unknown as Db, req, agentId, A2A_RULE_IDS.cardRefreshed, "allow", `Remote agent '${agent.name}': card refreshed (${after.length} skill(s))`, { phase: "card-refresh", skillsBefore: before, skillsAfter: after });
      return updated;
    });
    if (!row) return reply.status(404).send({ error: "unknown_agent" });
    const [cred] = await db.select().from(a2aAgentCredentials).where(eq(a2aAgentCredentials.agentId, agentId));
    return a2aAgentView(row, cred);
  });

  app.patch("/v1/a2a/agents/:agentId", async (req, reply) => {
    const { agentId } = agentParam.parse(req.params);
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success || Object.keys(parsed.data).length === 0) return reply.status(400).send({ error: "invalid_request", detail: "expected { enabled?, pricePerCallUsd? }" });
    const agent = await loadAgent(agentId);
    if (!agent) return reply.status(404).send({ error: "unknown_agent" });
    const changes = parsed.data;
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx.update(a2aAgents).set({ ...changes, updatedAt: new Date() }).where(eq(a2aAgents.id, agentId)).returning();
      if (!updated) return null;
      await audit(tx as unknown as Db, req, agentId, A2A_RULE_IDS.updated, "allow", `Remote agent '${agent.name}' updated`, {
        phase: "update",
        before: { enabled: agent.enabled, pricePerCallUsd: agent.pricePerCallUsd },
        after: { enabled: updated.enabled, pricePerCallUsd: updated.pricePerCallUsd },
      });
      return updated;
    });
    if (!row) return reply.status(404).send({ error: "unknown_agent" });
    const [cred] = await db.select().from(a2aAgentCredentials).where(eq(a2aAgentCredentials.agentId, agentId));
    return a2aAgentView(row, cred);
  });

  app.delete("/v1/a2a/agents/:agentId", async (req, reply) => {
    const { agentId } = agentParam.parse(req.params);
    const agent = await loadAgent(agentId);
    if (!agent) return reply.status(404).send({ error: "unknown_agent" });
    await db.transaction(async (tx) => {
      // the credential and the grants go with it (ON DELETE CASCADE); the trail keeps what was removed
      const grants = await tx.select({ id: a2aAgentGrants.id }).from(a2aAgentGrants).where(eq(a2aAgentGrants.agentId, agentId));
      await tx.delete(a2aAgents).where(eq(a2aAgents.id, agentId));
      await audit(tx as unknown as Db, req, agentId, A2A_RULE_IDS.removed, "allow", `Remote agent '${agent.name}' removed, with its credential and ${grants.length} grant(s)`, { phase: "removal", name: agent.name, url: agent.url, grantsRemoved: grants.length });
    });
    return reply.status(204).send();
  });

  // --- the credential -------------------------------------------------------

  const credentialStepUp = (op: "set" | "rotate" | "clear", agent: { id: string; url: string }, values: { scheme: string; headerName: string } | null) => ({
    kind: "settings_relax" as const,
    facts: { op: `a2a_credential_${op}`, agentId: agent.id, url: agent.url, ...(values ? { values: { credential: values } } : {}) },
  });

  app.get("/v1/a2a/agents/:agentId/credential", async (req, reply) => {
    const { agentId } = agentParam.parse(req.params);
    if (!(await loadAgent(agentId))) return reply.status(404).send({ error: "unknown_agent" });
    const [row] = await db.select().from(a2aAgentCredentials).where(eq(a2aAgentCredentials.agentId, agentId));
    return { credential: a2aCredentialView(row) };
  });

  app.put("/v1/a2a/agents/:agentId/credential", async (req, reply) => {
    const { agentId } = agentParam.parse(req.params);
    const parsed = setMcpUpstreamCredentialSchema.safeParse(req.body);
    // the zod issue list could echo the body back, and the body holds the secret: a fixed sentence instead
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request", detail: "expected { scheme: 'bearer' | 'header', headerName?, secret, rotate? }" });
    const body = parsed.data;
    const agent = await loadAgent(agentId);
    if (!agent) return reply.status(404).send({ error: "unknown_agent" });
    const label = `Remote agent '${agent.name}'`;
    const refuse = async (code: string, detail: string) => {
      await audit(db, req, agentId, A2A_RULE_IDS.credentialRefused, "deny", `${label}: credential refused (${code}): ${detail}. Nothing was saved.`, { phase: "credential", code });
      return reply.status(400).send({ error: "a2a_credential_refused", code, detail });
    };
    if (!opts.dataKey) return reply.status(503).send({ error: "data_key_unavailable", detail: "the data key is not configured, so a secret cannot be stored encrypted" });
    const headerName = body.scheme === "bearer" ? "authorization" : (body.headerName ?? "").trim().toLowerCase();
    if (body.scheme === "bearer" && body.headerName !== undefined && body.headerName.trim().toLowerCase() !== "authorization") {
      return refuse("header_with_bearer", "the Bearer scheme always uses Authorization; choose the header scheme to name another header");
    }
    if (body.scheme === "header") {
      const problem = mcpUpstreamHeaderNameProblem(body.headerName ?? "") ?? (A2A_RESERVED_HEADERS.includes(headerName) ? `'${headerName}' is reserved: the A2A transport sets it` : null);
      if (problem) return refuse("header_refused", problem);
    }
    const secretProblem = mcpUpstreamSecretProblem(body.secret);
    if (secretProblem) return refuse("secret_refused", secretProblem);
    const rotate = body.rotate === true;
    const [existing] = await db.select({ id: a2aAgentCredentials.id }).from(a2aAgentCredentials).where(eq(a2aAgentCredentials.agentId, agentId));
    if (Boolean(existing) !== rotate) {
      return reply.status(409).send(
        existing
          ? { error: "credential_exists", detail: "this agent already has a credential: rotate it to replace it" }
          : { error: "no_credential", detail: "this agent has no credential to rotate: set one" },
      );
    }
    const su = await checkStepUp(db, req, credentialStepUp(rotate ? "rotate" : "set", agent, { scheme: body.scheme, headerName }));
    if (!su.ok) return reply.status(su.status).send(su.body);
    const values = { scheme: body.scheme, headerName, secretCiphertext: encryptSecret(opts.dataKey, body.secret), secretLast4: body.secret.slice(-4), setBy: req.authCtx.userId ?? null };
    const row = await db.transaction(async (tx) => {
      const [saved] = rotate
        ? await tx.update(a2aAgentCredentials).set(values).where(eq(a2aAgentCredentials.agentId, agentId)).returning()
        : await tx.insert(a2aAgentCredentials).values({ agentId, ...values }).onConflictDoNothing().returning();
      if (!saved) return null;
      await audit(tx as unknown as Db, req, agentId, rotate ? A2A_RULE_IDS.credentialRotated : A2A_RULE_IDS.credentialSet, "allow", `${label}: credential ${rotate ? "rotated" : "set"} (${saved.scheme === "bearer" ? "Authorization: Bearer" : `header ${saved.headerName}`}), sent only to ${new URL(agent.url).origin}`, {
        phase: "credential",
        scheme: saved.scheme,
        headerName: saved.headerName,
        url: agent.url,
        relaxation: true,
      });
      return saved;
    });
    if (!row) return reply.status(409).send({ error: "changed_concurrently", detail: "the credential changed while this was being saved; reload and try again" });
    return reply.status(rotate ? 200 : 201).send({ credential: a2aCredentialView(row) });
  });

  app.delete("/v1/a2a/agents/:agentId/credential", async (req, reply) => {
    const { agentId } = agentParam.parse(req.params);
    const agent = await loadAgent(agentId);
    if (!agent) return reply.status(404).send({ error: "unknown_agent" });
    const [existing] = await db.select({ id: a2aAgentCredentials.id }).from(a2aAgentCredentials).where(eq(a2aAgentCredentials.agentId, agentId));
    if (!existing) return reply.status(404).send({ error: "no_credential", detail: "this agent has no credential" });
    const su = await checkStepUp(db, req, credentialStepUp("clear", agent, null));
    if (!su.ok) return reply.status(su.status).send(su.body);
    await db.transaction(async (tx) => {
      const gone = await tx.delete(a2aAgentCredentials).where(eq(a2aAgentCredentials.id, existing.id)).returning({ scheme: a2aAgentCredentials.scheme });
      if (gone.length === 0) return;
      await audit(tx as unknown as Db, req, agentId, A2A_RULE_IDS.credentialCleared, "allow", `Remote agent '${agent.name}': credential cleared; its stored secret was destroyed`, { phase: "credential", scheme: gone[0]!.scheme });
    });
    return { credential: a2aCredentialView(null) };
  });

  // --- grants (who may call) --------------------------------------------------

  app.get("/v1/a2a/agents/:agentId/grants", async (req, reply) => {
    const { agentId } = agentParam.parse(req.params);
    if (!(await loadAgent(agentId))) return reply.status(404).send({ error: "unknown_agent" });
    const rows = await db
      .select({ id: a2aAgentGrants.id, userId: a2aAgentGrants.userId, email: users.email, displayName: users.displayName, skillId: a2aAgentGrants.skillId, createdAt: a2aAgentGrants.createdAt })
      .from(a2aAgentGrants)
      .innerJoin(users, eq(users.id, a2aAgentGrants.userId))
      .where(eq(a2aAgentGrants.agentId, agentId))
      .orderBy(asc(users.email))
      .limit(1000);
    return { grants: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) };
  });

  app.post("/v1/a2a/agents/:agentId/grants", async (req, reply) => {
    const { agentId } = agentParam.parse(req.params);
    const parsed = grantSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request", detail: "expected { userId, skillId? }" });
    const { userId } = parsed.data;
    const skillId = parsed.data.skillId ?? null;
    const agent = await loadAgent(agentId);
    if (!agent) return reply.status(404).send({ error: "unknown_agent" });
    const [user] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, userId));
    if (!user) return reply.status(404).send({ error: "unknown_user" });
    if (skillId !== null && !cardSkills(agent.card).some((s) => s.id === skillId)) return reply.status(400).send({ error: "unknown_skill", detail: "the agent's card lists no such skill" });
    const row = await db.transaction(async (tx) => {
      const [created] = await tx.insert(a2aAgentGrants).values({ agentId, userId, skillId, grantedBy: req.authCtx.userId ?? null }).onConflictDoNothing().returning();
      if (!created) return null;
      await audit(tx as unknown as Db, req, agentId, A2A_RULE_IDS.granted, "allow", `Remote agent '${agent.name}': ${user.email} may now call ${skillId ? `skill '${skillId}'` : "every skill"}`, { phase: "grant", grantId: created.id, userId, skillId });
      return created;
    });
    if (!row) return reply.status(409).send({ error: "grant_exists", detail: "this person already has this access" });
    return reply.status(201).send({ id: row.id, userId, skillId, createdAt: row.createdAt.toISOString() });
  });

  app.delete("/v1/a2a/agents/:agentId/grants/:grantId", async (req, reply) => {
    const { agentId, grantId } = grantParam.parse(req.params);
    const agent = await loadAgent(agentId);
    if (!agent) return reply.status(404).send({ error: "unknown_agent" });
    const removed = await db.transaction(async (tx) => {
      const [gone] = await tx.delete(a2aAgentGrants).where(and(eq(a2aAgentGrants.id, grantId), eq(a2aAgentGrants.agentId, agentId))).returning();
      if (!gone) return false;
      await audit(tx as unknown as Db, req, agentId, A2A_RULE_IDS.grantRemoved, "allow", `Remote agent '${agent.name}': access removed`, { phase: "grant", grantId, userId: gone.userId, skillId: gone.skillId });
      return true;
    });
    if (!removed) return reply.status(404).send({ error: "unknown_grant" });
    return reply.status(204).send();
  });

  // --- the call (any authenticated person; the grant decides) ----------------

  app.post("/v1/a2a/agents/:agentId/messages", async (req, reply) => {
    const { agentId } = agentParam.parse(req.params);
    const parsed = callSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request", detail: `expected { text (1 to ${A2A_MESSAGE_MAX_CHARS} characters), skillId?, projectId? }` });
    const userId = req.authCtx.userId;
    if (!userId) return reply.status(403).send({ error: "forbidden", detail: "a remote agent is called as a person; this credential has none" });
    const out = await executeGovernedA2aCall(db, { userId, agentId, skillId: parsed.data.skillId ?? null, text: parsed.data.text, projectId: parsed.data.projectId ?? null }, deps);
    if (out.kind === "allowed") return { reply: out.reply, taskState: out.taskState, costUsd: out.costUsd, auditId: out.auditId };
    return reply.status(out.status).send({ error: out.error, detail: out.reason, auditId: out.auditId, ...(out.kind === "denied" ? { ruleId: out.ruleId } : {}) });
  });
}
