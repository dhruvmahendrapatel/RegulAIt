/**
 * ADR-0352 (lane E33 slice 2): the meaning-based cache tier, the gateway half.
 *
 * Where it sits: behind the exact cache on the native invoke path. When the exact
 * lookup misses and the org has turned the tier on (off by default), the input is
 * embedded by the deployment's LOCAL embedder and compared with the vectors of the
 * cache rows in its mandatory partition. A match is then served through exactly
 * the exact tier's hit path, which runs the live governance gates (ADR-0138) on the
 * NEW input and the cached output: entitlement, guardrails, PII mode and budget.
 *
 * The partition is not a setting. A row is only a candidate when it has the same
 * user and the same agent (the parent `semantic_cache` row's columns) AND the same
 * partition commitment: everything in the ADR-0146 exact key except the input text,
 * i.e. the attributed project, mode, system, baseline, reference content,
 * attachments, max tokens, cost sensitivity, the planner dials and the serving
 * configuration. A different user, project, option or configuration never matches.
 * (One deployment is one tenant, ADR-0041, so the deployment is the tenant boundary.)
 *
 * "Local only" is enforced, not documented: the embedder's host must resolve to
 * private or loopback addresses only, checked on every request inside the
 * DNS-pinned guarded fetch, so a registration that points at (or is re-pointed at)
 * a public service is refused before a byte of the prompt leaves.
 *
 * Failure is a MISS, never an error: an embedder that is down, slow or
 * non-conforming means the call is dispatched for real (and fully governed).
 */
import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  and,
  desc,
  eq,
  externalScorers,
  gte,
  semanticCache,
  semanticCacheEmbeddings,
  type Db,
} from "@regulait/db";
import {
  EMBED_INPUT_MAX_CHARS,
  SIMILARITY_CANDIDATES_MAX,
  TEXT_EMBEDDING_SCORER_KIND,
  bestSimilar,
  canonicalJson,
  parseEmbeddingReply,
} from "@regulait/shared";
import { loadEgressAllowList } from "./custom-providers.js";
import { classifyAddressLan, createGuardedFetch, egressRefusal, type EgressResolver } from "./egress-guard.js";
import { errMessage } from "./err-serializer.js";
import { decryptSecret } from "./secrets.js";
import type { NativeCacheConfig, NativeCacheRequest, SemanticCacheHit } from "./semantic-cache-shared.js";

/** the embed call is on the request path: a slow embedder is a miss, not a wait */
export const EMBED_TIMEOUT_MS = 2_000;

export interface LocalEmbedder {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKey: string | null;
  readonly fetchImpl: typeof fetch;
}

const systemResolver: EgressResolver = async (host) => {
  const res = await dnsLookup(host, { all: true, verbatim: true });
  return res.map((r) => ({ address: r.address, family: r.family }));
};

/**
 * A resolver that only ever yields private or loopback addresses. Any public (or
 * unclassifiable) address fails the resolution, so the guarded fetch refuses the
 * destination; the check runs on the very addresses the fetch then pins.
 */
export function localOnlyResolver(inner: EgressResolver = systemResolver): EgressResolver {
  return async (host) => {
    const addresses = await inner(host);
    const outside = addresses.filter((a) => {
      const c = classifyAddressLan(a.address);
      return c.never !== null || !c.privateLan;
    });
    if (outside.length > 0) {
      throw new Error(
        `the embedder must be local (private or loopback addresses only); '${host}' resolved to ${outside.map((a) => a.address).join(", ")}`,
      );
    }
    return addresses;
  };
}

/**
 * The resolver above never runs for an IP-literal URL, so a literal host is
 * classified here. Null = local; otherwise the refusal.
 */
export function localLiteralRefusal(baseUrl: string): string | null {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return "the embedder URL is not absolute";
  }
  if (isIP(host) === 0) return null;
  const c = classifyAddressLan(host);
  return c.never === null && c.privateLan ? null : `the embedder must be local (private or loopback addresses only); ${host} is not`;
}

