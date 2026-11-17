/**
 * ADR-0331 — GOVERNED REMOVAL OF FLAGGED MCP SERVERS FROM ENDPOINTS: the gateway half.
 *
 * An admin names one MCP server identity (exactly as ADR-0259's `mcpIdentityOf` derives it) and the endpoints to remove
 * it from. The targets are resolved once, at creation, from `endpoint_mcp_servers` evidence (user-writable config roots
 * only, live devices only); each target becomes one signed directive the endpoint agent fetches under its own DPoP-bound
 * token, verifies against its pinned keyring and applies (or refuses), then reports an outcome for.
 *
 * STRICT DEFAULT (ADR-0180), at two levels:
 *   - the org switch `discovery_settings.endpoint_addon_removal_enabled` is off; turning it on is a `settings_relax`
 *     step-up through `PUT /v1/discovery/settings` (discovery-routes.ts). While it is off no removal is created and no
 *     directive is delivered, pending ones included;
 *   - the directive signer is null in production (the ADR-0195 SD4 key ceremony is pending), so the directive route
 *     answers `503 directive_signer_unavailable`, as the config route answers `503 collection_pack_unavailable`. It is
 *     injectable only through buildApp's code-only test seam (`endpointDirectiveSigner`), never env or admin input.
 *
 * Admin routes (admin-only: none is in NON_ADMIN_ROUTES; every write audited in its own transaction):
 *   POST /v1/discovery/endpoint-addon-removals              create: `endpoint_remediation` step-up bound to the request
 *   GET  /v1/discovery/endpoint-addon-removals              list contract, newest first, target counts per status
 *   GET  /v1/discovery/endpoint-addon-removals/:id          one removal and its targets (list contract, bounded)
 *   POST /v1/discovery/endpoint-addon-removals/:id/cancel   stops undelivered and unreported targets (narrows: no step-up)
 *
 * Agent routes (registered inside endpoint-agent-routes.ts's agent scope, so they share `agentOf`, its refusals and
 * its audit; listed in ENDPOINT_AGENT_TOKEN_ROUTES):
 *   GET  /v1/endpoint-agent/directives            at most 20 signed envelopes `{keyId, payload, signature}`
 *   POST /v1/endpoint-agent/directive-outcomes    `{outcomes: [...]}`: final, idempotent per directive, refused per item
 *
 * Open source first (ADR-0176): the signature is Ed25519 from the platform (`node:crypto` in the test signer, the
 * agent's `crypto/ed25519`); the payload is plain JSON. No module was needed.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  and,
  asc,
  auditLog,
  discoverySettings,
  endpointAddonRemovals,
  endpointAddonRemovalTargets,
  endpointAgentIdentities,
  endpointAgentReports,
  endpointDevices,
  endpointMcpServers,
  ENDPOINT_ADDON_REMOVAL_ROOTS,
  ENDPOINT_DIRECTIVE_OUTCOME_CODES,
  ENDPOINT_MCP_LINK_IDENTITY_KINDS,
  eq,
  gt,
  inArray,
  isNull,
  sql,
  type Db,
  type EndpointAddonRemovalRow,
  workloadIdentities,
  ENDPOINT_ADDON_TARGET_OPEN_STATUSES,
  ENDPOINT_ADDON_TARGET_STATUSES,
  endpointAddonTargetSources,
  type SQL,
} from "@regulait/db";
import { scrubAuditText } from "@regulait/shared";
import { databaseNow } from "./db-clock.js";
import { loadDiscoverySettings } from "./discovery-posture.js";
import { ENDPOINT_AGENT_PATHS, type EndpointAgentContext } from "./endpoint-agent.js";
import { mcpIdentityInput, mcpServerSchema } from "./endpoint-mcp-config.js";
import { filterParams, parseListPage, runListPage, sendListError, type ListReader, type ListSpec } from "./list-contract.js";
import { checkStepUp, isStepUpPrompt, type StepUpCheckArgs } from "./step-up.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

// ---------------------------------------------------------------------------
// Bounds (secure by default, ADR-0180: each is the strict value; none is a setting)
// ---------------------------------------------------------------------------

export const DIRECTIVE_SCHEMA = "regulait.endpoint-directive/1";
export const DIRECTIVE_ACTION = "remove_mcp_server";
/** a removal's directives are valid for 7 days from its creation (ADR-0331 §4); the migration's CHECK pins it */
export const ADDON_REMOVAL_VALIDITY_DAYS = 7;
/** a selected list names at most 500 devices; a `recent` scope looks back 1 to 90 days */
export const ADDON_REMOVAL_MAX_DEVICES = 500;
export const ADDON_REMOVAL_MAX_DAYS = 90;
/** one removal resolves to at most this many config entries; more is refused (narrow the scope), never truncated */
export const ADDON_REMOVAL_MAX_TARGETS = 5000;
/** at most this many directives per sync, and outcomes per post (the agent's MaxDirectivesPerSync) */
export const DIRECTIVES_PER_SYNC = 20;
/** an outcomes body: 20 outcomes of about 150 bytes fit well inside it */
const OUTCOMES_BODY_LIMIT = 8 * 1024;
/** the agent's key id shape (agents/endpoint/internal/enforce: keyIDShape); a signer with another is not used */
const KEY_ID_SHAPE = /^[a-z0-9][a-z0-9-]{2,63}$/;
/** an addressable server entry name (the agent's serverShape); `(unnamed)` never is */
const SERVER_NAME_SHAPE = "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$";

