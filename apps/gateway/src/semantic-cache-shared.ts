/**
 * ADR-0119 — THE SEMANTIC CACHE'S GOVERNANCE BOUNDARY, IN ONE PLACE.
 *
 * This module exists because the cache was about to have TWO implementations.
 * The invoke path had it inline; the compat/IDE path needed it; and the thing
 * being duplicated is not a lookup, it is a GOVERNANCE BOUNDARY — a row is
 * servable only to the same user, for the same agent, within the TTL, and only
 * after the stored request commitment is re-checked against the candidate as
 * a hash-collision guard. (Both paths now key on a SHA-512 commitment to the
 * exact request — ADR-0136 for compat, ADR-0146 for native — never on
 * normalised text.) Two copies of that rule would drift, and the copy that
 * drifted would serve one user's answer to another.
 *
 * So the key derivation, the scoped lookup, the collision guard and the store
 * live here and BOTH paths call them. Nothing policy-bearing beyond the cache's
 * own scoping is decided here: the shared governed-dispatch core rechecks live
 * policy before either caller can serve a hit. Each caller then renders a
 * denial in its own JSON or vendor-compatible wire shape.
 */

import { createHash } from "node:crypto";
import { agents, and, customModelProviders, eq, gte, semanticCache, type Db } from "@regulait/db";
import { canonicalJson } from "@regulait/shared";
import { loadVersions, resolveAgentPromptVersion } from "./config-versions.js";

export interface SemanticCacheKey {
  /** the normalized text actually stored, and re-compared on a candidate hit */
  readonly norm: string;
  /** sha256 of `norm` — the indexed lookup key */
  readonly hash: string;
}

/**
 * AER-041 / ADR-0146 — WHAT A NATIVE `/invoke` ANSWER ACTUALLY DEPENDS ON.
 *
 * The first native key was `trim().toLowerCase()` of `body.input` alone. That
 * made "is `getUserId` defined?" and "is `getuserid` defined?" the same
 * question, served a `maxTokens: 4000` answer to a `maxTokens: 50` request,
 * ignored the caller's `system`, `baseline`, reference content and attachments
 * — all of which reach the model — and survived the agent being re-pointed at
 * a different model or given a different system prompt. The live governance
 * gates still ran on a hit, but they judged the CURRENT configuration while
 * handing back bytes produced under an old one.
 *
 * So the native key is now a commitment to two things, and nothing is
 * normalised away:
 *
 *  1. THE REQUEST: every body field that reaches the model or changes which
 *     bytes are sent, verbatim, plus the attributed project and the org/user
 *     planner settings that rewrite the outgoing input (edit-vs-rewrite and
 *     file preprocessing). Fields that only change DELIVERY or bookkeeping
 *     (`stream`, `semanticCache`, `dispatch`, `instanceId`) are deliberately
 *     out — they cannot change the answer, and including them would only cost
 *     hits. A conversation never reaches this path (the caller excludes it).
 *  2. THE CONFIGURATION THAT WOULD SERVE IT: provider, model, custom endpoint
 *     identity, the base system prompt, the active `agent_config` version and
 *     the prompt version this user's stable key resolves to (canary included).
 *     These are re-read at lookup time, so any change makes every old row an
 *     honest miss — and changing it BACK makes them valid again, because the
 *     configuration they were produced under is once more the one that serves.
 *
 * Only a SHA-512 commitment is stored, exactly as the compat key does: the
 * request can carry private system text and attachments, and a hash is all
 * the collision guard needs. Rows written under the old normalised-text key
 * can never equal a `native-v2:` commitment, so they miss closed and age out
 * through the TTL; nothing has to be deleted for the upgrade to be safe.
 */
