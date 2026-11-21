/**
 * ADR-0334 owner decision B2 (2026-11-15): THE RETENTION SWEEP FOR CAPTURED BROWSER PROMPTS.
 *
 * Captured prompts are kept `prompt_capture_retention_days` (30 by default; a longer period is a `settings_relax`
 * step-up, audited) and then deleted. The ADR-0302 sweep pattern, unchanged:
 *  - THE DATABASE CLOCK DECIDES (M-075): the cutoff is `now() - retention` computed by the database and compared with
 *    `received_at`, which the database wrote. The append-only guard re-checks both (the transaction-local
 *    `regulait.browser_capture_retention_cutoff`), so a process clock running ahead cannot delete early.
 *  - ONE AUDIT ROW PER PASS THAT DELETES, in the same transaction as the delete, naming the retention, the cutoff and
 *    the count. A pass that deletes nothing writes nothing (the job's run row records it).
 *  - BOUNDED: at most BATCH rows per transaction and MAX_BATCHES transactions per pass.
 * Breach events are not touched (they hold no prompt text).
 */
import { and, auditLog, browserGovernanceSettings, browserPromptCaptures, eq, inArray, lt, sql, type Db } from "@regulait/db";
import { BROWSER_CAPTURE_RETENTION_DEFAULT_DAYS } from "@regulait/shared";
import type { SchedulerJobDefinition } from "./scheduler.js";

export const BROWSER_CAPTURE_RETENTION_JOB_NAME = "browser-prompt-capture-retention-sweep";
export const BROWSER_CAPTURE_RETENTION_RULE_ID = "browser-prompt-captures-purged";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
const BATCH = 2000;
const MAX_BATCHES = 10;

export interface BrowserCaptureRetentionResult {
  deleted: number;
  retainedDays: number;
  cutoff: string;
}

export async function runBrowserCaptureRetentionSweep(db: Db, opts: { actorUserId?: string | null } = {}): Promise<BrowserCaptureRetentionResult> {
  const [settings] = await db
    .select({ days: browserGovernanceSettings.promptCaptureRetentionDays })
    .from(browserGovernanceSettings)
    .where(eq(browserGovernanceSettings.id, 1));
  const retainedDays = settings?.days ?? BROWSER_CAPTURE_RETENTION_DEFAULT_DAYS;
  const r = await db.execute<{ cutoff: string }>(sql`select (now() - make_interval(days => ${retainedDays}))::text as cutoff`);
  const cutoffText = String(r.rows[0]!.cutoff);
  const cutoff = new Date(cutoffText);
  let deleted = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const n = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      // the guard lets a DELETE through only for captures received before this cutoff (transaction-local)
      await tx.execute(sql`SELECT set_config('regulait.browser_capture_retention_cutoff', ${cutoffText}, true)`);
      const due = await tx
        .select({ id: browserPromptCaptures.id })
        .from(browserPromptCaptures)
        .where(lt(browserPromptCaptures.receivedAt, cutoff))
        .orderBy(browserPromptCaptures.receivedAt)
        .limit(BATCH);
      if (due.length === 0) return 0;
      const removed = await tx
        .delete(browserPromptCaptures)
        .where(and(inArray(browserPromptCaptures.id, due.map((d) => d.id)), lt(browserPromptCaptures.receivedAt, cutoff)))
        .returning({ id: browserPromptCaptures.id });
      await tx.insert(auditLog).values({
        userId: opts.actorUserId ?? NO_IDENTITY,
        objectType: "browser_governance",
        objectId: null,
        detail: { subsystem: "browser-governance", adr: "0334", phase: "prompt-capture-retention", deleted: removed.length, retainedDays, cutoff: cutoff.toISOString() },
        effect: "allow",
        ruleId: BROWSER_CAPTURE_RETENTION_RULE_ID,
        ruleChain: [],
        reason: `deleted ${removed.length} captured browser prompt(s) received before ${cutoff.toISOString()} (retention ${retainedDays} days, ADR-0334 B2)`,
      });
      return removed.length;
    });
    deleted += n;
    if (n < BATCH) break;
  }
  return { deleted, retainedDays, cutoff: cutoff.toISOString() };
}

export function browserGovernanceJobDefinitions(): SchedulerJobDefinition[] {
  return [
    {
      name: BROWSER_CAPTURE_RETENTION_JOB_NAME,
      description:
        "Delete prompts captured in the browser (ADR-0334) once they are older than the admin's retention (30 days by " +
        "default), audited in the same transaction.",
      adr: "ADR-0334",
      defaultIntervalSeconds: 3600,
      run: async (ctx) => {
        const out = await runBrowserCaptureRetentionSweep(ctx.db, { actorUserId: ctx.actorUserId });
        return { itemsProcessed: out.deleted, detail: { ...out } };
      },
    },
  ];
}
