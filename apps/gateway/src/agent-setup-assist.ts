/**
 * ADR-0205 — THE AGENT SETUP ASSISTANT (owner request 2026-10-30).
 *
 * Suggestion-only, on the ADR-0149 pattern: `POST /v1/agents/setup-assist`
 * returns a draft of a new agent's configuration and writes nothing but one
 * audit row (counts and outcome, never the admin's description). The rules half
 * (`suggestAgentSetup`) always runs. A model draft is optional and is an
 * ordinary governed dispatch of a registry agent the admin is entitled to
 * (`agentDecision` + `executeGovernedDispatch`, model allow-list feature
 * `builder`), so it is attributed, budgeted, screened and audited like any
 * other call. The agent itself is created only when the admin submits the
 * Register form (`POST /v1/agents`).
 *
 * Secure by default (ADR-0180): both routes are admin-only (not in
 * NON_ADMIN_ROUTES), and the draft route refuses 409 until an admin turns on
 * `agentSetupAssistEnabled` through PUT /v1/org/settings (step-up, audited).
 */
import type { FastifyInstance } from "fastify";
import { agents, auditLog, eq, modelCredentials, type Db } from "@regulait/db";
import {
  agentSetupAssistRequestSchema,
  buildAgentSetupPrompt,
  mergeAgentSetupReply,
  parseAgentSetupReply,
  suggestAgentSetup,
} from "@regulait/shared";
import { executeGovernedDispatch } from "./agents-connectors.js";
import { agentDecision, featureDefaultModel } from "./copilot.js";
import { loadOrgSettings } from "./org-settings.js";

const GATE = { feature: "builder" as const };

export function registerAgentSetupAssistRoutes(app: FastifyInstance, db: Db, opts: { dataKey?: string } = {}): void {
  // what the Register card needs to decide whether to offer the assistant
  app.get("/v1/agents/setup-assist", async () => {
    const org = await loadOrgSettings(db);
    const creds = await db.select({ provider: modelCredentials.provider }).from(modelCredentials);
    return {
      enabled: org.agentSetupAssistEnabled,
      connectedProviders: creds.map((c) => c.provider).sort(),
    };
  });

  app.post("/v1/agents/setup-assist", async (req, reply) => {
    const userId = req.authCtx.userId;
    if (!userId) {
      return reply.status(403).send({
        error: "agent_setup_assist_requires_identity",
        detail: "the assistant drafts on behalf of a person; a token with no user identity cannot use it",
      });
    }
    const org = await loadOrgSettings(db);
    if (!org.agentSetupAssistEnabled) {
      return reply.status(409).send({
        error: "agent_setup_assist_disabled",
        detail: "the agent setup assistant is off; an admin turns it on in organisation settings",
      });
    }
    const body = agentSetupAssistRequestSchema.parse(req.body ?? {});
    let draft = suggestAgentSetup(body);

    type ModelDraft =
      | { status: "not_requested" }
      | { status: "skipped" | "refused" | "failed" | "unparseable"; reason: string }
      | { status: "drafted"; source: "model" | "mock"; agentId: string; fields: string[] };
    let model: ModelDraft = { status: "not_requested" };
    if (body.draftWithModel) {
      const [named] = body.agentId ? await db.select().from(agents).where(eq(agents.id, body.agentId)) : [];
      const agent = named ?? (body.agentId ? undefined : await featureDefaultModel(db, userId, GATE));
      if (!agent) {
        model = { status: "skipped", reason: body.agentId ? "unknown agent" : "no agent chosen and the agent builder has no default model" };
      } else {
        const decision = await agentDecision(db, userId, agent, GATE);
        if (decision.effect !== "allow") {
          await db.insert(auditLog).values({
            userId,
            objectType: "agent",
            objectId: agent.id,
            detail: { surface: "agent_setup_assist", agentName: agent.name, receiptClass: "decision" },
            effect: "deny",
            ruleId: decision.ruleId,
            ruleChain: decision.ruleChain,
            reason: decision.reason,
          });
          model = { status: "refused", reason: decision.reason };
        } else {
          // a direct call the admin asked for: decided as the person, no agent principal acts
          const outcome = await executeGovernedDispatch(db, opts.dataKey, {
            userId,
            served: agent,
            requestedAgentId: agent.id,
            baseline: null,
            input: buildAgentSetupPrompt(body.description, draft),
            maxTokens: 2048,
            projectId: null,
            modelFeature: GATE,
            detail: { purpose: "agent-setup-assist" },
          });
          if (!outcome.ok) {
            model = { status: "failed", reason: `${outcome.error}${outcome.detail ? ` — ${outcome.detail}` : ""}` };
          } else {
            const parsed = parseAgentSetupReply(outcome.result.outputText);
            if (!parsed) {
              model = {
                status: "unparseable",
                reason: "the model reply was not the requested JSON; the rule-based draft is shown instead",
              };
            } else {
              const source = agent.provider === "mock" ? ("mock" as const) : ("model" as const);
              const merged = mergeAgentSetupReply(draft, parsed, source);
              draft = merged.draft;
              model = { status: "drafted", source, agentId: agent.id, fields: merged.fields };
            }
          }
        }
      }
    }

    // one row per assist: the outcome and the suggested risk tier, never the description
    await db.insert(auditLog).values({
      userId,
      objectType: "agent",
      objectId: null,
      // advisory, like an evaluate: no decision was made and nothing was applied, so it is not a receipt
      detail: { phase: "agent-setup-assist", riskTier: draft.riskTier.value, model: model.status, receiptClass: "excluded" },
      effect: "allow",
      ruleId: "agent-setup-assisted",
      ruleChain: [],
      reason: `agent setup assistant suggested risk tier '${draft.riskTier.value}' (model draft: ${model.status}); nothing was saved`,
    });

    return {
      draft,
      model,
      disclaimer:
        "Suggestions only. Nothing is saved until you register the agent, and grants, approvals, budget and the " +
        "model card stay for you to set on their own cards. Model-drafted text is labelled and may be wrong.",
    };
  });
}
