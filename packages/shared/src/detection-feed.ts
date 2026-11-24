/** ADR-0367: one offline, signed, additive injection-rule stream. No code, URLs or trust roots in the payload. */
import { z } from "zod";
import { RE2JS } from "re2js";

export const DETECTION_FEED_FORMAT = "regulait.detection-feed/v1";
export const DETECTION_FEED_MAX_BYTES = 256 * 1024;
const id = z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/);
export const detectionFeedRuleSchema = z.object({
  id,
  category: id,
  patterns: z.array(z.string().min(1).max(2048)).min(1).max(8),
  minMatches: z.number().int().min(1).max(8),
  caseInsensitive: z.boolean().optional(),
}).strict().superRefine((r, ctx) => {
  if(r.minMatches>r.patterns.length || new Set(r.patterns).size!==r.patterns.length)
    ctx.addIssue({code:"custom",message:"pattern counts must be distinct and satisfiable"});
  for(const p of r.patterns) {
    try { const re=RE2JS.compile(p,r.caseInsensitive?RE2JS.CASE_INSENSITIVE:0); if(re.test("")) throw new Error(); }
    catch {ctx.addIssue({code:"custom",message:"every pattern must be a non-empty RE2 expression"});}
  }
});
export const detectionFeedSchema = z.object({
  format: z.literal(DETECTION_FEED_FORMAT),
  feedId: id,
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  source: z.object({id, licence:z.enum(["MIT","Apache-2.0","BSD-2-Clause","BSD-3-Clause","ISC"])}).strict(),
  kind: z.literal("prompt_injection"),
  rules: z.array(detectionFeedRuleSchema).min(1).max(64),
}).strict().superRefine((v,ctx)=>{
  if(new Set(v.rules.map(r=>r.id)).size!==v.rules.length) ctx.addIssue({code:"custom",message:"rule identifiers must be unique"});
  if(v.rules.reduce((n,r)=>n+r.patterns.reduce((sum,p)=>sum+new TextEncoder().encode(p).length,0),0)>64*1024)
    ctx.addIssue({code:"custom",message:"combined patterns exceed the limit"});
});
export const detectionFeedEnvelopeSchema = z.object({bundle:z.string().min(1).max(DETECTION_FEED_MAX_BYTES),signature:z.string().min(1).max(256),keyId:id}).strict();
export type DetectionFeed = z.infer<typeof detectionFeedSchema>;
export type DetectionFeedRule = z.infer<typeof detectionFeedRuleSchema>;
export type DetectionFeedEnvelope = z.infer<typeof detectionFeedEnvelopeSchema>;
