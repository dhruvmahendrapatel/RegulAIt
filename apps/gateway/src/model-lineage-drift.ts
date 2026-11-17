/**
 * Lane L7 (P16; ADR-0217 amendment) — model-file lineage as MRM drift. A leaf module (database only) so the staleness
 * computation can read it without importing the artifact routes.
 *
 * A fine-tune, merge or quantization recorded from a file a model card cites is a new version of the model that card
 * certified. Counted from the audit rows the lineage route writes (`model-artifact-lineage-recorded`), so a later
 * delete of either file does not erase the drift.
 */
import { and, artifactScans, auditLog, eq, gt, modelCardEvidence, type Db } from "@regulait/db";

export const MODEL_LINEAGE_RULE_IDS = {
  recorded: "model-artifact-lineage-recorded",
  refused: "model-artifact-lineage-refused",
} as const;

/** the derivations that make a new VERSION of a model (P16): a change of weights or numerics */
export const VERSION_CHANGING_RELATIONS = ["fine_tuned", "merged", "quantized"] as const;

/** the artifacts a card cites through its scan evidence */
async function cardArtifactIds(q: Pick<Db, "select">, cardId: string): Promise<string[]> {
  const rows = await q
    .select({ artifactId: artifactScans.artifactId })
    .from(modelCardEvidence)
    .innerJoin(artifactScans, eq(artifactScans.id, modelCardEvidence.artifactScanId))
    .where(eq(modelCardEvidence.cardId, cardId));
  return [...new Set(rows.map((r) => r.artifactId))];
}

/** version-changing lineage events since `since` whose parent is a file the card cites */
export async function lineageDriftCount(q: Pick<Db, "select">, cardId: string, since: Date): Promise<number> {
  const cited = new Set(await cardArtifactIds(q, cardId));
  if (cited.size === 0) return 0;
  const rows = await q
    .select({ detail: auditLog.detail })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.ruleId, MODEL_LINEAGE_RULE_IDS.recorded),
        gt(auditLog.at, since),
        eq(auditLog.objectType, "model_artifact"),
      ),
    );
  let n = 0;
  for (const r of rows) {
    const d = (r.detail ?? {}) as { relation?: string; parentArtifactIds?: unknown };
    if (!(VERSION_CHANGING_RELATIONS as readonly string[]).includes(d.relation ?? "")) continue;
    const parents = Array.isArray(d.parentArtifactIds) ? (d.parentArtifactIds as string[]) : [];
    if (parents.some((p) => cited.has(p))) n += 1;
  }
  return n;
}