/** The embedder the org names, or a reason it cannot serve (a miss, recorded by the caller). */
export async function resolveLocalEmbedder(
  db: Db,
  dataKey: string | undefined,
  embedderId: string,
  deps: { resolve?: EgressResolver; connectionTest?: boolean } = {},
): Promise<{ ok: true; embedder: LocalEmbedder } | { ok: false; reason: string }> {
  const [row] = await db.select().from(externalScorers).where(eq(externalScorers.id, embedderId));
  if (!row) return { ok: false, reason: "the embedder no longer exists" };
  // the connection test is what enables a scorer, so it alone may call a disabled one
  if (!row.enabled && !deps.connectionTest) return { ok: false, reason: `embedder '${row.name}' is disabled` };
  if (!((row.scorerKinds as string[]) ?? []).includes(TEXT_EMBEDDING_SCORER_KIND) || row.adapter !== "regulait") {
    return { ok: false, reason: `scorer '${row.name}' is not a text_embedding embedder` };
  }
  if (row.keyCiphertext && !dataKey) return { ok: false, reason: "the embedder has a secret but no REGULAIT_DATA_KEY is set" };
  const literal = localLiteralRefusal(row.baseUrl);
  if (literal) return { ok: false, reason: literal };
  const allowList = await loadEgressAllowList(db);
  return {
    ok: true,
    embedder: {
      id: row.id,
      name: row.name,
      baseUrl: row.baseUrl,
      apiKey: row.keyCiphertext && dataKey ? decryptSecret(dataKey, row.keyCiphertext) : null,
      fetchImpl: createGuardedFetch({
        allowList,
        providerAllowsPlaintextHttp: row.allowPlaintextHttp,
        resolve: localOnlyResolver(deps.resolve),
        maxResponseBytes: 1 << 20,
      }),
    },
  };
}

