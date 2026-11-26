/**
 * ADR-0356: a stored `pm_trigger_settings` row as the one validated settings document. Its own module so the trigger
 * path (pm-triggers.ts) and the write-back (pm-write-back.ts) share it without importing each other.
 */
import type { pmTriggerSettings } from "@regulait/db";
import { pmTriggerSettingsSchema, type PmTriggerSettings } from "@regulait/pm-provider";

/** the stored row as the one validated settings document, or null when it no longer validates (then: ignored) */
export function settingsOf(row: typeof pmTriggerSettings.$inferSelect): PmTriggerSettings | null {
  const parsed = pmTriggerSettingsSchema.safeParse({
    ...(row.config !== null && typeof row.config === "object" ? (row.config as Record<string, unknown>) : {}),
    enabled: row.enabled,
    agentId: row.agentId,
  });
  return parsed.success ? parsed.data : null;
}
