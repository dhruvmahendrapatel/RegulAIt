/**
 * ADR-0215 — FRAMEWORK CONTENT IMPORTS AND THE IMPORTED REGULATORY FEED, the gateway half.
 *
 * The content is vendored (`packages/shared/src/framework-imports-data/`) and read
 * from disk: nothing here downloads. The pure merge and diff live in
 * `@regulait/shared` (`framework-imports.ts`); this file stores proposals, takes
 * the admin's decision and writes the result, each write in one transaction with
 * its audit row.
 *
 *  - A framework import is PROPOSED (the plan is computed and stored), then
 *    ACCEPTED or REJECTED. Accepting re-plans against the same base pack version
 *    and inserts a NEW draft pack version; it never updates a pack row. A control
 *    an admin edited is kept unless the admin names it in `takeIncoming`.
 *  - A feed import is proposed with its diff against the accepted entries, and
 *    joins the ADR-0158 feed only once accepted.
 *
 * Admin-only through the default gate. Every write refuses unless
 * `org_settings.framework_imports_enabled` is on (default off, ADR-0180).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  and,
  auditLog,
  compliancePackControls,
  compliancePacks,
  desc,
  eq,
  frameworkImportProposals,
  regulatoryFeedImports,
  sql,
  type Db,
} from "@regulait/db";
import {
  createCompliancePackSchema,
  diffFeedEntries,
  FRAMEWORK_IMPORT_SCHEMA,
  frameworkImportSnapshotSchema,
  importContentSha256,
  importTextPolicy,
  planFrameworkImport,
  REGULATORY_FEED_IMPORT_SCHEMA,
  regulatoryFeedSnapshotSchema,
  type FrameworkImportPlan,
  type FrameworkImportSnapshot,
  type ImportBasePack,
  type ImportedControl,
  type PackControlInput,
  type RegulatoryFeedSnapshot,
  type RegulatoryUpdate,
} from "@regulait/shared";
import { insertPack } from "./compliance-packs.js";
import { loadOrgSettings } from "./org-settings.js";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";

/** stable rule ids — the strings an operator greps the audit log for */
export const FRAMEWORK_IMPORT_RULE_IDS = {
  proposed: "framework-import-proposed",
  accepted: "framework-import-accepted",
  rejected: "framework-import-rejected",
  feedProposed: "regulatory-feed-import-proposed",
  feedAccepted: "regulatory-feed-import-accepted",
  feedRejected: "regulatory-feed-import-rejected",
  refusedDisabled: "framework-import-refused-disabled",
} as const;

// ---------------------------------------------------------------------------
// The vendored data, read from disk once
// ---------------------------------------------------------------------------

/** `packages/shared/src/framework-imports-data`, from `src/` or `dist/` alike */
export function frameworkImportDataDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../packages/shared/src/framework-imports-data");
}

interface VendoredData {
  packs: Map<string, FrameworkImportSnapshot>;
  feeds: Map<string, RegulatoryFeedSnapshot>;
}
let cached: VendoredData | null = null;
let dirForTest: string | null = null;

/** tests point the routes at a fixture directory; null restores the vendored data */
export function setFrameworkImportDataDirForTest(dir: string | null): void {
  dirForTest = dir;
  cached = null;
}

/** every snapshot file, validated; a malformed file throws at first use rather than importing half a framework */
export function vendoredImportData(): VendoredData {
  if (cached) return cached;
  const dir = dirForTest ?? frameworkImportDataDir();
  const packs = new Map<string, FrameworkImportSnapshot>();
  const feeds = new Map<string, RegulatoryFeedSnapshot>();
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const raw = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as { schema?: string };
    if (raw.schema === FRAMEWORK_IMPORT_SCHEMA) {
      const s = frameworkImportSnapshotSchema.parse(raw);
      packs.set(s.source.sourceId, s);
    } else if (raw.schema === REGULATORY_FEED_IMPORT_SCHEMA) {
      const s = regulatoryFeedSnapshotSchema.parse(raw);
      feeds.set(s.source.sourceId, s);
    } else {
      throw new Error(`${name}: unknown import schema`);
    }
  }
  cached = { packs, feeds };
  return cached;
}

// ---------------------------------------------------------------------------
// Reads shared with the ADR-0158 feed
// ---------------------------------------------------------------------------

