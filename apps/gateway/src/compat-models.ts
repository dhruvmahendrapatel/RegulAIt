/**
 * ADR-0066 §1 — `GET /v1/models`, THE DISCOVERY ENDPOINT.
 *
 * Every off-the-shelf OpenAI-compatible client calls this at setup: the
 * `openai` python/node SDKs' `client.models.list()`, Cursor's and Continue's
 * "verify base URL" step, LangChain's model-availability probe. Without it,
 * pointing a tool at RegulAIt fails BEFORE the first completion, on a request
 * that has nothing to do with governance — which for a freeware product is an
 * adoption blocker rather than a missing feature.
 *
 * WHAT MAKES OURS DIFFERENT FROM LITELLM'S. The list is ENTITLEMENT-FILTERED
 * per caller, through the same `evaluateAgent` the dispatch path runs. Under
 * default-deny, a model the caller was not granted is simply ABSENT — not
 * listed and then 403'd on use. Two users with different grants get different
 * lists, and neither can see the other's; `gateway-parity.test.ts` proves that
 * rather than asserting it. On a virtual key the list narrows again, to the
 * INTERSECTION of the key's allow-list with the owner's entitlements, so a
 * client's model picker shows exactly what that credential can actually call.
 *
 * TWO SHAPES, ONE ROUTE. OpenAI and Anthropic both define `GET /v1/models` and
 * they disagree on the envelope. They are distinguished by the
 * `anthropic-version` header, which the Anthropic SDK sends on EVERY request
 * and no OpenAI client ever sends — a real protocol marker, not a guess. The
 * `x-api-key` credential header the Anthropic SDK uses is accepted here for the
 * same reason `POST /v1/messages` accepts it.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  agentGrants,
  agents,
  auditLog,
  eq,
  userAgentPolicies,
  type Db,
} from "@regulait/db";
import { evaluateAgent } from "@regulait/policy-kernel";
import {
  loadAgentRevocations,
  loadRoleAgentGrants,
} from "./entitlements.js";
import { COMPAT_FEATURE, COMPAT_MODE } from "./compat-core.js";
import { loadModelPolicy, withModelPolicy } from "./model-policy.js";
import {
  loadVirtualKeyContext,
  virtualKeyAdmits,
  type VirtualKeyContext,
} from "./virtual-keys.js";
import { EVALUATION_ONLY_EXECUTION } from "./execution-posture.js";

/** The header the Anthropic SDK sends on every request, and the ONLY thing
 * this module uses to choose an envelope. Absent ⇒ OpenAI shape, which is the
 * right default: it is the shape the overwhelming majority of "compatible"
 * tooling speaks, and the one a bare `curl` most likely wants. */
const ANTHROPIC_VERSION_HEADER = "anthropic-version";

export type ModelsShape = "openai" | "anthropic";

export function modelsShapeFor(req: FastifyRequest): ModelsShape {
  return typeof req.headers[ANTHROPIC_VERSION_HEADER] === "string" ? "anthropic" : "openai";
}

export interface EntitledModel {
  /** the provider-native model id a client sends back as `model` */
  model: string;
  /** the agents behind it — several registry entries may share a model id */
  agentIds: string[];
  agentNames: string[];
  provider: string;
  /** lowest tier among the agents serving this model (the compat tie-break) */
  tier: number;
  createdAt: Date;
}

/**
 * The one entitlement-filtered listing, shared by both envelopes and by the
 * tests. Returns models the caller may ACTUALLY dispatch: enabled, carrying a
 * provider-native model id, allowed by the policy kernel for this user, and —
 * when the call arrived on a virtual key — admitted by that key's allow-list.
 *
 * A decision-only agent (`model` NULL, ADR-0016) is deliberately EXCLUDED: it
 * cannot be dispatched, so advertising it in a discovery endpoint would hand a
 * client a model id that is guaranteed to fail.
 */
