/**
 * ADR-0259 (P35) — MCP client configs on employee machines, through the read-only ADR-0195 SD4 endpoint agent.
 *
 * The agent's `mcp_config` collector reports one fact per server entry of an MCP host's config (Claude Desktop,
 * Cursor, VS Code, …): an identifier-shaped name, the transport, the command's base name, the package or image it
 * runs, a remote host, risk flag names, risky auto-approved tool names and key presence (name and rule id, never a
 * value). This module:
 *
 *   - validates that shape (`mcpServerSchema`, used by the report schema in endpoint-agent.ts);
 *   - reduces the facts to inventory sightings, keeping a secret only as its TYPE (the rule id) and never its name;
 *   - stores them per device in `endpoint_mcp_servers` (evidence, refreshed by each newer report, pruned when a
 *     complete report no longer lists them, deleted past the endpoint retention);
 *   - serves the admin inventory with its registry diff: `linked` (an admin linked the identity to an approved
 *     `mcp_servers` row), `registered` (a remote server whose host is a registered server's host) or
 *     `unregistered`, plus the shadow-AI finding the same report fed (its host config's catalogue sighting);
 *   - lets an admin link an identity to an approved server, or remove the link (both audited).
 *
 * The org switch (`discovery_settings.endpoint_mcp_config_enabled`, off) gates all of it: while it is off the
 * gateway names no opt-in kind in the agent's org policy and refuses (counts, never stores) every mcp_config fact.
 * Nothing here contacts a device or a configured server.
 *
 *   GET  /v1/discovery/endpoint-mcp-servers                 the inventory (keyset paginated, filters below)
 *   POST /v1/discovery/endpoint-mcp-server-links            {identityKind, identity, mcpServerId} link, audited
 *   POST /v1/discovery/endpoint-mcp-server-links/remove     {identityKind, identity} unlink, audited
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  and,
  asc,
  auditLog,
  endpointDevices,
  endpointMcpServerLinks,
  endpointMcpServers,
  ENDPOINT_MCP_LINK_IDENTITY_KINDS,
  ENDPOINT_MCP_RISKS,
  eq,
  gt,
  inArray,
  lt,
  mcpServers,
  shadowAiFindings,
  sql,
  type Db,
} from "@regulait/db";
import { loadDiscoverySettings, type DiscoverySettingsView } from "./discovery-posture.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
export const MCP_CONFIG_KIND = "mcp_config";
export const MCP_SERVER_MATCHED_ON = "mcpServer";
/** the opt-in kinds the agent collects only when its org policy names them (contract.OptInKinds) */
export const ENDPOINT_OPT_IN_KINDS = [MCP_CONFIG_KIND] as const;
const UNNAMED = "(unnamed)";
const SECRET_TYPES_MAX = 32;

// ---------------------------------------------------------------------------
// The wire shape (agents/endpoint/internal/contract: MCPServer)
// ---------------------------------------------------------------------------

const keyFoundSchema = z.object({ keyName: z.string().min(1).max(128), ruleId: z.string().max(64).optional(), present: z.boolean() }).strict();

export const mcpServerSchema = z
  .object({
    name: z.string().regex(/^(?:\(unnamed\)|[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/),
    transport: z.enum(["stdio", "http", "sse", "unknown"]),
    command: z
      .string()
      .regex(/^(?:\(unnamed\)|[A-Za-z0-9][A-Za-z0-9._+-]{0,63})$/)
      .optional(),
    package: z
      .string()
      .regex(/^[a-z0-9@][a-z0-9@._~/:-]{0,254}$/)
      .refine((p) => !p.includes(".."), { message: "a package has no '..'" })
      .optional(),
    packageVersion: z
      .string()
      .regex(/^[A-Za-z0-9^~*<>=][A-Za-z0-9.+_^~*<>=:-]{0,63}$/)
      .optional(),
    host: z
      .string()
      .regex(/^(?:[a-z0-9][a-z0-9.-]{0,252}|\[[0-9a-f:.]{2,45}\]|[0-9a-f:.]{2,45})(?::[0-9]{1,5})?$/)
      .optional(),
    disabled: z.boolean().optional(),
    risks: z.array(z.enum(ENDPOINT_MCP_RISKS)).max(ENDPOINT_MCP_RISKS.length).optional(),
    riskyTools: z
      .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/))
      .max(20)
      .optional(),
    autoApprovedTools: z.number().int().min(0).max(10_000).optional(),
    keys: z.array(keyFoundSchema).max(32).optional(),
  })
  .strict();
