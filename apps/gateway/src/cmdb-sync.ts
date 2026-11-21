/**
 * ADR-0358 (lane E39) part 2 — CMDB SYNC of the AI asset inventory, ServiceNow first, behind a vendor-neutral adapter.
 *
 *   GET    /v1/cmdb/connectors                          connectors, their posture and credential (never the secret)
 *   POST   /v1/cmdb/connectors                          create one, DISABLED and export only
 *   PUT    /v1/cmdb/connectors/:connectorId/config      instance, source name, CI classes, ownership read-back
 *   PUT    /v1/cmdb/connectors/:connectorId/credential  store or rotate (compare-and-set), step-up + reason
 *   DELETE /v1/cmdb/connectors/:connectorId/credential  revoke: destroys the secret, disables the connector
 *   PUT    /v1/cmdb/connectors/:connectorId/enabled     on (step-up + reason, a live credential, not air-gapped) / off
 *   POST   /v1/cmdb/connectors/:connectorId/sync        sync now (the scheduler's function)
 *   GET    /v1/cmdb/connectors/:connectorId/runs        the run ledger, paginated
 *   GET    /v1/cmdb/connectors/:connectorId/links       the exported CIs and the recorded ownership, paginated
 *
 * All admin-only through the default gate.
 *
 * WHAT LEAVES. One `CmdbExportItem` per asset: kind, stable source key (`regulait:<kind>:<id>`) and display name. No
 * prompt, configuration body, credential, email or free text. Agents and MCP servers by their registry name, models
 * as the distinct provider/model pairs of the agent registry, endpoints as enrolled, unrevoked devices by pseudonym.
 *
 * IDEMPOTENT. ServiceNow's Identification and Reconciliation Engine (`POST /api/now/identifyreconcile`) identifies
 * each item by `sys_object_source_info.source_native_key`, so a re-push updates the same CI. `cmdb_ci_links` keeps the
 * CI sys_id and the hash of the last accepted payload: an unchanged asset is not re-sent. An item the CMDB did not
 * confirm leaves its link as it was, so the next pass retries it.
 *
 * EXPORT ONLY BY DEFAULT. The ownership read-back (Table API, `owned_by.email`) is off until an admin turns it on (a
 * relaxation, step-up). It is RECORDED on the link and never changes RegulAIt's own owner fields.
 *
 * OFF BY DEFAULT (ADR-0180, as ADR-0322). Created disabled; enabling needs a live credential, a step-up and a reason;
 * the host must be on the egress allow-list (the guarded fetch refuses it otherwise); refused in code under
 * REGULAIT_DEPLOY_MODE=air_gapped. Changing the instance URL revokes the credential and disables the connector, so a
 * stored password is never sent to a host it was not stored for.
 *
 * NO VENDOR TEXT IS KEPT. A failure is a fixed error code (CHECK-constrained); nothing the CMDB returned is logged or
 * stored except the CI sys_id and the owner email the read-back asked for.
 */
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  agents,
  and,
  asc,
  auditLog,
  cmdbCiLinks,
  cmdbConnectors,
  cmdbCredentials,
  cmdbSyncRuns,
  CMDB_SYNC_ERROR_CODES,
  desc,
  endpointDevices,
  eq,
  inArray,
  isNotNull,
  isNull,
  mcpServers,
  sql,
  users,
  type CmdbConnectorRow,
  type CmdbSyncRunRow,
  type Db,
} from "@regulait/db";
import {
  CMDB_DEFAULT_CI_CLASSES,
  CMDB_DEFAULT_SOURCE_NAME,
  CMDB_LIMITS,
  cmdbCiClassesSchema,
  cmdbInstanceUrlProblem,
  CMDB_SYNC_RUN_MACHINE,
  cmdbSourceKey,
  createCmdbConnectorSchema,
  setCmdbEnabledSchema,
  storeCmdbCredentialSchema,
  updateCmdbConfigSchema,
  type CmdbAssetKind,
  type CmdbCiClasses,
  type CmdbExportItem,
} from "@regulait/shared";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { loadEgressAllowList } from "./custom-providers.js";
import { createGuardedFetch, egressRefusal, egressResponseTooLarge, normalizeHost, type EgressResolver } from "./egress-guard.js";
import { resolveDeployMode } from "./deploy-posture.js";
import { requireStepUp } from "./step-up.js";
import type { SchedulerJobDefinition } from "./scheduler.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
export const CMDB_SYNC_JOB_NAME = "cmdb-sync-sweep";
export type CmdbErrorCode = (typeof CMDB_SYNC_ERROR_CODES)[number];

export const CMDB_RULE_IDS = {
  created: "cmdb-connector-created",
  configured: "cmdb-connector-configured",
  credentialStored: "cmdb-credential-stored",
  credentialRevoked: "cmdb-credential-revoked",
  enabled: "cmdb-connector-enabled",
  disabled: "cmdb-connector-disabled",
  sync: "cmdb-sync-run",
} as const;

// ---------------------------------------------------------------------------
// the adapter contract (vendor-neutral) and the ServiceNow implementation
// ---------------------------------------------------------------------------

