/**
 * ADR-0193 addendum (lane E50, OWASP Agentic ASI06 memory poisoning): the content-trust floor and the injection scan
 * on the two routes that persist text an agent later reads as context.
 *
 *   POST /v1/projects/:projectId/context (and .../context/promote)   the Shared Project context store (pillar 4)
 *   POST /v1/builder/agents/:id/memory                               an agent's memory, part of its system prompt
 *
 * Nothing here is a second floor or a second scanner (ADR-0176). The floor is `contextContentTiers` +
 * `contentTrustWriteFloor` + `evaluateContentTrust`, exactly what `contentTrustGate` runs for a write tool call; the
 * scan is `resolveGuardrailPolicy` + `runGuardrailsAsync`, the guardrail input phase, narrowed to the two
 * injection-family detectors (prompt injection and jailbreak). Both are secure by default (ADR-0180): the floor is
 * `trusted` and both detectors `block`. An admin relaxes them through the existing, audited settings
 * (`PUT /v1/content-trust/settings`, step-up; `PUT /v1/guardrails/config`); there is no separate memory switch, so a
 * memory write can never sit below the posture a write tool call has.
 *
 * `evaluateMemoryWrite` is the decision, with no database I/O; the gateway probe for the
 * `memory.untrusted_context_write` proof calls it, so the proof exercises the live code (ADR-0345).
 */
import { auditLog, type Db } from "@regulait/db";
import {
  CONTENT_TRUST_REFUSAL_CODE,
  CONTENT_TRUST_RULE_ID,
  contentTrustRefusalReason,
  evaluateContentTrust,
  GUARDRAIL_DETECTOR_IDS,
  guardrailCategoryList,
  type ContentTrustTier,
  type ContentTrustWriteFloor,
  type GuardrailEvaluation,
  type GuardrailModes,
} from "@regulait/shared";
import { contentTrustWriteFloor, contextContentTiers } from "./content-provenance.js";
import { guardrailOutcome, recordGuardrailDecision, resolveGuardrailPolicy, runGuardrailsAsync, type GuardrailPolicy } from "./guardrails.js";

/** the detectors a memory or shared-context write is scanned with: the injection family, nothing else */
export const MEMORY_WRITE_DETECTORS = ["prompt_injection", "jailbreak"] as const;

export const MEMORY_GUARDRAIL_REFUSAL_CODE = "guardrail_blocked";

export type MemoryWriteTarget =
  | { kind: "shared_context"; projectId: string; key: string }
  | { kind: "agent_memory"; agentId: string; projectId: string | null };

export type MemoryWriteVerdict =
  | { ok: true; scan: GuardrailEvaluation }
  | { ok: false; code: typeof CONTENT_TRUST_REFUSAL_CODE; lowest: ContentTrustTier; floor: ContentTrustWriteFloor; reason: string }
  | { ok: false; code: typeof MEMORY_GUARDRAIL_REFUSAL_CODE; scan: GuardrailEvaluation; reason: string };

/** the org policy with every detector outside the injection family off (modes and trained modes alike) */
export function memoryScanPolicy(policy: GuardrailPolicy): GuardrailPolicy {
  const narrow = (modes: GuardrailModes): GuardrailModes =>
    Object.fromEntries(
      GUARDRAIL_DETECTOR_IDS.map((d) => [d, (MEMORY_WRITE_DETECTORS as readonly string[]).includes(d) ? modes[d] : "off"]),
    ) as GuardrailModes;
  const modes = narrow(policy.modes);
  return {
    ...policy,
    modes,
    ...(policy.trainedModes ? { trainedModes: narrow(policy.trainedModes) } : {}),
    // customer classifiers are their own detectors (ADR-0363), not the injection family
    classifiers: undefined,
    active: MEMORY_WRITE_DETECTORS.some((d) => modes[d] !== "off"),
  };
}

export function memoryWriteTargetLabel(target: MemoryWriteTarget): string {
  return target.kind === "shared_context" ? `shared context '${target.key}'` : `agent memory (${target.agentId})`;
}

