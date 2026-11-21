/** the shared prefixed-bearer parse (ADR-0223 amendment 1 review) and the bucketed limiter's bucket choice */
import Fastify, { type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { describe, expect, it } from "vitest";
import { bucketLimiter } from "./bucket-limiter.js";
import { prefixedBearer } from "./prefixed-bearer.js";

const req = (authorization?: string) => ({ headers: authorization === undefined ? {} : { authorization } }) as unknown as FastifyRequest;
const hex = "a".repeat(64);
const b64 = "Ab-_".repeat(10) + "xyz";

describe("prefixedBearer", () => {
  it("accepts exactly prefix + length × charset, scheme case-insensitive", () => {
    expect(prefixedBearer(req(`Bearer rgti_${hex}`), "rgti_", 64, "hex")).toBe(`rgti_${hex}`);
    expect(prefixedBearer(req(`bearer rgldi_${b64}`), "rgldi_", 43, "base64url")).toBe(`rgldi_${b64}`);
  });
  it("refuses everything else", () => {
    for (const h of [undefined, "", `Basic rgti_${hex}`, `Bearer rgti_${hex}0`, `Bearer rgti_${hex.slice(1)}`, `Bearer rgti_${"A".repeat(64)}`, `Bearer rgl_${hex}`, `Bearer rgti_${hex}`.padEnd(400, " ")]) {
      expect(prefixedBearer(req(h), "rgti_", 64, "hex")).toBeNull();
    }
    expect(prefixedBearer(req(`Bearer rgldi_${"=".repeat(43)}`), "rgldi_", 43, "base64url")).toBeNull();
  });
});

describe("bucketLimiter", () => {
  it("limits each bucket by its prefix's limit and answers 429 with retry-after", async () => {
    const app = Fastify();
    await app.register(rateLimit, { global: false });
    const limit = bucketLimiter(app, {
      addressPrefix: "t:addr:",
      buckets: [["t:cred:", { max: 1, windowMs: 60_000 }]],
      fallback: { max: 3, windowMs: 60_000 },
      message: (v) => `limit ${v.max}`,
    });
    app.get("/c", async (r, reply) => ((await limit(r, reply, "t:cred:x")) ? reply : { ok: true }));
    app.get("/a", async (r, reply) => ((await limit(r, reply, `t:addr:${r.ip}`)) ? reply : { ok: true }));
    await app.ready();
    expect((await app.inject("/c")).statusCode).toBe(200);
    const over = await app.inject("/c");
    expect(over.statusCode).toBe(429);
    expect(over.headers["retry-after"]).toBeDefined();
    expect(over.json()).toMatchObject({ error: "rate_limited", detail: "limit 1" });
    for (let i = 0; i < 3; i++) expect((await app.inject("/a")).statusCode).toBe(200);
    expect((await app.inject("/a")).statusCode).toBe(429);
    await app.close();
  });
});
