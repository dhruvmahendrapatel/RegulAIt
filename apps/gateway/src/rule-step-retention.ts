/**
 * ADR-0327 slice 3: retention of rule-like step suggestions. A leaf module (only `@regulait/db`), so the §8.3 prune
 * pass in `org-settings.ts` can call it without an import cycle through the routes.
 *
 * A suggestion's rule copies input values out of trace spans, and its scan window ends at `detected_at`, so a
 * suggestion detected before the retention cutoff draws only on spans the same prune pass removes. It is deleted, not
 * redacted (a redacted cell would be a wrong rule); the next scan rebuilds it from spans still held.
 */
import { lt, ruleStepSuggestions, type Db } from "@regulait/db";

/** delete every suggestion detected before `cutoff`; returns how many */
export async function pruneRuleStepSuggestions(db: Db, cutoff: Date): Promise<number> {
  const removed = await db
    .delete(ruleStepSuggestions)
    .where(lt(ruleStepSuggestions.detectedAt, cutoff))
    .returning({ id: ruleStepSuggestions.id });
  return removed.length;
}
