/**
 * ADR-0180 addendum (2026-11-21, lane E51) — oversight levels enforced at runtime, against the real schema and the
 * real chat route. Differential: for each class the same agent is run with its floors unmet and then met.
 *
 *   - assist and supervised: an unmet floor never refuses a run (unchanged behaviour);
 *   - delegated and autonomous: an unmet floor refuses the run with 403 `autonomy_floor_unmet`, audited with the
 *     unmet floor ids, before any model call; with every floor met the run goes ahead;
 *   - an admin relaxes the gate (step-up, reason, audited) and the run goes ahead, audited as a relaxed allow; a
 *     restore blocks it again; the owner cannot relax; the transitions follow AUTONOMY_ENFORCEMENT_MACHINE;
 *   - an error checking the floors refuses the run (503 `autonomy_floor_unverifiable`): fail closed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  and,
  auditLog,
  builderAgents,
  builderMessages,
  desc,
  eq,
  evalDatasets,
  evalRuns,
  guardrailConfigs,
  inArray,
  modelCardApprovals,
  modelCards,
  redteamLibraries,
  redteamRuns,
} from "@regulait/db";
import { AUTONOMY_DISPATCH_RULE_IDS, AUTONOMY_ENFORCEMENT_MACHINE, autonomyDispatchVerdict } from "@regulait/shared";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import { relaxDataPostureForTest } from "./testing/strict-data-posture.js";
import { relaxStepUpAround } from "./testing/step-up-posture.js";
import { autonomyDispatchGate } from "./autonomy.js";

let k: BuilderKit;
let owner: Person;
let admin: Person;
/** a priced model whose floors are put in place in beforeAll */
let metModel = "";
/** a priced model with only its card approved: the guardrail and red-team floors are not in place */
let bareModel = "";
let restorePosture: (() => Promise<void>) | undefined;

const newAgent = async (modelAgentId: string, extra: Record<string, unknown> = {}) => {
  const r = await k.req("POST", "/v1/builder/agents", owner.auth, {
    name: `E51 ${Math.random().toString(36).slice(2, 7)}`,
    connectionFormat: "shared",
    computerUse: false,
    projectId: owner.projectId,
    modelAgentId,
    ...extra,
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().agent as { id: string; name: string };
};
const declare = async (id: string, cls: string) => {
  const r = await k.req("PUT", `/v1/builder/agents/${id}/autonomy`, owner.auth, { class: cls, note: "E51 differential test" });
  expect(r.statusCode, r.body).toBe(200);
};
const chat = (id: string, who: Person = owner) => k.req("POST", `/v1/builder/agents/${id}/chat`, who.auth, { message: "hello" });
const enforcement = (id: string, who: Person, body: unknown) => k.req("PUT", `/v1/builder/agents/${id}/autonomy/enforcement`, who.auth, body);
const newestGateAudit = async (agentId: string) =>
  (
    await k.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, agentId), inArray(auditLog.ruleId, Object.values(AUTONOMY_DISPATCH_RULE_IDS))))
      .orderBy(desc(auditLog.at), desc(auditLog.id))
      .limit(1)
  )[0];
const agentReplies = async (agentId: string) =>
  (await k.db.select({ id: builderMessages.id }).from(builderMessages).where(and(eq(builderMessages.agentId, agentId), eq(builderMessages.role, "agent")))).length;

beforeAll(async () => {
  k = await builderKit("e51-gate");
  // the pre-strict all-log guardrail posture, so the guardrail floors start unmet (as in autonomy.test.ts)
  restorePosture = await relaxDataPostureForTest(k.db, { org: false, interception: false });
  owner = await k.person("owner");
  admin = await k.person("admin", { admin: true });
  metModel = await k.model("met", { price: 1 });
  bareModel = await k.model("bare", { price: 1 });
  await k.grantModel(owner.id, metModel);
  await k.grantModel(owner.id, bareModel);

  // every delegated and autonomous floor of `metModel`: guardrails at block, an approved card, a passing agentic run
  await k.db.insert(guardrailConfigs).values({ scope: "agent", scopeId: metModel, promptInjectionMode: "block", jailbreakMode: "block" });
  // both models carry an approved card: model risk management refuses an uncarded model on its own (mrmEnforced),
  // which would hide the gate under test
  for (const m of [metModel, bareModel]) {
    const [card] = await k.db.insert(modelCards).values({ agentId: m, intendedUse: `e51 ${k.RUN}` }).returning();
    await k.db.insert(modelCardApprovals).values({
      cardId: card!.id,
      status: "approved",
      approverUserId: admin.id,
      decidedBy: admin.id,
      decidedAt: new Date(),
      validUntil: new Date(Date.now() + 90 * 86_400_000),
    });
  }
  const [lib] = await k.db.insert(redteamLibraries).values({ name: `e51-lib-${k.RUN}` }).returning();
  const [ds] = await k.db.insert(evalDatasets).values({ name: `e51-ds-${k.RUN}` }).returning();
  const [ev] = await k.db.insert(evalRuns).values({ datasetId: ds!.id, datasetVersion: 1, agentId: metModel, agentName: "met", trigger: "manual" }).returning();
  await k.db.insert(redteamRuns).values({
    libraryId: lib!.id,
    libraryName: lib!.name,
    libraryVersion: 1,
    evalRunId: ev!.id,
    agentId: metModel,
    agentName: "met",
    classSummary: ["indirect_prompt_injection", "tool_abuse", "excessive_agency"].map((attackClass) => ({ attackClass, probes: 4, resisted: 4, defeated: 0 })),
    finishedAt: new Date(Date.now() - 86_400_000),
  });
}, 120_000);

