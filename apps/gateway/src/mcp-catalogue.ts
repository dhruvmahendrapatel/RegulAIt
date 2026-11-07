/**
 * ADR-0256 — SEEDING THE MCP CATALOGUE: the impure half.
 *
 * Builds on ADR-0101's federation (the pull, the inert catalogue, the explicit import). This module adds:
 *
 *   1. PRESETS: `POST /v1/mcp-catalogue/presets/:preset` creates the official MCP Registry or the community
 *      `awesome-mcp-servers` list as a source, DISABLED and through the same egress check as any registry. Nothing is
 *      seeded on install; nothing is fetched at request time (the scheduled sweep or a manual sync does that).
 *   2. SIGNED OFFLINE BUNDLES: `POST /v1/mcp-catalogue/bundles` imports a catalogue snapshot an air-gapped install
 *      cannot pull. The bundle text must verify under an Ed25519 key in the configured keyring
 *      (`REGULAIT_MCP_CATALOGUE_BUNDLE_KEYS` or `…_FILE`); with no keyring every bundle is refused. A bundle older
 *      than the last one imported for its source is refused (rollback protection).
 *      `GET /v1/mcp-catalogue/bundle?registryId=` exports the UNSIGNED bundle text from a connected install; it is
 *      signed offline (`scripts/mcp-catalogue-bundle-sign.mjs`), never by this gateway.
 *   3. THE DEDUPED VIEW: `GET /v1/mcp-catalogue` groups source rows by dedupe key, each with its own provenance, its
 *      vetting (community = unvetted), its paid/x402 flag and its admission state.
 *
 * NOTHING HERE ADMITS ANYTHING. Every entry is "available, not admitted". The only way to a usable server is ADR-0101's
 * import (stepped-up, audited), which creates an `unscanned` server with no grants; the MCP admission scan, and every
 * scanner and pinning check plugged into it, decides from there. There is no catalogue branch in the call path.
 *
 * Admin-only: none of these routes is in NON_ADMIN_ROUTES.
 */
import { createHash, createPublicKey, verify as ed25519Verify, type KeyObject } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import {
  and,
  asc,
  auditLog,
  desc,
  eq,
  inArray,
  isNotNull,
  mcpCatalogueItems,
  mcpCatalogueSnapshots,
  mcpRegistries,
  mcpRegistryEntries,
  mcpServers,
  sql,
  type Db,
} from "@regulait/db";
import {
  bundleEntriesUsable,
  MCP_CATALOGUE_BUNDLE_FORMAT,
  MCP_CATALOGUE_BUNDLE_MAX_BYTES,
  MCP_CATALOGUE_PRESET_IDS,
  MCP_CATALOGUE_PRESETS,
  mcpCatalogueBundleSchema,
  vettingFor,
  type McpCatalogueBundle,
  type McpCataloguePreset,
} from "@regulait/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  markMissing,
  mcpRegistryRuleIds,
  recordCatalogueSnapshot,
  refuseRegistryWrite,
  registryEntryDigest,
  upsertEntry,
  type McpRegistryDeps,
} from "./mcp-registry.js";
import { likeLiteral } from "./users-list.js";

const NIL_USER = "00000000-0000-0000-0000-000000000000";
const rowsOf = <T>(r: unknown): T[] => (r as { rows?: T[] }).rows ?? [];
/** the database clock (M-075) */
async function dbNow(db: Db): Promise<Date> {
  const row = rowsOf<{ now: Date | string }>(await db.execute(sql`select now() as "now"`))[0]!;
  return new Date(row.now);
}

export const MCP_CATALOGUE_BUNDLE_KEYS_ENV = "REGULAIT_MCP_CATALOGUE_BUNDLE_KEYS";
export const MCP_CATALOGUE_BUNDLE_KEYS_FILE_ENV = "REGULAIT_MCP_CATALOGUE_BUNDLE_KEYS_FILE";

// ---------------------------------------------------------------------------
// the keyring
// ---------------------------------------------------------------------------

const keyringSchema = z
  .array(z.object({ keyId: z.string().min(1).max(128), publicKeyPem: z.string().min(1).max(4096) }).strict())
  .max(32);

