/**
 * ADR-0364 (lane E45 S2): governed RPA "Robots" — the request shapes, the `steps_v1` step model's validation,
 * and the content digest an approval is bound to. Pure; the gateway (`robots.ts`) is the only writer.
 *
 * What S2 accepts, and why it is narrower than the ADR's full list (secure by default, ADR-0180):
 *  - `engine`: `browser` only. The desktop engine is S5.
 *  - `script_format`: `steps_v1` only. An uploaded Playwright script needs S4's lint first, and a Robot Framework
 *    task needs S5's engine; both are refused (`robot_format_unavailable`) until those slices land.
 *  - allowed sites: `https:` origins only (a host and an optional port, nothing else).
 *
 * The digest (§3) covers the script, the compiled output and compiler version when there is one (S4), both
 * schemas, the allow-list and every secret binding (name, origin, the live secret it uses). It is RFC 8785
 * canonical JSON (`canonicalize`, already pinned for the ADR-0246 definition pins) hashed with SHA-256.
 */
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { z } from "zod";

export const ROBOT_ENGINES = ["browser", "desktop"] as const;
export type RobotEngine = (typeof ROBOT_ENGINES)[number];
/** the engines S2 lets a robot be created with */
export const ROBOT_ENGINES_AVAILABLE: readonly RobotEngine[] = ["browser"];

export const ROBOT_SCRIPT_FORMATS = ["steps_v1", "playwright_ts", "robot_framework"] as const;
export type RobotScriptFormat = (typeof ROBOT_SCRIPT_FORMATS)[number];
/** the formats a version may be saved in before S4 (upload lint) and S5 (desktop engine) */
export const ROBOT_SCRIPT_FORMATS_AVAILABLE: readonly RobotScriptFormat[] = ["steps_v1"];

export const ROBOT_VERSION_SOURCES = ["recorded", "uploaded", "agent_drafted"] as const;
export type RobotVersionSource = (typeof ROBOT_VERSION_SOURCES)[number];

export const ROBOT_SECRET_SCOPES = ["live", "test"] as const;
export type RobotSecretScope = (typeof ROBOT_SECRET_SCOPES)[number];

export const ROBOT_RUN_KINDS = ["test", "agent", "freeform"] as const;
export type RobotRunKind = (typeof ROBOT_RUN_KINDS)[number];

/** the step verbs (shaped by TagUI's plain-English vocabulary, ideas only: ADR-0364 §9a) */
export const ROBOT_STEP_OPS = ["goto", "fill", "click", "select", "read", "download", "check"] as const;
export type RobotStepOp = (typeof ROBOT_STEP_OPS)[number];

export const ROBOT_SLUG_RE = /^[a-z0-9_]{1,48}$/;
const SECRET_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const FIELD_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export const ROBOT_LIMITS = {
  scriptBytes: 256 * 1024,
  steps: 500,
  allowedSites: 32,
  secretBindings: 32,
  schemaBytes: 32 * 1024,
  selectorChars: 1024,
  valueChars: 4096,
} as const;

/** The tool name a version gets on the Robots server (`robot_<slug>_v<N>`). */
export function robotToolName(slug: string, version: number): string {
  return `robot_${slug}_v${version}`;
}

/**
 * Normalise an allowed site to `https://host[:port]`. Anything else (another scheme, a path, a query, userinfo,
 * a fragment, an IP literal of any kind) is refused: a robot's sites are named hosts the reviewer can read.
 */
export function normaliseRobotOrigin(input: string): { ok: true; origin: string } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: "not a URL" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "only https: origins are allowed" };
  if (url.username || url.password) return { ok: false, reason: "an origin may not carry credentials" };
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    return { ok: false, reason: "an origin is a scheme, a host and an optional port only" };
  }
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || host.startsWith("[") || /^[0-9.]+$/.test(host)) {
    return { ok: false, reason: "an origin must name a public DNS host (no IP literals, no single-label names)" };
  }
  return { ok: true, origin: `https://${host}${url.port ? `:${url.port}` : ""}` };
}

