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
 * Idempotent twice over: the `data_backfills` marker stops it re-running, and
 * per row only a 16-hex (FNV) digest is ever touched. Concurrent boots
 * serialise on a transaction-scoped advisory lock and the second one sees the
 * marker.
 */
import {
  and,
  dataBackfills,
  eq,
  inArray,
  isNotNull,
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

export interface ManifestDigestRepinResult {
  status: "repinned" | "already_done";
  /** servers whose FNV digest(s) moved to SHA-256 */
  repinned: string[];
  /** servers with an FNV digest the stored manifest does not reproduce */
  unverified: string[];
  /** release_sightings rows written for the SHA-256 digests */
  sightings: number;
  /** release_overrides rows copied to the SHA-256 digests */
  overrides: number;
}

export async function repinManifestDigests(db: Db): Promise<ManifestDigestRepinResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`regulait:${MANIFEST_DIGEST_REPIN}`}))`);
    const [done] = await tx.select({ name: dataBackfills.name }).from(dataBackfills).where(eq(dataBackfills.name, MANIFEST_DIGEST_REPIN));
    if (done) return { status: "already_done", repinned: [], unverified: [], sightings: 0, overrides: 0 };

    const servers = await tx
      .select({
        id: mcpServers.id,
        admissionManifestDigest: mcpServers.admissionManifestDigest,
        releaseDigest: mcpServers.releaseDigest,
      })
      .from(mcpServers)
      .where(or(isNotNull(mcpServers.admissionManifestDigest), isNotNull(mcpServers.releaseDigest)));

    const repinned: string[] = [];
    const unverified: string[] = [];
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
      const fnv = legacyManifestDigestFnv1a64(stored);
      const sha = manifestDigest(stored);

      const patch: { admissionManifestDigest?: string; releaseDigest?: string } = {};
      if (legacyAdmission === fnv) patch.admissionManifestDigest = sha;
      if (legacyRelease === fnv) patch.releaseDigest = sha;
      const provedAll =
        (legacyAdmission === null || legacyAdmission === fnv) && (legacyRelease === null || legacyRelease === fnv);
      if (!provedAll) unverified.push(s.id);
      if (Object.keys(patch).length === 0) continue;

      await tx.update(mcpServers).set(patch).where(eq(mcpServers.id, s.id));
      mapping.set(fnv, sha);
      repinned.push(s.id);

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

    await tx.insert(dataBackfills).values({
      name: MANIFEST_DIGEST_REPIN,
      detail: { algorithm: "sha256", repinned, unverified, sightings, overrides },
    });
    return { status: "repinned", repinned, unverified, sightings, overrides };
  });
}
