/**
 * ADR-0188 slice S4 — a BUILDER agent acts under a delegation chain of its own, and under the strict
 * `own_grants` default it does nothing until an admin grants it (OWNER DECISION 1; ADR-0180).
 *
 * The kit is opened with `ownGrants: false`, so nothing grants the builder agent behind the test's back:
 *  - the person is entitled to the model, the builder agent is not → the turn is refused before any model
 *    call (`agent_delegation_refused`, rule `actor-allow-list`), audited, with a note in the thread;
 *  - granted its model through the real admin route, the same turn runs; its usage row names the builder
 *    agent's identity and the grant, and the grant is ended (`run_ended`) when the turn ends.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, auditLog, delegationGrants, eq, usageEvents } from "@regulait/db";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { ensureIdentityFor } from "./in-process-delegation.js";

let k: BuilderKit;
let owner: Person;
let model = "";
let restoreGates: () => Promise<void> = async () => {};

beforeAll(async () => {
  k = await builderKit("s4-bld", { ownGrants: false });
  restoreGates = await relaxGovernanceGatesForTest(k.db, { mrmEnforced: false, dispatchAttributionRequired: false });
  owner = await k.person("owner");
  model = await k.model("m", { price: 1 });
  await k.grantModel(owner.id, model);
}, 120_000);

afterAll(async () => {
  await restoreGates();
  await k.close();
});

describe("S4: a builder agent with no grants of its own", () => {
  it("is refused before any model call, audited; granted through the admin API, the turn runs under its own chain", async () => {
    const created = await k.req("POST", "/v1/builder/agents", owner.auth, {
      name: `s4 builder ${k.RUN}`, connectionFormat: "shared", computerUse: false, projectId: owner.projectId, modelAgentId: model,
    });
    expect(created.statusCode, created.body).toBe(201);
    const agentId = created.json().agent.id as string;
    const usage = async () => k.db.select().from(usageEvents).where(eq(usageEvents.agentId, model));

    const refused = await k.req("POST", `/v1/builder/agents/${agentId}/chat`, owner.auth, { message: "hello" });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toMatchObject({ error: "agent_delegation_refused" });
    expect(refused.json().detail).toMatch(/own grants do not cover agent/);
    expect(await usage()).toHaveLength(0);
    const rows = await k.db.select().from(auditLog).where(and(eq(auditLog.objectId, model), eq(auditLog.ruleId, "actor-allow-list")));
    expect(rows.length).toBe(1);
    expect(rows[0]!.userId).toBe(owner.id);

    // the admin grants the builder agent its model, through the real route
    const ident = await ensureIdentityFor(k.db, { kind: "builder_agent", id: agentId });
    const cur = await k.req("GET", `/v1/workload-identities/${ident.id}/grants`, k.BOOT);
    expect(cur.statusCode, cur.body).toBe(200);
    const put = await k.req("PUT", `/v1/workload-identities/${ident.id}/grants`, k.BOOT, {
      revision: cur.json().revision, tools: [], servers: [], connectors: [], roleIds: [], agents: [{ agentId: model, allowedModes: ["chat"] }],
    });
    expect(put.statusCode, put.body).toBe(200);

    const ok = await k.req("POST", `/v1/builder/agents/${agentId}/chat`, owner.auth, { message: "hello again" });
    expect(ok.statusCode, ok.body).toBe(200);
    const [u] = await usage();
    expect(u).toMatchObject({ actorIdentityId: ident.id });
    const [g] = await k.db.select().from(delegationGrants).where(eq(delegationGrants.id, u!.delegationGrantId!));
    expect(g).toMatchObject({ sponsorUserId: owner.id, actorIdentityId: ident.id, revokedReason: "run_ended", depth: 0 });
    expect(g!.builderTurnId).not.toBeNull();
  });
});
