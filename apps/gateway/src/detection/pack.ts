/**
 * ADR-0333 — the detection rule pack: a closed, versioned, signed document (`regulait.detection-pack.v1`).
 *
 * Rules are data, never code and never AI (owner scope guard). The vocabulary follows the Sigma correlation
 * specification (`temporal_ordered`, `event_count`) plus `single`. A selector is a conjunction over closed fields, a
 * tool class is a list of lower-case `*` globs over tool names. Both are evaluated on Cedar
 * (`@regulait/policy-kernel/detection-cedar`); there are no expressions and no regular expressions.
 */
import { createHash, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@regulait/shared";

export const DETECTION_PACK_SCHEMA = "regulait.detection-pack.v1";

export const DETECTION_LIMITS = {
  rules: 64,
  steps: 8,
  classes: 32,
  globsPerClass: 64,
  globLength: 64,
  maxTimespanSeconds: 3600,
  maxThreshold: 1000,
} as const;

const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type DetectionSeverity = (typeof SEVERITIES)[number];

/** slice 1 runs `alert` only; the stronger responses are carried by the schema so a pack round-trips (slice 2) */
export const RESPONSES = ["alert", "suspend_grant", "revoke_credential", "require_approval"] as const;
export type DetectionResponse = (typeof RESPONSES)[number];

const ident = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const className = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const glob = z
  .string()
  .min(1)
  .max(DETECTION_LIMITS.globLength)
  .regex(/^[a-z0-9_.:*-]+$/, "globs are lower-case tool-name characters and '*'");

export const selectorSchema = z
  .object({
    objectType: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,47}$/)).min(1).max(16).optional(),
    effect: z.array(z.enum(["allow", "deny", "require_approval"])).min(1).max(3).optional(),
    ruleId: z.array(z.string().regex(/^[A-Za-z0-9:._-]{1,96}$/)).min(1).max(32).optional(),
    toolClass: className.optional(),
    phase: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,47}$/)).min(1).max(8).optional(),
    dataScoped: z.boolean().optional(),
    addonSeverityAtLeast: z.enum(SEVERITIES).optional(),
    delegated: z.boolean().optional(),
  })
  .strict();
export type DetectionSelector = z.infer<typeof selectorSchema>;

const base = {
  id: ident,
  title: z.string().trim().min(1).max(160),
  severity: z.enum(SEVERITIES),
  enabled: z.boolean(),
  response: z.enum(RESPONSES).default("alert"),
};
const timespan = z.number().int().min(1).max(DETECTION_LIMITS.maxTimespanSeconds);

export const ruleSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("single"), selector: selectorSchema }).strict(),
  z
    .object({
      ...base,
      type: z.literal("temporal_ordered"),
      timespanSeconds: timespan,
      steps: z
        .array(z.object({ selector: selectorSchema, differentServer: z.boolean().optional() }).strict())
        .min(2)
        .max(DETECTION_LIMITS.steps),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("event_count"),
      timespanSeconds: timespan,
      threshold: z.number().int().min(2).max(DETECTION_LIMITS.maxThreshold),
      selector: selectorSchema,
    })
    .strict(),
]);
export type DetectionRule = z.infer<typeof ruleSchema>;

export const packSchema = z
  .object({
    schema: z.literal(DETECTION_PACK_SCHEMA),
    toolClasses: z.record(className, z.array(glob).min(1).max(DETECTION_LIMITS.globsPerClass)),
    rules: z.array(ruleSchema).max(DETECTION_LIMITS.rules),
  })
  .strict()
  .superRefine((pack, ctx) => {
    if (Object.keys(pack.toolClasses).length > DETECTION_LIMITS.classes) {
      ctx.addIssue({ code: "custom", message: "too many tool classes", path: ["toolClasses"] });
    }
    const seen = new Set<string>();
    pack.rules.forEach((rule, i) => {
      if (seen.has(rule.id)) ctx.addIssue({ code: "custom", message: "duplicate rule id", path: ["rules", i, "id"] });
      seen.add(rule.id);
      const selectors = rule.type === "temporal_ordered" ? rule.steps.map((s) => s.selector) : [rule.selector];
      for (const s of selectors) {
        if (s.toolClass && !Object.hasOwn(pack.toolClasses, s.toolClass)) {
          ctx.addIssue({ code: "custom", message: `unknown tool class ${s.toolClass}`, path: ["rules", i] });
        }
      }
    });
  });
export type DetectionPack = z.infer<typeof packSchema>;

