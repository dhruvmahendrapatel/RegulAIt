/**
 * ADR-0181: every relaxation of a strict default is audited as old -> new.
 *
 * `settingTransitions(before, submitted)` maps each SUBMITTED key whose value
 * actually changes to `{ from, to }`. Only the submitted keys are looked at
 * (a write never reports a column it did not touch), and values are compared
 * by their JSON form so arrays and objects compare by content. Keys named in
 * `omit` (secrets, large blobs) are left out entirely.
 */
export function settingTransitions(
  before: object,
  submitted: object,
  omit: readonly string[] = [],
): Record<string, { from: unknown; to: unknown }> {
  const prior = before as Record<string, unknown>;
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const [key, to] of Object.entries(submitted)) {
    if (to === undefined || omit.includes(key)) continue;
    const from = prior[key] ?? null;
    if (JSON.stringify(from) !== JSON.stringify(to)) out[key] = { from, to };
  }
  return out;
}
