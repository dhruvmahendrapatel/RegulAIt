/**
 * ADR-0173 §3 — the model allow-list matrix.
 *
 * The policy is ORG-WIDE state, so every test that writes it restores the empty
 * policy in a `finally` (M-012), and the file's afterAll clears it again. Every
 * refusal is asserted with its positive control beside it: the same person, the
 * same call, the binding the matrix allows.
 *
 * Two mock bindings, both granted to `owner`: ALLOWED is the one each policy
 * admits, BLOCKED the one it forbids. Both are keyless and dispatchable.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, and, auditLog, eq, modelPolicyRules, usageEvents } from "@regulait/db";
import { MODEL_NOT_ALLOWED_FOR_FEATURE } from "@regulait/shared";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import { executeGovernedDispatch, type AgentRow } from "./agents-connectors.js";
import { buildAgentDecider } from "./evals.js";
import { prepareCompatCall, AGENT_HEADER, COMPAT_MODE } from "./compat-core.js";
import { listEntitledModels } from "./compat-models.js";
import type { FastifyRequest } from "fastify";

let k: BuilderKit;
let admin: Person;
let owner: Person;
let outsider: Person;
let ALLOWED = "";
let BLOCKED = "";
let NOT_HELD = "";

type Rule = Record<string, unknown>;
const put = (who: Person | { auth: Record<string, string> }, rules: Rule[]) =>
  k.req("PUT", "/v1/model-policy", who.auth, { rules });

/** set a policy for the body of `fn`, and ALWAYS put the empty policy back */
async function withPolicy(rules: Rule[], fn: () => Promise<void>) {
  const r = await put(admin, rules);
  expect(r.statusCode, r.body).toBe(200);
  try {
    await fn();
  } finally {
    const back = await put(admin, []);
    expect(back.statusCode, back.body).toBe(200);
  }
}

const only = (feature: string, ids: string[], extra: Rule = {}): Rule => ({
  feature,
  dataClass: null,
  restricted: true,
  allowedAgentIds: ids,
  allowedProviders: [],
  defaultAgentId: null,
  ...extra,
});

const policyAudits = async () =>
  (await k.db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.objectType, "model_policy"))).length;
const usage = async (userId: string, agentId: string) =>
  (await k.db.select({ id: usageEvents.id }).from(usageEvents).where(and(eq(usageEvents.userId, userId), eq(usageEvents.agentId, agentId))))
    .length;
const agentRow = async (id: string) => (await k.db.select().from(agents).where(eq(agents.id, id)))[0] as AgentRow;

