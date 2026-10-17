/**
 * The enterprise harness's record mode (ADR-0196), kept apart from ratchet.ts so it has no `@playwright/test` import
 * and the scripts test suite (scripts/ui-enterprise-harness.test.mjs) can cover every branch: record mode is a
 * fail-open switch (every browser check passes unseen), so its CI refusal is tested, not only read.
 */

/** whether this run only records; throws when record mode is switched on in CI for anything but an --update run */
export function recordMode(env: Record<string, string | undefined> = process.env): boolean {
  const record = env.ENTERPRISE_RECORD;
  if (!record || record === "0") return false;
  if (!env.CI) return true;
  if (record === "update" && env.GITHUB_EVENT_NAME === "workflow_dispatch") return true;
  throw new Error(
    "ENTERPRISE_RECORD is set in CI: record mode would pass every browser check unseen by the baseline guard. " +
      "It is allowed in CI only as ENTERPRISE_RECORD=update on a manual run that rewrites the baselines with --update (ADR-0196).",
  );
}
