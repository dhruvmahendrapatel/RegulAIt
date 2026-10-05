/**
 * ADR-0173 batch 2b — the prompt playground, end to end on the mock provider.
 *
 *  - a run is an ordinary governed dispatch AS THE CALLER: it is metered
 *    (usage_events), audited, refused for a model the caller holds no grant on,
 *    and refused `model_not_allowed_for_feature` when the org's model policy
 *    restricts the `playground` feature — each with its positive control;
 *  - template variables are filled, a missing one is refused by name;
 *  - the output schema rides as native structured output where the provider
 *    has it, and is validated after the call either way (pass AND fail shown);
 *  - tools are described to the model, and a tool call it makes is returned,
 *    never executed;
 *  - evaluate mode: one governed call per row, ≤ 50 rows, the total cost
 *    summed; a dataset is admin-only (datasets are admin-managed).
 *
 * Shared state: the model policy this file writes is put back to empty in a
 * `finally` (M-012/M-068); the eval dataset it creates is its own.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, auditLog, eq, modelPolicyRules, usageEvents } from "@regulait/db";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import { validateOutputAgainstSchema } from "./playground.js";

let k: BuilderKit;
let admin: Person;
let tester: Person;
let MODEL = "";
let UNHELD = "";

const usage = async (userId: string, agentId: string) =>
  (await k.db.select({ id: usageEvents.id }).from(usageEvents).where(and(eq(usageEvents.userId, userId), eq(usageEvents.agentId, agentId)))).length;

const run = (who: Person, body: Record<string, unknown>) =>
  k.req("POST", "/v1/playground/run", who.auth, { modelAgentId: MODEL, projectId: who.projectId, ...body });

beforeAll(async () => {
  k = await builderKit("pgnd");
  admin = await k.person("admin", { admin: true });
  tester = await k.person("tester");
  MODEL = await k.model("model", { price: 3 });
  UNHELD = await k.model("unheld", { price: 3 });
  await k.grantModel(tester.id, MODEL);
  await k.grantModel(admin.id, MODEL);
});

afterAll(async () => {
  await k.close();
});

describe("a run", () => {
  it("is refused for a token with no identity", async () => {
    const r = await k.req("POST", "/v1/playground/run", k.BOOT, { modelAgentId: MODEL, template: "hi" });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("playground_requires_identity");
  });

  it("fills the template and dispatches as the caller — metered and audited", async () => {
    const before = await usage(tester.id, MODEL);
    const r = await run(tester, { template: "Explain {{topic}} to {{who}}.", variables: { topic: "retention", who: "auditors" } });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(body.outputText).toContain("retention");
    expect(body.variables).toEqual(["topic", "who"]);
    expect(body.costUsd).toBeGreaterThan(0);
    expect(body.toolCallsExecuted).toBe(false);
    expect(await usage(tester.id, MODEL)).toBe(before + 1);
    const audits = await k.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, tester.id), eq(auditLog.objectId, MODEL), eq(auditLog.ruleId, "playground-dispatched")));
    expect(audits.length).toBeGreaterThan(0);
  });

  it("refuses a missing variable by name, before any call", async () => {
    const before = await usage(tester.id, MODEL);
    const r = await run(tester, { template: "Explain {{topic}} to {{who}}.", variables: { topic: "x" } });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toMatchObject({ error: "missing_variables", missing: ["who"] });
    expect(await usage(tester.id, MODEL)).toBe(before);
  });

  it("refuses a model the caller holds no grant on (the control: the held model runs)", async () => {
    const r = await run(tester, { modelAgentId: UNHELD, template: "hi" });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("model_not_entitled");
    expect(await usage(tester.id, UNHELD)).toBe(0);
    const denied = await k.db.select().from(auditLog).where(and(eq(auditLog.userId, tester.id), eq(auditLog.objectId, UNHELD), eq(auditLog.effect, "deny")));
    expect(denied.length).toBeGreaterThan(0);
  });

  it("obeys the org's model policy for the playground feature", async () => {
    const put = (rules: unknown[]) => k.req("PUT", "/v1/model-policy", admin.auth, { rules });
    const other = await k.model("policy-only", { price: 3 });
    const set = await put([
      { feature: "playground", dataClass: null, restricted: true, allowedAgentIds: [other], allowedProviders: [], defaultAgentId: null },
    ]);
    expect(set.statusCode, set.body).toBe(200);
    try {
      const r = await run(tester, { template: "hi" });
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toBe("model_not_allowed_for_feature");
      // the same model in chat is untouched: the rule is the playground's
      const chat = await k.req("POST", `/v1/agents/${MODEL}/invoke`, tester.auth, { mode: "chat", input: "hi", projectId: tester.projectId });
      expect(chat.statusCode, chat.body).toBe(200);
    } finally {
      const back = await put([]);
      expect(back.statusCode, back.body).toBe(200);
    }
    expect(await k.db.select().from(modelPolicyRules)).toHaveLength(0);
    expect((await run(tester, { template: "hi" })).statusCode).toBe(200);
  });

  it("validates the output against the schema — natively constrained on a capable provider — and says pass or fail", async () => {
    const passing = await run(tester, {
      template: "Give me JSON about {{x}}",
      variables: { x: "audits" },
      outputSchema: { type: "object", required: ["format", "topic"], properties: { format: { const: "json_schema" }, topic: { type: "string" } } },
    });
    expect(passing.statusCode, passing.body).toBe(200);
    expect(passing.json().structuredOutput).toBe("native");
    expect(passing.json().schemaValidation).toEqual({ valid: true, errors: [] });
    const failing = await run(tester, {
      template: "Give me JSON about {{x}}",
      variables: { x: "audits" },
      outputSchema: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } },
    });
    expect(failing.statusCode, failing.body).toBe(200);
    expect(failing.json().schemaValidation.valid).toBe(false);
    expect(failing.json().schemaValidation.errors.join(" ")).toContain("answer");
    // a schema that does not compile is refused before any call
    const bad = await run(tester, { template: "x", outputSchema: { type: 12 } });
    expect(bad.statusCode).toBe(422);
  });

  it("validates after the call where the provider has no native mechanism (unit)", () => {
    const schema = { type: "object", required: ["a"], properties: { a: { type: "string" } } };
    expect(validateOutputAgainstSchema(schema, '```json\n{"a":"x"}\n```')).toEqual({ valid: true, errors: [] });
    expect(validateOutputAgainstSchema(schema, "not json").valid).toBe(false);
    expect(validateOutputAgainstSchema(schema, '{"a":1}').valid).toBe(false);
  });

  it("describes tools to the model and returns its tool call without executing it", async () => {
    const r = await run(tester, {
      template: "Find the record. <<use-tool:lookup_record>>",
      tools: [{ name: "lookup_record", description: "look a record up", inputSchema: { type: "object", properties: { id: { type: "string" } } } }],
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().toolCalls).toEqual([expect.objectContaining({ name: "lookup_record" })]);
    expect(r.json().toolCallsExecuted).toBe(false);
    expect(r.json().toolCallsNote).toMatch(/not executed/);
  });
});

describe("evaluate mode", () => {
  it("runs one governed call per inline row and sums the cost", async () => {
    const before = await usage(tester.id, MODEL);
    const r = await k.req("POST", "/v1/playground/evaluate", tester.auth, {
      modelAgentId: MODEL,
      projectId: tester.projectId,
      template: "Explain {{topic}}.",
      rows: [
        { inputs: { topic: "retention" }, reference: "retention" },
        { inputs: { topic: "consent" }, reference: "zzz-never-in-output" },
        { inputs: {}, reference: null },
      ],
    });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(body.summary).toMatchObject({ rows: 3, succeeded: 2, failed: 1, referenceMatched: 1, withReference: 2 });
    expect(body.results[2]).toMatchObject({ ok: false, error: "missing_variables" });
    expect(body.results[0].referenceMatch).toBe("contains");
    expect(body.results[1].referenceMatch).toBe("no");
    const sum = body.results.reduce((s: number, x: { costUsd: number | null }) => s + (x.costUsd ?? 0), 0);
    expect(body.summary.totalCostUsd).toBeCloseTo(sum, 8);
    expect(body.summary.totalCostUsd).toBeGreaterThan(0);
    expect(await usage(tester.id, MODEL)).toBe(before + 2);
  });

  it("refuses more than 50 rows", async () => {
    const rows = Array.from({ length: 51 }, () => ({ inputs: { topic: "x" } }));
    const r = await k.req("POST", "/v1/playground/evaluate", tester.auth, { modelAgentId: MODEL, template: "{{topic}}", rows });
    expect(r.statusCode).toBe(400);
  });

  it("reuses an evaluation dataset — for admins only", async () => {
    const ds = await k.req("POST", "/v1/evals/datasets", admin.auth, { name: `pgnd-ds-${k.RUN}`, scorerKind: "exact" });
    expect(ds.statusCode, ds.body).toBe(201);
    const dsId = ds.json().id as string;
    for (const input of [JSON.stringify({ topic: "audits" }), "plain words"]) {
      const c = await k.req("POST", `/v1/evals/datasets/${dsId}/cases`, admin.auth, { input, expected: "audits" });
      expect(c.statusCode, c.body).toBe(201);
    }
    const refused = await k.req("POST", "/v1/playground/evaluate", tester.auth, { modelAgentId: MODEL, template: "{{topic}}", datasetId: dsId });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("dataset_admin_only");
    const ok = await k.req("POST", "/v1/playground/evaluate", admin.auth, {
      modelAgentId: MODEL, projectId: admin.projectId, template: "Explain {{topic}}.", datasetId: dsId,
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().source).toMatchObject({ kind: "dataset", datasetId: dsId });
    expect(ok.json().summary.rows).toBe(2);
    // a JSON object input is the variables; a plain input binds the template's only variable
    expect(ok.json().results.map((x: { inputs: Record<string, string> }) => x.inputs)).toEqual(
      expect.arrayContaining([{ topic: "audits" }, { topic: "plain words" }]),
    );
  });
});