/** the entries of every ACCEPTED feed import, for the regulatory feed. Empty when the feature is off. */
export async function acceptedImportedFeedEntries(db: Db): Promise<RegulatoryUpdate[][]> {
  const settings = await loadOrgSettings(db);
  if (!settings.frameworkImportsEnabled) return [];
  const rows = await db
    .select({ entries: regulatoryFeedImports.entries })
    .from(regulatoryFeedImports)
    .where(eq(regulatoryFeedImports.status, "accepted"))
    .orderBy(regulatoryFeedImports.sourceId);
  return rows.map((r) => r.entries as unknown as RegulatoryUpdate[]);
}

// ---------------------------------------------------------------------------
// Planning helpers
// ---------------------------------------------------------------------------

/** the latest version of a framework's pack, whatever its status, with its controls */
async function latestPack(db: Db, framework: string): Promise<{ id: string; base: ImportBasePack } | null> {
  const [pack] = await db
    .select()
    .from(compliancePacks)
    .where(eq(compliancePacks.framework, framework))
    .orderBy(desc(compliancePacks.version))
    .limit(1);
  if (!pack) return null;
  const rows = await db
    .select()
    .from(compliancePackControls)
    .where(eq(compliancePackControls.packId, pack.id))
    .orderBy(compliancePackControls.controlRef);
  const controls: PackControlInput[] = rows.map((r) => ({
    controlRef: r.controlRef,
    title: r.title,
    description: r.description,
    coverage: r.coverage,
    collector: r.collector as PackControlInput["collector"],
    collectorParams: r.collectorParams as PackControlInput["collectorParams"],
    minEvidenceCount: r.minEvidenceCount,
    attestationRequired: r.attestationRequired,
    ownerNote: r.ownerNote,
  }));
  return {
    id: pack.id,
    base: {
      version: pack.version,
      title: pack.title,
      description: pack.description,
      cascadeTag: pack.cascadeTag,
      cascadePreset: pack.cascadePreset,
      controls,
    },
  };
}

/** the snapshot of the accepted import of this source: the baseline edits are detected against */
async function acceptedBaseline(db: Db, sourceId: string): Promise<{ id: string; controls: ImportedControl[] } | null> {
  const [row] = await db
    .select({ id: frameworkImportProposals.id, snapshot: frameworkImportProposals.snapshot })
    .from(frameworkImportProposals)
    .where(and(eq(frameworkImportProposals.sourceId, sourceId), eq(frameworkImportProposals.status, "accepted")));
  if (!row) return null;
  return { id: row.id, controls: (row.snapshot as { controls: ImportedControl[] }).controls };
}

/** the plan as stored and returned: the proposed pack's controls are summarised, the changes are listed */
function planView(plan: FrameworkImportPlan) {
  const { proposedPack, ...rest } = plan;
  return { ...rest, proposedPack: { framework: proposedPack.framework, version: proposedPack.version, title: proposedPack.title, controls: proposedPack.controls.length } };
}

const sourceParam = z.object({ sourceId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/) });
const idParam = z.object({ id: z.string().uuid() });
const acceptBody = z
  .object({ takeIncoming: z.array(z.string().min(1).max(200)).max(500).default([]) })
  .strict();

