/**
 * ADR-0217 — the re-test rows' reads and the attach-on-request write. Kept apart from the sweep
 * (mrm-auto-retest.ts), which imports the eval and red-team runners, so the MRM routes do not.
 */
import { and, desc, eq, isNull, mrmRetestRuns, type Db, type MrmRetestRunRow } from "@regulait/db";

export const MRM_AUTO_RETEST_NOTE =
  "After a model, prompt or endpoint change on a certified model, the tests already chosen for it (its pinned " +
  "eval baselines and the red-team libraries it has been probed with) are re-run against the change, as the " +
  "person who ran each before and billed to the same project, and the results are attached to the " +
  "re-certification request. It adds evidence; it never signs off, and the model stays refused until a person does.";

/** attach every unattached re-test of this card to a newly created re-certification request (same transaction) */
export async function attachRetestsToRequest(tx: Pick<Db, "update">, cardId: string, cardApprovalId: string): Promise<number> {
  const rows = await tx
    .update(mrmRetestRuns)
    .set({ cardApprovalId })
    .where(and(eq(mrmRetestRuns.cardId, cardId), isNull(mrmRetestRuns.cardApprovalId)))
    .returning({ id: mrmRetestRuns.id });
  return rows.length;
}

/** the re-tests for a card's view: by request, and those not yet attached to one */
export async function retestsForCard(db: Db, cardId: string, approvalIds: string[]) {
  const rows = await db
    .select()
    .from(mrmRetestRuns)
    .where(eq(mrmRetestRuns.cardId, cardId))
    .orderBy(desc(mrmRetestRuns.createdAt));
  const view = (r: MrmRetestRunRow) => ({
    id: r.id,
    kind: r.kind,
    sourceName: r.sourceName,
    status: r.status,
    reason: r.reason,
    summary: r.summary,
    evalRunId: r.evalRunId,
    redteamRunId: r.redteamRunId,
    createdAt: r.createdAt,
    finishedAt: r.finishedAt,
  });
  const byApproval = new Map<string, ReturnType<typeof view>[]>(approvalIds.map((id) => [id, []]));
  const unattached: ReturnType<typeof view>[] = [];
  for (const r of rows) {
    if (r.cardApprovalId && byApproval.has(r.cardApprovalId)) byApproval.get(r.cardApprovalId)!.push(view(r));
    else if (!r.cardApprovalId) unattached.push(view(r));
  }
  return { byApproval, unattached };
}
