/**
 * ADR-0176 security fix 1 — the ONE-TIME RE-PIN of stored MCP manifest digests
 * from FNV-1a 64 to SHA-256 (migration 0145 explains why this is not SQL).
 *
 * The admission clearance (`mcp_servers.admission_manifest_digest` while
 * `cleared`) and the release-age cooldown (`mcp_servers.release_digest`,
 * `release_sightings`, `release_overrides`) are all keyed on the manifest
 * digest. Changing the algorithm without this pass would make every stored
 * digest look like a CHANGED manifest on the next sync: every cleared server
 * that still scans dirty would be re-held, and every cooldown clock would
 * restart. This pass moves each stored digest to the new algorithm, but ONLY
 * when the stored manifest (`mcp_tools`) provably is the manifest the digest
 * was computed over: its legacy FNV digest must equal the stored one. A row
 * that cannot be proven keeps its FNV digest and fails closed on its next
 * sync (re-adjudicated from scratch; cooldown from that sync).
 *
 * FAILURE IS FATAL TO BOOT (`boot.ts`), by design. If this pass did not run
 * and the gateway listened anyway, the first syncs would compare SHA-256
 * digests with un-pinned FNV ones and re-hold servers, wiping clearances; the
 * next boot would then find nothing left to re-pin. One bad ROW never aborts
 * the pass: a row whose digest cannot be computed is recorded as unverified
 * (fail closed for that row only). What can still abort it is the database
 * itself, and a database the gateway cannot write is no reason to serve.
 *
 * MIXED VERSIONS. Each row's UPDATE is a compare-and-set on the values this
 * pass read, so a concurrent writer (an old replica still syncing during a
 * rolling deploy) is never overwritten: its row is recorded as unverified.
 * The supported upgrade is still: stop old replicas before the first new one
 * boots (migration 0145, the boot log).
 *
 * Idempotent twice over: the `data_backfills` marker stops it re-running, and
 * per row only a 16-hex (FNV) digest is ever touched. Concurrent boots
 * serialise on a transaction-scoped advisory lock and the second one sees the
 * marker.
 */
import {
  and,
  auditLog,
  dataBackfills,
  eq,
  inArray,
  isNotNull,
  isNull,
  mcpServers,
  mcpTools,
  NIL_SIGHTING_SUBJECT,
  or,
  releaseOverrides,
  releaseSightings,
  sql,
  type Db,
} from "@regulait/db";
import {
  isLegacyManifestDigest,
  legacyManifestDigestFnv1a64,
  manifestDigest,
  type ScannableTool,
} from "@regulait/shared";

export const MANIFEST_DIGEST_REPIN = "mcp-manifest-digest-sha256";
/** the audit row filed for every CLEARED server whose clearance was carried */
export const MANIFEST_DIGEST_REPIN_RULE_ID = "mcp-manifest-digest-repinned";

const NIL_USER = "00000000-0000-0000-0000-000000000000";

export type RepinUnverifiedReason = "manifest_mismatch" | "digest_error" | "changed_concurrently";

export interface ManifestDigestRepinResult {
  status: "repinned" | "already_done";
  /** servers whose FNV digest(s) moved to SHA-256 */
  repinned: string[];
  /** servers left on an FNV digest; they fail closed on their next sync */
  unverified: string[];
  /** why each unverified server was left */
  unverifiedReasons: Record<string, RepinUnverifiedReason>;
  /** CLEARED servers whose clearance was carried: re-review candidates */
  clearedRepinned: Array<{ id: string; name: string }>;
  /** release_sightings rows written for the SHA-256 digests */
  sightings: number;
  /** release_overrides rows copied to the SHA-256 digests */
  overrides: number;
}

