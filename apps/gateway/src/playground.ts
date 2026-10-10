/**
 * ADR-0173 batch 2b — THE PROMPT PLAYGROUND ("policy sandbox").
 *
 *   POST /v1/playground/run        one governed call of a template
 *   POST /v1/playground/evaluate   the same template over rows (≤ 50), one
 *                                  governed call per row, with the total cost
 *
 * Both are non-admin: a person tries their own prompt on a model they hold.
 *
 * NOTHING HERE IS A SHORTCUT. Every call runs through `executeGovernedDispatch`
 * as the caller, under the model-policy feature `playground`: the entitlement
 * decision (grants, revocations, ceiling, the kill switch) is `agentDecision`
 * with that feature, and the core then applies the project budget, PII,
 * guardrails, egress and metering exactly as for any dispatch, and re-applies
 * the model allow-list to the served binding.
 *
 * TOOLS are described to the model; a tool CALL it makes is returned as data
 * and is NOT executed in this batch (the UI says so).
 *
 * OUTPUT SCHEMA: when the served provider has a native structured-output
 * mechanism (the same set the compatible APIs honour), the schema rides the
 * call as `json_schema` output; either way the output is validated against the
 * schema after the call and reported pass/fail — never assumed.
 *
 * EVALUATE MODE reuses the evaluation datasets (ADR-0044) when given a
 * `datasetId` — admins only, because datasets are admin-managed — and accepts
 * inline rows (inputs + optional reference output) from anyone.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import { RE2JS } from "re2js";
import {
  agents,
  and,
  auditLog,
  eq,
  evalCases,
  evalDatasets,
  type Db,
} from "@regulait/db";
import {
  MODEL_NOT_ALLOWED_FOR_FEATURE,
  PROMPT_LIMITS,
  caseInputAsVariables,
  extractPromptVariables,
  playgroundEvaluateSchema,
  playgroundRunSchema,
  renderPromptTemplate,
  type PlaygroundRun,
} from "@regulait/shared";
import type { ModelResponseFormat, ModelToolDef } from "@regulait/model-provider";
import { executeGovernedDispatch, type AgentRow } from "./agents-connectors.js";
import { agentDecision } from "./copilot.js";
import { RESPONSE_FORMAT_CAPABLE_PROVIDERS } from "./compat-core.js";
import { assertProjectAttribution } from "./projects.js";
import type { ModelPolicyGate } from "./model-policy.js";

/** ADR-0173 batch 2b — the playground is its own feature of the model allow-list */
export const PLAYGROUND_FEATURE: ModelPolicyGate = { feature: "playground" };

export const PLAYGROUND_RULE_IDS = {
  dispatched: "playground-dispatched",
  refused: "playground-refused",
  evaluated: "playground-evaluated",
} as const;

export const TOOL_CALLS_NOT_EXECUTED =
  "Tool calls are shown as the model made them and are not executed in the playground.";

/**
 * A user's schema is untrusted, and so is the model output it is matched
 * against. Ajv's default engine for `pattern`, `patternProperties` (and a
 * `propertyNames` pattern) is the native backtracking RegExp, which runs on the
 * event loop: `^(a+)+$` against a few dozen characters stalls the whole
 * gateway (ReDoS). Every pattern here runs in RE2's linear-time engine instead
 * (the `re2js` port: pure JavaScript, no native build, no runtime download).
 * RE2 has no lookaround or backreferences, so a schema that uses them does not
 * compile and is refused with 422 `invalid_json_schema` — at commit time in the
 * registry and before any call in the playground. (`format: "regex"` only
 * compiles the value, it never matches anything with it, so it is not a ReDoS
 * vector.)
 */
export const re2RegExpEngine = Object.assign(
  (pattern: string, _flags: string) => {
    const re = RE2JS.compile(RE2JS.translateRegExp(pattern));
    return { test: (s: string) => re.test(s) };
  },
  { code: "re2js" },
);

function newAjv() {
  const ajv = new Ajv({ strict: false, allErrors: true, validateSchema: true, code: { regExp: re2RegExpEngine } });
  addFormats.default(ajv);
  return ajv;
}