export interface NativeCacheRequest {
  readonly input: string;
  readonly mode: string;
  readonly system: string | null;
  readonly baseline: string | null;
  readonly referenceContent: string | null;
  readonly attachments: ReadonlyArray<{
    readonly kind: string;
    readonly name: string;
    readonly mediaType: string;
    readonly dataBase64: string;
  }>;
  readonly maxTokens: number | null;
  readonly costSensitivity: string | null;
  readonly projectId: string | null;
  /** the org dials and per-user mode that decide whether the outgoing input is
   * rewritten — the model sees the REWRITTEN bytes, so they are part of the
   * request even though the caller never typed them */
  readonly planner: Readonly<Record<string, string | number | boolean | null>>;
}

export interface NativeCacheConfig {
  readonly agentId: string;
  readonly provider: string;
  readonly model: string | null;
  readonly customProvider: { readonly id: string; readonly wireProtocol: string; readonly baseUrl: string } | null;
  /** the column, which is what serves when no prompt version exists */
  readonly systemPrompt: string | null;
  readonly agentConfigVersion: { readonly id: string; readonly version: number } | null;
  readonly promptVersion: { readonly id: string; readonly version: number; readonly canary: boolean } | null;
}

/**
 * Re-read, from the database, the configuration a native dispatch of
 * `agentId` for `userId` would execute under right now. Null when the agent
 * is gone — the caller then neither serves nor stores.
 *
 * The prompt version is resolved with the SAME stable key the dispatch core
 * uses for a non-run, non-conversation call (the user), so a user on the
 * canary side of a split gets the canary's identity and never a control-side
 * answer, and vice versa. The `agent_config` identity is the ACTIVE version: a
 * canary candidate there is shadow-only and never serves (ADR-0073 B1).
 */
export async function loadNativeCacheConfig(
  db: Db,
  args: { agentId: string; userId: string },
): Promise<NativeCacheConfig | null> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, args.agentId));
  if (!agent) return null;
  let customProvider: NativeCacheConfig["customProvider"] = null;
  if (agent.customProviderId) {
    const [cp] = await db
      .select({
        id: customModelProviders.id,
        wireProtocol: customModelProviders.wireProtocol,
        baseUrl: customModelProviders.baseUrl,
      })
      .from(customModelProviders)
      .where(eq(customModelProviders.id, agent.customProviderId));
    // A dangling reference is still an identity: it must not collide with "no
    // custom provider", so the id is kept even when the row is gone.
    customProvider = cp ?? { id: agent.customProviderId, wireProtocol: "missing", baseUrl: "missing" };
  }
  const cfgVersions = await loadVersions(db, "agent_config", agent.id);
  const activeCfg = cfgVersions.find((v) => v.status === "active") ?? null;
  const prompt = await resolveAgentPromptVersion(db, {
    agentId: agent.id,
    userId: args.userId,
    runId: null,
    conversationId: null,
  });
  return {
    agentId: agent.id,
    provider: agent.provider,
    model: agent.model ?? null,
    customProvider,
    systemPrompt: agent.systemPrompt ?? null,
    agentConfigVersion: activeCfg ? { id: activeCfg.id, version: activeCfg.version } : null,
    promptVersion: prompt
      ? { id: prompt.versionId, version: prompt.version, canary: prompt.canary }
      : null,
  };
}

/** The native key: a versioned commitment to the request AND the config. */
export function semanticCacheNativeKey(
  request: NativeCacheRequest,
  config: NativeCacheConfig,
): SemanticCacheKey {
  const commitment = canonicalJson({ v: "native-v2", request, config });
  const norm = `native-v2:${createHash("sha512").update(commitment).digest("hex")}`;
  return { norm, hash: createHash("sha256").update(norm).digest("hex") };
}

/** Compat responses depend on the complete request, not a normalized search
 * phrase. Keep only a SHA-512 commitment in the cache row: the full canonical
 * request may contain private system instructions and message content. The
 * separate SHA-256 index and SHA-512 comparison preserve the collision guard
 * without persisting that additional plaintext. */
export function semanticCacheRequestKey(request: unknown): SemanticCacheKey {
  const norm = `compat-v2:${createHash("sha512").update(canonicalJson(request)).digest("hex")}`;
  return { norm, hash: createHash("sha256").update(norm).digest("hex") };
}