export type McpServerFact = z.infer<typeof mcpServerSchema>;

/** what of a report's mcp_config fact this module reads */
export interface McpConfigFact {
  kind: string;
  signatureId: string;
  provider: string;
  matchedOn: string;
  location: { root: string; path: string };
  server?: McpServerFact | undefined;
}

// ---------------------------------------------------------------------------
// Facts -> inventory sightings (pure)
// ---------------------------------------------------------------------------

export type McpIdentityKind = "package" | "host" | "command" | "unknown";

export interface McpServerSighting {
  signatureId: string;
  provider: string;
  configRoot: "home" | "system_applications" | "appdata" | "localappdata";
  configPath: string;
  serverName: string;
  transport: McpServerFact["transport"];
  command: string | null;
  package: string | null;
  packageVersion: string | null;
  host: string | null;
  identityKind: McpIdentityKind;
  identity: string;
  disabled: boolean;
  risks: Array<(typeof ENDPOINT_MCP_RISKS)[number]>;
  riskyTools: string[];
  autoApprovedTools: number;
  /** the rule ids of the keys found, never their names or values; `listed_name` when only the name matched */
  secretTypes: string[];
}

const CONFIG_ROOTS = new Set(["home", "system_applications", "appdata", "localappdata"]);

/** the identity a link and the registry diff use: the package, else the remote host, else the command */
export function mcpIdentityOf(s: Pick<McpServerFact, "package" | "host" | "command">): { identityKind: McpIdentityKind; identity: string } {
  if (s.package) return { identityKind: "package", identity: s.package };
  if (s.host) return { identityKind: "host", identity: s.host };
  if (s.command && s.command !== UNNAMED) return { identityKind: "command", identity: s.command };
  return { identityKind: "unknown", identity: UNNAMED };
}

/** inventory sightings of a report's mcp_config facts; anything malformed is skipped (the report schema refuses it) */
export function mcpSightingsOf(facts: readonly McpConfigFact[]): McpServerSighting[] {
  const out = new Map<string, McpServerSighting>();
  for (const f of facts) {
    if (f.kind !== MCP_CONFIG_KIND || f.matchedOn !== MCP_SERVER_MATCHED_ON || !f.server || !CONFIG_ROOTS.has(f.location.root) || !f.location.path) continue;
    const s = f.server;
    const id = mcpIdentityOf(s);
    const secretTypes = [...new Set((s.keys ?? []).filter((k) => k.present).map((k) => k.ruleId || "listed_name"))].sort().slice(0, SECRET_TYPES_MAX);
    const sighting: McpServerSighting = {
      signatureId: f.signatureId,
      provider: f.provider,
      configRoot: f.location.root as McpServerSighting["configRoot"],
      configPath: f.location.path,
      serverName: s.name,
      transport: s.transport,
      command: s.command ?? null,
      package: s.package ?? null,
      packageVersion: s.packageVersion ?? null,
      host: s.host ?? null,
      ...id,
      disabled: s.disabled === true,
      risks: [...new Set(s.risks ?? [])],
      riskyTools: [...new Set(s.riskyTools ?? [])].sort(),
      autoApprovedTools: s.autoApprovedTools ?? 0,
      secretTypes,
    };
    // the table's unique key: one row per device, config file, entry name and identity
    out.set(JSON.stringify([sighting.configRoot, sighting.configPath, sighting.serverName, sighting.identityKind, sighting.identity]), sighting);
  }
  return [...out.values()];
}

/**
 * The org policy the gateway serves an agent (`contract.OrgPolicy`): ADR-0259's opt-in kinds only when the org
 * turned them on. Served by the agent config route once the collection pack is signed (ADR-0195 SD4).
 */
export function endpointOrgPolicy(settings: Pick<DiscoverySettingsView, "endpointMcpConfig">, intervalSeconds = 24 * 3600) {
  return { intervalSeconds, disabledKinds: [] as string[], enabledOptInKinds: settings.endpointMcpConfig ? [...ENDPOINT_OPT_IN_KINDS] : [] };
}

// ---------------------------------------------------------------------------
// Storing (called by the report route, after the report row is written)
// ---------------------------------------------------------------------------

/**
 * Upsert one report's sightings for its device. A row only moves forward (an older report never overwrites a
 * newer one). When the report observed mcp_config completely (`complete`: no mcp_config gap), rows of the device
 * that this report did not list are deleted: the server is no longer configured.
 */