export interface CmdbPushItem {
  item: CmdbExportItem;
  ciClass: string;
}
/** per input item, in input order: the CI the CMDB confirmed, or null when it did not */
export type CmdbPushResult = { ok: true; sysIds: Array<string | null> } | { ok: false; code: CmdbErrorCode };
export type CmdbOwnershipResult = { ok: true; owners: Map<string, string | null> } | { ok: false; code: CmdbErrorCode };

export interface CmdbAdapter {
  push(items: CmdbPushItem[]): Promise<CmdbPushResult>;
  readOwnership(refs: Array<{ ciClass: string; sysId: string }>): Promise<CmdbOwnershipResult>;
}

export interface CmdbSyncDeps {
  resolve?: EgressResolver | undefined;
  fetchImpl?: typeof fetch | undefined;
}

const SYS_ID = /^[0-9a-f]{32}$/;
const ireResponse = z.object({
  result: z.object({
    items: z
      .array(
        z
          .object({
            sysId: z.string().nullish(),
            inputIndices: z.array(z.unknown()).optional(),
            errorCount: z.number().optional(),
          })
          .passthrough(),
      )
      .max(CMDB_LIMITS.pushBatchSize * 2),
  }),
});
const tableResponse = z.object({
  result: z.array(z.object({ sys_id: z.string() }).catchall(z.unknown())).max(CMDB_LIMITS.readBatchSize),
});

/** "YYYY-MM-DD hh:mm:ss" UTC, the IRE recency format */
function ireTimestamp(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function statusCode(status: number): CmdbErrorCode {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate_limited";
  return "http_error";
}

function transportCode(err: unknown): CmdbErrorCode {
  if (egressResponseTooLarge(err)) return "bad_response";
  if (egressRefusal(err)) return "egress_blocked";
  let cur: unknown = err;
  for (let i = 0; i < 8 && cur; i += 1) {
    if (cur instanceof Error && (cur.name === "TimeoutError" || cur.name === "AbortError")) return "timeout";
    cur = (cur as { cause?: unknown }).cause;
  }
  return "network";
}

export function serviceNowAdapter(opts: {
  instanceUrl: string;
  sourceName: string;
  username: string;
  password: string;
  fetch: typeof fetch;
  now: Date;
}): CmdbAdapter {
  const auth = `Basic ${Buffer.from(`${opts.username}:${opts.password}`, "utf8").toString("base64")}`;
  const headers = { authorization: auth, accept: "application/json", "user-agent": "RegulAIt-CMDB/1" };
  const call = async <T>(url: string, init: RequestInit, schema: z.ZodType<T>): Promise<{ ok: true; body: T } | { ok: false; code: CmdbErrorCode }> => {
    let res: Response;
    try {
      res = await opts.fetch(url, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) }, signal: AbortSignal.timeout(CMDB_LIMITS.timeoutMs) });
    } catch (err) {
      return { ok: false, code: transportCode(err) };
    }
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      return { ok: false, code: transportCode(err) };
    }
    if (res.status < 200 || res.status >= 300) return { ok: false, code: statusCode(res.status) };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, code: "bad_response" };
    }
    const parsed = schema.safeParse(json);
    return parsed.success ? { ok: true, body: parsed.data } : { ok: false, code: "bad_response" };
  };

  return {
    async push(items) {
      const body = {
        items: items.map((p, i) => ({
          className: p.ciClass,
          internal_id: `i${i}`,
          values: { name: p.item.name, short_description: `RegulAIt ${p.item.kind.replace("_", " ")}` },
          sys_object_source_info: {
            source_name: opts.sourceName,
            source_native_key: p.item.sourceKey,
            source_recency_timestamp: ireTimestamp(opts.now),
          },
        })),
      };
      const url = `${opts.instanceUrl}/api/now/identifyreconcile?sysparm_data_source=${encodeURIComponent(opts.sourceName)}`;
      const r = await call(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, ireResponse);
      if (!r.ok) return r;
      const sysIds: Array<string | null> = items.map(() => null);
      r.body.result.items.forEach((it, pos) => {
        const first = it.inputIndices?.[0];
        const idx = typeof first === "number" ? first : pos;
        if (idx < 0 || idx >= items.length) return;
        if ((it.errorCount ?? 0) === 0 && typeof it.sysId === "string" && SYS_ID.test(it.sysId)) sysIds[idx] = it.sysId;
      });
      return { ok: true, sysIds };
    },

    async readOwnership(refs) {
      const owners = new Map<string, string | null>();
      const byClass = new Map<string, string[]>();
      for (const r of refs) byClass.set(r.ciClass, [...(byClass.get(r.ciClass) ?? []), r.sysId]);
      for (const [ciClass, ids] of byClass) {
        for (let i = 0; i < ids.length; i += CMDB_LIMITS.readBatchSize) {
          const chunk = ids.slice(i, i + CMDB_LIMITS.readBatchSize).filter((s) => SYS_ID.test(s));
          if (chunk.length === 0) continue;
          const qs = new URLSearchParams({
            sysparm_query: `sys_idIN${chunk.join(",")}`,
            sysparm_fields: "sys_id,owned_by.email",
            sysparm_limit: String(CMDB_LIMITS.readBatchSize),
            sysparm_exclude_reference_link: "true",
          });
          const r = await call(`${opts.instanceUrl}/api/now/table/${ciClass}?${qs.toString()}`, { method: "GET" }, tableResponse);
          if (!r.ok) return r;
          for (const row of r.body.result) {
            const email = row["owned_by.email"];
            owners.set(row.sys_id, typeof email === "string" && email.length <= 320 && email.includes("@") ? email.trim() : null);
          }
        }
      }
      return { ok: true, owners };
    },
  };
}