/**
 * The trusted bundle keys, by id. Public keys only, so not a secret, but still out of code and rotatable: list the new
 * key beside the old, then drop the old. Only Ed25519 is accepted (the algorithm is pinned). An unparseable keyring,
 * a non-Ed25519 key or a key id listed twice refuses the WHOLE keyring, so a typo never half-trusts.
 */
export function loadBundleKeyring(env: NodeJS.ProcessEnv = process.env): Map<string, KeyObject> | { error: string } {
  const inline = env[MCP_CATALOGUE_BUNDLE_KEYS_ENV]?.trim();
  const file = env[MCP_CATALOGUE_BUNDLE_KEYS_FILE_ENV]?.trim();
  if (inline && file) return { error: `set one of ${MCP_CATALOGUE_BUNDLE_KEYS_ENV} and ${MCP_CATALOGUE_BUNDLE_KEYS_FILE_ENV}, not both` };
  let raw: unknown = null;
  try {
    if (inline) raw = JSON.parse(inline) as unknown;
    else if (file) {
      const st = statSync(file);
      if (!st.isFile() || st.size > 256 * 1024) return { error: `${MCP_CATALOGUE_BUNDLE_KEYS_FILE_ENV} is not a readable keyring file` };
      raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    }
  } catch {
    return { error: "the MCP catalogue bundle keyring is not valid JSON" };
  }
  const out = new Map<string, KeyObject>();
  if (raw === null) return out;
  const parsed = keyringSchema.safeParse(raw);
  if (!parsed.success) return { error: "the MCP catalogue bundle keyring is not a list of { keyId, publicKeyPem }" };
  for (const k of parsed.data) {
    if (out.has(k.keyId)) return { error: `the MCP catalogue bundle keyring lists key '${k.keyId}' twice` };
    let key: KeyObject;
    try {
      key = createPublicKey(k.publicKeyPem);
    } catch {
      return { error: `MCP catalogue bundle key '${k.keyId}' is not a public key` };
    }
    if (key.asymmetricKeyType !== "ed25519") return { error: `MCP catalogue bundle key '${k.keyId}' is not Ed25519` };
    out.set(k.keyId, key);
  }
  return out;
}

// ---------------------------------------------------------------------------
// bundle verification (pure apart from the keyring it is handed)
// ---------------------------------------------------------------------------

export const importBundleBodySchema = z
  .object({
    /** the bundle as the exact text that was signed */
    bundle: z.string().min(1).max(MCP_CATALOGUE_BUNDLE_MAX_BYTES),
    /** base64 Ed25519 signature over the UTF-8 bytes of `bundle` */
    signature: z.string().min(1).max(256),
    keyId: z.string().min(1).max(128),
  })
  .strict();

export type BundleVerdict =
  | { ok: true; bundle: McpCatalogueBundle; digest: string; keyId: string }
  | { ok: false; code: "no_keyring" | "keyring_invalid" | "unknown_key" | "bad_signature" | "too_large" | "malformed"; detail: string };

/** Verify FIRST, parse second: nothing in an unverified bundle is read beyond its byte length. */
export function verifyBundle(body: z.infer<typeof importBundleBodySchema>, keyring: Map<string, KeyObject> | { error: string }): BundleVerdict {
  if (!(keyring instanceof Map)) return { ok: false, code: "keyring_invalid", detail: keyring.error };
  if (keyring.size === 0) {
    return {
      ok: false,
      code: "no_keyring",
      detail: `no MCP catalogue bundle key is configured (${MCP_CATALOGUE_BUNDLE_KEYS_ENV}); every bundle is refused until one is`,
    };
  }
  const bytes = Buffer.from(body.bundle, "utf8");
  if (bytes.length > MCP_CATALOGUE_BUNDLE_MAX_BYTES) return { ok: false, code: "too_large", detail: `the bundle exceeds ${MCP_CATALOGUE_BUNDLE_MAX_BYTES} bytes` };
  const key = keyring.get(body.keyId);
  if (!key) return { ok: false, code: "unknown_key", detail: `key '${body.keyId}' is not in the MCP catalogue bundle keyring` };
  let good = false;
  try {
    good = ed25519Verify(null, bytes, key, Buffer.from(body.signature, "base64"));
  } catch {
    good = false;
  }
  if (!good) return { ok: false, code: "bad_signature", detail: `the bundle does not verify under key '${body.keyId}'` };
  let json: unknown;
  try {
    json = JSON.parse(body.bundle) as unknown;
  } catch {
    return { ok: false, code: "malformed", detail: "the signed bundle is not JSON" };
  }
  const parsed = mcpCatalogueBundleSchema.safeParse(json);
  if (!parsed.success) return { ok: false, code: "malformed", detail: `the signed bundle is not a ${MCP_CATALOGUE_BUNDLE_FORMAT} document` };
  return { ok: true, bundle: parsed.data, digest: createHash("sha256").update(bytes).digest("hex"), keyId: body.keyId };
}

