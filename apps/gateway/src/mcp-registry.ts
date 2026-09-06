/**
 * ADR-0101 — FEDERATED MCP REGISTRY: the impure half.
 *
 * `packages/shared/src/mcp-registry.ts` owns the wire schema and the
 * remote-vs-package classification (pure, local, no network). This module owns
 * the four things that touch the world:
 *
 *   1. THE PULL — one guarded, bounded, paginated read of an upstream
 *      `GET /v0.1/servers`, through ADR-0043's egress guard, refused outright
 *      on an air-gapped deployment.
 *   2. THE CATALOGUE WRITE — upsert on `(registry_id, upstream_name)`. A sync
 *      writes `mcp_registry_entries` AND NOTHING ELSE. It never creates an
 *      `mcp_servers` row, never grants anything, never rewrites a server's url.
 *   3. THE IMPORT — an explicit, audited operator act that turns ONE catalogue
 *      entry carrying a real remote endpoint into an `mcp_servers` row which is
 *      `unscanned`, `federated`, and usable by nobody.
 *   4. THE SWEEP + its manual door (ADR-0064).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY SYNC AND IMPORT ARE TWO ACTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The reference implementation we reviewed (agentic-community/mcp-gateway-
 * registry) federates by making a remote entry immediately usable — same access
 * as a locally-registered server, no approval step. In a default-deny product
 * that is not a shortcut, it is the opposite policy: it lets a third party
 * decide what exists inside the estate.
 *
 * So the pull is deliberately inert. A sync tells an operator what a directory
 * SAYS. Creating a governed object out of one of those rows is a decision a
 * human makes and the audit log records, and even that decision confers no
 * entitlement on anybody: the imported row has no `tool_grants` and no
 * `server_grants`, so the very next call by an ordinary user is refused by the
 * same policy path that refuses any ungranted server. Nothing about "it came
 * from a registry" shortens that path — there is no federation branch in the
 * gate, because there is no federation branch anywhere in the call path at all.
 *
 * And it is `unscanned`, never `grandfathered`. Migration 0103's grandfather
 * default exists for rows that predate the ADR-0097 scanner and are trusted
 * because they already were. A server that arrived from the public internet
 * five seconds ago has no such history. Federation is precisely the population
 * ADR-0097's gate was built for — an upstream nobody in this organisation has
 * ever met, whose tool descriptions become a model's instructions — so an
 * imported server takes the same scan and the same hold as any other, with no
 * bypass, and this module adds none.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NEVER CLOBBER A LOCAL ROW
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `mcp_servers.name` is globally unique and registry names are reverse-DNS, so
 * the local name is the upstream name VERBATIM (see `localServerNameFor` for
 * why mangling is worse). Every collision — with a hand-registered server, or
 * with a server imported from a DIFFERENT registry that mirrors this one — is
 * recorded as a conflict on the catalogue row and refused with a 409. Same for
 * a remote url that some existing row already points at. An operator resolves
 * it; this code never does, because "the registry won" is not a resolution
 * anybody signed for.
 *
 * The same rule applies AFTER an import. If the upstream endpoint moves, the
 * new url is recorded as `remote_url_drift` on the catalogue row and
 * `mcp_servers.url` is LEFT ALONE. A registry that can silently repoint a
 * server an operator already trusts and already granted people access to is the
 * whole federation attack in one field.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EGRESS, AND AIR-GAPPED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Pulling a registry is an outbound call to an admin-typed URL, so it is
 * ADR-0043's surface exactly: `checkEgress` at write time (an honest 400 when
 * somebody configures an unreachable destination) and `createGuardedFetch` on
 * every pull (re-validated per request, DNS-pinned, redirects refused). A
 * public registry host therefore needs an `egress_allow_hosts` entry like every
 * other public destination — default-deny is not relaxed for this feature.
 *
 * ON AN AIR-GAPPED DEPLOYMENT FEDERATION REFUSES OUTRIGHT, before DNS, before
 * any socket, and REGARDLESS of the allow-list. This is a stronger rule than
 * the ordinary posture and it is chosen, not inherited: ADR-0062's mode-scoped
 * egress adjudicates a COMPILED vendor default and leaves admin-typed URLs to
 * the allow-list, which means an air-gapped operator who allow-listed a host
 * for some other reason would otherwise be pulling a public directory into a
 * disconnected enclave. The promise air-gapped mode makes is that nothing
 * leaves; "except the thing that goes and asks the internet what servers
 * exist" is not a footnote that promise survives.
 *
 * The honest cost, stated here and in the ADR: an air-gapped install running
 * its OWN registry mirror on the LAN cannot use federation either. That
 * operator registers servers by hand, which is what they do today. A carve-out
 * for "private-looking" registry URLs would be a per-request DNS decision
 * deciding whether a governance promise applies, and the promise is worth more
 * than the convenience.
 */
import {
  and,
  asc,
  auditLog,
  eq,
  isNull,
  mcpRegistries,
  mcpRegistryEntries,
  mcpServers,
  ne,
  sql,
  type Db,
} from "@regulait/db";
import {
  localServerNameFor,
  MCP_REGISTRY_LIST_PATH,
  MCP_REGISTRY_MAX_PAGE_SIZE,
  normalizeRegistryPage,
  type McpImportConflictReason,
  type NormalizedRegistryEntry,
} from "@regulait/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadEgressAllowList } from "./custom-providers.js";
import { resolveDeployMode, type DeployMode } from "./deploy-posture.js";
import {
  checkEgress,
  createGuardedFetch,
  type EgressAllowEntry,
  type EgressDenied,
  type EgressResolver,
} from "./egress-guard.js";
import { loadOrgSettings } from "./org-settings.js";
import { REGISTRATION_ADMISSION_STATE } from "./mcp-admission.js";

/** the deployment's own null actor, for a pass no human initiated */
const NIL_USER = "00000000-0000-0000-0000-000000000000";