/**
 * The device-policy signer (Ed25519, the ADR-0298 policy-signing key path). Owner answer B4 (2026-11-15): one rotatable
 * device-policy signer signs endpoint and browser policies; it is built by the browser lane and is not on main yet.
 * This interface is wired to that shared signer when it lands. Until then it is NULL in production; there is
 * deliberately no environment variable or setting that supplies a key (buildApp's code-only test seam injects one).
 */
export interface DevicePolicySigner {
  keyId: string;
  /** the Ed25519 signature (64 bytes) over exactly `payload` */
  sign(payload: Buffer): Promise<Buffer>;
}

type OutcomeKind = keyof typeof ENDPOINT_DIRECTIVE_OUTCOME_CODES;
const OUTCOMES = Object.keys(ENDPOINT_DIRECTIVE_OUTCOME_CODES) as OutcomeKind[];
const ALL_CODES = [...new Set(OUTCOMES.flatMap((o) => [...ENDPOINT_DIRECTIVE_OUTCOME_CODES[o]]))] as [string, ...string[]];
/** does `code` belong to `outcome` (ADR-0331 §7)? */
export const outcomeCodeValid = (outcome: OutcomeKind, code: string): boolean => (ENDPOINT_DIRECTIVE_OUTCOME_CODES[outcome] as readonly string[]).includes(code);

// ---------------------------------------------------------------------------
// Bodies (strict: an unknown member is refused)
// ---------------------------------------------------------------------------

const serverNameInput = mcpServerSchema.shape.name.refine((n) => n !== "(unnamed)", { message: "an unnamed entry cannot be addressed" });
const scopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("device"), deviceId: z.string().uuid() }).strict(),
  z
    .object({ kind: z.literal("devices"), deviceIds: z.array(z.string().uuid()).min(1).max(ADDON_REMOVAL_MAX_DEVICES) })
    .strict()
    .refine((s) => new Set(s.deviceIds.map((d) => d.toLowerCase())).size === s.deviceIds.length, { message: "deviceIds must be unique" }),
  z.object({ kind: z.literal("recent"), days: z.number().int().min(1).max(ADDON_REMOVAL_MAX_DAYS) }).strict(),
]);
export const createRemovalSchema = z
  .object({
    // `unknown` is not in the link kinds, so it is refused here (ADR-0331 §3)
    identityKind: z.enum(ENDPOINT_MCP_LINK_IDENTITY_KINDS),
    identity: mcpIdentityInput,
    packageVersion: mcpServerSchema.shape.packageVersion,
    serverName: serverNameInput.optional(),
    scope: scopeSchema,
    blockReinstall: z.boolean().default(true),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .refine((s) => [...s].every((c) => c >= " " && c !== "\u007f"), { message: "printable" }),
  })
  .strict();
export type CreateRemovalRequest = z.infer<typeof createRemovalSchema>;