/** the problems with a JSON Schema document; [] = compiles */
export function validateJsonSchemaShape(schema: Record<string, unknown>): string[] {
  try {
    newAjv().compile(schema);
    return [];
  } catch (err) {
    return [err instanceof Error ? err.message.slice(0, 300) : String(err)];
  }
}

/** validate a model's text output against a schema: it must be JSON, and match */
export function validateOutputAgainstSchema(
  schema: Record<string, unknown>,
  outputText: string,
): { valid: boolean; errors: string[] } {
  let parsed: unknown;
  const trimmed = outputText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { valid: false, errors: ["the output is not JSON"] };
  }
  const validate = newAjv().compile(schema);
  if (validate(parsed)) return { valid: true, errors: [] };
  return {
    valid: false,
    errors: (validate.errors ?? []).slice(0, 20).map((e) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`),
  };
}

interface Caller {
  userId: string;
  isAdmin: boolean;
}

function callerOf(req: FastifyRequest, reply: FastifyReply): Caller | null {
  const userId = req.authCtx.userId;
  if (!userId) {
    void reply.status(403).send({
      error: "playground_requires_identity",
      detail: "A playground run dispatches as the person running it; a token with no user identity has no entitlements to lend.",
    });
    return null;
  }
  return { userId, isAdmin: req.authCtx.isAdmin };
}

type Refusal = { status: number; body: Record<string, unknown> };

/**
 * One answer for "no such model" and "a model you may not use": the same
 * status, code and text, so the playground cannot be used to probe which model
 * ids exist. (A model-policy refusal for the playground feature is decided only
 * AFTER the entitlement allows, so it tells nothing to someone who does not
 * hold the model.)
 */
const MODEL_REFUSAL: Refusal = {
  status: 403,
  body: { error: "model_not_entitled", detail: "you may not use this model, or there is no such model" },
};

/** the checks before any call: schemas compile, the project, the model exists */
async function prepare(
  db: Db,
  caller: Caller,
  body: Pick<PlaygroundRun, "modelAgentId" | "outputSchema" | "tools" | "projectId">,
): Promise<{ agent: AgentRow } | Refusal> {
  const schemaErrors = [
    ...(body.outputSchema ? validateJsonSchemaShape(body.outputSchema).map((e) => `outputSchema: ${e}`) : []),
    ...body.tools.flatMap((t) => validateJsonSchemaShape(t.inputSchema).map((e) => `tools.${t.name}.inputSchema: ${e}`)),
  ];
  if (schemaErrors.length) return { status: 422, body: { error: "invalid_json_schema", detail: schemaErrors.join("; ") } };
  if (body.projectId) {
    const r = await assertProjectAttribution(db, body.projectId, caller.userId, caller.isAdmin);
    if (!r.ok) return { status: r.status, body: { error: r.error, field: "projectId" } };
  }
  const [agent] = await db.select().from(agents).where(eq(agents.id, body.modelAgentId));
  if (!agent) {
    // audited like an entitlement refusal, and answered exactly like one
    await db.insert(auditLog).values({
      userId: caller.userId,
      objectType: "agent",
      objectId: null,
      detail: { purpose: "playground", mode: "chat", requestedModelAgentId: body.modelAgentId, receiptClass: "decision" },
      effect: "deny",
      ruleId: PLAYGROUND_RULE_IDS.refused,
      ruleChain: [],
      reason: "playground call refused: no such model",
    });
    return MODEL_REFUSAL;
  }
  return { agent: agent as AgentRow };
}

/** the entitlement decision for one call, audited when it refuses */
async function entitlementRefusal(db: Db, caller: Caller, agent: AgentRow, detail: Record<string, unknown>): Promise<Refusal | null> {
  const decision = await agentDecision(db, caller.userId, agent, PLAYGROUND_FEATURE);
  if (decision.effect === "allow") return null;
  await db.insert(auditLog).values({
    userId: caller.userId,
    objectType: "agent",
    objectId: agent.id,
    detail: { purpose: "playground", mode: "chat", ...detail, receiptClass: "decision" },
    effect: "deny",
    ruleId: decision.ruleId ?? PLAYGROUND_RULE_IDS.refused,
    ruleChain: decision.ruleChain as typeof auditLog.$inferInsert.ruleChain,
    reason: decision.reason ?? `playground call to '${agent.name}' refused`,
  });
  // the caller holds the model and the playground's own policy refuses it
  if (decision.ruleId === MODEL_NOT_ALLOWED_FOR_FEATURE) {
    return { status: 403, body: { error: MODEL_NOT_ALLOWED_FOR_FEATURE, detail: decision.reason } };
  }
  // otherwise the reason (which names the model) stays in the audit row
  return MODEL_REFUSAL;
}

interface OneCall {
  ok: boolean;
  status: number;
  error: string | null;
  detail: string | null;
  outputText: string | null;
  toolCalls: unknown[];
  costUsd: number | null;
  usage: unknown;
  servedAgentId: string | null;
  model: string | null;
  schemaValidation: { valid: boolean; errors: string[] } | null;
  pii: unknown;
  guardrails: unknown;
  trace: unknown;
}

/** one governed call, as the caller, under the playground feature */
async function governedCall(
  db: Db,
  dataKey: string | undefined,
  caller: Caller,
  agent: AgentRow,
  input: string,
  body: Pick<PlaygroundRun, "outputSchema" | "tools" | "projectId" | "maxTokens">,
  detail: Record<string, unknown>,
): Promise<OneCall> {
  const nativeSchema = !!body.outputSchema && RESPONSE_FORMAT_CAPABLE_PROVIDERS.has(agent.provider);
  const responseFormat: ModelResponseFormat | undefined = nativeSchema
    ? { type: "json_schema", name: "playground_output", schema: body.outputSchema! }
    : undefined;
  const tools: ModelToolDef[] = body.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  const outcome = await executeGovernedDispatch(db, dataKey, {
    userId: caller.userId,
    served: agent,
    requestedAgentId: agent.id,
    baseline: null,
    input,
    ...(tools.length ? { tools } : {}),
    ...(responseFormat ? { responseFormat } : {}),
    ...(body.maxTokens ? { maxTokens: body.maxTokens } : {}),
    projectId: body.projectId ?? null,
    modelFeature: PLAYGROUND_FEATURE,
    mode: "chat",
    detail: { purpose: "playground", ...detail },
  });
  // the decision row the invoke route writes for every governed call
  await db.insert(auditLog).values({
    userId: caller.userId,
    objectType: "agent",
    objectId: agent.id,
    detail: {
      purpose: "playground",
      mode: "chat",
      ...detail,
      tools: tools.map((t) => t.name),
      structuredOutput: body.outputSchema ? (nativeSchema ? "native" : "validated_after") : null,
      dispatch: outcome.ok
        ? { model: outcome.result.model, stopReason: outcome.result.stopReason, toolCalls: outcome.result.toolCalls?.length ?? 0 }
        : { error: outcome.error },
      receiptClass: "decision",
    },
    effect: outcome.ok ? "allow" : "deny",
    ruleId: outcome.ok ? PLAYGROUND_RULE_IDS.dispatched : PLAYGROUND_RULE_IDS.refused,
    ruleChain: [],
    reason: outcome.ok
      ? `playground call to '${agent.name}' dispatched as the person running it`
      : `playground call to '${agent.name}' refused: ${outcome.error}${outcome.detail ? ` — ${outcome.detail}` : ""}`.slice(0, 1000),
  });
  if (!outcome.ok) {
    return {
      ok: false,
      status: outcome.status,
      error: outcome.error,
      detail: outcome.detail ?? null,
      outputText: null,
      toolCalls: [],
      costUsd: null,
      usage: null,
      servedAgentId: null,
      model: null,
      schemaValidation: null,
      pii: outcome.pii ?? null,
      guardrails: outcome.guardrails ?? null,
      trace: outcome.trace ?? null,
    };
  }
  const r = outcome.result;
  return {
    ok: true,
    status: 200,
    error: null,
    detail: null,
    outputText: r.outputText,
    toolCalls: r.toolCalls ?? [],
    costUsd: r.costUsd ?? null,
    usage: r.usage,
    servedAgentId: r.servedAgentId,
    model: r.model ?? null,
    schemaValidation: body.outputSchema ? validateOutputAgainstSchema(body.outputSchema, r.outputText ?? "") : null,
    pii: r.pii ?? null,
    guardrails: r.guardrails ?? null,
    trace: outcome.trace ?? null,
  };
}

function referenceMatch(output: string | null, reference: string | null): "exact" | "contains" | "no" | null {
  if (reference === null || reference.trim() === "") return null;
  if (output === null) return "no";
  const o = output.trim();
  const ref = reference.trim();
  if (o === ref) return "exact";
  return o.includes(ref) ? "contains" : "no";
}

export function registerPlaygroundRoutes(app: FastifyInstance, db: Db, opts: { dataKey?: string | undefined } = {}): void {
  app.post("/v1/playground/run", async (req, reply) => {
    const caller = callerOf(req, reply);
    if (!caller) return;
    const body = playgroundRunSchema.parse(req.body ?? {});
    const rendered = renderPromptTemplate(body.template, body.variables);
    if (!rendered.ok) {
      return reply.status(422).send({ error: "missing_variables", missing: rendered.missing, detail: `give a value for: ${rendered.missing.join(", ")}` });
    }
    const prep = await prepare(db, caller, body);
    if ("status" in prep) return reply.status(prep.status).send(prep.body);
    const refused = await entitlementRefusal(db, caller, prep.agent, { phase: "run" });
    if (refused) return reply.status(refused.status).send(refused.body);
    const call = await governedCall(db, opts.dataKey, caller, prep.agent, rendered.text, body, { phase: "run" });
    if (!call.ok) {
      return reply.status(call.status).send({ error: call.error, detail: call.detail, pii: call.pii, guardrails: call.guardrails, trace: call.trace });
    }
    return {
      outputText: call.outputText,
      toolCalls: call.toolCalls,
      toolCallsExecuted: false,
      toolCallsNote: TOOL_CALLS_NOT_EXECUTED,
      structuredOutput: body.outputSchema ? (RESPONSE_FORMAT_CAPABLE_PROVIDERS.has(prep.agent.provider) ? "native" : "validated_after") : null,
      schemaValidation: call.schemaValidation,
      usage: call.usage,
      costUsd: call.costUsd,
      servedAgentId: call.servedAgentId,
      model: call.model,
      variables: extractPromptVariables(body.template),
      pii: call.pii,
      guardrails: call.guardrails,
      trace: call.trace,
    };
  });

  app.post("/v1/playground/evaluate", async (req, reply) => {
    const caller = callerOf(req, reply);
    if (!caller) return;
    const body = playgroundEvaluateSchema.parse(req.body ?? {});
    const templateVars = extractPromptVariables(body.template);
    let rows: Array<{ inputs: Record<string, string>; reference: string | null; caseId?: string }>;
    let source: { kind: "inline" } | { kind: "dataset"; datasetId: string; name: string; version: number };
    if (body.datasetId) {
      if (!caller.isAdmin) {
        return reply.status(403).send({ error: "dataset_admin_only", detail: "evaluation datasets are admin-managed; give inline rows instead" });
      }
      const [ds] = await db.select().from(evalDatasets).where(eq(evalDatasets.id, body.datasetId));
      if (!ds) return reply.status(404).send({ error: "unknown_dataset" });
      const cases = await db
        .select()
        .from(evalCases)
        .where(and(eq(evalCases.datasetId, ds.id), eq(evalCases.datasetVersion, ds.version)));
      if (cases.length > PROMPT_LIMITS.rowsPerEvaluation) {
        return reply.status(422).send({ error: "dataset_too_large", detail: `at most ${PROMPT_LIMITS.rowsPerEvaluation} rows per run; this dataset has ${cases.length}` });
      }
      rows = cases.map((c) => ({
        caseId: c.id,
        inputs: caseInputAsVariables(c.input, templateVars),
        reference: c.expected === null || c.expected === undefined ? null : typeof c.expected === "string" ? c.expected : JSON.stringify(c.expected),
      }));
      source = { kind: "dataset", datasetId: ds.id, name: ds.name, version: ds.version };
    } else {
      rows = body.rows!.map((r) => ({ inputs: r.inputs, reference: r.reference }));
      source = { kind: "inline" };
    }
    if (!rows.length) return reply.status(422).send({ error: "no_rows" });
    const prep = await prepare(db, caller, body);
    if ("status" in prep) return reply.status(prep.status).send(prep.body);
    // a model the caller may not use is refused for the run as a whole — the
    // same answer as an unknown one; the per-row re-check below still stops a
    // run that a revocation or the kill switch reaches midway
    const upfront = await entitlementRefusal(db, caller, prep.agent, { phase: "evaluate", row: null });
    if (upfront) return reply.status(upfront.status).send(upfront.body);

    const results: Array<Record<string, unknown>> = [];
    let stoppedBy: Refusal | null = null;
    for (const [index, row] of rows.entries()) {
      const base = { index, ...(row.caseId ? { caseId: row.caseId } : {}), inputs: row.inputs, reference: row.reference };
      if (stoppedBy) {
        results.push({ ...base, ok: false, error: "not_run", detail: "an earlier row was refused for the whole run" });
        continue;
      }
      const rendered = renderPromptTemplate(body.template, row.inputs);
      if (!rendered.ok) {
        results.push({ ...base, ok: false, error: "missing_variables", detail: `no value for: ${rendered.missing.join(", ")}`, costUsd: null });
        continue;
      }
      // the entitlement (and the kill switch) is re-checked before every row
      const refused = await entitlementRefusal(db, caller, prep.agent, { phase: "evaluate", row: index });
      if (refused) {
        stoppedBy = refused;
        results.push({ ...base, ok: false, error: refused.body.error, detail: refused.body.detail ?? null, costUsd: null });
        continue;
      }
      const call = await governedCall(db, opts.dataKey, caller, prep.agent, rendered.text, body, { phase: "evaluate", row: index });
      results.push({
        ...base,
        ok: call.ok,
        error: call.error,
        detail: call.detail,
        outputText: call.outputText,
        toolCalls: call.toolCalls,
        costUsd: call.costUsd,
        schemaValidation: call.schemaValidation,
        referenceMatch: call.ok ? referenceMatch(call.outputText, row.reference) : null,
      });
    }
    const succeeded = results.filter((r) => r.ok).length;
    const priced = results.filter((r) => typeof r.costUsd === "number");
    const totalCostUsd = Number(priced.reduce((s, r) => s + (r.costUsd as number), 0).toFixed(8));
    const summary = {
      rows: results.length,
      succeeded,
      failed: results.length - succeeded,
      totalCostUsd,
      unpricedCalls: results.filter((r) => r.ok && typeof r.costUsd !== "number").length,
      schemaPassed: results.filter((r) => (r.schemaValidation as { valid?: boolean } | null)?.valid === true).length,
      referenceMatched: results.filter((r) => r.referenceMatch === "exact" || r.referenceMatch === "contains").length,
      withReference: results.filter((r) => r.reference !== null && r.reference !== undefined && String(r.reference).trim() !== "").length,
    };
    await db.insert(auditLog).values({
      userId: caller.userId,
      objectType: "agent",
      objectId: prep.agent.id,
      detail: { purpose: "playground", phase: "evaluate", source, ...summary, receiptClass: "excluded" },
      effect: stoppedBy ? "deny" : "allow",
      ruleId: PLAYGROUND_RULE_IDS.evaluated,
      ruleChain: [],
      reason: `playground evaluation on '${prep.agent.name}': ${succeeded}/${results.length} rows ran, $${totalCostUsd} total`,
    });
    return {
      source,
      summary,
      results,
      toolCallsExecuted: false,
      toolCallsNote: TOOL_CALLS_NOT_EXECUTED,
      structuredOutput: body.outputSchema ? (RESPONSE_FORMAT_CAPABLE_PROVIDERS.has(prep.agent.provider) ? "native" : "validated_after") : null,
    };
  });
}