/** ADR-0053: audit ruleIds are a published vocabulary; one per fact. */
export const mcpRegistryRuleIds = {
  configured: "mcp-registry-configured",
  synced: "mcp-registry-synced",
  syncRefused: "mcp-registry-sync-refused",
  imported: "mcp-registry-entry-imported",
  importConflict: "mcp-registry-import-conflict",
  swept: "mcp-registry-swept",
} as const;

// ---------------------------------------------------------------------------
// bounds — every one of them small, and every one of them stated
// ---------------------------------------------------------------------------

/** pages per registry per pass. With the upstream page cap of 100 this is a
 * hard ceiling of 500 entries examined per registry per pass; the rest is not
 * lost, it is reported as `truncated` and picked up next pass. A directory
 * with tens of thousands of entries must not turn one tick into a full crawl. */
export const MCP_REGISTRY_SYNC_MAX_PAGES = 5;

/** registries per SWEEP pass. A manual sync is one registry by definition. */
export const MCP_REGISTRY_SWEEP_MAX_REGISTRIES = 5;

/** per-request timeout on the pull. A registry that hangs must not hold the
 * scheduler's lease open until it expires. */
export const MCP_REGISTRY_FETCH_TIMEOUT_MS = 10_000;

/** response body cap. The parse is bounded by what we are willing to read, not
 * by what an upstream is willing to send. */
export const MCP_REGISTRY_MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface McpRegistryDeps {
  resolve?: EgressResolver;
  fetchImpl?: typeof fetch;
  /** test seam for the deployment mode; production reads process.env */
  deployMode?: DeployMode;
}

// ---------------------------------------------------------------------------
// egress posture
// ---------------------------------------------------------------------------

export interface RegistryEgressPosture {
  allowList: EgressAllowEntry[];
  /** registry.allowPrivateRanges ?? org.mcpPrivateRangesDefault — the SAME
   * tri-state `mcp_servers` uses, deliberately: a registry mirror on the LAN
   * is the same shape of deployment as an MCP server on the LAN. */
  openByDefault: boolean;
}

export async function loadRegistryEgressPosture(
  db: Db,
  allowPrivateRanges: boolean | null | undefined,
): Promise<RegistryEgressPosture> {
  const [allowList, org] = await Promise.all([loadEgressAllowList(db), loadOrgSettings(db)]);
  return { allowList, openByDefault: allowPrivateRanges ?? org.mcpPrivateRangesDefault };
}

/** THE AIR-GAP RULE, in one place so it cannot be applied in one path and
 * forgotten in another. Returns the refusal string, or null. */
export function airGappedFederationRefusal(deployMode: DeployMode): string | null {
  if (deployMode !== "air_gapped") return null;
  return (
    "federation is refused on an air-gapped deployment: pulling a public MCP registry is an " +
    "outbound call to a directory, and REGULAIT_DEPLOY_MODE=air_gapped promises that nothing " +
    "leaves this box. The refusal is unconditional — an egress_allow_hosts entry does not " +
    "lift it — so no DNS lookup and no socket is attempted. Register MCP servers directly " +
    "instead (POST /v1/servers), which is the supported motion in this mode."
  );
}

/** The listing URL for one page. The `/v0.1/servers` path is appended here and
 * never typed by an operator, so a registry row cannot be half-configured into
 * pointing at some other endpoint of the same host. */
export function listingUrl(baseUrl: string, opts: { cursor?: string | null; limit: number }): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const u = new URL(base + MCP_REGISTRY_LIST_PATH);
  u.searchParams.set("limit", String(Math.min(opts.limit, MCP_REGISTRY_MAX_PAGE_SIZE)));
  // `version=latest` collapses a server's version history to the one row we
  // could act on. Without it a registry may return every published version and
  // the catalogue's `(registry, name)` key would thrash between them.
  u.searchParams.set("version", "latest");
  // `include_deleted` is NEVER sent, and `updated_since` is never sent either —
  // the spec says include_deleted is FORCED TRUE whenever updated_since is
  // present, so an "incremental" sync would silently start ingesting tombstones.
  if (opts.cursor) u.searchParams.set("cursor", opts.cursor);
  return u.toString();
}

async function auditRegistryDenied(
  db: Db,
  args: { userId?: string | null; registryId: string | null; reason: string; detail: Record<string, unknown> },
): Promise<void> {
  await db.insert(auditLog).values({
    userId: args.userId ?? NIL_USER,
    objectType: "mcp_server",
    objectId: args.registryId,
    detail: args.detail,
    effect: "deny",
    ruleId: mcpRegistryRuleIds.syncRefused,
    ruleChain: [],
    reason: args.reason,
  });
}

/**
 * WRITE TIME. Returns the 400 body when the configured base url is not a
 * destination this deployment may reach, audited; null when it is.
 */
export async function refuseRegistryWrite(
  db: Db,
  args: {
    url: string;
    allowPrivateRanges: boolean | null | undefined;
    userId?: string | null;
    registryId?: string | null;
    label: string;
    deps?: McpRegistryDeps;
  },
): Promise<{ error: "egress_blocked"; code: string; detail: string } | null> {
  const deps = args.deps ?? {};
  const posture = await loadRegistryEgressPosture(db, args.allowPrivateRanges);
  const decision = await checkEgress(args.url, {
    allowList: posture.allowList,
    privateLan: { openByDefault: posture.openByDefault },
    ...(deps.resolve ? { resolve: deps.resolve } : {}),
  });
  if (decision.ok) return null;
  const denied = decision as EgressDenied;
  const detail = `${args.label} refused: ${denied.reason}`;
  await auditRegistryDenied(db, {
    ...(args.userId !== undefined ? { userId: args.userId } : {}),
    registryId: args.registryId ?? null,
    reason: detail,
    detail: { phase: "configure", url: args.url, code: denied.code, ...(denied.host ? { host: denied.host } : {}) },
  });
  return { error: "egress_blocked", code: denied.code, detail };
}

// ---------------------------------------------------------------------------
// the pull
// ---------------------------------------------------------------------------

export interface RegistryRow {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  allowPrivateRanges: boolean | null;
}

