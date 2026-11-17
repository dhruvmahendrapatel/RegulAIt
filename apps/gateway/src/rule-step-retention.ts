/**
 * ADR-0327 slice 3: retention of rule-like step suggestions. A leaf module (only `@regulait/db`), so the §8.3 prune
 * pass in `org-settings.ts` can call it without an import cycle through the routes.
 *
 * A suggestion's rule copies input values out of trace spans recorded in its scan window,
 * `[detected_at − SCAN_WINDOW_DAYS, detected_at]`. The prune therefore keys on the window's START: once that start is
 * older than the retention cutoff, some of the spans the cells came from have been pruned, so the suggestion goes too
 * (review #901). A rescan rebuilds it from spans still held. Deleted, not redacted: a redacted cell would be a wrong
 * rule.
 */
import { lt, ruleStepSuggestions, sql, type Db } from "@regulait/db";

/** the scan reads spans this many days back from the scan time (`rule-steps.ts` uses the same constant) */
export const SCAN_WINDOW_DAYS = 30;

/** delete every suggestion whose scan window starts before `cutoff`; returns how many */
export async function pruneRuleStepSuggestions(db: Db, cutoff: Date): Promise<number> {
  const removed = await db
    .delete(ruleStepSuggestions)
    .where(lt(sql`${ruleStepSuggestions.detectedAt} - make_interval(days => ${SCAN_WINDOW_DAYS})`, cutoff))
    .returning({ id: ruleStepSuggestions.id });
  return removed.length;
}
