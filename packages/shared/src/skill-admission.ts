/**
 * ADR-0175 A6 — ADMISSION SCANNING FOR BUILDER SKILLS: the pure half.
 *
 * A builder skill is model-directed text: its body is pasted into the system
 * prompt of every agent it is attached to, including agents other people use.
 * That is the same position an MCP tool description is in, so it gets the
 * same gate. The scan is `scanAdmissionUnits` from mcp-admission.ts — the
 * ADR-0097 rule set, called rather than copied — plus two detector families a
 * free-form markdown body needs and a tool manifest does not:
 *
 *   - `skill.confusable.*` — words that mix Latin letters with Cyrillic or
 *     Greek look-alikes, and full-width Latin letters. A reviewer reading
 *     "p<U+0430>ypal" sees a familiar word; a tokenizer and a URL parser do not.
 *   - `skill.exfil_url.*` — URLs built to carry data out: a link whose path or
 *     query holds a placeholder for the model to fill (`{{conversation}}`,
 *     `${SECRET}`), and a markdown image that fetches an external URL with a
 *     query string (the image loads with no click, so the query is the
 *     payload).
 *
 * VERDICT. The product's severity vocabulary, with a skill's own thresholds:
 *   - `high` or `critical` → REFUSED (422 `skill_admission_refused`, nothing
 *     stored). A skill is authored here, not fetched from an upstream, so the
 *     honest place to stop a poisoned body is the save.
 *   - `medium` → HELD: stored, but it cannot be attached and never reaches a
 *     prompt until an admin admits it with a reason.
 *   - `low` or nothing → CLEAN.
 *
 * These are heuristic DETECTORS, with every limit ADR-0042 and ADR-0097 state:
 * literal English, no obfuscation handling, false positives on a skill that
 * legitimately discusses these topics. That is why `medium` holds for a human
 * rather than refusing, and why admitting is a reason-required admin act.
 *
 * COUNTS AND LOCATIONS ONLY. A finding names the rule, the severity and where
 * it matched (`name`, `description`, `body`) with a count — never the text.
 */

import {
  maxSeverity,
  scanAdmissionUnits,
  severityAtLeast,
  type McpAdmissionFinding,
  type McpAdmissionSeverity,
} from "./mcp-admission.js";

/** The scanner + ruleset version stamped on a scanned skill. Bump it when a
 * skill rule changes (the ADR-0097 rules carry their own version). */
export const SKILL_ADMISSION_SCANNER_VERSION = "skill-admission/1";

/**
 * The persisted verdict on `builder_skills.admission_state` (and on each
 * attachment's `snapshot_admission_state`).
 *
 *  - `unscanned` — the MIGRATION's default for rows that predate the scanner.
 *    Usable until the ADR-0100 sweep (or the next edit) scans it.
 *  - `clean`     — scanned; nothing at `medium` or above.
 *  - `held`      — scanned; a `medium` finding. Not attachable, not run.
 *  - `refused`   — scanned; a `high`/`critical` finding. A save never stores
 *    one (it is refused with 422); a stored row only reaches this state when a
 *    re-scan finds something in a body that was clean under older rules.
 *  - `admitted`  — an admin reviewed a held skill and admitted it with a
 *    reason, audited. Pinned to the digest that was admitted: a changed body is
 *    scanned from scratch.
 */
export const SKILL_ADMISSION_STATES = ["unscanned", "clean", "held", "refused", "admitted"] as const;
export type SkillAdmissionState = (typeof SKILL_ADMISSION_STATES)[number];

/** the states a skill body may reach a prompt (or be attached) in */
export const SKILL_USABLE_STATES: readonly SkillAdmissionState[] = ["unscanned", "clean", "admitted"];

export function skillStateUsable(state: string): boolean {
  return (SKILL_USABLE_STATES as readonly string[]).includes(state);
}

/** `high` and above refuses the save */
export const SKILL_ADMISSION_REFUSE_AT: McpAdmissionSeverity = "high";
/** `medium` and above (below the refusal line) holds for an admin */
export const SKILL_ADMISSION_HOLD_AT: McpAdmissionSeverity = "medium";

/**
 * The one ADR-0097 phrase rule a skill skips: `mcp.tool_order.model_directive`
 * flags a tool description that ADDRESSES THE MODEL ("the agent must read …").
 * In a tool description that is the poisoning tell; in a skill it is the whole
 * point of the text, so it would fire on nearly every legitimate skill. Every
 * other rule (tool ordering, sensitive paths, exfiltration, hidden Unicode,
 * the ADR-0042 injection and credential detectors) runs unchanged.
 */
export const SKILL_SKIPPED_MCP_RULES = ["mcp.tool_order.model_directive"] as const;

