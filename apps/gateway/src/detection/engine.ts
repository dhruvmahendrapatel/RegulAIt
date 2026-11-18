/**
 * ADR-0333 — the deterministic evaluator: events in, matches out, no I/O and no clock.
 *
 * Whether an event matches a selector is decided by Cedar (`@regulait/policy-kernel/detection-cedar`), the engine ABAC,
 * rate limits and approval rules already run on. This module only orders those per-event answers into the three rule
 * shapes (`single`, `temporal_ordered`, `event_count`) over a bounded window.
 *
 * Events are one or more groups' committed audit rows in chain order. Only events whose seq is in `fresh` can
 * TRIGGER a match; older events are the look-back window. The same input always gives the same matches in the same
 * order.
 */
import { matchDetectionSelectors, type DetectionEventFacts, type DetectionSelectorInput } from "@regulait/policy-kernel/detection-cedar";
import type { DetectionPack, DetectionRule, DetectionSeverity } from "./pack.js";

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

/** decides, for each event, which selector positions it matches (injectable for tests; Cedar by default) */
export type DetectionSelectorMatcher = (
  selectors: readonly DetectionSelectorInput[],
  classes: Readonly<Record<string, readonly string[]>>,
  events: readonly DetectionEventFacts[],
) => Array<ReadonlySet<number>>;

/** (rule id, first evidence seq) pairs already raised, so one opening event does not raise a rule twice */
export type RaisedKeys = Set<string>;
export const raisedKey = (ruleId: string, firstSeq: number): string => `${ruleId}#${firstSeq}`;

const facts = (e: DetectionEvent): DetectionEventFacts => ({
  objectType: e.objectType,
  effect: e.effect,
  ruleId: e.ruleId,
  toolName: e.toolName,
  phase: e.phase,
  dataScoped: e.dataScoped,
  addonSeverity: e.addonSeverity,
  delegated: e.delegationGrantId !== null,
});

/** one entry per selector in rule order: the position Cedar answers for */
interface IndexedRule {
  rule: DetectionRule;
  /** selector positions, one per step (`single` and `event_count` have one) */
  selectors: number[];
}

function indexRules(pack: DetectionPack): { rules: IndexedRule[]; selectors: DetectionSelectorInput[] } {
  const selectors: DetectionSelectorInput[] = [];
  const rules = pack.rules
    .filter((r) => r.enabled)
    .map((rule) => {
      const own = rule.type === "temporal_ordered" ? rule.steps.map((s) => s.selector) : [rule.selector];
      return { rule, selectors: own.map((s) => selectors.push(s) - 1) };
    });
  return { rules, selectors };
}

/** the episode key of an `event_count` rule in one group */
export const episodeKey = (ruleId: string, group: string): string => `${ruleId}\u0000${group}`;
/** `episodeKey` -> the trigger time (ms) of the latest not-closed incident: a burst is one incident per window */
export type DetectionEpisodes = Map<string, number>;

/** Evaluate every enabled rule. `events` must be sorted by seq ascending. */
export function evaluateDetections(
  pack: DetectionPack,
  events: readonly DetectionEvent[],
  fresh: ReadonlySet<number>,
  raised: RaisedKeys = new Set(),
  matcher: DetectionSelectorMatcher = matchDetectionSelectors,
  episodes: DetectionEpisodes = new Map(),
): DetectionMatch[] {
  const { rules, selectors } = indexRules(pack);
  const answers = matcher(selectors, pack.toolClasses, events.map(facts));
  const matchedBy = new Map<number, ReadonlySet<number>>();
  events.forEach((e, i) => matchedBy.set(e.seq, answers[i]!));
  const hits = (selector: number, e: DetectionEvent) => matchedBy.get(e.seq)!.has(selector);

  const byGroup = new Map<string, DetectionEvent[]>();
  const position = new Map<number, number>();
  for (const e of events) {
    const list = byGroup.get(e.group) ?? [];
    if (list.length === 0) byGroup.set(e.group, list);
    position.set(e.seq, list.length);
    list.push(e);
  }
  const out: DetectionMatch[] = [];
  for (const e of events) {
    if (!fresh.has(e.seq)) continue;
    const history = byGroup.get(e.group)!;
    const idx = position.get(e.seq)!;
    for (const r of rules) {
      const evidence = matchRule(r, history, idx, hits);
      if (!evidence) continue;
      const key = raisedKey(r.rule.id, evidence[0]!.seq);
      if (raised.has(key)) continue;
      if (r.rule.type === "event_count") {
        // A sliding window keeps reaching the threshold while a probe goes on, each time with a different first
        // event: one open incident per (rule, group) per timespan, not one per denied call (review of #865).
        const ep = episodeKey(r.rule.id, e.group);
        const last = episodes.get(ep);
        if (last !== undefined && Math.abs(e.at - last) < r.rule.timespanSeconds * 1000) continue;
        episodes.set(ep, e.at);
      }
      raised.add(key);
      out.push({ rule: r.rule, group: e.group, trigger: e, evidence });
    }
  }
  return out;
}

function matchRule(
  { rule, selectors }: IndexedRule,
  history: readonly DetectionEvent[],
  idx: number,
  hits: (selector: number, e: DetectionEvent) => boolean,
): DetectionEvent[] | null {
  const e = history[idx]!;
  if (rule.type === "single") return hits(selectors[0]!, e) ? [e] : null;
  const since = e.at - rule.timespanSeconds * 1000;
  if (rule.type === "event_count") {
    if (!hits(selectors[0]!, e)) return null;
    const window: DetectionEvent[] = [];
    for (let i = idx; i >= 0 && history[i]!.at >= since; i--) if (hits(selectors[0]!, history[i]!)) window.push(history[i]!);
    // At or above the threshold; the episode check in evaluateDetections keeps it to one incident per window. The
    // evidence is the `threshold` most recent matching events.
    return window.length >= rule.threshold ? window.slice(0, rule.threshold).reverse() : null;
  }
  // temporal_ordered: the trigger matches the last step; walk back, taking the latest earlier event for each step.
  const last = selectors.length - 1;
  if (!hits(selectors[last]!, e)) return null;
  const chain: DetectionEvent[] = [e];
  let cursor = idx - 1;
  for (let s = last - 1; s >= 0; s--) {
    const next = chain[0]!;
    const needDifferent = rule.steps[s + 1]!.differentServer === true;
    let found: DetectionEvent | null = null;
    for (; cursor >= 0; cursor--) {
      const c = history[cursor]!;
      if (c.at < since) return null;
      if (!hits(selectors[s]!, c)) continue;
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
