/**
 * ADR-0208 (G7): the read-only facts about compliance profiles that other modules need — who carries a tag, which tags
 * are retired, each profile's active version and pending review. A LEAF module (only @regulait/db), so projects.ts and
 * infra.ts can import it without closing an import cycle through config-versions.ts (preflight-import-cycles).
 */
import { and, approvals, complianceProfiles, configVersions, eq, inArray, sql, type Db } from "@regulait/db";

/** `approvals.stage_id` of a version review: the prefix, then the draft's config_versions id */
export const COMPLIANCE_VERSION_PREFIX = "compliance-profile-version:";


/** who carries a tag today, by name; capped per kind so one response stays bounded */
export interface ProfileCarriers {
  projects: string[];
  pendingProjects: string[];
  teams: string[];
  resources: string[];
}
const CARRIER_NAMES_MAX = 200;

export const emptyCarriers = (): ProfileCarriers => ({ projects: [], pendingProjects: [], teams: [], resources: [] });

/**
 * Every carrier of each tag in `tags`, in four grouped queries (never one per profile). A pending project is a project
 * whose proposed reclassification (awaiting review) includes the tag.
 */
export async function carriersForTags(db: Pick<Db, "execute">, tags: string[]): Promise<Map<string, ProfileCarriers>> {
  const out = new Map<string, ProfileCarriers>(tags.map((t) => [t, emptyCarriers()]));
  if (tags.length === 0) return out;
  const list = sql.join(
    tags.map((t) => sql`${t}`),
    sql`, `,
  );
  // the table, column and filter names are constants of this function, never caller input
  const grouped = (table: string, column: string, onlyActive: boolean) =>
    sql`SELECT tg.tag AS tag, (array_agg(x.name ORDER BY x.name))[1:${CARRIER_NAMES_MAX}] AS names
          FROM ${sql.raw(`"${table}"`)} x, jsonb_array_elements_text(COALESCE(x.${sql.raw(`"${column}"`)}, '[]'::jsonb)) AS tg(tag)
         WHERE jsonb_typeof(COALESCE(x.${sql.raw(`"${column}"`)}, '[]'::jsonb)) = 'array' AND tg.tag IN (${list})
           ${onlyActive ? sql`AND x.status = 'active'` : sql``}
         GROUP BY tg.tag`;
  // a retired infra resource (ADR-0208 G8) is no longer monitored, so it no longer carries a tag
  const kinds: Array<[keyof ProfileCarriers, string, string, boolean]> = [
    ["projects", "projects", "classifications", false],
    ["pendingProjects", "projects", "pending_classifications", false],
    ["teams", "teams", "default_classifications", false],
    ["resources", "infra_resources", "classifications", true],
  ];
  const results = await Promise.all(kinds.map(([, table, column, onlyActive]) => db.execute(grouped(table, column, onlyActive))));
  kinds.forEach(([kind], i) => {
    for (const row of results[i]!.rows as Array<{ tag: string; names: string[] | null }>) {
      out.get(row.tag)![kind] = row.names ?? [];
    }
  });
  return out;
}

export const carrierCount = (c: ProfileCarriers) => c.projects.length + c.pendingProjects.length + c.teams.length + c.resources.length;

/**
 * The retired tags among `tags`. A writer that puts tags on a project, team or resource refuses these
 * (`compliance_profile_retired`): a retired profile takes no new carrier. (A carrier that slipped in anyway is still
 * governed by the retired profile's floors — `profilesForTags` resolves retired profiles too — so the race fails closed.)
 */
export async function retiredTagsAmong(db: Pick<Db, "select">, tags: readonly string[]): Promise<string[]> {
  if (tags.length === 0) return [];
  const rows = await db
    .select({ tag: complianceProfiles.tag })
    .from(complianceProfiles)
    .where(and(inArray(complianceProfiles.tag, [...tags]), eq(complianceProfiles.status, "retired")));
  return rows.map((r) => r.tag).sort();
}

/** the refusal body for a write that names a retired tag */
export const retiredTagRefusal = (tags: string[]) => ({
  error: "compliance_profile_retired",
  detail: `compliance profile(s) ${tags.map((t) => `'${t}'`).join(", ")} are retired and take no new project, team or resource`,
  tags,
});

/** active version number of each profile (1 when it has never been versioned), and its pending review if any */
export async function profileVersionFacts(
  db: Pick<Db, "select">,
  profileIds: string[],
): Promise<Map<string, { version: number; pendingReview: { approvalId: string; version: number; reviewerUserId: string } | null }>> {
  const out = new Map(profileIds.map((id) => [id, { version: 1, pendingReview: null as null | { approvalId: string; version: number; reviewerUserId: string } }]));
  if (profileIds.length === 0) return out;
  const versions = await db
    .select({ id: configVersions.id, artifactId: configVersions.artifactId, version: configVersions.version, status: configVersions.status })
    .from(configVersions)
    .where(and(eq(configVersions.artifactType, "compliance_profile"), inArray(configVersions.artifactId, profileIds)));
  const drafts = new Map<string, { artifactId: string; version: number }>();
  for (const v of versions) {
    if (v.status === "active") out.get(v.artifactId)!.version = v.version;
    if (v.status === "draft") drafts.set(`${COMPLIANCE_VERSION_PREFIX}${v.id}`, { artifactId: v.artifactId, version: v.version });
  }
  if (drafts.size > 0) {
    const pending = await db
      .select({ id: approvals.id, stageId: approvals.stageId, approverUserId: approvals.approverUserId })
      .from(approvals)
      .where(
        and(
          eq(approvals.objectType, "compliance_profile"),
          eq(approvals.status, "pending"),
          inArray(approvals.stageId, [...drafts.keys()]),
        ),
      );
    for (const p of pending) {
      const d = drafts.get(p.stageId ?? "");
      if (d) out.get(d.artifactId)!.pendingReview = { approvalId: p.id, version: d.version, reviewerUserId: p.approverUserId };
    }
  }
  return out;
}