// ---------------------------------------------------------------------------
// the inventory to export
// ---------------------------------------------------------------------------

export async function cmdbExportItems(db: Db): Promise<{ items: CmdbExportItem[]; truncated: boolean }> {
  const cap = CMDB_LIMITS.maxItemsPerPass;
  const out: CmdbExportItem[] = [];
  const add = (kind: CmdbAssetKind, id: string, name: string) => out.push({ kind, sourceKey: cmdbSourceKey(kind, id), name: name.slice(0, 255) });
  const left = () => cap + 1 - out.length;
  for (const a of await db.select({ id: agents.id, name: agents.name }).from(agents).orderBy(asc(agents.name)).limit(left())) add("agent", a.id, a.name);
  if (left() > 0) {
    for (const m of await db.select({ id: mcpServers.id, name: mcpServers.name }).from(mcpServers).orderBy(asc(mcpServers.name)).limit(left())) add("mcp_server", m.id, m.name);
  }
  if (left() > 0) {
    const models = await db
      .selectDistinct({ provider: agents.provider, model: agents.model })
      .from(agents)
      .where(isNotNull(agents.model))
      .orderBy(asc(agents.provider), asc(agents.model))
      .limit(left());
    for (const m of models) add("model", `${m.provider}/${m.model}`, `${m.provider}/${m.model}`);
  }
  if (left() > 0) {
    const devices = await db
      .select({ id: endpointDevices.id, pseudonym: endpointDevices.devicePseudonym })
      .from(endpointDevices)
      .where(isNull(endpointDevices.revokedAt))
      .orderBy(asc(endpointDevices.devicePseudonym))
      .limit(left());
    for (const d of devices) add("endpoint", d.id, d.pseudonym);
  }
  return { items: out.slice(0, cap), truncated: out.length > cap };
}

/** the hash of what identifies the CI and what it says, without the per-push recency timestamp */
export function cmdbPayloadSha256(item: CmdbExportItem, ciClass: string, sourceName: string): string {
  return createHash("sha256").update(JSON.stringify([ciClass, sourceName, item.kind, item.sourceKey, item.name])).digest("hex");
}

// ---------------------------------------------------------------------------
// one sync pass
// ---------------------------------------------------------------------------

export interface CmdbSyncOutcome {
  run: CmdbSyncRunRow;
}

async function liveCredential(db: Db, connectorId: string) {
  const [c] = await db
    .select()
    .from(cmdbCredentials)
    .where(and(eq(cmdbCredentials.connectorId, connectorId), isNull(cmdbCredentials.revokedAt)));
  return c ?? null;
}

async function openRun(db: Db, c: CmdbConnectorRow, trigger: "manual" | "schedule", actor: string | null, refusedWith: CmdbErrorCode | null) {
  // a pass that died mid-run must not block every later one
  await db
    .update(cmdbSyncRuns)
    .set({ status: "failed", errorCode: "stale", finishedAt: sql`now()` })
    .where(
      and(
        eq(cmdbSyncRuns.connectorId, c.id),
        eq(cmdbSyncRuns.status, "running"),
        sql`${cmdbSyncRuns.startedAt} < now() - make_interval(mins => ${CMDB_LIMITS.staleRunMinutes})`,
      ),
    );
  const base = { connectorId: c.id, trigger, initiatedBy: actor };
  if (refusedWith) {
    const [r] = await db.insert(cmdbSyncRuns).values({ ...base, status: "refused", errorCode: refusedWith, finishedAt: sql`now()` }).returning();
    return { run: r!, opened: false };
  }
  const [r] = await db.insert(cmdbSyncRuns).values({ ...base, status: "running" }).onConflictDoNothing().returning();
  if (r) return { run: r, opened: true };
  const [refused] = await db.insert(cmdbSyncRuns).values({ ...base, status: "refused", errorCode: "in_progress", finishedAt: sql`now()` }).returning();
  return { run: refused!, opened: false };
}