const jsonSchemaDoc = z
  .record(z.string(), z.unknown())
  .refine((v) => Buffer.byteLength(JSON.stringify(v), "utf8") <= ROBOT_LIMITS.schemaBytes, {
    message: `a schema is at most ${ROBOT_LIMITS.schemaBytes} bytes`,
  })
  .refine((v) => v["type"] === "object", { message: "a robot's input and output schemas are JSON Schema objects (type: object)" });

export const robotSecretBindingSchema = z
  .object({
    name: z.string().regex(SECRET_NAME_RE),
    origin: z.string().min(1).max(300),
  })
  .strict();

export const createRobotSchema = z
  .object({
    slug: z.string().regex(ROBOT_SLUG_RE),
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000).default(""),
    engine: z.enum(ROBOT_ENGINES).default("browser"),
  })
  .strict();

export const robotVersionDraftSchema = z
  .object({
    source: z.enum(ROBOT_VERSION_SOURCES).default("recorded"),
    scriptFormat: z.enum(ROBOT_SCRIPT_FORMATS).default("steps_v1"),
    script: z.string().max(ROBOT_LIMITS.scriptBytes),
    inputSchema: jsonSchemaDoc,
    outputSchema: jsonSchemaDoc,
    allowedSites: z.array(z.string().min(1).max(300)).min(1).max(ROBOT_LIMITS.allowedSites),
    secretBindings: z.array(robotSecretBindingSchema).max(ROBOT_LIMITS.secretBindings).default([]),
  })
  .strict();
export type RobotVersionDraft = z.infer<typeof robotVersionDraftSchema>;

export const setRobotSecretSchema = z.object({ value: z.string().min(1).max(8192) }).strict();

export const submitRobotVersionSchema = z
  .object({
    approverUserId: z.string().uuid().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// steps_v1
// ---------------------------------------------------------------------------

const selector = z.string().min(1).max(ROBOT_LIMITS.selectorChars);
const stepSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("goto"), url: z.string().min(1).max(2048) }).strict(),
  z
    .object({
      op: z.literal("fill"),
      selector,
      /** exactly one of: a literal, a named input, or a named secret */
      value: z.string().max(ROBOT_LIMITS.valueChars).optional(),
      input: z.string().regex(FIELD_NAME_RE).optional(),
      secret: z.string().regex(SECRET_NAME_RE).optional(),
    })
    .strict(),
  z.object({ op: z.literal("click"), selector }).strict(),
  z
    .object({
      op: z.literal("select"),
      selector,
      value: z.string().max(ROBOT_LIMITS.valueChars).optional(),
      input: z.string().regex(FIELD_NAME_RE).optional(),
    })
    .strict(),
  z.object({ op: z.literal("read"), selector, output: z.string().regex(FIELD_NAME_RE) }).strict(),
  z.object({ op: z.literal("download"), selector, output: z.string().regex(FIELD_NAME_RE) }).strict(),
  z.object({ op: z.literal("check"), selector, text: z.string().max(ROBOT_LIMITS.valueChars).optional() }).strict(),
]);
const stepsDocSchema = z.object({ steps: z.array(stepSchema).min(1).max(ROBOT_LIMITS.steps) }).strict();
export type RobotStep = z.infer<typeof stepSchema>;

export interface RobotScriptProblem {
  /** 0-based step index, or null for the document as a whole */
  step: number | null;
  problem: string;
}

/**
 * Validate a `steps_v1` script against the version it belongs to:
 * - every `goto` lands on one of the allowed origins;
 * - a `fill` names exactly one of `value`, `input` or `secret`, and a `select` exactly one of `value` or `input`;
 * - a named secret is one of the version's secret bindings;
 * - a named input is a property of the input schema, and a named output a property of the output schema;
 * - a secret is never read back (`read` and `download` take selectors and outputs only, so the step model has no
 *   way to copy a secret into an output, a URL or a log; ADR-0364 §7).
 */
