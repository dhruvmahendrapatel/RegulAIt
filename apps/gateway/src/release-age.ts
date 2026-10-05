/**
 * ADR-0175 A5 — RELEASE-AGE COOLDOWN: the stored half.
 *
 * `packages/shared/src/release-age.ts` owns the pure status. This module owns
 * the two tables and the admin surface:
 *
 *   - `release_sightings` — when THIS deployment first saw an exact digest
 *     (first writer wins). Age is always measured from here.
 *   - `release_overrides` — an admin's per-item override (one subject at one
 *     digest), reason required, audited.
 *
 * The cooldown itself is enforced where each kind of item is used: the MCP
 * connect gate and tool discovery (mcp-admission.ts), and skill attach and run
 * time (skill-admission.ts). With `org_settings.min_release_age_days = 0` (the
 * default) nothing here is consulted and nothing is written.
 */
import type { FastifyInstance } from "fastify";
import {
  and,
  auditLog,
  builderSkills,
  eq,
  isNull,
  mcpServers,
  NIL_SIGHTING_SUBJECT,
  releaseOverrides,
  releaseSightings,
  sql,
  type Db,
} from "@regulait/db";
import {
  RELEASE_AGE_RECOMMENDED_DAYS,
  releaseAgeStatus,
  releaseOverrideSchema,
  type ReleaseAgeKind,
  type ReleaseAgeStatus,
} from "@regulait/shared";
import { loadOrgSettings } from "./org-settings.js";

const NIL_USER = "00000000-0000-0000-0000-000000000000";

export type SightingKind = "skill" | "mcp_manifest" | "registry_entry";

/** the override digest a never-synced MCP server is quarantined under */
export const REGISTRATION_RELEASE = "registration";

export async function minReleaseAgeDays(db: Db): Promise<number> {
  return (await loadOrgSettings(db)).minReleaseAgeDays;
}

/**
 * Record that we have seen `digest` (first writer wins) and return when it was
 * FIRST seen. `at` backdates nothing: it only ever applies to a new row.
 * `subjectId` keys a skill's sightings by the skill (one skill's history never
 * ages another); manifests and registry entries use the nil subject.
 */
export async function recordSighting(
  db: Db,
  kind: SightingKind,
  digest: string,
  at: Date = new Date(),
  subjectId: string = NIL_SIGHTING_SUBJECT,
): Promise<Date> {
  await db.insert(releaseSightings).values({ kind, subjectId, digest, firstSeenAt: at }).onConflictDoNothing();
  return (await firstSighting(db, kind, digest, subjectId)) ?? at;
}

/** when `digest` was first seen (for `subjectId`); null if never */
export async function firstSighting(
  db: Db,
  kind: SightingKind,
  digest: string,
  subjectId: string = NIL_SIGHTING_SUBJECT,
): Promise<Date | null> {
  const [row] = await db
    .select({ firstSeenAt: releaseSightings.firstSeenAt })
    .from(releaseSightings)
    .where(and(eq(releaseSightings.kind, kind), eq(releaseSightings.subjectId, subjectId), eq(releaseSightings.digest, digest)));
  return row?.firstSeenAt ?? null;
}

export async function hasReleaseOverride(db: Db, kind: ReleaseAgeKind, subjectId: string, digest: string): Promise<boolean> {
  const [row] = await db
    .select({ id: releaseOverrides.id })
    .from(releaseOverrides)
    .where(and(eq(releaseOverrides.kind, kind), eq(releaseOverrides.subjectId, subjectId), eq(releaseOverrides.digest, digest)));
  return !!row;
}

/** a server's first manifest IS the release that was registered: an override
 * granted for the registration carries over to that manifest's digest */
export async function carryRegistrationOverride(db: Db, serverId: string, digest: string): Promise<void> {
  const [reg] = await db
    .select()
    .from(releaseOverrides)
    .where(
      and(
        eq(releaseOverrides.kind, "mcp_server"),
        eq(releaseOverrides.subjectId, serverId),
        eq(releaseOverrides.digest, REGISTRATION_RELEASE),
      ),
    );
  if (!reg) return;
  await db
    .insert(releaseOverrides)
    .values({ kind: "mcp_server", subjectId: serverId, digest, overriddenBy: reg.overriddenBy, reason: reg.reason })
    .onConflictDoNothing();
}