async function auditRun(db: Db, c: CmdbConnectorRow, run: CmdbSyncRunRow, actor: string | null, extra: Record<string, unknown> = {}) {
  await db.insert(auditLog).values({
    userId: actor ?? NIL_UUID,
    objectType: "cmdb_connector",
    objectId: c.id,
    detail: {
      subsystem: "cmdb-sync",
      adr: "0358",
      runId: run.id,
      trigger: run.trigger,
      status: run.status,
      errorCode: run.errorCode,
      itemsExamined: run.itemsExamined,
      itemsPushed: run.itemsPushed,
      itemsUnchanged: run.itemsUnchanged,
      itemsFailed: run.itemsFailed,
      ownershipRead: run.ownershipRead,
      ...extra,
    },
    effect: run.status === "succeeded" ? "allow" : "deny",
    ruleId: CMDB_RULE_IDS.sync,
    ruleChain: [],
    reason: `CMDB sync to '${c.name}' ${run.status}${run.errorCode ? ` (${run.errorCode})` : ""}: ${run.itemsPushed} pushed, ${run.itemsUnchanged} unchanged, ${run.itemsFailed} not confirmed`,
  });
}

/** the one state change out of `running`, a compare-and-set on the states the declared table allows */
async function finishRun(db: Db, runId: string, event: "succeed" | "fail", counts: Partial<CmdbSyncRunRow>, code: CmdbErrorCode | null) {
  const [r] = await db
    .update(cmdbSyncRuns)
    .set({ ...counts, status: CMDB_SYNC_RUN_MACHINE.def.transitions[event].to, errorCode: code, finishedAt: sql`now()` })
    .where(and(eq(cmdbSyncRuns.id, runId), inArray(cmdbSyncRuns.status, [...CMDB_SYNC_RUN_MACHINE.sourcesOf(event)])))
    .returning();
  return r ?? null;
}

export async function syncCmdbConnector(
  db: Db,
  connectorId: string,
  opts: { dataKey: string | undefined; trigger: "manual" | "schedule"; actorUserId: string | null; deps?: CmdbSyncDeps },
): Promise<CmdbSyncOutcome | null> {
  const [c] = await db.select().from(cmdbConnectors).where(eq(cmdbConnectors.id, connectorId));
  if (!c) return null;
  const cred = await liveCredential(db, c.id);
  const preRefusal: CmdbErrorCode | null =
    resolveDeployMode() === "air_gapped" ? "air_gapped" : !c.enabled ? "disabled" : !cred ? "no_credential" : !opts.dataKey ? "no_data_key" : null;
  const opened = await openRun(db, c, opts.trigger, opts.actorUserId, preRefusal);
  if (!opened.opened) {
    await auditRun(db, c, opened.run, opts.actorUserId);
    return { run: opened.run };
  }
  const runId = opened.run.id;
  const counts = { itemsExamined: 0, itemsPushed: 0, itemsUnchanged: 0, itemsFailed: 0, ownershipRead: 0 };
  const fail = async (code: CmdbErrorCode) => {
    const run = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const r = await finishRun(t, runId, "fail", counts, code);
      if (r) await auditRun(t, c, r, opts.actorUserId);
      return r;
    });
    return { run: run ?? opened.run };
  };
  try {
    let password: string;
    try {
      password = decryptSecret(opts.dataKey!, cred!.secretCiphertext!);
    } catch {
      return await fail("secret_unreadable");
    }
    const guarded = createGuardedFetch({
      allowList: await loadEgressAllowList(db),
      maxResponseBytes: CMDB_LIMITS.maxResponseBytes,
      ...(opts.deps?.resolve ? { resolve: opts.deps.resolve } : {}),
      ...(opts.deps?.fetchImpl ? { fetchImpl: opts.deps.fetchImpl } : {}),
    });
    const [{ now }] = (await db.execute<{ now: string }>(sql`select now()::text as now`)).rows as [{ now: string }];
    const adapter = serviceNowAdapter({ instanceUrl: c.instanceUrl, sourceName: c.sourceName, username: cred!.username, password, fetch: guarded, now: new Date(now) });
    const classes = cmdbCiClassesSchema.parse({ ...CMDB_DEFAULT_CI_CLASSES, ...c.ciClasses });

    const { items, truncated } = await cmdbExportItems(db);
    counts.itemsExamined = items.length;
    const links = new Map(
      (await db.select({ sourceKey: cmdbCiLinks.sourceKey, sha: cmdbCiLinks.payloadSha256 }).from(cmdbCiLinks).where(eq(cmdbCiLinks.connectorId, c.id))).map(
        (l) => [l.sourceKey, l.sha],
      ),
    );
    const changed = items
      .map((item) => ({ item, ciClass: classes[item.kind], sha: cmdbPayloadSha256(item, classes[item.kind], c.sourceName) }))
      .filter((p) => links.get(p.item.sourceKey) !== p.sha);
    counts.itemsUnchanged = items.length - changed.length;

    for (let i = 0; i < changed.length; i += CMDB_LIMITS.pushBatchSize) {
      const batch = changed.slice(i, i + CMDB_LIMITS.pushBatchSize);
      const r = await adapter.push(batch);
      if (!r.ok) {
        counts.itemsFailed += changed.length - i;
        return await fail(r.code);
      }
      const confirmed = batch.flatMap((p, k) => (r.sysIds[k] ? [{ ...p, sysId: r.sysIds[k]! }] : []));
      counts.itemsPushed += confirmed.length;
      counts.itemsFailed += batch.length - confirmed.length;
      if (confirmed.length > 0) {
        await db
          .insert(cmdbCiLinks)
          .values(confirmed.map((p) => ({ connectorId: c.id, assetKind: p.item.kind, sourceKey: p.item.sourceKey, ciClass: p.ciClass, ciSysId: p.sysId, payloadSha256: p.sha, lastRunId: runId })))
          .onConflictDoUpdate({
            target: [cmdbCiLinks.connectorId, cmdbCiLinks.sourceKey],
            set: {
              assetKind: sql`excluded.asset_kind`,
              ciClass: sql`excluded.ci_class`,
              ciSysId: sql`excluded.ci_sys_id`,
              payloadSha256: sql`excluded.payload_sha256`,
              lastPushedAt: sql`now()`,
              lastRunId: runId,
            },
          });
      }
    }

    if (c.readBackOwnership) {
      const refs = await db
        .select({ ciClass: cmdbCiLinks.ciClass, sysId: cmdbCiLinks.ciSysId })
        .from(cmdbCiLinks)
        .where(eq(cmdbCiLinks.connectorId, c.id))
        .limit(CMDB_LIMITS.maxItemsPerPass);
      const r = await adapter.readOwnership(refs);
      if (!r.ok) return await fail(r.code);
      for (const [sysId, email] of r.owners) {
        await db
          .update(cmdbCiLinks)
          .set({
            cmdbOwnerEmail: email,
            cmdbOwnerUserId: email ? sql`(SELECT ${users.id} FROM ${users} WHERE lower(${users.email}) = lower(${email}) LIMIT 1)` : null,
            ownershipReadAt: sql`now()`,
          })
          .where(and(eq(cmdbCiLinks.connectorId, c.id), eq(cmdbCiLinks.ciSysId, sysId)));
        counts.ownershipRead += 1;
      }
    }

    const run = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const r = await finishRun(t, runId, "succeed", counts, null);
      if (r) await auditRun(t, c, r, opts.actorUserId, { truncated });
      return r;
    });
    return { run: run ?? opened.run };
  } catch {
    // never vendor text: the fixed code only
    return await fail("internal");
  }
}