afterAll(async () => {
  await restorePosture?.();
  await k.db.delete(guardrailConfigs).where(and(eq(guardrailConfigs.scope, "agent"), inArray(guardrailConfigs.scopeId, [metModel, bareModel].filter(Boolean))));
  await k.close();
});

describe("assist and supervised keep their behaviour: an unmet floor never refuses a run", () => {
  it("assist (nothing set up) runs", async () => {
    const a = await newAgent(bareModel);
    const r = await chat(a.id);
    expect(r.statusCode, r.body).toBe(200);
  });

  it("supervised with its guardrail floor unmet runs, and its view says the gate does not block it", async () => {
    const a = await newAgent(bareModel);
    await declare(a.id, "supervised");
    const v = await k.req("GET", `/v1/builder/agents/${a.id}/autonomy`, owner.auth);
    expect(v.json().autonomy.floors.some((f: { met: boolean }) => !f.met)).toBe(true);
    expect(v.json().autonomy.enforcement).toMatchObject({ state: "enforced", blocksDispatch: false });
    expect((await chat(a.id)).statusCode).toBe(200);
  });
});

describe("delegated and autonomous: an unmet floor refuses the run, a met floor allows it", () => {
  it("delegated, floors unmet: 403 autonomy_floor_unmet with the reason, audited, and nothing dispatched", async () => {
    const a = await newAgent(bareModel);
    await declare(a.id, "delegated");
    const r = await chat(a.id);
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json().error).toBe("autonomy_floor_unmet");
    expect(r.json().detail).toContain("runs as delegated");
    expect(await agentReplies(a.id)).toBe(0);
    const row = await newestGateAudit(a.id);
    expect(row).toMatchObject({ effect: "deny", ruleId: AUTONOMY_DISPATCH_RULE_IDS.blocked, userId: owner.id });
    expect((row!.detail as { unmetFloors: string[] }).unmetFloors.sort()).toEqual(
      ["agentic_redteam_measured", "guardrails_block", "guardrails_warn"].sort(),
    );
    const v = await k.req("GET", `/v1/builder/agents/${a.id}/autonomy`, owner.auth);
    expect(v.json().autonomy.enforcement).toMatchObject({ state: "enforced", blocksDispatch: true });
  });

  it("delegated, every floor met: runs", async () => {
    const a = await newAgent(metModel);
    await declare(a.id, "delegated");
    const r = await chat(a.id);
    expect(r.statusCode, r.body).toBe(200);
    expect(await agentReplies(a.id)).toBe(1);
  });

  it("autonomous: refused for the one floor it lacks (a monthly limit), and runs once it is set", async () => {
    const a = await newAgent(metModel);
    await declare(a.id, "autonomous");
    const r = await chat(a.id);
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json().error).toBe("autonomy_floor_unmet");
    expect((await newestGateAudit(a.id))!.detail).toMatchObject({ autonomyClass: "autonomous", unmetFloors: ["monthly_limit_set"] });
    await k.db.update(builderAgents).set({ monthlyLimitUsd: 25 }).where(eq(builderAgents.id, a.id));
    expect((await chat(a.id)).statusCode).toBe(200);
  });

  it("an observed class counts as a declared one: computer use makes an agent delegated, and it is refused", async () => {
    const a = await newAgent(bareModel, { computerUse: true });
    const r = await chat(a.id);
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json().error).toBe("autonomy_floor_unmet");
  });
});

