/**
 * ADR-0205 — the agent setup assistant's pure half.
 *
 * The admin describes a new agent in plain words; this module turns that into a
 * reviewable DRAFT of its configuration: name, tier, base system prompt,
 * purpose, risk tier, least-privilege grant advice, approval rule, a starting
 * monthly budget and the model-card fields. The rules half here is
 * deterministic and needs no model, exactly like ADR-0149's `suggestIntake`.
 * The gateway may ask a governed model to improve the text fields; the merge
 * below lets a model raise the risk tier, never lower it. Nothing here writes
 * anything: the admin still registers the agent through the ordinary form.
 */
import { z } from "zod";

export const AGENT_SETUP_RISK_TIERS = ["minimal", "limited", "high"] as const;
export type AgentSetupRiskTier = (typeof AGENT_SETUP_RISK_TIERS)[number];

export const agentSetupAssistRequestSchema = z
  .object({
    /** what the agent is for, in the admin's words; never written to the audit log */
    description: z.string().trim().min(10).max(4000),
    /** also ask a governed model to improve the draft's text */
    draftWithModel: z.boolean().optional(),
    /** the registry agent to draft with; absent = the `builder` feature's policy default */
    agentId: z.string().uuid().optional(),
  })
  .strict();
export type AgentSetupAssistRequest = z.infer<typeof agentSetupAssistRequestSchema>;

export type AgentSetupSource = "rules" | "model" | "mock";
export interface AgentSetupField<T> {
  value: T;
  source: AgentSetupSource;
  /** why the rules chose this value, when there is a reason worth showing */
  why?: string;
}

export interface AgentSetupDraft {
  name: AgentSetupField<string>;
  /** the registry's cost tier (0 = cheapest) */
  tier: AgentSetupField<number>;
  systemPrompt: AgentSetupField<string>;
  purpose: AgentSetupField<string>;
  riskTier: AgentSetupField<AgentSetupRiskTier>;
  grants: AgentSetupField<string>;
  approvalRule: AgentSetupField<string>;
  monthlyBudgetUsd: AgentSetupField<number>;
  intendedUse: AgentSetupField<string>;
  limitations: AgentSetupField<string>;
}

const SENSITIVE =
  /\b(personal data|pii|customer data|patient|health|medical|financ\w*|payment|credit|loan|bank\w*|salary|payroll|hiring|recruit\w*|employee|biometric|legal advice|insurance)\b/;
const ACTS = /\b(send|email|writ|delet|deploy|pay|transfer|updat|modif|creat|merg|approv|book|order|refund)\w*/;
const EXTERNAL = /\b(customer-facing|customers?|public|external|clients?|citizens?)\b/;

const RISK_RANK: Record<AgentSetupRiskTier, number> = { minimal: 0, limited: 1, high: 2 };

const APPROVAL_RULE: Record<AgentSetupRiskTier, string> = {
  minimal: "No approval needed; every call is still audited.",
  limited: "Actions that change data need a person's approval; reads run without one.",
  high: "Every tool call needs a person's approval before it runs.",
};
const BUDGET_USD: Record<AgentSetupRiskTier, number> = { minimal: 25, limited: 100, high: 200 };
const LIMITATIONS: Record<AgentSetupRiskTier, string> = {
  minimal: "Not evaluated beyond its stated purpose. Outputs may be wrong and are not reviewed by default.",
  limited:
    "Not evaluated beyond its stated purpose. Outputs may be wrong; actions that change data are reviewed by a person.",
  high:
    "Handles sensitive data or decisions about people. Outputs may be wrong or biased and must be reviewed by a person before they are relied on.",
};
const GRANTS =
  "Grant it to no one at registration. After review, grant it to named people or one role, and allow read-only tools first.";

function firstSentence(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  const cut = one.split(/(?<=[.!?])\s/)[0] ?? one;
  return cut.length > 200 ? `${cut.slice(0, 197).trimEnd()}...` : cut;
}

function slugName(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !["the", "and", "for", "that", "with", "agent", "this", "who", "which"].includes(w))
    .slice(0, 3);
  const base = words.join("-").slice(0, 48).replace(/-+$/, "");
  return `${base || "new"}-agent`;
}

function riskFor(text: string): { tier: AgentSetupRiskTier; why: string } {
  if (SENSITIVE.test(text)) return { tier: "high", why: "the description mentions sensitive data or decisions about people" };
  const acts = ACTS.test(text);
  const external = EXTERNAL.test(text);
  if (acts || external) {
    return {
      tier: "limited",
      why: acts ? "the description says the agent takes actions that change things" : "the agent faces people outside the team",
    };
  }
  return { tier: "minimal", why: "no sensitive data, actions or outside audience were described" };
}