export async function listEntitledModels(
  db: Db,
  userId: string,
  vk: VirtualKeyContext | null,
): Promise<EntitledModel[]> {
  const [registry, grants, roleGrants, revocations, [policy]] = await Promise.all([
    db.select().from(agents).where(eq(agents.enabled, true)),
    db.select().from(agentGrants).where(eq(agentGrants.userId, userId)),
    loadRoleAgentGrants(db, userId),
    loadAgentRevocations(db, userId),
    db.select().from(userAgentPolicies).where(eq(userAgentPolicies.userId, userId)),
  ]);
  let ceilingTier: number | null = null;
  if (policy?.ceilingAgentId) {
    const [ceiling] = await db
      .select({ tier: agents.tier })
      .from(agents)
      .where(eq(agents.id, policy.ceilingAgentId));
    ceilingTier = ceiling?.tier ?? null;
  }

  // ADR-0173 §3: and the org's "compat" model allow-list, through the same helper
  const modelPolicy = await loadModelPolicy(db);
  const byModel = new Map<string, EntitledModel>();
  for (const a of registry) {
    if (!a.model) continue;
    // THE FILTER. Identical inputs to the dispatch path's own check, so what a
    // client sees listed and what it may call cannot drift.
    const kernelDecision = evaluateAgent({
      userId,
      /**
       * ADR-0124 — VISIBILITY, not execution. This is the `/v1/models` listing
       * an IDE reads to populate its picker. Emptying it during a halt would
       * look to the developer like their entitlements had been revoked, and
       * would leave the client with nothing to name in the call that should
       * come back with a clear "this deployment is halted".
       */
      execution: EVALUATION_ONLY_EXECUTION,
      agent: { id: a.id, name: a.name, tier: a.tier, enabled: a.enabled, modes: a.modes ?? null },
      mode: COMPAT_MODE,
      agentGrants: grants,
      roleAgentGrants: roleGrants,
      agentRevocations: revocations,
      ceilingTier,
    });
    const decision = withModelPolicy(kernelDecision, modelPolicy, COMPAT_FEATURE, a);
    if (decision.effect !== "allow") continue;
    // §2's intersection, applied to discovery as well as to dispatch: a key
    // must not advertise a model it would refuse.
    if (vk && !virtualKeyAdmits(vk, { id: a.id, model: a.model })) continue;

    const existing = byModel.get(a.model);
    if (!existing) {
      byModel.set(a.model, {
        model: a.model,
        agentIds: [a.id],
        agentNames: [a.name],
        provider: a.provider,
        tier: a.tier,
        createdAt: a.createdAt,
      });
      continue;
    }
    existing.agentIds.push(a.id);
    existing.agentNames.push(a.name);
    if (a.tier < existing.tier) existing.tier = a.tier;
    if (a.createdAt.getTime() < existing.createdAt.getTime()) existing.createdAt = a.createdAt;
  }
  // deterministic ordering — clients render this in a picker
  return [...byModel.values()].sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
}

export function registerModelsDiscovery(app: FastifyInstance, db: Db) {
  app.get("/v1/models", async (req, reply) => {
    // The disabled-surface 404 is applied by app.ts's interception gate in the
    // onRequest phase, before auth — as with the two POST surfaces, a
    // deployment that has not enabled interception does not admit that this
    // route exists.
    const userId = req.authCtx.userId;
    if (!userId) {
      // The bootstrap token has no user identity, and this endpoint's entire
      // contract is "what may YOU call". Answering with the whole registry
      // would be the one place in this system where a list is not
      // entitlement-scoped, so it refuses instead.
      return reply.status(403).send({
        error: {
          type: "bootstrap_cannot_list",
          message:
            "the bootstrap token has no user identity, and this list is per-caller — use a per-user RegulAIt API key or a virtual key",
        },
      });
    }
    const vk = await loadVirtualKeyContext(db, req);
    const models = await listEntitledModels(db, userId, vk);

    // One audit row per listing. A discovery call is a read of the caller's own
    // entitlement surface, and "who enumerated what they could reach, and when"
    // is exactly the kind of question this product exists to answer.
    await db.insert(auditLog).values({
      userId,
      objectType: "agent",
      objectId: null,
      detail: {
        surface: "compat",
        phase: "models-list",
        shape: modelsShapeFor(req),
        count: models.length,
        ...(vk ? { virtualKeyId: vk.id } : {}),
      },
      effect: "allow",
      ruleId: "models-listed",
      ruleChain: [],
      reason: `listed ${models.length} entitled model(s)${vk ? ` under virtual key '${vk.name}'` : ""}`,
    });

    if (modelsShapeFor(req) === "anthropic") {
      // Anthropic's list envelope: `data[{type,id,display_name,created_at}]`
      // plus the pagination triple. We return everything in one page, so
      // `has_more` is honestly false rather than omitted.
      const data = models.map((m) => ({
        type: "model" as const,
        id: m.model,
        display_name: m.agentNames[0] ?? m.model,
        created_at: m.createdAt.toISOString(),
        regulait: { agent_ids: m.agentIds, provider: m.provider, tier: m.tier },
      }));
      return reply.send({
        data,
        has_more: false,
        first_id: data[0]?.id ?? null,
        last_id: data[data.length - 1]?.id ?? null,
      });
    }

    return reply.send({
      object: "list",
      data: models.map((m) => ({
        id: m.model,
        object: "model" as const,
        created: Math.floor(m.createdAt.getTime() / 1000),
        owned_by: m.provider,
        // A RegulAIt extension. OpenAI clients ignore unknown fields, and this
        // is the only way a caller in `require_agent` resolution mode can learn
        // the agent id it must send in `x-regulait-agent-id`.
        regulait: { agent_ids: m.agentIds, tier: m.tier },
      })),
    });
  });
}