// ---------------------------------------------------------------------------
// bundle import
// ---------------------------------------------------------------------------

export interface BundleImportResult {
  registryId: string;
  registryName: string;
  snapshotId: string;
  entriesSeen: number;
  created: number;
  updated: number;
  skipped: number;
  markedMissing: number;
  conflicts: number;
  serversCreated: 0;
  grantsCreated: 0;
}

export type BundleImportOutcome =
  | { ok: true; result: BundleImportResult }
  | { ok: false; status: number; body: { error: string; code?: string; detail: string } };

async function auditBundleRefused(db: Db, actorUserId: string | null, code: string, detail: string, extra: Record<string, unknown> = {}) {
  await db.insert(auditLog).values({
    userId: actorUserId ?? NIL_USER,
    objectType: "mcp_server",
    objectId: null,
    detail: { phase: "catalogue-bundle-import", code, ...extra },
    effect: "deny",
    ruleId: mcpRegistryRuleIds.bundleRefused,
    ruleChain: [],
    reason: `MCP catalogue bundle refused: ${detail}`,
  });
}

/**
 * Import ONE verified bundle into its source. The source row is created on first import (`delivery =
 * 'offline_bundle'`, disabled: there is nothing to enable) and reused after; a PULL source of the same name is never
 * overwritten by a bundle (409). The whole import is one transaction: a bundle lands completely or not at all.
 */