export function validateStepsScript(
  script: string,
  ctx: { allowedOrigins: readonly string[]; secretNames: readonly string[]; inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> },
): { ok: true; steps: RobotStep[] } | { ok: false; problems: RobotScriptProblem[] } {
  let doc: unknown;
  try {
    doc = JSON.parse(script);
  } catch {
    return { ok: false, problems: [{ step: null, problem: "a steps_v1 script is a JSON document {\"steps\": [...]}" }] };
  }
  const parsed = stepsDocSchema.safeParse(doc);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.slice(0, 20).map((i) => ({
        step: typeof i.path[1] === "number" ? (i.path[1] as number) : null,
        problem: `${i.path.join(".")}: ${i.message}`,
      })),
    };
  }
  const props = (schema: Record<string, unknown>) =>
    new Set(Object.keys((schema["properties"] as Record<string, unknown> | undefined) ?? {}));
  const inputs = props(ctx.inputSchema);
  const outputs = props(ctx.outputSchema);
  const origins = new Set(ctx.allowedOrigins);
  const secrets = new Set(ctx.secretNames);
  const problems: RobotScriptProblem[] = [];
  parsed.data.steps.forEach((step, i) => {
    if (step.op === "goto") {
      let origin: string | null = null;
      try {
        const u = new URL(step.url);
        origin = u.protocol === "https:" ? `https://${u.hostname.toLowerCase()}${u.port ? `:${u.port}` : ""}` : null;
      } catch {
        origin = null;
      }
      if (!origin || !origins.has(origin)) problems.push({ step: i, problem: "goto must land on one of the version's allowed https origins" });
    }
    if (step.op === "fill" || step.op === "select") {
      const named = [step.value !== undefined, step.input !== undefined, step.op === "fill" && step.secret !== undefined].filter(Boolean).length;
      if (named !== 1) problems.push({ step: i, problem: `${step.op} names exactly one of value, input${step.op === "fill" ? " or secret" : ""}` });
      if (step.input !== undefined && !inputs.has(step.input)) problems.push({ step: i, problem: `input '${step.input}' is not in the input schema` });
      if (step.op === "fill" && step.secret !== undefined && !secrets.has(step.secret)) {
        problems.push({ step: i, problem: `secret '${step.secret}' has no binding on this version` });
      }
    }
    if ((step.op === "read" || step.op === "download") && !outputs.has(step.output)) {
      problems.push({ step: i, problem: `output '${step.output}' is not in the output schema` });
    }
  });
  return problems.length ? { ok: false, problems } : { ok: true, steps: parsed.data.steps };
}

// ---------------------------------------------------------------------------
// the content digest (§3)
// ---------------------------------------------------------------------------

export interface RobotDigestInput {
  scriptFormat: RobotScriptFormat;
  script: string;
  compiledSha256: string | null;
  compilerVersion: string | null;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  allowedOrigins: readonly string[];
  secretBindings: ReadonlyArray<{ name: string; origin: string; liveSecretId: string | null }>;
}

export function robotScriptSha256(script: string): string {
  return createHash("sha256").update(script, "utf8").digest("hex");
}

/** The digest a reviewer approves: canonical (RFC 8785) JSON of everything the version will do, SHA-256. */
export function robotContentDigest(v: RobotDigestInput): string {
  const doc = {
    v: 1,
    scriptFormat: v.scriptFormat,
    scriptSha256: robotScriptSha256(v.script),
    compiledSha256: v.compiledSha256,
    compilerVersion: v.compilerVersion,
    inputSchema: v.inputSchema,
    outputSchema: v.outputSchema,
    allowedOrigins: [...v.allowedOrigins].sort(),
    secretBindings: [...v.secretBindings]
      .map((b) => ({ name: b.name, origin: b.origin, liveSecretId: b.liveSecretId }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
  const canonical = canonicalize(doc);
  if (canonical === undefined) throw new Error("robotContentDigest: not serialisable");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
