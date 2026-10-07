/**
 * ADR-0186 M — the four detection monitor rules' loader (slice M, Codex).
 * FOUNDATION STUB.
 *
 * `runGovernanceMonitor` calls `detectionMonitorInput(db, now)` as an OPTIONAL
 * input (a failure leaves the four rules unevaluated for the pass and is
 * audited). It returns, per rule id it evaluated, the breaches
 * (`MonitorAssuranceInput`); a rule id it does not return is NOT evaluated, so
 * its open episodes are left as they are. The foundation reports NO BREACH for
 * each of `mcp_server_baseline_drift`, `sharing_scope_widened`,
 * `instructions_changed_after_approval` and `jailbreak_correlation` (the
 * ADR-0182 P0 precedent: the rules exist and raise nothing until their slice
 * lands; none can have an open episode before then). Thresholds: `org_settings.monitor_mcp_baseline_days`,
 * `monitor_jailbreak_threshold`, `monitor_jailbreak_window_hours`.
 */
import type { Db } from "@regulait/db";
import { DETECTION_MONITOR_RULE_IDS, type DetectionMonitorRuleId, type MonitorAssuranceInput } from "@regulait/shared";

export async function detectionMonitorInput(
  _db: Db,
  _now: Date,
): Promise<Partial<Record<DetectionMonitorRuleId, MonitorAssuranceInput>>> {
  return Object.fromEntries(DETECTION_MONITOR_RULE_IDS.map((id) => [id, { breaches: [] }])) as Partial<
    Record<DetectionMonitorRuleId, MonitorAssuranceInput>
  >;
}