export async function importCatalogueBundle(
  db: Db,
  body: z.infer<typeof importBundleBodySchema>,
  opts: { actorUserId: string | null; keyring?: Map<string, KeyObject> | { error: string } },
): Promise<BundleImportOutcome> {
  const verdict = verifyBundle(body, opts.keyring ?? loadBundleKeyring());
  if (!verdict.ok) {
    await auditBundleRefused(db, opts.actorUserId, verdict.code, verdict.detail, { keyId: body.keyId });
    const status = verdict.code === "no_keyring" || verdict.code === "keyring_invalid" ? 409 : 400;
    return { ok: false, status, body: { error: "bundle_refused", code: verdict.code, detail: verdict.detail } };
  }
  const { bundle, digest, keyId } = verdict;
  const createdAt = new Date(bundle.createdAt);

  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const [existing] = await t.select().from(mcpRegistries).where(eq(mcpRegistries.name, bundle.source.name)).for("update");
    if (existing && existing.delivery !== "offline_bundle") {
      const detail = `source '${bundle.source.name}' is a pulled source; a bundle never overwrites one`;
      await auditBundleRefused(t, opts.actorUserId, "source_is_pulled", detail, { keyId, digest });
      return { ok: false as const, status: 409, body: { error: "bundle_refused", code: "source_is_pulled", detail } };
    }
    if (existing && existing.listingKind !== bundle.source.listingKind) {
      const detail = `source '${bundle.source.name}' is a ${existing.listingKind} listing; the bundle says ${bundle.source.listingKind}`;
      await auditBundleRefused(t, opts.actorUserId, "listing_kind_changed", detail, { keyId, digest });
      return { ok: false as const, status: 409, body: { error: "bundle_refused", code: "listing_kind_changed", detail } };
    }
    if (existing) {
      const [last] = await t
        .select({ createdAt: mcpCatalogueSnapshots.bundleCreatedAt })
        .from(mcpCatalogueSnapshots)
        .where(and(eq(mcpCatalogueSnapshots.registryId, existing.id), isNotNull(mcpCatalogueSnapshots.bundleCreatedAt)))
        .orderBy(desc(mcpCatalogueSnapshots.bundleCreatedAt))
        .limit(1);
      if (last?.createdAt && createdAt.getTime() <= last.createdAt.getTime()) {
        const detail = `the bundle (created ${bundle.createdAt}) is not newer than the last one imported for '${bundle.source.name}' (${last.createdAt.toISOString()})`;
        await auditBundleRefused(t, opts.actorUserId, "stale_bundle", detail, { keyId, digest });
        return { ok: false as const, status: 409, body: { error: "bundle_refused", code: "stale_bundle", detail } };
      }
    }
    const registry =
      existing ??
      (
        await t
          .insert(mcpRegistries)
          .values({
            name: bundle.source.name,
            url: bundle.source.origin,
            enabled: false,
            listingKind: bundle.source.listingKind,
            delivery: "offline_bundle",
          })
          .returning()
      )[0]!;

    // one clock for the pass: the database's, so `last_synced_at` and the snapshot agree (M-075)
    const now = await dbNow(t);
    const usable = bundleEntriesUsable(bundle.entries);
    const counts = { created: 0, updated: 0, conflicts: 0 };
    const digests: string[] = [];
    for (const entry of usable.entries) {
      digests.push(registryEntryDigest({ registryId: registry.id, ...entry }));
      const p = await upsertEntry(t, registry.id, entry, now);
      if (p.created) counts.created += 1;
      else counts.updated += 1;
      if (p.conflict) counts.conflicts += 1;
    }
    const markedMissing = bundle.truncated ? 0 : await markMissing(t, registry.id, usable.entries.map((e) => e.upstreamName), now);
    const snapshotId = await recordCatalogueSnapshot(t, {
      registryId: registry.id,
      listingKind: bundle.source.listingKind,
      delivery: "offline_bundle",
      actorUserId: opts.actorUserId,
      entryCount: usable.entries.length,
      truncated: bundle.truncated,
      digests,
      now,
      bundle: { keyId, digest, createdAt },
    });
    await t
      .update(mcpRegistries)
      .set({
        lastSyncAt: now,
        lastSyncOutcome: "ok",
        lastSyncDetail: { at: now.toISOString(), outcome: "ok", via: "offline_bundle", keyId, digest, snapshotId, entriesSeen: usable.entries.length },
      })
      .where(eq(mcpRegistries.id, registry.id));
    const result: BundleImportResult = {
      registryId: registry.id,
      registryName: registry.name,
      snapshotId,
      entriesSeen: usable.entries.length,
      ...counts,
      skipped: usable.skipped,
      markedMissing,
      serversCreated: 0,
      grantsCreated: 0,
    };
    await t.insert(auditLog).values({
      userId: opts.actorUserId ?? NIL_USER,
      objectType: "mcp_server",
      objectId: registry.id,
      detail: {
        phase: "catalogue-bundle-import",
        source: bundle.source,
        bundleCreatedAt: bundle.createdAt,
        keyId,
        digest,
        ...result,
      },
      effect: "allow",
      ruleId: mcpRegistryRuleIds.bundleImported,
      ruleChain: [],
      reason:
        `Imported a signed MCP catalogue bundle for '${registry.name}' (key '${keyId}'): ${usable.entries.length} entr(ies), ` +
        `${usable.skipped} unusable row(s) dropped. Every entry is available, not admitted; this import created 0 servers and 0 grants.`,
    });
    return { ok: true as const, result };
  });
}

// ---------------------------------------------------------------------------
// bundle export (unsigned; signed offline)
// ---------------------------------------------------------------------------