interface SkillRule {
  id: string;
  severity: McpAdmissionSeverity;
  count: (text: string) => number;
}

function countRe(re: RegExp): (text: string) => number {
  return (text) => {
    re.lastIndex = 0;
    let n = 0;
    while (re.exec(text) !== null) {
      n++;
      if (n > 10_000 || re.lastIndex === 0) break;
    }
    return n;
  };
}

const LATIN = /\p{Script=Latin}/u;
const LOOKALIKE = /[\p{Script=Cyrillic}\p{Script=Greek}]/u;
const WORD = /[\p{L}\p{M}]{2,}/gu;

/** words that mix Latin letters with Cyrillic or Greek letters */
function mixedScriptWords(text: string): number {
  let n = 0;
  WORD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WORD.exec(text)) !== null) {
    if (LATIN.test(m[0]) && LOOKALIKE.test(m[0])) n++;
    if (n > 10_000) break;
  }
  return n;
}

const SKILL_RULES: readonly SkillRule[] = [
  { id: "skill.confusable.mixed_script", severity: "medium", count: mixedScriptWords },
  // full-width Latin letters (U+FF21–U+FF3A, U+FF41–U+FF5A)
  { id: "skill.confusable.fullwidth", severity: "medium", count: countRe(/[\uFF21-\uFF3A\uFF41-\uFF5A]/gu) },
  // a URL whose path or query holds a placeholder for the model to fill
  {
    id: "skill.exfil_url.template",
    severity: "high",
    count: countRe(/https?:\/\/[^\s)"'<>\]]*(?:\{\{?\s*[\w.-]{1,60}\s*\}?\}|\$\{?[A-Za-z_][\w]{1,60}\}?|%7B%7B|<[\w.-]{1,40}>)/gi),
  },
  // a markdown image that fetches an external URL carrying a query string
  {
    id: "skill.exfil_url.image_query",
    severity: "medium",
    count: countRe(/!\[[^\]]{0,200}\]\(\s*https?:\/\/[^)\s]*\?[^)\s]+\)/gi),
  },
];

export interface SkillScanInput {
  name: string;
  description?: string | null;
  body: string;
}

export interface SkillAdmissionScan {
  scannerVersion: string;
  findings: McpAdmissionFinding[];
  severity: McpAdmissionSeverity | null;
  /** clean | held | refused — what a save of this text would store */
  verdict: "clean" | "held" | "refused";
}

/** Scan one skill's name, description and body. Pure and total. */
export function scanSkill(input: SkillScanInput): SkillAdmissionScan {
  const subject = input.name || "<unnamed>";
  const units = [
    { where: "name", text: input.name ?? "" },
    { where: "description", text: input.description ?? "" },
    { where: "body", text: input.body ?? "" },
  ].filter((u) => u.text.length > 0);
  const findings = scanAdmissionUnits(subject, units, { skipRules: SKILL_SKIPPED_MCP_RULES });
  for (const unit of units) {
    for (const rule of SKILL_RULES) {
      const count = rule.count(unit.text);
      if (count > 0) findings.push({ rule: rule.id, severity: rule.severity, tool: subject, where: unit.where, count });
    }
  }
  const severity = maxSeverity(findings);
  const verdict = severityAtLeast(severity, SKILL_ADMISSION_REFUSE_AT)
    ? "refused"
    : severityAtLeast(severity, SKILL_ADMISSION_HOLD_AT)
      ? "held"
      : "clean";
  return { scannerVersion: SKILL_ADMISSION_SCANNER_VERSION, findings, severity, verdict };
}

/**
 * The state a scan implies, given what the row already said. An `admitted`
 * skill keeps its admission only while its digest is the one an admin
 * admitted, and only for a HOLD: a re-scan that now refuses is never covered
 * by an earlier admission of a lesser finding.
 */
export function nextSkillState(args: {
  scan: SkillAdmissionScan;
  digest: string;
  admittedDigest: string | null;
}): SkillAdmissionState {
  if (args.scan.verdict === "held" && args.admittedDigest !== null && args.admittedDigest === args.digest) {
    return "admitted";
  }
  return args.scan.verdict;
}

/** counts-only findings for a refusal body: rule, severity, where, count */
export function skillFindingCounts(findings: readonly McpAdmissionFinding[]) {
  return findings.map((f) => ({ rule: f.rule, severity: f.severity, where: f.where, count: f.count }));
}

/** the skill-specific rule ids (the ADR-0097 ids come from mcpAdmissionRuleIds) */
export function skillAdmissionRuleIds(): string[] {
  return SKILL_RULES.map((r) => r.id);
}