export async function runCmdbSyncSweep(db: Db, dataKey: string | undefined, deps: CmdbSyncDeps = {}) {
  if (resolveDeployMode() === "air_gapped") return { connectors: 0, succeeded: 0 };
  const enabled = await db.select({ id: cmdbConnectors.id }).from(cmdbConnectors).where(eq(cmdbConnectors.enabled, true)).orderBy(asc(cmdbConnectors.createdAt));
  let succeeded = 0;
  for (const c of enabled) {
    const out = await syncCmdbConnector(db, c.id, { dataKey, trigger: "schedule", actorUserId: null, deps });
    if (out?.run.status === "succeeded") succeeded += 1;
  }
  return { connectors: enabled.length, succeeded };
}

export function cmdbSyncJobDefinitions(opts: { dataKey?: string | undefined } = {}): SchedulerJobDefinition[] {
  return [
    {
      name: CMDB_SYNC_JOB_NAME,
      description:
        "Push the AI asset inventory (agents, MCP servers, models, endpoints) to each enabled CMDB connector as " +
        "configuration items through the CMDB's identification API; unchanged assets are not re-sent; the ownership " +
        "read-back runs only where an admin turned it on. With no connector enabled it sends nothing; refused when air-gapped.",
      adr: "ADR-0358",
      defaultIntervalSeconds: 6 * 3600,
      run: async (ctx) => {
        const out = await runCmdbSyncSweep(ctx.db, opts.dataKey);
        return { itemsProcessed: out.connectors, detail: { ...out } };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

const connectorParam = z.object({ connectorId: z.string().uuid() });
const pageQuery = z
  .object({
    limit: z.coerce.number().int().refine((n) => [10, 50, 100, 500].includes(n), { message: "limit must be 10, 50, 100 or 500" }).default(50),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .strict();

function hostOf(instanceUrl: string): string {
  return normalizeHost(new URL(instanceUrl).hostname);
}

async function connectorView(db: Db, c: CmdbConnectorRow) {
  const [cred, allow, [last]] = await Promise.all([
    liveCredential(db, c.id),
    loadEgressAllowList(db),
    db.select().from(cmdbSyncRuns).where(eq(cmdbSyncRuns.connectorId, c.id)).orderBy(desc(cmdbSyncRuns.startedAt)).limit(1),
  ]);
  const host = hostOf(c.instanceUrl);
  return {
    id: c.id,
    name: c.name,
    kind: c.kind,
    instanceUrl: c.instanceUrl,
    sourceName: c.sourceName,
    ciClasses: { ...CMDB_DEFAULT_CI_CLASSES, ...c.ciClasses },
    enabled: c.enabled,
    readBackOwnership: c.readBackOwnership,
    credential: cred ? { id: cred.id, username: cred.username, createdAt: cred.createdAt } : null,
    posture: {
      exportOnly: !c.readBackOwnership,
      airGapped: resolveDeployMode() === "air_gapped",
      egressAllowed: allow.some((e) => e.host === host),
      canRun: c.enabled && !!cred && resolveDeployMode() !== "air_gapped",
      setup: [
        `register '${c.sourceName}' as a discovery_source choice on cmdb_ci (the IRE requires a registered source)`,
        "use an integration user that can call the identification API on the chosen classes and read owned_by",
        `add ${host} to the egress allow-list`,
      ],
    },
    lastRun: last ? runView(last) : null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

function runView(r: CmdbSyncRunRow) {
  return {
    id: r.id,
    trigger: r.trigger,
    status: r.status,
    errorCode: r.errorCode,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    itemsExamined: r.itemsExamined,
    itemsPushed: r.itemsPushed,
    itemsUnchanged: r.itemsUnchanged,
    itemsFailed: r.itemsFailed,
    ownershipRead: r.ownershipRead,
  };
}

export function registerCmdbSyncRoutes(app: FastifyInstance, db: Db, opts: { dataKey?: string | undefined; deps?: CmdbSyncDeps } = {}): void {
  const actor = (req: FastifyRequest) => req.authCtx.userId ?? null;
  const refuse = (reply: FastifyReply, status: number, error: string, detail?: string) => reply.status(status).send({ error, ...(detail ? { detail } : {}) });
  const bad = (reply: FastifyReply, e: z.ZodError) => refuse(reply, 400, "invalid_request", e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const audit = (t: Db, req: FastifyRequest, c: Pick<CmdbConnectorRow, "id">, ruleId: string, effect: "allow" | "deny", reason: string, detail: Record<string, unknown>) =>
    t.insert(auditLog).values({
      userId: actor(req) ?? NIL_UUID,
      objectType: "cmdb_connector",
      objectId: c.id,
      detail: { subsystem: "cmdb-sync", adr: "0358", via: req.authCtx.via, ...detail },
      effect,
      ruleId,
      ruleChain: [],
      reason,
    });
  const load = async (reply: FastifyReply, params: unknown): Promise<CmdbConnectorRow | null> => {
    const p = connectorParam.safeParse(params);
    if (!p.success) {
      await refuse(reply, 400, "invalid_request", "connectorId must be a uuid");
      return null;
    }
    const [row] = await db.select().from(cmdbConnectors).where(eq(cmdbConnectors.id, p.data.connectorId));
    if (!row) {
      await refuse(reply, 404, "not_found");
      return null;
    }
    return row;
  };

  app.get("/v1/cmdb/connectors", async () => {
    const rows = await db.select().from(cmdbConnectors).orderBy(asc(cmdbConnectors.createdAt)).limit(100);
    return { connectors: await Promise.all(rows.map((r) => connectorView(db, r))) };
  });

  app.post("/v1/cmdb/connectors", async (req, reply) => {
    const b = createCmdbConnectorSchema.safeParse(req.body ?? {});
    if (!b.success) return bad(reply, b.error);
    const problem = cmdbInstanceUrlProblem(b.data.instanceUrl);
    if (problem) return refuse(reply, 400, "invalid_instance_url", problem);
    const instanceUrl = new URL(b.data.instanceUrl).origin;
    const created = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const [row] = await t
        .insert(cmdbConnectors)
        .values({
          name: b.data.name,
          kind: b.data.kind,
          instanceUrl,
          sourceName: b.data.sourceName ?? CMDB_DEFAULT_SOURCE_NAME,
          ciClasses: { ...CMDB_DEFAULT_CI_CLASSES, ...b.data.ciClasses },
          createdBy: actor(req),
        })
        .onConflictDoNothing()
        .returning();
      if (!row) return null;
      await audit(t, req, row, CMDB_RULE_IDS.created, "allow", `CMDB connector '${row.name}' created for ${instanceUrl}, disabled and export only until an admin enables it (ADR-0358)`, {
        kind: row.kind,
        instanceUrl,
        enabled: false,
        readBackOwnership: false,
      });
      return row;
    });
    if (!created) return refuse(reply, 409, "connector_name_taken");
    return reply.status(201).send({ connector: await connectorView(db, created) });
  });

  app.put("/v1/cmdb/connectors/:connectorId/config", async (req, reply) => {
    const c = await load(reply, req.params);
    if (!c) return reply;
    const b = updateCmdbConfigSchema.safeParse(req.body ?? {});
    if (!b.success) return bad(reply, b.error);
    let instanceUrl = c.instanceUrl;
    if (b.data.instanceUrl !== undefined) {
      const problem = cmdbInstanceUrlProblem(b.data.instanceUrl);
      if (problem) return refuse(reply, 400, "invalid_instance_url", problem);
      instanceUrl = new URL(b.data.instanceUrl).origin;
    }
    const moved = instanceUrl !== c.instanceUrl;
    const turningOnReadBack = b.data.readBackOwnership === true && !c.readBackOwnership;
    // reading CMDB data back into RegulAIt is a relaxation of the export-only default
    if (turningOnReadBack) {
      const su = await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { cmdb: "read_back_ownership", connectorId: c.id } });
      if (!su.ok) return reply;
    }
    const ciClasses: CmdbCiClasses = { ...CMDB_DEFAULT_CI_CLASSES, ...c.ciClasses, ...b.data.ciClasses };
    const saved = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      // the step-up and the move were decided on `c`: a connector that changed since is refused, never overwritten
      const [locked] = await t.select().from(cmdbConnectors).where(eq(cmdbConnectors.id, c.id)).for("update");
      if (
        !locked ||
        locked.instanceUrl !== c.instanceUrl ||
        locked.readBackOwnership !== c.readBackOwnership ||
        locked.enabled !== c.enabled
      ) {
        return null;
      }
      const [row] = await t
        .update(cmdbConnectors)
        .set({
          instanceUrl,
          sourceName: b.data.sourceName ?? c.sourceName,
          ciClasses,
          readBackOwnership: b.data.readBackOwnership ?? c.readBackOwnership,
          // a new host never receives a password stored for the old one: revoke and disable
          ...(moved ? { enabled: false } : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(cmdbConnectors.id, c.id))
        .returning();
      if (!row) return null;
      let revoked: string | null = null;
      if (moved) {
        const [r] = await t
          .update(cmdbCredentials)
          .set({ revokedAt: sql`now()`, revokedBy: actor(req), secretCiphertext: null })
          .where(and(eq(cmdbCredentials.connectorId, c.id), isNull(cmdbCredentials.revokedAt)))
          .returning({ id: cmdbCredentials.id });
        revoked = r?.id ?? null;
      }
      await audit(
        t,
        req,
        c,
        CMDB_RULE_IDS.configured,
        turningOnReadBack ? "deny" : "allow",
        `CMDB connector '${c.name}' configured${moved ? `: moved to ${instanceUrl}, so it was disabled and its credential revoked` : ""}${turningOnReadBack ? "; ownership read-back turned ON — RELAXED from export only (step-up)" : ""}: ${b.data.reason}`,
        {
          from: { instanceUrl: c.instanceUrl, sourceName: c.sourceName, ciClasses: c.ciClasses, readBackOwnership: c.readBackOwnership },
          to: { instanceUrl, sourceName: row.sourceName, ciClasses, readBackOwnership: row.readBackOwnership },
          relaxation: turningOnReadBack,
          revokedCredentialId: revoked,
        },
      );
      return row;
    });
    if (!saved) return refuse(reply, 409, "changed_concurrently", "the connector changed since it was read; read it again");
    return { connector: await connectorView(db, saved) };
  });

  app.put("/v1/cmdb/connectors/:connectorId/credential", async (req, reply) => {
    const c = await load(reply, req.params);
    if (!c) return reply;
    const b = storeCmdbCredentialSchema.safeParse(req.body ?? {});
    if (!b.success) return refuse(reply, 400, "invalid_request", "send {username, password, replacesCredentialId: uuid | null, reason}");
    if (!opts.dataKey) return refuse(reply, 503, "no_data_key", "REGULAIT_DATA_KEY is not set, so the credential cannot be stored encrypted");
    const su = await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { cmdb: "credential", connectorId: c.id, replaces: b.data.replacesCredentialId } });
    if (!su.ok) return reply;
    const out = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      await t.execute(sql`SELECT 1 FROM ${cmdbConnectors} WHERE ${cmdbConnectors.id} = ${c.id} FOR UPDATE`);
      const live = await liveCredential(t, c.id);
      if ((live?.id ?? null) !== b.data.replacesCredentialId) return { conflict: live?.id ?? null } as const;
      if (live) {
        await t.update(cmdbCredentials).set({ revokedAt: sql`now()`, revokedBy: actor(req), secretCiphertext: null }).where(eq(cmdbCredentials.id, live.id));
      }
      const [row] = await t
        .insert(cmdbCredentials)
        .values({ connectorId: c.id, username: b.data.username, secretCiphertext: encryptSecret(opts.dataKey!, b.data.password), createdBy: actor(req) })
        .returning({ id: cmdbCredentials.id });
      await audit(t, req, c, CMDB_RULE_IDS.credentialStored, "allow", `CMDB credential ${live ? "rotated" : "stored"} for connector '${c.name}' (step-up ${su.method}): ${b.data.reason}`, {
        credentialId: row!.id,
        replacedCredentialId: live?.id ?? null,
        username: b.data.username,
        stepUp: su.method,
      });
      return { id: row!.id } as const;
    });
    if ("conflict" in out) {
      return refuse(reply, 409, "credential_conflict", out.conflict ? `this connector has a credential (${out.conflict}); name it in replacesCredentialId` : "this connector has no credential; replacesCredentialId must be null");
    }
    return { connector: await connectorView(db, (await db.select().from(cmdbConnectors).where(eq(cmdbConnectors.id, c.id)))[0]!) };
  });

  // revoking is never harder than granting: no step-up
  app.delete("/v1/cmdb/connectors/:connectorId/credential", async (req, reply) => {
    const c = await load(reply, req.params);
    if (!c) return reply;
    const out = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const [r] = await t
        .update(cmdbCredentials)
        .set({ revokedAt: sql`now()`, revokedBy: actor(req), secretCiphertext: null })
        .where(and(eq(cmdbCredentials.connectorId, c.id), isNull(cmdbCredentials.revokedAt)))
        .returning({ id: cmdbCredentials.id });
      if (!r) return null;
      await t.update(cmdbConnectors).set({ enabled: false, updatedAt: sql`now()` }).where(eq(cmdbConnectors.id, c.id));
      await audit(t, req, c, CMDB_RULE_IDS.credentialRevoked, "allow", `CMDB credential of connector '${c.name}' revoked; the secret was destroyed and the connector disabled`, { credentialId: r.id });
      return r;
    });
    if (!out) return refuse(reply, 404, "no_credential", "this connector has no live credential");
    return { revoked: out.id };
  });

  app.put("/v1/cmdb/connectors/:connectorId/enabled", async (req, reply) => {
    const c = await load(reply, req.params);
    if (!c) return reply;
    const b = setCmdbEnabledSchema.safeParse(req.body ?? {});
    if (!b.success) return refuse(reply, 400, "invalid_request", "send {enabled: true | false, reason}");
    if (b.data.enabled === c.enabled) return { connector: await connectorView(db, c) };
    let method: string | null = null;
    if (b.data.enabled) {
      if (resolveDeployMode() === "air_gapped") return refuse(reply, 409, "air_gapped", "an air-gapped deployment (REGULAIT_DEPLOY_MODE=air_gapped) cannot send the inventory to a CMDB");
      if (!(await liveCredential(db, c.id))) return refuse(reply, 409, "no_credential", "store a credential before enabling the connector");
      const su = await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { cmdb: "enable", connectorId: c.id, instanceUrl: c.instanceUrl } });
      if (!su.ok) return reply;
      method = su.method;
    }
    const saved = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const [row] = await t
        .update(cmdbConnectors)
        .set({ enabled: b.data.enabled, updatedAt: sql`now()` })
        .where(and(eq(cmdbConnectors.id, c.id), eq(cmdbConnectors.enabled, c.enabled)))
        .returning();
      if (!row) return null;
      await audit(
        t,
        req,
        c,
        b.data.enabled ? CMDB_RULE_IDS.enabled : CMDB_RULE_IDS.disabled,
        b.data.enabled ? "deny" : "allow",
        b.data.enabled
          ? `CMDB connector '${c.name}' enabled: the AI asset inventory is sent to ${c.instanceUrl} (step-up ${method}): ${b.data.reason}`
          : `CMDB connector '${c.name}' disabled: nothing more is sent: ${b.data.reason}`,
        { from: { enabled: c.enabled }, to: { enabled: b.data.enabled }, relaxation: b.data.enabled, ...(method ? { stepUp: method } : {}) },
      );
      return row;
    });
    if (!saved) return refuse(reply, 409, "changed_concurrently", "the connector changed since it was read; read it again");
    return { connector: await connectorView(db, saved) };
  });

  app.post("/v1/cmdb/connectors/:connectorId/sync", async (req, reply) => {
    const c = await load(reply, req.params);
    if (!c) return reply;
    const out = await syncCmdbConnector(db, c.id, { dataKey: opts.dataKey, trigger: "manual", actorUserId: actor(req), deps: opts.deps });
    return { run: runView(out!.run) };
  });

  app.get("/v1/cmdb/connectors/:connectorId/runs", async (req, reply) => {
    const c = await load(reply, req.params);
    if (!c) return reply;
    const q = pageQuery.safeParse(req.query ?? {});
    if (!q.success) return bad(reply, q.error);
    const rows = await db
      .select()
      .from(cmdbSyncRuns)
      .where(eq(cmdbSyncRuns.connectorId, c.id))
      .orderBy(desc(cmdbSyncRuns.startedAt), desc(cmdbSyncRuns.id))
      .limit(q.data.limit + 1)
      .offset(q.data.offset);
    return { items: rows.slice(0, q.data.limit).map(runView), nextOffset: rows.length > q.data.limit ? q.data.offset + q.data.limit : null };
  });

  app.get("/v1/cmdb/connectors/:connectorId/links", async (req, reply) => {
    const c = await load(reply, req.params);
    if (!c) return reply;
    const q = pageQuery.safeParse(req.query ?? {});
    if (!q.success) return bad(reply, q.error);
    const rows = await db
      .select()
      .from(cmdbCiLinks)
      .where(eq(cmdbCiLinks.connectorId, c.id))
      .orderBy(asc(cmdbCiLinks.assetKind), asc(cmdbCiLinks.sourceKey))
      .limit(q.data.limit + 1)
      .offset(q.data.offset);
    return {
      items: rows.slice(0, q.data.limit).map((l) => ({
        assetKind: l.assetKind,
        sourceKey: l.sourceKey,
        ci: { class: l.ciClass, sysId: l.ciSysId },
        lastPushedAt: l.lastPushedAt,
        // what the CMDB reported: recorded, never applied to RegulAIt's owner fields
        cmdbOwnership: l.ownershipReadAt ? { email: l.cmdbOwnerEmail, matchedUserId: l.cmdbOwnerUserId, readAt: l.ownershipReadAt } : null,
      })),
      nextOffset: rows.length > q.data.limit ? q.data.offset + q.data.limit : null,
    };
  });
}