export async function exportCatalogueBundle(db: Db, registryId: string, now: Date): Promise<string | null> {
  const [registry] = await db.select().from(mcpRegistries).where(eq(mcpRegistries.id, registryId));
  if (!registry) return null;
  const rows = await db
    .select()
    .from(mcpRegistryEntries)
    .where(eq(mcpRegistryEntries.registryId, registryId))
    .orderBy(asc(mcpRegistryEntries.upstreamName));
  const preset = Object.values(MCP_CATALOGUE_PRESETS).find((p) => p.url === registry.url);
  const bundle: McpCatalogueBundle = {
    format: MCP_CATALOGUE_BUNDLE_FORMAT,
    createdAt: now.toISOString(),
    source: {
      name: registry.name,
      listingKind: registry.listingKind,
      origin: registry.url,
      dataLicence: preset?.dataLicence ?? "unstated",
    },
    truncated: Boolean((registry.lastSyncDetail as { truncated?: boolean } | null)?.truncated),
    entries: rows
      .filter((r) => r.missingSince === null)
      .map((r) => ({
        upstreamName: r.upstreamName,
        upstreamVersion: r.upstreamVersion,
        title: r.title,
        description: r.description,
        repositoryUrl: r.repositoryUrl,
        websiteUrl: r.websiteUrl,
        kind: r.kind,
        remoteUrl: r.remoteUrl,
        remoteTransport: (r.remoteTransport as "streamable-http" | "sse" | null) ?? null,
        catalogueReason: (r.catalogueReason as McpCatalogueBundle["entries"][number]["catalogueReason"]) ?? null,
        upstreamStatus: r.upstreamStatus,
        publishedAt: r.upstreamPublishedAt?.toISOString() ?? null,
        updatedAt: r.upstreamUpdatedAt?.toISOString() ?? null,
        packageCount: 0,
        remoteCount: r.kind === "remote" ? 1 : 0,
        paidSignal: r.paidSignal,
      })),
  };
  return JSON.stringify(bundle);
}

// ---------------------------------------------------------------------------
// the deduped view
// ---------------------------------------------------------------------------

export type CatalogueAdmission = "available_not_admitted" | "imported_not_admitted" | "imported_admitted";

/** an imported server is admitted only once the admission scan (or an audited clear) says so */
export function admissionOf(serverAdmission: string | null | undefined): CatalogueAdmission {
  if (serverAdmission === undefined || serverAdmission === null) return "available_not_admitted";
  return serverAdmission === "clean" || serverAdmission === "cleared" ? "imported_admitted" : "imported_not_admitted";
}

const catalogueQuerySchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .strict();