/** a skill version's cooldown status (this skill's first sighting of that
 * exact digest — never another skill's) */
export async function skillReleaseStatus(
  db: Db,
  skillId: string,
  digest: string,
  minDays: number,
  now: Date = new Date(),
): Promise<ReleaseAgeStatus> {
  if (minDays <= 0) return releaseAgeStatus({ minDays, firstSeenAt: now, now, overridden: false });
  const [seen, overridden] = await Promise.all([
    // a digest nobody recorded (written straight into the table) is new now
    firstSighting(db, "skill", digest, skillId).then((d) => d ?? recordSighting(db, "skill", digest, now, skillId)),
    hasReleaseOverride(db, "skill", skillId, digest),
  ]);
  return releaseAgeStatus({ minDays, firstSeenAt: seen, now, overridden });
}

/** an MCP server's cooldown status, from the release recorded on its row */
export async function serverReleaseStatus(
  db: Db,
  row: { id: string; releaseDigest: string | null; releaseSeenAt: Date },
  minDays: number,
  now: Date = new Date(),
): Promise<ReleaseAgeStatus> {
  if (minDays <= 0) return releaseAgeStatus({ minDays, firstSeenAt: row.releaseSeenAt, now, overridden: false });
  const overridden = await hasReleaseOverride(db, "mcp_server", row.id, row.releaseDigest ?? REGISTRATION_RELEASE);
  return releaseAgeStatus({ minDays, firstSeenAt: row.releaseSeenAt, now, overridden });
}

/** a short, human reason for a quarantine refusal */
export function quarantineDetail(what: string, minDays: number, status: ReleaseAgeStatus): string {
  return (
    `${what} is in release-age quarantine: this deployment first saw this exact release ${status.ageDays} day(s) ago, ` +
    `and the organisation waits ${minDays} day(s) before using anything new (min_release_age_days). ` +
    `It is usable from ${status.readyAt ?? "now"}, or sooner if an admin overrides the cooldown for it with a reason.`
  );
}

// ---------------------------------------------------------------------------
// The admin surface (admin-only via the default gate)
// ---------------------------------------------------------------------------