export function registerFrameworkImportRoutes(app: FastifyInstance, db: Db): void {
  async function auditRow(
    tx: Db,
    actor: string | null,
    objectType: "framework_import" | "regulatory_feed_import",
    objectId: string | null,
    ruleId: string,
    reason: string,
    detail: Record<string, unknown>,
    effect: "allow" | "deny" = "allow",
  ) {
    await tx.insert(auditLog).values({
      userId: actor ?? NO_IDENTITY,
      objectType,
      objectId,
      detail,
      effect,
      ruleId,
      ruleChain: [],
      reason,
    });
  }

  /** every write refuses while the org setting is off, and the refusal is audited */
  async function refuseIfDisabled(actor: string | null, what: string, reply: FastifyReply): Promise<boolean> {
    const settings = await loadOrgSettings(db);
    if (settings.frameworkImportsEnabled) return false;
    await auditRow(db, actor, "framework_import", null, FRAMEWORK_IMPORT_RULE_IDS.refusedDisabled, `${what} refused: framework imports are off in organisation settings`, { what }, "deny");
    await reply.status(403).send({
      error: "framework_imports_disabled",
      detail: "Framework imports are off for this organisation. An admin can turn them on in Organisation settings.",
    });
    return true;
  }

  // --- framework imports ---------------------------------------------------

  app.get("/v1/compliance/framework-imports", async () => {
    const settings = await loadOrgSettings(db);
    const data = vendoredImportData();
    const proposals = await db
      .select()
      .from(frameworkImportProposals)
      .where(sql`${frameworkImportProposals.status} IN ('pending', 'accepted')`);
    const sources = [...data.packs.values()].map((s) => {
      const sha = importContentSha256(s);
      const accepted = proposals.find((p) => p.sourceId === s.source.sourceId && p.status === "accepted") ?? null;
      const pending = proposals.find((p) => p.sourceId === s.source.sourceId && p.status === "pending") ?? null;
      return {
        sourceId: s.source.sourceId,
        framework: s.source.framework,
        title: s.source.title,
        publisher: s.source.publisher,
        licence: s.source.licence,
        licenceUrl: s.source.licenceUrl,
        textPolicy: importTextPolicy(s.source.licence),
        sourceVersion: s.source.sourceVersion,
        upstreamUrl: s.source.upstreamUrl,
        retrievedOn: s.source.retrievedOn,
        controls: s.controls.length,
        contentSha256: sha,
        accepted: accepted
          ? { id: accepted.id, sourceVersion: accepted.sourceVersion, decidedAt: accepted.decidedAt, resultingPackId: accepted.resultingPackId, upToDate: accepted.contentSha256 === sha }
          : null,
        pending: pending ? { id: pending.id, createdAt: pending.createdAt } : null,
      };
    });
    return { enabled: settings.frameworkImportsEnabled, sources };
  });

  app.get("/v1/compliance/framework-imports/proposals/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [row] = await db.select().from(frameworkImportProposals).where(eq(frameworkImportProposals.id, id));
    if (!row) return reply.status(404).send({ error: "unknown_import_proposal" });
    const { snapshot, ...rest } = row;
    return { proposal: { ...rest, source: (snapshot as { source: unknown }).source } };
  });

  app.post("/v1/compliance/framework-imports/:sourceId/proposals", async (req, reply) => {
    const actor = req.authCtx.userId ?? null;
    if (await refuseIfDisabled(actor, "proposing a framework import", reply)) return reply;
    const { sourceId } = sourceParam.parse(req.params);
    const snapshot = vendoredImportData().packs.get(sourceId);
    if (!snapshot) return reply.status(404).send({ error: "unknown_import_source" });
    const outcome = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [pending] = await tx
        .select({ id: frameworkImportProposals.id })
        .from(frameworkImportProposals)
        .where(and(eq(frameworkImportProposals.sourceId, sourceId), eq(frameworkImportProposals.status, "pending")));
      if (pending) return { status: 409 as const, body: { error: "import_proposal_pending", proposalId: pending.id } };
      const current = await latestPack(tx, snapshot.source.framework);
      const baseline = await acceptedBaseline(tx, sourceId);
      const plan = planFrameworkImport({ snapshot, baseline: baseline?.controls ?? null, current: current?.base ?? null });
      if (plan.noChange) return { status: 200 as const, body: { noChange: true, plan: planView(plan) } };
      const [row] = await tx
        .insert(frameworkImportProposals)
        .values({
          sourceId,
          framework: snapshot.source.framework,
          sourceVersion: snapshot.source.sourceVersion,
          contentSha256: plan.contentSha256,
          snapshot: snapshot as unknown as Record<string, unknown>,
          basePackId: current?.id ?? null,
          basePackVersion: current?.base.version ?? null,
          plan: planView(plan) as unknown as Record<string, unknown>,
          createdByUserId: actor,
        })
        .returning();
      await auditRow(
        tx,
        actor,
        "framework_import",
        row!.id,
        FRAMEWORK_IMPORT_RULE_IDS.proposed,
        `proposed importing ${snapshot.source.title} ${snapshot.source.sourceVersion} as '${plan.framework}' ` +
          `v${plan.toVersion}: ${plan.summary.added} added, ${plan.summary.text_updated} updated, ` +
          `${plan.summary.kept_edited} edited control(s) kept. Nothing changes until an admin accepts it`,
        { sourceId, framework: plan.framework, sourceVersion: plan.sourceVersion, contentSha256: plan.contentSha256, fromVersion: plan.fromVersion, toVersion: plan.toVersion, summary: plan.summary },
      );
      return { status: 201 as const, body: { proposal: { id: row!.id, status: row!.status }, plan: planView(plan) } };
    });
    return reply.status(outcome.status).send(outcome.body);
  });

  app.post("/v1/compliance/framework-imports/proposals/:id/accept", async (req, reply) => {
    const actor = req.authCtx.userId ?? null;
    if (await refuseIfDisabled(actor, "accepting a framework import", reply)) return reply;
    const { id } = idParam.parse(req.params);
    const { takeIncoming } = acceptBody.parse(req.body ?? {});
    const outcome = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [row] = await tx.select().from(frameworkImportProposals).where(eq(frameworkImportProposals.id, id)).for("update");
      if (!row) return { status: 404 as const, body: { error: "unknown_import_proposal" } };
      if (row.status !== "pending") return { status: 409 as const, body: { error: "import_proposal_decided", status: row.status } };
      const snapshot = frameworkImportSnapshotSchema.parse(row.snapshot);
      if (importContentSha256(snapshot) !== row.contentSha256) {
        return { status: 409 as const, body: { error: "import_snapshot_mismatch" } };
      }
      const current = await latestPack(tx, row.framework);
      if ((current?.id ?? null) !== row.basePackId) {
        return {
          status: 409 as const,
          body: {
            error: "import_base_changed",
            detail: "The pack changed after this import was proposed. Reject this proposal and propose the import again.",
          },
        };
      }
      const baseline = await acceptedBaseline(tx, row.sourceId);
      const plan = planFrameworkImport({ snapshot, baseline: baseline?.controls ?? null, current: current?.base ?? null, takeIncoming });
      if (plan.unknownResolutions.length) {
        return {
          status: 400 as const,
          body: {
            error: "import_unknown_resolution",
            detail: "Only an edited control the import would keep can be overwritten.",
            controlRefs: plan.unknownResolutions,
          },
        };
      }
      const pack = await insertPack(tx, createCompliancePackSchema.parse(plan.proposedPack), actor);
      if (baseline) {
        await tx
          .update(frameworkImportProposals)
          .set({ status: "superseded" })
          .where(eq(frameworkImportProposals.id, baseline.id));
      }
      const [decided] = await tx
        .update(frameworkImportProposals)
        .set({
          status: "accepted",
          takeIncoming: [...takeIncoming].sort(),
          plan: planView(plan) as unknown as Record<string, unknown>,
          resultingPackId: pack.id,
          decidedByUserId: actor,
          decidedAt: sql`now()`,
        })
        .where(eq(frameworkImportProposals.id, id))
        .returning();
      await auditRow(
        tx,
        actor,
        "framework_import",
        id,
        FRAMEWORK_IMPORT_RULE_IDS.accepted,
        `accepted the ${row.sourceId} import: '${plan.framework}' v${plan.toVersion} created as a DRAFT pack ` +
          `(${plan.summary.added} added, ${plan.summary.text_updated} updated, ${plan.summary.kept_edited} edited ` +
          `control(s) kept, ${plan.summary.edited_replaced} edited control(s) overwritten by choice). It evaluates nothing until activated`,
        {
          sourceId: row.sourceId,
          framework: plan.framework,
          contentSha256: plan.contentSha256,
          fromVersion: plan.fromVersion,
          toVersion: plan.toVersion,
          packId: pack.id,
          summary: plan.summary,
          takeIncoming: [...takeIncoming].sort(),
          supersededProposalId: baseline?.id ?? null,
        },
      );
      return { status: 201 as const, body: { proposal: { id: decided!.id, status: decided!.status }, pack, plan: planView(plan) } };
    });
    return reply.status(outcome.status).send(outcome.body);
  });

  app.post("/v1/compliance/framework-imports/proposals/:id/reject", async (req, reply) => {
    const actor = req.authCtx.userId ?? null;
    if (await refuseIfDisabled(actor, "rejecting a framework import", reply)) return reply;
    const { id } = idParam.parse(req.params);
    const outcome = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [row] = await tx.select().from(frameworkImportProposals).where(eq(frameworkImportProposals.id, id)).for("update");
      if (!row) return { status: 404 as const, body: { error: "unknown_import_proposal" } };
      if (row.status !== "pending") return { status: 409 as const, body: { error: "import_proposal_decided", status: row.status } };
      await tx
        .update(frameworkImportProposals)
        .set({ status: "rejected", decidedByUserId: actor, decidedAt: sql`now()` })
        .where(eq(frameworkImportProposals.id, id));
      await auditRow(tx, actor, "framework_import", id, FRAMEWORK_IMPORT_RULE_IDS.rejected, `rejected the ${row.sourceId} import proposal; no pack changed`, {
        sourceId: row.sourceId,
        framework: row.framework,
        contentSha256: row.contentSha256,
      });
      return { status: 200 as const, body: { proposal: { id, status: "rejected" } } };
    });
    return reply.status(outcome.status).send(outcome.body);
  });

  // --- regulatory feed imports ---------------------------------------------

  app.get("/v1/regulatory/feed-imports", async () => {
    const settings = await loadOrgSettings(db);
    const data = vendoredImportData();
    const rows = await db
      .select()
      .from(regulatoryFeedImports)
      .where(sql`${regulatoryFeedImports.status} IN ('pending', 'accepted')`);
    const sources = [...data.feeds.values()].map((s) => {
      const sha = importContentSha256(s);
      const accepted = rows.find((r) => r.sourceId === s.source.sourceId && r.status === "accepted") ?? null;
      const pending = rows.find((r) => r.sourceId === s.source.sourceId && r.status === "pending") ?? null;
      return {
        sourceId: s.source.sourceId,
        title: s.source.title,
        publisher: s.source.publisher,
        licence: s.source.licence,
        licenceUrl: s.source.licenceUrl,
        sourceVersion: s.source.sourceVersion,
        retrievedOn: s.source.retrievedOn,
        entries: s.entries.length,
        contentSha256: sha,
        accepted: accepted
          ? { id: accepted.id, sourceVersion: accepted.sourceVersion, decidedAt: accepted.decidedAt, entries: accepted.entries.length, upToDate: accepted.contentSha256 === sha }
          : null,
        pending: pending ? { id: pending.id, createdAt: pending.createdAt, diff: pending.diff } : null,
      };
    });
    return { enabled: settings.frameworkImportsEnabled, sources };
  });

  /**
   * The review view of one feed import: the entries it would add, change (with
   * what is in the feed now) and remove, so an admin sees what joins the feed
   * before accepting it. Changed and removed entries are read from the source's
   * accepted row, the same baseline the stored diff was computed against.
   */
  app.get("/v1/regulatory/feed-imports/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [row] = await db.select().from(regulatoryFeedImports).where(eq(regulatoryFeedImports.id, id));
    if (!row) return reply.status(404).send({ error: "unknown_feed_import" });
    const [accepted] = await db
      .select({ entries: regulatoryFeedImports.entries })
      .from(regulatoryFeedImports)
      .where(and(eq(regulatoryFeedImports.sourceId, row.sourceId), eq(regulatoryFeedImports.status, "accepted")));
    const view = (e: RegulatoryUpdate) => ({
      key: e.key,
      title: e.title,
      instrument: e.instrument,
      effectiveDate: e.effectiveDate,
      status: e.status,
      sourceUrl: e.sourceUrl,
    });
    const next = new Map((row.entries as unknown as RegulatoryUpdate[]).map((e) => [e.key, e]));
    const prev = new Map(((accepted?.entries ?? []) as unknown as RegulatoryUpdate[]).map((e) => [e.key, e]));
    const diff = row.diff as { added?: string[]; changed?: string[]; removed?: string[] };
    const pick = (keys: string[] | undefined, from: Map<string, RegulatoryUpdate>) =>
      (keys ?? []).flatMap((k) => (from.has(k) ? [view(from.get(k)!)] : []));
    return {
      feedImport: {
        id: row.id,
        sourceId: row.sourceId,
        sourceVersion: row.sourceVersion,
        status: row.status,
        createdAt: row.createdAt,
        decidedAt: row.decidedAt,
        added: pick(diff.added, next),
        changed: (diff.changed ?? []).flatMap((k) =>
          next.has(k) ? [{ ...view(next.get(k)!), previous: prev.has(k) ? view(prev.get(k)!) : null }] : [],
        ),
        removed: pick(diff.removed, prev),
      },
    };
  });

  app.post("/v1/regulatory/feed-imports/:sourceId/proposals", async (req, reply) => {
    const actor = req.authCtx.userId ?? null;
    if (await refuseIfDisabled(actor, "proposing a regulatory feed import", reply)) return reply;
    const { sourceId } = sourceParam.parse(req.params);
    const snapshot = vendoredImportData().feeds.get(sourceId);
    if (!snapshot) return reply.status(404).send({ error: "unknown_import_source" });
    const outcome = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const existing = await tx
        .select({ id: regulatoryFeedImports.id, status: regulatoryFeedImports.status, entries: regulatoryFeedImports.entries })
        .from(regulatoryFeedImports)
        .where(and(eq(regulatoryFeedImports.sourceId, sourceId), sql`${regulatoryFeedImports.status} IN ('pending', 'accepted')`));
      const pending = existing.find((r) => r.status === "pending");
      if (pending) return { status: 409 as const, body: { error: "import_proposal_pending", proposalId: pending.id } };
      const accepted = existing.find((r) => r.status === "accepted");
      const entries = snapshot.entries as RegulatoryUpdate[];
      const diff = diffFeedEntries((accepted?.entries as unknown as RegulatoryUpdate[] | undefined) ?? null, entries);
      if (diff.noChange) return { status: 200 as const, body: { noChange: true, diff } };
      const contentSha256 = importContentSha256(snapshot);
      const [row] = await tx
        .insert(regulatoryFeedImports)
        .values({
          sourceId,
          sourceVersion: snapshot.source.sourceVersion,
          contentSha256,
          source: snapshot.source as unknown as Record<string, unknown>,
          entries: entries as unknown as Array<Record<string, unknown>>,
          diff: diff as unknown as Record<string, unknown>,
          createdByUserId: actor,
        })
        .returning({ id: regulatoryFeedImports.id, status: regulatoryFeedImports.status });
      await auditRow(
        tx,
        actor,
        "regulatory_feed_import",
        row!.id,
        FRAMEWORK_IMPORT_RULE_IDS.feedProposed,
        `proposed ${snapshot.source.title} (${snapshot.source.sourceVersion}): ${diff.added.length} added, ` +
          `${diff.changed.length} changed, ${diff.removed.length} removed. Nothing joins the feed until an admin accepts it`,
        { sourceId, sourceVersion: snapshot.source.sourceVersion, contentSha256, added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length },
      );
      return { status: 201 as const, body: { feedImport: row, diff } };
    });
    return reply.status(outcome.status).send(outcome.body);
  });

  for (const decision of ["accept", "reject"] as const) {
    app.post(`/v1/regulatory/feed-imports/:id/${decision}`, async (req, reply) => {
      const actor = req.authCtx.userId ?? null;
      if (await refuseIfDisabled(actor, `${decision === "accept" ? "accepting" : "rejecting"} a regulatory feed import`, reply)) return reply;
      const { id } = idParam.parse(req.params);
      const outcome = await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        const [row] = await tx.select().from(regulatoryFeedImports).where(eq(regulatoryFeedImports.id, id)).for("update");
        if (!row) return { status: 404 as const, body: { error: "unknown_feed_import" } };
        if (row.status !== "pending") return { status: 409 as const, body: { error: "import_proposal_decided", status: row.status } };
        let supersededId: string | null = null;
        if (decision === "accept") {
          const [prev] = await tx
            .update(regulatoryFeedImports)
            .set({ status: "superseded" })
            .where(and(eq(regulatoryFeedImports.sourceId, row.sourceId), eq(regulatoryFeedImports.status, "accepted")))
            .returning({ id: regulatoryFeedImports.id });
          supersededId = prev?.id ?? null;
        }
        const status = decision === "accept" ? "accepted" : "rejected";
        await tx
          .update(regulatoryFeedImports)
          .set({ status, decidedByUserId: actor, decidedAt: sql`now()` })
          .where(eq(regulatoryFeedImports.id, id));
        await auditRow(
          tx,
          actor,
          "regulatory_feed_import",
          id,
          decision === "accept" ? FRAMEWORK_IMPORT_RULE_IDS.feedAccepted : FRAMEWORK_IMPORT_RULE_IDS.feedRejected,
          decision === "accept"
            ? `accepted ${row.entries.length} imported regulatory feed entries from ${row.sourceId}; they join the regulatory feed`
            : `rejected the ${row.sourceId} feed import; the feed is unchanged`,
          { sourceId: row.sourceId, contentSha256: row.contentSha256, entries: row.entries.length, supersededId },
        );
        return { status: 200 as const, body: { feedImport: { id, status } } };
      });
      return reply.status(outcome.status).send(outcome.body);
    });
  }
}
