/**
 * ADR-0327 slice 4b: serve an approved rule-like step from its measured rule.
 *
 * A step is served by its rule only when all of these hold, re-checked on every call:
 *  - its suggestion is `switched` and its latest switch request is `switched` (a reviewer approved it, ADR-0327 4a);
 *  - the suggestion's rule still hashes to the digest the reviewer approved (`rule_step_switches.rule_sha256`);
 *  - the request's input parses into the rule's fields and an exact-match cell covers it.
 * Anything else returns null and the AI answers, exactly as before the switch. A covered answer is only a candidate:
 * the caller hands it to the one dispatch core as `cachedResponse`, so every input gate and the output PII and
 * guardrail checks still run on it. Nothing here makes a permission decision, and nothing here calls a model.
 *
 * Kept apart from `rule-steps.ts` (the admin routes) so the request path imports no route module.
 */
import { createHash } from "node:crypto";
import {
  and,
  costEvents,
  decisionTables,
  decisionTableVersions,
  desc,
  eq,
  ruleStepSuggestions,
  ruleStepSwitches,
  sql,
  traceSpans,
  type Db,
} from "@regulait/db";
import { applyInducedRule, compileDecisionTable, extractStepFields, type DecisionTableBody, type InducedRule } from "@regulait/optimizer-kernel";
import { canonicalJson } from "@regulait/shared";

/**
 * What a reviewer approves when they approve a switch: sha256 hex over ADR-0060's `canonicalJson` of the suggestion's
 * rule. Stored on the request and as the approval's ADR-0104 consent fingerprint (`arguments_digest`); the decide path
 * recomputes it from the suggestion and refuses to switch on a mismatch, and the serve path refuses to serve on one.
 */
export function ruleStepRuleDigest(rule: unknown): string {
  return createHash("sha256").update(canonicalJson(rule)).digest("hex");
}

/** The `trace_spans.attributes` key that marks a span answered by a rule, not by the AI. */
export const RULE_STEP_SPAN_ATTRIBUTE = "ruleStep";

/**
 * A span the switched rule answered is not an AI run. Detection and shadow counts read AI runs only, or a switched
 * rule would measure itself and its agreement would drift towards 100%.
 */
export const NOT_RULE_SERVED_SPAN = sql`NOT coalesce(jsonb_exists(${traceSpans.attributes}, ${RULE_STEP_SPAN_ATTRIBUTE}), false)`;

/**
 * What answered: one switch request, and its subject — a detector suggestion (slice 4b) or a published decision-table
 * version (slice 4d). Exactly one subject is set. Carried on the span (`ruleStep`), the audit row and the saving.
 */
export interface RuleStepRef {
  readonly switchId: string;
  readonly suggestionId: string | null;
  readonly decisionTableVersionId: string | null;
}

export interface RuleStepAnswer {
  readonly ref: RuleStepRef;
  readonly output: string;
  /** the step's measured average AI cost per run over its scan window; null when no run was priced */
  readonly avgCostPerRunUsd: number | null;
}

const avgCost = (s: { runs: number; windowCostUsd: number }) =>
  s.runs > 0 && s.windowCostUsd > 0 ? Number((s.windowCostUsd / s.runs).toFixed(6)) : null;

/**
 * The switched rule's answer for this input, or null when the AI must answer. A switched suggestion is tried first,
 * then a switched decision table; the switch routes refuse a second switch on a step that already has one, so at most
 * one is live (this order only settles a race between two concurrent requests).
 */
