/**
 * ADR-0333 — the deterministic evaluator. Pure: events in, matches out, no I/O and no clock.
 *
 * Events are one group's (or several groups') committed audit rows in chain order. Only events whose seq is in the
 * `fresh` set can TRIGGER a match; older events are the look-back window that earlier steps and counts read. The
 * same input always yields the same matches in the same order.
 */
import { SEVERITY_RANK, globMatch, type DetectionPack, type DetectionRule, type DetectionSelector, type DetectionSeverity } from "./pack.js";

export interface DetectionEvent {
  auditId: string;
  seq: number;
  /** epoch ms of the audit row's `at` (database clock) */
  at: number;
  group: string;
  userId: string;
  objectType: string;
  effect: "allow" | "deny" | "require_approval";
  ruleId: string;
  toolName: string | null;
  serverId: string | null;
  phase: string | null;
  dataScoped: boolean;
  addonSeverity: DetectionSeverity | null;
  delegationGrantId: string | null;
  actorIdentityId: string | null;
  actorChain: string[] | null;
}

export interface DetectionMatch {
  rule: DetectionRule;
  group: string;
  trigger: DetectionEvent;
  /** the evidence chain in step order; the trigger is last */
  evidence: DetectionEvent[];
}

/** (rule id, first evidence seq) pairs already raised, so one opening event does not raise a rule twice */
export type RaisedKeys = Set<string>;
export const raisedKey = (ruleId: string, firstSeq: number): string => `${ruleId}#${firstSeq}`;

function matchesSelector(s: DetectionSelector, e: DetectionEvent, classes: DetectionPack["toolClasses"]): boolean {
  if (s.objectType && !s.objectType.includes(e.objectType)) return false;
  if (s.effect && !s.effect.includes(e.effect)) return false;
  if (s.ruleId && !s.ruleId.includes(e.ruleId)) return false;
  if (s.phase && (e.phase === null || !s.phase.includes(e.phase))) return false;
  if (s.dataScoped !== undefined && s.dataScoped !== e.dataScoped) return false;
  if (s.delegated !== undefined && s.delegated !== (e.delegationGrantId !== null)) return false;
  if (s.addonSeverityAtLeast) {
    if (e.addonSeverity === null || SEVERITY_RANK[e.addonSeverity] < SEVERITY_RANK[s.addonSeverityAtLeast]) return false;
  }
  if (s.toolClass) {
    if (e.toolName === null) return false;
    const name = e.toolName.toLowerCase();
    if (!(classes[s.toolClass] ?? []).some((g) => globMatch(g, name))) return false;
  }
  return true;
}

/**
 * Evaluate every enabled rule. `events` must be sorted by seq ascending (the caller's SQL orders them). Matches are
 * returned in (trigger seq, rule order) order.
 */
export function evaluateDetections(
  pack: DetectionPack,
  events: readonly DetectionEvent[],
  fresh: ReadonlySet<number>,
  raised: RaisedKeys = new Set(),
): DetectionMatch[] {
  const rules = pack.rules.filter((r) => r.enabled);
  const byGroup = new Map<string, DetectionEvent[]>();
  const position = new Map<number, number>();
  for (const e of events) {
    const list = byGroup.get(e.group) ?? [];
    if (list.length === 0) byGroup.set(e.group, list);
    position.set(e.seq, list.length);
    list.push(e);
  }
  const out: DetectionMatch[] = [];
  const classes = pack.toolClasses;
  for (const e of events) {
    if (!fresh.has(e.seq)) continue;
    const history = byGroup.get(e.group)!;
    const idx = position.get(e.seq)!;
    for (const rule of rules) {
      const evidence = matchRule(rule, history, idx, classes);
      if (!evidence) continue;
      const key = raisedKey(rule.id, evidence[0]!.seq);
      if (raised.has(key)) continue;
      raised.add(key);
      out.push({ rule, group: e.group, trigger: e, evidence });
    }
  }
  return out;
}

function matchRule(
  rule: DetectionRule,
  history: readonly DetectionEvent[],
  idx: number,
  classes: DetectionPack["toolClasses"],
): DetectionEvent[] | null {
  const e = history[idx]!;
  if (rule.type === "single") return matchesSelector(rule.selector, e, classes) ? [e] : null;
  const since = e.at - rule.timespanSeconds * 1000;
  if (rule.type === "event_count") {
    if (!matchesSelector(rule.selector, e, classes)) return null;
    const window: DetectionEvent[] = [];
    for (let i = idx; i >= 0 && history[i]!.at >= since; i--) {
      if (matchesSelector(rule.selector, history[i]!, classes)) window.push(history[i]!);
    }
    // Fire when the count reaches the threshold, not on every event above it.
    return window.length === rule.threshold ? window.reverse() : null;
  }
  // temporal_ordered: the trigger matches the last step; walk back, taking the latest earlier event for each step.
  const steps = rule.steps;
  if (!matchesSelector(steps[steps.length - 1]!.selector, e, classes)) return null;
  const chain: DetectionEvent[] = [e];
  let cursor = idx - 1;
  for (let s = steps.length - 2; s >= 0; s--) {
    const next = chain[0]!;
    const needDifferent = steps[s + 1]!.differentServer === true;
    let found: DetectionEvent | null = null;
    for (; cursor >= 0; cursor--) {
      const c = history[cursor]!;
      if (c.at < since) return null;
      if (!matchesSelector(steps[s]!.selector, c, classes)) continue;
      if (needDifferent && c.serverId !== null && c.serverId === next.serverId) continue;
      found = c;
      cursor--;
      break;
    }
    if (!found) return null;
    chain.unshift(found);
  }
  return chain;
}
