/**
 * One bucketed limiter for unauthenticated or route-authenticated public routes (supplier portal, drift ingestion).
 *
 * It reuses the gateway's registered @fastify/rate-limit (`createRateLimit`) rather than a counter of its own, so the
 * shared store, the multi-replica behaviour and `REGULAIT_RATE_LIMIT=off` all apply. A route picks the bucket per
 * request (for example `sp:access:<id>` or `dic:cred:<id>`); a key's limit is the first entry in `buckets` whose prefix
 * it starts with, else `fallback`. The address bucket is `<addressPrefix><ip>` when the route sets none.
 *
 * Returns a function that answers 429 with `retry-after` and the shared `rate_limited` body and resolves true when the
 * request is over its limit, else false.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export interface BucketLimit {
  max: number;
  windowMs: number;
}

export interface BucketLimiterOptions {
  /** the bucket a request falls into when the route has not chosen one, e.g. `"sp:addr:"` (the client address is appended) */
  addressPrefix: string;
  /** key prefix → limit, first match wins */
  buckets: ReadonlyArray<readonly [prefix: string, limit: BucketLimit]>;
  /** the limit for any other key (normally the per-address one) */
  fallback: BucketLimit;
  /** the 429 `detail` text */
  message: (v: { max: number; timeWindow: number; ttlInSeconds: number }) => string;
}

type Limiter = (req: FastifyRequest) => Promise<{ isExceeded: boolean; max: number; ttlInSeconds: number; timeWindow: number }>;

export type BucketLimit429 = (req: FastifyRequest, reply: FastifyReply, bucket: string) => Promise<boolean>;

export function bucketLimiter(app: FastifyInstance, opts: BucketLimiterOptions): BucketLimit429 {
  const chosen = new WeakMap<FastifyRequest, string>();
  const limitFor = (key: string) => opts.buckets.find(([p]) => key.startsWith(p))?.[1] ?? opts.fallback;
  let limiter: Limiter | null = null;
  return async (req, reply, bucket) => {
    // REGULAIT_RATE_LIMIT=off turns every HTTP limiter off at once; these buckets follow it
    if (!app.hasDecorator("createRateLimit")) return false;
    limiter ??= app.createRateLimit({
      keyGenerator: (r: FastifyRequest) => chosen.get(r) ?? `${opts.addressPrefix}${r.ip}`,
      max: (_r: FastifyRequest, k: string) => limitFor(k).max,
      timeWindow: (_r: FastifyRequest, k: string) => limitFor(k).windowMs,
      allowList: () => false,
    }) as unknown as Limiter;
    chosen.set(req, bucket);
    const v = await limiter(req);
    if (!v.isExceeded) return false;
    await reply.status(429).header("retry-after", String(v.ttlInSeconds)).send({
      error: "rate_limited",
      detail: opts.message(v),
      retryAfterSeconds: v.ttlInSeconds,
    });
    return true;
  };
}
