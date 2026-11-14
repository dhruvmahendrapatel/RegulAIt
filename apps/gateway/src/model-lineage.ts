/**
 * Lane L7 (P14 + P16; ADR-0216 and ADR-0217 amendments, 2026-11-14) — MODEL-FILE LINEAGE.
 *
 *   POST /v1/model-artifacts/:artifactId/lineage   the child's uploader or an admin: records how this file was made
 *                                                  from its parent file(s) — repackaged, converted, fine_tuned,
 *                                                  quantized (one parent) or merged (two or more). Once per child;
 *                                                  never edited. Audited `model-artifact-lineage-recorded` with every
 *                                                  sha256, so the record outlives a deleted file.
 *   GET  /v1/model-artifacts/:artifactId/lineage   the same callers: its parents, its ancestors (bounded) and its
 *                                                  direct children. An artifact the caller cannot see appears as a
 *                                                  count, never as an id or name.
 *
 * WHY IT MATTERS FOR MODEL RISK (P16). A merge, quantization or fine-tune of a file a certified model card cites is a
 * new version of the model that card certified. `lineageDriftCount` (model-lineage-drift.ts) counts these events since certification, and
 * `computeCardStaleness` counts them as configuration changes: with staleness-forces-recertification on, dispatch
 * holds until a person signs off again, and with the ADR-0217 automatic re-test on, the suites already chosen for that
 * agent are queued against it.
 *
 * Integrity: a parent must exist and be visible to the caller; no self-edge (also a DB CHECK); no cycle (the child
 * may not be an ancestor of any parent, checked in the same transaction under a row lock on the child).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  and,
  auditLog,
  eq,
  inArray,
  modelArtifactLineage,
  modelArtifacts,
  sql,
  MODEL_LINEAGE_RELATIONS,
  type Db,
} from "@regulait/db";
import { artifactAccessible } from "./model-artifacts.js";
import { MODEL_LINEAGE_RULE_IDS, VERSION_CHANGING_RELATIONS } from "./model-lineage-drift.js";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";

export { MODEL_LINEAGE_RULE_IDS, VERSION_CHANGING_RELATIONS };

/** the longest ancestor chain walked */
export const MODEL_LINEAGE_MAX_DEPTH = 16;
const MAX_PARENTS = 16;

const artifactParam = z.object({ artifactId: z.string().uuid() });
const recordSchema = z
  .object({
    relation: z.enum(MODEL_LINEAGE_RELATIONS),
    parentArtifactIds: z.array(z.string().uuid()).min(1).max(MAX_PARENTS),
    method: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (new Set(b.parentArtifactIds).size !== b.parentArtifactIds.length) {
      ctx.addIssue({ code: "custom", path: ["parentArtifactIds"], message: "a parent is named twice" });
    }
    if (b.relation === "merged" && b.parentArtifactIds.length < 2) {
      ctx.addIssue({ code: "custom", path: ["parentArtifactIds"], message: "a merge has two or more parents" });
    }
    if (b.relation !== "merged" && b.parentArtifactIds.length !== 1) {
      ctx.addIssue({ code: "custom", path: ["parentArtifactIds"], message: `'${b.relation}' has exactly one parent` });
    }
  });

type Caller = { userId: string | null; isAdmin: boolean };

/** every ancestor of the given artifacts (bounded depth), as ids */
async function ancestorIds(q: Pick<Db, "execute">, start: readonly string[]): Promise<Set<string>> {
  if (start.length === 0) return new Set();
  const rows = await q.execute<{ id: string }>(sql`
    WITH RECURSIVE up(id, depth) AS (
      SELECT parent_artifact_id, 1 FROM model_artifact_lineage
       WHERE child_artifact_id IN (${sql.join(start.map((s) => sql`${s}::uuid`), sql`, `)})
      UNION
      SELECT l.parent_artifact_id, up.depth + 1 FROM model_artifact_lineage l
        JOIN up ON l.child_artifact_id = up.id
       WHERE up.depth < ${MODEL_LINEAGE_MAX_DEPTH}
    )
    SELECT DISTINCT id FROM up`);
  return new Set(rows.rows.map((r) => r.id));
}

function view(a: { id: string; sha256: string; filename: string; format: string }) {
  return { id: a.id, sha256: a.sha256, filename: a.filename, format: a.format };
}