/** The built-in default pack (ADR-0333 §3). It ships in code, so it needs no signature. */
export const DEFAULT_DETECTION_PACK: DetectionPack = Object.freeze({
  schema: DETECTION_PACK_SCHEMA,
  toolClasses: {
    secret_read: [
      "*secret*",
      "*credential*",
      "*password*",
      "*passwd*",
      "*token*",
      "*apikey*",
      "*api_key*",
      "*vault*",
      "*keychain*",
      "*private_key*",
      "read_env*",
      "get_env*",
      "*getenv*",
    ],
    network_egress: [
      "*fetch*",
      "*http*",
      "*request*",
      "*curl*",
      "*wget*",
      "*webhook*",
      "*upload*",
      "*send*",
      "*post*",
      "*publish*",
      "*email*",
      "*browse*",
      "*navigate*",
    ],
    write: [
      "*write*",
      "*create*",
      "*update*",
      "*insert*",
      "*upload*",
      "*put*",
      "*post*",
      "*send*",
      "*push*",
      "*commit*",
      "*publish*",
      "*save*",
    ],
  },
  rules: [
    {
      id: "secret-read-then-egress",
      title: "A secret or credential was read, then data was sent out of the session",
      severity: "high",
      enabled: true,
      response: "alert",
      type: "temporal_ordered",
      timespanSeconds: 600,
      steps: [
        { selector: { toolClass: "secret_read", effect: ["allow"] } },
        { selector: { toolClass: "network_egress", effect: ["allow"] } },
      ],
    },
    {
      id: "sensitive-scope-then-unapproved-write",
      title: "A data-scoped call was followed by a write to a different destination",
      severity: "high",
      enabled: true,
      response: "alert",
      type: "temporal_ordered",
      timespanSeconds: 900,
      steps: [
        { selector: { dataScoped: true, effect: ["allow"] } },
        { selector: { toolClass: "write", effect: ["allow"] }, differentServer: true },
      ],
    },
    {
      id: "high-risk-addon-call",
      // ADR-0333 D1 (owner, 2026-11-15): an MCP server or a builder skill the admission scanner rated High/Critical
      title: "A call used an add-on (MCP server or builder skill) the admission scanner rated High or Critical",
      severity: "high",
      enabled: true,
      response: "alert",
      type: "single",
      selector: { addonSeverityAtLeast: "high", effect: ["allow"] },
    },
    {
      id: "delegation-escalation",
      title: "An agent asked for more than its sponsor's entitlements along its delegation chain",
      severity: "critical",
      enabled: true,
      response: "alert",
      type: "single",
      selector: {
        effect: ["deny"],
        ruleId: ["delegation-scope", "delegation-depth", "lead-ceiling", "actor-allow-list", "delegation-isolation"],
      },
    },
    {
      id: "denied-call-burst",
      title: "A burst of denied calls (probing)",
      severity: "medium",
      enabled: true,
      response: "alert",
      type: "event_count",
      timespanSeconds: 300,
      threshold: 10,
      selector: { effect: ["deny"] },
    },
  ],
}) as DetectionPack;

/** parse an untrusted pack (admin input or a stored row); throws a ZodError on anything outside the contract */
export function parseDetectionPack(input: unknown): DetectionPack {
  return packSchema.parse(input);
}

export function packCanonicalBytes(pack: DetectionPack): Buffer {
  return Buffer.from(canonicalJson(pack), "utf8");
}

export function packDigest(pack: DetectionPack): string {
  return createHash("sha256").update(packCanonicalBytes(pack)).digest("hex");
}

export function signDetectionPack(pack: DetectionPack, privateKey: KeyObject): string {
  return sign(null, packCanonicalBytes(pack), privateKey).toString("base64url");
}

/** true only when the signature verifies against the recorded public key; any malformed input is false */
export function verifyDetectionPack(
  pack: DetectionPack,
  signature: string,
  publicJwk: { kty: string; crv: string; x: string },
): boolean {
  try {
    if (publicJwk.kty !== "OKP" || publicJwk.crv !== "Ed25519") return false;
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicJwk.x }, format: "jwk" });
    return verify(null, packCanonicalBytes(pack), key, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

/**
 * Is moving from `previous` to `next` a relaxation (ADR-0180)? Only adding rules or tool classes, while every
 * existing rule and class stays byte-identical, is not. A rule carrying a response stronger than `alert` is a
 * relaxation of the default posture too (ADR-0333 §5), so it needs the step-up as well.
 */
export function packChangeIsRelaxation(previous: DetectionPack, next: DetectionPack): boolean {
  const nextRules = new Map(next.rules.map((r) => [r.id, canonicalJson(r)]));
  for (const rule of previous.rules) if (nextRules.get(rule.id) !== canonicalJson(rule)) return true;
  for (const [name, globs] of Object.entries(previous.toolClasses)) {
    const after = next.toolClasses[name];
    if (!after || canonicalJson(after) !== canonicalJson(globs)) return true;
  }
  return next.rules.some((r) => r.response !== "alert");
}
