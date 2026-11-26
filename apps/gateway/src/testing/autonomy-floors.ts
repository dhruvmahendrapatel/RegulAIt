/**
 * ADR-0180 addendum (lane E51) test fixture: put the DELEGATED autonomy floors in place for a model, so that a builder
 * suite whose agents are delegated by setup (a write tool without Ask-first, computer use) runs under the strict
 * oversight gate instead of switching it off. Writes exactly what an operator would: prompt-injection and jailbreak
 * guardrails at block for the model, an approved model card, and a fresh red-team run on the model in which no agentic
 * attack class succeeded. The autonomous floors (a monthly limit, Ask-first on every write tool) stay the suite's own
 * business: they are properties of the agent, not of the model.
 *
 * `cleanup()` removes the guardrail rows (M-068). The card, its approval and the red-team run stay: they are scoped to
 * a model the suite created under its own per-run name.
 */
import {
  and,
  eq,
  evalDatasets,
  evalRuns,
  guardrailConfigs,
  inArray,
  modelCardApprovals,
  modelCards,
  redteamLibraries,
  redteamRuns,
  users,
  type Db,
} from "@regulait/db";
import { AUTONOMY_AGENTIC_TEST_CLASSES } from "@regulait/shared";

export interface AutonomyFloorsFixture {
  cleanup: () => Promise<void>;
}

export async function meetDelegatedAutonomyFloorsForTest(db: Db, modelAgentIds: readonly string[]): Promise<AutonomyFloorsFixture> {
  if (process.env.VITEST === undefined && process.env.NODE_ENV !== "test") {
    throw new Error("meetDelegatedAutonomyFloorsForTest is a test fixture: it runs only under a test runner");
  }
  const tag = Math.random().toString(36).slice(2, 8);
  const [approver] = await db
    .insert(users)
    .values({ email: `e51-floor-approver-${tag}@example.com`, displayName: `floor approver ${tag}` })
    .returning({ id: users.id });
  const [lib] = await db.insert(redteamLibraries).values({ name: `e51-floors-lib-${tag}` }).returning();
  const [ds] = await db.insert(evalDatasets).values({ name: `e51-floors-ds-${tag}` }).returning();
  for (const agentId of modelAgentIds) {
    await db
      .insert(guardrailConfigs)
      .values({ scope: "agent", scopeId: agentId, promptInjectionMode: "block", jailbreakMode: "block" })
      .onConflictDoNothing();
    const [card] = await db.insert(modelCards).values({ agentId, intendedUse: `e51 floors ${tag}` }).returning();
    await db.insert(modelCardApprovals).values({
      cardId: card!.id,
      status: "approved",
      approverUserId: approver!.id,
      decidedBy: approver!.id,
      decidedAt: new Date(),
      validUntil: new Date(Date.now() + 90 * 86_400_000),
    });
    const [ev] = await db
      .insert(evalRuns)
      .values({ datasetId: ds!.id, datasetVersion: 1, agentId, agentName: "floors", trigger: "manual" })
      .returning();
    await db.insert(redteamRuns).values({
      libraryId: lib!.id,
      libraryName: lib!.name,
      libraryVersion: 1,
      evalRunId: ev!.id,
      agentId,
      agentName: "floors",
      classSummary: AUTONOMY_AGENTIC_TEST_CLASSES.map((attackClass) => ({ attackClass, probes: 4, resisted: 4, defeated: 0 })),
      finishedAt: new Date(Date.now() - 3_600_000),
    });
  }
  return {
    // only the guardrail rows are global-looking state; the card, its approval and the red-team run are scoped to a
    // model this suite created under its own per-run name, and approval decisions are evidence (append-only)
    cleanup: async () => {
      if (modelAgentIds.length) {
        await db.delete(guardrailConfigs).where(and(eq(guardrailConfigs.scope, "agent"), inArray(guardrailConfigs.scopeId, [...modelAgentIds])));
      }
    },
  };
}
