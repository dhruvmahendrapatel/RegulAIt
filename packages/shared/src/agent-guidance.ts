/**
 * ADR-0354 — AGENT GUIDANCE: the one validator for the text an `advise` or `correct` response returns to an agent.
 *
 * Guidance is a channel back INTO the agent's context, so it is treated as the injection surface it is:
 *
 *  - it is static, admin-authored policy text, stored with the policy version. It is never model output and never
 *    built from call arguments: there is no interpolation (no `${…}`, `{{…}}` or `%s` placeholders);
 *  - it is plain text, never HTML or markup: `<` and `>` are refused outright, so no surface can ever render it as
 *    markup, and every surface sends it as a JSON string;
 *  - it is one line of printable text: control characters and newlines are refused, and it is NFC-normalised;
 *  - it passes the SAME admission scan as an MCP tool description or a skill (`scanAdmissionUnits`, ADR-0097 /
 *    ADR-0175): prompt-injection phrasing, hidden or bidi Unicode, exfiltration directives and credentials are
 *    refused at write time. The rule that flags text for addressing the model is skipped, exactly as for a skill,
 *    because guidance is by definition addressed to the agent.
 *
 * Open-source check (ADR-0176): DOMPurify / sanitize-html sanitise HTML into safe HTML; we want no HTML at all, so
 * refusing markup characters is the stricter and smaller rule. zod (already pinned here) does the shape.
 */
import { z } from "zod";
import { scanAdmissionUnits, type McpAdmissionFinding } from "./mcp-admission.js";
import { SKILL_SKIPPED_MCP_RULES } from "./skill-admission.js";

export const AGENT_GUIDANCE_MESSAGE_MAX = 500;
export const AGENT_GUIDANCE_ALTERNATIVE_MAX = 300;

/** printable, single-line, no markup, no placeholders */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u;
const MARKUP_RE = /[<>]/u;
const PLACEHOLDER_RE = /\$\{|\{\{|\}\}|%[sdifoOj]/u;

function plainText(max: number) {
  return z
    .string()
    .transform((s) => s.normalize("NFC").trim())
    .pipe(
      z
        .string()
        .min(1)
        .max(max)
        .refine((s) => !CONTROL_RE.test(s), "guidance is one line of printable text (no control characters or newlines)")
        .refine((s) => !MARKUP_RE.test(s), "guidance is plain text: '<' and '>' are not allowed (it is never HTML)")
        .refine((s) => !PLACEHOLDER_RE.test(s), "guidance is static text: placeholders such as ${…}, {{…}} or %s are not allowed"),
    );
}

export const agentGuidanceSchema = z
  .object({
    message: plainText(AGENT_GUIDANCE_MESSAGE_MAX),
    alternative: plainText(AGENT_GUIDANCE_ALTERNATIVE_MAX).optional(),
  })
  .strict();

export type AgentGuidanceInput = z.input<typeof agentGuidanceSchema>;
export type ValidAgentGuidance = z.output<typeof agentGuidanceSchema>;

export type AgentGuidanceResult =
  | { ok: true; guidance: ValidAgentGuidance }
  | { ok: false; errors: string[]; findings: McpAdmissionFinding[] };

/**
 * Validate guidance for storage. Total: never throws. A refusal names every problem, and any admission-scan finding
 * (of any severity: this text goes straight into an agent's context) refuses it.
 */
export function parseAgentGuidance(input: unknown): AgentGuidanceResult {
  const parsed = agentGuidanceSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "guidance"}: ${i.message}`), findings: [] };
  }
  const units = [
    { where: "message", text: parsed.data.message },
    ...(parsed.data.alternative ? [{ where: "alternative", text: parsed.data.alternative }] : []),
  ];
  // the scan reads the RAW input too, so hidden Unicode removed by trim/normalise is still caught
  const raw = input as { message?: unknown; alternative?: unknown };
  const rawUnits = [
    ...(typeof raw.message === "string" ? [{ where: "message", text: raw.message }] : []),
    ...(typeof raw.alternative === "string" ? [{ where: "alternative", text: raw.alternative }] : []),
  ];
  const findings = scanAdmissionUnits("agent-guidance", [...units, ...rawUnits], { skipRules: SKILL_SKIPPED_MCP_RULES });
  if (findings.length > 0) {
    const rules = [...new Set(findings.map((f) => f.rule))];
    return { ok: false, errors: [`guidance failed the admission scan: ${rules.join(", ")}`], findings };
  }
  return { ok: true, guidance: parsed.data };
}