/** One /embed call. Throws with a reason on anything outside the contract. */
export async function embedText(
  embedder: LocalEmbedder,
  text: string,
  timeoutMs = EMBED_TIMEOUT_MS,
): Promise<{ vector: number[]; model: string; truncated: boolean }> {
  let res: Response;
  try {
    res = await embedder.fetchImpl(embedder.baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(embedder.apiKey ? { authorization: `Bearer ${embedder.apiKey}` } : {}),
      },
      body: JSON.stringify({ scorerKind: TEXT_EMBEDDING_SCORER_KIND, input: text }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const refusal = egressRefusal(err);
    throw new Error(refusal ?? `embedder '${embedder.name}' request failed`);
  }
  const body = await res.text();
  // the status only: an error body could echo the request
  if (!res.ok) throw new Error(`embedder '${embedder.name}' returned HTTP ${res.status}`);
  return parseEmbeddingReply(body);
}

/**
 * The mandatory partition: a commitment to the user, the agent, the request minus
 * its input text, and the serving configuration. Versioned like the exact key.
 */
export function similarityPartitionKey(
  userId: string,
  request: NativeCacheRequest,
  config: NativeCacheConfig,
): string {
  const { input: _input, ...rest } = request;
  void _input;
  const commitment = canonicalJson({ v: "similar-v1", userId, agentId: config.agentId, request: rest, config });
  return `similar-v1:${createHash("sha256").update(commitment).digest("hex")}`;
}

export interface SimilarHit extends SemanticCacheHit {
  readonly cacheId: string;
  readonly similarity: number;
}

/** The best live row in the partition at or above `min`, comparing at most the newest
 * SIMILARITY_CANDIDATES_MAX rows. Filters on the parent's user and agent as well as
 * the partition commitment, so the scope holds even if a commitment ever collided. */
export async function lookupSimilar(
  db: Db,
  args: {
    userId: string;
    agentId: string;
    partitionKey: string;
    embedderId: string;
    embedderModel: string;
    vector: number[];
    min: number;
    ttlSeconds: number;
  },
): Promise<SimilarHit | null> {
  const cutoff = new Date(Date.now() - args.ttlSeconds * 1000);
  const rows = await db
    .select({
      cacheId: semanticCache.id,
      outputText: semanticCache.outputText,
      model: semanticCache.model,
      inputTokens: semanticCache.inputTokens,
      outputTokens: semanticCache.outputTokens,
      createdAt: semanticCache.createdAt,
      embedding: semanticCacheEmbeddings.embedding,
    })
    .from(semanticCacheEmbeddings)
    .innerJoin(semanticCache, eq(semanticCache.id, semanticCacheEmbeddings.cacheId))
    .where(
      and(
        eq(semanticCacheEmbeddings.partitionKey, args.partitionKey),
        eq(semanticCacheEmbeddings.embedderId, args.embedderId),
        eq(semanticCacheEmbeddings.embedderModel, args.embedderModel),
        eq(semanticCache.userId, args.userId),
        eq(semanticCache.agentId, args.agentId),
        gte(semanticCache.createdAt, cutoff),
      ),
    )
    .orderBy(desc(semanticCacheEmbeddings.createdAt))
    .limit(SIMILARITY_CANDIDATES_MAX);
  const best = bestSimilar(args.vector, rows, args.min);
  if (!best) return null;
  const { embedding: _e, ...hit } = best.row;
  void _e;
  return { ...hit, similarity: best.similarity };
}

/** Index a freshly stored cache row for the tier (the vector computed at lookup). */
export async function storeSimilarEmbedding(
  db: Db,
  args: { cacheId: string; partitionKey: string; embedderId: string; embedderModel: string; vector: number[] },
): Promise<void> {
  await db
    .insert(semanticCacheEmbeddings)
    .values({
      cacheId: args.cacheId,
      partitionKey: args.partitionKey,
      embedderId: args.embedderId,
      embedderModel: args.embedderModel,
      embedding: args.vector,
    })
    .onConflictDoUpdate({
      target: semanticCacheEmbeddings.cacheId,
      set: {
        partitionKey: args.partitionKey,
        embedderId: args.embedderId,
        embedderModel: args.embedderModel,
        embedding: args.vector,
        createdAt: new Date(),
      },
    });
}

/** The lookup-time state the store side reuses (no second embed call). */
export interface SimilarityProbe {
  readonly partitionKey: string;
  readonly embedderId: string;
  readonly embedderModel: string;
  readonly vector: number[];
}

/** Why the tier did not serve, as a fixed vocabulary (the metrics label, R3 #969
 * finding 2). `missReason` carries the detail for the log. */
export const SIMILARITY_MISS_CODES = [
  "no_match",
  "input_too_long",
  "input_truncated",
  "embedder_unavailable",
  "embedder_error",
] as const;
export type SimilarityMissCode = (typeof SIMILARITY_MISS_CODES)[number];

/**
 * The whole miss-path probe: resolve the embedder, embed, look up. Returns the hit
 * (if any) and the probe for the store side; a failure is reported as `missReason`
 * and is never thrown, because a cache failure must not fail the call.
 *
 * An input the encoder cut to its window (R3 #969 finding 1) is a miss AND is never
 * indexed (`probe` is null): its vector stands for a prefix only, so a different
 * prompt sharing that prefix would match at cosine 1.0 and be served another
 * prompt's answer. Such inputs use the exact tier only.
 */
export async function probeSimilar(
  db: Db,
  dataKey: string | undefined,
  args: {
    embedderId: string;
    userId: string;
    request: NativeCacheRequest;
    config: NativeCacheConfig;
    min: number;
    ttlSeconds: number;
  },
  deps: { resolve?: EgressResolver } = {},
): Promise<{ hit: SimilarHit | null; probe: SimilarityProbe | null; missCode?: SimilarityMissCode; missReason?: string }> {
  if (args.request.input.length > EMBED_INPUT_MAX_CHARS) {
    return { hit: null, probe: null, missCode: "input_too_long", missReason: "input too long to embed" };
  }
  const resolved = await resolveLocalEmbedder(db, dataKey, args.embedderId, deps);
  if (!resolved.ok) return { hit: null, probe: null, missCode: "embedder_unavailable", missReason: resolved.reason };
  let embedded: { vector: number[]; model: string; truncated: boolean };
  try {
    embedded = await embedText(resolved.embedder, args.request.input);
  } catch (err) {
    return { hit: null, probe: null, missCode: "embedder_error", missReason: errMessage(err) };
  }
  if (embedded.truncated) {
    return { hit: null, probe: null, missCode: "input_truncated", missReason: "input exceeds the embedder's window" };
  }
  const probe: SimilarityProbe = {
    partitionKey: similarityPartitionKey(args.userId, args.request, args.config),
    embedderId: resolved.embedder.id,
    embedderModel: embedded.model,
    vector: embedded.vector,
  };
  const hit = await lookupSimilar(db, {
    userId: args.userId,
    agentId: args.config.agentId,
    partitionKey: probe.partitionKey,
    embedderId: probe.embedderId,
    embedderModel: probe.embedderModel,
    vector: probe.vector,
    min: args.min,
    ttlSeconds: args.ttlSeconds,
  });
  return hit ? { hit, probe } : { hit, probe, missCode: "no_match" };
}