export async function recordMcpServers(
  db: Db,
  input: { deviceId: string; reportId: string; collectedAt: Date; sightings: readonly McpServerSighting[]; complete: boolean },
): Promise<{ upserted: number; pruned: number }> {
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    let upserted = 0;
    for (const s of input.sightings) {
      const values = { ...s, deviceId: input.deviceId, lastReportId: input.reportId, firstSeenAt: input.collectedAt, lastSeenAt: input.collectedAt };
      const { signatureId, provider, transport, command, package: pkg, packageVersion, host, disabled, risks, riskyTools, autoApprovedTools, secretTypes } = s;
      const rows = await t
        .insert(endpointMcpServers)
        .values(values)
        .onConflictDoUpdate({
          target: [endpointMcpServers.deviceId, endpointMcpServers.configRoot, endpointMcpServers.configPath, endpointMcpServers.serverName, endpointMcpServers.identityKind, endpointMcpServers.identity],
          set: { lastReportId: input.reportId, signatureId, provider, transport, command, package: pkg, packageVersion, host, disabled, risks, riskyTools, autoApprovedTools, secretTypes, lastSeenAt: input.collectedAt },
          setWhere: sql`${endpointMcpServers.lastSeenAt} <= ${input.collectedAt.toISOString()}::timestamptz`,
        })
        .returning({ id: endpointMcpServers.id });
      upserted += rows.length;
    }
    let pruned = 0;
    if (input.complete) {
      const gone = await t
        .delete(endpointMcpServers)
        .where(and(eq(endpointMcpServers.deviceId, input.deviceId), lt(endpointMcpServers.lastSeenAt, input.collectedAt))!)
        .returning({ id: endpointMcpServers.id });
      pruned = gone.length;
    }
    return { upserted, pruned };
  });
}

/** ADR-0195 decision 20: inventory rows not seen within the endpoint retention are deleted (the job's batch size) */
export async function runEndpointMcpRetention(db: Db, retentionDays: number, batch: number): Promise<number> {
  const res = await db.execute(sql`
    DELETE FROM endpoint_mcp_servers
     WHERE id IN (SELECT id FROM endpoint_mcp_servers
                   WHERE last_seen_at < now() - make_interval(days => ${retentionDays})
                   LIMIT ${batch})
     RETURNING id`);
  return res.rows.length;
}

// ---------------------------------------------------------------------------
// Admin routes
// ---------------------------------------------------------------------------

/** the host of an `mcp_servers.url`, lower-case, without the scheme's default port: the agent's `host` form */
const REGISTRY_HOST = sql`(
  CASE
    WHEN lower(${mcpServers.url}) LIKE 'https://%' THEN regexp_replace(lower(substring(${mcpServers.url} from '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^@/?#]*@)?([^/?#]+)')), ':443$', '')
    WHEN lower(${mcpServers.url}) LIKE 'http://%' THEN regexp_replace(lower(substring(${mcpServers.url} from '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^@/?#]*@)?([^/?#]+)')), ':80$', '')
    ELSE lower(substring(${mcpServers.url} from '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^@/?#]*@)?([^/?#]+)'))
  END)`;

const LINKED_SERVER = sql<string | null>`(SELECT ${endpointMcpServerLinks.mcpServerId} FROM ${endpointMcpServerLinks}
   WHERE ${endpointMcpServerLinks.identityKind} = ${endpointMcpServers.identityKind} AND ${endpointMcpServerLinks.identity} = ${endpointMcpServers.identity})`;
const REGISTERED_SERVER = sql<string | null>`(SELECT ${mcpServers.id} FROM ${mcpServers}
   WHERE ${endpointMcpServers.host} IS NOT NULL AND ${REGISTRY_HOST} = ${endpointMcpServers.host} ORDER BY ${mcpServers.name} LIMIT 1)`;