const outcomesSchema = z
  .object({
    outcomes: z
      .array(
        z
          .object({
            directiveId: z.string().uuid(),
            outcome: z.enum(OUTCOMES as [OutcomeKind, ...OutcomeKind[]]),
            code: z.enum(ALL_CODES),
            notified: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(DIRECTIVES_PER_SYNC),
  })
  .strict();

/** the scope as the step-up binds it and the audit records it (a device list in canonical order) */
function canonicalScope(s: CreateRemovalRequest["scope"]): Record<string, unknown> {
  if (s.kind === "device") return { kind: "device", deviceId: s.deviceId.toLowerCase() };
  if (s.kind === "devices") return { kind: "devices", deviceIds: s.deviceIds.map((d) => d.toLowerCase()).sort() };
  return { kind: "recent", days: s.days };
}

/**
 * ADR-0331 §3: a removal is an `endpoint_remediation` step-up bound to everything it does (the identity, the asset
 * version, the endpoints, the reinstall block and the reason), so the grant cannot start a different removal.
 */
export const endpointRemediationStepUp = (b: CreateRemovalRequest): StepUpCheckArgs => ({
  kind: "endpoint_remediation",
  facts: {
    op: "endpoint_addon_removal",
    identityKind: b.identityKind,
    identity: b.identity,
    packageVersion: b.packageVersion ?? null,
    serverName: b.serverName ?? null,
    scope: canonicalScope(b.scope),
    blockReinstall: b.blockReinstall,
    reason: b.reason,
  },
});

// ---------------------------------------------------------------------------
// The directive (ADR-0331 §4): closed JSON, the agent strict-decodes it
// ---------------------------------------------------------------------------

/** RFC 3339 at whole seconds (truncated: an earlier `notAfter` only narrows the window) */
const rfc3339 = (d: Date) => new Date(Math.floor(d.getTime() / 1000) * 1000).toISOString().replace(/\.000Z$/, "Z");

export interface DirectiveInput {
  directiveId: string;
  removalId: string;
  identityId: string;
  issuedAt: Date;
  notAfter: Date;
  signatureId: string;
  root: string;
  path: string;
  serverName: string;
  identityKind: string;
  identity: string;
  packageVersion: string | null;
}

/** the exact payload, member order as in the ADR; `packageVersion` is omitted when the removal names none */
export function directivePayload(d: DirectiveInput) {
  return {
    schema: DIRECTIVE_SCHEMA,
    directiveId: d.directiveId,
    removalId: d.removalId,
    identityId: d.identityId,
    issuedAt: rfc3339(d.issuedAt),
    notAfter: rfc3339(d.notAfter),
    action: DIRECTIVE_ACTION,
    asset: {
      signatureId: d.signatureId,
      root: d.root,
      path: d.path,
      serverName: d.serverName,
      identityKind: d.identityKind,
      identity: d.identity,
      ...(d.packageVersion === null ? {} : { packageVersion: d.packageVersion }),
    },
  };
}

/** one signed envelope (the agent's `enforce.Envelope`): standard base64 of the exact payload bytes and the signature */
export async function signDirective(signer: DevicePolicySigner, d: DirectiveInput): Promise<{ keyId: string; payload: string; signature: string }> {
  const bytes = Buffer.from(JSON.stringify(directivePayload(d)), "utf8");
  const sig = await signer.sign(bytes);
  if (!Buffer.isBuffer(sig) || sig.length !== 64) throw new Error("the directive signer returned no Ed25519 signature");
  return { keyId: signer.keyId, payload: bytes.toString("base64"), signature: sig.toString("base64") };
}

// ---------------------------------------------------------------------------
// Views and lists (ADR-0226 list contract)
// ---------------------------------------------------------------------------

type StatusCounts = Record<(typeof endpointAddonRemovalTargets.$inferSelect)["status"], number> & { total: number };
const emptyCounts = (): StatusCounts => ({ pending: 0, delivered: 0, removed: 0, nothing_to_remove: 0, failed: 0, cancelled: 0, total: 0 });

function removalView(r: EndpointAddonRemovalRow, now: Date) {
  return {
    id: r.id,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    action: r.action,
    identityKind: r.identityKind,
    identity: r.identity,
    packageVersion: r.packageVersion,
    serverName: r.serverName,
    scope: r.scopeKind === "recent" ? { kind: r.scopeKind, days: r.scopeDays } : { kind: r.scopeKind },
    blockReinstall: r.blockReinstall,
    // ADR-0331 §6: recorded, shown and audited; nothing on the device enforces it until SD4 policy delivery
    blockEnforced: false,
    reason: r.reason,
    expiresAt: r.expiresAt.toISOString(),
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
    cancelledBy: r.cancelledBy,
    state: r.cancelledAt ? "cancelled" : r.expiresAt.getTime() <= now.getTime() ? "expired" : "active",
  };
}
type RemovalListRow = ReturnType<typeof removalView> & { targets: StatusCounts };

async function countsFor(db: Db, removalIds: string[]): Promise<Map<string, StatusCounts>> {
  const out = new Map<string, StatusCounts>();
  if (removalIds.length === 0) return out;
  const rows = await db
    .select({ removalId: endpointAddonRemovalTargets.removalId, status: endpointAddonRemovalTargets.status, n: sql<number>`count(*)::int` })
    .from(endpointAddonRemovalTargets)
    .where(inArray(endpointAddonRemovalTargets.removalId, removalIds))
    .groupBy(endpointAddonRemovalTargets.removalId, endpointAddonRemovalTargets.status);
  for (const r of rows) {
    const c = out.get(r.removalId) ?? emptyCounts();
    c[r.status] = Number(r.n);
    c.total += Number(r.n);
    out.set(r.removalId, c);
  }
  return out;
}

export const ADDON_REMOVALS_LIST: ListSpec<RemovalListRow> = {
  id: "endpoint-addon-removals",
  sorts: {
    created: { expr: endpointAddonRemovals.createdAt, keysetAt: endpointAddonRemovals.createdAt },
    expires: { expr: endpointAddonRemovals.expiresAt, keysetAt: endpointAddonRemovals.expiresAt },
    identity: { expr: endpointAddonRemovals.identity },
  },
  columns: {
    identity: { label: "MCP server", value: (r) => `${r.identityKind} ${r.identity}${r.packageVersion ? `@${r.packageVersion}` : ""}${r.serverName ? ` (${r.serverName})` : ""}` },
    state: { label: "State", value: (r) => r.state },
    targets: { label: "Endpoints", value: (r) => r.targets.total },
    removed: { label: "Removed", value: (r) => r.targets.removed },
    created: { label: "Created", value: (r) => new Date(r.createdAt) },
    expires: { label: "Expires", value: (r) => new Date(r.expiresAt) },
  },
  filters: [],
  defaultSort: { col: "created", dir: "desc" },
  idCol: endpointAddonRemovals.id,
};

type TargetListRow = {
  id: string;
  deviceId: string;
  devicePseudonym: string;
  /** the device user the directive is bound to: pseudonymous ids only, never a name (as the devices route) */
  identityId: string;
  deviceUserPseudonym: string;
  provider: string;
  config: { root: string; path: string };
  serverName: string;
  status: string;
  code: string | null;
  notified: boolean | null;
  deliveredAt: string | null;
  reportedAt: string | null;
};
export const ADDON_REMOVAL_TARGETS_LIST: ListSpec<TargetListRow> = {
  id: "endpoint-addon-removal-targets",
  sorts: {
    device: { expr: endpointDevices.devicePseudonym },
    status: { expr: endpointAddonRemovalTargets.status },
    reported: { expr: endpointAddonRemovalTargets.reportedAt },
  },
  columns: {
    device: { label: "Device", value: (r) => r.devicePseudonym },
    user: { label: "Device user", value: (r) => r.deviceUserPseudonym },
    config: { label: "Config file", value: (r) => `${r.config.root}/${r.config.path}` },
    status: { label: "Status", value: (r) => (r.code && r.code !== r.status ? `${r.status} (${r.code})` : r.status) },
    reported: { label: "Reported", value: (r) => (r.reportedAt ? new Date(r.reportedAt) : null) },
  },
  filters: ["status"],
  defaultSort: { col: "device", dir: "asc" },
  idCol: endpointAddonRemovalTargets.id,
};

const idParam = z.object({ id: z.string().uuid() });
const targetsFilter = z.object({ status: z.enum(ENDPOINT_ADDON_TARGET_STATUSES).optional() }).strict();

interface Refusal {
  status: number;
  body: Record<string, unknown>;
}
const refusal = (status: number, error: string, detail: string): Refusal => ({ status, body: { error, detail } });
const isRefusal = (x: unknown): x is Refusal => typeof x === "object" && x !== null && "status" in x && "body" in x;

// ---------------------------------------------------------------------------
// Admin routes
// ---------------------------------------------------------------------------

export function registerEndpointAddonRemovalRoutes(app: FastifyInstance, db: Db, opts: { signer?: DevicePolicySigner | null } = {}): void {
  const signerConfigured = !!opts.signer;
  const actor = (req: FastifyRequest) => req.authCtx.userId ?? NIL_UUID;
  const badRequest = (reply: FastifyReply, err: z.ZodError) =>
    reply.status(400).send({ error: "invalid_request", detail: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
  const audit = (t: Db, req: FastifyRequest, objectId: string | null, ruleId: string, effect: "allow" | "deny", reason: string, detail: Record<string, unknown>) =>
    t.insert(auditLog).values({
      userId: actor(req),
      objectType: "endpoint_addon_removal",
      objectId,
      detail: { subsystem: "shadow-ai-discovery", adr: "0331", ...detail },
      effect,
      ruleId,
      ruleChain: [],
      reason,
    });

  /**
   * the config entries a request resolves to, from the evidence (user-writable roots, live devices), capped. Each is
   * bound to the identity whose signed report last showed it (last_report_id → the report's identity): an entry whose
   * report is gone is skipped (never guessed), and a revoked identity is never targeted.
   */
  const resolveTargets = (t: Db, b: CreateRemovalRequest) => {
    const conds: SQL[] = [
      eq(endpointMcpServers.identityKind, b.identityKind),
      eq(endpointMcpServers.identity, b.identity),
      inArray(endpointMcpServers.configRoot, [...ENDPOINT_ADDON_REMOVAL_ROOTS]),
      sql`${endpointMcpServers.serverName} ~ ${SERVER_NAME_SHAPE}`,
      isNull(endpointDevices.revokedAt),
      eq(workloadIdentities.status, "active"),
    ];
    if (b.packageVersion !== undefined) conds.push(eq(endpointMcpServers.packageVersion, b.packageVersion));
    if (b.serverName !== undefined) conds.push(eq(endpointMcpServers.serverName, b.serverName));
    const s = b.scope;
    if (s.kind === "device") conds.push(eq(endpointMcpServers.deviceId, s.deviceId.toLowerCase()));
    else if (s.kind === "devices") conds.push(inArray(endpointMcpServers.deviceId, s.deviceIds.map((d) => d.toLowerCase())));
    else conds.push(sql`${endpointMcpServers.lastSeenAt} >= now() - make_interval(days => ${s.days})`);
    return t
      .select({
        deviceId: endpointMcpServers.deviceId,
        identityId: endpointAgentReports.identityId,
        signatureId: endpointMcpServers.signatureId,
        provider: endpointMcpServers.provider,
        configRoot: endpointMcpServers.configRoot,
        configPath: endpointMcpServers.configPath,
        serverName: endpointMcpServers.serverName,
      })
      .from(endpointMcpServers)
      .innerJoin(endpointDevices, eq(endpointDevices.id, endpointMcpServers.deviceId))
      .innerJoin(endpointAgentReports, and(eq(endpointAgentReports.id, endpointMcpServers.lastReportId), eq(endpointAgentReports.deviceId, endpointMcpServers.deviceId)))
      .innerJoin(workloadIdentities, eq(workloadIdentities.id, endpointAgentReports.identityId))
      .where(and(...conds))
      .orderBy(asc(endpointMcpServers.deviceId), asc(endpointMcpServers.configRoot), asc(endpointMcpServers.configPath), asc(endpointMcpServers.serverName))
      .limit(ADDON_REMOVAL_MAX_TARGETS + 1);
  };

  app.post("/v1/discovery/endpoint-addon-removals", async (req, reply) => {
    const parsed = createRemovalSchema.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(reply, parsed.error);
    const b = parsed.data;
    // a removal names the person who started it; a credential with no person behind it cannot start one
    const userId = req.authCtx.userId;
    if (!userId) return reply.status(403).send({ error: "person_required", detail: "a removal is started by a signed-in administrator" });
    const stepUp = endpointRemediationStepUp(b);
    const out = await db.transaction(async (tx): Promise<Refusal | { removal: EndpointAddonRemovalRow; targets: number; devices: number }> => {
      const t = tx as unknown as Db;
      // FOR SHARE: a concurrent switch-off (FOR UPDATE in PUT /v1/discovery/settings) waits for this removal, or wins
      const [settings] = await t.select({ on: discoverySettings.endpointAddonRemovalEnabled }).from(discoverySettings).where(eq(discoverySettings.id, 1)).for("share");
      if (!settings?.on) {
        return refusal(403, "addon_removal_disabled", "removing MCP servers from endpoints is off: an admin turns it on in the discovery settings (that asks you to confirm it's you, and is audited)");
      }
      // resolved before the step-up, so a request that matches nothing never spends a grant
      const found = await resolveTargets(t, b);
      if (found.length === 0) return refusal(409, "no_matching_endpoints", "no live endpoint's reports show that MCP server in a user-writable config within the scope");
      if (found.length > ADDON_REMOVAL_MAX_TARGETS) {
        return refusal(409, "too_many_endpoints", `that removal resolves to more than ${ADDON_REMOVAL_MAX_TARGETS} config entries; narrow the scope`);
      }
      // the grant is spent in this transaction, with the three writes it authorises (ADR-0331 §3)
      const su = await checkStepUp(t, req, stepUp, { spend: true });
      if (!su.ok) {
        if (!isStepUpPrompt(su.body)) {
          await audit(t, req, null, "endpoint-addon-removal-step-up-refused", "deny", `an endpoint add-on removal was refused: ${String(su.body.error)} (ADR-0331)`, {
            actionKind: stepUp.kind,
            error: su.body.error,
          });
        }
        return { status: su.status, body: su.body };
      }
      const id = randomUUID();
      const [removal] = await t
        .insert(endpointAddonRemovals)
        .values({
          id,
          createdBy: userId,
          identityKind: b.identityKind,
          identity: b.identity,
          packageVersion: b.packageVersion ?? null,
          serverName: b.serverName ?? null,
          scopeKind: b.scope.kind,
          scopeDays: b.scope.kind === "recent" ? b.scope.days : null,
          blockReinstall: b.blockReinstall,
          reason: b.reason,
          // the same transaction's now(): the CHECK holds expires_at = created_at + 7 days exactly
          createdAt: sql`now()`,
          expiresAt: sql`now() + make_interval(days => ${ADDON_REMOVAL_VALIDITY_DAYS})`,
        })
        .returning();
      await t.insert(endpointAddonRemovalTargets).values(
        found.map((f) => ({
          removalId: id,
          identityId: f.identityId,
          signatureId: f.signatureId,
          provider: f.provider,
          configRoot: f.configRoot as (typeof ENDPOINT_ADDON_REMOVAL_ROOTS)[number],
          configPath: f.configPath,
          serverName: f.serverName,
        })),
      );
      const devices = new Set(found.map((f) => f.deviceId)).size;
      await audit(
        t,
        req,
        id,
        "endpoint-addon-removal-created",
        "allow",
        `removal of MCP server ${b.identityKind} '${b.identity}' started for ${found.length} config entr${found.length === 1 ? "y" : "ies"} on ${devices} endpoint(s) (step-up ${su.method}) (ADR-0331)`,
        {
          identityKind: b.identityKind,
          identity: b.identity,
          packageVersion: b.packageVersion ?? null,
          serverName: b.serverName ?? null,
          scope: canonicalScope(b.scope),
          blockReinstall: b.blockReinstall,
          reason: scrubAuditText(b.reason),
          targets: found.length,
          devices,
          expiresAt: removal!.expiresAt.toISOString(),
          stepUp: su.method,
          stepUpKind: stepUp.kind,
        },
      );
      return { removal: removal!, targets: found.length, devices };
    });
    if (isRefusal(out)) return reply.status(out.status).send(out.body);
    const now = await databaseNow(db);
    const counts = emptyCounts();
    counts.pending = out.targets;
    counts.total = out.targets;
    return reply.status(201).send({ removal: { ...removalView(out.removal, now), targets: counts }, devices: out.devices });
  });

  const removalsReader: ListReader<RemovalListRow> = {
    fetch: async (q) => {
      const rows = await db
        .select({ r: endpointAddonRemovals, _cursorAt: q.cursorAt })
        .from(endpointAddonRemovals)
        .where(q.where)
        .orderBy(...q.orderBy)
        .limit(q.limit)
        .offset(q.offset);
      const now = await databaseNow(db);
      const counts = await countsFor(db, rows.map((r) => r.r.id));
      return rows.map((r) => ({ ...removalView(r.r, now), targets: counts.get(r.r.id) ?? emptyCounts(), _cursorAt: r._cursorAt }));
    },
    countable: (where) => db.select({ one: sql`1` }).from(endpointAddonRemovals).where(where),
    idOf: (r) => r.id,
  };

  app.get("/v1/discovery/endpoint-addon-removals", async (req, reply) => {
    try {
      const q = (req.query ?? {}) as Record<string, unknown>;
      z.object({}).strict().parse(filterParams(q));
      const page = parseListPage(ADDON_REMOVALS_LIST, q);
      const [out, settings] = await Promise.all([runListPage(db, ADDON_REMOVALS_LIST, removalsReader, undefined, page), loadDiscoverySettings(db)]);
      // the posture an admin screen shows: whether removals are on, and whether any directive could be signed yet (SD4)
      return reply.send({ ...out, enabled: settings.endpointAddonRemoval, signerConfigured });
    } catch (e) {
      if (e instanceof z.ZodError) return badRequest(reply, e);
      return sendListError(reply, e);
    }
  });

  const targetsReader: ListReader<TargetListRow> = {
    fetch: async (q) => {
      const rows = await db
        .select({
          t: endpointAddonRemovalTargets,
          deviceId: endpointAgentIdentities.deviceId,
          deviceUserPseudonym: endpointAgentIdentities.deviceUserPseudonym,
          devicePseudonym: endpointDevices.devicePseudonym,
          _cursorAt: q.cursorAt,
        })
        .from(endpointAddonRemovalTargets)
        .innerJoin(endpointAgentIdentities, eq(endpointAgentIdentities.identityId, endpointAddonRemovalTargets.identityId))
        .innerJoin(endpointDevices, eq(endpointDevices.id, endpointAgentIdentities.deviceId))
        .where(q.where)
        .orderBy(...q.orderBy)
        .limit(q.limit)
        .offset(q.offset);
      return rows.map(({ t, deviceId, deviceUserPseudonym, devicePseudonym, _cursorAt }) => ({
        id: t.id,
        deviceId,
        devicePseudonym,
        identityId: t.identityId,
        deviceUserPseudonym,
        provider: t.provider,
        config: { root: t.configRoot, path: t.configPath },
        serverName: t.serverName,
        status: t.status,
        code: t.code,
        notified: t.notified,
        deliveredAt: t.deliveredAt?.toISOString() ?? null,
        reportedAt: t.reportedAt?.toISOString() ?? null,
        _cursorAt,
      }));
    },
    countable: (where) =>
      db
        .select({ one: sql`1` })
        .from(endpointAddonRemovalTargets)
        .innerJoin(endpointAgentIdentities, eq(endpointAgentIdentities.identityId, endpointAddonRemovalTargets.identityId))
        .innerJoin(endpointDevices, eq(endpointDevices.id, endpointAgentIdentities.deviceId))
        .where(where),
    idOf: (r) => r.id,
  };

  app.get("/v1/discovery/endpoint-addon-removals/:id", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.status(400).send({ error: "invalid_request", detail: "id must be a uuid" });
    const id = p.data.id.toLowerCase();
    try {
      const q = (req.query ?? {}) as Record<string, unknown>;
      const f = targetsFilter.parse(filterParams(q));
      const page = parseListPage(ADDON_REMOVAL_TARGETS_LIST, q);
      const [r] = await db.select().from(endpointAddonRemovals).where(eq(endpointAddonRemovals.id, id));
      if (!r) return reply.status(404).send({ error: "not_found", detail: "no such removal" });
      const where = and(eq(endpointAddonRemovalTargets.removalId, id), f.status ? eq(endpointAddonRemovalTargets.status, f.status) : undefined);
      const [targets, counts, now] = await Promise.all([runListPage(db, ADDON_REMOVAL_TARGETS_LIST, targetsReader, where, page), countsFor(db, [id]), databaseNow(db)]);
      return reply.send({ removal: { ...removalView(r, now), targets: counts.get(id) ?? emptyCounts() }, targets });
    } catch (e) {
      if (e instanceof z.ZodError) return badRequest(reply, e);
      return sendListError(reply, e);
    }
  });

  app.post("/v1/discovery/endpoint-addon-removals/:id/cancel", async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.status(400).send({ error: "invalid_request", detail: "id must be a uuid" });
    const b = z.object({}).strict().safeParse(req.body ?? {});
    if (!b.success) return badRequest(reply, b.error);
    const id = p.data.id.toLowerCase();
    // cancelling narrows, so it needs no step-up (ADR-0331 §3); the removal, its targets and the audit row commit together
    const out = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const [r] = await t.select().from(endpointAddonRemovals).where(eq(endpointAddonRemovals.id, id)).for("update");
      if (!r) return null;
      if (r.cancelledAt) return { removal: r, cancelled: 0, alreadyCancelled: true };
      const stopped = await t
        .update(endpointAddonRemovalTargets)
        .set({ status: "cancelled" })
        .where(and(eq(endpointAddonRemovalTargets.removalId, id), inArray(endpointAddonRemovalTargets.status, endpointAddonTargetSources("cancelled"))))
        .returning({ id: endpointAddonRemovalTargets.id, deliveredAt: endpointAddonRemovalTargets.deliveredAt });
      const [cancelled] = await t
        .update(endpointAddonRemovals)
        .set({ cancelledAt: sql`GREATEST(now(), ${endpointAddonRemovals.createdAt})`, cancelledBy: req.authCtx.userId ?? null })
        .where(eq(endpointAddonRemovals.id, id))
        .returning();
      const wasDelivered = stopped.filter((s) => s.deliveredAt !== null).length;
      await audit(
        t,
        req,
        id,
        "endpoint-addon-removal-cancelled",
        "allow",
        `removal of MCP server ${r.identityKind} '${r.identity}' cancelled: ${stopped.length} target(s) stopped, ${wasDelivered} of them already delivered (ADR-0331)`,
        { stopped: stopped.length, alreadyDelivered: wasDelivered },
      );
      return { removal: cancelled!, cancelled: stopped.length, alreadyCancelled: false };
    });
    if (!out) return reply.status(404).send({ error: "not_found", detail: "no such removal" });
    const [counts, now] = await Promise.all([countsFor(db, [id]), databaseNow(db)]);
    return reply.send({ removal: { ...removalView(out.removal, now), targets: counts.get(id) ?? emptyCounts() }, cancelled: out.cancelled, alreadyCancelled: out.alreadyCancelled });
  });
}

// ---------------------------------------------------------------------------
// Agent routes (registered inside the endpoint agent scope of endpoint-agent-routes.ts)
// ---------------------------------------------------------------------------

export interface DirectiveRouteDeps {
  /** the calling agent, or null with the reply already sent (endpoint-agent-routes.ts) */
  agentOf(req: FastifyRequest, reply: FastifyReply): Promise<EndpointAgentContext | null>;
  /** an agent-route audit row (the scope's own, fixed fields only), written on `t` */
  audit(t: Db, sourceId: string, ruleId: string, effect: "allow" | "deny", reason: string, detail: Record<string, unknown>): Promise<unknown>;
  refuse(reply: FastifyReply, status: number, error: string): FastifyReply;
  /** the raw body as JSON, or undefined (never echoed) */
  jsonOf(body: unknown): unknown;
  signer: DevicePolicySigner | null;
}

export function registerEndpointDirectiveRoutes(scope: FastifyInstance, db: Db, deps: DirectiveRouteDeps): void {
  // Owner answer (2026-11-15): this is the agent's one narrow, audited read of its device's flagged-asset list. It is
  // scoped to the calling agent's own identity on its own device (from its token, never a parameter), and EVERY call writes one audit row
  // with fixed fields only: {deviceId, identityId, served, outcome} and, when served, the target ids. There is no other
  // agent-side read of removals or targets.
  type ReadOutcome = "served" | "none" | "switch_off" | "signer_unavailable";
  const readAudit = (t: Db, agent: EndpointAgentContext, outcome: ReadOutcome, served: string[]) =>
    deps.audit(
      t,
      agent.sourceId,
      "endpoint-agent-directives-read",
      outcome === "signer_unavailable" ? "deny" : "allow",
      outcome === "signer_unavailable"
        ? "an endpoint agent request was refused: directive_signer_unavailable (ADR-0331)"
        : `an endpoint agent read its device's removal directives: ${served.length} served (${outcome}) (ADR-0331)`,
      { deviceId: agent.deviceId, identityId: agent.identityId, served: served.length, outcome, ...(served.length ? { directiveIds: served } : {}) },
    );

  scope.get(ENDPOINT_AGENT_PATHS.directives, async (req, reply) => {
    const agent = await deps.agentOf(req, reply);
    if (!agent) return reply;
    // while the org switch is off nothing is delivered, pending directives included (ADR-0331 §2)
    if (!(await loadDiscoverySettings(db)).endpointAddonRemoval) {
      await readAudit(db, agent, "switch_off", []);
      return reply.send({ directives: [] });
    }
    const due = await db
      .select({ t: endpointAddonRemovalTargets, r: endpointAddonRemovals })
      .from(endpointAddonRemovalTargets)
      .innerJoin(endpointAddonRemovals, eq(endpointAddonRemovals.id, endpointAddonRemovalTargets.removalId))
      .where(
        and(
          // only the calling identity's own targets: the paths are relative to that device user's home
          eq(endpointAddonRemovalTargets.identityId, agent.identityId),
          inArray(endpointAddonRemovalTargets.status, ENDPOINT_ADDON_TARGET_OPEN_STATUSES),
          isNull(endpointAddonRemovals.cancelledAt),
          gt(endpointAddonRemovals.expiresAt, sql`now()`),
        ),
      )
      .orderBy(asc(endpointAddonRemovals.createdAt), asc(endpointAddonRemovalTargets.id))
      .limit(DIRECTIVES_PER_SYNC);
    if (due.length === 0) {
      await readAudit(db, agent, "none", []);
      return reply.send({ directives: [] });
    }
    const signer = deps.signer;
    if (!signer || !KEY_ID_SHAPE.test(signer.keyId)) {
      // no device-policy signer yet: an unsigned directive is never served (the agent refuses one anyway)
      await readAudit(db, agent, "signer_unavailable", []);
      return deps.refuse(reply, 503, "directive_signer_unavailable");
    }
    const issuedAt = await databaseNow(db);
    let directives: Array<{ keyId: string; payload: string; signature: string }>;
    try {
      directives = await Promise.all(
        due.map(({ t, r }) =>
          signDirective(signer, {
            directiveId: t.id,
            removalId: r.id,
            identityId: agent.identityId,
            issuedAt,
            notAfter: r.expiresAt,
            signatureId: t.signatureId,
            root: t.configRoot,
            path: t.configPath,
            serverName: t.serverName,
            identityKind: r.identityKind,
            identity: r.identity,
            packageVersion: r.packageVersion,
          }),
        ),
      );
    } catch {
      await readAudit(db, agent, "signer_unavailable", []);
      return deps.refuse(reply, 503, "directive_signer_unavailable");
    }
    const ids = due.map((d) => d.t.id);
    // the delivery mark and the read's audit row commit together
    await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      await t
        .update(endpointAddonRemovalTargets)
        .set({ status: "delivered", deliveredAt: sql`now()` })
        .where(and(inArray(endpointAddonRemovalTargets.id, ids), inArray(endpointAddonRemovalTargets.status, endpointAddonTargetSources("delivered"))));
      await readAudit(t, agent, "served", ids);
    });
    return reply.send({ directives });
  });

  scope.post(ENDPOINT_AGENT_PATHS.directiveOutcomes, { bodyLimit: OUTCOMES_BODY_LIMIT }, async (req, reply) => {
    const agent = await deps.agentOf(req, reply);
    if (!agent) return reply;
    const parsed = outcomesSchema.safeParse(deps.jsonOf(req.body));
    if (!parsed.success) {
      await deps.audit(db, agent.sourceId, "endpoint-agent-directive-outcomes-refused", "deny", "an endpoint agent request was refused: invalid_body (ADR-0331)", { code: "invalid_body", deviceId: agent.deviceId, identityId: agent.identityId });
      return deps.refuse(reply, 400, "invalid_body");
    }
    const items = parsed.data.outcomes.map((o) => ({ ...o, directiveId: o.directiveId.toLowerCase() }));
    const result = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const rows = await t
        .select({ id: endpointAddonRemovalTargets.id, identityId: endpointAddonRemovalTargets.identityId, status: endpointAddonRemovalTargets.status, code: endpointAddonRemovalTargets.code })
        .from(endpointAddonRemovalTargets)
        .where(inArray(endpointAddonRemovalTargets.id, [...new Set(items.map((i) => i.directiveId))]))
        .for("update");
      const byId = new Map(rows.map((r) => [r.id, r]));
      const seen = new Set<string>();
      const accepted: Array<{ directiveId: string; outcome: string; code: string; notified: boolean; repeat: boolean }> = [];
      const refused: Array<{ directiveId: string; code: string }> = [];
      const refusedDetail: Array<{ directiveId: string; code: string; outcome: string; outcomeCode: string }> = [];
      const refuseItem = (i: (typeof items)[number], code: string) => {
        refused.push({ directiveId: i.directiveId, code });
        refusedDetail.push({ directiveId: i.directiveId, code, outcome: i.outcome, outcomeCode: i.code });
      };
      for (const i of items) {
        if (seen.has(i.directiveId)) {
          refuseItem(i, "duplicate_directive");
          continue;
        }
        seen.add(i.directiveId);
        if (!outcomeCodeValid(i.outcome, i.code)) {
          refuseItem(i, "code_mismatch");
          continue;
        }
        const row = byId.get(i.directiveId);
        if (!row) {
          refuseItem(i, "unknown_directive");
          continue;
        }
        // an outcome counts only from the identity the directive is bound to (another user's, or another device's)
        if (row.identityId !== agent.identityId) {
          refuseItem(i, "not_your_directive");
          continue;
        }
        const sources = endpointAddonTargetSources(i.outcome);
        if (sources.includes(row.status)) {
          await t
            .update(endpointAddonRemovalTargets)
            .set({ status: i.outcome, code: i.code, notified: i.notified, reportedAt: sql`GREATEST(now(), ${endpointAddonRemovalTargets.deliveredAt})` })
            .where(and(eq(endpointAddonRemovalTargets.id, row.id), inArray(endpointAddonRemovalTargets.status, sources)));
          accepted.push({ directiveId: row.id, outcome: i.outcome, code: i.code, notified: i.notified, repeat: false });
        } else if (row.status === i.outcome && row.code === i.code) {
          // final already, with this same outcome: a retry of a post whose answer was lost
          accepted.push({ directiveId: row.id, outcome: i.outcome, code: i.code, notified: i.notified, repeat: true });
        } else if (row.status === "pending") {
          refuseItem(i, "not_delivered");
        } else if (row.status === "cancelled") {
          refuseItem(i, "directive_cancelled");
        } else {
          refuseItem(i, "outcome_conflict");
        }
      }
      const fresh = accepted.filter((a) => !a.repeat);
      if (accepted.length > 0) {
        await deps.audit(t, agent.sourceId, "endpoint-agent-directive-outcomes-recorded", "allow", `an endpoint agent reported ${fresh.length} add-on removal outcome(s) (${accepted.length - fresh.length} repeated) (ADR-0331)`, {
          deviceId: agent.deviceId,
          identityId: agent.identityId,
          outcomes: accepted,
        });
      }
      if (refused.length > 0) {
        // the refused outcomes are kept as evidence (closed vocabulary only), never applied
        await deps.audit(t, agent.sourceId, "endpoint-agent-directive-outcomes-refused", "deny", `an endpoint agent reported ${refused.length} add-on removal outcome(s) that were refused (ADR-0331)`, {
          deviceId: agent.deviceId,
          identityId: agent.identityId,
          refused: refusedDetail,
        });
      }
      return { accepted: accepted.length, refused };
    });
    return reply.send(result);
  });
}