function systemPromptFor(purpose: string, risk: AgentSetupRiskTier, acts: boolean): string {
  return [
    `Your purpose: ${purpose}`,
    "Stay within this purpose and say so when a request falls outside it.",
    "Never reveal credentials, secrets or personal data.",
    acts || risk !== "minimal" ? "Before any action that changes data, state what you will do and wait for confirmation." : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/** the deterministic draft: always available, no model involved */
export function suggestAgentSetup(req: Pick<AgentSetupAssistRequest, "description">): AgentSetupDraft {
  const text = req.description.toLowerCase();
  const purpose = firstSentence(req.description);
  const risk = riskFor(text);
  const rules = <T>(value: T, why?: string): AgentSetupField<T> => (why ? { value, source: "rules", why } : { value, source: "rules" });
  return {
    name: rules(slugName(req.description)),
    tier: rules(risk.tier === "high" ? 2 : 1, risk.tier === "high" ? "a higher tier for sensitive work" : undefined),
    systemPrompt: rules(systemPromptFor(purpose, risk.tier, ACTS.test(text))),
    purpose: rules(purpose),
    riskTier: rules(risk.tier, risk.why),
    grants: rules(GRANTS, "least privilege: nobody holds a new agent until someone is granted it"),
    approvalRule: rules(APPROVAL_RULE[risk.tier]),
    monthlyBudgetUsd: rules(BUDGET_USD[risk.tier], "a starting point for the per-user run budget; adjust it to real use"),
    intendedUse: rules(purpose),
    limitations: rules(LIMITATIONS[risk.tier]),
  };
}

/** what the model is asked for; every field optional, every string bounded */
const modelReplySchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/).optional(),
  purpose: z.string().trim().min(1).max(400).optional(),
  systemPrompt: z.string().trim().min(1).max(4000).optional(),
  riskTier: z.enum(AGENT_SETUP_RISK_TIERS).optional(),
  intendedUse: z.string().trim().min(1).max(1000).optional(),
  limitations: z.string().trim().min(1).max(1000).optional(),
});
export type AgentSetupModelReply = z.infer<typeof modelReplySchema>;

/** parse the model's reply; null when it is not the requested JSON object */
export function parseAgentSetupReply(text: string): AgentSetupModelReply | null {
  // first "{" to last "}": skips any prose or code fence around the object, with no regex over model output
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = modelReplySchema.safeParse(raw);
  if (!parsed.success) return null;
  return Object.values(parsed.data).some((v) => v !== undefined) ? parsed.data : null;
}

/**
 * Merge a parsed model reply into the rules draft. Text fields take the
 * model's wording, labelled with its source. The risk tier only moves UP: a
 * model can never talk an agent into lighter oversight than the rules chose,
 * and a raised tier brings its stricter approval rule and budget with it.
 */
export function mergeAgentSetupReply(
  draft: AgentSetupDraft,
  reply: AgentSetupModelReply,
  source: Exclude<AgentSetupSource, "rules">,
): { draft: AgentSetupDraft; fields: string[] } {
  const next: AgentSetupDraft = { ...draft };
  const fields: string[] = [];
  for (const k of ["name", "purpose", "systemPrompt", "intendedUse", "limitations"] as const) {
    const v = reply[k];
    if (v !== undefined) {
      next[k] = { value: v, source };
      fields.push(k);
    }
  }
  if (reply.riskTier && RISK_RANK[reply.riskTier] > RISK_RANK[draft.riskTier.value]) {
    const t = reply.riskTier;
    next.riskTier = { value: t, source, why: "raised by the model draft; a draft can raise the tier, never lower it" };
    next.approvalRule = { value: APPROVAL_RULE[t], source: "rules" };
    next.monthlyBudgetUsd = { value: BUDGET_USD[t], source: "rules" };
    fields.push("riskTier");
  }
  return { draft: next, fields };
}

/** the prompt sent through the governed dispatch */
export function buildAgentSetupPrompt(description: string, draft: AgentSetupDraft): string {
  return [
    "You help an administrator configure a governed AI agent. Reply with ONE JSON object and nothing else.",
    'Keys (all optional): "name" (lowercase-kebab, max 63 chars), "purpose" (one sentence), "systemPrompt"',
    '(the agent\'s base instructions, least privilege, no secrets), "riskTier" ("minimal" | "limited" | "high"),',
    '"intendedUse", "limitations".',
    "",
    "The administrator's description:",
    description,
    "",
    `The rule-based draft rates the risk tier "${draft.riskTier.value}". You may raise it, not lower it.`,
  ].join("\n");
}