describe("an admin may relax the gate per agent, audited; the transitions are the declared machine's", () => {
  it("owner refused, admin without step-up refused, admin with step-up relaxes; the run is audited as relaxed; restore blocks again", async () => {
    const a = await newAgent(bareModel);
    await declare(a.id, "delegated");
    expect((await chat(a.id)).statusCode).toBe(403);

    // only an admin
    expect((await enforcement(a.id, owner, { event: "relax", reason: "pilot" })).statusCode).toBe(403);
    // a reason is required
    expect((await enforcement(a.id, admin, { event: "relax" })).statusCode).toBe(400);
    // relaxing a strict default takes a step-up: refused without one, and nothing changes
    const noStepUp = await enforcement(a.id, admin, { event: "relax", reason: "pilot" });
    expect(noStepUp.statusCode, noStepUp.body).not.toBe(200);
    const [still] = await k.db.select().from(builderAgents).where(eq(builderAgents.id, a.id));
    expect(still!.autonomyEnforcement).toBe("enforced");

    const relaxed = await relaxStepUpAround(k.db, () => enforcement(a.id, admin, { event: "relax", reason: "supervised pilot until the card is signed" }));
    expect(relaxed.statusCode, relaxed.body).toBe(200);
    expect(relaxed.json().autonomy.enforcement).toMatchObject({ state: "relaxed", blocksDispatch: false, relaxedBy: { id: admin.id } });
    const changed = await newestGateAudit(a.id);
    expect(changed).toMatchObject({ effect: "allow", ruleId: AUTONOMY_DISPATCH_RULE_IDS.changed, userId: admin.id });
    expect(changed!.detail).toMatchObject({ event: "relax", from: "enforced", to: "relaxed" });

    // relaxing twice is not a transition the machine has
    const again = await relaxStepUpAround(k.db, () => enforcement(a.id, admin, { event: "relax", reason: "again" }));
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("illegal_transition");

    expect((await chat(a.id)).statusCode).toBe(200);
    const ran = await newestGateAudit(a.id);
    expect(ran).toMatchObject({ effect: "allow", ruleId: AUTONOMY_DISPATCH_RULE_IDS.relaxed });
    expect((ran!.detail as { unmetFloors: string[] }).unmetFloors).toContain("guardrails_block");

    // restoring the strict default needs no step-up
    const restored = await enforcement(a.id, admin, { event: "restore", reason: "pilot over" });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json().autonomy.enforcement).toMatchObject({ state: "enforced", blocksDispatch: true, relaxedBy: null });
    expect((await chat(a.id)).statusCode).toBe(403);
    expect((await enforcement(a.id, admin, { event: "restore", reason: "x" })).statusCode).toBe(409);
  });

  it("the owner's view says why they cannot change it; an admin's view offers the allowed event", async () => {
    const a = await newAgent(bareModel);
    const mine = (await k.req("GET", `/v1/builder/agents/${a.id}/autonomy`, owner.auth)).json().autonomy.enforcement;
    expect(mine.lifecycle.machine).toBe(AUTONOMY_ENFORCEMENT_MACHINE.def.id);
    expect(mine.lifecycle.transitions.find((t: { event: string }) => t.event === "relax")).toMatchObject({ allowed: false });
    const theirs = (await k.req("GET", `/v1/builder/agents/${a.id}/autonomy`, admin.auth)).json().autonomy.enforcement;
    expect(theirs.lifecycle.transitions.find((t: { event: string }) => t.event === "relax")).toMatchObject({ allowed: true });
    expect(theirs.lifecycle.transitions.find((t: { event: string }) => t.event === "restore")).toMatchObject({ allowed: false });
  });
});

describe("fail closed", () => {
  it("floors that cannot be checked refuse the run with 503 autonomy_floor_unverifiable, audited", async () => {
    const ghost = { id: "00000000-0000-4000-8000-0000000e5100", name: "ghost" };
    const out = await autonomyDispatchGate(k.db, ghost, owner.id, "chat");
    expect(out).toMatchObject({ ok: false, status: 503, error: "autonomy_floor_unverifiable" });
    expect(await newestGateAudit(ghost.id)).toMatchObject({ effect: "deny", ruleId: AUTONOMY_DISPATCH_RULE_IDS.unverifiable });
  });

  it("an unknown enforcement value reads as enforced", () => {
    const floors = [{ id: "guardrails_block", minClass: "delegated", label: "x", met: false, detail: "", fix: "" }] as never;
    expect(autonomyDispatchVerdict({ agentName: "a", effective: "delegated", floors, enforcement: "garbage" }).kind).toBe("deny");
    expect(autonomyDispatchVerdict({ agentName: "a", effective: "delegated", floors, enforcement: null }).kind).toBe("deny");
    expect(autonomyDispatchVerdict({ agentName: "a", effective: "supervised", floors, enforcement: null }).kind).toBe("allow");
  });
});