export function registerReleaseAgeRoutes(app: FastifyInstance, db: Db) {
  /**
   * Everything the cooldown is holding right now, with when each leaves
   * quarantine. Empty lists (and `enabled: false`) while the setting is 0.
   */
  app.get("/v1/release-quarantine", async () => {
    const minDays = await minReleaseAgeDays(db);
    const now = new Date();
    const base = {
      enabled: minDays > 0,
      minReleaseAgeDays: minDays,
      recommendedDays: RELEASE_AGE_RECOMMENDED_DAYS,
    };
    if (minDays <= 0) return { ...base, servers: [], skills: [] };
    const cutoff = new Date(now.getTime() - minDays * 86_400_000);
    const serverRows = await db
      .select({
        id: mcpServers.id,
        name: mcpServers.name,
        origin: mcpServers.origin,
        releaseDigest: mcpServers.releaseDigest,
        releaseSeenAt: mcpServers.releaseSeenAt,
        admissionState: mcpServers.admissionState,
      })
      .from(mcpServers)
      .where(sql`${mcpServers.releaseSeenAt} > ${cutoff}`);
    const servers = [];
    for (const r of serverRows) {
      const status = await serverReleaseStatus(db, r, minDays, now);
      if (!status.quarantined) continue;
      servers.push({
        id: r.id,
        name: r.name,
        origin: r.origin,
        release: r.releaseDigest ?? REGISTRATION_RELEASE,
        firstSeenAt: r.releaseSeenAt.toISOString(),
        admissionState: r.admissionState,
        ...status,
      });
    }
    const skillRows = await db
      .select({
        id: builderSkills.id,
        name: builderSkills.name,
        version: builderSkills.version,
        contentDigest: builderSkills.contentDigest,
        admissionState: builderSkills.admissionState,
        firstSeenAt: releaseSightings.firstSeenAt,
      })
      .from(builderSkills)
      .innerJoin(
        releaseSightings,
        and(
          eq(releaseSightings.kind, "skill"),
          eq(releaseSightings.subjectId, builderSkills.id),
          eq(releaseSightings.digest, builderSkills.contentDigest),
        ),
      )
      .where(and(isNull(builderSkills.archivedAt), sql`${releaseSightings.firstSeenAt} > ${cutoff}`));
    const skills = [];
    for (const r of skillRows) {
      const status = await skillReleaseStatus(db, r.id, r.contentDigest, minDays, now);
      if (!status.quarantined) continue;
      skills.push({
        id: r.id,
        name: r.name,
        version: r.version,
        digest: r.contentDigest,
        firstSeenAt: r.firstSeenAt.toISOString(),
        admissionState: r.admissionState,
        ...status,
      });
    }
    return { ...base, servers, skills };
  });

  /**
   * THE OVERRIDE. One item, at the release the admin was SHOWN (`digest` in
   * the body), reason required, audited. If the item has moved to another
   * release since, nothing is written: 409 `release_changed`. A later change
   * of that item is a new release with its own clock.
   */
  app.post("/v1/release-quarantine/override", async (req, reply) => {
    const body = releaseOverrideSchema.parse(req.body ?? {});
    let digest: string;
    let label: string;
    if (body.kind === "mcp_server") {
      const [row] = await db
        .select({ id: mcpServers.id, name: mcpServers.name, releaseDigest: mcpServers.releaseDigest })
        .from(mcpServers)
        .where(eq(mcpServers.id, body.id));
      if (!row) return reply.status(404).send({ error: "unknown_server" });
      digest = row.releaseDigest ?? REGISTRATION_RELEASE;
      label = `MCP server '${row.name}'`;
    } else {
      const [row] = await db
        .select({ id: builderSkills.id, name: builderSkills.name, contentDigest: builderSkills.contentDigest, version: builderSkills.version })
        .from(builderSkills)
        .where(eq(builderSkills.id, body.id));
      if (!row) return reply.status(404).send({ error: "unknown_skill" });
      digest = row.contentDigest;
      label = `skill '${row.name}' v${row.version}`;
    }
    const changed = () =>
      reply.status(409).send({
        error: "release_changed",
        detail:
          `${label} is no longer on the release you reviewed (${body.digest.slice(0, 16)}); it is now on ` +
          `${digest.slice(0, 16)}. Reload the queue and review the current release.`,
      });
    if (digest !== body.digest) return changed();
    // conditional on the item still being on that release when the row is
    // written: the subject row is locked, re-checked, then the override goes in
    const created = await db.transaction(async (tx) => {
      const still =
        body.kind === "mcp_server"
          ? await tx
              .select({ id: mcpServers.id })
              .from(mcpServers)
              .where(and(eq(mcpServers.id, body.id), sql`coalesce(${mcpServers.releaseDigest}, ${REGISTRATION_RELEASE}) = ${body.digest}`))
              .for("update")
          : await tx
              .select({ id: builderSkills.id })
              .from(builderSkills)
              .where(and(eq(builderSkills.id, body.id), eq(builderSkills.contentDigest, body.digest)))
              .for("update");
      if (still.length === 0) return "changed" as const;
      const [row] = await tx
        .insert(releaseOverrides)
        .values({ kind: body.kind, subjectId: body.id, digest: body.digest, overriddenBy: req.authCtx.userId ?? null, reason: body.reason })
        .onConflictDoNothing()
        .returning();
      return row ?? ("exists" as const);
    });
    if (created === "changed") return changed();
    if (created === "exists") {
      return reply.status(409).send({ error: "already_overridden", detail: `${label} is already overridden at this release` });
    }
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? NIL_USER,
      objectType: body.kind === "mcp_server" ? "mcp_server" : "builder_skill",
      objectId: body.id,
      ...(body.kind === "mcp_server" ? { serverId: body.id } : {}),
      detail: { phase: "release-age-override", kind: body.kind, digest, reason: body.reason, via: req.authCtx.via },
      effect: "allow",
      ruleId: "release-age-overridden",
      ruleChain: [],
      reason:
        `release-age cooldown overridden for ${label} at release ${digest.slice(0, 16)} — reason: ${body.reason}. ` +
        `A later change is a new release with its own clock.`,
    });
    return reply.status(201).send({ override: { kind: body.kind, id: body.id, digest, reason: body.reason } });
  });
}