export interface SyncRegistryResult {
  registryId: string;
  registryName: string;
  outcome: "ok" | "failed" | "refused" | "skipped";
  reason: string;
  /** pages actually fetched */
  pages: number;
  /** true when MCP_REGISTRY_SYNC_MAX_PAGES stopped a listing that had more */
  truncated: boolean;
  entriesSeen: number;
  created: number;
  updated: number;
  /** entries carrying a usable remote endpoint (importable) */
  remote: number;
  /** entries with no endpoint this gateway can dial — recorded, never importable */
  catalogueOnly: number;
  /** rows the upstream served that carried no name/version */
  malformed: number;
  /** entries that vanished from a COMPLETE listing */
  markedMissing: number;
  /** already-imported entries whose upstream endpoint moved (url NOT rewritten) */
  driftDetected: number;
  /** entries whose name/url collides with a row this registry does not own */
  conflicts: number;
  /** servers this sync created. ALWAYS ZERO — a sync never creates one. */
  serversCreated: 0;
  /** grants this sync created. ALWAYS ZERO. */
  grantsCreated: 0;
}

const EMPTY_COUNTS = {
  pages: 0,
  truncated: false,
  entriesSeen: 0,
  created: 0,
  updated: 0,
  remote: 0,
  catalogueOnly: 0,
  malformed: 0,
  markedMissing: 0,
  driftDetected: 0,
  conflicts: 0,
  serversCreated: 0 as const,
  grantsCreated: 0 as const,
};

async function readBounded(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length > MCP_REGISTRY_MAX_BODY_BYTES) {
    throw new Error(`registry response exceeded ${MCP_REGISTRY_MAX_BODY_BYTES} bytes`);
  }
  return JSON.parse(text) as unknown;
}

/**
 * ONE SYNC PASS OVER ONE REGISTRY. Writes `mcp_registry_entries` and the
 * registry's own last-sync columns. Writes NOTHING ELSE — no server row, no
 * grant, no tool, and never `mcp_servers.url`.
 */