export async function listCatalogue(db: Db, query: z.infer<typeof catalogueQuerySchema>) {
  const pattern = query.q ? likeLiteral(query.q) : null;
  const matching = pattern
    ? sql`${mcpCatalogueItems.id} in (select ${mcpRegistryEntries.catalogueItemId} from ${mcpRegistryEntries} where ${mcpRegistryEntries.upstreamName} ilike ${pattern} or coalesce(${mcpRegistryEntries.title}, '') ilike ${pattern})`
    : undefined;
  const items = await db
    .select({ id: mcpCatalogueItems.id, dedupeKey: mcpCatalogueItems.dedupeKey })
    .from(mcpCatalogueItems)
    .where(pattern ? sql`(${mcpCatalogueItems.dedupeKey} ilike ${pattern} or ${matching})` : undefined)
    .orderBy(asc(mcpCatalogueItems.dedupeKey))
    .limit(query.limit + 1)
    .offset(query.offset);
  const page = items.slice(0, query.limit);
  const ids = page.map((i) => i.id);
  const sources = ids.length
    ? await db
        .select({
          itemId: mcpRegistryEntries.catalogueItemId,
          entryId: mcpRegistryEntries.id,
          registryId: mcpRegistries.id,
          registryName: mcpRegistries.name,
          listingKind: mcpRegistries.listingKind,
          delivery: mcpRegistries.delivery,
          upstreamName: mcpRegistryEntries.upstreamName,
          upstreamVersion: mcpRegistryEntries.upstreamVersion,
          title: mcpRegistryEntries.title,
          kind: mcpRegistryEntries.kind,
          remoteUrl: mcpRegistryEntries.remoteUrl,
          catalogueReason: mcpRegistryEntries.catalogueReason,
          paidSignal: mcpRegistryEntries.paidSignal,
          firstSeenAt: mcpRegistryEntries.firstSeenAt,
          lastSyncedAt: mcpRegistryEntries.lastSyncedAt,
          lastSnapshotId: mcpRegistryEntries.lastSnapshotId,
          missingSince: mcpRegistryEntries.missingSince,
          serverId: mcpRegistryEntries.serverId,
          serverAdmission: mcpServers.admissionState,
        })
        .from(mcpRegistryEntries)
        .innerJoin(mcpRegistries, eq(mcpRegistries.id, mcpRegistryEntries.registryId))
        .leftJoin(mcpServers, eq(mcpServers.id, mcpRegistryEntries.serverId))
        .where(inArray(mcpRegistryEntries.catalogueItemId, ids))
        .orderBy(asc(mcpRegistries.name))
    : [];
  return {
    items: page.map((item) => {
      const mine = sources.filter((s) => s.itemId === item.id);
      const admissions = mine.map((s) => admissionOf(s.serverId ? s.serverAdmission : null));
      return {
        id: item.id,
        dedupeKey: item.dedupeKey,
        // listed by the registry anywhere = registry_listed; only community sources = unvetted
        vetting: mine.some((s) => s.listingKind === "registry") ? "registry_listed" : "unvetted",
        paid: mine.find((s) => s.paidSignal === "x402")?.paidSignal ?? mine.find((s) => s.paidSignal)?.paidSignal ?? null,
        admission: admissions.includes("imported_admitted")
          ? "imported_admitted"
          : admissions.includes("imported_not_admitted")
            ? "imported_not_admitted"
            : "available_not_admitted",
        sources: mine.map(({ itemId: _i, serverAdmission, ...s }) => ({
          ...s,
          vetting: vettingFor(s.listingKind),
          admission: admissionOf(s.serverId ? serverAdmission : null),
        })),
      };
    }),
    limit: query.limit,
    offset: query.offset,
    hasMore: items.length > query.limit,
  };
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

const presetParam = z.object({ preset: z.enum(MCP_CATALOGUE_PRESET_IDS as [McpCataloguePreset, ...McpCataloguePreset[]]) });
const bundleQuery = z.object({ registryId: z.string().uuid() }).strict();

export function registerMcpCatalogueRoutes(app: FastifyInstance, db: Db, deps: McpRegistryDeps = {}) {
  app.post("/v1/mcp-catalogue/presets/:preset", async (req, reply) => {
    const { preset } = presetParam.parse(req.params);
    const p = MCP_CATALOGUE_PRESETS[preset];
    const [taken] = await db.select({ id: mcpRegistries.id }).from(mcpRegistries).where(eq(mcpRegistries.name, p.name));
    if (taken) return reply.status(409).send({ error: "conflict", detail: `a source named '${p.name}' already exists`, registryId: taken.id });
    // the same write-time egress check as any registry: the host must already be allow-listed (default-deny holds)
    const refusal = await refuseRegistryWrite(db, {
      url: p.url,
      allowPrivateRanges: null,
      userId: req.authCtx.userId ?? null,
      label: `MCP catalogue preset '${preset}' url`,
      deps,
    });
    if (refusal) return reply.status(400).send(refusal);
    const [row] = await db
      .insert(mcpRegistries)
      .values({ name: p.name, url: p.url, enabled: false, allowPrivateRanges: null, listingKind: p.listingKind })
      .returning();
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? NIL_USER,
      objectType: "mcp_server",
      objectId: row!.id,
      detail: { phase: "catalogue-seed", preset, name: p.name, url: p.url, listingKind: p.listingKind, dataLicence: p.dataLicence, enabled: false },
      effect: "allow",
      ruleId: mcpRegistryRuleIds.seeded,
      ruleChain: [],
      reason:
        `Seeded MCP catalogue source '${p.name}' (${p.listingKind}, data licence ${p.dataLicence}), disabled. ` +
        `Seeding fetches nothing and imports nothing; enabling it is a stepped-up change and every entry stays available, not admitted.`,
    });
    return reply.status(201).send(row);
  });

  app.post("/v1/mcp-catalogue/bundles", { bodyLimit: MCP_CATALOGUE_BUNDLE_MAX_BYTES + 64 * 1024 }, async (req, reply) => {
    const body = importBundleBodySchema.parse(req.body);
    const out = await importCatalogueBundle(db, body, { actorUserId: req.authCtx.userId ?? null });
    if (!out.ok) return reply.status(out.status).send(out.body);
    return reply.status(201).send(out.result);
  });

  app.get("/v1/mcp-catalogue/bundle", async (req, reply) => {
    const { registryId } = bundleQuery.parse(req.query);
    const text = await exportCatalogueBundle(db, registryId, await dbNow(db));
    if (text === null) return reply.status(404).send({ error: "unknown_registry" });
    return reply.header("content-type", "application/json; charset=utf-8").send(text);
  });

  app.get("/v1/mcp-catalogue", async (req) => listCatalogue(db, catalogueQuerySchema.parse(req.query)));
}