/**
 * The decision. The floor first: like the write-tool gate it is categorical, so the scan never runs on a write the
 * floor already refuses. Then the injection scan on the text being persisted.
 */
export async function evaluateMemoryWrite(input: {
  floor: ContentTrustWriteFloor;
  contextTiers: readonly ContentTrustTier[];
  policy: GuardrailPolicy;
  text: string;
  target: string;
}): Promise<MemoryWriteVerdict> {
  const trust = evaluateContentTrust("write", input.contextTiers, input.floor);
  if (!trust.ok) {
    return { ok: false, code: CONTENT_TRUST_REFUSAL_CODE, lowest: trust.lowest, floor: trust.floor, reason: contentTrustRefusalReason(trust.lowest, trust.floor, input.target) };
  }
  const scan = await runGuardrailsAsync(memoryScanPolicy(input.policy), "input", input.text);
  if (scan.action === "block") {
    return {
      ok: false,
      code: MEMORY_GUARDRAIL_REFUSAL_CODE,
      scan,
      reason: `write '${input.target}' blocked by guardrail: ${guardrailCategoryList(scan.blocking)}`,
    };
  }
  return { ok: true, scan };
}

/**
 * The gate at the route. Reads the causal context's tiers, the floor and the org guardrail policy, decides, and
 * writes the evidence: a deny row for a floor refusal (the same shape as the write-tool refusal), and the guardrail
 * decision row for any scan finding (block, warn or log), as every other guardrail site does.
 */
export async function memoryWriteGate(
  db: Db,
  args: { userId: string; contextId: string | null; text: string; target: MemoryWriteTarget },
): Promise<MemoryWriteVerdict> {
  const projectId = args.target.projectId;
  const [contextTiers, floor, policy] = await Promise.all([
    args.contextId ? contextContentTiers(db, args.contextId) : Promise.resolve([] as ContentTrustTier[]),
    contentTrustWriteFloor(db),
    resolveGuardrailPolicy(db, { projectId, userId: args.userId }),
  ]);
  const target = memoryWriteTargetLabel(args.target);
  const verdict = await evaluateMemoryWrite({ floor, contextTiers, policy, text: args.text, target });
  const objectType = args.target.kind === "shared_context" ? ("project" as const) : ("builder_agent" as const);
  const objectId = args.target.kind === "shared_context" ? args.target.projectId : args.target.agentId;
  const where = { surface: args.target.kind, ...(args.target.kind === "shared_context" ? { key: args.target.key } : {}) };
  if (!verdict.ok && verdict.code === CONTENT_TRUST_REFUSAL_CODE) {
    await db.insert(auditLog).values({
      userId: args.userId,
      objectType,
      objectId,
      detail: {
        ...where,
        phase: "content-trust",
        code: CONTENT_TRUST_REFUSAL_CODE,
        contextId: args.contextId,
        lowestTier: verdict.lowest,
        writeFloor: verdict.floor,
        projectId,
        receiptClass: "decision",
      },
      effect: "deny",
      ruleId: CONTENT_TRUST_RULE_ID,
      ruleChain: [],
      reason: verdict.reason,
    });
    return verdict;
  }
  const scan = verdict.scan;
  const outcome = guardrailOutcome(scan);
  if (outcome) {
    await recordGuardrailDecision(db, { userId: args.userId, objectType, objectId, projectId, evaluation: scan, outcome, detail: where });
  }
  return verdict;
}

/** the HTTP answer for a refusal: 403, the code, the reason (category counts only, never the text) */
export function memoryWriteRefusal(verdict: Exclude<MemoryWriteVerdict, { ok: true }>): { status: 403; body: Record<string, unknown> } {
  return verdict.code === CONTENT_TRUST_REFUSAL_CODE
    ? { status: 403, body: { error: verdict.code, detail: verdict.reason, lowestTier: verdict.lowest, writeFloor: verdict.floor } }
    : { status: 403, body: { error: verdict.code, detail: verdict.reason } };
}