const listQuery = z
  .object({
    status: z.enum(["unregistered", "registered", "linked"]).optional(),
    risky: z.enum(["true", "false"]).optional(),
    secrets: z.enum(["true", "false"]).optional(),
    deviceId: z.string().uuid().optional(),
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

const linkBody = z
  .object({
    identityKind: z.enum(ENDPOINT_MCP_LINK_IDENTITY_KINDS),
    // the shapes the agent reports for a package, a host or a command (never free text)
    identity: z.string().regex(/^[A-Za-z0-9@[][A-Za-z0-9@._~/:+[\]-]{0,254}$/),
    mcpServerId: z.string().uuid(),
  })
  .strict();
const unlinkBody = linkBody.omit({ mcpServerId: true }).strict();

const refuse = (reply: FastifyReply, status: number, error: string, detail: string) => reply.status(status).send({ error, detail });

export function registerEndpointMcpConfigRoutes(app: FastifyInstance, db: Db): void {
  const actor = (req: FastifyRequest) => req.authCtx.userId ?? NIL_UUID;

  app.get("/v1/discovery/endpoint-mcp-servers", async (req, reply) => {
    const q = listQuery.safeParse(req.query ?? {});
    if (!q.success) return refuse(reply, 400, "invalid_query", q.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const f = q.data;
    const settings = await loadDiscoverySettings(db);
    const conds = [];
    if (f.cursor) conds.push(gt(endpointMcpServers.id, f.cursor));
    if (f.deviceId) conds.push(eq(endpointMcpServers.deviceId, f.deviceId));
    if (f.risky === "true") conds.push(sql`cardinality(${endpointMcpServers.risks}) > 0`);
    if (f.risky === "false") conds.push(sql`cardinality(${endpointMcpServers.risks}) = 0`);
    if (f.secrets === "true") conds.push(sql`cardinality(${endpointMcpServers.secretTypes}) > 0`);
    if (f.secrets === "false") conds.push(sql`cardinality(${endpointMcpServers.secretTypes}) = 0`);
    if (f.status === "linked") conds.push(sql`${LINKED_SERVER} IS NOT NULL`);
    if (f.status === "registered") conds.push(sql`${LINKED_SERVER} IS NULL AND ${REGISTERED_SERVER} IS NOT NULL`);
    if (f.status === "unregistered") conds.push(sql`${LINKED_SERVER} IS NULL AND ${REGISTERED_SERVER} IS NULL`);
    const rows = await db
      .select({
        row: endpointMcpServers,
        devicePseudonym: endpointDevices.devicePseudonym,
        linkedServerId: LINKED_SERVER,
        registeredServerId: REGISTERED_SERVER,
      })
      .from(endpointMcpServers)
      .innerJoin(endpointDevices, eq(endpointDevices.id, endpointMcpServers.deviceId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(endpointMcpServers.id))
      .limit(f.limit + 1);
    const page = rows.slice(0, f.limit);
    // names of the servers the page points at, and the shadow-AI findings its devices' host configs fed
    const serverIds = [...new Set(page.flatMap((r) => [r.linkedServerId, r.registeredServerId]).filter((x): x is string => !!x))];
    const names = new Map<string, string>();
    if (serverIds.length) {
      for (const s of await db.select({ id: mcpServers.id, name: mcpServers.name }).from(mcpServers).where(inArray(mcpServers.id, serverIds))) names.set(s.id, s.name);
    }
    const subjects = [...new Set(page.map((r) => r.devicePseudonym))];
    const findings = new Map<string, string>();
    if (subjects.length) {
      const found = await db
        .select({ id: shadowAiFindings.id, subject: shadowAiFindings.subject, provider: shadowAiFindings.provider })
        .from(shadowAiFindings)
        .where(and(eq(shadowAiFindings.subjectKind, "device"), inArray(shadowAiFindings.subject, subjects)));
      for (const x of found) findings.set(`${x.subject}\u0000${x.provider}`, x.id);
    }
    const items = page.map(({ row, devicePseudonym, linkedServerId, registeredServerId }) => {
      const registry = linkedServerId
        ? { status: "linked" as const, mcpServerId: linkedServerId, mcpServerName: names.get(linkedServerId) ?? null }
        : registeredServerId
          ? { status: "registered" as const, mcpServerId: registeredServerId, mcpServerName: names.get(registeredServerId) ?? null }
          : { status: "unregistered" as const, mcpServerId: null, mcpServerName: null };
      return {
        id: row.id,
        deviceId: row.deviceId,
        devicePseudonym,
        hostApp: { signatureId: row.signatureId, provider: row.provider },
        config: { root: row.configRoot, path: row.configPath },
        serverName: row.serverName,
        transport: row.transport,
        command: row.command,
        package: row.package,
        packageVersion: row.packageVersion,
        host: row.host,
        identity: { kind: row.identityKind, value: row.identity },
        disabled: row.disabled,
        risks: row.risks,
        riskyTools: row.riskyTools,
        autoApprovedTools: row.autoApprovedTools,
        secretTypes: row.secretTypes,
        registry,
        verdict:
          registry.status === "unregistered"
            ? "UNREGISTERED: this MCP server is configured on the device and matches no server in this deployment's registry and no admin link, so nothing about its tool calls is governed here."
            : registry.status === "linked"
              ? `Linked by an admin to the approved server '${registry.mcpServerName ?? registry.mcpServerId}'.`
              : `Its host is the registered server '${registry.mcpServerName ?? registry.mcpServerId}'.`,
        findingId: findings.get(`${devicePseudonym}\u0000${row.provider}`) ?? null,
        firstSeenAt: row.firstSeenAt.toISOString(),
        lastSeenAt: row.lastSeenAt.toISOString(),
      };
    });
    return {
      enabled: settings.endpointMcpConfig,
      posture: settings.endpointMcpConfig
        ? "Endpoint MCP config discovery is on: enrolled endpoint agents read the MCP host configs the signed collection pack names, read-only. No configured server is started or contacted, and no argument, env or header value or key leaves the device."
        : "Endpoint MCP config discovery is off: no endpoint agent reads MCP host configs, and any such fact a device sends is refused, not stored.",
      items,
      nextCursor: rows.length > f.limit ? page[page.length - 1]!.row.id : null,
    };
  });

  app.post("/v1/discovery/endpoint-mcp-server-links", async (req, reply) => {
    const b = linkBody.safeParse(req.body ?? {});
    if (!b.success) return refuse(reply, 400, "invalid_body", b.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const { identityKind, identity, mcpServerId } = b.data;
    const out = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const [server] = await t.select({ id: mcpServers.id, name: mcpServers.name }).from(mcpServers).where(eq(mcpServers.id, mcpServerId)).for("share");
      if (!server) return null;
      const [prev] = await t
        .select()
        .from(endpointMcpServerLinks)
        .where(and(eq(endpointMcpServerLinks.identityKind, identityKind), eq(endpointMcpServerLinks.identity, identity)))
        .for("update");
      await t
        .insert(endpointMcpServerLinks)
        .values({ identityKind, identity, mcpServerId, linkedBy: req.authCtx.userId ?? null })
        .onConflictDoUpdate({
          target: [endpointMcpServerLinks.identityKind, endpointMcpServerLinks.identity],
          set: { mcpServerId, linkedBy: req.authCtx.userId ?? null, linkedAt: sql`now()` },
        });
      await t.insert(auditLog).values({
        userId: actor(req),
        objectType: "mcp_server",
        objectId: server.id,
        detail: { subsystem: "shadow-ai-discovery", adr: "0259", identityKind, identity, previousMcpServerId: prev?.mcpServerId ?? null },
        effect: "allow",
        ruleId: "endpoint-mcp-server-linked",
        ruleChain: [],
        reason: `configured MCP server ${identityKind} '${identity}' linked to the approved server '${server.name}' (ADR-0259)`,
      });
      return server;
    });
    if (!out) return refuse(reply, 404, "mcp_server_not_found", "no MCP server with that id is registered; register it first");
    return reply.status(201).send({ identityKind, identity, mcpServerId: out.id, mcpServerName: out.name });
  });

  app.post("/v1/discovery/endpoint-mcp-server-links/remove", async (req, reply) => {
    const b = unlinkBody.safeParse(req.body ?? {});
    if (!b.success) return refuse(reply, 400, "invalid_body", b.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const { identityKind, identity } = b.data;
    const removed = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const [gone] = await t
        .delete(endpointMcpServerLinks)
        .where(and(eq(endpointMcpServerLinks.identityKind, identityKind), eq(endpointMcpServerLinks.identity, identity)))
        .returning();
      if (!gone) return null;
      await t.insert(auditLog).values({
        userId: actor(req),
        objectType: "mcp_server",
        objectId: gone.mcpServerId,
        detail: { subsystem: "shadow-ai-discovery", adr: "0259", identityKind, identity },
        effect: "allow",
        ruleId: "endpoint-mcp-server-unlinked",
        ruleChain: [],
        reason: `configured MCP server ${identityKind} '${identity}' unlinked from its approved server (ADR-0259)`,
      });
      return gone;
    });
    if (!removed) return refuse(reply, 404, "link_not_found", "that identity is not linked to any server");
    return { identityKind, identity, removed: true };
  });
}