/** Thrown by boot when the re-pin cannot complete; the gateway does not listen. */
export class ManifestDigestRepinBootError extends Error {
  constructor(cause: unknown) {
    super(
      `MCP manifest digest re-pin (ADR-0176, migration 0145) failed, so the gateway is NOT starting: ` +
        `serving now would compare new SHA-256 manifest digests with un-pinned FNV ones and re-hold every ` +
        `cleared MCP server. Nothing was changed (the pass is one transaction). Fix the cause and restart; ` +
        `the re-pin runs again on the next boot. Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "ManifestDigestRepinBootError";
  }
}

export interface RepinOptions {
  /** TEST SEAM ONLY: runs after a server row is read and before its
   * compare-and-set, so a test can commit a concurrent change in between */
  afterRead?: (serverId: string) => Promise<void>;
}

export async function repinManifestDigests(db: Db, opts: RepinOptions = {}): Promise<ManifestDigestRepinResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`regulait:${MANIFEST_DIGEST_REPIN}`}))`);
    const [done] = await tx.select({ name: dataBackfills.name }).from(dataBackfills).where(eq(dataBackfills.name, MANIFEST_DIGEST_REPIN));
    if (done) {
      return { status: "already_done", repinned: [], unverified: [], unverifiedReasons: {}, clearedRepinned: [], sightings: 0, overrides: 0 };
    }

    const servers = await tx
      .select({
        id: mcpServers.id,
        name: mcpServers.name,
        admissionState: mcpServers.admissionState,
        admissionManifestDigest: mcpServers.admissionManifestDigest,
        releaseDigest: mcpServers.releaseDigest,
      })
      .from(mcpServers)
      .where(or(isNotNull(mcpServers.admissionManifestDigest), isNotNull(mcpServers.releaseDigest)));

    const repinned: string[] = [];
    const unverifiedReasons: Record<string, RepinUnverifiedReason> = {};
    const clearedRepinned: Array<{ id: string; name: string }> = [];
    /** FNV digest -> SHA-256 digest, for every PROVEN mapping */
    const mapping = new Map<string, string>();
    let overrides = 0;

    for (const s of servers) {
      const legacyAdmission = isLegacyManifestDigest(s.admissionManifestDigest) ? s.admissionManifestDigest : null;
      const legacyRelease = isLegacyManifestDigest(s.releaseDigest) ? s.releaseDigest : null;
      if (!legacyAdmission && !legacyRelease) continue;

      const rows = await tx
        .select({ name: mcpTools.name, description: mcpTools.description, inputSchema: mcpTools.inputSchema })
        .from(mcpTools)
        .where(eq(mcpTools.serverId, s.id));
      const stored: ScannableTool[] = rows.map((r) => ({
        name: r.name,
        description: r.description ?? undefined,
        inputSchema: r.inputSchema ?? undefined,
      }));
      // one row whose digest cannot be computed is that row's problem, never
      // the whole pass's: it stays on FNV and fails closed on its next sync
      let fnv: string;
      let sha: string;
      try {
        fnv = legacyManifestDigestFnv1a64(stored);
        sha = manifestDigest(stored);
      } catch {
        unverifiedReasons[s.id] = "digest_error";
        continue;
      }

      const patch: { admissionManifestDigest?: string; releaseDigest?: string } = {};
      if (legacyAdmission === fnv) patch.admissionManifestDigest = sha;
      if (legacyRelease === fnv) patch.releaseDigest = sha;
      const provedAll =
        (legacyAdmission === null || legacyAdmission === fnv) && (legacyRelease === null || legacyRelease === fnv);
      if (!provedAll) unverifiedReasons[s.id] = "manifest_mismatch";
      if (Object.keys(patch).length === 0) continue;

      if (opts.afterRead) await opts.afterRead(s.id);

      // COMPARE-AND-SET on exactly what was read: a writer that changed either
      // digest since (an old replica's sync) wins, and this row is left alone
      const updated = await tx
        .update(mcpServers)
        .set(patch)
        .where(
          and(
            eq(mcpServers.id, s.id),
            s.admissionManifestDigest === null
              ? isNull(mcpServers.admissionManifestDigest)
              : eq(mcpServers.admissionManifestDigest, s.admissionManifestDigest),
            s.releaseDigest === null ? isNull(mcpServers.releaseDigest) : eq(mcpServers.releaseDigest, s.releaseDigest),
          ),
        )
        .returning({ id: mcpServers.id, admissionState: mcpServers.admissionState });
      if (updated.length === 0) {
        unverifiedReasons[s.id] = "changed_concurrently";
        continue;
      }
      mapping.set(fnv, sha);
      repinned.push(s.id);

      // INFO for review: a cleared server's clearance was carried to the new
      // digest. Listed and audited, because a collision exploited BEFORE the
      // upgrade is indistinguishable from the real manifest now.
      if (patch.admissionManifestDigest && updated[0]!.admissionState === "cleared") {
        clearedRepinned.push({ id: s.id, name: s.name });
        await tx.insert(auditLog).values({
          userId: NIL_USER,
          serverId: s.id,
          objectType: "mcp_server",
          objectId: s.id,
          detail: { phase: "digest-repin", previousDigest: fnv, digest: sha, admissionState: "cleared", algorithm: "sha256" },
          effect: "allow",
          ruleId: MANIFEST_DIGEST_REPIN_RULE_ID,
          ruleChain: [],
          reason:
            `The admin clearance of MCP server '${s.name}' was carried from its FNV-1a 64 manifest digest to SHA-256 ` +
            `by the one-time re-pin (ADR-0176): the stored manifest reproduces the digest the clearance was granted ` +
            `for. A manifest swapped in through an FNV collision BEFORE this upgrade cannot be detected after the ` +
            `fact, so review this server's stored manifest and re-clear it if in doubt.`,
        });
      }

      // an admin's cooldown override at this exact release follows it
      const ov = await tx
        .select()
        .from(releaseOverrides)
        .where(and(eq(releaseOverrides.kind, "mcp_server"), eq(releaseOverrides.subjectId, s.id), eq(releaseOverrides.digest, fnv)));
      for (const o of ov) {
        const inserted = await tx
          .insert(releaseOverrides)
          .values({
            kind: o.kind,
            subjectId: o.subjectId,
            digest: sha,
            overriddenBy: o.overriddenBy,
            reason: o.reason,
            createdAt: o.createdAt,
          })
          .onConflictDoNothing()
          .returning({ id: releaseOverrides.id });
        overrides += inserted.length;
      }
    }

    // the cooldown clock: a manifest's first sighting carries over to its new
    // digest, so a server that was past the cooldown stays past it
    let sightings = 0;
    if (mapping.size > 0) {
      const old = await tx
        .select({ digest: releaseSightings.digest, firstSeenAt: releaseSightings.firstSeenAt })
        .from(releaseSightings)
        .where(
          and(
            eq(releaseSightings.kind, "mcp_manifest"),
            eq(releaseSightings.subjectId, NIL_SIGHTING_SUBJECT),
            inArray(releaseSightings.digest, [...mapping.keys()]),
          ),
        );
      for (const row of old) {
        await tx
          .insert(releaseSightings)
          .values({ kind: "mcp_manifest", subjectId: NIL_SIGHTING_SUBJECT, digest: mapping.get(row.digest)!, firstSeenAt: row.firstSeenAt })
          .onConflictDoUpdate({
            target: [releaseSightings.kind, releaseSightings.subjectId, releaseSightings.digest],
            set: { firstSeenAt: sql`LEAST(${releaseSightings.firstSeenAt}, excluded.first_seen_at)` },
          });
        sightings += 1;
      }
    }

    const unverified = Object.keys(unverifiedReasons);
    await tx.insert(dataBackfills).values({
      name: MANIFEST_DIGEST_REPIN,
      detail: {
        algorithm: "sha256",
        repinned,
        unverified,
        unverifiedReasons,
        clearedRepinned,
        clearedRepinnedNote:
          "clearances carried to SHA-256; a collision exploited before the upgrade cannot be detected — re-review these servers",
        sightings,
        overrides,
      },
    });
    return { status: "repinned", repinned, unverified, unverifiedReasons, clearedRepinned, sightings, overrides };
  });
}