export async function switchedRuleAnswer(
  db: Db,
  step: { agentId: string; stepName: string; inputText: string },
): Promise<RuleStepAnswer | null> {
  if (step.inputText.length === 0) return null;
  const fields = extractStepFields(step.inputText);
  if (fields === null) return null;
  const [s] = await db
    .select({
      id: ruleStepSuggestions.id,
      status: ruleStepSuggestions.status,
      rule: ruleStepSuggestions.rule,
      runs: ruleStepSuggestions.runs,
      windowCostUsd: ruleStepSuggestions.windowCostUsd,
    })
    .from(ruleStepSuggestions)
    // one suggestion per step (rule_step_suggestions_step_uq)
    .where(and(eq(ruleStepSuggestions.agentId, step.agentId), eq(ruleStepSuggestions.stepName, step.stepName)));
  if (s?.status === "switched") {
    const [w] = await db
      .select({ id: ruleStepSwitches.id, status: ruleStepSwitches.status, ruleSha256: ruleStepSwitches.ruleSha256 })
      .from(ruleStepSwitches)
      .where(eq(ruleStepSwitches.suggestionId, s.id))
      .orderBy(desc(ruleStepSwitches.requestedAt), desc(ruleStepSwitches.id))
      .limit(1);
    if (w && w.status === "switched" && w.ruleSha256 === ruleStepRuleDigest(s.rule)) {
      const applied = applyInducedRule(s.rule as InducedRule, fields);
      if (!applied.matched) return null;
      return { ref: { switchId: w.id, suggestionId: s.id, decisionTableVersionId: null }, output: applied.output, avgCostPerRunUsd: avgCost(s) };
    }
  }
  // a switched decision table: only its published version, only while that version still hashes to the digest the
  // switch was approved for (a newer published version reverts the switch; see `revertSwitchOfSupersededVersion`)
  const [t] = await db
    .select({ switchId: ruleStepSwitches.id, ruleSha256: ruleStepSwitches.ruleSha256, versionId: decisionTableVersions.id, body: decisionTableVersions.body })
    .from(decisionTables)
    .innerJoin(decisionTableVersions, and(eq(decisionTableVersions.tableId, decisionTables.id), eq(decisionTableVersions.status, "published")))
    .innerJoin(ruleStepSwitches, and(eq(ruleStepSwitches.decisionTableVersionId, decisionTableVersions.id), eq(ruleStepSwitches.status, "switched")))
    .where(and(eq(decisionTables.agentId, step.agentId), eq(decisionTables.stepName, step.stepName)))
    .limit(1);
  if (!t || t.ruleSha256 !== ruleStepRuleDigest(t.body)) return null;
  const compiled = compileDecisionTable(t.body as DecisionTableBody);
  if (!compiled.ok) return null;
  const applied = applyInducedRule(compiled.rule, fields);
  if (!applied.matched) return null;
  return {
    ref: { switchId: t.switchId, suggestionId: null, decisionTableVersionId: t.versionId },
    output: applied.output,
    // the table was written, not measured: the step's own measurement, when the detector has one, prices the saving
    avgCostPerRunUsd: s ? avgCost(s) : null,
  };
}

/**
 * The one savings record for a rule-served answer, shared by every serve path (compat and native invoke), so the
 * ledger row cannot drift between them. Nothing was spent, so no `usage_events` row is written; the saving is the
 * step's measured average AI cost per run. `surface` names the path that served it.
 */
export async function recordRuleStepSaving(
  db: Db,
  args: {
    userId: string;
    requestedAgentId: string;
    servedAgentId: string;
    projectId: string | null;
    ruleAnswer: RuleStepAnswer;
    surface: string;
  },
): Promise<void> {
  await db.insert(costEvents).values({
    userId: args.userId,
    objectType: "agent",
    objectId: args.servedAgentId,
    technique: "rule_replacement",
    requestedAgentId: args.requestedAgentId,
    servedAgentId: args.servedAgentId,
    baselineAgentId: args.servedAgentId,
    estimatedCostSavedUsd: args.ruleAnswer.avgCostPerRunUsd,
    estimationBasis:
      "rule-replacement: a switched rule-like step answered by its approved exact-match rule or decision table — the step's " +
      "measured average AI cost per run over its scan window saved (null when no run was priced)",
    ruleId: "rule-step-served",
    projectId: args.projectId,
    detail: { ...args.ruleAnswer.ref, surface: args.surface },
  });
}