export async function syncRegistry(
  db: Db,
  registry: RegistryRow,
  opts: {
    actorUserId?: string | null;
    now?: Date;
    maxPages?: number;
    deps?: McpRegistryDeps;
  } = {},
): Promise<SyncRegistryResult> {
  const now = opts.now ?? new Date();
  const deps = opts.deps ?? {};
  const maxPages = Math.max(1, opts.maxPages ?? MCP_REGISTRY_SYNC_MAX_PAGES);
  const deployMode = deps.deployMode ?? resolveDeployMode();
  const base = { registryId: registry.id, registryName: registry.name, ...EMPTY_COUNTS };

  const finish = async (
    outcome: SyncRegistryResult["outcome"],
    reason: string,
    counts: Partial<typeof EMPTY_COUNTS>,
  ): Promise<SyncRegistryResult> => {
    const out: SyncRegistryResult = { ...base, ...counts, outcome, reason };
    await db
      .update(mcpRegistries)
      .set({
        lastSyncAt: now,
        lastSyncOutcome: outcome,
        lastSyncDetail: {
          at: now.toISOString(),
          outcome,
          reason,
          pages: out.pages,
          truncated: out.truncated,
          entriesSeen: out.entriesSeen,
          created: out.created,
          updated: out.updated,
          remote: out.remote,
          catalogueOnly: out.catalogueOnly,
          malformed: out.malformed,
          markedMissing: out.markedMissing,
          driftDetected: out.driftDetected,
          conflicts: out.conflicts,
        },
      })
      .where(eq(mcpRegistries.id, registry.id));
    return out;
  };

  // ── THE AIR-GAP GATE. Before DNS, before the allow-list, before any socket.
  const airgap = airGappedFederationRefusal(deployMode);
  if (airgap) {
    await auditRegistryDenied(db, {
      userId: opts.actorUserId ?? null,
      registryId: registry.id,
      reason: `MCP registry '${registry.name}' sync refused: ${airgap}`,
      detail: { phase: "sync", deployMode, url: registry.url, code: "air_gapped" },
    });
    return finish("refused", `air-gapped: ${airgap}`, {});
  }

  const posture = await loadRegistryEgressPosture(db, registry.allowPrivateRanges);
  const guardOpts = {
    allowList: posture.allowList,
    privateLan: { openByDefault: posture.openByDefault },
    ...(deps.resolve ? { resolve: deps.resolve } : {}),
  };
  // ── ADR-0043's guard, adjudicated on the BASE url before the first page, so
  // a refusal is one audit row rather than one per page.
  const decision = await checkEgress(registry.url, guardOpts);
  if (!decision.ok) {
    const denied = decision as EgressDenied;
    const reason = `MCP registry '${registry.name}' sync refused: ${denied.reason}`;
    await auditRegistryDenied(db, {
      userId: opts.actorUserId ?? null,
      registryId: registry.id,
      reason,
      detail: { phase: "sync", deployMode, url: registry.url, code: denied.code, ...(denied.host ? { host: denied.host } : {}) },
    });
    return finish("refused", reason, {});
  }

  const guardedFetch = createGuardedFetch({
    ...guardOpts,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });

  const counts = { ...EMPTY_COUNTS } as {
    pages: number;
    truncated: boolean;
    entriesSeen: number;
    created: number;
    updated: number;
    remote: number;
    catalogueOnly: number;
    malformed: number;
    markedMissing: number;
    driftDetected: number;
    conflicts: number;
    serversCreated: 0;
    grantsCreated: 0;
  };
  const seenNames: string[] = [];
  let cursor: string | null = null;

  try {
    for (let page = 0; page < maxPages; page += 1) {
      const url = listingUrl(registry.url, { cursor, limit: MCP_REGISTRY_MAX_PAGE_SIZE });
      const res = await guardedFetch(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(MCP_REGISTRY_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`registry returned HTTP ${res.status}`);
      const normalized = normalizeRegistryPage(await readBounded(res));
      counts.pages += 1;
      counts.malformed += normalized.skipped;
      for (const entry of normalized.entries) {
        counts.entriesSeen += 1;
        seenNames.push(entry.upstreamName);
        if (entry.kind === "remote") counts.remote += 1;
        else counts.catalogueOnly += 1;
        const persisted = await upsertEntry(db, registry.id, entry, now);
        if (persisted.created) counts.created += 1;
        else counts.updated += 1;
        if (persisted.drift) counts.driftDetected += 1;
        if (persisted.conflict) counts.conflicts += 1;
      }
      // OPAQUE cursor, passed back verbatim. Never parsed, never constructed.
      cursor = normalized.nextCursor;
      if (!cursor) break;
    }
    if (cursor) counts.truncated = true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const reason = `MCP registry '${registry.name}' sync failed after ${counts.pages} page(s): ${message}`;
    // A failure is NOT a refusal and NOT a deletion: whatever the catalogue
    // already holds stays exactly as it is, and nothing is marked missing.
    return finish("failed", reason, counts);
  }

  // ── DISAPPEARANCE, and the one condition under which it means anything.
  // Only a COMPLETE listing can tell "gone" from "beyond the page cap".
  if (!counts.truncated) {
    counts.markedMissing = await markMissing(db, registry.id, seenNames, now);
  }

  const reason =
    `MCP registry '${registry.name}' synced ${counts.entriesSeen} entr(ies) over ${counts.pages} page(s)` +
    (counts.truncated ? ` (TRUNCATED at ${maxPages} pages — the remainder is picked up next pass, and nothing was marked missing)` : "") +
    `: ${counts.created} new, ${counts.updated} refreshed, ${counts.remote} with a usable remote endpoint, ` +
    `${counts.catalogueOnly} catalogue-only (no endpoint this gateway can dial — never importable), ` +
    `${counts.conflicts} colliding with a row this registry does not own, ${counts.driftDetected} whose ` +
    `upstream endpoint moved (local url left alone), ${counts.markedMissing} no longer listed upstream ` +
    `(recorded only — no local server was deleted, disabled or un-granted), ${counts.malformed} unusable rows skipped. ` +
    `This sync created 0 servers and 0 grants: importing is a separate, explicit operator act.`;

  await db.insert(auditLog).values({
    userId: opts.actorUserId ?? NIL_USER,
    objectType: "mcp_server",
    objectId: registry.id,
    detail: {
      phase: "registry-sync",
      registryId: registry.id,
      registryName: registry.name,
      url: registry.url,
      deployMode,
      at: now.toISOString(),
      pages: counts.pages,
      truncated: counts.truncated,
      entriesSeen: counts.entriesSeen,
      created: counts.created,
      updated: counts.updated,
      remote: counts.remote,
      catalogueOnly: counts.catalogueOnly,
      malformed: counts.malformed,
      markedMissing: counts.markedMissing,
      driftDetected: counts.driftDetected,
      conflicts: counts.conflicts,
      serversCreated: 0,
      grantsCreated: 0,
    },
    effect: "allow",
    ruleId: mcpRegistryRuleIds.synced,
    ruleChain: [],
    reason,
  });

  return finish("ok", reason, counts);
}

/** Upsert one catalogue entry. Idempotent on `(registry_id, upstream_name)`,
 * which is what makes running the sweep twice a no-op rather than a duplicate. */
async function upsertEntry(
  db: Db,
  registryId: string,
  entry: NormalizedRegistryEntry,
  now: Date,
): Promise<{ created: boolean; drift: boolean; conflict: boolean }> {
  const [existing] = await db
    .select()
    .from(mcpRegistryEntries)
    .where(
      and(
        eq(mcpRegistryEntries.registryId, registryId),
        eq(mcpRegistryEntries.upstreamName, entry.upstreamName),
      ),
    );

  const conflict = await detectConflict(db, entry, existing?.serverId ?? null);

  const common = {
    upstreamVersion: entry.upstreamVersion,
    title: entry.title,
    description: entry.description,
    repositoryUrl: entry.repositoryUrl,
    websiteUrl: entry.websiteUrl,
    kind: entry.kind,
    remoteTransport: entry.remoteTransport,
    catalogueReason: entry.catalogueReason,
    upstreamStatus: entry.upstreamStatus,
    upstreamPublishedAt: entry.publishedAt ? new Date(entry.publishedAt) : null,
    upstreamUpdatedAt: entry.updatedAt ? new Date(entry.updatedAt) : null,
    lastSeenAt: now,
    lastSyncedAt: now,
    // re-appearing upstream clears the missing marker; it never un-deletes
    // anything, because nothing was deleted.
    missingSince: null,
    conflictReason: conflict?.reason ?? null,
    conflictServerId: conflict?.serverId ?? null,
  };

  if (!existing) {
    await db.insert(mcpRegistryEntries).values({
      registryId,
      upstreamName: entry.upstreamName,
      remoteUrl: entry.remoteUrl,
      firstSeenAt: now,
      ...common,
    });
    return { created: true, drift: false, conflict: conflict !== null };
  }

  // DRIFT. An already-imported entry whose upstream endpoint has moved. The
  // catalogue records where it moved TO; `mcp_servers.url` is not touched,
  // here or anywhere else in this module.
  const moved =
    existing.serverId !== null &&
    entry.remoteUrl !== null &&
    existing.remoteUrl !== null &&
    entry.remoteUrl !== existing.remoteUrl;

  await db
    .update(mcpRegistryEntries)
    .set({
      ...common,
      // the catalogue's own view of the current upstream endpoint always tracks
      // upstream; the IMPORTED server's url is a different, frozen fact.
      remoteUrl: entry.remoteUrl,
      ...(moved ? { remoteUrlDrift: entry.remoteUrl } : {}),
      // provenance on the imported server row: version and last-synced move,
      // name and url never do.
    })
    .where(eq(mcpRegistryEntries.id, existing.id));

  if (existing.serverId) {
    await db
      .update(mcpServers)
      .set({ registryVersion: entry.upstreamVersion, registryLastSyncedAt: now })
      .where(eq(mcpServers.id, existing.serverId));
  }

  return { created: false, drift: moved, conflict: conflict !== null };
}

/**
 * Does this entry collide with a server row this catalogue entry does not own?
 *
 * `ownServerId` is the server this entry already imported (if any) — colliding
 * with yourself is not a collision. Everything else is: a hand-registered
 * server, or one imported from a different registry.
 */
async function detectConflict(
  db: Db,
  entry: NormalizedRegistryEntry,
  ownServerId: string | null,
): Promise<{ reason: McpImportConflictReason; serverId: string } | null> {
  const localName = localServerNameFor(entry.upstreamName);
  const byName = await db
    .select({ id: mcpServers.id })
    .from(mcpServers)
    .where(
      ownServerId
        ? and(eq(mcpServers.name, localName), ne(mcpServers.id, ownServerId))
        : eq(mcpServers.name, localName),
    );
  if (byName[0]) return { reason: "name_taken", serverId: byName[0].id };
  if (entry.remoteUrl) {
    const byUrl = await db
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(
        ownServerId
          ? and(eq(mcpServers.url, entry.remoteUrl), ne(mcpServers.id, ownServerId))
          : eq(mcpServers.url, entry.remoteUrl),
      );
    if (byUrl[0]) return { reason: "url_taken", serverId: byUrl[0].id };
  }
  return null;
}

/**
 * Mark entries a COMPLETE listing no longer contained.
 *
 * This sets a timestamp on a catalogue row. It does not delete the row, and it
 * emphatically does not touch `mcp_servers`: an imported server keeps existing,
 * keeps its url, keeps every grant anybody has on it. A public directory losing
 * an entry — because a publisher unpublished it, or because somebody took over
 * an abandoned name — is not authority to remove a governed object from an
 * operator's estate. It is information, and the operator acts on it.
 */
async function markMissing(db: Db, registryId: string, seen: string[], now: Date): Promise<number> {
  const rows = await db
    .select({ id: mcpRegistryEntries.id, upstreamName: mcpRegistryEntries.upstreamName })
    .from(mcpRegistryEntries)
    .where(and(eq(mcpRegistryEntries.registryId, registryId), isNull(mcpRegistryEntries.missingSince)));
  const seenSet = new Set(seen);
  const gone = rows.filter((r) => !seenSet.has(r.upstreamName));
  for (const row of gone) {
    await db
      .update(mcpRegistryEntries)
      .set({ missingSince: now })
      .where(eq(mcpRegistryEntries.id, row.id));
  }
  return gone.length;
}

// ---------------------------------------------------------------------------
// the import — an explicit operator act
// ---------------------------------------------------------------------------

export type ImportRefusal =
  | { status: 404; body: { error: "unknown_entry" } }
  | { status: 409; body: { error: "not_importable"; reason: string; detail: string } }
  | { status: 409; body: { error: "conflict"; reason: McpImportConflictReason; conflictServerId: string; detail: string } }
  | { status: 409; body: { error: "already_imported"; serverId: string } }
  | { status: 400; body: { error: "egress_blocked"; code: string; detail: string } };

export interface ImportResult {
  serverId: string;
  name: string;
  url: string;
  admissionState: string;
  origin: "federated";
  /** the two numbers this act is judged on, returned so the caller can see them */
  grantsCreated: 0;
  toolsCreated: 0;
}

/**
 * Import ONE catalogue entry into `mcp_servers`.
 *
 * What this creates: one row, `origin='federated'`, `admission_state='unscanned'`,
 * carrying its provenance.
 *
 * What this does NOT create, and the reason the numbers are in the return type:
 * zero `tool_grants`, zero `server_grants`, zero `mcp_tools`. The imported
 * server is reachable by the proxy route and usable by NOBODY — the first
 * ordinary user to call it is refused by the same policy path that refuses any
 * ungranted server, and the first connect is scanned by ADR-0097 like any other.
 */
export async function importRegistryEntry(
  db: Db,
  entryId: string,
  opts: { actorUserId?: string | null; now?: Date; deps?: McpRegistryDeps } = {},
): Promise<{ ok: true; result: ImportResult } | { ok: false; refusal: ImportRefusal }> {
  const now = opts.now ?? new Date();
  const [entry] = await db.select().from(mcpRegistryEntries).where(eq(mcpRegistryEntries.id, entryId));
  if (!entry) return { ok: false, refusal: { status: 404, body: { error: "unknown_entry" } } };
  if (entry.serverId) {
    return { ok: false, refusal: { status: 409, body: { error: "already_imported", serverId: entry.serverId } } };
  }

  // ── NO URL IS INVENTED. A catalogue-only entry has no endpoint and never
  // acquires one; this is the refusal an operator sees when they ask why.
  if (entry.kind !== "remote" || !entry.remoteUrl) {
    const detail =
      `'${entry.upstreamName}' publishes no remote endpoint this gateway can call ` +
      `(${entry.catalogueReason ?? "no_distribution"}). RegulAIt proxies remote HTTP MCP servers; a ` +
      `package distribution is installed and run locally over stdio, and no URL is invented for one. ` +
      `The entry stays in the catalogue as a record of what the registry publishes, and it can never ` +
      `become a callable server.`;
    return {
      ok: false,
      refusal: { status: 409, body: { error: "not_importable", reason: entry.catalogueReason ?? "no_distribution", detail } },
    };
  }

  const [registry] = await db.select().from(mcpRegistries).where(eq(mcpRegistries.id, entry.registryId));

  // ── COLLISION. Re-checked at import time against the LIVE table, not trusted
  // from the last sync, and never resolved by overwriting.
  const conflict = await detectConflict(
    db,
    {
      upstreamName: entry.upstreamName,
      remoteUrl: entry.remoteUrl,
    } as NormalizedRegistryEntry,
    null,
  );
  if (conflict) {
    await db
      .update(mcpRegistryEntries)
      .set({ conflictReason: conflict.reason, conflictServerId: conflict.serverId })
      .where(eq(mcpRegistryEntries.id, entry.id));
    const detail =
      conflict.reason === "name_taken"
        ? `an MCP server named '${localServerNameFor(entry.upstreamName)}' already exists and was not created by this ` +
          `registry. A local row is an operator's own decision and a federated entry never overwrites one; ` +
          `the collision is recorded on the catalogue entry for a human to resolve.`
        : `an MCP server already points at ${entry.remoteUrl}. Importing would create a second governed ` +
          `object for one endpoint, with two independent grant sets; the collision is recorded rather ` +
          `than merged.`;
    await db.insert(auditLog).values({
      userId: opts.actorUserId ?? NIL_USER,
      objectType: "mcp_server",
      objectId: conflict.serverId,
      detail: {
        phase: "registry-import",
        registryId: entry.registryId,
        registryName: registry?.name ?? null,
        upstreamName: entry.upstreamName,
        conflictReason: conflict.reason,
        conflictServerId: conflict.serverId,
      },
      effect: "deny",
      ruleId: mcpRegistryRuleIds.importConflict,
      ruleChain: [],
      reason: `MCP registry import refused: ${detail}`,
    });
    return {
      ok: false,
      refusal: {
        status: 409,
        body: { error: "conflict", reason: conflict.reason, conflictServerId: conflict.serverId, detail },
      },
    };
  }

  // ── ADR-0043 at write time, exactly as POST /v1/servers does it. An operator
  // typing this url by hand would be adjudicated; arriving from a registry
  // changes nothing about whether this box may dial it.
  const deps = opts.deps ?? {};
  const posture = await loadRegistryEgressPosture(db, registry?.allowPrivateRanges ?? null);
  const decision = await checkEgress(entry.remoteUrl, {
    allowList: posture.allowList,
    privateLan: { openByDefault: posture.openByDefault },
    ...(deps.resolve ? { resolve: deps.resolve } : {}),
  });
  if (!decision.ok) {
    const denied = decision as EgressDenied;
    const detail = `imported MCP server '${entry.upstreamName}' url refused: ${denied.reason}`;
    await auditRegistryDenied(db, {
      userId: opts.actorUserId ?? null,
      registryId: entry.registryId,
      reason: detail,
      detail: { phase: "registry-import", url: entry.remoteUrl, code: denied.code, ...(denied.host ? { host: denied.host } : {}) },
    });
    return { ok: false, refusal: { status: 400, body: { error: "egress_blocked", code: denied.code, detail } } };
  }

  const [row] = await db
    .insert(mcpServers)
    .values({
      name: localServerNameFor(entry.upstreamName),
      url: entry.remoteUrl,
      // ADR-0043's tri-state, inherited from the registry that vouched for it.
      allowPrivateRanges: registry?.allowPrivateRanges ?? null,
      // ADR-0097: EXPLICIT, and deliberately not `grandfathered`. A server that
      // arrived from a public directory has no history to be trusted on.
      admissionState: REGISTRATION_ADMISSION_STATE,
      origin: "federated",
      registryId: entry.registryId,
      registryEntryName: entry.upstreamName,
      registryVersion: entry.upstreamVersion,
      registryFirstSeenAt: entry.firstSeenAt,
      registryLastSyncedAt: entry.lastSyncedAt,
    })
    .returning();
  if (!row) throw new Error("import failed to create server row");

  await db
    .update(mcpRegistryEntries)
    .set({ serverId: row.id, importedAt: now, importedBy: opts.actorUserId ?? null, conflictReason: null, conflictServerId: null })
    .where(eq(mcpRegistryEntries.id, entry.id));

  await db.insert(auditLog).values({
    userId: opts.actorUserId ?? NIL_USER,
    objectType: "mcp_server",
    objectId: row.id,
    serverId: row.id,
    detail: {
      phase: "registry-import",
      registryId: entry.registryId,
      registryName: registry?.name ?? null,
      upstreamName: entry.upstreamName,
      upstreamVersion: entry.upstreamVersion,
      remoteTransport: entry.remoteTransport,
      url: entry.remoteUrl,
      admissionState: REGISTRATION_ADMISSION_STATE,
      origin: "federated",
      grantsCreated: 0,
      toolsCreated: 0,
    },
    effect: "allow",
    ruleId: mcpRegistryRuleIds.imported,
    ruleChain: [],
    reason:
      `Imported MCP server '${entry.upstreamName}' v${entry.upstreamVersion} from registry ` +
      `'${registry?.name ?? entry.registryId}' as a federated row. It is usable by NOBODY: the import ` +
      `created 0 grants, and an ordinary user calling it is refused exactly as for any ungranted ` +
      `server. It is admission_state='unscanned', so ADR-0097 scans its manifest on the first ` +
      `connect and holds it under enforce if that manifest is dirty — federation gets no bypass.`,
  });

  return {
    ok: true,
    result: {
      serverId: row.id,
      name: row.name,
      url: row.url,
      admissionState: REGISTRATION_ADMISSION_STATE,
      origin: "federated",
      grantsCreated: 0,
      toolsCreated: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// the ADR-0064 sweep
// ---------------------------------------------------------------------------

export interface McpRegistrySweepResult {
  deployMode: DeployMode;
  /** true when the pass pulled nothing because federation is refused or there
   * is nothing enabled to pull */
  skipped: boolean;
  reason: string;
  /** enabled registries at the start of the pass */
  eligible: number;
  examined: number;
  capped: boolean;
  ok: number;
  refused: number;
  failed: number;
  entriesSeen: number;
  created: number;
  updated: number;
  remote: number;
  catalogueOnly: number;
  markedMissing: number;
  driftDetected: number;
  conflicts: number;
  truncatedRegistries: number;
  /** ALWAYS ZERO — the sweep is a catalogue pass and creates no governed object */
  serversCreated: 0;
  grantsCreated: 0;
}

/**
 * ONE SWEEP PASS. Called by the ADR-0064 job `mcp-registry-sync-sweep` and by
 * that job's `POST /v1/scheduler/jobs/:name/run` manual door — the same
 * function, so a hand-run and a timed run are the same code path by
 * construction rather than by review.
 *
 * DOUBLY OPT-IN, like ADR-0100's re-scan: ADR-0064's scheduler is off by
 * default, AND a fresh install has zero registry rows, AND a registry row is
 * `enabled = false` until an operator says otherwise.
 */
export async function runMcpRegistrySync(
  db: Db,
  opts: { actorUserId?: string | null; now?: Date; limit?: number; deps?: McpRegistryDeps } = {},
): Promise<McpRegistrySweepResult> {
  const now = opts.now ?? new Date();
  const deps = opts.deps ?? {};
  const limit = Math.max(1, opts.limit ?? MCP_REGISTRY_SWEEP_MAX_REGISTRIES);
  const deployMode = deps.deployMode ?? resolveDeployMode();

  const empty = {
    eligible: 0,
    examined: 0,
    capped: false,
    ok: 0,
    refused: 0,
    failed: 0,
    entriesSeen: 0,
    created: 0,
    updated: 0,
    remote: 0,
    catalogueOnly: 0,
    markedMissing: 0,
    driftDetected: 0,
    conflicts: 0,
    truncatedRegistries: 0,
    serversCreated: 0 as const,
    grantsCreated: 0 as const,
  };

  // ── THE AIR-GAP GATE AT THE SWEEP LEVEL TOO. Returns before any row is read
  // so the pass provably contacts nothing; the scheduler still writes its
  // ordinary run row carrying skipped:true and the reason, because "it ran and
  // did nothing on purpose" must never look like "it never ran".
  const airgap = airGappedFederationRefusal(deployMode);
  if (airgap) {
    return { deployMode, skipped: true, reason: airgap, ...empty };
  }

  const registries = (await db
    .select({
      id: mcpRegistries.id,
      name: mcpRegistries.name,
      url: mcpRegistries.url,
      enabled: mcpRegistries.enabled,
      allowPrivateRanges: mcpRegistries.allowPrivateRanges,
    })
    .from(mcpRegistries)
    .where(eq(mcpRegistries.enabled, true))
    .orderBy(sql`${mcpRegistries.lastSyncAt} asc nulls first`, asc(mcpRegistries.id))) as RegistryRow[];

  if (registries.length === 0) {
    return {
      deployMode,
      skipped: true,
      reason:
        "no enabled MCP registries — federation is configured per registry row and a fresh install " +
        "has none, so this pass contacted nothing and wrote nothing.",
      ...empty,
    };
  }

  const batch = registries.slice(0, limit);
  const out = { ...empty, eligible: registries.length, examined: batch.length, capped: registries.length > batch.length };

  for (const registry of batch) {
    const r = await syncRegistry(db, registry, {
      actorUserId: opts.actorUserId ?? null,
      now,
      ...(opts.deps ? { deps: opts.deps } : {}),
    });
    if (r.outcome === "ok") out.ok += 1;
    else if (r.outcome === "refused") out.refused += 1;
    else if (r.outcome === "failed") out.failed += 1;
    out.entriesSeen += r.entriesSeen;
    out.created += r.created;
    out.updated += r.updated;
    out.remote += r.remote;
    out.catalogueOnly += r.catalogueOnly;
    out.markedMissing += r.markedMissing;
    out.driftDetected += r.driftDetected;
    out.conflicts += r.conflicts;
    if (r.truncated) out.truncatedRegistries += 1;
  }

  const reason =
    `MCP registry sweep pulled ${out.examined} of ${out.eligible} enabled registr(ies)` +
    (out.capped ? ` (capped at ${limit} per pass; the remainder is picked up next pass, least-recently-synced first)` : "") +
    `: ${out.ok} ok, ${out.refused} refused, ${out.failed} failed. ` +
    `${out.entriesSeen} catalogue entr(ies) seen — ${out.created} new, ${out.updated} refreshed, ` +
    `${out.remote} importable, ${out.catalogueOnly} catalogue-only, ${out.conflicts} colliding, ` +
    `${out.driftDetected} endpoint-drifted (local urls untouched), ${out.markedMissing} no longer listed. ` +
    `${out.truncatedRegistries} registr(ies) hit the ${MCP_REGISTRY_SYNC_MAX_PAGES}-page bound. ` +
    `The sweep created 0 servers and 0 grants: it writes the catalogue and nothing else.`;

  // ONE AUDITED FACT PER PASS, in the shape ADR-0100's
  // `mcp-admission-rescan-swept` established. `effect: 'allow'` deliberately —
  // each refused registry already filed its own deny row, and duplicating it
  // here would double-count a refusal on an admin's filtered view.
  await db.insert(auditLog).values({
    userId: opts.actorUserId ?? NIL_USER,
    objectType: "mcp_server",
    objectId: null,
    detail: { phase: "registry-sync-sweep", deployMode, at: now.toISOString(), limit, ...out },
    effect: "allow",
    ruleId: mcpRegistryRuleIds.swept,
    ruleChain: [],
    reason,
  });

  return { deployMode, skipped: false, reason, ...out };
}

// ---------------------------------------------------------------------------
// admin API
// ---------------------------------------------------------------------------

export const createMcpRegistrySchema = z
  .object({
    name: z.string().min(1).max(200),
    url: z.string().min(1).max(2000),
    enabled: z.boolean().optional(),
    allowPrivateRanges: z.boolean().nullish(),
  })
  .strict();

export const updateMcpRegistrySchema = z
  .object({
    url: z.string().min(1).max(2000).optional(),
    enabled: z.boolean().optional(),
    allowPrivateRanges: z.boolean().nullish(),
  })
  .strict();

const uuidParam = z.object({ registryId: z.string().uuid() });
const entryParam = z.object({ entryId: z.string().uuid() });

/** Admin-only through the default gate (none of these appear in
 * NON_ADMIN_ROUTES): configuring a registry, pulling one, and importing an
 * entry are all acts that change what governed objects exist. */
export function registerMcpRegistryRoutes(app: FastifyInstance, db: Db, deps: McpRegistryDeps = {}) {
  app.post("/v1/mcp-registries", async (req, reply) => {
    const body = createMcpRegistrySchema.parse(req.body);
    const refusal = await refuseRegistryWrite(db, {
      url: body.url,
      allowPrivateRanges: body.allowPrivateRanges ?? null,
      userId: req.authCtx.userId ?? null,
      label: `MCP registry '${body.name}' url`,
      deps,
    });
    if (refusal) return reply.status(400).send(refusal);
    const [row] = await db
      .insert(mcpRegistries)
      .values({
        name: body.name,
        url: body.url,
        enabled: body.enabled ?? false,
        allowPrivateRanges: body.allowPrivateRanges ?? null,
      })
      .returning();
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? NIL_USER,
      objectType: "mcp_server",
      objectId: row!.id,
      detail: { phase: "registry-configure", action: "create", name: body.name, url: body.url, enabled: row!.enabled },
      effect: "allow",
      ruleId: mcpRegistryRuleIds.configured,
      ruleChain: [],
      reason: `Configured MCP registry '${body.name}' (${row!.enabled ? "enabled" : "disabled"}). Configuring a registry imports nothing.`,
    });
    return reply.status(201).send(row);
  });

  app.get("/v1/mcp-registries", async () => {
    const deployMode = deps.deployMode ?? resolveDeployMode();
    return {
      deployMode,
      // stated in the listing so an operator never has to infer it from a
      // string of failed syncs
      federationRefused: airGappedFederationRefusal(deployMode) !== null,
      federationRefusedReason: airGappedFederationRefusal(deployMode),
      maxPagesPerSync: MCP_REGISTRY_SYNC_MAX_PAGES,
      maxRegistriesPerSweep: MCP_REGISTRY_SWEEP_MAX_REGISTRIES,
      registries: await db.select().from(mcpRegistries).orderBy(asc(mcpRegistries.name)),
    };
  });

  app.patch("/v1/mcp-registries/:registryId", async (req, reply) => {
    const { registryId } = uuidParam.parse(req.params);
    const body = updateMcpRegistrySchema.parse(req.body);
    const [before] = await db.select().from(mcpRegistries).where(eq(mcpRegistries.id, registryId));
    if (!before) return reply.status(404).send({ error: "unknown_registry" });
    const nextUrl = body.url ?? before.url;
    const nextFlag = body.allowPrivateRanges !== undefined ? body.allowPrivateRanges ?? null : before.allowPrivateRanges;
    if (body.url !== undefined || body.allowPrivateRanges !== undefined) {
      const refusal = await refuseRegistryWrite(db, {
        url: nextUrl,
        allowPrivateRanges: nextFlag,
        userId: req.authCtx.userId ?? null,
        registryId,
        label: `MCP registry '${before.name}' url`,
        deps,
      });
      if (refusal) return reply.status(400).send(refusal);
    }
    const [row] = await db
      .update(mcpRegistries)
      .set({
        ...(body.url !== undefined ? { url: body.url } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.allowPrivateRanges !== undefined ? { allowPrivateRanges: body.allowPrivateRanges ?? null } : {}),
      })
      .where(eq(mcpRegistries.id, registryId))
      .returning();
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? NIL_USER,
      objectType: "mcp_server",
      objectId: registryId,
      detail: { phase: "registry-configure", action: "update", name: before.name, url: row!.url, enabled: row!.enabled },
      effect: "allow",
      ruleId: mcpRegistryRuleIds.configured,
      ruleChain: [],
      reason: `Updated MCP registry '${before.name}' (${row!.enabled ? "enabled" : "disabled"}).`,
    });
    return reply.send(row);
  });

  /** THE MANUAL DOOR for one registry — the same `syncRegistry` the sweep calls. */
  app.post("/v1/mcp-registries/:registryId/sync", async (req, reply) => {
    const { registryId } = uuidParam.parse(req.params);
    const [registry] = await db.select().from(mcpRegistries).where(eq(mcpRegistries.id, registryId));
    if (!registry) return reply.status(404).send({ error: "unknown_registry" });
    const out = await syncRegistry(
      db,
      {
        id: registry.id,
        name: registry.name,
        url: registry.url,
        enabled: registry.enabled,
        allowPrivateRanges: registry.allowPrivateRanges,
      },
      { actorUserId: req.authCtx.userId ?? null, deps },
    );
    return reply.status(out.outcome === "ok" ? 200 : 200).send(out);
  });

  app.get("/v1/mcp-registries/:registryId/entries", async (req, reply) => {
    const { registryId } = uuidParam.parse(req.params);
    const [registry] = await db.select().from(mcpRegistries).where(eq(mcpRegistries.id, registryId));
    if (!registry) return reply.status(404).send({ error: "unknown_registry" });
    const entries = await db
      .select()
      .from(mcpRegistryEntries)
      .where(eq(mcpRegistryEntries.registryId, registryId))
      .orderBy(asc(mcpRegistryEntries.upstreamName));
    return reply.send({ registry: { id: registry.id, name: registry.name }, entries });
  });

  app.post("/v1/mcp-registries/entries/:entryId/import", async (req, reply) => {
    const { entryId } = entryParam.parse(req.params);
    const out = await importRegistryEntry(db, entryId, {
      actorUserId: req.authCtx.userId ?? null,
      deps,
    });
    if (!out.ok) return reply.status(out.refusal.status).send(out.refusal.body);
    return reply.status(201).send(out.result);
  });
}

/** kept exported for the suite and for anyone auditing what a federated row can
 * reach: a federated server row is an ORDINARY `mcp_servers` row in every
 * respect except its provenance columns. There is no federation branch in the
 * policy gate, the proxy route, the admission gate or the egress guard, and
 * this constant exists to make the absence searchable. */
export const FEDERATION_HAS_NO_CALL_PATH_BRANCH = true;