/** a keyless mock binding usable in chat AND in the compat surface's mode */
async function mkModel(label: string) {
  const r = await k.req("POST", "/v1/agents", k.BOOT, {
    name: `mpol-${label}-${k.RUN}`, provider: "mock", tier: 1, modes: ["chat", COMPAT_MODE], model: "mock-balanced",
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}

beforeAll(async () => {
  k = await builderKit("mpol");
  // a clean slate: an earlier crashed run of this file must not leave a policy behind
  await k.db.delete(modelPolicyRules);
  admin = await k.person("admin", { admin: true });
  owner = await k.person("owner");
  outsider = await k.person("outsider");
  ALLOWED = await mkModel("allowed");
  BLOCKED = await mkModel("blocked");
  NOT_HELD = await mkModel("not-held");
  await k.grantModel(owner.id, ALLOWED);
  await k.grantModel(owner.id, BLOCKED);
}, 120_000);

afterAll(async () => {
  await k.db.delete(modelPolicyRules);
  await k.close();
});

// ---------------------------------------------------------------------------
describe("the policy itself", () => {
  it("reads empty for everyone, and an empty policy is today's behaviour", async () => {
    for (const who of [admin, owner]) {
      const r = await k.req("GET", "/v1/model-policy", who.auth);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().rules).toEqual([]);
      expect(r.json().features.map((f: { id: string }) => f.id)).toEqual([
        "chat", "builder", "copilot", "intake_assist", "evals", "orchestration", "compat",
      ]);
    }
    const inv = await k.req("POST", `/v1/agents/${BLOCKED}/invoke`, owner.auth, { mode: "chat", input: "hi" });
    expect(inv.statusCode, inv.body).toBe(200);
  });

  it("only an admin may replace it; the replacement is audited, an identical one writes nothing", async () => {
    const refused = await put(owner, [only("chat", [ALLOWED])]);
    expect(refused.statusCode).toBe(403);
    expect((await k.db.select().from(modelPolicyRules)).length).toBe(0);

    const before = await policyAudits();
    try {
      const r = await put(admin, [only("chat", [ALLOWED], { defaultAgentId: ALLOWED })]);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().changed).toBe(true);
      expect(r.json().rules).toEqual([only("chat", [ALLOWED], { defaultAgentId: ALLOWED })]);
      expect(await policyAudits()).toBe(before + 1);
      const [row] = await k.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.objectType, "model_policy"), eq(auditLog.userId, admin.id)));
      expect(row?.ruleId).toBe("model-policy-set");
      expect((row?.detail as { after: unknown[] }).after).toHaveLength(1);

      const again = await put(admin, [only("chat", [ALLOWED], { defaultAgentId: ALLOWED })]);
      expect(again.json().changed).toBe(false);
      expect(await policyAudits()).toBe(before + 1);
    } finally {
      await put(admin, []);
    }
    expect(await policyAudits()).toBe(before + 2);
  });

  it("a person reads the policy as it applies to THEM: ids only for bindings they hold", async () => {
    await withPolicy([only("chat", [ALLOWED, NOT_HELD], { defaultAgentId: NOT_HELD })], async () => {
      const mine = (await k.req("GET", "/v1/model-policy", owner.auth)).json();
      expect(mine.scope).toBe("you");
      expect(mine.rules[0].allowedAgentIds).toEqual([ALLOWED]);
      expect(mine.rules[0].defaultAgentId).toBeNull();
      expect(mine.rules[0].restricted).toBe(true);
      const theirs = (await k.req("GET", "/v1/model-policy", outsider.auth)).json();
      expect(theirs.rules[0].allowedAgentIds).toEqual([]);
      const org = (await k.req("GET", "/v1/model-policy", admin.auth)).json();
      expect(org.scope).toBe("organisation");
      expect(org.rules[0].allowedAgentIds).toEqual([ALLOWED, NOT_HELD]);
      expect(org.rules[0].defaultAgentId).toBe(NOT_HELD);
    });
  });

  it("refuses an unknown binding, a default its own rules forbid, and a duplicate rule", async () => {
    const ghost = "00000000-0000-4000-8000-000000000001";
    const unknown = await put(admin, [only("chat", [ghost])]);
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().error).toBe("unknown_model_binding");

    const badDefault = await put(admin, [only("chat", [ALLOWED], { defaultAgentId: BLOCKED })]);
    expect(badDefault.statusCode).toBe(422);
    expect(badDefault.json().error).toBe("default_not_allowed");
    // a data-class rule's default must also pass the base rule (classes only narrow)
    const classDefault = await put(admin, [
      only("intake_assist", [ALLOWED]),
      only("intake_assist", [BLOCKED], { dataClass: "public", defaultAgentId: BLOCKED }),
    ]);
    expect(classDefault.statusCode).toBe(422);
    expect(classDefault.json().error).toBe("default_not_allowed");

    const dup = await put(admin, [only("chat", [ALLOWED]), only("chat", [BLOCKED])]);
    expect(dup.statusCode).toBe(422);
    expect((await k.db.select().from(modelPolicyRules)).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("enforced in the shared model-access decision, per feature", () => {
  it("chat (the native invoke path): refused by name and audited; the allowed binding answers", async () => {
    await withPolicy([only("chat", [ALLOWED])], async () => {
      const r = await k.req("POST", `/v1/agents/${BLOCKED}/invoke`, owner.auth, { mode: "chat", input: "hi" });
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json().decision.ruleId).toBe(MODEL_NOT_ALLOWED_FOR_FEATURE);
      expect(r.json().decision.reason).toContain("Chat");
      const rows = await k.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.userId, owner.id), eq(auditLog.objectId, BLOCKED), eq(auditLog.ruleId, MODEL_NOT_ALLOWED_FOR_FEATURE)));
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]!.effect).toBe("deny");

      const ok = await k.req("POST", `/v1/agents/${ALLOWED}/invoke`, owner.auth, { mode: "chat", input: "hi" });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json().decision.effect).toBe("allow");
    });
  });

  it("a provider entry admits every binding of that provider", async () => {
    await withPolicy([only("chat", [], { allowedProviders: ["mock"] })], async () => {
      const r = await k.req("POST", `/v1/agents/${BLOCKED}/invoke`, owner.auth, { mode: "chat", input: "hi" });
      expect(r.statusCode, r.body).toBe(200);
    });
    await withPolicy([only("chat", [], { allowedProviders: ["anthropic"] })], async () => {
      const r = await k.req("POST", `/v1/agents/${BLOCKED}/invoke`, owner.auth, { mode: "chat", input: "hi" });
      expect(r.statusCode, r.body).toBe(403);
    });
  });

  it("is scoped to its feature: restricting chat leaves the builder alone, and vice versa", async () => {
    await withPolicy([only("chat", [ALLOWED])], async () => {
      const b = await k.req("POST", "/v1/builder/agents", owner.auth, {
        name: `scoped ${k.RUN}`, connectionFormat: "shared", computerUse: false, modelAgentId: BLOCKED,
      });
      expect(b.statusCode, b.body).toBe(201);
    });
    await withPolicy([only("builder", [ALLOWED])], async () => {
      const r = await k.req("POST", `/v1/agents/${BLOCKED}/invoke`, owner.auth, { mode: "chat", input: "hi" });
      expect(r.statusCode, r.body).toBe(200);
    });
  });

  it("the dispatch core refuses a SERVED binding the matrix forbids (routing / fallback cannot reach it)", async () => {
    await withPolicy([only("chat", [ALLOWED])], async () => {
      const blocked = await agentRow(BLOCKED);
      const before = await usage(owner.id, BLOCKED);
      const out = await executeGovernedDispatch(k.db, "a".repeat(64), {
        userId: owner.id,
        served: blocked,
        requestedAgentId: ALLOWED,
        input: "hi",
        modelFeature: { feature: "chat" },
      });
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.status).toBe(403);
        expect(out.error).toBe(MODEL_NOT_ALLOWED_FOR_FEATURE);
      }
      expect(await usage(owner.id, BLOCKED)).toBe(before);

      const allowed = await agentRow(ALLOWED);
      const ok = await executeGovernedDispatch(k.db, "a".repeat(64), {
        userId: owner.id,
        served: allowed,
        requestedAgentId: ALLOWED,
        input: "hi",
        modelFeature: { feature: "chat" },
      });
      expect(ok.ok, JSON.stringify(ok)).toBe(true);
    });
  });

  it("copilot narration: refused model_not_allowed_for_feature and audited; the allowed narrator runs", async () => {
    await withPolicy([only("copilot", [ALLOWED])], async () => {
      const r = await k.req("POST", "/v1/copilot/ask", owner.auth, { question: "spend this month?", narratorAgentId: BLOCKED });
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json().error).toBe(MODEL_NOT_ALLOWED_FOR_FEATURE);
      const rows = await k.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.userId, owner.id), eq(auditLog.objectType, "copilot_query"), eq(auditLog.ruleId, MODEL_NOT_ALLOWED_FOR_FEATURE)));
      expect(rows.length).toBe(1);

      const ok = await k.req("POST", "/v1/copilot/ask", owner.auth, { question: "spend this month?", narratorAgentId: ALLOWED });
      expect(ok.statusCode, ok.body).toBe(201);
    });
  });

  const intake = (dataCategories: string[], extra: Rule = {}) => ({
    title: "Model policy probe",
    description: "A probe of the intake assistant's model policy",
    euAiAct: {
      purposeDomain: "internal-productivity",
      affectedPersons: [],
      decisionAutonomy: "informs-human",
      biometricUse: "none",
      emotionRecognition: false,
      socialScoring: false,
      manipulativeTechniques: false,
      profilesNaturalPersons: false,
      safetyComponent: false,
      interactsWithHumans: true,
      generatesSyntheticContent: true,
    },
    context: {
      sectors: [],
      dataCategories,
      deployment: "internal",
      euNexus: false,
      usesExternalVendor: false,
      generative: true,
      autonomousActions: false,
      toolsUsed: [],
    },
    draftNarrative: true,
    ...extra,
  });

  it("intake assistant: refused (and audited) for a forbidden binding, drafted with the allowed one", async () => {
    await withPolicy([only("intake_assist", [ALLOWED])], async () => {
      const auditsBefore = (
        await k.db.select({ id: auditLog.id }).from(auditLog).where(and(eq(auditLog.userId, owner.id), eq(auditLog.ruleId, MODEL_NOT_ALLOWED_FOR_FEATURE)))
      ).length;
      const r = await k.req("POST", "/v1/use-cases/intake/assist", owner.auth, intake(["public"], { agentId: BLOCKED }));
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().narrative.status).toBe("refused");
      expect(r.json().narrative.reason).toContain("Intake assistant");
      expect(
        (await k.db.select({ id: auditLog.id }).from(auditLog).where(and(eq(auditLog.userId, owner.id), eq(auditLog.ruleId, MODEL_NOT_ALLOWED_FOR_FEATURE))))
          .length,
      ).toBe(auditsBefore + 1);

      const before = await usage(owner.id, ALLOWED);
      const ok = await k.req("POST", "/v1/use-cases/intake/assist", owner.auth, intake(["public"], { agentId: ALLOWED }));
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json().narrative.status).not.toBe("refused");
      expect(await usage(owner.id, ALLOWED)).toBe(before + 1);
    });
  });

  it("a data-class rule narrows the feature only for data of that class", async () => {
    // the feature is unrestricted; regulated data may use ALLOWED only
    await withPolicy([only("intake_assist", [ALLOWED], { dataClass: "regulated" })], async () => {
      const regulated = await k.req("POST", "/v1/use-cases/intake/assist", owner.auth, intake(["health"], { agentId: BLOCKED }));
      expect(regulated.json().narrative.status).toBe("refused");
      expect(regulated.json().narrative.reason).toContain("regulated data");
      // positive controls: the same binding on public data, and the allowed binding on regulated data
      const pub = await k.req("POST", "/v1/use-cases/intake/assist", owner.auth, intake(["public"], { agentId: BLOCKED }));
      expect(pub.json().narrative.status).not.toBe("refused");
      const ok = await k.req("POST", "/v1/use-cases/intake/assist", owner.auth, intake(["health"], { agentId: ALLOWED }));
      expect(ok.json().narrative.status).not.toBe("refused");
    });
  });

  it("intake assistant: with no agent named, the policy default drafts (when the person may use it)", async () => {
    const skipped = await k.req("POST", "/v1/use-cases/intake/assist", owner.auth, intake(["public"]));
    expect(skipped.json().narrative).toMatchObject({ status: "skipped" });
    await withPolicy([only("intake_assist", [ALLOWED, BLOCKED], { defaultAgentId: ALLOWED })], async () => {
      const before = await usage(owner.id, ALLOWED);
      const r = await k.req("POST", "/v1/use-cases/intake/assist", owner.auth, intake(["public"]));
      expect(r.json().narrative.status).not.toBe("skipped");
      expect(await usage(owner.id, ALLOWED)).toBe(before + 1);
      // a default is never a grant: someone who does not hold it is skipped, not served
      const theirs = await k.req("POST", "/v1/use-cases/intake/assist", outsider.auth, intake(["public"]));
      expect(theirs.json().narrative).toMatchObject({ status: "skipped" });
    });
  });

  it("agent builder: a forbidden model cannot be chosen; the policy default is applied to a new agent", async () => {
    await withPolicy([only("builder", [ALLOWED], { defaultAgentId: ALLOWED })], async () => {
      const refused = await k.req("POST", "/v1/builder/agents", owner.auth, {
        name: `bad model ${k.RUN}`, connectionFormat: "shared", computerUse: false, modelAgentId: BLOCKED,
      });
      expect(refused.statusCode, refused.body).toBe(403);
      const ok = await k.req("POST", "/v1/builder/agents", owner.auth, {
        name: `good model ${k.RUN}`, connectionFormat: "shared", computerUse: false, modelAgentId: ALLOWED,
      });
      expect(ok.statusCode, ok.body).toBe(201);
    });
    // no model named: the builder's policy default — here the binding that is
    // NOT first by name ("mpol-allowed-…" sorts before "mpol-blocked-…"), which
    // is what the pre-policy fallback would have picked
    const create = () =>
      k.req("POST", "/v1/builder/agents", owner.auth, { name: `default model ${k.RUN}`, connectionFormat: "shared", computerUse: false });
    const without = await create();
    expect(without.json().agent.modelAgent?.id).toBe(ALLOWED);
    await withPolicy([only("builder", [ALLOWED, BLOCKED], { defaultAgentId: BLOCKED })], async () => {
      const dflt = await create();
      expect(dflt.statusCode, dflt.body).toBe(201);
      expect(dflt.json().agent.modelAgent?.id).toBe(BLOCKED);
    });
  });

  const fakeReq = (userId: string, agentId: string) =>
    ({ authCtx: { userId, isAdmin: false, via: "api-key" }, headers: { [AGENT_HEADER]: agentId } }) as unknown as FastifyRequest;

  it("compatible APIs: the requested binding is refused by name, and /v1/models does not list it", async () => {
    await withPolicy([only("compat", [ALLOWED])], async () => {
      const r = await prepareCompatCall(k.db, "a".repeat(64), fakeReq(owner.id, BLOCKED), {
        requestedModel: "mock-balanced", stream: false, text: "hi",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(403);
        expect(r.error).toBe(MODEL_NOT_ALLOWED_FOR_FEATURE);
      }
      const ok = await prepareCompatCall(k.db, "a".repeat(64), fakeReq(owner.id, ALLOWED), {
        requestedModel: "mock-balanced", stream: false, text: "hi",
      });
      expect(ok.ok, JSON.stringify(ok)).toBe(true);
      const listed = (await listEntitledModels(k.db, owner.id, null)).flatMap((m) => m.agentIds);
      expect(listed).toContain(ALLOWED);
      expect(listed).not.toContain(BLOCKED);
    });
  });

  it("evaluations: the agent under test (and a judge) is refused through the shared decider", async () => {
    await withPolicy([only("evals", [ALLOWED])], async () => {
      const decide = await buildAgentDecider(k.db, owner.id);
      expect(decide(await agentRow(BLOCKED), "chat").ruleId).toBe(MODEL_NOT_ALLOWED_FOR_FEATURE);
      expect(decide(await agentRow(ALLOWED), "chat").effect).toBe("allow");
    });
  });

  it("orchestration: a plan whose worker binding is forbidden fails its envelope; the allowed one plans", async () => {
    const graph = (ownerAgentId: string) => ({
      graph: {
        run: `mpol-run-${Math.random().toString(36).slice(2, 8)}`,
        escalationApproverUserId: admin.id,
        nodes: [{ id: "task", title: "Do the thing", ownerAgentId, mode: "chat", estimate: { in: 5, out: 10 } }],
      },
    });
    await withPolicy([only("orchestration", [ALLOWED])], async () => {
      const r = await k.req("POST", "/v1/runs", owner.auth, graph(BLOCKED));
      expect(r.statusCode, r.body).toBe(422);
      expect(r.json().error).toBe("entitlement_exceeded");
      expect(r.json().nodes[0].decision.ruleId).toBe(MODEL_NOT_ALLOWED_FOR_FEATURE);
      const ok = await k.req("POST", "/v1/runs", owner.auth, graph(ALLOWED));
      expect(ok.statusCode, ok.body).toBe(201);
    });
  });
});