export interface SemanticCacheHit {
  readonly outputText: string;
  /** nullable in the row, so nullable here — a cached answer whose model was
   * not recorded is still servable; inventing a model name would be worse. */
  readonly model: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** when the entry was written — reported on the savings row so an operator
   * can see how stale the answer they were served is */
  readonly createdAt: Date;
}

/**
 * THE SCOPED READ. `userId` AND `agentId` AND a row inside the TTL, then the
 * stored `normalizedInput` is compared to the candidate before anything is
 * returned — a sha256 collision must not be able to hand back another prompt's
 * answer, however improbable. Returns null on any of those failing.
 */
export async function lookupSemanticCache(
  db: Db,
  args: {
    userId: string;
    /** the agent the CALLER asked for, not the one routing served — the cache
     * is scoped to what was requested, exactly as the invoke path scopes it */
    agentId: string;
    key: SemanticCacheKey;
    ttlSeconds: number;
  },
): Promise<SemanticCacheHit | null> {
  const ttlCutoff = new Date(Date.now() - args.ttlSeconds * 1000);
  const [hit] = await db
    .select()
    .from(semanticCache)
    .where(
      and(
        eq(semanticCache.userId, args.userId),
        eq(semanticCache.agentId, args.agentId),
        eq(semanticCache.promptHash, args.key.hash),
        gte(semanticCache.createdAt, ttlCutoff),
      ),
    )
    .limit(1);
  if (!hit) return null;
  // the collision guard — never skip this
  if (hit.normalizedInput !== args.key.norm) return null;
  return {
    outputText: hit.outputText,
    model: hit.model,
    inputTokens: hit.inputTokens,
    outputTokens: hit.outputTokens,
    createdAt: hit.createdAt,
  };
}

/**
 * THE STORE. Refusals, empty outputs and PII-withheld markers are never
 * stored — caching a withheld marker would serve the withholding forever, and
 * caching a refusal would make one transient provider failure permanent.
 */
export async function storeSemanticCache(
  db: Db,
  args: {
    userId: string;
    agentId: string;
    key: SemanticCacheKey;
    outputText: string;
    model: string | null;
    inputTokens: number;
    outputTokens: number;
  },
): Promise<void> {
  if (!args.outputText) return;
  await db
    .insert(semanticCache)
    .values({
      userId: args.userId,
      agentId: args.agentId,
      promptHash: args.key.hash,
      normalizedInput: args.key.norm,
      outputText: args.outputText,
      model: args.model,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
    })
    .onConflictDoUpdate({
      target: [semanticCache.userId, semanticCache.agentId, semanticCache.promptHash],
      set: {
        normalizedInput: args.key.norm,
        outputText: args.outputText,
        model: args.model,
        inputTokens: args.inputTokens,
        outputTokens: args.outputTokens,
        createdAt: new Date(),
      },
    });
}

/**
 * A hit saves the WHOLE call — no provider was contacted — so the estimate is
 * the cached input+output tokens at the requested agent's list price. Null
 * dollars when the agent is unpriced: the cache row stores no price, and
 * inventing one would put a fabricated number on the Spend page.
 */
export function semanticCacheSavings(
  agent: { costPerMTokIn: number | null; costPerMTokOut: number | null },
  hit: { inputTokens: number; outputTokens: number },
): { savedTokens: number; estimatedCostSavedUsd: number | null } {
  const savedTokens = hit.inputTokens + hit.outputTokens;
  const estimatedCostSavedUsd =
    agent.costPerMTokIn != null && agent.costPerMTokOut != null
      ? Number(
          (
            (hit.inputTokens / 1e6) * agent.costPerMTokIn +
            (hit.outputTokens / 1e6) * agent.costPerMTokOut
          ).toFixed(6),
        )
      : null;
  return { savedTokens, estimatedCostSavedUsd };
}
