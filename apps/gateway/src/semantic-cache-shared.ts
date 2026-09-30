/**
 * ADR-0119 — THE SEMANTIC CACHE'S GOVERNANCE BOUNDARY, IN ONE PLACE.
 *
 * This module exists because the cache was about to have TWO implementations.
 * The invoke path had it inline; the compat/IDE path needed it; and the thing
 * being duplicated is not a lookup, it is a GOVERNANCE BOUNDARY — a row is
 * servable only to the same user, for the same agent, within the TTL, and only
 * after the stored normalized input is re-checked against the candidate as a
 * hash-collision guard. Two copies of that rule would drift, and the copy that
 * drifted would serve one user's answer to another.
 *
 * So the key derivation, the scoped lookup, the collision guard and the store
 * live here and BOTH paths call them. Nothing policy-bearing beyond the cache's
 * own scoping is decided here: the shared governed-dispatch core rechecks live
 * policy before either caller can serve a hit. Each caller then renders a
 * denial in its own JSON or vendor-compatible wire shape.
 */

import { createHash } from "node:crypto";
import { and, eq, gte, semanticCache, type Db } from "@regulait/db";
import { canonicalJson } from "@regulait/shared";

export interface SemanticCacheKey {
  /** the normalized text actually stored, and re-compared on a candidate hit */
  readonly norm: string;
  /** sha256 of `norm` — the indexed lookup key */
  readonly hash: string;
}

/** Normalization is deliberately conservative: trim, lower-case, collapse
 * runs of whitespace. It must stay IDENTICAL for both paths or a prompt typed
 * in an IDE would miss a cache entry the same prompt stored from the API. */
export function semanticCacheKey(input: string): SemanticCacheKey {
  const norm = input.trim().toLowerCase().replace(/\s+/g, " ");
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