export function registerModelLineageRoutes(app: FastifyInstance, db: Db): void {
  app.post("/v1/model-artifacts/:artifactId/lineage", async (req, reply) => {
    const { artifactId } = artifactParam.parse(req.params);
    const caller = req.authCtx as Caller;
    const actor = caller.userId ?? NO_IDENTITY;
    const parsed = recordSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body", issues: parsed.error.issues });
    const body = parsed.data;
    if (body.parentArtifactIds.includes(artifactId)) {
      return reply.status(400).send({ error: "lineage_self_parent", detail: "a file cannot be its own parent" });
    }

    const refuse = async (status: number, error: string, detail: string) => {
      await db.insert(auditLog).values({
        userId: actor,
        objectType: "model_artifact",
        objectId: artifactId,
        detail: { phase: "lineage", refused: error, relation: body.relation, parentArtifactIds: body.parentArtifactIds },
        effect: "deny",
        ruleId: MODEL_LINEAGE_RULE_IDS.refused,
        ruleChain: [],
        reason: `lineage for model artifact ${artifactId} was not recorded: ${detail}`,
      });
      return reply.status(status).send({ error, detail });
    };

    const outcome = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      // the child row locked: two concurrent records for one child serialise here
      const [child] = await tx
        .select()
        .from(modelArtifacts)
        .where(eq(modelArtifacts.id, artifactId))
        .for("update");
      if (!child || !artifactAccessible(child, caller)) return { kind: "unknown_child" as const };
      const parents = await tx.select().from(modelArtifacts).where(inArray(modelArtifacts.id, body.parentArtifactIds));
      const visible = parents.filter((p) => artifactAccessible(p, caller));
      // a parent the caller cannot see is refused exactly like one that does not exist
      if (visible.length !== body.parentArtifactIds.length) return { kind: "unknown_parent" as const };
      const existing = await tx
        .select({ parent: modelArtifactLineage.parentArtifactId })
        .from(modelArtifactLineage)
        .where(eq(modelArtifactLineage.childArtifactId, artifactId))
        .limit(1);
      if (existing.length > 0) return { kind: "already_recorded" as const };
      const ancestors = await ancestorIds(tx, body.parentArtifactIds);
      if (ancestors.has(artifactId)) return { kind: "cycle" as const };
      await tx.insert(modelArtifactLineage).values(
        visible.map((p) => ({
          childArtifactId: artifactId,
          parentArtifactId: p.id,
          relation: body.relation,
          method: body.method ?? null,
          recordedByUserId: caller.userId,
        })),
      );
      const parentShas = Object.fromEntries(visible.map((p) => [p.id, p.sha256]));
      await tx.insert(auditLog).values({
        userId: actor,
        objectType: "model_artifact",
        objectId: artifactId,
        detail: {
          phase: "lineage",
          relation: body.relation,
          method: body.method ?? null,
          childArtifactId: artifactId,
          childSha256: child.sha256,
          parentArtifactIds: body.parentArtifactIds,
          parentSha256s: body.parentArtifactIds.map((id) => parentShas[id]),
          versionChange: (VERSION_CHANGING_RELATIONS as readonly string[]).includes(body.relation),
        },
        effect: "allow",
        ruleId: MODEL_LINEAGE_RULE_IDS.recorded,
        ruleChain: [],
        reason:
          `model file ${child.filename} (${child.sha256.slice(0, 12)}) recorded as ${body.relation.replace("_", "-")} ` +
          `from ${visible.map((p) => `${p.filename} (${p.sha256.slice(0, 12)})`).join(", ")}`,
      });
      return { kind: "recorded" as const, child, parents: visible };
    });

    switch (outcome.kind) {
      case "unknown_child":
        return reply.status(404).send({ error: "unknown_artifact" });
      case "unknown_parent":
        return refuse(404, "unknown_parent_artifact", "a named parent does not exist or is not visible to the caller");
      case "already_recorded":
        return refuse(409, "lineage_already_recorded", "this file's derivation is already recorded and is never edited");
      case "cycle":
        return refuse(409, "lineage_cycle", "the file is already an ancestor of a named parent");
      case "recorded":
        return reply.status(201).send({
          artifact: view(outcome.child),
          relation: body.relation,
          method: body.method ?? null,
          parents: outcome.parents.map(view),
        });
    }
  });

  app.get("/v1/model-artifacts/:artifactId/lineage", async (req, reply) => {
    const { artifactId } = artifactParam.parse(req.params);
    const caller = req.authCtx as Caller;
    const [a] = await db.select().from(modelArtifacts).where(eq(modelArtifacts.id, artifactId));
    if (!a || !artifactAccessible(a, caller)) return reply.status(404).send({ error: "unknown_artifact" });
    const edges = await db
      .select()
      .from(modelArtifactLineage)
      .where(eq(modelArtifactLineage.childArtifactId, artifactId));
    const childEdges = await db
      .select()
      .from(modelArtifactLineage)
      .where(eq(modelArtifactLineage.parentArtifactId, artifactId))
      .limit(200);
    const ancestors = [...(await ancestorIds(db, [artifactId]))];
    const ids = [...new Set([...ancestors, ...edges.map((e) => e.parentArtifactId), ...childEdges.map((e) => e.childArtifactId)])];
    const rows = ids.length ? await db.select().from(modelArtifacts).where(inArray(modelArtifacts.id, ids)) : [];
    const seen = new Map(rows.filter((r) => artifactAccessible(r, caller)).map((r) => [r.id, r]));
    const hidden = ids.filter((id) => !seen.has(id)).length;
    return {
      artifact: view(a),
      relation: edges[0]?.relation ?? null,
      method: edges[0]?.method ?? null,
      parents: edges.filter((e) => seen.has(e.parentArtifactId)).map((e) => view(seen.get(e.parentArtifactId)!)),
      ancestors: ancestors.filter((id) => seen.has(id)).map((id) => view(seen.get(id)!)),
      children: childEdges
        .filter((e) => seen.has(e.childArtifactId))
        .map((e) => ({ ...view(seen.get(e.childArtifactId)!), relation: e.relation })),
      /** artifacts on the graph the caller may not see, as a count only */
      hiddenRelatives: hidden,
      maxDepth: MODEL_LINEAGE_MAX_DEPTH,
    };
  });
}
